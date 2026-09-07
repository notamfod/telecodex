import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  compareLegacyTelegramJobs,
  exportLegacyTelegramJobs,
  importLegacyTelegramJobs,
  prepareTelegramJobStoreMode,
  synchronizeLegacyTelegramJobsShadow,
  TelegramJobMigrationError,
} from "../src/telegram-job-migration.js";
import { parseTelegramJobConfig } from "../src/config.js";
import { SqliteTelegramJobStore, TelegramJobStore, type TelegramJob } from "../src/telegram-job-store.js";

const START = 1_700_000_000_000;

function legacy(id: string, state: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    contextKey: "-100123:42",
    chatId: -100123,
    messageThreadId: 42,
    threadId: `thread-${id}`,
    input: { text: `prompt-${id}`, imagePaths: [`/safe/${id}.png`] },
    modelChoiceId: "openai-default",
    cleanupInbox: { workspace: "/safe", turnId: id },
    state,
    sentPartKeys: [],
    createdAt: START,
    updatedAt: START + 10,
    ...overrides,
  };
}

describe("legacy Telegram job migration", () => {
  let directory: string;
  let sourcePath: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-job-migration-"));
    sourcePath = path.join(directory, "jobs.json");
    databasePath = path.join(directory, "jobs.sqlite");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("imports every legacy state through canonical events and preserves the complete source payload", () => {
    const jobs = [
      legacy("waiting", "waiting"),
      legacy("running", "active", { turnId: "turn-running" }),
      legacy("ambiguous", "active", { threadId: "thread-ambiguous" }),
      legacy("delivering", "delivering", { turnId: "turn-delivering", sentPartKeys: ["summary:0"] }),
      legacy("completed", "completed", {
        turnId: "turn-completed", sentPartKeys: ["final:0", "attachment:1"],
        response: "result-present-only-in-source", attachments: [{ path: "/safe/result.txt" }],
      }),
      legacy("failed", "failed", { error: { code: "LEGACY_FAILURE", detail: "source-only" } }),
      legacy("aborted", "aborted", { sentPartKeys: ["notice:0"] }),
      legacy("model", "awaiting-model", { selectionToken: "selection-token" }),
    ];
    const source = `${JSON.stringify(jobs, null, 2)}\n`;
    writeFileSync(sourcePath, source);

    const report = importLegacyTelegramJobs({ sourcePath, databasePath });

    expect(report).toMatchObject({
      status: "imported", readyForSqlite: true, sourceIdentity: "synthetic",
      importedCount: 8, quarantined: [], migrationVersion: "1",
    });
    expect(readFileSync(sourcePath, "utf8")).toBe(source);

    const store = new SqliteTelegramJobStore(databasePath);
    try {
      expect(store.get("waiting")).toMatchObject({ phase: "queued", outcome: null });
      expect(store.get("running")).toMatchObject({ phase: "running", turnId: "turn-running" });
      expect(store.get("ambiguous")).toMatchObject({
        phase: "dispatching", attention: { kind: "required", code: "LEGACY_ACTIVE_WITHOUT_TURN" },
      });
      expect(store.get("delivering")).toMatchObject({ phase: "delivering", turnId: "turn-delivering" });
      expect(store.get("completed")).toMatchObject({
        phase: "terminal", outcome: "completed",
        responsePlan: [{ partId: "final:0", kind: "final" }, { partId: "attachment:1", kind: "attachment" }],
        deliveries: [
          { partId: "final:0", state: "delivered", deliveredAt: START + 10 },
          { partId: "attachment:1", state: "delivered", deliveredAt: START + 10 },
        ],
      });
      expect(store.listDeliveries("completed").map((part) => ({ partKey: part.partKey, state: part.state }))).toEqual([
        { partKey: "final:0", state: "delivered" }, { partKey: "attachment:1", state: "delivered" },
      ]);
      expect(store.get("failed")).toMatchObject({ phase: "terminal", outcome: "failed" });
      expect(store.get("aborted")).toMatchObject({ phase: "terminal", outcome: "aborted" });
      expect(store.get("model")).toMatchObject({
        phase: "accepted", attention: { kind: "required", code: "LEGACY_AWAITING_MODEL" },
      });
      expect(store.listDispatchable(20).map((job) => job.id)).toEqual(["waiting"]);

      jobs.forEach((original, ordinal) => {
        const imported = store.get(original.id)!;
        expect(imported.id).toBe(original.id);
        expect(imported.threadId).toBe(original.threadId);
        expect(imported.source).toEqual({ botId: `legacy-json-v1:${report.checksum}`, updateId: ordinal });
        expect(store.readSourcePayload(original.id)).toEqual({
          migration: { version: "1", checksum: report.checksum, sourceIdentity: "synthetic", ordinal },
          legacy: original,
        });
        expect(store.listEvents(original.id).at(-1)?.event.eventAt).toBe(original.updatedAt);
      });
    } finally { store.close(); }
  });

  it("quarantines malformed entries without content and resumes the same checksum without duplicate events", () => {
    writeFileSync(sourcePath, JSON.stringify([
      legacy("valid", "waiting"),
      { ...legacy("bad-state", "unknown"), input: "secret prompt" },
      { id: "safe-id", state: "waiting", input: "another secret" },
      null,
    ]));

    const first = importLegacyTelegramJobs({ sourcePath, databasePath });
    const store = new SqliteTelegramJobStore(databasePath);
    const eventCount = store.listEvents("valid").length;
    store.close();
    const second = importLegacyTelegramJobs({ sourcePath, databasePath });

    expect(first.quarantined).toEqual([
      { index: 1, jobId: "bad-state", reasonCode: "INVALID_STATE" },
      { index: 2, jobId: "safe-id", reasonCode: "INVALID_CONTEXT_KEY" },
      { index: 3, reasonCode: "INVALID_ENTRY" },
    ]);
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(second).toMatchObject({ status: "already_imported", readyForSqlite: true, importedCount: 1 });
    const reopened = new SqliteTelegramJobStore(databasePath);
    try {
      expect(reopened.countJobs()).toBe(1);
      expect(reopened.listEvents("valid")).toHaveLength(eventCount);
      expect(reopened.getMetadata("legacy-json-migration")).toMatchObject({ status: "complete" });
    } finally { reopened.close(); }
  });

  it("fails closed for unreadable or invalid roots and rejects a changed checksum", () => {
    expect(() => importLegacyTelegramJobs({ sourcePath, databasePath })).toThrowError(
      expect.objectContaining({ code: "SOURCE_READ_FAILED" }),
    );
    expect(existsSync(databasePath)).toBe(false);

    writeFileSync(sourcePath, "{not-json");
    const invalid = readFileSync(sourcePath, "utf8");
    expect(() => importLegacyTelegramJobs({ sourcePath, databasePath })).toThrowError(
      expect.objectContaining({ code: "INVALID_SOURCE_ROOT" }),
    );
    expect(readFileSync(sourcePath, "utf8")).toBe(invalid);
    expect(existsSync(databasePath)).toBe(false);

    writeFileSync(sourcePath, JSON.stringify([legacy("one", "waiting")]));
    importLegacyTelegramJobs({ sourcePath, databasePath });
    writeFileSync(sourcePath, JSON.stringify([legacy("one", "completed")]));
    expect(() => importLegacyTelegramJobs({ sourcePath, databasePath })).toThrowError(
      expect.objectContaining({ code: "SOURCE_CHECKSUM_MISMATCH" }),
    );
  });

  it("requires an explicit migration version and merges only unchanged existing entries", () => {
    const original = legacy("one", "waiting");
    writeFileSync(sourcePath, JSON.stringify([original]));
    importLegacyTelegramJobs({ sourcePath, databasePath });
    const before = new SqliteTelegramJobStore(databasePath);
    const originalEvents = before.listEvents("one").length;
    before.close();

    writeFileSync(sourcePath, JSON.stringify([original, legacy("two", "completed")]));
    expect(importLegacyTelegramJobs({ sourcePath, databasePath, migrationVersion: "2" })).toMatchObject({
      status: "imported", migrationVersion: "2", importedCount: 2, readyForSqlite: true,
    });
    const inspect = new SqliteTelegramJobStore(databasePath);
    try {
      expect(inspect.countJobs()).toBe(2);
      expect(inspect.listEvents("one")).toHaveLength(originalEvents);
      expect(inspect.getMetadata("legacy-json-migration")).toMatchObject({ version: "2", status: "complete" });
    } finally { inspect.close(); }

    writeFileSync(sourcePath, JSON.stringify([{ ...original, state: "completed" }, legacy("two", "completed")]));
    expect(() => importLegacyTelegramJobs({ sourcePath, databasePath, migrationVersion: "3" })).toThrowError(
      expect.objectContaining({ code: "IMPORT_JOB_CONFLICT" }),
    );
  });

  it("leaves an in-progress marker and never reports SQLite ready after a mid-import conflict", () => {
    const source = JSON.stringify([legacy("conflict", "waiting", { input: "source-remains-private" })]);
    writeFileSync(sourcePath, source);
    const store = new SqliteTelegramJobStore(databasePath);
    store.acceptUpdate({
      job: acceptedJob("conflict", { botId: "native", updateId: 1 }),
      sourcePayload: { safe: true }, eventId: "native-accept",
    });
    store.close();

    expect(() => importLegacyTelegramJobs({ sourcePath, databasePath })).toThrowError(
      expect.objectContaining({ code: "IMPORT_JOB_CONFLICT" }),
    );
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
    const inspect = new SqliteTelegramJobStore(databasePath);
    try { expect(inspect.getMetadata("legacy-json-migration")).toMatchObject({ status: "in_progress" }); }
    finally { inspect.close(); }
    expect(() => prepareTelegramJobStoreMode({ mode: "sqlite", sourcePath, databasePath })).toThrowError(
      expect.objectContaining({ code: "MIGRATION_FAILED" }),
    );
  });

  it("keeps JSON authoritative in shadow mode and reports clean, count, id, and state parity safely", () => {
    const jobs = [legacy("one", "waiting"), legacy("two", "completed")];
    writeFileSync(sourcePath, JSON.stringify(jobs));
    const shadow = synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath });
    expect(shadow).toMatchObject({ authority: "json", sqliteEligible: true, failure: null });
    expect(shadow.parity).toMatchObject({ matches: true, legacyCount: 2, sqliteCount: 2, mismatches: [] });

    writeFileSync(sourcePath, JSON.stringify([
      legacy("one", "completed", { input: "must-not-appear" }),
      legacy("missing", "waiting", { input: "also-secret" }),
      legacy("extra", "waiting"),
    ]));
    const parity = compareLegacyTelegramJobs({ sourcePath, databasePath });
    expect(parity.matches).toBe(false);
    expect(parity.mismatches.map((item) => item.code)).toEqual(expect.arrayContaining([
      "COUNT_MISMATCH", "PHASE_MISMATCH", "MISSING_JOB",
    ]));
    expect(JSON.stringify(parity)).not.toMatch(/must-not-appear|also-secret|prompt-/);

    writeFileSync(sourcePath, "[]");
    const failedShadow = synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath });
    expect(failedShadow).toMatchObject({ authority: "json", sqliteEligible: false,
      failure: { code: "IMPORT_JOB_CONFLICT" }, parity: { matches: false } });
  });

  it("accepts an empty valid shadow snapshot without creating phantom jobs", () => {
    writeFileSync(sourcePath, "[]");
    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath })).toMatchObject({
      sqliteEligible: true, migration: { importedCount: 0 }, parity: { matches: true, sqliteCount: 0 },
    });
  });

  it("mirrors forward legacy lifecycle changes and appended jobs in shadow mode", () => {
    writeFileSync(sourcePath, JSON.stringify([legacy("one", "waiting")]));
    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath }).sqliteEligible).toBe(true);
    const evolved = legacy("one", "active", {
      threadId: "thread-evolved", turnId: "turn-evolved", updatedAt: START + 20,
    });
    writeFileSync(sourcePath, JSON.stringify([evolved, legacy("two", "waiting", { updatedAt: START + 20 })]));

    const synchronized = synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath });

    expect(synchronized).toMatchObject({ authority: "json", sqliteEligible: true, failure: null,
      parity: { matches: true, legacyCount: 2, sqliteCount: 2 } });
    const store = new SqliteTelegramJobStore(databasePath);
    try {
      expect(store.get("one")).toMatchObject({ phase: "running", threadId: "thread-evolved", turnId: "turn-evolved" });
      expect(store.get("two")).toMatchObject({ phase: "queued" });
      expect(store.readSourcePayload("one")).toMatchObject({ legacy: evolved });
    } finally { store.close(); }

    writeFileSync(sourcePath, JSON.stringify([legacy("one", "waiting", { input: "secret regression" })]));
    const conflicted = synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath });
    expect(conflicted).toMatchObject({ authority: "json", sqliteEligible: false,
      failure: { code: "IMPORT_JOB_CONFLICT" }, parity: { matches: false } });
    expect(JSON.stringify(conflicted)).not.toContain("secret regression");
  });

  it("prepares authority modes without allowing an incomplete SQLite cutover", () => {
    writeFileSync(sourcePath, JSON.stringify([legacy("one", "waiting")]));
    expect(prepareTelegramJobStoreMode({ mode: "json", sourcePath, databasePath })).toEqual({
      authority: "json", sqliteEligible: false, migration: null, parity: null, failure: null,
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(() => prepareTelegramJobStoreMode({ mode: "sqlite", sourcePath, databasePath })).toThrowError(
      expect.objectContaining({ code: "MIGRATION_FAILED" }),
    );
    expect(prepareTelegramJobStoreMode({ mode: "shadow", sourcePath, databasePath })).toMatchObject({
      authority: "json", sqliteEligible: true,
    });
    expect(prepareTelegramJobStoreMode({ mode: "sqlite", sourcePath, databasePath })).toMatchObject({
      authority: "sqlite", sqliteEligible: true, failure: null, parity: null,
    });
    const corrupt = new SqliteTelegramJobStore(databasePath);
    const marker = corrupt.getMetadata("legacy-json-migration") as Record<string, unknown>;
    corrupt.setMetadata("legacy-json-migration", { ...marker, importedCount: -1,
      quarantined: [{ index: 0, reasonCode: "INVALID", prompt: "must-not-leak" }] });
    corrupt.close();
    let error: unknown;
    try { prepareTelegramJobStoreMode({ mode: "sqlite", sourcePath, databasePath }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "MIGRATION_FAILED" });
    expect(String(error)).not.toContain("must-not-leak");
  });

  it("starts from a complete SQLite cutover without reading legacy JSON or requiring parity", () => {
    writeFileSync(sourcePath, JSON.stringify([legacy("legacy", "waiting")]));
    importLegacyTelegramJobs({ sourcePath, databasePath });
    const store = new SqliteTelegramJobStore(databasePath);
    const native = acceptedJob("native", { botId: "real-bot", updateId: 99 });
    store.acceptUpdate({ job: native, eventId: "native-accept", sourcePayload: {
      botId: "real-bot", updateId: 99, chatId: -100321, messageThreadId: null, messageId: 100,
      kind: "text", text: "native", attachment: null, retryOfJobId: null,
    } });
    store.close();
    rmSync(sourcePath);

    expect(prepareTelegramJobStoreMode({ mode: "sqlite", sourcePath, databasePath })).toMatchObject({
      authority: "sqlite", sqliteEligible: true, parity: null, failure: null,
    });
  });

  it("never echoes unsafe correlation identifiers in quarantine or parity", () => {
    const unsafe = "secret prompt\nTOKEN";
    writeFileSync(sourcePath, JSON.stringify([legacy(unsafe, "waiting"), legacy("safe", "waiting")]));
    const imported = importLegacyTelegramJobs({ sourcePath, databasePath });
    expect(imported.quarantined).toEqual([{ index: 0, reasonCode: "INVALID_JOB_ID" }]);
    const store = new SqliteTelegramJobStore(databasePath);
    store.acceptUpdate({ job: acceptedJob(unsafe, { botId: "native", updateId: 44 }),
      eventId: "unsafe-native", sourcePayload: { safe: true } });
    store.close();
    const parity = compareLegacyTelegramJobs({ sourcePath, databasePath });
    expect(parity.mismatches).toContainEqual({ code: "EXTRA_JOB", field: "id" });
    expect(JSON.stringify({ imported, parity })).not.toContain(unsafe);
  });

  it("exports deterministic private legacy JSON atomically and the legacy store can read it", () => {
    const jobs = [
      legacy("waiting", "waiting"),
      legacy("running", "active", { turnId: "turn-running" }),
      legacy("done", "completed", { sentPartKeys: ["final:0"], response: "kept" }),
      legacy("model", "awaiting-model", { selectionToken: "selection-token" }),
    ];
    writeFileSync(sourcePath, JSON.stringify(jobs));
    importLegacyTelegramJobs({ sourcePath, databasePath });
    const outputPath = path.join(directory, "compat", "jobs.json");

    expect(exportLegacyTelegramJobs({ databasePath, outputPath, limit: 20 })).toEqual({
      exportedCount: 4, outputPath,
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    const first = readFileSync(outputPath, "utf8");
    exportLegacyTelegramJobs({ databasePath, outputPath, limit: 20 });
    expect(readFileSync(outputPath, "utf8")).toBe(first);
    const legacyStore = new TelegramJobStore(outputPath);
    expect(legacyStore.list().map((job) => job.id)).toEqual(["waiting", "running", "done", "model"]);
    expect(legacyStore.get("done")).toMatchObject({ state: "completed", response: "kept", sentPartKeys: ["final:0"] });
    expect(legacyStore.get("model")).toMatchObject({ state: "awaiting-model", selectionToken: "selection-token" });
  });

  it("exports safely representable native text jobs and refuses missing or colliding ledger paths", () => {
    expect(() => exportLegacyTelegramJobs({ databasePath, outputPath: sourcePath, limit: 20 })).toThrowError(
      expect.objectContaining({ code: "MIGRATION_FAILED" }),
    );
    expect(existsSync(databasePath)).toBe(false);
    const store = new SqliteTelegramJobStore(databasePath);
    const native = acceptedJob("native", { botId: "real-bot", updateId: 12 });
    store.acceptUpdate({ job: native, eventId: "native-accept", sourcePayload: {
      botId: "real-bot", updateId: 12, chatId: -100321, messageThreadId: 7, messageId: 99,
      kind: "text", text: "native prompt", attachment: null, retryOfJobId: null,
    } });
    store.transition({ jobId: "native", eventId: "native-queue", expectedVersion: 1,
      event: { schemaVersion: 1, type: "job.queued", eventAt: START } });
    store.close();
    expect(() => exportLegacyTelegramJobs({ databasePath, outputPath: databasePath, limit: 20 })).toThrowError(
      expect.objectContaining({ code: "EXPORT_UNSAFE" }),
    );
    const intact = new SqliteTelegramJobStore(databasePath);
    try { expect(intact.countJobs()).toBe(1); } finally { intact.close(); }
    const outputPath = path.join(directory, "native.json");
    exportLegacyTelegramJobs({ databasePath, outputPath, limit: 20 });
    expect(new TelegramJobStore(outputPath).get("native")).toMatchObject({
      contextKey: "-100321:7", chatId: -100321, messageThreadId: 7,
      input: "native prompt", state: "waiting",
    });
  });

  it("refuses ambiguous dispatch, delivery, or recovery without touching the compatibility target", () => {
    const target = path.join(directory, "compat.json");
    writeFileSync(target, "original-backup");
    writeFileSync(sourcePath, JSON.stringify([
      legacy("ambiguous", "active"), legacy("outbox-only", "waiting"), legacy("pending", "waiting"),
    ]));
    importLegacyTelegramJobs({ sourcePath, databasePath });
    expect(() => exportLegacyTelegramJobs({ databasePath, outputPath: target, limit: 20 })).toThrowError(
      expect.objectContaining({ code: "EXPORT_UNSAFE", reasons: [{ jobId: "ambiguous", reasonCode: "ATTENTION_REQUIRED" }] }),
    );
    expect(readFileSync(target, "utf8")).toBe("original-backup");

    const store = new SqliteTelegramJobStore(databasePath);
    try {
      store.insertDelivery({ jobId: "outbox-only", partKey: "final:ghost", ordinal: 0, kind: "final",
        state: "uncertain", payload: {}, contentHash: "0".repeat(64), updatedAt: START });
      seedDeliveryState(store, "sending", 9, "sending");
      seedDeliveryState(store, "uncertain", 10, "uncertain");
      const recovery = acceptedJob("recovery", { botId: "legacy-manual", updateId: 11 });
      store.acceptUpdate({ job: recovery, sourcePayload: { legacy: legacy("recovery", "aborted") }, eventId: "recovery-accept" });
      store.transition({ jobId: "recovery", eventId: "recovery-terminal", expectedVersion: 1,
        event: { schemaVersion: 1, type: "job.terminal", eventAt: START, outcome: "recovery_interrupted" } });
      const pending = store.get("pending")!;
      store.transitionLegacyMigration({ jobId: "pending", eventId: "pending-terminal", expectedVersion: pending.version,
        event: { schemaVersion: 1, type: "job.terminal", eventAt: pending.updatedAt, outcome: "completed",
          responsePlan: [{ partId: "final:0", kind: "final" }],
          deliveries: [{ partId: "final:0", state: "pending", attempts: 0, messageId: null, deliveredAt: null }] } });
    } finally { store.close(); }
    let error: unknown;
    try { exportLegacyTelegramJobs({ databasePath, outputPath: target, limit: 20 }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TelegramJobMigrationError);
    expect((error as TelegramJobMigrationError).reasons).toEqual(expect.arrayContaining([
      { jobId: "ambiguous", reasonCode: "ATTENTION_REQUIRED" },
      { jobId: "outbox-only", reasonCode: "NORMALIZED_DELIVERY_MISMATCH" },
      { jobId: "sending", reasonCode: "DELIVERY_AMBIGUOUS" },
      { jobId: "uncertain", reasonCode: "DELIVERY_AMBIGUOUS" },
      { jobId: "recovery", reasonCode: "RECOVERY_UNREPRESENTABLE" },
      { jobId: "pending", reasonCode: "INCOMPLETE_DELIVERY" },
    ]));
    expect(readFileSync(target, "utf8")).toBe("original-backup");
  });

  it("refuses compatibility export when normalized delivery ordinal or kind diverges", () => {
    writeFileSync(sourcePath, JSON.stringify([legacy("done", "completed", { sentPartKeys: ["final:0"] })]));
    importLegacyTelegramJobs({ sourcePath, databasePath });
    const database = new Database(databasePath);
    database.prepare("UPDATE deliveries SET ordinal = 2, kind = 'summary' WHERE job_id = ?").run("done");
    database.close();

    let error: unknown;
    try { exportLegacyTelegramJobs({ databasePath, outputPath: path.join(directory, "compat.json"), limit: 20 }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "EXPORT_UNSAFE",
      reasons: [{ jobId: "done", reasonCode: "NORMALIZED_DELIVERY_MISMATCH" }] });
  });

  it("removes its exact temporary file when atomic replacement fails", () => {
    writeFileSync(sourcePath, JSON.stringify([legacy("safe", "waiting")]));
    importLegacyTelegramJobs({ sourcePath, databasePath });
    const outputPath = path.join(directory, "existing-directory");
    mkdirSync(outputPath);
    expect(() => exportLegacyTelegramJobs({ databasePath, outputPath, limit: 20 })).toThrow();
    expect(readdirSync(directory).filter((name) => name.startsWith("existing-directory.tmp-"))).toEqual([]);
    expect(existsSync(outputPath)).toBe(true);
  });

  it("validates authority, paths, retry, and retention defaults before startup", () => {
    expect(parseTelegramJobConfig("/workspace", {})).toEqual({
      storeMode: "json",
      databasePath: "/workspace/.telecodex/jobs.sqlite",
      legacyJsonPath: "/workspace/.telecodex/jobs.json",
      maxAttempts: 5,
      payloadRetentionDays: 7,
      metadataRetentionDays: 90,
      retentionInitialDelaySeconds: 0,
    });
    expect(parseTelegramJobConfig("/workspace", { TELEGRAM_JOB_STORE_MODE: "shadow" }).storeMode).toBe("shadow");
    for (const environment of [
      { TELEGRAM_JOB_STORE_MODE: "other" },
      { TELEGRAM_JOB_MAX_ATTEMPTS: "0" },
      { TELEGRAM_JOB_PAYLOAD_RETENTION_DAYS: "0" },
      { TELEGRAM_JOB_METADATA_RETENTION_DAYS: "6" },
      { TELEGRAM_JOB_DB_PATH: "relative.sqlite" },
      { TELEGRAM_JOB_DB_PATH: "/same", TELEGRAM_JOB_LEGACY_JSON_PATH: "/same" },
      { TELEGRAM_JOB_DB_PATH: "/same", TELEGRAM_JOB_LEGACY_JSON_PATH: "/same-wal" },
      { TELEGRAM_JOB_DB_PATH: "/same", TELEGRAM_JOB_LEGACY_JSON_PATH: "/same-shm" },
    ]) expect(() => parseTelegramJobConfig("/workspace", environment)).toThrow();
  });
});

function acceptedJob(id: string, source: { botId: string; updateId: number }): TelegramJob {
  return {
    schemaVersion: 1, id, version: 1, source, attachments: [], phase: "accepted", health: "healthy",
    activity: "unknown", attention: { kind: "none" }, outcome: null, dispatchId: null, threadId: null,
    turnId: null, responsePlan: undefined, deliveries: [], acceptedAt: START, updatedAt: START,
    terminalAt: null, dismissedAt: null, retainUntil: null,
  };
}

function seedDeliveryState(
  store: SqliteTelegramJobStore,
  id: string,
  updateId: number,
  state: "sending" | "uncertain",
): void {
  const accepted = acceptedJob(id, { botId: "legacy-manual", updateId });
  store.acceptUpdate({ job: accepted, sourcePayload: { legacy: legacy(id, "delivering") }, eventId: `${id}-accept` });
  let current = store.transition({ jobId: id, eventId: `${id}-queue`, expectedVersion: 1,
    event: { schemaVersion: 1, type: "job.queued", eventAt: START } });
  current = store.transition({ jobId: id, eventId: `${id}-dispatch`, expectedVersion: current.version,
    event: { schemaVersion: 1, type: "dispatch.written", eventAt: START } });
  current = store.transition({ jobId: id, eventId: `${id}-turn`, expectedVersion: current.version,
    event: { schemaVersion: 1, type: "turn.started", eventAt: START, identifiers: { turnId: "turn" } } });
  store.transition({ jobId: id, eventId: `${id}-delivery`, expectedVersion: current.version,
    event: { schemaVersion: 1, type: "delivery.changed", eventAt: START,
      responsePlan: [{ partId: "final:0", kind: "final" }],
      deliveries: [{ partId: "final:0", state, attempts: 1, messageId: null, deliveredAt: null }] } });
}
