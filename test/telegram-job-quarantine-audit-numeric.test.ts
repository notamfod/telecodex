import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditTelegramLegacyQuarantine } from "../src/telegram-job-quarantine-repair.js";
import { seedLegacyQuarantineDefect } from "./telegram-job-quarantine-repair-fixtures.js";

const CHECKED_AT = 1_700_604_801_002;
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PRIVATE_TEXT = `numeric-private-${"x".repeat(256)}`;
const PRIVATE_BLOB = Buffer.from(PRIVATE_TEXT, "utf8");

describe("Telegram quarantine audit numeric affinity bounds", () => {
  let directory = "";
  let databasePath = "";

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-quarantine-numeric-"));
    databasePath = path.join(directory, "jobs.sqlite");
  });
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("type-gates every numeric-affinity result in SQL", () => {
    seedLegacyQuarantineDefect(databasePath);
    const statements: string[] = [];
    const prototype = Database.prototype as unknown as { prepare(sql: string): Database.Statement };
    const original = prototype.prepare;
    prototype.prepare = function prepare(sql: string): Database.Statement {
      statements.push(sql); return original.call(this, sql);
    };
    try { auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT }); }
    finally { prototype.prepare = original; }
    const initial = findSql(statements, "FROM job_quarantine AS quarantine");
    const archive = findSql(statements, "FROM job_event_archive");
    const live = findSql(statements, "FROM job_events", "length(payload_json)");
    const deliveries = findSql(statements, "FROM deliveries", "content_hash");
    expectIntegerGates(initial, ["quarantine.quarantined_at_ms", "jobs.version", "jobs.updated_at_ms",
      "inbox_updates.update_id", "inbox_updates.accepted_at_ms"]);
    expectIntegerGates(archive, ["sequence", "event_at_ms"]);
    expectIntegerGates(live, ["sequence", "event_at_ms"]);
    expectIntegerGates(deliveries, ["ordinal", "telegram_message_id", "attempt_count",
      "next_attempt_at_ms", "updated_at_ms"]);
    expect(deliveries).toContain("telegram_message_id_type_valid");
    expect(deliveries).toContain("next_attempt_at_ms_type_valid");
  });

  it.each([
    ["initial quarantine time TEXT", "UPDATE job_quarantine SET quarantined_at_ms = ?", PRIVATE_TEXT],
    ["projection version BLOB", "UPDATE jobs SET version = ?", PRIVATE_BLOB],
    ["projection updated time TEXT", "UPDATE jobs SET updated_at_ms = ?", PRIVATE_TEXT],
    ["inbox update id BLOB", "UPDATE inbox_updates SET update_id = ?", PRIVATE_BLOB],
    ["inbox accepted time TEXT", "UPDATE inbox_updates SET accepted_at_ms = ?", PRIVATE_TEXT],
    ["archive sequence BLOB", "UPDATE job_event_archive SET sequence = ? WHERE event_type = 'update.accepted'", PRIVATE_BLOB],
    ["archive event time TEXT", "UPDATE job_event_archive SET event_at_ms = ?", PRIVATE_TEXT],
    ["live event time BLOB", "UPDATE job_events SET event_at_ms = ?", PRIVATE_BLOB],
    ["delivery ordinal TEXT", "UPDATE deliveries SET ordinal = ? WHERE part_key = 'final:0000'", PRIVATE_TEXT],
    ["delivery message id BLOB", "UPDATE deliveries SET telegram_message_id = ? WHERE part_key = 'final:0000'", PRIVATE_BLOB],
    ["delivery attempt count TEXT", "UPDATE deliveries SET attempt_count = ? WHERE part_key = 'final:0000'", PRIVATE_TEXT],
    ["delivery next attempt BLOB", "UPDATE deliveries SET next_attempt_at_ms = ? WHERE part_key = 'final:0000'", PRIVATE_BLOB],
    ["delivery updated time TEXT", "UPDATE deliveries SET updated_at_ms = ? WHERE part_key = 'final:0000'", PRIVATE_TEXT],
    ["negative quarantine time", "UPDATE job_quarantine SET quarantined_at_ms = ?", -1],
    ["unsafe projection version", "UPDATE jobs SET version = ?", 9_007_199_254_740_992n],
  ] as const)("classifies a malformed %s as unknown without leaking it", (_name, sql, value) => {
    seedLegacyQuarantineDefect(databasePath);
    const database = new Database(databasePath);
    try { database.prepare(sql).run(value); } finally { database.close(); }
    const report = auditTelegramLegacyQuarantine({ databasePath, checkedAt: CHECKED_AT });
    expect(report).toEqual(expect.objectContaining({ repairable: 0, unknown: 1, auditHash: EMPTY_HASH }));
    expect(JSON.stringify(report)).not.toContain("numeric-private");
  });
});

function findSql(statements: readonly string[], ...needles: readonly string[]): string {
  return statements.find((sql) => needles.every((needle) => sql.includes(needle))) ?? "";
}

function expectIntegerGates(sql: string, columns: readonly string[]): void {
  for (const column of columns) expect(sql).toContain(`typeof(${column}) = 'integer'`);
}
