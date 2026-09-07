import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteTelegramJobStore, type NewDeliveryPart } from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";

const START = 1_700_000_000_000;

describe("Telegram status anchor final plan", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-status-anchor-plan-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("preserves a persisted anchor id by reconciling a final send payload to a known edit", () => {
    let job = accepted(store, "job-final-plan");
    const status = prepareStatus(store, job);
    store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: status.contentHash,
      expectedLeaseUntil: status.nextAttemptAt!,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: START + 2,
    });
    job = advanceToDelivering(store, job);
    installFinalPlan(store, job);

    expect(store.listDeliveries(job.id)).toEqual([
      expect.objectContaining({
        state: "pending",
        telegramMessageId: 501,
        payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Final" },
        contentHash: hashTelegramDeliveryPayload({
          operation: "edit_text", chatId: -1001, messageId: 501, text: "Final",
        }),
      }),
    ]);
  });

  it("installs the final plan without making an uncertain initial anchor automatically retryable", () => {
    let job = accepted(store, "job-uncertain-final-plan");
    const status = prepareStatus(store, job);
    store.finishStatusAnchorRevision({
      jobId: job.id,
      expectedAttemptCount: 0,
      expectedContentHash: status.contentHash,
      expectedLeaseUntil: status.nextAttemptAt!,
      state: "uncertain",
      attemptCount: 1,
      lastErrorCode: "telegram_send_uncertain",
      updatedAt: START + 2,
    });
    job = advanceToDelivering(store, job);
    const finalSend = installFinalPlan(store, job);

    expect(store.listDeliveries(job.id)).toEqual([
      expect.objectContaining({
        state: "uncertain",
        attemptCount: 1,
        telegramMessageId: null,
        lastErrorCode: "telegram_send_uncertain",
        payload: finalSend,
      }),
    ]);
    expect(store.listDueDeliveries(job.updatedAt + 100, 10)).toEqual([]);
  });
});

function accepted(store: SqliteTelegramJobStore, id: string): TelegramJob {
  const job: TelegramJob = {
    schemaVersion: 1,
    id,
    version: 1,
    source: { botId: "bot", updateId: 1 },
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
    acceptedAt: START,
    updatedAt: START,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
  store.acceptUpdate({
    job,
    sourcePayload: { kind: "text", text: "prompt" },
    eventId: `${id}:accepted`,
    initialDeliveries: [reservedAnchor(id)],
  });
  return job;
}

function prepareStatus(store: SqliteTelegramJobStore, job: TelegramJob) {
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
  return prepared.delivery;
}

function installFinalPlan(store: SqliteTelegramJobStore, job: TelegramJob) {
  const payload = { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Final" } as const;
  store.installDeliveryPlan({
    jobId: job.id,
    eventId: `${job.id}:plan`,
    expectedVersion: job.version,
    eventAt: job.updatedAt + 1,
    responsePlan: [],
    parts: [{
      jobId: job.id,
      partKey: "status-anchor",
      ordinal: 0,
      kind: "status-anchor",
      state: "pending",
      payload,
      contentHash: hashTelegramDeliveryPayload(payload),
      telegramMessageId: null,
      updatedAt: job.updatedAt + 1,
    }],
  });
  return payload;
}

function reservedAnchor(jobId: string): NewDeliveryPart {
  return {
    jobId,
    partKey: "status-anchor",
    ordinal: 0,
    kind: "status-anchor",
    state: "pending",
    payload: { chatId: -1001, messageThreadId: 7, sourceMessageId: 11 },
    contentHash: "a".repeat(64),
    updatedAt: START,
  };
}

function advanceToDelivering(store: SqliteTelegramJobStore, initial: TelegramJob): TelegramJob {
  let job = store.transition({
    jobId: initial.id,
    eventId: `${initial.id}:queued`,
    expectedVersion: initial.version,
    event: { schemaVersion: 1, type: "job.queued", eventAt: initial.updatedAt + 1 },
  });
  job = store.transition({
    jobId: job.id,
    eventId: `${job.id}:dispatch`,
    expectedVersion: job.version,
    event: {
      schemaVersion: 1,
      type: "dispatch.started",
      eventAt: job.updatedAt + 1,
      dispatch: {
        id: `${job.id}:dispatch-id`,
        threadId: "thread-1",
        previousTurnId: null,
        attempt: 1,
        startedAt: job.updatedAt + 1,
        transportWriteState: "written",
        nextAttemptAt: null,
      },
    },
  });
  job = store.transition({
    jobId: job.id,
    eventId: `${job.id}:started`,
    expectedVersion: job.version,
    event: {
      schemaVersion: 1,
      type: "turn.started",
      eventAt: job.updatedAt + 1,
      identifiers: { turnId: "turn-1" },
      codexEventAt: job.updatedAt + 1,
    },
  });
  return store.transition({
    jobId: job.id,
    eventId: `${job.id}:completed`,
    expectedVersion: job.version,
    event: {
      schemaVersion: 1,
      type: "turn.completed",
      eventAt: job.updatedAt + 1,
      codexEventAt: job.updatedAt + 1,
      turnResult: { schemaVersion: 1, content: [] },
    },
  });
}
