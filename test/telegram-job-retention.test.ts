import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteTelegramJobStore, type TelegramJob } from "../src/telegram-job-store.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";

const DAY = 24 * 60 * 60 * 1_000;
const BASE = 1_700_000_000_000;

describe("Telegram job retention", () => {
  let directory: string;
  let databasePath: string;
  let store: SqliteTelegramJobStore;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-retention-"));
    databasePath = path.join(directory, "jobs.sqlite");
    store = new SqliteTelegramJobStore(databasePath);
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps payload for seven days, then retains only safe event metadata until day ninety", () => {
    const relativePath = "job-one/attachment.txt";
    seedDelivered(store, "job-one", 1, BASE, relativePath);

    expect(store.runRetention(retention(BASE + 7 * DAY - 1))).toMatchObject({
      payloadsPurged: 0,
      jobsDeleted: 0,
    });
    expect(JSON.stringify(store.readSourcePayload("job-one"))).toContain("secret prompt");

    const purged = store.runRetention(retention(BASE + 7 * DAY));

    expect(purged).toEqual({
      payloadsPurged: 1,
      jobsDeleted: 0,
      orphanedMaterializedPaths: [relativePath],
    });
    expect(store.readSourcePayload("job-one")).toEqual({
      botId: "bot",
      updateId: 1,
      chatId: -1001,
      messageThreadId: 7,
      messageId: 11,
      kind: "document",
      text: null,
      attachment: null,
      retryOfJobId: null,
      payloadPurged: true,
    });
    expect(store.get("job-one")).toMatchObject({
      attachments: [],
      retainUntil: BASE + 90 * DAY,
    });
    expect(store.get("job-one")).not.toHaveProperty("materializedPrompt");
    expect(store.get("job-one")).not.toHaveProperty("turnResult");
    expect(store.listEvents("job-one")).toEqual([]);
    expect(store.listEventSummaries("job-one").map((event) => event.type)).toEqual([
      "update.accepted",
      "materialization.succeeded",
      "job.queued",
      "dispatch.started",
      "dispatch.in_flight",
      "dispatch.written",
      "turn.started",
      "turn.completed",
      "delivery.changed",
      "job.terminal",
    ]);
    expect(store.listDeliveries("job-one").every((part) => part.payload === null)).toBe(true);
    expect(JSON.stringify({
      job: store.get("job-one"),
      events: store.listEventSummaries("job-one"),
      source: store.readSourcePayload("job-one"),
      deliveries: store.listDeliveries("job-one"),
    })).not.toMatch(/secret prompt|secret response|telegram-secret-file/);

    store.close();
    store = new SqliteTelegramJobStore(databasePath);
    expect(store.runRetention(retention(BASE + 8 * DAY)).orphanedMaterializedPaths)
      .toEqual([relativePath]);
    expect(store.retentionFileCleanupIsOrphaned(relativePath)).toBe(true);
    store.acknowledgeRetentionFileCleanup(relativePath);
    expect(store.runRetention(retention(BASE + 8 * DAY)).orphanedMaterializedPaths).toEqual([]);

    expect(store.runRetention(retention(BASE + 90 * DAY - 1))).toMatchObject({ jobsDeleted: 0 });
    expect(store.runRetention(retention(BASE + 90 * DAY))).toMatchObject({ jobsDeleted: 1 });
    expect(store.get("job-one")).toBeNull();
    expect(store.listEventSummaries("job-one")).toEqual([]);
  });

  it("preserves only valid synthetic migration provenance while purging its payload", () => {
    const checksum = "c".repeat(64);
    const source = { botId: `legacy-json-v1:${checksum}`, updateId: 7 };
    const migration = { version: "1", checksum, sourceIdentity: "synthetic", ordinal: 7 };
    const accepted: TelegramJob = {
      schemaVersion: 1, version: 1, id: "legacy-retained", source, attachments: [],
      phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" },
      outcome: null, dispatchId: null, threadId: "thread", turnId: "turn",
      responsePlan: undefined, deliveries: [], acceptedAt: BASE, updatedAt: BASE,
      terminalAt: null, dismissedAt: null, retainUntil: null,
    };
    store.setMetadata("legacy-json-migration", {
      status: "complete", version: "1", checksum, sourceIdentity: "synthetic",
      importedCount: 8, quarantinedCount: 0, quarantined: [],
    });
    store.acceptUpdate({
      job: accepted, eventId: "legacy-retained:accepted",
      sourcePayload: { migration, legacy: { input: "secret prompt" }, text: "secret prompt" },
      initialDeliveries: [{
        jobId: accepted.id, partKey: "final:0", ordinal: 0, kind: "final",
        state: "delivered", payload: { text: "secret response" }, contentHash: "a".repeat(64),
        telegramMessageId: null, attemptCount: 0, updatedAt: BASE + 1,
      }],
    });
    store.transitionLegacyMigration({
      jobId: accepted.id, eventId: "legacy-retained:terminal", expectedVersion: 1,
      event: {
        schemaVersion: 1, type: "job.terminal", eventAt: BASE + 1, outcome: "completed",
        responsePlan: [{ partId: "final:0", kind: "final" }],
        deliveries: [{ partId: "final:0", state: "delivered", attempts: 0,
          messageId: null, deliveredAt: BASE + 1 }],
      },
    });

    expect(store.runRetention(retention(BASE + 7 * DAY + 1))).toMatchObject({ payloadsPurged: 1 });
    expect(store.readSourcePayload(accepted.id)).toEqual({
      migration, text: null, attachment: null, payloadPurged: true,
    });
    expect(store.scanReconciliationCandidates({ limit: 10, quarantinedAt: BASE + 8 * DAY }))
      .toMatchObject({ jobs: [], quarantined: [] });
  });

  it("never automatically purges unresolved, failed-delivery, attention, or quarantined jobs", () => {
    seedAccepted(store, "unresolved", 1, BASE);
    seedAccepted(store, "attention", 2, BASE);
    const attention = store.get("attention")!;
    store.transition({
      jobId: attention.id,
      eventId: "attention-required",
      expectedVersion: attention.version,
      event: {
        schemaVersion: 1,
        type: "activity.observed",
        eventAt: BASE + 1,
        health: "stalled",
        attention: { kind: "required", code: "GUARDIAN_RECOVERY_REQUIRED", actions: ["inspect"] },
      },
    });
    seedFailedDelivery(store, "failed-delivery", 3, BASE);
    seedDelivered(store, "quarantined", 4, BASE, "quarantined/file.txt");
    quarantine(databasePath, "quarantined");

    const result = store.runRetention(retention(BASE + 365 * DAY));

    expect(result).toMatchObject({ payloadsPurged: 0, jobsDeleted: 0 });
    for (const id of ["unresolved", "attention", "failed-delivery", "quarantined"]) {
      expect(store.get(id)).not.toBeNull();
    }
  });

  it("purges payload at day seven even when metadata retention was already scheduled", () => {
    seedDelivered(store, "scheduled", 1, BASE, "scheduled/file.txt");
    const terminal = store.get("scheduled")!;
    store.transition({
      jobId: terminal.id,
      eventId: "schedule-retention",
      expectedVersion: terminal.version,
      event: {
        schemaVersion: 1,
        type: "delivery.changed",
        eventAt: BASE + 1,
        retainUntil: BASE + 90 * DAY,
      },
    });

    expect(store.runRetention(retention(BASE + 7 * DAY))).toMatchObject({ payloadsPurged: 1 });
    expect(store.readSourcePayload("scheduled")).toMatchObject({ payloadPurged: true });
    expect(store.get("scheduled")).toMatchObject({ retainUntil: BASE + 90 * DAY });
  });

  it("is batched, restart-safe, and a rolled-back clock cannot purge early", () => {
    for (let index = 1; index <= 3; index += 1) {
      seedDelivered(store, `job-${index}`, index, BASE, `shared/file-${index}.txt`);
    }

    expect(store.runRetention({ ...retention(BASE + 7 * DAY - 1), batchSize: 2 }))
      .toMatchObject({ payloadsPurged: 0 });
    expect(store.runRetention({ ...retention(BASE + 7 * DAY), batchSize: 2 }))
      .toMatchObject({ payloadsPurged: 2 });
    store.close();
    store = new SqliteTelegramJobStore(databasePath);

    expect(store.runRetention({ ...retention(BASE + 7 * DAY), batchSize: 2 }))
      .toMatchObject({ payloadsPurged: 1 });
    expect(store.runRetention({ ...retention(BASE + 7 * DAY), batchSize: 2 }))
      .toMatchObject({ payloadsPurged: 0 });
  });

  it("releases a materialized file only when no live job still references it", () => {
    const shared = "shared/live.txt";
    writeFileSync(path.join(directory, "placeholder"), "ok");
    seedDelivered(store, "expired", 1, BASE, shared);
    seedAccepted(store, "live", 2, BASE, shared);

    const first = store.runRetention(retention(BASE + 7 * DAY));
    expect(first.orphanedMaterializedPaths).not.toContain(shared);

    const live = store.get("live")!;
    store.transition({
      jobId: live.id,
      eventId: "dismiss-live",
      expectedVersion: live.version,
      event: {
        schemaVersion: 1,
        type: "job.terminal",
        eventAt: BASE + 1,
        outcome: "aborted",
        dismissedAt: BASE + 1,
      },
    });
    const second = store.runRetention(retention(BASE + 7 * DAY + 1));
    expect(second.orphanedMaterializedPaths).toEqual([shared]);
  });
});

function retention(now: number) {
  return { now, payloadRetentionMs: 7 * DAY, metadataRetentionMs: 90 * DAY, batchSize: 100 };
}

function seedAccepted(
  store: SqliteTelegramJobStore,
  id: string,
  updateId: number,
  acceptedAt: number,
  relativePath?: string,
): TelegramJob {
  const job: TelegramJob = {
    schemaVersion: 1,
    version: 1,
    id,
    source: { botId: "bot", updateId },
    attachments: relativePath ? [{
      id: `document:${updateId}`,
      kind: "document",
      telegramFileId: "telegram-secret-file",
    }] : [],
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
    eventId: `${id}:accepted`,
    sourcePayload: {
      botId: "bot",
      updateId,
      chatId: -1001,
      messageThreadId: 7,
      messageId: 10 + updateId,
      kind: relativePath ? "document" : "text",
      text: "secret prompt",
      attachment: relativePath ? { telegramFileId: "telegram-secret-file" } : null,
      retryOfJobId: null,
    },
  });
  if (relativePath) {
    return store.transition({
      jobId: id,
      eventId: `${id}:materialized`,
      expectedVersion: 1,
      event: {
        schemaVersion: 1,
        type: "materialization.succeeded",
        eventAt: acceptedAt,
        materializedPrompt: {
          text: "secret prompt",
          attachments: [{ id: `document:${updateId}`, kind: "document", relativePath }],
        },
      },
    });
  }
  return job;
}

function seedDelivered(
  store: SqliteTelegramJobStore,
  id: string,
  updateId: number,
  acceptedAt: number,
  relativePath: string,
): void {
  let current = seedAccepted(store, id, updateId, acceptedAt, relativePath);
  current = transition(store, current, "job.queued", `${id}:queued`, acceptedAt);
  current = store.transition({
    jobId: id,
    eventId: `${id}:dispatch-started`,
    expectedVersion: current.version,
    event: {
      schemaVersion: 1,
      type: "dispatch.started",
      eventAt: acceptedAt,
      dispatch: {
        id: `${id}:dispatch`, threadId: "11111111-1111-4111-8111-111111111111",
        previousTurnId: null, attempt: 1, startedAt: acceptedAt,
        transportWriteState: "prepared", nextAttemptAt: null,
      },
    },
  });
  current = transition(store, current, "dispatch.in_flight", `${id}:dispatch-flight`, acceptedAt);
  current = transition(store, current, "dispatch.written", `${id}:dispatch-written`, acceptedAt);
  current = store.transition({
    jobId: id,
    eventId: `${id}:turn-started`,
    expectedVersion: current.version,
    event: {
      schemaVersion: 1,
      type: "turn.started",
      eventAt: acceptedAt,
      identifiers: { turnId: "22222222-2222-4222-8222-222222222222" },
    },
  });
  current = store.transition({
    jobId: id,
    eventId: `${id}:turn-completed`,
    expectedVersion: current.version,
    event: {
      schemaVersion: 1,
      type: "turn.completed",
      eventAt: acceptedAt,
      turnResult: { schemaVersion: 1, content: [{ kind: "text", text: "secret response" }] },
    },
  });
  const finalPayload = {
    operation: "send_text", chatId: -1001, messageThreadId: null, text: "secret response",
  } as const;
  current = store.installDeliveryPlan({
    jobId: id,
    eventId: `${id}:plan`,
    expectedVersion: current.version,
    eventAt: acceptedAt,
    responsePlan: [],
    parts: [{
      jobId: id,
      partKey: "status-anchor",
      ordinal: 0,
      kind: "status-anchor",
      state: "pending",
      payload: finalPayload,
      contentHash: hashTelegramDeliveryPayload(finalPayload),
      updatedAt: acceptedAt,
    }],
  });
  store.transitionDelivery({
    jobId: id,
    partKey: "status-anchor",
    state: "sending",
    attemptCount: 1,
    updatedAt: acceptedAt,
  });
  store.transitionDeliveryAndProject({
    jobId: id,
    partKey: "status-anchor",
    expectedState: "sending",
    expectedAttemptCount: 1,
    state: "delivered",
    attemptCount: 1,
    telegramMessageId: 500 + updateId,
    updatedAt: acceptedAt,
    eventId: `${id}:delivered`,
    expectedJobVersion: current.version,
  });
}

function seedFailedDelivery(store: SqliteTelegramJobStore, id: string, updateId: number, acceptedAt: number): void {
  const current = seedAccepted(store, id, updateId, acceptedAt);
  store.insertDelivery({
    jobId: id,
    partKey: "status-anchor",
    ordinal: 0,
    kind: "status-anchor",
    state: "failed",
    payload: { text: "secret response" },
    contentHash: "b".repeat(64),
    attemptCount: 5,
    lastErrorCode: "TELEGRAM_PERMANENT",
    updatedAt: acceptedAt,
  });
  store.transition({
    jobId: id,
    eventId: `${id}:failed-attention`,
    expectedVersion: current.version,
    event: {
      schemaVersion: 1,
      type: "activity.observed",
      eventAt: acceptedAt,
      attention: { kind: "required", code: "DELIVERY_FAILED", actions: ["inspect"] },
    },
  });
}

function transition(
  store: SqliteTelegramJobStore,
  current: TelegramJob,
  type: "job.queued" | "dispatch.in_flight" | "dispatch.written",
  eventId: string,
  eventAt: number,
): TelegramJob {
  return store.transition({
    jobId: current.id,
    eventId,
    expectedVersion: current.version,
    event: { schemaVersion: 1, type, eventAt },
  });
}

function quarantine(databasePath: string, jobId: string): void {
  const database = new Database(databasePath);
  try {
    database.prepare(`INSERT INTO job_quarantine
      (job_id, reason_code, fingerprint, quarantined_at_ms) VALUES (?, ?, ?, ?)`).run(
      jobId, "TEST_QUARANTINE", "fingerprint", BASE,
    );
  } finally {
    database.close();
  }
}
