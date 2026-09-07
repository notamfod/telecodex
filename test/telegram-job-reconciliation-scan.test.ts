import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { SqliteTelegramJobStore, type TelegramJob } from "../src/telegram-job-store.js";

const NOW = 1_700_000_000_000;

describe("SQLite reconciliation scan", () => {
  let directory: string;
  let databasePath: string;
  let stores: SqliteTelegramJobStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-reconciliation-scan-"));
    databasePath = path.join(directory, "jobs.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function open(): SqliteTelegramJobStore {
    const store = new SqliteTelegramJobStore(databasePath);
    stores.push(store);
    return store;
  }

  it("quarantines one malformed job without hiding later unfinished jobs", () => {
    const store = open();
    accept(store, "bad-job", 1, NOW);
    accept(store, "good-job", 2, NOW + 1);
    store.close();

    const corrupt = new Database(databasePath);
    try {
      corrupt.prepare("UPDATE jobs SET projection_json = ? WHERE id = ?")
        .run("not-json-must-not-leak", "bad-job");
    } finally { corrupt.close(); }

    const reopened = open();
    const first = reopened.scanReconciliationCandidates({ limit: 10, quarantinedAt: NOW + 10 });

    expect(first.jobs.map((candidate) => candidate.id)).toEqual(["good-job"]);
    expect(first.quarantined).toEqual([{
      jobId: "bad-job",
      reasonCode: "malformed_persisted_job",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      quarantinedAt: NOW + 10,
    }]);
    expect(JSON.stringify(first.quarantined)).not.toContain("must-not-leak");
    expect(reopened.listUnfinished(10).map((candidate) => candidate.id)).toEqual(["good-job"]);

    const second = reopened.scanReconciliationCandidates({ limit: 10, quarantinedAt: NOW + 20 });
    expect(second.jobs.map((candidate) => candidate.id)).toEqual(["good-job"]);
    expect(second.quarantined).toEqual([]);
    expect(reopened.listQuarantined(10)).toEqual(first.quarantined);
  });

  it("uses a stable cursor and preserves accepted data while migrating a v1 ledger", () => {
    const initial = open();
    accept(initial, "job-a", 1, NOW);
    accept(initial, "job-b", 2, NOW + 1);
    initial.close();

    const legacy = new Database(databasePath);
    try {
      legacy.exec("DROP TABLE status_anchor_plans");
      legacy.exec("DROP TABLE status_anchor_plan_bootstrap_eligibility");
      legacy.exec("DROP TABLE job_quarantine");
      legacy.exec("DROP TABLE job_event_archive");
      legacy.exec("DROP TABLE job_retry_reservations");
      legacy.exec("DROP TABLE retention_file_cleanup");
      legacy.pragma("user_version = 1");
    } finally { legacy.close(); }

    const migrated = open();
    const page1 = migrated.scanReconciliationCandidates({ limit: 1, quarantinedAt: NOW + 10 });
    const page2 = migrated.scanReconciliationCandidates({
      limit: 1, cursor: page1.nextCursor!, quarantinedAt: NOW + 10,
    });
    const done = migrated.scanReconciliationCandidates({
      limit: 1, cursor: page2.nextCursor!, quarantinedAt: NOW + 10,
    });

    expect(page1.jobs.map((candidate) => candidate.id)).toEqual(["job-a"]);
    expect(page2.jobs.map((candidate) => candidate.id)).toEqual(["job-b"]);
    expect(done).toMatchObject({ jobs: [], quarantined: [], nextCursor: null });
    const inspect = new Database(databasePath, { readonly: true });
    try {
      expect(inspect.pragma("user_version", { simple: true })).toBe(6);
      expect(inspect.prepare("SELECT count(*) AS count FROM job_quarantine").get()).toEqual({ count: 0 });
      expect(inspect.prepare("SELECT count(*) AS count FROM job_event_archive").get()).toEqual({ count: 0 });
      expect(inspect.prepare("SELECT count(*) AS count FROM status_anchor_plans").get()).toEqual({ count: 0 });
      expect(inspect.prepare("SELECT count(*) AS count FROM status_anchor_plan_bootstrap_eligibility").get())
        .toEqual({ count: 2 });
    } finally { inspect.close(); }
  });

  it.each([1, 2, 3, 4, 5])("migrates a valid v%s ledger to an empty v6 status anchor plan table", (version) => {
    const migrationPath = path.join(directory, `migration-v${version}.sqlite`);
    const seeded = new SqliteTelegramJobStore(migrationPath);
    accept(seeded, `preserved-v${version}`, version, NOW + version);
    seeded.close();

    const legacy = new Database(migrationPath);
    try {
      legacy.exec("DROP TABLE IF EXISTS status_anchor_plans");
      legacy.exec("DROP TABLE IF EXISTS status_anchor_plan_bootstrap_eligibility");
      if (version < 5) legacy.exec("DROP TABLE retention_file_cleanup");
      if (version < 4) legacy.exec("DROP TABLE job_retry_reservations");
      if (version < 3) legacy.exec("DROP TABLE job_event_archive");
      if (version < 2) legacy.exec("DROP TABLE job_quarantine");
      legacy.pragma(`user_version = ${version}`);
    } finally { legacy.close(); }

    const migrated = new SqliteTelegramJobStore(migrationPath);
    try {
      expect(migrated.get(`preserved-v${version}`)?.id).toBe(`preserved-v${version}`);
      const inspect = new Database(migrationPath, { readonly: true });
      try {
        expect(inspect.pragma("user_version", { simple: true })).toBe(6);
        expect(inspect.prepare("SELECT count(*) AS count FROM status_anchor_plans").get()).toEqual({ count: 0 });
        expect(inspect.prepare("SELECT job_id FROM status_anchor_plan_bootstrap_eligibility").all())
          .toEqual([{ job_id: `preserved-v${version}` }]);
      } finally { inspect.close(); }
    } finally { migrated.close(); }
  });

  it("rejects a malformed database that claims to be schema v6", () => {
    const initial = open();
    initial.close();
    const malformed = new Database(databasePath);
    try {
      malformed.exec("DROP TABLE IF EXISTS status_anchor_plans");
      malformed.exec(`CREATE TABLE status_anchor_plans (
        job_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL
      )`);
      malformed.pragma("user_version = 6");
    } finally { malformed.close(); }

    expect(() => open()).toThrow("Malformed telegram job schema");
  });

  it("includes a terminal job until its durable status anchor is physically complete", () => {
    const store = open();
    accept(store, "terminal-job", 1, NOW);
    const accepted = store.get("terminal-job")!;
    store.transition({
      jobId: accepted.id, eventId: "terminal-failed", expectedVersion: accepted.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: NOW + 1, outcome: "failed" },
    });

    expect(store.scanReconciliationCandidates({ limit: 10, quarantinedAt: NOW + 2 })
      .jobs.map((candidate) => candidate.id)).toEqual(["terminal-job"]);

    store.insertDelivery({
      jobId: "terminal-job", partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "delivered",
      payload: { operation: "edit_text", chatId: 1, messageId: 9, text: "failed" },
      contentHash: "a".repeat(64), telegramMessageId: 9, attemptCount: 1, updatedAt: NOW + 2,
    });
    expect(store.scanReconciliationCandidates({ limit: 10, quarantinedAt: NOW + 3 }).jobs).toEqual([]);
  });

  it("excludes a terminal job imported from legacy JSON even when its status anchor is incomplete", () => {
    const store = open();
    const checksum = "c".repeat(64);
    accept(store, "legacy-terminal-job", 1, NOW, `legacy-json-v1:${checksum}`, syntheticPayload(checksum, 1));
    const accepted = store.get("legacy-terminal-job")!;
    store.transition({
      jobId: accepted.id, eventId: "legacy-terminal-failed", expectedVersion: accepted.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: NOW + 1, outcome: "failed" },
    });

    expect(store.scanReconciliationCandidates({ limit: 10, quarantinedAt: NOW + 2 }).jobs).toEqual([]);
  });

  it("keeps spoofed legacy terminal prefixes without valid synthetic provenance", () => {
    const store = open();
    const checksum = "c".repeat(64);
    const spoofed = [
      { id: "missing-migration", migration: undefined },
      { id: "wrong-identity", migration: { sourceIdentity: "native", checksum, ordinal: 2 } },
      { id: "wrong-checksum", migration: { sourceIdentity: "synthetic", checksum: "d".repeat(64), ordinal: 3 } },
      { id: "wrong-ordinal", migration: { sourceIdentity: "synthetic", checksum, ordinal: 999 } },
      { id: "invalid-checksum", checksum: "not-a-sha256", migration: {
        sourceIdentity: "synthetic", checksum: "not-a-sha256", ordinal: 5,
      } },
    ];
    for (const [index, entry] of spoofed.entries()) {
      const updateId = index + 1;
      accept(store, entry.id, updateId, NOW + index, `legacy-json-v1:${entry.checksum ?? checksum}`, {
        migration: entry.migration,
      });
      const accepted = store.get(entry.id)!;
      store.transition({
        jobId: accepted.id, eventId: `${entry.id}-failed`, expectedVersion: accepted.version,
        event: { schemaVersion: 1, type: "job.terminal", eventAt: NOW + index + 1, outcome: "failed" },
      });
    }

    expect(store.scanReconciliationCandidates({ limit: 10, quarantinedAt: NOW + 10 })
      .jobs.map((candidate) => candidate.id)).toEqual(spoofed.map((entry) => entry.id));
  });

  it("includes an unfinished job imported from legacy JSON", () => {
    const store = open();
    const checksum = "c".repeat(64);
    accept(store, "legacy-unfinished-job", 1, NOW,
      `legacy-json-v1:${checksum}`, syntheticPayload(checksum, 1));

    expect(store.scanReconciliationCandidates({ limit: 10, quarantinedAt: NOW + 1 })
      .jobs.map((candidate) => candidate.id)).toEqual(["legacy-unfinished-job"]);
  });

  it("continues after a page containing only skipped synthetic legacy terminal jobs", () => {
    const store = open();
    const checksum = "c".repeat(64);
    accept(store, "legacy-terminal-job", 1, NOW,
      `legacy-json-v1:${checksum}`, syntheticPayload(checksum, 1));
    const legacy = store.get("legacy-terminal-job")!;
    store.transition({
      jobId: legacy.id, eventId: "legacy-terminal-failed", expectedVersion: legacy.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: NOW + 1, outcome: "failed" },
    });
    accept(store, "canonical-terminal-job", 2, NOW + 2);
    const canonical = store.get("canonical-terminal-job")!;
    store.transition({
      jobId: canonical.id, eventId: "canonical-terminal-failed", expectedVersion: canonical.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: NOW + 3, outcome: "failed" },
    });

    const skipped = store.scanReconciliationCandidates({ limit: 1, quarantinedAt: NOW + 4 });
    expect(skipped.jobs).toEqual([]);
    expect(skipped.nextCursor).toEqual({ acceptedAt: NOW, jobId: "legacy-terminal-job" });
    expect(store.scanReconciliationCandidates({
      limit: 1, cursor: skipped.nextCursor!, quarantinedAt: NOW + 4,
    }).jobs.map((candidate) => candidate.id)).toEqual(["canonical-terminal-job"]);
  });
});

function accept(
  store: SqliteTelegramJobStore,
  id: string,
  updateId: number,
  acceptedAt: number,
  botId = "bot",
  sourcePayload: unknown = { updateId },
): void {
  const job: TelegramJob = {
    schemaVersion: 1, id, version: 1, source: { botId, updateId }, attachments: [],
    phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt, updatedAt: acceptedAt, terminalAt: null, dismissedAt: null, retainUntil: null,
  };
  store.acceptUpdate({ job, sourcePayload, eventId: `accepted-${id}` });
}

function syntheticPayload(checksum: string, ordinal: number): unknown {
  return {
    migration: { version: "1", checksum, sourceIdentity: "synthetic", ordinal },
    legacy: { id: `legacy-${ordinal}` },
  };
}
