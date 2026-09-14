import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import {
  replayTelegramJobEvents,
  SqliteTelegramJobStore,
  type TelegramJob,
  type TelegramSourceKey,
} from "../src/telegram-job-store.js";

const BOT_ID = "telecodex-bot";
const SOURCE: TelegramSourceKey = { botId: BOT_ID, updateId: 42 };

function job(id: string, source: TelegramSourceKey = SOURCE, acceptedAt = 1_700_000_000_000): TelegramJob {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    source: { ...source },
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
}

function mode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

function replaceTopicResumeWithV8(database: Database.Database): void {
  database.exec("DROP TABLE topic_resume_attempt_history");
  database.exec("DROP TABLE topic_resume_attempts");
  database.exec(`CREATE TABLE topic_resume_attempts (
    job_id TEXT PRIMARY KEY, action_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, chat_id INTEGER NOT NULL, message_thread_id INTEGER NOT NULL,
    reserved_job_version INTEGER NOT NULL, current_job_version INTEGER NOT NULL,
    next_attempt_at_ms INTEGER, reason_code TEXT,
    started_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`);
}

function logicalDatabaseSnapshot(database: Database.Database): unknown {
  const schema = database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
  const tableNames = schema.filter((entry) => entry.type === "table").map((entry) => entry.name);
  return {
    userVersion: database.pragma("user_version", { simple: true }),
    schema,
    rows: Object.fromEntries(tableNames.map((name) => [
      name,
      database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ])),
  };
}

function waitForMessage<T extends { type: string }>(worker: Worker, type: T["type"]): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { cleanup(); reject(error); };
    const succeed = (message: T) => { cleanup(); resolve(message); };
    const onError = (error: Error) => fail(error);
    const onExit = () => fail(new Error("Telegram ledger worker exited before result"));
    const onMessage = (message: T | { type: "error"; message: string }) => {
      if (message.type === "error") fail(new Error(message.message));
      else if (message.type === type) succeed(message);
    };
    const cleanup = () => {
      worker.off("error", onError);
      worker.off("exit", onExit);
      worker.off("message", onMessage);
    };
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.on("message", onMessage);
  });
}

describe("SqliteTelegramJobStore", () => {
  let directory: string;
  let databasePath: string;
  let stores: SqliteTelegramJobStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-job-ledger-"));
    databasePath = path.join(directory, ".telecodex", "jobs.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function open(options: {
    readonly hardenFile?: (filePath: string) => void;
    readonly maxPageCount?: number;
    readonly readOnly?: boolean;
  } = {}): SqliteTelegramJobStore {
    const store = new SqliteTelegramJobStore(databasePath, options);
    stores.push(store);
    return store;
  }

  it("atomically accepts one job per Telegram update and initializes the private WAL ledger", () => {
    const store = open();
    const payload = { update_id: 42, message: { text: "do not expose me" } };
    const first = store.acceptUpdate({ job: job("job-1"), sourcePayload: payload, eventId: "event-1" });
    const duplicate = open().acceptUpdate({ job: job("job-2"), sourcePayload: payload, eventId: "event-2" });

    expect(first).toEqual({ created: true, job: job("job-1") });
    expect(duplicate).toEqual({ created: false, job: job("job-1") });
    expect(store.getBySourceKey(SOURCE)).toEqual(job("job-1"));
    expect(store.listEvents("job-1")).toEqual([{
      jobId: "job-1", event: { schemaVersion: 1, type: "update.accepted", eventAt: 1_700_000_000_000 },
      initialJob: expect.objectContaining({ id: "job-1", version: 1, source: SOURCE }),
    }]);

    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM inbox_updates").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM job_events").get()).toEqual({ count: 1 });
      expect(db.pragma("user_version", { simple: true })).toBe(10);
      expect(db.prepare("SELECT count(*) AS count FROM status_anchor_plans").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM status_anchor_plan_bootstrap_eligibility").get())
        .toEqual({ count: 0 });
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
    }
    expect(mode(databasePath)).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      expect(existsSync(`${databasePath}${suffix}`)).toBe(true);
      expect(mode(`${databasePath}${suffix}`)).toBe(0o600);
    }
  });

  it("creates the v6 immutable status anchor plan schema", () => {
    open();
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.prepare("PRAGMA table_info(status_anchor_plans)").all()).toEqual([
        { cid: 0, name: "job_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "payload_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: "content_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 3, name: "installed_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      ]);
      expect(db.prepare("PRAGMA foreign_key_list(status_anchor_plans)").all()).toEqual([
        expect.objectContaining({ table: "jobs", from: "job_id", to: "id" }),
      ]);
      expect(db.prepare("PRAGMA table_info(status_anchor_plan_bootstrap_eligibility)").all()).toEqual([
        { cid: 0, name: "job_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      ]);
    } finally { db.close(); }
  });

  it("preserves the exact v7 topic recovery schema while migrating v6 to v10", () => {
    open().close();
    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE topic_resume_attempt_history");
    legacy.exec("DROP TABLE topic_resume_attempts");
    legacy.exec("DROP TABLE topic_recoveries");
    legacy.pragma("user_version = 6");
    legacy.close();

    open();
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(10);
      expect(db.prepare("PRAGMA table_info(topic_recoveries)").all()).toEqual([
        { cid: 0, name: "job_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "action_token", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 3, name: "old_chat_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 4, name: "old_message_thread_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 5, name: "new_message_thread_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 6, name: "reserved_job_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 7, name: "current_job_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 8, name: "next_attempt_at_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 9, name: "reason_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 10, name: "started_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 11, name: "updated_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      ]);
      expect(db.prepare("PRAGMA index_list(topic_recoveries)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ unique: 1, origin: "u" }),
        expect.objectContaining({ unique: 1, origin: "pk" }),
      ]));
      expect(db.prepare("PRAGMA foreign_key_list(topic_recoveries)").all()).toEqual([
        expect.objectContaining({ table: "jobs", from: "job_id", to: "id" }),
      ]);
    } finally { db.close(); }
  });

  it("migrates v7 to the exact topic resume schema at v10", () => {
    open().close();
    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE topic_resume_attempt_history");
    legacy.exec("DROP TABLE topic_resume_attempts");
    legacy.pragma("user_version = 7");
    legacy.close();

    open();
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(10);
      expect(db.prepare("PRAGMA table_info(topic_resume_attempts)").all()).toEqual([
        { cid: 0, name: "job_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "action_token", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 3, name: "resume_mode", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 4, name: "anchor_attempt_baseline", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 5, name: "recovery_job_version_baseline", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 6, name: "delivery_topology_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 7, name: "chat_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 8, name: "message_thread_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 9, name: "reserved_job_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 10, name: "current_job_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 11, name: "next_attempt_at_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 12, name: "reason_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 13, name: "started_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 14, name: "updated_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      ]);
      expect(db.prepare("PRAGMA index_list(topic_resume_attempts)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ unique: 1, origin: "u" }),
        expect.objectContaining({ unique: 1, origin: "pk" }),
      ]));
      expect(db.prepare("PRAGMA foreign_key_list(topic_resume_attempts)").all()).toEqual([
        expect.objectContaining({ table: "jobs", from: "job_id", to: "id" }),
      ]);
    } finally { db.close(); }
  });

  it("migrates an empty v8 topic resume table to v10 without changing its indexes", () => {
    open().close();
    const legacy = new Database(databasePath);
    try {
      replaceTopicResumeWithV8(legacy);
      legacy.pragma("user_version = 8");
    } finally { legacy.close(); }

    open();
    const inspect = new Database(databasePath, { readonly: true });
    try {
      expect(inspect.pragma("user_version", { simple: true })).toBe(10);
      expect(inspect.prepare("PRAGMA table_info(topic_resume_attempts)").all().map((column) =>
        (column as { name: string }).name)).toEqual([
        "job_id", "action_token", "state", "resume_mode", "anchor_attempt_baseline",
        "recovery_job_version_baseline", "delivery_topology_hash", "chat_id",
        "message_thread_id", "reserved_job_version", "current_job_version",
        "next_attempt_at_ms", "reason_code", "started_at_ms", "updated_at_ms",
      ]);
      expect(inspect.prepare("PRAGMA index_list(topic_resume_attempts)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ unique: 1, origin: "u" }),
        expect.objectContaining({ unique: 1, origin: "pk" }),
      ]));
    } finally { inspect.close(); }
  });

  it("rolls back v8 to v10 migration when a resume row cannot acquire baselines", () => {
    const store = open();
    store.acceptUpdate({ job: job("active-resume"), sourcePayload: {}, eventId: "active-resume-event" });
    store.close();
    const legacy = new Database(databasePath);
    let beforeMigration: unknown;
    try {
      replaceTopicResumeWithV8(legacy);
      legacy.prepare(`INSERT INTO topic_resume_attempts
        (job_id, action_token, state, chat_id, message_thread_id, reserved_job_version,
          current_job_version, next_attempt_at_ms, reason_code, started_at_ms, updated_at_ms)
        VALUES (?, ?, 'probe_in_flight', ?, ?, ?, ?, NULL, NULL, ?, ?)`).run(
        "active-resume", "a".repeat(64), -1001, 7, 1, 2, 10, 10,
      );
      legacy.pragma("user_version = 8");
      beforeMigration = logicalDatabaseSnapshot(legacy);
    } finally { legacy.close(); }

    expect(() => open()).toThrow("Cannot migrate active Telegram topic resumes");
    const inspect = new Database(databasePath, { readonly: true });
    try {
      expect(logicalDatabaseSnapshot(inspect)).toEqual(beforeMigration);
    } finally { inspect.close(); }
  });

  it("indexes canonical and archived event streams by job and sequence", () => {
    open();
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.prepare("PRAGMA index_info(job_events_job_sequence)").all()).toEqual([
        { seqno: 0, cid: 1, name: "job_id" },
        { seqno: 1, cid: 0, name: "sequence" },
      ]);
      expect(db.prepare("PRAGMA index_info(job_event_archive_job_sequence)").all()).toEqual([
        { seqno: 0, cid: 0, name: "job_id" },
        { seqno: 1, cid: 1, name: "sequence" },
      ]);
    } finally { db.close(); }
  });

  it("probes SQLite writability without leaving readiness metadata behind", () => {
    const store = open();

    expect(() => store.probeReadable(25)).not.toThrow();
    expect(() => store.probeWritable()).not.toThrow();
    expect(store.getMetadata("telecodex.readiness-probe")).toBeNull();
  });

  it("opens an existing ledger read-only without creating or migrating storage", () => {
    const writable = open();
    writable.acceptUpdate({
      job: job("read-only-job"),
      sourcePayload: { update_id: 42 },
      eventId: "read-only-event",
    });
    const beforeInspect = new Database(databasePath, { readonly: true });
    const beforeVersion = beforeInspect.pragma("user_version", { simple: true });
    beforeInspect.close();

    const readOnly = open({ readOnly: true });

    expect(readOnly.listUnfinished()).toEqual([expect.objectContaining({ id: "read-only-job" })]);
    expect(() => readOnly.setMetadata("read-only-write", true)).toThrow(/readonly/i);
    const inspect = new Database(databasePath, { readonly: true });
    try {
      expect(inspect.pragma("user_version", { simple: true })).toBe(beforeVersion);
      expect(inspect.prepare("SELECT value FROM metadata WHERE key = ?").get("read-only-write")).toBeUndefined();
    } finally { inspect.close(); }
  });

  it("does not create a missing ledger when opened read-only", () => {
    expect(() => open({ readOnly: true })).toThrow("Unable to open Telegram SQLite job ledger");
    expect(existsSync(databasePath)).toBe(false);
  });

  it("fails the read-only release probe for malformed or quarantined rows", () => {
    const store = open();
    store.acceptUpdate({
      job: job("release-probe-job"),
      sourcePayload: { update_id: 42 },
      eventId: "release-probe-event",
    });
    const inspect = new Database(databasePath);
    try {
      const original = inspect.prepare("SELECT projection_json FROM jobs WHERE id = ?")
        .get("release-probe-job") as { projection_json: string };
      inspect.prepare("UPDATE jobs SET projection_json = ? WHERE id = ?").run("{", "release-probe-job");
      expect(() => store.probeReleaseReadable()).toThrow("Malformed Telegram release ledger");

      inspect.prepare("UPDATE jobs SET projection_json = ? WHERE id = ?")
        .run(original.projection_json, "release-probe-job");
      inspect.prepare(`INSERT INTO job_quarantine
        (job_id, reason_code, fingerprint, quarantined_at_ms) VALUES (?, ?, ?, ?)`)
        .run("release-probe-job", "INVALID", "fingerprint", 1_700_000_000_001);
      expect(() => store.probeReleaseReadable()).toThrow("Malformed Telegram release ledger");

      inspect.prepare("DELETE FROM job_quarantine WHERE job_id = ?").run("release-probe-job");
      const current = store.get("release-probe-job")!;
      store.transition({
        jobId: current.id,
        eventId: "release-probe-terminal",
        expectedVersion: current.version,
        event: {
          schemaVersion: 1,
          type: "job.terminal",
          eventAt: current.updatedAt + 1,
          outcome: "failed",
        },
      });
      inspect.prepare(`INSERT INTO job_quarantine
        (job_id, reason_code, fingerprint, quarantined_at_ms) VALUES (?, ?, ?, ?)`)
        .run("release-probe-job", "HISTORICAL", "fingerprint", 1_700_000_000_002);
      expect(() => store.probeReleaseReadable()).toThrow("Malformed Telegram release ledger");
    } finally { inspect.close(); }
  });

  it("fails the release probe when a complete terminal projection conceals active event history", () => {
    const store = open();
    store.acceptUpdate({
      job: job("concealed-active-job"),
      sourcePayload: { update_id: 42 },
      eventId: "concealed-active-event",
    });
    store.insertDelivery({
      jobId: "concealed-active-job",
      partKey: "status-anchor",
      ordinal: 0,
      kind: "status-anchor",
      state: "delivered",
      payload: { operation: "edit_text", chatId: 1, messageId: 9, text: "complete" },
      contentHash: "a".repeat(64),
      telegramMessageId: 9,
      attemptCount: 1,
      updatedAt: 1_700_000_000_001,
    });
    const current = store.get("concealed-active-job")!;
    const concealed = {
      ...current,
      version: current.version + 1,
      phase: "terminal",
      outcome: "failed",
      terminalAt: current.updatedAt + 1,
      updatedAt: current.updatedAt + 1,
    };
    const inspect = new Database(databasePath);
    try {
      inspect.prepare("UPDATE jobs SET version = ?, projection_json = ?, updated_at_ms = ? WHERE id = ?")
        .run(concealed.version, JSON.stringify(concealed), concealed.updatedAt, concealed.id);
    } finally { inspect.close(); }

    expect(store.listUnfinished()).toEqual([]);
    expect(store.listStatusCandidates()).toEqual([]);
    expect(() => store.probeReleaseReadable()).toThrow("Malformed Telegram job projection");

    const quarantine = new Database(databasePath);
    try {
      quarantine.prepare(`INSERT INTO job_quarantine
        (job_id, reason_code, fingerprint, quarantined_at_ms) VALUES (?, ?, ?, ?)`)
        .run("concealed-active-job", "malformed_persisted_job", "b".repeat(64), concealed.updatedAt + 1);
    } finally { quarantine.close(); }
    expect(() => store.probeReleaseReadable()).toThrow("Malformed Telegram release ledger");
  });

  it("fails the release probe for an orphan sending delivery written without foreign keys", () => {
    const store = open();
    const corrupt = new Database(databasePath);
    try {
      corrupt.pragma("foreign_keys = OFF");
      corrupt.prepare(`INSERT INTO deliveries
        (job_id, part_key, ordinal, kind, state, payload_json, content_hash,
          telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("missing-job", "orphan", 0, "final", "sending", "null", "c".repeat(64),
          null, 1, null, null, 1_700_000_000_001);
    } finally { corrupt.close(); }

    expect(() => store.probeReleaseReadable()).toThrow("Malformed Telegram release ledger");
  });

  it("bounds a writability probe while another connection owns the writer lock", () => {
    const store = open();
    const blocker = new Database(databasePath);
    blocker.exec("BEGIN IMMEDIATE");
    const startedAt = Date.now();
    try {
      expect(() => store.probeWritable(25)).toThrow(/locked/i);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("aggregates the full canonical ledger without loading every Dashboard card", () => {
    const store = open();
    for (let index = 0; index < 201; index += 1) {
      const source = { botId: BOT_ID, updateId: 1_000 + index };
      store.acceptUpdate({
        job: job(`aggregate-${index}`, source),
        sourcePayload: { source },
        eventId: `aggregate-event-${index}`,
      });
    }

    expect(store.getDashboardAggregates(1_700_000_010_000)).toEqual({
      oldestQueueAgeMs: null,
      counts: {
        inProgress: 201,
        needsAttention: 0,
        recent: 0,
        ambiguous: 0,
        stalled: 0,
        undelivered: 201,
      },
    });
  });

  it("concurrently initializes one ledger and accepts one durable Telegram update", async () => {
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const shared = new Int32Array(gate);
    const workerModule = new URL("./telegram-job-ledger-worker.ts", import.meta.url).href;
    const bootstrap = `(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(workerModule)}); })();`;
    const workers = ["worker-job-a", "worker-job-b"].map((jobId, index) => new Worker(
      bootstrap,
      { eval: true, workerData: { databasePath, jobId, eventId: `worker-event-${index}`, gate } },
    ));
    try {
      await Promise.all(workers.map((worker) => waitForMessage<{ type: "ready" }>(worker, "ready")));
      const resultPromises = workers.map((worker) => waitForMessage<{
        type: "result"; created: boolean; jobId: string;
      }>(worker, "result"));
      Atomics.store(shared, 0, 1);
      Atomics.notify(shared, 0);
      const results = await Promise.all(resultPromises);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
      const inspect = new Database(databasePath, { readonly: true });
      try {
        for (const table of ["inbox_updates", "jobs", "job_events"]) {
          expect(inspect.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
        }
      } finally { inspect.close(); }
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 20_000);

  it("propagates worker error messages without waiting for worker exit", async () => {
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerModule = new URL("./telegram-job-ledger-worker.ts", import.meta.url).href;
    const bootstrap = `(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(workerModule)}); })();`;
    const worker = new Worker(bootstrap, {
      eval: true, workerData: { databasePath, jobId: "worker-error", eventId: "worker-error-event", gate, fail: true },
    });
    try {
      await waitForMessage<{ type: "ready" }>(worker, "ready");
      const result = waitForMessage<{ type: "result"; created: boolean; jobId: string }>(worker, "result");
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      await expect(result).rejects.toThrow("worker failure");
    } finally { await worker.terminate(); }
  });

  it("rejects a clean worker exit while a result is pending", async () => {
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const bootstrap = `const { parentPort, workerData } = require("node:worker_threads");
      parentPort.postMessage({ type: "ready" });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      process.exit(0);`;
    const worker = new Worker(bootstrap, {
      eval: true, workerData: { databasePath, jobId: "worker-exit", eventId: "worker-exit-event", gate, exit: true },
    });
    try {
      await waitForMessage<{ type: "ready" }>(worker, "ready");
      const result = waitForMessage<{ type: "result"; created: boolean; jobId: string }>(worker, "result");
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      await expect(result).rejects.toThrow("exited before result");
    } finally { await worker.terminate(); }
  });

  it("uses an optimistic transaction to append ordered events and update the projection", () => {
    const store = open();
    store.acceptUpdate({ job: job("job-1"), sourcePayload: { update_id: 42 }, eventId: "event-1" });
    const queued = store.transition({
      jobId: "job-1",
      eventId: "event-2",
      event: { schemaVersion: 1, type: "job.queued", eventAt: 1_700_000_000_001 },
      expectedVersion: 1,
    });

    expect(queued).toMatchObject({ phase: "queued", version: 2 });
    expect(() => store.transition({
      jobId: "job-1",
      eventId: "event-3",
      event: { schemaVersion: 1, type: "dispatch.written", eventAt: 1_700_000_000_002 },
      expectedVersion: 1,
    })).toThrow("Telegram job version conflict");
    expect(store.listEvents("job-1").map((event) => event.event.type)).toEqual([
      "update.accepted", "job.queued",
    ]);
    expect(store.get("job-1")).toEqual(queued);
  });

  it("reopens jobs, orders unfinished and recent lists deterministically, and isolates returned values", () => {
    const first = open();
    first.acceptUpdate({ job: job("job-b", { botId: BOT_ID, updateId: 2 }, 20), sourcePayload: {}, eventId: "event-b" });
    first.acceptUpdate({ job: job("job-a", { botId: BOT_ID, updateId: 1 }, 10), sourcePayload: {}, eventId: "event-a" });
    first.transition({
      jobId: "job-a", eventId: "event-a2", expectedVersion: 1,
      event: { schemaVersion: 1, type: "job.queued", eventAt: 30 },
    });
    first.close();

    const reopened = open();
    const restored = reopened.get("job-a")!;
    (restored.source as { botId: string }).botId = "mutated";
    expect(reopened.get("job-a")?.source.botId).toBe(BOT_ID);
    expect(reopened.listUnfinished().map((item) => item.id)).toEqual(["job-a", "job-b"]);
    expect(reopened.listDispatchable(1).map((item) => item.id)).toEqual(["job-a"]);
    expect(reopened.listRecent(2).map((item) => item.id)).toEqual(["job-a", "job-b"]);
    const events = reopened.listEvents("job-a");
    expect(events.map((event) => event.event.type)).toEqual(["update.accepted", "job.queued"]);
    expect(events[1]?.event.expectedVersion).toBe(1);
    expect(replayTelegramJobEvents(events)).toEqual(reopened.get("job-a"));
  });

  it("rejects an untrusted event expectedVersion without appending an event or projection", () => {
    const store = open();
    store.acceptUpdate({ job: job("job-1"), sourcePayload: {}, eventId: "event-1" });
    expect(() => store.transition({
      jobId: "job-1", eventId: "event-2", expectedVersion: 1,
      event: { schemaVersion: 1, type: "job.queued", eventAt: 1_700_000_000_001, expectedVersion: 99 } as never,
    })).toThrow("Telegram job event must not include expectedVersion");
    expect(store.get("job-1")).toEqual(job("job-1"));
    expect(store.listEvents("job-1")).toHaveLength(1);
  });

  it("rejects bounded identifiers, invalid SHA-256 hashes, and invalid replay roles without leaking input", () => {
    const store = open();
    const secret = "unsafe-source-marker";
    expect(() => store.acceptUpdate({
      job: job("job-1"), sourcePayload: { secret }, eventId: "x".repeat(129),
    })).toThrow("Invalid eventId");
    expect(() => store.insertDelivery({
      jobId: "job-1", partKey: "part", ordinal: 0, kind: "final", state: "pending", payload: {},
      contentHash: "A".repeat(64), updatedAt: 1,
    })).toThrow("Invalid contentHash");
    expect(() => replayTelegramJobEvents([{
      jobId: "job-1", event: { schemaVersion: 1, type: "job.queued", eventAt: 1 },
    }] as never)).toThrow("Malformed Telegram job event stream");
  });

  it("fails safely when raw SQLite rows disagree with projections or event envelopes", () => {
    const store = open();
    store.acceptUpdate({ job: job("job-1"), sourcePayload: { prompt: "do not expose" }, eventId: "event-1" });
    store.close();
    const corrupt = new Database(databasePath);
    corrupt.prepare("UPDATE jobs SET version = ? WHERE id = ?").run(9, "job-1");
    corrupt.close();
    expect(() => open().get("job-1")).toThrow("Malformed Telegram job row");

    const repaired = new Database(databasePath);
    repaired.prepare("UPDATE jobs SET version = ? WHERE id = ?").run(1, "job-1");
    repaired.prepare("UPDATE job_events SET event_type = ? WHERE job_id = ?").run("wrong", "job-1");
    repaired.close();
    expect(() => open().get("job-1")).toThrow("Malformed Telegram job event");
  });

  it("uses inbox rows as the canonical boundary for every job reader", () => {
    const store = open();
    store.acceptUpdate({ job: job("job-1"), sourcePayload: { prompt: "inbox-secret" }, eventId: "event-1" });
    store.transition({ jobId: "job-1", eventId: "event-2", expectedVersion: 1, event: { schemaVersion: 1, type: "job.queued", eventAt: 1_700_000_000_001 } });
    store.close();
    const corrupt = new Database(databasePath);
    expect(() => corrupt.prepare(`INSERT INTO inbox_updates
      (bot_id, update_id, accepted_at_ms, source_json, job_id) VALUES (?, ?, ?, ?, ?)`)
      .run("other-bot", 99, 1, "{}", "job-1")).toThrow("UNIQUE constraint failed");
    corrupt.prepare("UPDATE inbox_updates SET bot_id = ?, accepted_at_ms = ? WHERE job_id = ?").run("wrong-bot", 9, "job-1");
    corrupt.close();

    const reader = open();
    for (const read of [
      () => reader.get("job-1"), () => reader.getBySourceKey(SOURCE), () => reader.listUnfinished(),
      () => reader.listDispatchable(10), () => reader.listRecent(10), () => reader.listEvents("job-1"),
      () => reader.acceptUpdate({ job: job("job-duplicate"), sourcePayload: { prompt: "inbox-secret" }, eventId: "event-duplicate" }),
    ]) expect(read).toThrow("Malformed Telegram job inbox");
    let error: unknown;
    try { reader.get("job-1"); } catch (caught) { error = caught; }
    expect(String(error)).not.toContain("inbox-secret");
    reader.close();

    const missing = new Database(databasePath);
    missing.prepare("DELETE FROM inbox_updates WHERE job_id = ?").run("job-1");
    missing.close();
    const missingReader = open();
    expect(() => missingReader.get("job-1")).toThrow("Malformed Telegram job inbox");
    expect(() => missingReader.getBySourceKey(SOURCE)).toThrow("Malformed Telegram job inbox");
  });

  it("fails closed on missing, mismatched, or corrupt history through every public job reader", () => {
    const store = open();
    store.acceptUpdate({ job: job("job-1"), sourcePayload: { prompt: "history-secret" }, eventId: "event-1" });
    store.transition({
      jobId: "job-1", eventId: "event-2", expectedVersion: 1,
      event: { schemaVersion: 1, type: "job.queued", eventAt: 1_700_000_000_001 },
    });
    store.close();
    const corrupt = new Database(databasePath);
    corrupt.prepare("DELETE FROM job_events WHERE job_id = ?").run("job-1");
    corrupt.close();

    const reader = open();
    for (const read of [
      () => reader.get("job-1"), () => reader.getBySourceKey(SOURCE), () => reader.listUnfinished(),
      () => reader.listDispatchable(10), () => reader.listRecent(10), () => reader.listEvents("job-1"),
      () => reader.acceptUpdate({ job: job("job-duplicate"), sourcePayload: { prompt: "history-secret" }, eventId: "event-duplicate" }),
    ]) expect(read).toThrow("Malformed Telegram job projection");

    reader.close();
    const mismatched = new Database(databasePath);
    mismatched.prepare("INSERT INTO job_events (job_id, event_id, event_type, event_at_ms, payload_json) VALUES (?, ?, ?, ?, ?)").run(
      "job-1", "event-1", "update.accepted", 1_700_000_000_000,
      JSON.stringify({ jobId: "job-1", event: { schemaVersion: 1, type: "update.accepted", eventAt: 1_700_000_000_000 }, initialJob: job("job-1") }),
    );
    mismatched.close();
    expect(() => open().get("job-1")).toThrow("Malformed Telegram job projection");

    const oversized = new Database(databasePath);
    oversized.prepare("UPDATE job_events SET event_id = ? WHERE job_id = ?").run("x".repeat(129), "job-1");
    oversized.close();
    let error: unknown;
    try { open().get("job-1"); } catch (caught) { error = caught; }
    expect(String(error)).toBe("Error: Malformed Telegram job event");
    expect(String(error)).not.toContain("history-secret");
  });

  it("fails construction before accepting work when filesystem hardening fails", () => {
    const secret = "hardener-source-marker";
    let thrown: unknown;
    try {
      new SqliteTelegramJobStore(databasePath, { hardenFile: () => { throw new Error(secret); } });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toBe("Error: Unable to open Telegram SQLite job ledger");
    expect(String(thrown)).not.toContain(secret);
  });

  it("persists and validates delivery parts without coupling delivery policy to the ledger", () => {
    const store = open();
    store.acceptUpdate({ job: job("job-1"), sourcePayload: {}, eventId: "event-1" });
    const inserted = store.insertDelivery({
      jobId: "job-1", partKey: "final:0", ordinal: 0, kind: "final", state: "pending",
      payload: { text: "secret response" }, contentHash: "a".repeat(64), telegramMessageId: 70,
      nextAttemptAt: 99, lastErrorCode: "TEMP", updatedAt: 100,
    });
    const sent = store.transitionDelivery({
      jobId: "job-1", partKey: "final:0", state: "delivered", attemptCount: 1,
      telegramMessageId: 77, nextAttemptAt: 101, lastErrorCode: "RETRY", updatedAt: 101,
    });

    expect(inserted).toMatchObject({ state: "pending", telegramMessageId: 70, attemptCount: 0 });
    expect(sent).toMatchObject({ state: "delivered", telegramMessageId: 77, attemptCount: 1 });
    const preserved = store.transitionDelivery({
      jobId: "job-1", partKey: "final:0", state: "delivered", attemptCount: 2, updatedAt: 102,
    });
    expect(preserved).toMatchObject({ telegramMessageId: 77, nextAttemptAt: 101, lastErrorCode: "RETRY" });
    const cleared = store.transitionDelivery({
      jobId: "job-1", partKey: "final:0", state: "delivered", attemptCount: 3,
      telegramMessageId: null, nextAttemptAt: null, lastErrorCode: null, updatedAt: 103,
    });
    expect(cleared).toMatchObject({ telegramMessageId: null, nextAttemptAt: null, lastErrorCode: null });
    expect(store.listDeliveries("job-1")).toEqual([cleared]);
    expect(() => store.transitionDelivery({
      jobId: "job-1", partKey: "final:0", state: "failed", attemptCount: 0, updatedAt: 100,
    })).toThrow("cannot move backwards");
    expect(() => store.insertDelivery({
      jobId: "job-1", partKey: "final:0", ordinal: 0, kind: "final", state: "pending",
      payload: {}, contentHash: "a".repeat(64), updatedAt: 102,
    })).toThrow("UNIQUE constraint failed");
    expect(() => store.insertDelivery({
      jobId: "unknown-job", partKey: "final:1", ordinal: 1, kind: "final", state: "pending",
      payload: {}, contentHash: "b".repeat(64), updatedAt: 104,
    })).toThrow("FOREIGN KEY constraint failed");
    const inspect = new Database(databasePath, { readonly: true });
    try { expect(inspect.prepare("SELECT count(*) AS count FROM deliveries").get()).toEqual({ count: 1 }); }
    finally { inspect.close(); }
  });

  it("rolls back a locked SQLite accept and accepts the same update after the lock is released", () => {
    const store = open();
    const blocker = new Database(databasePath);
    const payload = { message: { text: "locked-source-payload" } };
    blocker.exec("BEGIN IMMEDIATE");
    try {
      const startedAt = Date.now();
      let lockedError: unknown;
      try {
        store.acceptUpdate({ job: job("locked-job"), sourcePayload: payload, eventId: "locked-event" });
      } catch (error) {
        lockedError = error;
      }
      expect(String(lockedError)).toMatch(/database is locked/i);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
      expect(String(lockedError)).not.toContain("locked-source-payload");
      expect(store.get("locked-job")).toBeNull();
      expect(store.listEvents("locked-job")).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }

    expect(store.acceptUpdate({ job: job("locked-job"), sourcePayload: payload, eventId: "locked-event" }))
      .toEqual({ created: true, job: job("locked-job") });
  }, 15_000);

  it("rolls back an SQLITE_FULL accept before a job becomes dispatchable", () => {
    const store = open({ maxPageCount: 1 });
    const payload = { message: { text: `full-source-payload-${"x".repeat(2 * 1024 * 1024)}` } };

    let fullError: unknown;
    try {
      store.acceptUpdate({ job: job("full-job"), sourcePayload: payload, eventId: "full-event" });
    } catch (error) {
      fullError = error;
    }
    expect(String(fullError)).toMatch(/full/i);
    expect(String(fullError)).not.toContain("full-source-payload");
    store.close();

    const reopened = open();
    expect(reopened.get("full-job")).toBeNull();
    expect(reopened.listDispatchable(10)).toEqual([]);
    expect(reopened.listEvents("full-job")).toEqual([]);
    const inspect = new Database(databasePath, { readonly: true });
    try {
      expect(inspect.prepare("SELECT count(*) AS count FROM inbox_updates").get()).toEqual({ count: 0 });
      expect(inspect.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 0 });
      expect(inspect.prepare("SELECT count(*) AS count FROM job_events").get()).toEqual({ count: 0 });
    } finally {
      inspect.close();
    }
  });

  it("fails closed for non-SQLite JSON, malformed schemas, and errors that contain source payloads", () => {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, JSON.stringify([{ prompt: "do not expose me" }]));
    let error: unknown;
    try { new SqliteTelegramJobStore(databasePath); } catch (caught) { error = caught; }
    expect(String(error)).toBe("Error: Unable to open Telegram SQLite job ledger");
    expect(String(error)).not.toContain("do not expose me");
    expect(readFileSync(databasePath, "utf8")).toContain("do not expose me");

    const malformedPath = path.join(directory, "malformed.sqlite");
    const db = new Database(malformedPath);
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();
    expect(() => new SqliteTelegramJobStore(malformedPath)).toThrow("Malformed telegram job schema");
  });
});
