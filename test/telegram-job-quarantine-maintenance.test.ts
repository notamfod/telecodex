import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createVerifiedTelegramJobBackup,
  digestTelegramLogicalLedger,
  repairTelegramLegacyQuarantine,
} from "../src/telegram-job-quarantine-maintenance.js";
import { auditTelegramLegacyQuarantine }
  from "../src/telegram-job-quarantine-repair.js";
import { seedLegacyQuarantineDefect }
  from "./telegram-job-quarantine-repair-fixtures.js";
import { createLegacyQuarantineDefectFixtureContext }
  from "./telegram-job-quarantine-repair-fixtures.js";

describe("Telegram quarantine maintenance", () => {
  let directory = "";
  let databasePath = "";

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-quarantine-maintenance-"));
    databasePath = path.join(directory, "jobs.sqlite");
  });
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("repairs exactly the hash-bound set and preserves archive and delivery rows", () => {
    const fixture = seedLegacyQuarantineDefect(databasePath);
    const before = rawEvidence(databasePath);
    const audit = auditTelegramLegacyQuarantine({ databasePath, checkedAt: 10 });

    const result = repairTelegramLegacyQuarantine({
      databasePath, expectedAuditHash: audit.auditHash,
      backupSha256: "b".repeat(64), checkedAt: 11,
    });

    expect(result).toEqual({
      schemaVersion: 1, repaired: 1, auditHash: audit.auditHash,
      backupSha256: "b".repeat(64),
    });
    expect(rawEvidence(databasePath)).toMatchObject({
      archives: before.archives,
      deliveries: before.deliveries,
      quarantine: [],
      liveEvents: [],
    });
    const repaired = rawEvidence(databasePath);
    expect(repaired.source).toMatchObject({
      text: null, attachment: null, payloadPurged: true,
      migration: {
        version: "1", checksum: fixture.expected.checksum,
        sourceIdentity: "synthetic", ordinal: fixture.expected.ordinal,
      },
    });
    expect(repaired.projection).not.toHaveProperty("reconciliation");
    expect(repaired.projection).toMatchObject({
      version: fixture.expected.projectionVersion - 1,
      updatedAt: fixture.expected.archivedTerminalAt,
    });
    expect(auditTelegramLegacyQuarantine({ databasePath, checkedAt: 12 })).toMatchObject({
      repairable: 0, unknown: 0, criticalDeliveries: 0,
    });
  });

  it("writes nothing for a stale audit hash", () => {
    seedLegacyQuarantineDefect(databasePath);
    const before = rawEvidence(databasePath);

    expect(() => repairTelegramLegacyQuarantine({
      databasePath, expectedAuditHash: "a".repeat(64),
      backupSha256: "b".repeat(64), checkedAt: 11,
    })).toThrow("Telegram quarantine candidate set changed");

    expect(rawEvidence(databasePath)).toEqual(before);
  });

  it("rolls back every row when a later candidate update fails", () => {
    const context = createLegacyQuarantineDefectFixtureContext();
    try {
      context.seed({ jobId: "first", ordinal: 0 });
      context.seed({ jobId: "second", ordinal: 1 });
      const audit = auditTelegramLegacyQuarantine({ databasePath: context.databasePath, checkedAt: 10 });
      const database = new Database(context.databasePath);
      try {
        database.exec(`CREATE TRIGGER block_second BEFORE UPDATE OF source_json ON inbox_updates
          WHEN NEW.job_id = 'second' BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
      } finally { database.close(); }
      const before = digestTelegramLogicalLedger(context.databasePath);

      expect(() => repairTelegramLegacyQuarantine({
        databasePath: context.databasePath, expectedAuditHash: audit.auditHash,
        backupSha256: "b".repeat(64), checkedAt: 11,
      })).toThrow();

      expect(digestTelegramLogicalLedger(context.databasePath)).toEqual(before);
      const inspect = new Database(context.databasePath, { readonly: true });
      try {
        expect(inspect.prepare("SELECT count(*) AS count FROM job_quarantine").get())
          .toEqual({ count: 2 });
      } finally { inspect.close(); }
    } finally { context.cleanup(); }
  });

  it("creates a private verified backup with identical logical digest", async () => {
    seedLegacyQuarantineDefect(databasePath);
    const destinationPath = path.join(directory, "private", "backup.sqlite");

    const backup = await createVerifiedTelegramJobBackup({ databasePath, destinationPath });

    expect(backup.backupPath).toBe(destinationPath);
    expect(backup.backupSha256).toBe(
      createHash("sha256").update(readFileSync(destinationPath)).digest("hex"),
    );
    expect(statSync(destinationPath).mode & 0o777).toBe(0o600);
    expect(digestTelegramLogicalLedger(destinationPath))
      .toEqual(digestTelegramLogicalLedger(databasePath));
  });
});

function rawEvidence(databasePath: string) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const one = (sql: string) => database.prepare(sql).get() as Record<string, unknown>;
    return {
      projection: JSON.parse(String(one("SELECT projection_json FROM jobs").projection_json)),
      source: JSON.parse(String(one("SELECT source_json FROM inbox_updates").source_json)),
      archives: database.prepare("SELECT * FROM job_event_archive ORDER BY sequence").all(),
      liveEvents: database.prepare("SELECT * FROM job_events ORDER BY sequence").all(),
      deliveries: database.prepare("SELECT * FROM deliveries ORDER BY ordinal, part_key").all(),
      quarantine: database.prepare("SELECT * FROM job_quarantine ORDER BY job_id").all(),
    };
  } finally {
    database.close();
  }
}
