import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hashTelegramQuarantineAuditCandidates,
  type TelegramQuarantineAuditHashCandidate as CanonicalCandidate,
} from "../src/telegram-job-quarantine-audit-hash.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import {
  createLegacyQuarantineDefectFixtureContext,
  seedLegacyQuarantineDefect,
  type LegacyQuarantineDefectFixture,
  type SafeSqliteRow,
} from "./telegram-job-quarantine-repair-fixtures.js";

interface AuditModule {
  auditTelegramLegacyQuarantine(input: {
    readonly databasePath: string; readonly checkedAt: number; readonly limit?: number;
  }): AuditReport;
}
interface AuditReport {
  readonly schemaVersion: 1; readonly checkedAt: number; readonly repairable: number;
  readonly unknown: number; readonly criticalDeliveries: number; readonly auditHash: string;
}
type HashedField = keyof CanonicalCandidate;

const CHECKED_AT = 1_700_604_801_002;
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ONE_CANDIDATE_HASH = "429fdf4e5c57d46b56a6edb84f41e5b7c9e0d4cafacac546cf36bb731a90afa7";
const TWO_CANDIDATE_HASH = "4fab89e4082c3606b53bb3f2ee16d120d0816597f17b4010b80ff0e62cd3bb90";
const OVERSIZED_JSON = JSON.stringify({ text: "x".repeat(4 * 1024 * 1024 + 1) });
const OVERSIZED_MARKER = `{${"x".repeat(256 * 1024)}`;
const HASHED_FIELDS: readonly HashedField[] = [
  "jobId", "projectionVersion", "projectionUpdatedAt", "quarantineFingerprint",
  "quarantinedAt", "liveEventId", "liveEventAt", "checksum", "ordinal",
];

describe("Telegram legacy quarantine audit", () => {
  let directory = "";
  let databasePath = "";

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-quarantine-audit-"));
    databasePath = path.join(directory, "jobs.sqlite");
  });
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("uses the exact canonical SHA-256 for one known candidate", async () => {
    const fixture = seedLegacyQuarantineDefect(databasePath);
    const audit = await loadAudit();
    const expected = canonicalHash([fixtureCandidate(fixture)]);
    expect(expected).toBe(ONE_CANDIDATE_HASH);
    expect(audit.auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT })).toEqual({
      schemaVersion: 1, checkedAt: CHECKED_AT, repairable: 1, unknown: 0,
      criticalDeliveries: 0, auditHash: ONE_CANDIDATE_HASH,
    });
  });

  it("sorts multiple candidate IDs by UTF-8 bytes rather than JavaScript UTF-16 order", async () => {
    const context = createLegacyQuarantineDefectFixtureContext();
    try {
      const astralId = "job-\u{10000}", bmpId = "job-\uE000";
      const astral = context.seed({ jobId: astralId, ordinal: 0, quarantineTime: CHECKED_AT });
      const bmp = context.seed({ jobId: bmpId, ordinal: 1, quarantineTime: CHECKED_AT + 1 });
      expect([astralId, bmpId].sort()).toEqual([astralId, bmpId]);
      expect([astralId, bmpId].sort(compareUtf8)).toEqual([bmpId, astralId]);
      expect(sqlQuarantineOrder(context.databasePath)).toEqual([astralId, bmpId]);
      expect(canonicalHash([astral, bmp].map(fixtureCandidate))).toBe(TWO_CANDIDATE_HASH);
      const report = (await loadAudit()).auditTelegramLegacyQuarantine({
        databasePath: context.databasePath, checkedAt: CHECKED_AT,
      });
      expect(report).toEqual(expect.objectContaining({
        repairable: 2, unknown: 0, auditHash: TWO_CANDIDATE_HASH,
      }));
    } finally { context.cleanup(); }
  });

  it.each(HASHED_FIELDS)("pure hash changes when independent field %s changes", (field) => {
    const baseline = arbitraryCandidate();
    const changed = { ...baseline, [field]: typeof baseline[field] === "number"
      ? (baseline[field] as number) + 1 : `${baseline[field]}:changed` };
    expect(hashTelegramQuarantineAuditCandidates([baseline])).toBe(canonicalHash([baseline]));
    expect(hashTelegramQuarantineAuditCandidates([changed])).toBe(canonicalHash([changed]));
    expect(hashTelegramQuarantineAuditCandidates([changed]))
      .not.toBe(hashTelegramQuarantineAuditCandidates([baseline]));
  });

  it("keeps canonical field slots ordered and rejects invalid numeric inputs", () => {
    const baseline = arbitraryCandidate();
    const swapped = { ...baseline, jobId: baseline.liveEventId, liveEventId: baseline.jobId };
    expect(hashTelegramQuarantineAuditCandidates([swapped]))
      .not.toBe(hashTelegramQuarantineAuditCandidates([baseline]));
    expect(() => hashTelegramQuarantineAuditCandidates([{ ...baseline, ordinal: -1 }])).toThrow();
    expect(() => hashTelegramQuarantineAuditCandidates([{ ...baseline, ordinal: 0.5 }])).toThrow();
    expect(() => hashTelegramQuarantineAuditCandidates([
      { ...baseline, projectionVersion: Number.MAX_SAFE_INTEGER + 1 },
    ])).toThrow();
  });

  it("excludes payload and path text from the hash, report, and bounded errors", async () => {
    seedLegacyQuarantineDefect(databasePath);
    const audit = await loadAudit();
    const before = audit.auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT });
    const secret = "PRIVATE-PAYLOAD-/tmp/private-path";
    updateTemporaryDatabase(databasePath, "UPDATE deliveries SET payload_json = ?",
      JSON.stringify({ path: `/tmp/${secret}`, text: secret }));
    const after = audit.auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT + 1 });
    expect(before).toEqual(expect.objectContaining({ repairable: 1, unknown: 0 }));
    expect(after).toEqual(expect.objectContaining({ repairable: 0, unknown: 1, auditHash: EMPTY_HASH }));
    expect(JSON.stringify(after)).not.toContain(secret);
    let failure: unknown;
    try {
      audit.auditTelegramLegacyQuarantine({
        databasePath: `${databasePath}-${secret}`, checkedAt: CHECKED_AT,
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "Unable to audit Telegram legacy quarantine" });
    expect(String(failure)).not.toContain(secret);
  });

  it("returns the standard empty SHA-256 for an empty current-schema ledger", async () => {
    new SqliteTelegramJobStore(databasePath).close();
    expect((await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT }))
      .toEqual({ schemaVersion: 1, checkedAt: CHECKED_AT, repairable: 0, unknown: 0,
        criticalDeliveries: 0, auditHash: EMPTY_HASH });
  });

  it("audits all 446 exact rows in one database with a stable hash", async () => {
    const context = createLegacyQuarantineDefectFixtureContext();
    try {
      Array.from({ length: 446 }, (_, ordinal) => context.seed({
        jobId: `legacy-quarantine-${String(ordinal).padStart(4, "0")}`, ordinal,
      }));
      const audit = await loadAudit();
      const first = audit.auditTelegramLegacyQuarantine({ databasePath: context.databasePath, checkedAt: CHECKED_AT });
      const second = audit.auditTelegramLegacyQuarantine({ databasePath: context.databasePath, checkedAt: CHECKED_AT + 1 });
      expect(first).toEqual(expect.objectContaining({ repairable: 446, unknown: 0, criticalDeliveries: 0 }));
      expect(second).toEqual({ ...first, checkedAt: CHECKED_AT + 1 });
    } finally { context.cleanup(); }
  }, 60_000);

  it("counts a mixed exact and unknown set without hashing the unknown row", async () => {
    const context = createLegacyQuarantineDefectFixtureContext();
    try {
      const exact = context.seed({ jobId: "mixed-exact", ordinal: 0 });
      context.seed({ jobId: "mixed-unknown", ordinal: 1 });
      updateTemporaryDatabase(context.databasePath,
        "UPDATE job_quarantine SET reason_code = 'unexpected' WHERE job_id = 'mixed-unknown'");
      expect((await loadAudit()).auditTelegramLegacyQuarantine({
        databasePath: context.databasePath, checkedAt: CHECKED_AT,
      })).toEqual({ schemaVersion: 1, checkedAt: CHECKED_AT, repairable: 1, unknown: 1,
        criticalDeliveries: 0, auditHash: canonicalHash([fixtureCandidate(exact)]) });
    } finally { context.cleanup(); }
  });

  it("prepares bounded metadata-first candidate queries", async () => {
    seedLegacyQuarantineDefect(databasePath);
    const statements: string[] = [];
    const prototype = Database.prototype as unknown as {
      prepare(sql: string): Database.Statement;
    };
    const original = prototype.prepare;
    prototype.prepare = function prepare(sql: string): Database.Statement {
      statements.push(sql); return original.call(this, sql);
    };
    try {
      (await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT });
    } finally { prototype.prepare = original; }
    const quarantine = statements.find((sql) => sql.includes("FROM job_quarantine AS quarantine")) ?? "";
    expect(quarantine).not.toMatch(/jobs\.projection_json(?:\s|,)/);
    expect(quarantine).not.toMatch(/inbox_updates\.source_json(?:\s|,)/);
    expect(statements).toContainEqual(expect.stringMatching(/length\(CAST\(projection_json AS BLOB\)\)/));
    expect(statements).toContainEqual(expect.stringMatching(/length\(CAST\(source_json AS BLOB\)\)/));
    expect(statements).toContainEqual(expect.stringMatching(/job_event_archive[\s\S]*LIMIT 3/));
    expect(statements).toContainEqual(expect.stringMatching(/job_events[\s\S]*LIMIT 2/));
    expect(statements).toContainEqual(expect.stringMatching(/deliveries[\s\S]*LIMIT 514/));
    expect(quarantine).toMatch(/CASE[\s\S]*AS job_id/);
    expect(quarantine).toMatch(/AS reason_is_malformed/);
    expect(quarantine).toMatch(/CASE[\s\S]*AS fingerprint/);
    const archive = statements.find((sql) => sql.includes("FROM job_event_archive")) ?? "";
    const live = statements.find((sql) => sql.includes("FROM job_events")) ?? "";
    const deliveries = statements.find((sql) => sql.includes("FROM deliveries")) ?? "";
    expect(archive).toMatch(/CASE[\s\S]*AS event_id[\s\S]*event_type_is_accepted/);
    expect(live).toMatch(/CASE[\s\S]*AS event_id[\s\S]*event_type_is_reconciliation/);
    expect(deliveries).toMatch(/CASE[\s\S]*AS part_key[\s\S]*AS content_hash/);
    for (const sql of [quarantine, archive, live, deliveries]) expect(sql).toMatch(/length\(CAST\(/);
    expect(statements).toContainEqual(expect.stringMatching(
      /length\(CAST\(value AS BLOB\)\)[\s\S]*metadata/,
    ));
    expect(statements).toContainEqual(expect.stringMatching(/pragma_foreign_key_check[\s\S]*LIMIT 1/i));
  });

  it.each([
    ["initial job id", "job_id"], ["initial reason", "reason"],
    ["initial fingerprint", "fingerprint"], ["inbox bot id", "bot_id"],
    ["archive event id", "archive_id"], ["archive event type", "archive_type"],
    ["live event id", "live_id"], ["live event type", "live_type"],
    ["delivery part key", "part_key"], ["delivery kind", "kind"],
    ["delivery state", "state"], ["delivery hash", "hash"],
    ["delivery error", "error"],
  ] as const)("classifies an oversized %s scalar without exposing it", async (_name, field) => {
    seedLegacyQuarantineDefect(databasePath);
    oversizeCandidateScalar(databasePath, field);
    const report = (await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT });
    expect(report).toEqual(expect.objectContaining({ repairable: 0, unknown: 1, auditHash: EMPTY_HASH }));
    expect(JSON.stringify(report)).not.toContain("oversized-private");
  });

  it("treats an oversized migration marker as unavailable before parsing", async () => {
    seedLegacyQuarantineDefect(databasePath);
    updateTemporaryDatabase(databasePath,
      "UPDATE metadata SET value = ? WHERE key = 'legacy-json-migration'", OVERSIZED_MARKER);
    expect((await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT }))
      .toEqual(expect.objectContaining({ repairable: 0, unknown: 1, auditHash: EMPTY_HASH }));
  });

  it.each(["projection", "source", "live", "delivery"] as const)(
    "classifies an oversized %s JSON body without exposing it", async (kind) => {
      seedLegacyQuarantineDefect(databasePath);
      oversizeCandidatePayload(databasePath, kind);
      const report = (await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT });
      expect(report).toEqual(expect.objectContaining({ repairable: 0, unknown: 1, auditHash: EMPTY_HASH }));
      expect(JSON.stringify(report)).not.toContain("xxxx");
    },
  );

  it.each(["archive", "live", "delivery"] as const)(
    "bounds an overflowing %s child row set", async (kind) => {
      seedLegacyQuarantineDefect(databasePath);
      overflowChildRows(databasePath, kind);
      expect((await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT }))
        .toEqual(expect.objectContaining({ repairable: 0, unknown: 1, auditHash: EMPTY_HASH }));
    },
  );

  it.each(classifierMismatches)("classifies a %s mismatch as unknown", async (_name, sql) => {
    seedLegacyQuarantineDefect(databasePath);
    updateTemporaryDatabase(databasePath, sql);
    expect((await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT }))
      .toEqual(expect.objectContaining({ repairable: 0, unknown: 1, auditHash: EMPTY_HASH }));
  });

  it.each(["pending", "sending", "uncertain", "failed"] as const)(
    "blocks a repairable job with one %s critical delivery", async (state) => {
      seedLegacyQuarantineDefect(databasePath);
      updateTemporaryDatabase(databasePath,
        "UPDATE deliveries SET state = ? WHERE part_key = 'final:0000'", state);
      expect((await loadAudit()).auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT }))
        .toEqual({ schemaVersion: 1, checkedAt: CHECKED_AT, repairable: 0, unknown: 1,
          criticalDeliveries: 1, auditHash: EMPTY_HASH });
    },
  );

  it("rejects limit overflow, malformed metadata JSON, and foreign-key damage globally", async () => {
    const audit = await loadAudit();
    const context = createLegacyQuarantineDefectFixtureContext();
    try {
      context.seed({ jobId: "overflow-0", ordinal: 0 }); context.seed({ jobId: "overflow-1", ordinal: 1 });
      expect(() => audit.auditTelegramLegacyQuarantine({
        databasePath: context.databasePath, checkedAt: 1, limit: 1,
      })).toThrow("Unable to audit Telegram legacy quarantine");
    } finally { context.cleanup(); }
    seedLegacyQuarantineDefect(databasePath);
    updateTemporaryDatabase(databasePath, "UPDATE metadata SET value = '{' WHERE key = 'legacy-json-migration'");
    expect(() => audit.auditTelegramLegacyQuarantine({ databasePath, checkedAt: 1 }))
      .toThrow("Unable to audit Telegram legacy quarantine");
    updateTemporaryDatabase(databasePath, "DELETE FROM metadata WHERE key = 'legacy-json-migration'");
    damageForeignKeyTemporaryDatabase(databasePath, `INSERT INTO deliveries
      (job_id, part_key, ordinal, kind, state, payload_json, content_hash, telegram_message_id,
       attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
      VALUES ('orphan', 'final:0000', 0, 'final', 'delivered', 'null', '${"a".repeat(64)}',
       NULL, 0, NULL, NULL, 1)`);
    expect(() => audit.auditTelegramLegacyQuarantine({ databasePath, checkedAt: 1 }))
      .toThrow("Unable to audit Telegram legacy quarantine");
    damageForeignKeyTemporaryDatabase(databasePath, `WITH RECURSIVE sequence(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM sequence WHERE n < 200
    ) INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json, content_hash,
      telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
      SELECT 'orphan-many-' || n, 'part', 0, 'final', 'delivered', 'null', '${"b".repeat(64)}',
        NULL, 0, NULL, NULL, 1 FROM sequence`);
    expect(() => audit.auditTelegramLegacyQuarantine({ databasePath, checkedAt: 1 }))
      .toThrow("Unable to audit Telegram legacy quarantine");
  });
});

const classifierMismatches = [
  ["quarantine reason", "UPDATE job_quarantine SET reason_code = 'unexpected_fixture_reason'"],
  ["malformed projection JSON", "UPDATE jobs SET projection_json = '{'"],
  ["projection row version", "UPDATE jobs SET version = version + 1"],
  ["inbox accepted metadata", "UPDATE inbox_updates SET accepted_at_ms = accepted_at_ms + 1"],
  ["terminal retention", "UPDATE jobs SET projection_json = json_set(projection_json, '$.retainUntil', NULL)"],
  ["pending reconciliation intent", "UPDATE jobs SET projection_json = json_remove(projection_json, '$.reconciliation')"],
  ["live expected version", `UPDATE job_events SET payload_json = json_set(payload_json,
    '$.event.expectedVersion', json_extract(payload_json, '$.event.expectedVersion') + 1)`],
  ["projection and live timestamps", `UPDATE jobs SET projection_json = json_set(projection_json,
    '$.updatedAt', updated_at_ms + 1), updated_at_ms = updated_at_ms + 1`],
  ["synthetic source identity", `UPDATE jobs SET projection_json = json_set(projection_json,
    '$.source.botId', 'legacy-json-v1:${"C".repeat(64)}')`],
  ["purged source contract", `UPDATE inbox_updates SET source_json =
    json_set(source_json, '$.migration', json('{}'))`],
  ["completed marker checksum", `UPDATE metadata SET value = json_set(value, '$.checksum',
    '${"d".repeat(64)}') WHERE key = 'legacy-json-migration'`],
  ["exact archive", `INSERT INTO job_event_archive (job_id, sequence, event_id, event_type, event_at_ms)
    SELECT job_id, sequence + 100, 'extra-archive', event_type, event_at_ms
    FROM job_event_archive WHERE event_type = 'job.terminal'`],
  ["live payload identity", "UPDATE job_events SET payload_json = json_set(payload_json, '$.jobId', 'wrong-job')"],
  ["exact live count", `INSERT INTO job_events (job_id, event_id, event_type, event_at_ms, payload_json)
    SELECT job_id, 'extra-live', event_type, event_at_ms, payload_json FROM job_events`],
  ["malformed live JSON", "UPDATE job_events SET payload_json = '{'"],
  ["delivery ordinal", "UPDATE deliveries SET ordinal = 2 WHERE part_key = 'final:0001'"],
  ["response plan kind", `UPDATE jobs SET projection_json =
    json_set(projection_json, '$.responsePlan[1].kind', 'notice')`],
  ["unexpected anchor", `INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json,
    content_hash, telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
    SELECT job_id, 'status-anchor', 0, 'status-anchor', state, payload_json, content_hash,
    telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms
    FROM deliveries WHERE part_key = 'final:0000'`],
  ["synthetic delivery", "UPDATE deliveries SET telegram_message_id = 42 WHERE part_key = 'final:0000'"],
  ["missing marker", "DELETE FROM metadata WHERE key = 'legacy-json-migration'"],
  ["malformed marker", "UPDATE metadata SET value = '{}' WHERE key = 'legacy-json-migration'"],
  ["wrong-type marker", `UPDATE metadata SET value = json_set(value, '$.version', 1)
    WHERE key = 'legacy-json-migration'`],
] as const;

async function loadAudit(): Promise<AuditModule> {
  return await import("../src/telegram-job-quarantine-repair.js") as AuditModule;
}

function fixtureCandidate(fixture: LegacyQuarantineDefectFixture): CanonicalCandidate {
  const row = only(fixture.preRepair.jobQuarantine);
  return { jobId: fixture.expected.jobId, projectionVersion: fixture.expected.projectionVersion,
    projectionUpdatedAt: fixture.expected.eventAt, quarantineFingerprint: String(row.fingerprint),
    quarantinedAt: fixture.expected.quarantineTime, liveEventId: fixture.expected.eventId,
    liveEventAt: fixture.expected.eventAt, checksum: fixture.expected.checksum,
    ordinal: fixture.expected.ordinal };
}

function canonicalHash(candidates: readonly CanonicalCandidate[]): string {
  const hash = createHash("sha256");
  for (const candidate of [...candidates].sort((a, b) => compareUtf8(a.jobId, b.jobId))) {
    for (const key of HASHED_FIELDS) {
      const bytes = Buffer.from(String(candidate[key]), "utf8"), length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes);
    }
  }
  return hash.digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function arbitraryCandidate(): CanonicalCandidate {
  return { jobId: "job-a", projectionVersion: 2, projectionUpdatedAt: 3,
    quarantineFingerprint: "f".repeat(64), quarantinedAt: 5, liveEventId: "event-b",
    liveEventAt: 7, checksum: "c".repeat(64), ordinal: 11 };
}

function sqlQuarantineOrder(databasePath: string): string[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`SELECT job_id FROM job_quarantine
      ORDER BY quarantined_at_ms ASC, job_id ASC`).pluck().all().map(String);
  } finally { database.close(); }
}

function oversizeCandidatePayload(
  databasePath: string,
  kind: "projection" | "source" | "live" | "delivery",
): void {
  const targets = {
    projection: ["jobs", "projection_json", "1 = 1"],
    source: ["inbox_updates", "source_json", "1 = 1"],
    live: ["job_events", "payload_json", "1 = 1"],
    delivery: ["deliveries", "payload_json", "part_key = 'final:0000'"],
  } as const;
  const [table, column, where] = targets[kind];
  updateTemporaryDatabase(databasePath, `UPDATE ${table} SET ${column} = ? WHERE ${where}`, OVERSIZED_JSON);
}

type OversizedScalar = "job_id" | "reason" | "fingerprint" | "bot_id" | "archive_id"
  | "archive_type" | "live_id" | "live_type" | "part_key" | "kind" | "state" | "hash" | "error";
function oversizeCandidateScalar(databasePath: string, field: OversizedScalar): void {
  const value = `oversized-private-${"x".repeat(field === "part_key" ? 256 : 128)}`;
  if (field === "job_id") { replaceJobId(databasePath, value); return; }
  const mutations: Record<Exclude<OversizedScalar, "job_id">, string> = {
    reason: "UPDATE job_quarantine SET reason_code = ?", fingerprint: "UPDATE job_quarantine SET fingerprint = ?",
    bot_id: "UPDATE inbox_updates SET bot_id = ?", archive_id: `UPDATE job_event_archive SET event_id = ?
      WHERE event_type = 'update.accepted'`,
    archive_type: "UPDATE job_event_archive SET event_type = ?", live_id: "UPDATE job_events SET event_id = ?",
    live_type: "UPDATE job_events SET event_type = ?", part_key: "UPDATE deliveries SET part_key = ? WHERE part_key = 'final:0000'",
    kind: "UPDATE deliveries SET kind = ? WHERE part_key = 'final:0000'",
    state: "UPDATE deliveries SET state = ? WHERE part_key = 'final:0000'",
    hash: "UPDATE deliveries SET content_hash = ? WHERE part_key = 'final:0000'",
    error: "UPDATE deliveries SET last_error_code = ? WHERE part_key = 'final:0000'",
  };
  updateTemporaryDatabase(databasePath, mutations[field], value);
}

function replaceJobId(databasePath: string, jobId: string): void {
  mutateDatabase(databasePath, (database) => {
    database.pragma("foreign_keys = OFF");
    database.transaction(() => {
      database.prepare("UPDATE jobs SET id = ?, projection_json = json_set(projection_json, '$.id', ?)").run(jobId, jobId);
      for (const table of ["inbox_updates", "job_events", "job_event_archive", "deliveries", "job_quarantine"]) {
        database.prepare(`UPDATE ${table} SET job_id = ?`).run(jobId);
      }
    })();
  });
}

function overflowChildRows(databasePath: string, kind: "archive" | "live" | "delivery"): void {
  if (kind === "archive") {
    updateTemporaryDatabase(databasePath, `INSERT INTO job_event_archive
      (job_id, sequence, event_id, event_type, event_at_ms)
      SELECT job_id, sequence + 100, 'overflow-archive-' || sequence, event_type, event_at_ms
      FROM job_event_archive`);
  } else if (kind === "live") {
    updateTemporaryDatabase(databasePath, `INSERT INTO job_events
      (job_id, event_id, event_type, event_at_ms, payload_json)
      SELECT job_id, 'overflow-live-' || n, event_type, event_at_ms, payload_json
      FROM job_events JOIN (SELECT 1 AS n UNION ALL SELECT 2) ON 1 = 1`);
  } else {
    updateTemporaryDatabase(databasePath, `WITH RECURSIVE sequence(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM sequence WHERE n < 511
    ) INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json, content_hash,
      telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
      SELECT jobs.id, 'overflow:' || n, n + 2, 'final', 'delivered', 'null', '${"a".repeat(64)}',
        NULL, 0, NULL, NULL, jobs.updated_at_ms FROM jobs CROSS JOIN sequence`);
  }
}

function updateTemporaryDatabase(databasePath: string, sql: string, ...values: unknown[]): void {
  mutateDatabase(databasePath, (database) => { run(database, sql, ...values); });
}
function damageForeignKeyTemporaryDatabase(databasePath: string, sql: string): void {
  mutateDatabase(databasePath, (database) => { database.pragma("foreign_keys = OFF"); run(database, sql); });
}
function mutateDatabase(databasePath: string, mutation: (database: Database.Database) => void): void {
  const database = new Database(databasePath);
  try { mutation(database); } finally { database.close(); }
}
function run(database: Database.Database, sql: string, ...values: unknown[]): void {
  database.prepare(sql).run(...values);
}
function only(rows: readonly SafeSqliteRow[]): SafeSqliteRow {
  const row = rows[0]; if (!row || rows.length !== 1) throw new Error("Expected one row"); return row;
}
