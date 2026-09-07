import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TELEGRAM_QUARANTINE_CONDITION_CODES,
  diagnoseTelegramLegacyQuarantine,
} from "../src/telegram-job-quarantine-repair.js";
import { seedLegacyQuarantineDefect }
  from "./telegram-job-quarantine-repair-fixtures.js";

describe("Telegram quarantine diagnosis", () => {
  let directory = "";
  let databasePath = "";

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-quarantine-diagnosis-"));
    databasePath = path.join(directory, "jobs.sqlite");
  });

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("reports only bounded first-rejection counts for all 15 conditions", () => {
    seedLegacyQuarantineDefect(databasePath);
    const database = new Database(databasePath);
    try {
      database.exec(`INSERT INTO deliveries
        (job_id, part_key, ordinal, kind, state, payload_json, content_hash,
         telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
        SELECT job_id, 'status-anchor', 0, 'status-anchor', state, payload_json,
          content_hash, NULL, 0, NULL, NULL, updated_at_ms
        FROM deliveries WHERE part_key = 'final:0000'`);
    } finally {
      database.close();
    }

    const report = diagnoseTelegramLegacyQuarantine({
      databasePath,
      checkedAt: 1_700_604_801_002,
    });

    expect(TELEGRAM_QUARANTINE_CONDITION_CODES).toHaveLength(15);
    expect(Object.keys(report.rejections)).toEqual(TELEGRAM_QUARANTINE_CONDITION_CODES);
    expect(report).toEqual(expect.objectContaining({
      schemaVersion: 1,
      total: 1,
      repairable: 0,
      unknown: 1,
      criticalDeliveries: 0,
    }));
    expect(report.rejections.condition14_synthetic_deliveries).toBe(1);
    expect(Object.values(report.rejections).reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(
      /legacy-quarantine|databasePath|payload|prompt|response|attachment|threadId|turnId|eventId|jobId/,
    );
  });
});
