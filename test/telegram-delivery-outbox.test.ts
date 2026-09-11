import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";
import Database from "better-sqlite3";

import {
  TelegramDeliveryApiError,
  TelegramDeliveryOutbox,
  type TelegramDeliveryAdapter,
  type TelegramDeliveryPayload,
} from "../src/telegram-delivery-outbox.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { isDoneEligible } from "../src/telegram-job-transition.js";
import type { TelegramJob } from "../src/telegram-job-types.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import type { TelegramTurnResultContent } from "../src/telegram-turn-result.js";

const START = 1_700_000_000_000;

class FakeTelegram implements TelegramDeliveryAdapter {
  readonly calls: TelegramDeliveryPayload[] = [];
  behavior: (payload: TelegramDeliveryPayload, signal: AbortSignal) => Promise<{ messageId: number }> =
    async () => ({ messageId: 900 });
  deliver(payload: TelegramDeliveryPayload, signal: AbortSignal): Promise<{ messageId: number }> {
    this.calls.push(structuredClone(payload));
    return this.behavior(payload, signal);
  }
}

describe("TelegramDeliveryOutbox", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let telegram: FakeTelegram;
  let now: number;
  let sequence: number;
  let sourceSequence: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-outbox-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    telegram = new FakeTelegram();
    now = START;
    sequence = 0;
    sourceSequence = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function running(id = "job-1"): TelegramJob {
    const updateId = ++sourceSequence;
    const initial: TelegramJob = {
      schemaVersion: 1, id, version: 1, source: { botId: "bot", updateId }, attachments: [],
      phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
      dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
      acceptedAt: now, updatedAt: now, terminalAt: null, dismissedAt: null, retainUntil: null,
    };
    store.acceptUpdate({ job: initial, sourcePayload: {
      botId: "bot", updateId, chatId: -1001, messageThreadId: 7, messageId: updateId,
      kind: "text", text: "prompt", attachment: null, retryOfJobId: null,
    }, eventId: `${id}:accept`, initialDeliveries: [{
      jobId: id, partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "pending",
      payload: { chatId: -1001, messageThreadId: 7, sourceMessageId: updateId },
      contentHash: "a".repeat(64), updatedAt: now,
    }] });
    let job = store.transition({ jobId: id, eventId: `${id}:queued`, expectedVersion: 1,
      event: { schemaVersion: 1, type: "job.queued", eventAt: now } });
    job = store.transition({ jobId: id, eventId: `${id}:dispatch`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.started", eventAt: now, dispatch: {
        id: "dispatch-1", threadId: "thread-1", previousTurnId: null, attempt: 1,
        startedAt: now, transportWriteState: "written", nextAttemptAt: null,
      } } });
    job = store.transition({ jobId: id, eventId: `${id}:turn`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "turn.started", eventAt: now, identifiers: { turnId: "turn-1" } } });
    return job;
  }

  function delivering(
    id = "job-1",
    content: readonly TelegramTurnResultContent[] = [{ kind: "text", text: "answer" }],
  ): TelegramJob {
    const job = running(id);
    return store.transition({ jobId: id, eventId: `${id}:complete`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "turn.completed", eventAt: now,
        turnResult: { schemaVersion: 1, content } } });
  }

  function outbox(overrides: Partial<ConstructorParameters<typeof TelegramDeliveryOutbox>[0]> = {}) {
    return new TelegramDeliveryOutbox({
      store, telegram, now: () => now, createId: () => `outbox-${++sequence}`,
      scheduleWakeup: () => {}, timeoutMs: 30_000, ...overrides,
    });
  }

  function installedPlanParts(messageThreadId: number | null) {
    return {
      supplementalParts: [{
        partKey: "notice:complete",
        kind: "notice" as const,
        payload: {
          operation: "send_text" as const,
          chatId: -1001,
          messageThreadId,
          text: "Saved.",
        },
      }],
    };
  }

  async function failInstalledAnchor(
    worker: TelegramDeliveryOutbox,
    id: string,
    messageThreadId: number | null = 7,
  ): Promise<TelegramJob> {
    const job = delivering(id);
    worker.installPlan(
      job.id,
      { chatId: -1001, messageThreadId, anchorMessageId: 501 },
      undefined,
      installedPlanParts(messageThreadId),
    );
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("permanent"); };
    await worker.pump();
    telegram.calls.length = 0;
    return job;
  }

  function overwriteDeliveredAnchor(jobId: string, payload: TelegramDeliveryPayload, messageId: number): void {
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try {
      raw.prepare(`UPDATE deliveries SET state = 'delivered', payload_json = ?, content_hash = ?,
        telegram_message_id = ?, attempt_count = 1, next_attempt_at_ms = NULL, last_error_code = NULL
        WHERE job_id = ? AND part_key = 'status-anchor'`)
        .run(JSON.stringify(payload), hashTelegramDeliveryPayload(payload), messageId, jobId);
    } finally { raw.close(); }
  }

  function downgradeToV5WithoutAnchorPlans(): void {
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try {
      raw.exec("DROP TABLE IF EXISTS topic_resume_attempts");
      raw.exec("DROP TABLE IF EXISTS topic_recoveries");
      const planTable = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'status_anchor_plans'")
        .get();
      if (planTable) raw.exec("DROP TABLE status_anchor_plans");
      raw.exec("DROP TABLE IF EXISTS status_anchor_plan_bootstrap_eligibility");
      raw.pragma("user_version = 5");
    } finally { raw.close(); }
  }

  function terminalDistractor(id: string): void {
    const updateId = ++sourceSequence;
    const initial: TelegramJob = {
      schemaVersion: 1, id, version: 1, source: { botId: "bot", updateId }, attachments: [],
      phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
      dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
      acceptedAt: now, updatedAt: now, terminalAt: null, dismissedAt: null, retainUntil: null,
    };
    store.acceptUpdate({
      job: initial,
      sourcePayload: {
        botId: "bot", updateId, chatId: -1001, messageThreadId: 7, messageId: updateId,
        kind: "text", text: "prompt", attachment: null, retryOfJobId: null,
      },
      eventId: `${id}:accept`,
      initialDeliveries: [{
        jobId: id, partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "pending",
        payload: { chatId: -1001, messageThreadId: 7, sourceMessageId: updateId },
        contentHash: "a".repeat(64), updatedAt: now,
      }],
    });
    store.transition({
      jobId: id, eventId: `${id}:failed`, expectedVersion: initial.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: now, outcome: "failed" },
    });
  }

  it("atomically installs the plan before pending -> sending -> delivered", async () => {
    const job = delivering();
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    telegram.behavior = async () => {
      expect(store.listDeliveries(job.id)[0]?.state).toBe("sending");
      return { messageId: 501 };
    };

    await worker.pump();

    expect(store.listDeliveries(job.id)[0]).toMatchObject({ state: "delivered", attemptCount: 1, telegramMessageId: 501 });
    expect(store.getDeliverySummary(job.id)).toEqual({
      total: 1, pending: 0, sending: 0, delivered: 1, uncertain: 0, failed: 0,
    });
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(isDoneEligible(store.get(job.id)!)).toBe(true);
  });

  it("delivers completed commentary while the turn is running and reuses it in the final plan", async () => {
    const job = running("job-live-commentary");
    const worker = outbox();
    const destination = { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 };
    overwriteDeliveredAnchor(job.id, {
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Running.",
    }, 501);
    const commentary = {
      turnId: "turn-1",
      itemId: "commentary-1",
      commentaryIndex: 0,
      text: "Checking production.",
    };
    const secondCommentary = {
      turnId: "turn-1",
      itemId: "commentary-2",
      commentaryIndex: 1,
      text: "Still checking production.",
    };

    worker.installLiveCommentary(job.id, destination, commentary);
    worker.installLiveCommentary(job.id, destination, commentary);
    worker.installLiveCommentary(job.id, destination, secondCommentary);
    expect(store.get(job.id)?.phase).toBe("running");

    await worker.pump();

    expect(telegram.calls.filter((payload) => payload.operation === "send_text")
      .map((payload) => payload.operation === "send_text" ? payload.text : "")).toEqual([
        "Checking production.",
        "Still checking production.",
      ]);
    expect(store.listDeliveries(job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ partKey: "summary:0000:0000", kind: "summary", state: "delivered" }),
      expect.objectContaining({ partKey: "summary:0001:0000", kind: "summary", state: "delivered" }),
    ]));
    const recreatedWorker = outbox();
    recreatedWorker.installLiveCommentary(job.id, destination, commentary);
    await recreatedWorker.pump();
    expect(telegram.calls.filter((payload) =>
      payload.operation === "send_text" && payload.text.includes("Checking production."))).toHaveLength(1);
    expect(() => recreatedWorker.installLiveCommentary(job.id, destination, {
      ...commentary,
      text: "Conflicting replay.",
    })).toThrow("Telegram live commentary conflict");

    const runningJob = store.get(job.id)!;
    const completed = store.transition({
      jobId: job.id,
      eventId: `${job.id}:complete`,
      expectedVersion: runningJob.version,
      event: {
        schemaVersion: 1,
        type: "turn.completed",
        eventAt: now,
        turnResult: { schemaVersion: 1, content: [
          { kind: "text", phase: "commentary", text: "Checking production." },
          { kind: "text", phase: "commentary", text: "Still checking production." },
          { kind: "text", phase: "final_answer", text: "Done." },
        ] },
      },
    });
    worker.installPlan(completed.id, destination);
    await worker.pump();

    expect(telegram.calls.filter((payload) =>
      payload.operation === "send_text" && payload.text.includes("Checking production."))).toHaveLength(1);
    expect(telegram.calls.some((payload) =>
      payload.operation === "send_text" && payload.text === "Done.")).toBe(true);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("finalizes an already delivered empty plan when the restart pump finds no pending row", async () => {
    const job = delivering("restart-complete", []);
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: now,
    });
    expect(store.listDueDeliveries(now, 10)).toEqual([]);
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", responsePlan: [] });

    store.close();
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    await outbox().pump();

    expect(telegram.calls).toEqual([]);
    expect(store.get(job.id)).toMatchObject({
      phase: "terminal", outcome: "completed", responsePlan: [], deliveries: [],
    });
  });

  it("restores and sends the immutable final edit after status overwrites the delivered anchor", async () => {
    const job = delivering("status-overwrote-final");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    overwriteDeliveredAnchor(job.id, {
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working",
    }, 501);

    store.close();
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    await outbox().pump();

    expect(telegram.calls).toEqual([expect.objectContaining({
      operation: "edit_text", chatId: -1001, messageId: 501, text: "answer",
    })]);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("gives a restored final edit its own retry budget after many status revisions", async () => {
    const job = delivering("status-attempts-do-not-exhaust-final");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    overwriteDeliveredAnchor(job.id, {
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working",
    }, 501);
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try {
      raw.prepare(`UPDATE deliveries SET attempt_count = 24
        WHERE job_id = ? AND part_key = 'status-anchor'`).run(job.id);
    } finally { raw.close(); }
    let attempts = 0;
    telegram.behavior = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ambiguous edit timeout");
      return { messageId: 501 };
    };

    await worker.pump();
    now += 1_000;
    await worker.pump();

    expect(telegram.calls).toHaveLength(2);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("narrowly bootstraps a missing v5 anchor plan and restores the deterministic final edit", async () => {
    const job = delivering("v5-status-overwrote-final");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    overwriteDeliveredAnchor(job.id, {
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working",
    }, 501);
    store.close();
    downgradeToV5WithoutAnchorPlans();
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));

    await outbox().pump();

    expect(telegram.calls).toEqual([expect.objectContaining({
      operation: "edit_text", chatId: -1001, messageId: 501, text: "answer",
    })]);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("does not bootstrap a v5 plan when durable completion metadata requires a transform", async () => {
    const job = delivering("v5-completion-transform");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    const source = store.readSourcePayload(job.id) as Record<string, unknown>;
    store.replaceSourcePayload(job.id, job.source, {
      ...source, completion: { kind: "inbox_ticket", ticketId: 12 },
    });
    overwriteDeliveredAnchor(job.id, {
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working",
    }, 501);
    store.close();
    downgradeToV5WithoutAnchorPlans();
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));

    await outbox().pump();

    expect(telegram.calls).toEqual([]);
    expect(store.get(job.id)).toMatchObject({
      phase: "delivering", outcome: null,
      attention: { kind: "required", code: "delivery_plan_recovery_unsafe", actions: ["inspect"] },
    });
  });

  it("does not bootstrap a deleted immutable plan for a native v6 job", async () => {
    const job = delivering("native-v6-missing-plan");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    overwriteDeliveredAnchor(job.id, {
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Still working",
    }, 501);
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try { raw.prepare("DELETE FROM status_anchor_plans WHERE job_id = ?").run(job.id); }
    finally { raw.close(); }

    await worker.pump();

    expect(telegram.calls).toEqual([]);
    expect(store.get(job.id)).toMatchObject({
      phase: "delivering", outcome: null,
      attention: { kind: "required", code: "delivery_plan_recovery_unsafe", actions: ["inspect"] },
    });
  });

  it("does not duplicate an ambiguous planned send when no anchor message id is known", async () => {
    const job = delivering("ambiguous-final-send");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: null });
    const status = { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Still working" } as const;
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try {
      raw.prepare(`UPDATE deliveries SET state = 'uncertain', payload_json = ?, content_hash = ?,
        telegram_message_id = NULL, last_error_code = 'telegram_send_uncertain' WHERE job_id = ? AND part_key = 'status-anchor'`)
        .run(JSON.stringify(status), hashTelegramDeliveryPayload(status), job.id);
    } finally { raw.close(); }

    store.close();
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    await outbox().pump();

    expect(telegram.calls).toEqual([]);
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("does not starve a completed delivering plan behind more than 1000 terminal status candidates", async () => {
    for (let index = 0; index < 1_001; index += 1) terminalDistractor(`terminal-${String(index).padStart(4, "0")}`);
    const target = delivering("completed-delivering-target", []);
    const worker = outbox();
    worker.installPlan(target.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({
      jobId: target.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: now,
    });

    await worker.pump();

    expect(telegram.calls).toEqual([]);
    expect(store.get(target.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  }, 30_000);

  it.each(["pending", "sending", "uncertain", "failed"] as const)(
    "does not finalize a plan while its anchor is %s",
    async (state) => {
      const job = delivering(`incomplete-${state}`, []);
      const worker = outbox();
      worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
      store.transitionDelivery({
        jobId: job.id, partKey: "status-anchor", state, attemptCount: 0,
        nextAttemptAt: state === "pending" || state === "sending" ? now + 1_000 : null,
        lastErrorCode: state === "uncertain" || state === "failed" ? `test-${state}` : null,
        updatedAt: now,
      });

      await worker.pump();

      expect(telegram.calls).toEqual([]);
      expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
    },
  );

  it("does not finalize invalid anchor or plan rows even when every row says delivered", async () => {
    const invalidAnchor = delivering("invalid-anchor", []);
    const worker = outbox();
    worker.installPlan(invalidAnchor.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({
      jobId: invalidAnchor.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: now,
    });

    const invalidPlan = delivering("invalid-plan", [{ kind: "text", text: "x".repeat(8_500) }]);
    worker.installPlan(invalidPlan.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 502 });
    store.listDeliveries(invalidPlan.id).forEach((part, index) => store.transitionDelivery({
      jobId: invalidPlan.id, partKey: part.partKey, state: "delivered", attemptCount: 1,
      telegramMessageId: 502 + index, updatedAt: now,
    }));

    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try {
      raw.prepare("UPDATE deliveries SET kind = 'final' WHERE job_id = ? AND part_key = 'status-anchor'")
        .run(invalidAnchor.id);
      raw.prepare("UPDATE deliveries SET kind = 'notice' WHERE job_id = ? AND part_key != 'status-anchor'")
        .run(invalidPlan.id);
    } finally { raw.close(); }

    await worker.pump();

    expect(telegram.calls).toEqual([]);
    expect(store.get(invalidAnchor.id)).toMatchObject({ phase: "delivering", outcome: null });
    expect(store.get(invalidPlan.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("does not finalize delivered ordinary rows with corrupt hashes or missing message ids", async () => {
    const corruptHash = delivering("ordinary-corrupt-hash", [{ kind: "text", text: "x".repeat(8_500) }]);
    const missingMessage = delivering("ordinary-missing-message", [{ kind: "text", text: "y".repeat(8_500) }]);
    const worker = outbox();
    for (const [job, anchorId] of [[corruptHash, 501], [missingMessage, 601]] as const) {
      worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: anchorId });
      store.listDeliveries(job.id).forEach((part, index) => store.transitionDelivery({
        jobId: job.id, partKey: part.partKey, state: "delivered", attemptCount: 1,
        telegramMessageId: anchorId + index, updatedAt: now,
      }));
    }
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try {
      raw.prepare(`UPDATE deliveries SET content_hash = ?
        WHERE job_id = ? AND part_key != 'status-anchor'`).run("f".repeat(64), corruptHash.id);
      raw.prepare(`UPDATE deliveries SET telegram_message_id = NULL
        WHERE job_id = ? AND part_key != 'status-anchor'`).run(missingMessage.id);
    } finally { raw.close(); }

    await worker.pump();

    expect(telegram.calls).toEqual([]);
    expect(store.get(corruptHash.id)).toMatchObject({ phase: "delivering", outcome: null });
    expect(store.get(missingMessage.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("quarantines a malformed immutable plan without starving a later valid completion", async () => {
    const malformed = delivering("a-malformed-anchor-plan", []);
    const valid = delivering("z-valid-anchor-plan", []);
    const worker = outbox();
    for (const [job, messageId] of [[malformed, 501], [valid, 601]] as const) {
      worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: messageId });
      store.transitionDelivery({
        jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
        telegramMessageId: messageId, updatedAt: now,
      });
    }
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try {
      raw.prepare("UPDATE status_anchor_plans SET payload_json = '{}' WHERE job_id = ?").run(malformed.id);
    } finally { raw.close(); }

    await worker.pump();

    expect(store.get(malformed.id)).toMatchObject({
      phase: "delivering", outcome: null,
      attention: { kind: "required", code: "delivery_plan_recovery_unsafe", actions: ["inspect"] },
    });
    expect(store.get(valid.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("does not duplicate a successful edit when its immutable plan is malformed", async () => {
    const job = delivering("malformed-plan-after-edit");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    try { raw.prepare("UPDATE status_anchor_plans SET payload_json = '{}' WHERE job_id = ?").run(job.id); }
    finally { raw.close(); }

    await worker.pump();
    now += 1_000;
    await worker.pump();

    expect(telegram.calls).toHaveLength(1);
    expect(store.listDeliveries(job.id)[0]).toMatchObject({ state: "delivered", telegramMessageId: 501 });
    expect(store.get(job.id)).toMatchObject({
      phase: "delivering", outcome: null,
      attention: { kind: "required", code: "delivery_plan_recovery_unsafe", actions: ["inspect"] },
    });
  });

  it("does not finalize a completed plan from a stale reconciliation snapshot", async () => {
    const job = delivering("stale-finalize", []);
    const worker = outbox();
    const planned = worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: now,
    });
    let raced = false;
    const racingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "scanDeliveryCompletionCandidates") return (
          input: Parameters<typeof target.scanDeliveryCompletionCandidates>[0],
        ) => {
          const stale = target.scanDeliveryCompletionCandidates(input);
          if (!raced && stale.candidates.some((candidate) => candidate.jobId === job.id)) {
            const current = target.get(job.id)!;
            target.transition({
              jobId: job.id, eventId: "racing-version-change", expectedVersion: current.version,
              event: { schemaVersion: 1, type: "activity.observed", eventAt: now, health: "healthy" },
            });
            raced = true;
          }
          return stale;
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const wakeups: Array<{ at: number; wake: () => Promise<void> }> = [];
    const recoveryWorker = outbox({
      store: racingStore,
      scheduleWakeup: (at, wake) => wakeups.push({ at, wake }),
    });

    await recoveryWorker.pump();

    expect(raced).toBe(true);
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", version: planned.version + 1 });
    expect(wakeups.map(({ at }) => at)).toEqual([now + 1_000]);
    expect(telegram.calls).toEqual([]);

    now += 1_000;
    await wakeups[0]!.wake();

    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(telegram.calls).toEqual([]);
  });

  it("reschedules completion after a finalize error while preserving the thrown result", async () => {
    const job = delivering("errored-finalize", []);
    const workerForPlan = outbox();
    workerForPlan.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: now,
    });
    let fail = true;
    const faultStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "finalizeDeliveredPlan") return (
          input: Parameters<typeof target.finalizeDeliveredPlan>[0],
        ) => {
          if (fail) { fail = false; throw new Error("injected finalize failure"); }
          return target.finalizeDeliveredPlan(input);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wakeups: Array<{ at: number; wake: () => Promise<void> }> = [];
    const worker = outbox({
      store: faultStore,
      scheduleWakeup: (at, wake) => wakeups.push({ at, wake }),
    });

    await expect(worker.pump()).rejects.toThrow("injected finalize failure");

    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
    expect(wakeups.map(({ at }) => at)).toEqual([now + 1_000]);
    expect(telegram.calls).toEqual([]);

    now += 1_000;
    await wakeups[0]!.wake();

    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(telegram.calls).toEqual([]);
  });

  it("refuses direct completed projection while the physical anchor is pending", () => {
    const job = delivering();
    const worker = outbox();
    const planned = worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });

    expect(() => store.transition({
      jobId: job.id, eventId: "bypass-completion", expectedVersion: planned.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: now, outcome: "completed",
        responsePlan: [], deliveries: [] },
    })).toThrow("Telegram delivery incomplete");
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
    expect(store.listDeliveries(job.id)[0]?.state).toBe("pending");
  });

  it("refuses direct completed projection when the physical anchor is missing", () => {
    const job = delivering();
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    raw.prepare("DELETE FROM deliveries WHERE job_id = ?").run(job.id);
    raw.close();

    expect(() => store.transition({
      jobId: job.id, eventId: "missing-anchor-completion", expectedVersion: job.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: now, outcome: "completed",
        responsePlan: [], deliveries: [] },
    })).toThrow("Telegram delivery incomplete");
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("refuses a caller-supplied empty plan while persisted response parts are pending", () => {
    const job = delivering("malicious-empty-plan", [{ kind: "text", text: "x".repeat(8_500) }]);
    const worker = outbox();
    const planned = worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: now,
    });

    expect(() => store.transition({
      jobId: job.id, eventId: "empty-plan-completion", expectedVersion: planned.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: now, outcome: "completed",
        responsePlan: [], deliveries: [] },
    })).toThrow("Telegram delivery incomplete");
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
    expect(store.listDeliveries(job.id).filter((part) => part.partKey !== "status-anchor"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: "pending" })]));
  });

  it("uses the exact known edit target and treats message-not-modified as delivered", async () => {
    const job = delivering();
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("message_not_modified"); };

    await worker.pump();

    expect(telegram.calls).toEqual([expect.objectContaining({
      operation: "edit_text", chatId: -1001, messageId: 501, text: "answer",
    })]);
    expect(store.listDeliveries(job.id)[0]).toMatchObject({ state: "delivered", telegramMessageId: 501 });
  });

  it("marks a timed-out new send uncertain and never retries it automatically", async () => {
    vi.useFakeTimers();
    const job = delivering();
    const worker = outbox({ timeoutMs: 10 });
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: null });
    telegram.behavior = () => new Promise(() => {});

    const pumping = worker.pump();
    await vi.advanceTimersByTimeAsync(11);
    await pumping;
    await worker.pump();

    expect(telegram.calls).toHaveLength(1);
    expect(store.listDeliveries(job.id).find((part) => part.state === "uncertain"))
      .toMatchObject({ partKey: "status-anchor", attemptCount: 1 });
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
    expect(isDoneEligible(store.get(job.id)!)).toBe(false);
  });

  it("schedules and safely retries a timed-out edit of a known message", async () => {
    vi.useFakeTimers();
    const job = delivering();
    let wake!: () => Promise<void>;
    const wakeups: number[] = [];
    const first = outbox({ timeoutMs: 10, scheduleWakeup: (at, callback) => {
      wakeups.push(at); wake = callback;
    } });
    first.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    telegram.behavior = () => new Promise(() => {});
    const pumping = first.pump();
    await vi.advanceTimersByTimeAsync(11);
    await pumping;

    expect(store.listDeliveries(job.id)[0]).toMatchObject({
      state: "pending", attemptCount: 1, nextAttemptAt: now + 1_000,
    });
    expect(wakeups).toEqual([now + 1_000]);
    telegram.behavior = async () => ({ messageId: 501 });
    now += 1_000;
    await wake();

    expect(telegram.calls).toHaveLength(2);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("reschedules retry_after without consuming an attempt", async () => {
    const job = delivering();
    const wakeups: number[] = [];
    const worker = outbox({ scheduleWakeup: (at) => wakeups.push(at) });
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("retry_after", 2_000); };

    await worker.pump();

    expect(store.listDeliveries(job.id)[0]).toMatchObject({ state: "pending", attemptCount: 0, nextAttemptAt: now + 2_000 });
    expect(wakeups).toEqual([now + 2_000]);
  });

  it("durably schedules a bounded retry after a proven not-sent result", async () => {
    const job = delivering("not-sent-retry");
    const wakeups: number[] = [];
    const worker = outbox({ scheduleWakeup: (at) => wakeups.push(at) });
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("not_sent"); };

    await worker.pump();

    expect(store.listDeliveries(job.id)[0]).toMatchObject({
      state: "pending", attemptCount: 0, nextAttemptAt: now + 1_000,
    });
    expect(wakeups).toEqual([now + 1_000]);
  });

  it("persists permanent failure with bounded actions and never renders Done", async () => {
    const job = delivering();
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("permanent"); };

    await worker.pump();

    expect(store.listDeliveries(job.id)[0]).toMatchObject({ state: "failed", lastErrorCode: "telegram_permanent" });
    expect(store.get(job.id)).toMatchObject({
      phase: "delivering", outcome: null,
      attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
    });
    expect(isDoneEligible(store.get(job.id)!)).toBe(false);
  });

  it("retries one exact failed part only after an explicit operator action", async () => {
    const job = delivering("manual-failed-retry");
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("permanent"); };
    await worker.pump();
    telegram.behavior = async () => ({ messageId: 501 });

    await worker.retryFailed(job.id, "status-anchor");

    expect(telegram.calls).toHaveLength(2);
    expect(store.listDeliveries(job.id)[0]).toMatchObject({ state: "delivered", attemptCount: 2 });
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("replaces a missing installed status anchor and pumps its persisted followers", async () => {
    const worker = outbox({
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
    });
    const job = await failInstalledAnchor(worker, "missing-installed-anchor");
    let call = 0;
    telegram.behavior = async () => {
      call += 1;
      if (call === 1) throw new TelegramDeliveryApiError("message_missing");
      return { messageId: 700 + call };
    };

    await worker.retryFailed(job.id, "status-anchor");

    expect(telegram.calls.map((payload) => payload.operation)).toEqual([
      "edit_text", "send_text", "send_text", "send_text",
    ]);
    expect(telegram.calls[1]).toEqual({
      operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Response follows.",
    });
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(store.listDeliveries(job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ partKey: "status-anchor", state: "delivered", attemptCount: 3 }),
      expect.objectContaining({ kind: "final", state: "delivered" }),
      expect.objectContaining({ kind: "notice", state: "delivered" }),
    ]));
  });

  it("recovers after a replacement CAS failure without sending a duplicate anchor", async () => {
    let inject = false;
    const faultStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "replaceMissingStatusAnchorEdit") return (
          input: Parameters<typeof target.replaceMissingStatusAnchorEdit>[0],
        ) => {
          if (inject) { inject = false; throw new Error("injected replacement CAS failure"); }
          return target.replaceMissingStatusAnchorEdit(input);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wakeups: Array<{ at: number; wake: () => Promise<void> }> = [];
    const worker = outbox({
      store: faultStore,
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
      scheduleWakeup: (at, wake) => wakeups.push({ at, wake }),
    });
    const job = await failInstalledAnchor(worker, "replacement-cas-failure");
    inject = true;
    telegram.behavior = async (payload) => {
      if (payload.operation === "edit_text") throw new TelegramDeliveryApiError("message_missing");
      return { messageId: 710 };
    };

    await expect(worker.retryFailed(job.id, "status-anchor"))
      .rejects.toThrow("injected replacement CAS failure");

    expect(telegram.calls.map((payload) => payload.operation)).toEqual(["edit_text"]);
    expect(store.listDeliveries(job.id).find((part) => part.partKey === "status-anchor"))
      .toMatchObject({ state: "sending", attemptCount: 1, nextAttemptAt: now + 30_000 });
    expect(wakeups.map(({ at }) => at)).toEqual([now + 30_000]);

    now += 30_000;
    await wakeups[0]!.wake();

    expect(telegram.calls.map((payload) => payload.operation)).toEqual([
      "edit_text", "edit_text", "send_text", "send_text", "send_text",
    ]);
    expect(telegram.calls.filter((payload) =>
      payload.operation === "send_text" && payload.text === "Response follows.")).toHaveLength(1);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("recovers after a replacement claim failure without sending before the normal wakeup", async () => {
    let inject = false;
    const faultStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "transitionDeliveryAndProject") return (
          input: Parameters<typeof target.transitionDeliveryAndProject>[0],
        ) => {
          if (inject && input.partKey === "status-anchor"
            && input.expectedState === "pending" && input.state === "sending") {
            inject = false;
            throw new Error("injected replacement claim failure");
          }
          return target.transitionDeliveryAndProject(input);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wakeups: Array<{ at: number; wake: () => Promise<void> }> = [];
    const worker = outbox({
      store: faultStore,
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
      scheduleWakeup: (at, wake) => wakeups.push({ at, wake }),
    });
    const job = await failInstalledAnchor(worker, "replacement-claim-failure");
    inject = true;
    telegram.behavior = async (payload) => {
      if (payload.operation === "edit_text") throw new TelegramDeliveryApiError("message_missing");
      return { messageId: 720 };
    };

    await expect(worker.retryFailed(job.id, "status-anchor"))
      .rejects.toThrow("injected replacement claim failure");

    expect(telegram.calls.map((payload) => payload.operation)).toEqual(["edit_text"]);
    expect(store.listDeliveries(job.id).find((part) => part.partKey === "status-anchor"))
      .toMatchObject({ state: "pending", attemptCount: 2, nextAttemptAt: now });
    expect(wakeups.map(({ at }) => at)).toEqual([now]);

    await wakeups[0]!.wake();

    expect(telegram.calls.map((payload) => payload.operation)).toEqual([
      "edit_text", "send_text", "send_text", "send_text",
    ]);
    expect(telegram.calls.filter((payload) =>
      payload.operation === "send_text" && payload.text === "Response follows.")).toHaveLength(1);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("marks a confirmed replacement send uncertain when its finish cannot be persisted", async () => {
    let inject = false;
    const faultStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "transitionDeliveryAndProject") return (
          input: Parameters<typeof target.transitionDeliveryAndProject>[0],
        ) => {
          if (inject && input.partKey === "status-anchor"
            && input.expectedState === "sending" && input.state === "delivered") {
            inject = false;
            throw new Error("injected replacement finish failure");
          }
          return target.transitionDeliveryAndProject(input);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wakeups: number[] = [];
    const worker = outbox({
      store: faultStore,
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
      scheduleWakeup: (at) => wakeups.push(at),
    });
    const job = await failInstalledAnchor(worker, "replacement-finish-failure");
    inject = true;
    let call = 0;
    telegram.behavior = async () => {
      call += 1;
      if (call === 1) throw new TelegramDeliveryApiError("message_missing");
      return { messageId: 730 };
    };

    await worker.retryFailed(job.id, "status-anchor");
    await worker.pump();

    expect(telegram.calls.map((payload) => payload.operation)).toEqual(["edit_text", "send_text"]);
    expect(store.listDeliveries(job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ partKey: "status-anchor", state: "uncertain", attemptCount: 3 }),
      expect.objectContaining({ kind: "final", state: "pending" }),
      expect.objectContaining({ kind: "notice", state: "pending" }),
    ]));
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
    expect(wakeups).toEqual([]);
  });

  it("leaves a timed-out replacement send uncertain without pumping followers", async () => {
    vi.useFakeTimers();
    const worker = outbox({
      timeoutMs: 10,
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
    });
    const job = await failInstalledAnchor(worker, "missing-replacement-timeout");
    telegram.behavior = (payload) => payload.operation === "edit_text"
      ? Promise.reject(new TelegramDeliveryApiError("message_missing"))
      : new Promise(() => {});

    const retrying = worker.retryFailed(job.id, "status-anchor");
    await vi.advanceTimersByTimeAsync(11);
    await retrying;

    expect(telegram.calls.map((payload) => payload.operation)).toEqual(["edit_text", "send_text"]);
    expect(store.listDeliveries(job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ partKey: "status-anchor", state: "uncertain" }),
      expect.objectContaining({ kind: "final", state: "pending" }),
      expect.objectContaining({ kind: "notice", state: "pending" }),
    ]));
  });

  it("keeps a rate-limited replacement pending without pumping followers", async () => {
    const worker = outbox({
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
    });
    const job = await failInstalledAnchor(worker, "missing-replacement-rate-limit");
    telegram.behavior = async (payload) => {
      if (payload.operation === "edit_text") throw new TelegramDeliveryApiError("message_missing");
      throw new TelegramDeliveryApiError("retry_after", 2_000);
    };

    await worker.retryFailed(job.id, "status-anchor");

    expect(telegram.calls.map((payload) => payload.operation)).toEqual(["edit_text", "send_text"]);
    expect(store.listDeliveries(job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        partKey: "status-anchor", state: "pending", nextAttemptAt: now + 2_000,
      }),
      expect.objectContaining({ kind: "final", state: "pending" }),
      expect.objectContaining({ kind: "notice", state: "pending" }),
    ]));
  });

  it("fails a missing non-anchor edit permanently without replacing it", async () => {
    const statusDestination = vi.fn(() => ({ chatId: -1001, messageThreadId: 7 }));
    const worker = outbox({ statusDestination });
    const job = delivering("missing-non-anchor");
    worker.installPlan(
      job.id,
      { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 },
      undefined,
      {
        result: { schemaVersion: 1, content: [] },
        supplementalParts: [{
          partKey: "final:manual",
          kind: "final",
          payload: {
            operation: "edit_text",
            chatId: -1001,
            messageId: 601,
            text: "Final response.",
          },
        }],
      },
    );
    telegram.behavior = async (payload) => {
      if (payload.operation === "edit_text" && payload.messageId === 501) return { messageId: 501 };
      throw new TelegramDeliveryApiError("permanent");
    };
    await worker.pump();
    telegram.calls.length = 0;
    const final = store.listDeliveries(job.id).find((part) => part.kind === "final")!;
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("message_missing"); };

    await worker.retryFailed(job.id, final.partKey);

    expect(telegram.calls).toHaveLength(1);
    expect(statusDestination).not.toHaveBeenCalled();
    expect(store.listDeliveries(job.id).find((part) => part.partKey === final.partKey))
      .toMatchObject({ state: "failed", lastErrorCode: "telegram_permanent" });
  });

  it("fails closed when the canonical status destination is unavailable", async () => {
    const worker = outbox();
    const job = await failInstalledAnchor(worker, "missing-destination");
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("message_missing"); };

    await worker.retryFailed(job.id, "status-anchor");

    expect(telegram.calls.map((payload) => payload.operation)).toEqual(["edit_text"]);
    expect(store.listDeliveries(job.id).find((part) => part.partKey === "status-anchor"))
      .toMatchObject({ state: "failed", lastErrorCode: "telegram_permanent" });
  });

  it("accepts a canonical null root-topic destination for the replacement send", async () => {
    const worker = outbox({
      statusDestination: () => ({ chatId: -1001, messageThreadId: null }),
    });
    const job = await failInstalledAnchor(worker, "missing-root-anchor", null);
    let call = 0;
    telegram.behavior = async () => {
      call += 1;
      if (call === 1) throw new TelegramDeliveryApiError("message_missing");
      return { messageId: 800 + call };
    };

    await worker.retryFailed(job.id, "status-anchor");

    expect(telegram.calls[1]).toEqual({
      operation: "send_text", chatId: -1001, messageThreadId: null, text: "Response follows.",
    });
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("recovers sending new messages as uncertain but safely retries known edits", async () => {
    const newJob = delivering("new-send");
    const editJob = delivering("known-edit");
    const worker = outbox();
    worker.installPlan(newJob.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: null });
    worker.installPlan(editJob.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({ jobId: newJob.id, partKey: "status-anchor", state: "sending", attemptCount: 0, updatedAt: now });
    store.transitionDelivery({ jobId: editJob.id, partKey: "status-anchor", state: "sending", attemptCount: 0, updatedAt: now });

    await worker.pump();

    expect(store.listDeliveries(newJob.id).find((part) => part.partKey === "status-anchor")?.state).toBe("uncertain");
    expect(store.listDeliveries(editJob.id).find((part) => part.partKey === "status-anchor")?.state).toBe("delivered");
    expect(telegram.calls).toHaveLength(1);
  });

  it.each(["pending", "sending"] as const)("recreates a wakeup for future %s work", async (state) => {
    const job = delivering(`future-${state}`);
    const first = outbox();
    first.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state, attemptCount: 0,
      nextAttemptAt: now + 1_000, updatedAt: now,
    });
    const wakeups: number[] = [];

    await outbox({ scheduleWakeup: (at) => wakeups.push(at) }).pump();

    expect(telegram.calls).toEqual([]);
    expect(wakeups).toEqual([now + 1_000]);
  });

  it("requires explicit warned resend for an uncertain new message", async () => {
    const job = delivering();
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: null });
    store.transitionDelivery({ jobId: job.id, partKey: "status-anchor", state: "uncertain", attemptCount: 1, updatedAt: now });

    await worker.sendAgainWithWarning(job.id, "status-anchor");

    expect(telegram.calls).toHaveLength(1);
    expect(store.listDeliveries(job.id).find((part) => part.partKey === "status-anchor"))
      .toMatchObject({ state: "delivered", attemptCount: 2 });
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("reinstalls the same immutable plan after progress but rejects a different rebuild", async () => {
    const delivered = delivering("delivered-plan");
    const deliveredWorker = outbox();
    deliveredWorker.installPlan(delivered.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    await deliveredWorker.pump();
    const terminalVersion = store.get(delivered.id)!.version;

    expect(deliveredWorker.installPlan(delivered.id, {
      chatId: -1001, messageThreadId: 7, anchorMessageId: 501,
    }).version).toBe(terminalVersion);
    expect(() => deliveredWorker.installPlan(delivered.id, {
      chatId: -1001, messageThreadId: 7, anchorMessageId: 502,
    })).toThrow("Telegram response plan conflict");

    const uncertain = delivering("uncertain-plan");
    const uncertainWorker = outbox();
    uncertainWorker.installPlan(uncertain.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: null });
    telegram.behavior = async () => { throw new Error("ambiguous"); };
    await uncertainWorker.pump();
    expect(() => uncertainWorker.installPlan(uncertain.id, {
      chatId: -1001, messageThreadId: 7, anchorMessageId: null,
    })).not.toThrow();
  });

  it("rolls back physical rows when atomic plan projection persistence fails", () => {
    const job = delivering();
    const before = store.listDeliveries(job.id);
    const worker = outbox({ createId: () => `${job.id}:complete` });

    expect(() => worker.installPlan(job.id, {
      chatId: -1001, messageThreadId: 7, anchorMessageId: 501,
    })).toThrow();

    expect(store.get(job.id)?.responsePlan).toBeUndefined();
    expect(store.listDeliveries(job.id)).toEqual(before);
  });

  it("fails closed on content-hash corruption before any Telegram call", async () => {
    const job = delivering();
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    const raw = new Database(path.join(directory, "jobs.sqlite"));
    raw.prepare("UPDATE deliveries SET content_hash = ? WHERE job_id = ? AND part_key = ?")
      .run("b".repeat(64), job.id, "status-anchor");
    raw.close();

    await worker.pump();

    expect(telegram.calls).toEqual([]);
    expect(store.listDeliveries(job.id)[0]).toMatchObject({ state: "failed", lastErrorCode: "delivery_payload_corrupt" });
  });

  it("allows only one adapter call when two outbox instances race", async () => {
    const job = delivering();
    const first = outbox();
    const second = outbox();
    first.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    let release!: () => void;
    telegram.behavior = () => new Promise((resolve) => { release = () => resolve({ messageId: 501 }); });

    const firstPump = first.pump();
    await vi.waitFor(() => expect(telegram.calls).toHaveLength(1));
    await second.pump();
    expect(telegram.calls).toHaveLength(1);
    release();
    await firstPump;
  });

  it("reruns an active pump when newly installed due work arrives", async () => {
    const firstJob = delivering("active-pump-a");
    const worker = outbox();
    worker.installPlan(firstJob.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    let rejectFirst!: (error: Error) => void;
    telegram.behavior = () => telegram.calls.length === 1
      ? new Promise((_, reject) => { rejectFirst = reject; })
      : Promise.resolve({ messageId: 502 });

    const firstPump = worker.pump();
    await vi.waitFor(() => expect(telegram.calls).toHaveLength(1));
    const secondJob = delivering("active-pump-b");
    worker.installPlan(secondJob.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 502 });
    const joinedPump = worker.pump();
    rejectFirst(new TelegramDeliveryApiError("permanent"));
    await Promise.all([firstPump, joinedPump]);

    expect(telegram.calls).toHaveLength(2);
    expect(store.get(secondJob.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("keeps later response parts behind an in-flight anchor across two outbox instances", async () => {
    const job = delivering("multipart-race", [{ kind: "text", text: "x".repeat(8_500) }]);
    const first = outbox();
    const second = outbox();
    first.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    let release!: () => void;
    telegram.behavior = (payload) => payload.operation === "edit_text"
      ? new Promise((resolve) => { release = () => resolve({ messageId: 501 }); })
      : Promise.resolve({ messageId: 900 + telegram.calls.length });

    const firstPump = first.pump();
    await vi.waitFor(() => expect(telegram.calls).toHaveLength(1));
    await second.pump();
    expect(telegram.calls).toHaveLength(1);
    release();
    await firstPump;

    expect(telegram.calls.map((payload) => payload.operation)).toEqual([
      "edit_text", "send_text", "send_text", "send_text",
    ]);
    expect(store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("delivers contained attachments and rejects a symlink escape before Telegram", async () => {
    const attachmentRoot = path.join(directory, "attachments");
    const outputs = path.join(attachmentRoot, "outputs");
    mkdirSync(outputs, { recursive: true });
    writeFileSync(path.join(outputs, "good.txt"), "safe");
    const good = delivering("good-media", [
      { kind: "attachment", attachment: { kind: "file", path: "outputs/good.txt" } },
    ]);
    const goodWorker = outbox({ attachmentRoot });
    goodWorker.installPlan(good.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 501 });
    await goodWorker.pump();
    expect(telegram.calls).toHaveLength(2);

    const outside = path.join(directory, "outside.txt");
    writeFileSync(outside, "unsafe");
    symlinkSync(outside, path.join(outputs, "link.txt"));
    const escaped = delivering("escaped-media", [
      { kind: "attachment", attachment: { kind: "file", path: "outputs/link.txt" } },
    ]);
    const escapedWorker = outbox({ attachmentRoot });
    escapedWorker.installPlan(escaped.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: 502 });
    await escapedWorker.pump();

    expect(telegram.calls).toHaveLength(3);
    expect(store.listDeliveries(escaped.id).find((part) => part.partKey.startsWith("attachment:"))).toMatchObject({
      state: "failed", lastErrorCode: "delivery_media_unavailable",
    });
  });

  it("does not treat message-not-modified as success for a new send", async () => {
    const job = delivering();
    const worker = outbox();
    worker.installPlan(job.id, { chatId: -1001, messageThreadId: 7, anchorMessageId: null });
    telegram.behavior = async () => { throw new TelegramDeliveryApiError("message_not_modified"); };

    await worker.pump();

    expect(store.listDeliveries(job.id).find((part) => part.partKey === "status-anchor")?.state).toBe("uncertain");
    expect(store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
  });
});
