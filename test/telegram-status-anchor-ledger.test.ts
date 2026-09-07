import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  SqliteTelegramJobStore,
  type NewDeliveryPart,
} from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";
import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
} from "../src/telegram-response-plan.js";
import {
  reconcilePlannedStatusAnchor,
  replaceMissingStatusAnchorEditValues,
} from "../src/telegram-status-anchor-ledger.js";

const START = 1_700_000_000_000;

describe("durable Telegram status anchor ledger", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let updateId: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-status-anchor-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    updateId = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function accepted(id: string): TelegramJob {
    const acceptedAt = START + updateId;
    const source = { botId: "bot", updateId: ++updateId };
    const job: TelegramJob = {
      schemaVersion: 1,
      id,
      version: 1,
      source,
      attachments: [],
      phase: "accepted",
      health: "healthy",
      activity: "unknown",
      attention: { kind: "none" },
      outcome: null,
      dispatchId: null,
      threadId: null,
      turnId: null,
      responsePlan: undefined,
      deliveries: [],
      acceptedAt,
      updatedAt: acceptedAt,
      terminalAt: null,
      dismissedAt: null,
      retainUntil: null,
    };
    store.acceptUpdate({
      job,
      sourcePayload: { kind: "text", text: "prompt" },
      eventId: `${id}:accepted`,
      initialDeliveries: [reservedAnchor(id, acceptedAt)],
    });
    return job;
  }

  it("prepares a canonical revision without consuming an attempt and finishes it with the known message id", () => {
    const job = accepted("job-canonical");
    const payload = Object.fromEntries([
      ["text", "Working"],
      ["messageThreadId", 7],
      ["chatId", -1001],
      ["operation", "send_text"],
    ]);

    const prepared = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: job.version,
      expectedState: "pending",
      expectedAttemptCount: 0,
      payload,
      nextAttemptAt: START + 30_000,
      updatedAt: START + 1,
    });

    expect(prepared).toEqual({
      kind: "prepared",
      delivery: expect.objectContaining({
        state: "sending",
        payload: normalizeTelegramDeliveryPayload(payload),
        contentHash: hashTelegramDeliveryPayload(payload),
        attemptCount: 0,
        telegramMessageId: null,
        nextAttemptAt: START + 30_000,
      }),
    });
    expect(store.get(job.id)?.version).toBe(job.version);

    const delivered = store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: prepared.delivery.contentHash,
      expectedLeaseUntil: START + 30_000,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: START + 2,
    });
    expect(delivered).toEqual(expect.objectContaining({
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      nextAttemptAt: null,
      lastErrorCode: null,
    }));
  });

  it("detects a delivered byte-identical revision and rejects stale job, state, attempt, and revision CAS", () => {
    const job = accepted("job-cas");
    const payload = { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Working" } as const;
    const first = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "pending",
      expectedAttemptCount: 0,
      payload,
      nextAttemptAt: START + 30_000,
      updatedAt: START + 1,
    });
    if (first.kind !== "prepared") throw new Error("expected prepared revision");
    const delivered = store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: first.delivery.contentHash,
      expectedLeaseUntil: START + 30_000,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: START + 2,
    });

    const unchanged = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "delivered",
      expectedAttemptCount: 1,
      payload,
      nextAttemptAt: START + 40_000,
      updatedAt: START + 3,
    });
    expect(unchanged).toEqual({ kind: "unchanged", delivery: delivered });

    expect(() => store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 2,
      expectedState: "delivered",
      expectedAttemptCount: 1,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Changed" },
      nextAttemptAt: START + 40_000,
      updatedAt: START + 3,
    })).toThrow("Telegram job version conflict");
    expect(() => store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "pending",
      expectedAttemptCount: 1,
      payload,
      nextAttemptAt: START + 40_000,
      updatedAt: START + 3,
    })).toThrow("Telegram delivery conflict");
    expect(() => store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: "b".repeat(64),
      expectedLeaseUntil: START + 30_000,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: START + 3,
    })).toThrow("Telegram delivery conflict");
  });

  it("supports safe retry outcomes and only recovers an expired known edit lease", () => {
    const job = accepted("job-retry");
    const initial = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "pending",
      expectedAttemptCount: 0,
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Working" },
      nextAttemptAt: START + 30_000,
      updatedAt: START + 1,
    });
    if (initial.kind !== "prepared") throw new Error("expected prepared revision");
    store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: initial.delivery.contentHash,
      expectedLeaseUntil: START + 30_000,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: START + 2,
    });
    const edit = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "delivered",
      expectedAttemptCount: 1,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working" },
      nextAttemptAt: START + 20,
      updatedAt: START + 3,
    });
    if (edit.kind !== "prepared") throw new Error("expected prepared revision");

    expect(() => store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "sending",
      expectedAttemptCount: 1,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working" },
      nextAttemptAt: START + 40,
      updatedAt: START + 19,
    })).toThrow("Telegram status anchor lease is active");

    expect(() => store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "sending",
      expectedAttemptCount: 1,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working" },
      nextAttemptAt: START + 20,
      updatedAt: START + 20,
    })).toThrow("Telegram delivery conflict");

    const recovered = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "sending",
      expectedAttemptCount: 1,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working" },
      nextAttemptAt: START + 40,
      updatedAt: START + 20,
    });
    expect(recovered).toEqual({
      kind: "prepared",
      delivery: expect.objectContaining({ state: "sending", attemptCount: 1, nextAttemptAt: START + 40 }),
    });

    expect(() => store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 1,
      expectedContentHash: edit.delivery.contentHash,
      expectedLeaseUntil: START + 20,
      state: "pending",
      attemptCount: 2,
      nextAttemptAt: START + 100,
      lastErrorCode: "stale_telegram_edit_timeout",
      updatedAt: START + 21,
    })).toThrow("Telegram delivery conflict");

    const pending = store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 1,
      expectedContentHash: recovered.delivery.contentHash,
      expectedLeaseUntil: START + 40,
      state: "pending",
      attemptCount: 2,
      nextAttemptAt: START + 100,
      lastErrorCode: "telegram_edit_timeout",
      updatedAt: START + 21,
    });
    expect(pending).toEqual(expect.objectContaining({
      state: "pending",
      attemptCount: 2,
      telegramMessageId: 501,
      nextAttemptAt: START + 100,
      lastErrorCode: "telegram_edit_timeout",
    }));
  });

  it("treats a send-shaped revision as unchanged after it reconciles to the delivered known edit", () => {
    const job = accepted("job-reconciled-unchanged");
    const initial = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "pending",
      expectedAttemptCount: 0,
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Working" },
      nextAttemptAt: START + 10,
      updatedAt: START + 1,
    });
    if (initial.kind !== "prepared") throw new Error("expected prepared revision");
    store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: initial.delivery.contentHash,
      expectedLeaseUntil: START + 10,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: START + 2,
    });
    const edit = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "delivered",
      expectedAttemptCount: 1,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working" },
      nextAttemptAt: START + 20,
      updatedAt: START + 3,
    });
    if (edit.kind !== "prepared") throw new Error("expected prepared revision");
    const delivered = store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 1,
      expectedContentHash: edit.delivery.contentHash,
      expectedLeaseUntil: START + 20,
      state: "delivered",
      attemptCount: 2,
      telegramMessageId: 501,
      updatedAt: START + 4,
    });

    expect(store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "delivered",
      expectedAttemptCount: 2,
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Still working" },
      nextAttemptAt: START + 30,
      updatedAt: START + 5,
    })).toEqual({ kind: "unchanged", delivery: delivered });
  });

  it("preserves a matching rich edit anchor and rejects a rich send anchor", () => {
    const job = accepted("job-rich-anchor");
    const initial = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "pending",
      expectedAttemptCount: 0,
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Working" },
      nextAttemptAt: START + 10,
      updatedAt: START + 1,
    });
    if (initial.kind !== "prepared") throw new Error("expected prepared revision");
    store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: initial.delivery.contentHash,
      expectedLeaseUntil: START + 10,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: START + 2,
    });
    const fallbackParts = [{
      partKey: "final:0000:fallback:0000",
      kind: "final" as const,
      payload: { operation: "edit_text" as const, chatId: -1001, messageId: 501, text: "<b>Done</b>" },
    }];

    expect(() => store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "delivered",
      expectedAttemptCount: 1,
      payload: {
        operation: "send_rich", chatId: -1001, messageThreadId: 7,
        markdown: "# Done", media: [], fallbackParts: [{
          partKey: "final:0000:fallback:0000", kind: "final",
          payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "<b>Done</b>" },
        }],
      },
      nextAttemptAt: START + 20,
      updatedAt: START + 3,
    })).toThrow("Invalid Telegram status anchor revision");

    const rich = {
      operation: "edit_rich" as const,
      chatId: -1001,
      messageId: 501,
      markdown: "# Done",
      media: [],
      fallbackParts,
    };
    expect(() => store.prepareStatusAnchorRevision({
      jobId: job.id, expectedJobVersion: 1, expectedState: "delivered", expectedAttemptCount: 1,
      payload: {
        ...rich,
        messageId: 502,
        fallbackParts: [{
          ...fallbackParts[0]!,
          payload: { operation: "edit_text", chatId: -1001, messageId: 502, text: "<b>Done</b>" },
        }],
      },
      nextAttemptAt: START + 20, updatedAt: START + 3,
    })).toThrow("Telegram delivery conflict");
    const prepared = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "delivered",
      expectedAttemptCount: 1,
      payload: rich,
      nextAttemptAt: START + 20,
      updatedAt: START + 3,
    });
    expect(prepared).toEqual({
      kind: "prepared",
      delivery: expect.objectContaining({ payload: rich, telegramMessageId: 501 }),
    });
  });

  it("extracts the planned message id from a rich edit anchor", () => {
    const job = accepted("job-planned-rich-anchor");
    const current = store.listDeliveries(job.id)[0]!;
    const rich = {
      operation: "edit_rich" as const,
      chatId: -1001,
      messageId: 501,
      markdown: "# Done",
      media: [],
      fallbackParts: [{
        partKey: "final:0000:fallback:0000",
        kind: "final" as const,
        payload: { operation: "edit_text" as const, chatId: -1001, messageId: 501, text: "<b>Done</b>" },
      }],
    };
    const planned = { ...reservedAnchor(job.id, START + 1), payload: rich, contentHash: hashTelegramDeliveryPayload(rich) };

    expect(reconcilePlannedStatusAnchor([planned], current)).toEqual([
      expect.objectContaining({ payload: rich, telegramMessageId: 501 }),
    ]);
  });

  it("marks an ambiguous new send uncertain and never permits it through known-edit lease recovery", () => {
    const job = accepted("job-uncertain");
    const prepared = store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "pending",
      expectedAttemptCount: 0,
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Working" },
      nextAttemptAt: START + 10,
      updatedAt: START + 1,
    });
    if (prepared.kind !== "prepared") throw new Error("expected prepared revision");
    const uncertain = store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: prepared.delivery.contentHash,
      expectedLeaseUntil: START + 10,
      state: "uncertain",
      attemptCount: 1,
      lastErrorCode: "telegram_send_uncertain",
      updatedAt: START + 10,
    });
    expect(uncertain).toEqual(expect.objectContaining({
      state: "uncertain",
      attemptCount: 1,
      telegramMessageId: null,
    }));
    expect(() => store.prepareStatusAnchorRevision({
      jobId: job.id,
      expectedJobVersion: 1,
      expectedState: "sending",
      expectedAttemptCount: 1,
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Working" },
      nextAttemptAt: START + 20,
      updatedAt: START + 11,
    })).toThrow("Telegram delivery conflict");
  });

  it("atomically replaces a missing active edit with an immediately due canonical send without a plan", () => {
    const { job, sending } = activeEdit("job-replace-no-plan");
    const advanced = store.transition({
      jobId: job.id,
      eventId: `${job.id}:activity`,
      expectedVersion: job.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: START + 4, activity: "tool" },
    });
    expect(advanced.version).toBe(job.version + 1);
    const replacementPayload = Object.fromEntries([
      ["text", "Current status"],
      ["messageThreadId", 7],
      ["chatId", -1001],
      ["operation", "send_text"],
    ]);

    const replaced = store.replaceMissingStatusAnchorEdit({
      jobId: job.id,
      expectedAttemptCount: sending.attemptCount,
      expectedContentHash: sending.contentHash,
      expectedLeaseUntil: sending.nextAttemptAt!,
      expectedMessageId: 501,
      replacementPayload,
      updatedAt: START + 42,
    });

    expect(replaced).toMatchObject({
      state: "pending",
      attemptCount: sending.attemptCount + 1,
      telegramMessageId: null,
      nextAttemptAt: START + 42,
      lastErrorCode: "telegram_status_message_missing",
      payload: {
        operation: "send_text",
        chatId: -1001,
        messageThreadId: 7,
        text: "Current status",
      },
    });
    expect(replaced.contentHash).toBe(hashTelegramDeliveryPayload(replacementPayload));

    const nullable = activeEdit("job-replace-null-topic");
    expect(store.replaceMissingStatusAnchorEdit({
      jobId: nullable.job.id,
      expectedAttemptCount: nullable.sending.attemptCount,
      expectedContentHash: nullable.sending.contentHash,
      expectedLeaseUntil: nullable.sending.nextAttemptAt!,
      expectedMessageId: 501,
      replacementPayload: {
        operation: "send_text", chatId: -1001, messageThreadId: null, text: "Current status",
      },
      updatedAt: START + 42,
    }).payload).toEqual({
      operation: "send_text", chatId: -1001, messageThreadId: null, text: "Current status",
    });
  });

  it("atomically replaces the installed anchor plan and permits final delivery finalization", () => {
    const fixture = installedActiveEdit("job-replace-installed-plan");
    const replaced = replaceMissingEdit(fixture);

    expect(replaced).toMatchObject({
      state: "pending",
      attemptCount: fixture.sending.attemptCount + 1,
      telegramMessageId: null,
      nextAttemptAt: START + 42,
      lastErrorCode: "telegram_status_message_missing",
      payload: fixture.replacementPayload,
      contentHash: hashTelegramDeliveryPayload(fixture.replacementPayload),
    });
    expect(withRaw((database) => database.prepare(`SELECT payload_json, content_hash
      FROM status_anchor_plans WHERE job_id = ?`).get(fixture.job.id))).toEqual({
      payload_json: JSON.stringify(fixture.replacementPayload),
      content_hash: hashTelegramDeliveryPayload(fixture.replacementPayload),
    });

    let eventAt = START + 43;
    for (const partKey of ["status-anchor", "final:0000", "notice:0001"]) {
      const due = store.listDueDeliveries(eventAt, 10);
      expect(due.map((part) => part.partKey)).toEqual([partKey]);
      const part = due[0]!;
      store.transitionDelivery({
        jobId: fixture.job.id,
        partKey,
        state: "sending",
        attemptCount: part.attemptCount,
        updatedAt: eventAt++,
      });
      store.transitionDelivery({
        jobId: fixture.job.id,
        partKey: part.partKey,
        state: "delivered",
        attemptCount: part.attemptCount + 1,
        telegramMessageId: part.partKey === "status-anchor" ? 777 : 800 + part.ordinal,
        updatedAt: eventAt++,
      });
    }

    expect(store.finalizeDeliveredPlan({
      jobId: fixture.job.id,
      eventId: `${fixture.job.id}:finalize`,
      expectedVersion: fixture.job.version,
      eventAt,
    })).toMatchObject({
      phase: "terminal",
      outcome: "completed",
      deliveries: [
        { partId: "final:0000", state: "delivered" },
        { partId: "notice:0001", state: "delivered" },
      ],
    });
  });

  it.each([
    ["state", (fixture: InstalledEditFixture) => mutateDelivery(fixture.job.id, "state = 'pending'")],
    ["attempt", (fixture: InstalledEditFixture) => ({ expectedAttemptCount: fixture.sending.attemptCount + 1 })],
    ["hash", () => ({ expectedContentHash: "b".repeat(64) })],
    ["lease", (fixture: InstalledEditFixture) => ({ expectedLeaseUntil: fixture.sending.nextAttemptAt! + 1 })],
    ["message id", () => ({ expectedMessageId: 502 })],
    ["chat", (fixture: InstalledEditFixture) => ({ replacementPayload: { ...fixture.replacementPayload, chatId: -1002 } })],
    ["text", (fixture: InstalledEditFixture) => ({ replacementPayload: { ...fixture.replacementPayload, text: "Other" } })],
    ["send operation", () => ({ replacementPayload: {
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Current status",
    } })],
    ["nullable topic", (fixture: InstalledEditFixture) => ({ replacementPayload: {
      ...fixture.replacementPayload, messageThreadId: 0,
    } })],
    ["monotonic timestamp", (fixture: InstalledEditFixture) => ({ updatedAt: fixture.sending.updatedAt - 1 })],
    ["anchor kind", (fixture: InstalledEditFixture) => mutateDelivery(fixture.job.id, "kind = 'final'")],
    ["anchor ordinal", (fixture: InstalledEditFixture) => mutateDelivery(fixture.job.id, "ordinal = 1")],
    ["anchor part key", (fixture: InstalledEditFixture) => mutateDelivery(fixture.job.id, "part_key = 'other-anchor'")],
    ["current edit operation", (fixture: InstalledEditFixture) => mutateDeliveryPayload(fixture.job.id, {
      operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Current status",
    })],
    ["current edit message id", (fixture: InstalledEditFixture) => mutateDeliveryPayload(fixture.job.id, {
      operation: "edit_text", chatId: -1001, messageId: 502, text: "Current status",
    })],
  ])("rejects a %s mismatch and rolls back delivery plus installed plan", (_name, arrange) => {
    const fixture = installedActiveEdit(`job-replace-mismatch-${updateId}`);
    const overrides = arrange(fixture) ?? {};
    const before = ledgerSnapshot(fixture.job.id);

    expect(() => replaceMissingEdit(fixture, overrides)).toThrow();
    expect(ledgerSnapshot(fixture.job.id)).toBe(before);
  });

  it.each([
    ["missing", (jobId: string) => withRaw((database) => database.prepare(
      "DELETE FROM status_anchor_plans WHERE job_id = ?",
    ).run(jobId))],
    ["malformed", (jobId: string) => mutatePlan(jobId, "{}", "a".repeat(64))],
    ["mismatched", (jobId: string) => {
      const payload = { operation: "edit_text", chatId: -1001, messageId: 501, text: "Other" };
      mutatePlan(jobId, JSON.stringify(payload), hashTelegramDeliveryPayload(payload));
    }],
  ])("rolls back delivery and the %s installed anchor plan", (_name, arrange) => {
    const fixture = installedActiveEdit(`job-replace-plan-${updateId}`);
    arrange(fixture.job.id);
    const before = ledgerSnapshot(fixture.job.id);

    expect(() => replaceMissingEdit(fixture)).toThrow();
    expect(ledgerSnapshot(fixture.job.id)).toBe(before);
  });

  it("rolls back the successful plan write when the subsequent delivery payload CAS changes zero rows", () => {
    const fixture = installedActiveEdit("job-replace-post-plan-cas");
    const noncanonicalEditJson = JSON.stringify({
      text: "Current status", messageId: 501, chatId: -1001, operation: "edit_text",
    });
    withRaw((database) => database.prepare(`UPDATE deliveries SET payload_json = ?
      WHERE job_id = ? AND part_key = 'status-anchor'`).run(noncanonicalEditJson, fixture.job.id));
    expect(withRaw((database) => database.prepare(`SELECT
      (SELECT payload_json FROM deliveries WHERE job_id = ? AND part_key = 'status-anchor') AS delivery_payload,
      (SELECT payload_json FROM status_anchor_plans WHERE job_id = ?) AS plan_payload`).get(
      fixture.job.id, fixture.job.id,
    ))).toEqual({
      delivery_payload: noncanonicalEditJson,
      plan_payload: JSON.stringify(fixture.sending.payload),
    });
    const before = ledgerSnapshot(fixture.job.id);

    expect(() => replaceMissingEdit(fixture)).toThrow("Telegram delivery conflict");
    expect(ledgerSnapshot(fixture.job.id)).toBe(before);
  });

  it.each([
    ["unsafe lease", { expectedLeaseUntil: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional lease", { expectedLeaseUntil: START + 0.5 }],
    ["unsafe updatedAt", { updatedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional updatedAt", { updatedAt: START + 42.5 }],
    ["attempt overflow", { expectedAttemptCount: Number.MAX_SAFE_INTEGER }],
    ["zero message id", { expectedMessageId: 0 }],
    ["unsafe message id", { expectedMessageId: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional message id", { expectedMessageId: 501.5 }],
  ])("rejects %s input without changing the delivery or installed plan", (_name, overrides) => {
    const fixture = installedActiveEdit(`job-replace-bounds-${updateId}`);
    const before = ledgerSnapshot(fixture.job.id);

    expect(() => replaceMissingEdit(fixture, overrides)).toThrow();
    expect(ledgerSnapshot(fixture.job.id)).toBe(before);
  });

  it("rejects a 129-character job id through the pure 128-character validator", () => {
    const fixture = installedActiveEdit("job-replace-job-id-bound");
    const before = ledgerSnapshot(fixture.job.id);

    expect(() => replaceMissingStatusAnchorEditValues({
      jobId: "j".repeat(129),
      expectedAttemptCount: fixture.sending.attemptCount,
      expectedContentHash: fixture.sending.contentHash,
      expectedLeaseUntil: fixture.sending.nextAttemptAt!,
      expectedMessageId: 501,
      replacementPayload: fixture.replacementPayload,
      updatedAt: START + 42,
    }, fixture.sending)).toThrow("Invalid jobId");
    expect(ledgerSnapshot(fixture.job.id)).toBe(before);
  });

  it("requires absence of a stored anchor plan when the job has no response plan", () => {
    const { job, sending } = activeEdit("job-replace-unexpected-plan");
    mutatePlan(job.id, JSON.stringify(sending.payload), sending.contentHash, true);
    const before = ledgerSnapshot(job.id);

    expect(() => store.replaceMissingStatusAnchorEdit({
      jobId: job.id,
      expectedAttemptCount: sending.attemptCount,
      expectedContentHash: sending.contentHash,
      expectedLeaseUntil: sending.nextAttemptAt!,
      expectedMessageId: 501,
      replacementPayload: {
        operation: "send_text", chatId: -1001, messageThreadId: null, text: "Current status",
      },
      updatedAt: START + 42,
    })).toThrow();
    expect(ledgerSnapshot(job.id)).toBe(before);
  });

  interface InstalledEditFixture {
    readonly job: TelegramJob;
    readonly sending: ReturnType<SqliteTelegramJobStore["listDeliveries"]>[number];
    readonly replacementPayload: {
      readonly operation: "send_text";
      readonly chatId: number;
      readonly messageThreadId: number | null;
      readonly text: string;
    };
  }

  function activeEdit(id: string): { readonly job: TelegramJob; readonly sending: InstalledEditFixture["sending"] } {
    const job = accepted(id);
    const sent = store.prepareStatusAnchorRevision({
      jobId: job.id, expectedJobVersion: job.version, expectedState: "pending", expectedAttemptCount: 0,
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Initial" },
      nextAttemptAt: START + 10, updatedAt: START + 1,
    });
    if (sent.kind !== "prepared") throw new Error("expected prepared revision");
    store.finishStatusAnchorRevision({
      jobId: job.id, expectedAttemptCount: 0, expectedContentHash: sent.delivery.contentHash,
      expectedLeaseUntil: sent.delivery.nextAttemptAt!, state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: START + 2,
    });
    const edit = store.prepareStatusAnchorRevision({
      jobId: job.id, expectedJobVersion: job.version, expectedState: "delivered", expectedAttemptCount: 1,
      payload: Object.fromEntries([
        ["text", "Current status"], ["messageId", 501], ["chatId", -1001], ["operation", "edit_text"],
      ]),
      nextAttemptAt: START + 40, updatedAt: START + 3,
    });
    if (edit.kind !== "prepared") throw new Error("expected prepared revision");
    return { job, sending: edit.delivery };
  }

  function installedActiveEdit(id: string): InstalledEditFixture {
    const initial = activeEdit(`${id}-initial`);
    store.finishStatusAnchorRevision({
      jobId: initial.job.id, expectedAttemptCount: initial.sending.attemptCount,
      expectedContentHash: initial.sending.contentHash, expectedLeaseUntil: initial.sending.nextAttemptAt!,
      state: "delivered", attemptCount: initial.sending.attemptCount + 1,
      telegramMessageId: 501, updatedAt: START + 4,
    });
    let job = advanceToDelivering(initial.job);
    const anchor = { operation: "edit_text", chatId: -1001, messageId: 501, text: "Current status" } as const;
    const final = { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Final" } as const;
    const notice = { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Notice" } as const;
    job = store.installDeliveryPlan({
      jobId: job.id, eventId: `${job.id}:plan`, expectedVersion: job.version, eventAt: START + 9,
      responsePlan: [{ partId: "final:0000", kind: "final" }, { partId: "notice:0001", kind: "notice" }],
      parts: [
        plannedPart(job.id, "status-anchor", 0, "status-anchor", anchor, START + 9, 501),
        plannedPart(job.id, "final:0000", 0, "final", final, START + 9),
        plannedPart(job.id, "notice:0001", 1, "notice", notice, START + 9),
      ],
    });
    const edit = store.prepareStatusAnchorRevision({
      jobId: job.id, expectedJobVersion: job.version, expectedState: "pending", expectedAttemptCount: 2,
      payload: anchor, nextAttemptAt: START + 40, updatedAt: START + 10,
    });
    if (edit.kind !== "prepared") throw new Error("expected prepared revision");
    return {
      job,
      sending: edit.delivery,
      replacementPayload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Current status" },
    };
  }

  function advanceToDelivering(initial: TelegramJob): TelegramJob {
    let job = store.transition({ jobId: initial.id, eventId: `${initial.id}:queued`, expectedVersion: initial.version,
      event: { schemaVersion: 1, type: "job.queued", eventAt: START + 5 } });
    job = store.transition({ jobId: job.id, eventId: `${job.id}:dispatch`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.started", eventAt: START + 6, dispatch: {
        id: `${job.id}:dispatch-id`, threadId: "thread-1", previousTurnId: null, attempt: 1,
        startedAt: START + 6, transportWriteState: "written", nextAttemptAt: null,
      } } });
    job = store.transition({ jobId: job.id, eventId: `${job.id}:started`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "turn.started", eventAt: START + 7,
        identifiers: { turnId: "turn-1" }, codexEventAt: START + 7 } });
    return store.transition({ jobId: job.id, eventId: `${job.id}:completed`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "turn.completed", eventAt: START + 8,
        codexEventAt: START + 8, turnResult: { schemaVersion: 1, content: [] } } });
  }

  function plannedPart(
    jobId: string, partKey: string, ordinal: number, kind: string, payload: unknown, updatedAt: number,
    telegramMessageId: number | null = null,
  ): NewDeliveryPart {
    return { jobId, partKey, ordinal, kind, state: "pending", payload,
      contentHash: hashTelegramDeliveryPayload(payload), telegramMessageId, updatedAt };
  }

  function replaceMissingEdit(fixture: InstalledEditFixture, overrides: Record<string, unknown> = {}) {
    return store.replaceMissingStatusAnchorEdit({
      jobId: fixture.job.id, expectedAttemptCount: fixture.sending.attemptCount,
      expectedContentHash: fixture.sending.contentHash, expectedLeaseUntil: fixture.sending.nextAttemptAt!,
      expectedMessageId: 501, replacementPayload: fixture.replacementPayload,
      updatedAt: START + 42, ...overrides,
    });
  }

  function mutateDelivery(jobId: string, assignment: string): undefined {
    withRaw((database) => database.prepare(`UPDATE deliveries SET ${assignment}
      WHERE job_id = ? AND part_key = 'status-anchor'`).run(jobId));
  }

  function mutateDeliveryPayload(jobId: string, payload: unknown): undefined {
    withRaw((database) => database.prepare(`UPDATE deliveries SET payload_json = ?, content_hash = ?
      WHERE job_id = ? AND part_key = 'status-anchor'`).run(
      JSON.stringify(payload), hashTelegramDeliveryPayload(payload), jobId,
    ));
  }

  function mutatePlan(jobId: string, payloadJson: string, contentHash: string, insert = false): void {
    withRaw((database) => database.prepare(insert
      ? "INSERT INTO status_anchor_plans (job_id, payload_json, content_hash, installed_at_ms) VALUES (?, ?, ?, ?)"
      : "UPDATE status_anchor_plans SET payload_json = ?, content_hash = ? WHERE job_id = ?")
      .run(...(insert ? [jobId, payloadJson, contentHash, START] : [payloadJson, contentHash, jobId])));
  }

  function ledgerSnapshot(jobId: string): string {
    return withRaw((database) => JSON.stringify({
      delivery: database.prepare("SELECT * FROM deliveries WHERE job_id = ? ORDER BY part_key").all(jobId),
      plan: database.prepare("SELECT * FROM status_anchor_plans WHERE job_id = ?").all(jobId),
    }));
  }

  function withRaw<T>(callback: (database: Database.Database) => T): T {
    const database = new Database(path.join(directory, "jobs.sqlite"));
    try { return callback(database); }
    finally { database.close(); }
  }

});

function reservedAnchor(jobId: string, updatedAt: number): NewDeliveryPart {
  return {
    jobId,
    partKey: "status-anchor",
    ordinal: 0,
    kind: "status-anchor",
    state: "pending",
    payload: { chatId: -1001, messageThreadId: 7, sourceMessageId: 11 },
    contentHash: "a".repeat(64),
    updatedAt,
  };
}
