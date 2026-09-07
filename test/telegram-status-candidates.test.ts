import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteTelegramJobStore, type NewDeliveryPart } from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";

const START = 1_700_000_000_000;

describe("Telegram status candidates", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let updateId: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-status-candidates-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    updateId = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function accepted(id: string, options: {
    anchor?: boolean; acceptedAt: number; legacyChecksum?: string;
  }): TelegramJob {
    const source = {
      botId: options.legacyChecksum === undefined ? "bot" : `legacy-json-v1:${options.legacyChecksum}`,
      updateId: ++updateId,
    };
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
      acceptedAt: options.acceptedAt,
      updatedAt: options.acceptedAt,
      terminalAt: null,
      dismissedAt: null,
      retainUntil: null,
    };
    store.acceptUpdate({
      job,
      sourcePayload: options.legacyChecksum === undefined
        ? { kind: "text", text: "prompt" }
        : { migration: {
            version: "1",
            sourceIdentity: "synthetic",
            checksum: options.legacyChecksum,
            ordinal: source.updateId,
          } },
      eventId: `${id}:accepted`,
      initialDeliveries: options.anchor === false ? [] : [reservedAnchor(id, options.acceptedAt)],
    });
    return job;
  }

  function terminalFailed(job: TelegramJob): TelegramJob {
    return store.transition({
      jobId: job.id,
      eventId: `${job.id}:failed`,
      expectedVersion: job.version,
      event: { schemaVersion: 1, type: "job.terminal", outcome: "failed", eventAt: job.updatedAt + 1 },
    });
  }

  it("lists bounded jobs with physically incomplete terminal work first", () => {
    const active = accepted("active", { acceptedAt: START + 1 });
    const delivered = terminalFailed(accepted("terminal-delivered", { acceptedAt: START + 2 }));
    store.transitionDelivery({
      jobId: delivered.id,
      partKey: "status-anchor",
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: delivered.updatedAt + 1,
    });
    const pending = terminalFailed(accepted("terminal-pending", { acceptedAt: START + 3 }));
    const missing = terminalFailed(accepted("terminal-missing", { anchor: false, acceptedAt: START + 4 }));
    const unidentified = terminalFailed(accepted("terminal-no-message", { acceptedAt: START + 5 }));
    store.transitionDelivery({
      jobId: unidentified.id,
      partKey: "status-anchor",
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: null,
      updatedAt: unidentified.updatedAt + 1,
    });

    expect(store.listStatusCandidates(10).map((candidate) => candidate.id)).toEqual([
      unidentified.id,
      missing.id,
      pending.id,
      active.id,
    ]);
    expect(store.listStatusCandidates(2).map((candidate) => candidate.id)).toEqual([
      unidentified.id,
      missing.id,
    ]);
  });

  it("keeps a legacy completed job visible while an ordinary physical delivery is incomplete", () => {
    const checksum = "c".repeat(64);
    const initial = accepted("terminal-ordinary-pending", {
      acceptedAt: START + 1,
      legacyChecksum: checksum,
    });
    const completed = store.transitionLegacyMigration({
      jobId: initial.id,
      eventId: `${initial.id}:completed`,
      expectedVersion: initial.version,
      event: {
        schemaVersion: 1,
        type: "job.terminal",
        outcome: "completed",
        eventAt: initial.updatedAt,
        responsePlan: [{ partId: "final:0000", kind: "final" }],
        deliveries: [{
          partId: "final:0000",
          state: "pending",
          attempts: 0,
          messageId: null,
          deliveredAt: null,
        }],
      },
    });
    store.transitionDelivery({
      jobId: completed.id,
      partKey: "status-anchor",
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: completed.updatedAt,
    });
    const payload = { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Final" } as const;
    store.insertDelivery({
      jobId: completed.id,
      partKey: "final:0000",
      ordinal: 0,
      kind: "final",
      state: "pending",
      payload,
      contentHash: hashTelegramDeliveryPayload(payload),
      updatedAt: completed.updatedAt,
    });

    expect(store.listStatusCandidates(10).map((candidate) => candidate.id)).toContain(completed.id);
  });

  it("excludes a fully delivered synthetic legacy job without a status anchor", () => {
    const checksum = "d".repeat(64);
    const initial = accepted("terminal-legacy-delivered", {
      anchor: false,
      acceptedAt: START + 1,
      legacyChecksum: checksum,
    });
    const payload = {
      operation: "send_text",
      chatId: -1001,
      messageThreadId: 7,
      text: "Archived final",
    } as const;
    store.insertDelivery({
      jobId: initial.id,
      partKey: "final:0000",
      ordinal: 0,
      kind: "final",
      state: "delivered",
      payload,
      contentHash: hashTelegramDeliveryPayload(payload),
      telegramMessageId: null,
      updatedAt: initial.updatedAt,
    });
    store.transitionLegacyMigration({
      jobId: initial.id,
      eventId: `${initial.id}:completed`,
      expectedVersion: initial.version,
      event: {
        schemaVersion: 1,
        type: "job.terminal",
        outcome: "completed",
        eventAt: initial.updatedAt,
        responsePlan: [{ partId: "final:0000", kind: "final" }],
        deliveries: [{
          partId: "final:0000",
          state: "delivered",
          attempts: 0,
          messageId: null,
          deliveredAt: initial.updatedAt,
        }],
      },
    });

    expect(store.listStatusCandidates(10).map((candidate) => candidate.id)).not.toContain(initial.id);

    store.replaceSourcePayload(initial.id, initial.source, {
      migration: {
        version: "invalid version",
        checksum,
        sourceIdentity: "synthetic",
        ordinal: initial.source.updateId,
      },
    });
    expect(store.listStatusCandidates(10).map((candidate) => candidate.id)).toContain(initial.id);
  });

  it("keeps newer attention and stalled jobs ahead of the bounded ordinary queue", () => {
    accepted("ordinary-oldest", { acceptedAt: START + 1 });
    accepted("ordinary-second", { acceptedAt: START + 2 });
    const stalled = accepted("stalled-new", { acceptedAt: START + 3 });
    store.transition({
      jobId: stalled.id,
      eventId: `${stalled.id}:stalled`,
      expectedVersion: stalled.version,
      event: {
        schemaVersion: 1,
        type: "activity.observed",
        eventAt: START + 4,
        health: "stalled",
      },
    });
    const attention = accepted("attention-newest", { acceptedAt: START + 5 });
    store.transition({
      jobId: attention.id,
      eventId: `${attention.id}:attention`,
      expectedVersion: attention.version,
      event: {
        schemaVersion: 1,
        type: "activity.observed",
        eventAt: START + 6,
        attention: { kind: "required", code: "OPERATOR_REQUIRED", actions: ["inspect"] },
      },
    });

    expect(store.listStatusCandidates(2).map((candidate) => candidate.id)).toEqual([
      attention.id,
      stalled.id,
    ]);
  });
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
