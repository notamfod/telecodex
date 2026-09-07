import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";
import {
  SqliteTelegramJobStore,
  type TelegramJob,
} from "../src/telegram-job-store.js";
import {
  hashTelegramDeliveryPayload,
} from "../src/telegram-response-plan.js";
import {
  planTelegramTopicRecovery,
  type TelegramTopicRecoveryCandidate,
} from "../src/telegram-topic-recovery.js";
import type { TelegramTopicRecoveryRecord } from "../src/telegram-topic-recovery-ledger.js";

const NOW = 1_700_000_000_000;
const OLD = { chatId: -100_123, messageThreadId: 41 } as const;
const NEW = { chatId: OLD.chatId, messageThreadId: 99 } as const;
const token = (value: number) => value.toString(16).padStart(64, "0");

describe("Telegram topic recovery ledger", () => {
  let directory: string;
  let databasePath: string;
  let stores: SqliteTelegramJobStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-recovery-"));
    databasePath = path.join(directory, "jobs.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function open(readOnly = false): SqliteTelegramJobStore {
    const store = new SqliteTelegramJobStore(databasePath, { readOnly });
    stores.push(store);
    return store;
  }

  test("reserves one exact candidate and advances its job once", () => {
    const fixture = recoverable(open(), "job-1", 1);

    const result = fixture.store.reserveTopicRecovery({
      candidate: fixture.candidate,
      eventId: "reserve-1",
      actionToken: token(1),
      eventAt: NOW + 20,
    });

    expect(result.recovery).toEqual({
      jobId: "job-1",
      actionToken: token(1),
      state: "in_flight",
      oldDestination: OLD,
      newMessageThreadId: null,
      reservedJobVersion: fixture.job.version,
      currentJobVersion: fixture.job.version + 1,
      nextAttemptAt: null,
      reasonCode: null,
      startedAt: NOW + 20,
      updatedAt: NOW + 20,
    });
    expect(result.job).toMatchObject({
      version: fixture.job.version + 1,
      attention: { kind: "required", code: "TOPIC_RECOVERY_IN_FLIGHT", actions: ["inspect"] },
    });
    expect(fixture.store.getTopicRecovery(fixture.job.id)).toEqual(result.recovery);
    expect(() => fixture.store.reserveTopicRecovery({
      candidate: fixture.candidate,
      eventId: "reserve-duplicate",
      actionToken: token(2),
      eventAt: NOW + 21,
    })).toThrow();
    expect(fixture.store.get(fixture.job.id)).toEqual(result.job);
    expect(fixture.store.getTopicRecovery(fixture.job.id)).toEqual(result.recovery);
  });

  test("rejects a stale reservation without any partial write", () => {
    const fixture = recoverable(open(), "job-1", 1);
    const before = snapshot(databasePath);
    expect(() => fixture.store.reserveTopicRecovery({
      candidate: { ...fixture.candidate, expectedVersion: fixture.candidate.expectedVersion - 1 },
      eventId: "reserve-stale", actionToken: token(3), eventAt: NOW + 20,
    })).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  test("atomically rebinds the complete plan and schedules only the anchor retry", () => {
    const fixture = recoverable(open(), "job-1", 1);
    const reserved = fixture.store.reserveTopicRecovery({
      candidate: fixture.candidate,
      eventId: "reserve-1",
      actionToken: token(1),
      eventAt: NOW + 20,
    });

    const completed = fixture.store.completeTopicRecovery({
      jobId: fixture.job.id,
      expectedVersion: reserved.job.version,
      eventId: "complete-1",
      actionToken: token(1),
      target: NEW,
      eventAt: NOW + 21,
    });

    expect(completed.recovery).toMatchObject({
      state: "complete",
      currentJobVersion: reserved.job.version + 1,
      newMessageThreadId: NEW.messageThreadId,
      reasonCode: null,
    });
    expect(completed.job).toMatchObject({
      version: reserved.job.version + 1,
      attention: { kind: "none" },
    });
    expect(completed.anchor).toMatchObject({
      partKey: "status-anchor",
      state: "pending",
      telegramMessageId: null,
      attemptCount: 1,
      nextAttemptAt: null,
      lastErrorCode: null,
    });
    const parts = fixture.store.listDeliveries(fixture.job.id);
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part.payload).toMatchObject(NEW);
      expect(part.contentHash).toBe(hashTelegramDeliveryPayload(part.payload));
    }
    const rich = parts.find((part) => (part.payload as { operation?: unknown }).operation === "send_rich");
    expect((rich!.payload as any).fallbackParts[0].payload).toMatchObject(NEW);
    expect(fixture.store.readSourcePayload(fixture.job.id)).toMatchObject({ targetContext: NEW });
    expect(raw(databasePath, (db) => db.prepare(
      "SELECT payload_json, content_hash FROM status_anchor_plans WHERE job_id = ?",
    ).get(fixture.job.id))).toEqual({
      payload_json: JSON.stringify(completed.anchor.payload),
      content_hash: completed.anchor.contentHash,
    });
  });

  it.each([
    ["retry_wait", (fixture: ReturnType<typeof reservedFixture>) => fixture.store.deferTopicRecovery({
      ...outcomeInput(fixture), nextAttemptAt: NOW + 60,
    }), "TOPIC_RECOVERY_RATE_LIMITED", NOW + 60],
    ["unknown", (fixture: ReturnType<typeof reservedFixture>) => fixture.store.markTopicRecoveryUnknown({
      ...outcomeInput(fixture), reasonCode: "TOPIC_RECOVERY_UNKNOWN",
    }), "TOPIC_RECOVERY_UNKNOWN", null],
    ["failed", (fixture: ReturnType<typeof reservedFixture>) => fixture.store.failTopicRecovery({
      ...outcomeInput(fixture), reasonCode: "TOPIC_RECOVERY_FAILED",
    }), "TOPIC_RECOVERY_FAILED", null],
  ] as const)("atomically records the %s outcome and advances attention", (
    state, transition, reasonCode, nextAttemptAt,
  ) => {
    const fixture = reservedFixture(open());
    const beforeVersion = fixture.reserved.job.version;

    const recovery = transition(fixture);

    expect(recovery).toMatchObject({
      state, reasonCode, nextAttemptAt, currentJobVersion: beforeVersion + 1,
    });
    expect(fixture.store.get(fixture.job.id)).toMatchObject({
      version: beforeVersion + 1,
      attention: { kind: "required", actions: ["inspect"] },
    });
    expect(fixture.store.listTopicRecoveries([state])).toEqual([recovery]);
  });

  test("resumes a due rate-limited recovery with one versioned compare-and-swap", () => {
    const fixture = reservedFixture(open());
    const waiting = fixture.store.deferTopicRecovery({
      ...outcomeInput(fixture), nextAttemptAt: NOW + 60,
    });

    const resumed = fixture.store.resumeTopicRecovery({
      jobId: fixture.job.id, expectedVersion: waiting.currentJobVersion,
      actionToken: waiting.actionToken, updatedAt: NOW + 60,
    });

    expect(resumed.recovery).toMatchObject({
      state: "in_flight", nextAttemptAt: null, reasonCode: null,
      currentJobVersion: waiting.currentJobVersion + 1,
    });
    expect(resumed.job).toMatchObject({
      version: waiting.currentJobVersion + 1,
      attention: { kind: "required", code: "TOPIC_RECOVERY_IN_FLIGHT", actions: ["inspect"] },
    });
  });

  it.each([
    ["early deadline", (waiting: TelegramTopicRecoveryRecord) => ({ updatedAt: waiting.nextAttemptAt! - 1 })],
    ["stale version", (waiting: TelegramTopicRecoveryRecord) => ({ expectedVersion: waiting.currentJobVersion - 1 })],
    ["stale token", () => ({ actionToken: token(99) })],
  ])("rolls back a retry resume on %s", (_name, override) => {
    const fixture = reservedFixture(open());
    const waiting = fixture.store.deferTopicRecovery({ ...outcomeInput(fixture), nextAttemptAt: NOW + 60 });
    const before = snapshot(databasePath);
    expect(() => fixture.store.resumeTopicRecovery({
      jobId: fixture.job.id, expectedVersion: waiting.currentJobVersion,
      actionToken: waiting.actionToken, updatedAt: NOW + 60, ...override(waiting),
    })).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  test("rolls back a retry resume from a stale recovery state", () => {
    const fixture = reservedFixture(open());
    const waiting = fixture.store.deferTopicRecovery({ ...outcomeInput(fixture), nextAttemptAt: NOW + 60 });
    const resumed = fixture.store.resumeTopicRecovery({
      jobId: fixture.job.id, expectedVersion: waiting.currentJobVersion,
      actionToken: waiting.actionToken, updatedAt: NOW + 60,
    });
    const before = snapshot(databasePath);
    expect(() => fixture.store.resumeTopicRecovery({
      jobId: fixture.job.id, expectedVersion: resumed.job.version,
      actionToken: waiting.actionToken, updatedAt: NOW + 61,
    })).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  it.each([
    ["rate limit with stale version", (fixture: ReturnType<typeof reservedFixture>) => fixture.store.deferTopicRecovery({
      ...outcomeInput(fixture), expectedVersion: fixture.reserved.job.version - 1, nextAttemptAt: NOW + 60,
    })],
    ["unknown with stale token", (fixture: ReturnType<typeof reservedFixture>) => fixture.store.markTopicRecoveryUnknown({
      ...outcomeInput(fixture), actionToken: token(99), reasonCode: "TOPIC_RECOVERY_UNKNOWN",
    })],
    ["failure with stale token", (fixture: ReturnType<typeof reservedFixture>) => fixture.store.failTopicRecovery({
      ...outcomeInput(fixture), actionToken: token(99), reasonCode: "TOPIC_RECOVERY_FAILED",
    })],
  ] as const)("rolls back a %s outcome conflict", (_name, transition) => {
    const fixture = reservedFixture(open());
    const before = snapshot(databasePath);
    expect(() => transition(fixture)).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  it.each([
    ["stale job version", () => ({ expectedVersion: 1 })],
    ["recovery token", () => ({ actionToken: "wrong-token" })],
    ["recovery state", () => mutate("UPDATE topic_recoveries SET state = 'failed', reason_code = 'STOPPED' WHERE job_id = 'job-1'")],
    ["source", () => mutateSourceTarget(42)],
    ["delivery state", () => mutate("UPDATE deliveries SET state = 'sending' WHERE job_id = 'job-1' AND part_key = 'final:0000'")],
    ["delivery payload", () => mutate("UPDATE deliveries SET payload_json = json_set(payload_json, '$.text', 'changed') WHERE job_id = 'job-1' AND part_key = 'notice:0001'")],
    ["delivery content hash", () => mutate(`UPDATE deliveries SET content_hash = '${"0".repeat(64)}' WHERE job_id = 'job-1' AND part_key = 'notice:0001'`)],
    ["anchor plan", () => mutate("UPDATE status_anchor_plans SET payload_json = json_set(payload_json, '$.text', 'changed') WHERE job_id = 'job-1'")],
  ] as const)("rolls back every write on a %s mismatch", (_name, arrange) => {
    const fixture = reservedFixture(open());
    const override = arrange() ?? {};
    const before = snapshot(databasePath);

    expect(() => fixture.store.completeTopicRecovery({
      jobId: fixture.job.id,
      expectedVersion: fixture.reserved.job.version,
      eventId: "complete-conflict",
      actionToken: token(1),
      target: NEW,
      eventAt: NOW + 21,
      ...override,
    })).toThrow();

    expect(snapshot(databasePath)).toEqual(before);
  });

  test("leaves unrelated jobs unchanged and preserves database integrity", () => {
    const first = reservedFixture(open(), "job-1", 1);
    recoverable(first.store, "job-2", 2);
    const unrelated = snapshot(databasePath, "job-2");

    first.store.completeTopicRecovery({
      jobId: first.job.id, expectedVersion: first.reserved.job.version,
      eventId: "complete-isolated", actionToken: token(1), target: NEW, eventAt: NOW + 21,
    });

    expect(snapshot(databasePath, "job-2")).toEqual(unrelated);
    expect(raw(databasePath, (db) => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    expect(raw(databasePath, (db) => db.prepare("SELECT count(*) AS count FROM job_quarantine").get()))
      .toEqual({ count: 0 });
  });

  test("rolls back reservation for a noncanonical but normalizable raw anchor plan", () => {
    const fixture = recoverable(open(), "job-1", 1);
    mutate("UPDATE status_anchor_plans SET payload_json = ' ' || payload_json WHERE job_id = 'job-1'");
    const before = snapshot(databasePath);
    expect(() => fixture.store.reserveTopicRecovery({
      candidate: fixture.candidate, eventId: "reserve-noncanonical",
      actionToken: token(4), eventAt: NOW + 20,
    })).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  it.each([
    ["source whitespace", () => mutate("UPDATE inbox_updates SET source_json = ' ' || source_json WHERE job_id = 'job-1'")],
    ["source key order", () => reorderSourceKeys()],
    ["anchor delivery", () => prefixDeliveryJson("status-anchor")],
    ["rich follower", () => prefixDeliveryJson("final:0000")],
    ["notice follower", () => prefixDeliveryJson("notice:0001")],
    ["anchor delivery key order", () => reorderDeliveryKeys("status-anchor")],
    ["rich follower key order", () => reorderDeliveryKeys("final:0000")],
    ["notice follower key order", () => reorderDeliveryKeys("notice:0001")],
  ])("rolls back reservation for noncanonical raw %s JSON", (_name, corrupt) => {
    const fixture = recoverable(open(), "job-1", 1);
    corrupt();
    const before = snapshot(databasePath);
    expect(() => fixture.store.reserveTopicRecovery({
      candidate: fixture.candidate, eventId: "reserve-raw-conflict",
      actionToken: token(5), eventAt: NOW + 20,
    })).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  it.each([
    ["relative", "work/telecodex"],
    ["root", "/"],
    ["unnormalized absolute", "/work/telecodex/../telecodex"],
  ])("rolls back reservation for %s raw source workspace", (_name, workspace) => {
    const fixture = recoverable(open(), "job-1", 1);
    raw(databasePath, (db) => {
      const row = db.prepare("SELECT source_json FROM inbox_updates WHERE job_id = 'job-1'")
        .get() as { source_json: string };
      const source = JSON.parse(row.source_json);
      db.prepare("UPDATE inbox_updates SET source_json = ? WHERE job_id = 'job-1'").run(JSON.stringify({
        ...source,
        sessionDefaults: { workspace, launchProfileId: "default" },
      }));
    });
    const before = snapshot(databasePath);
    expect(() => fixture.store.reserveTopicRecovery({
      candidate: fixture.candidate, eventId: "reserve-invalid-workspace",
      actionToken: token(6), eventAt: NOW + 20,
    })).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  it.each([
    ["source", () => mutate("UPDATE inbox_updates SET source_json = ' ' || source_json WHERE job_id = 'job-1'")],
    ["delivery", () => prefixDeliveryJson("notice:0001")],
  ])("rechecks canonical raw %s JSON during completion", (_name, corrupt) => {
    const fixture = reservedFixture(open());
    corrupt();
    const before = snapshot(databasePath);
    expect(() => fixture.store.completeTopicRecovery({
      jobId: fixture.job.id, expectedVersion: fixture.reserved.job.version,
      eventId: "complete-raw-conflict", actionToken: token(1), target: NEW, eventAt: NOW + 21,
    })).toThrow();
    expect(snapshot(databasePath)).toEqual(before);
  });

  it.each(["operator token", "token\nsecret", "sk-secret-credential"])(
    "rejects unsafe recovery action token %j without writes",
    (actionToken) => {
      const fixture = recoverable(open(), "job-1", 1);
      const before = snapshot(databasePath);
      expect(() => fixture.store.reserveTopicRecovery({
        candidate: fixture.candidate, eventId: "reserve-unsafe-token",
        actionToken, eventAt: NOW + 20,
      })).toThrow();
      expect(snapshot(databasePath)).toEqual(before);
    },
  );

  it.each(["ambiguous prose", "TOPIC_RECOVERY_UNKNOWN\nsecret", "password=credential"])(
    "rejects unsafe recovery reason code %j without writes",
    (reasonCode) => {
      const fixture = reservedFixture(open());
      const before = snapshot(databasePath);
      expect(() => fixture.store.markTopicRecoveryUnknown({
        ...outcomeInput(fixture), reasonCode: reasonCode as "TOPIC_RECOVERY_UNKNOWN",
      })).toThrow();
      expect(snapshot(databasePath)).toEqual(before);
    },
  );

  test("strictly decodes records and permits read-only inspection but not mutation", () => {
    const fixture = reservedFixture(open());
    const readOnly = open(true);
    expect(readOnly.getTopicRecovery(fixture.job.id)).toEqual(fixture.reserved.recovery);
    expect(() => readOnly.failTopicRecovery({
      ...outcomeInput(fixture), reasonCode: "TOPIC_RECOVERY_FAILED",
    })).toThrow(/readonly/i);

    readOnly.close();
  });

  it.each([
    ["unknown state", "state = 'unexpected'"],
    ["nullable-field mismatch", "reason_code = 'NOT_NULL'"],
    ["out-of-range destination", "old_message_thread_id = 0"],
    ["unsafe reason code", "state = 'failed', reason_code = 'password=credential'"],
  ])("rejects a strictly malformed recovery row with %s", (_name, assignment) => {
    const fixture = reservedFixture(open());
    mutate(`UPDATE topic_recoveries SET ${assignment} WHERE job_id = 'job-1'`);
    expect(() => fixture.store.getTopicRecovery(fixture.job.id)).toThrow("Malformed Telegram topic recovery");
  });

  test("derives collision-safe outcome event identities from the full action token", () => {
    const store = open();
    const first = recoverable(store, "job-1", 1);
    const second = recoverable(store, "job-2", 2);
    const reserve = (fixture: typeof first, suffix: string) => store.reserveTopicRecovery({
      candidate: fixture.candidate, eventId: `reserve-${suffix}`,
      actionToken: suffix === "one" ? token(1) : token(2), eventAt: NOW + 20,
    });
    const firstReserved = reserve(first, "one");
    const secondReserved = reserve(second, "two");

    expect(store.failTopicRecovery({
      jobId: first.job.id, expectedVersion: firstReserved.job.version,
      actionToken: token(1), reasonCode: "TOPIC_RECOVERY_FAILED", updatedAt: NOW + 21,
    }).state).toBe("failed");
    expect(store.failTopicRecovery({
      jobId: second.job.id, expectedVersion: secondReserved.job.version,
      actionToken: token(2), reasonCode: "TOPIC_RECOVERY_FAILED", updatedAt: NOW + 21,
    }).state).toBe("failed");
  });

  test("retains only bounded recovery metadata and deletes it before the retained job", () => {
    const fixture = reservedFixture(open());
    const completed = fixture.store.completeTopicRecovery({
      jobId: fixture.job.id, expectedVersion: fixture.reserved.job.version,
      eventId: "complete-retention", actionToken: token(1), target: NEW, eventAt: NOW + 21,
    });
    const terminal = deliverAndFinalize(fixture.store, completed.job, NOW + 22);

    expect(fixture.store.runRetention({
      now: terminal.terminalAt! + 2, payloadRetentionMs: 1, metadataRetentionMs: 100, batchSize: 10,
    }).payloadsPurged).toBe(1);
    const encoded = JSON.stringify(fixture.store.getTopicRecovery(fixture.job.id));
    expect(encoded).not.toContain("Response follows");
    expect(encoded).not.toContain("Result");
    expect(encoded).not.toContain("Notice");
    expect(fixture.store.runRetention({
      now: terminal.terminalAt! + 101, payloadRetentionMs: 1, metadataRetentionMs: 100, batchSize: 10,
    }).jobsDeleted).toBe(1);
    expect(fixture.store.getTopicRecovery(fixture.job.id)).toBeNull();
  });

  function mutate(sql: string): void {
    raw(databasePath, (db) => db.exec(sql));
  }

  function mutateSourceTarget(messageThreadId: number): void {
    raw(databasePath, (db) => {
      const row = db.prepare("SELECT source_json FROM inbox_updates WHERE job_id = 'job-1'").get() as { source_json: string };
      const source = JSON.parse(row.source_json);
      db.prepare("UPDATE inbox_updates SET source_json = ? WHERE job_id = 'job-1'")
        .run(JSON.stringify({ ...source, targetContext: { ...source.targetContext, messageThreadId } }));
    });
  }

  function reorderSourceKeys(): void {
    raw(databasePath, (db) => {
      const row = db.prepare("SELECT source_json FROM inbox_updates WHERE job_id = 'job-1'").get() as { source_json: string };
      const { botId, ...source } = JSON.parse(row.source_json);
      db.prepare("UPDATE inbox_updates SET source_json = ? WHERE job_id = 'job-1'")
        .run(JSON.stringify({ ...source, botId }));
    });
  }

  function prefixDeliveryJson(partKey: string): void {
    raw(databasePath, (db) => db.prepare(`UPDATE deliveries SET payload_json = ' ' || payload_json
      WHERE job_id = 'job-1' AND part_key = ?`).run(partKey));
  }

  function reorderDeliveryKeys(partKey: string): void {
    raw(databasePath, (db) => {
      const row = db.prepare(`SELECT payload_json FROM deliveries
        WHERE job_id = 'job-1' AND part_key = ?`).get(partKey) as { payload_json: string };
      const { operation, ...payload } = JSON.parse(row.payload_json);
      db.prepare(`UPDATE deliveries SET payload_json = ?
        WHERE job_id = 'job-1' AND part_key = ?`).run(JSON.stringify({ ...payload, operation }), partKey);
    });
  }
});

function reservedFixture(store: SqliteTelegramJobStore, id = "job-1", updateId = 1) {
  const fixture = recoverable(store, id, updateId);
  const reserved = store.reserveTopicRecovery({
    candidate: fixture.candidate, eventId: `reserve-${id}`, actionToken: token(updateId), eventAt: NOW + 20,
  });
  return { ...fixture, reserved };
}

function outcomeInput(fixture: ReturnType<typeof reservedFixture>) {
  return {
    jobId: fixture.job.id,
    expectedVersion: fixture.reserved.job.version,
    actionToken: fixture.reserved.recovery.actionToken,
    updatedAt: NOW + 21,
  };
}

function snapshot(databasePath: string, jobId?: string): unknown {
  return raw(databasePath, (db) => Object.fromEntries([
    "jobs", "inbox_updates", "job_events", "deliveries", "status_anchor_plans", "topic_recoveries",
  ].map((table) => [table, db.prepare(`SELECT * FROM ${table}${jobId ? ` WHERE ${table === "jobs" ? "id" : "job_id"} = ?` : ""} ORDER BY rowid`)
    .all(...(jobId ? [jobId] : []))])));
}

function deliverAndFinalize(store: SqliteTelegramJobStore, initial: TelegramJob, startAt: number): TelegramJob {
  let job = initial;
  let eventAt = startAt;
  for (const partKey of ["status-anchor", "final:0000", "notice:0001"]) {
    const part = store.listDeliveries(job.id).find((candidate) => candidate.partKey === partKey)!;
    let moved = store.transitionDeliveryAndProject({
      jobId: job.id, partKey, expectedJobVersion: job.version,
      expectedState: "pending", expectedAttemptCount: part.attemptCount,
      state: "sending", attemptCount: part.attemptCount,
      eventId: `sending-${partKey}`, updatedAt: eventAt++,
    });
    moved = store.transitionDeliveryAndProject({
      jobId: job.id, partKey, expectedJobVersion: moved.job.version,
      expectedState: "sending", expectedAttemptCount: part.attemptCount,
      state: "delivered", attemptCount: part.attemptCount + 1, telegramMessageId: 100 + eventAt,
      eventId: `delivered-${partKey}`, updatedAt: eventAt++,
    });
    job = moved.job;
  }
  if (job.phase === "terminal") return job;
  return store.finalizeDeliveredPlan({
    jobId: job.id, expectedVersion: job.version, eventId: "finalize-retention", eventAt,
  })!;
}

function recoverable(store: SqliteTelegramJobStore, id: string, updateId: number): {
  readonly store: SqliteTelegramJobStore;
  readonly job: TelegramJob;
  readonly source: TelegramWorkSource;
  readonly candidate: TelegramTopicRecoveryCandidate;
} {
  const source: TelegramWorkSource = {
    botId: "bot", updateId, ...OLD, messageId: updateId, kind: "text", text: "request",
    attachment: null, retryOfJobId: null,
  };
  let job: TelegramJob = {
    schemaVersion: 1, version: 1, id, source: { botId: source.botId, updateId }, attachments: [],
    phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt: NOW, updatedAt: NOW, terminalAt: null, dismissedAt: null, retainUntil: null,
  };
  store.acceptUpdate({ job, sourcePayload: source, eventId: `${id}:accepted` });
  job = store.transition({ jobId: id, eventId: `${id}:queued`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "job.queued", eventAt: NOW + 1 } });
  job = store.transition({ jobId: id, eventId: `${id}:dispatch`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "dispatch.started", eventAt: NOW + 2, dispatch: {
      id: `${id}:dispatch-id`, threadId: "thread-1", previousTurnId: null, attempt: 1,
      startedAt: NOW + 2, transportWriteState: "written", nextAttemptAt: null,
    } } });
  job = store.transition({ jobId: id, eventId: `${id}:started`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.started", eventAt: NOW + 3,
      identifiers: { turnId: "turn-1" }, codexEventAt: NOW + 3 } });
  job = store.transition({ jobId: id, eventId: `${id}:completed`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.completed", eventAt: NOW + 4,
      codexEventAt: NOW + 4, turnResult: { schemaVersion: 1, content: [] } } });
  const anchor = { operation: "send_text" as const, ...OLD, text: "Response follows." };
  const final = {
    operation: "send_rich" as const, ...OLD, markdown: "# Result", media: [], fallbackParts: [{
      partKey: "final:0000:fallback:0000", kind: "final" as const,
      payload: { operation: "send_text" as const, ...OLD, text: "Result" },
    }],
  };
  const notice = { operation: "send_text" as const, ...OLD, text: "Notice" };
  job = store.installDeliveryPlan({
    jobId: id, expectedVersion: job.version, eventId: `${id}:plan`, eventAt: NOW + 5,
    responsePlan: [{ partId: "final:0000", kind: "final" }, { partId: "notice:0001", kind: "notice" }],
    parts: [
      planned(id, "status-anchor", 0, "status-anchor", anchor),
      planned(id, "final:0000", 0, "final", final),
      planned(id, "notice:0001", 1, "notice", notice),
    ],
  });
  let moved = store.transitionDeliveryAndProject({
    jobId: id, partKey: "status-anchor", expectedJobVersion: job.version,
    expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
    eventId: `${id}:anchor-sending`, updatedAt: NOW + 6,
  });
  moved = store.transitionDeliveryAndProject({
    jobId: id, partKey: "status-anchor", expectedJobVersion: moved.job.version,
    expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
    lastErrorCode: "telegram_topic_missing", eventId: `${id}:anchor-failed`, updatedAt: NOW + 7,
    attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
  });
  job = moved.job;
  const anchorPlan = { payload: anchor, contentHash: hashTelegramDeliveryPayload(anchor) };
  const thread: CodexThreadRecord = {
    id: "thread-1", title: "Recover topic", cwd: "/work/telecodex", model: null, modelProvider: null,
    createdAt: new Date(0), updatedAt: new Date(0), firstUserMessage: "recover",
  };
  const candidate = planTelegramTopicRecovery({
    job, source, deliveries: store.listDeliveries(id), anchorPlan, thread,
  });
  if (!candidate) throw new Error("expected recovery candidate");
  return { store, job, source, candidate };
}

function planned(jobId: string, partKey: string, ordinal: number, kind: string, payload: unknown) {
  return {
    jobId, partKey, ordinal, kind, state: "pending" as const, payload,
    contentHash: hashTelegramDeliveryPayload(payload), updatedAt: NOW + 5,
  };
}

function raw<T>(databasePath: string, callback: (database: Database.Database) => T): T {
  const database = new Database(databasePath);
  try { return callback(database); }
  finally { database.close(); }
}

void (undefined as unknown as TelegramTopicRecoveryRecord);
