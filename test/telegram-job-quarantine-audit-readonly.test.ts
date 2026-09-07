import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditTelegramLegacyQuarantine } from "../src/telegram-job-quarantine-repair.js";
import { seedLegacyQuarantineDefect } from "./telegram-job-quarantine-repair-fixtures.js";

const CHECKED_AT = 1_700_604_801_002;

describe("Telegram legacy quarantine audit readonly evidence", () => {
  let directory: string | undefined;
  let databasePath: string | undefined;
  let observer: Database.Database | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-quarantine-readonly-"));
    databasePath = path.join(directory, "jobs.sqlite");
  });

  afterEach(() => {
    const cleanupErrors: unknown[] = [];
    try { observer?.close(); } catch (error) { cleanupErrors.push(error); }
    observer = undefined;
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    directory = undefined;
    databasePath = undefined;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Unable to clean readonly audit fixture");
  });

  it("detects a separate committed writer through the same observer connection", () => {
    const fixture = openFixtureObserver(requiredPath(databasePath));
    observer = fixture.observer;
    let writer: Database.Database | undefined;
    try {
      const before = databaseSnapshot(fixture.databasePath, fixture.observer);
      writer = new Database(fixture.databasePath);
      writer.prepare("UPDATE jobs SET updated_at_ms = updated_at_ms + 1").run();
      const after = databaseSnapshot(fixture.databasePath, fixture.observer);
      expect(after.dataVersion).not.toBe(before.dataVersion);
    } finally { writer?.close(); }
  });

  it("keeps durable ledger evidence unchanged across two audits", () => {
    const fixture = openFixtureObserver(requiredPath(databasePath));
    observer = fixture.observer;
    const before = databaseSnapshot(fixture.databasePath, fixture.observer);
    expect(before).not.toHaveProperty("files");
    auditTelegramLegacyQuarantine({ databasePath: fixture.databasePath, checkedAt: CHECKED_AT });
    auditTelegramLegacyQuarantine({ databasePath: fixture.databasePath, checkedAt: CHECKED_AT + 1 });
    expect(databaseSnapshot(fixture.databasePath, fixture.observer)).toEqual(before);
  });
});

function openFixtureObserver(databasePath: string): {
  readonly databasePath: string; readonly observer: Database.Database;
} {
  seedLegacyQuarantineDefect(databasePath);
  return {
    databasePath,
    observer: new Database(databasePath, { readonly: true, fileMustExist: true }),
  };
}

function databaseSnapshot(databasePath: string, observer: Database.Database): Record<string, unknown> {
  // SHM holds volatile SQLite reader coordination state; WAL/SHM stay outside this durable snapshot.
  const stat = statSync(databasePath);
  const tables = observer.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all().map(String);
  return {
    mainDatabase: {
      sha256: createHash("sha256").update(readFileSync(databasePath)).digest("hex"),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    },
    dataVersion: observer.pragma("data_version", { simple: true }),
    tables: tables.map((name) => {
      const rows = observer.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
      return { name, count: rows.length, rows };
    }),
  };
}

function requiredPath(databasePath: string | undefined): string {
  if (!databasePath) throw new Error("Missing Telegram quarantine readonly fixture path");
  return databasePath;
}
