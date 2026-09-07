import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import {
  createLegacyQuarantineDefectFixtureContext,
  seedLegacyQuarantineDefect,
  type LegacyQuarantineDefectFixture,
  type LegacyQuarantineDefectFixtureContext,
  type SafeSqliteRow,
} from "./telegram-job-quarantine-repair-fixtures.js";

describe("Telegram legacy quarantine repair fixture", () => {
  let directory = "";
  let databasePath = "";
  let ownedContext: LegacyQuarantineDefectFixtureContext | null = null;

  beforeEach(() => {
    directory = "";
    databasePath = "";
    ownedContext = null;
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-quarantine-repair-"));
    databasePath = path.join(directory, "jobs.sqlite");
  });

  afterEach(() => {
    ownedContext?.cleanup();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("reproduces the exact retained synthetic terminal quarantine defect", () => {
    const fixture = seedLegacyQuarantineDefect(databasePath);
    const { expected, preRepair } = fixture;

    expect(preRepair.jobs).toHaveLength(1);
    expect(preRepair.inboxUpdates).toHaveLength(1);
    expect(preRepair.jobEvents).toHaveLength(1);
    expect(preRepair.jobEventArchive).toHaveLength(2);
    expect(preRepair.deliveries).toHaveLength(2);
    expect(preRepair.jobQuarantine).toHaveLength(1);

    expect(preRepair.jobEventArchive.map((row) => ({
      type: row.event_type,
      eventAt: row.event_at_ms,
    }))).toEqual([
      { type: "update.accepted", eventAt: 1_700_000_000_000 },
      { type: "job.terminal", eventAt: expected.archivedTerminalAt },
    ]);

    const liveEvent = only(preRepair.jobEvents);
    expect(liveEvent).toEqual({
      sequence: 3,
      job_id: expected.jobId,
      event_id: expected.eventId,
      event_type: "reconciliation.decided",
      event_at_ms: expected.eventAt,
      payload_json: expect.any(String),
    });
    expect(parseJson(liveEvent.payload_json)).toEqual({
      jobId: expected.jobId,
      event: {
        schemaVersion: 1,
        type: "reconciliation.decided",
        eventAt: expected.eventAt,
        expectedVersion: expected.projectionVersion - 1,
        decision: {
          id: `refresh-terminal:${expected.ordinal}`,
          kind: "refresh_terminal",
          threadId: `legacy-thread-${expected.ordinal}`,
          turnId: `legacy-turn-${expected.ordinal}`,
          reasonCode: "restart_terminal",
        },
      },
    });

    const projection = parseJson(only(preRepair.jobs).projection_json);
    expect(projection).toEqual({
      schemaVersion: 1,
      id: expected.jobId,
      version: expected.projectionVersion,
      source: {
        botId: `legacy-json-v1:${expected.checksum}`,
        updateId: expected.ordinal,
      },
      attachments: [],
      phase: "terminal",
      health: "healthy",
      activity: "unknown",
      attention: { kind: "none" },
      outcome: "completed",
      dispatchId: null,
      threadId: `legacy-thread-${expected.ordinal}`,
      turnId: `legacy-turn-${expected.ordinal}`,
      responsePlan: [
        { partId: "final:0000", kind: "final" },
        { partId: "final:0001", kind: "final" },
      ],
      deliveries: [
        {
          partId: "final:0000",
          state: "delivered",
          attempts: 0,
          messageId: null,
          deliveredAt: expected.archivedTerminalAt,
        },
        {
          partId: "final:0001",
          state: "delivered",
          attempts: 0,
          messageId: null,
          deliveredAt: expected.archivedTerminalAt,
        },
      ],
      acceptedAt: 1_700_000_000_000,
      updatedAt: expected.eventAt,
      terminalAt: expected.archivedTerminalAt,
      dismissedAt: null,
      retainUntil: expected.archivedTerminalAt + 90 * 24 * 60 * 60 * 1_000,
      reconciliation: {
        decision: {
          id: `refresh-terminal:${expected.ordinal}`,
          kind: "refresh_terminal",
          threadId: `legacy-thread-${expected.ordinal}`,
          turnId: `legacy-turn-${expected.ordinal}`,
          reasonCode: "restart_terminal",
        },
        state: "pending",
        decidedAt: expected.eventAt,
        appliedAt: null,
      },
    });

    expect(preRepair.deliveries.map((row) => ({
      partKey: row.part_key,
      ordinal: row.ordinal,
      kind: row.kind,
      state: row.state,
      payload: row.payload_json,
      telegramMessageId: row.telegram_message_id,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at_ms,
      lastErrorCode: row.last_error_code,
      updatedAt: row.updated_at_ms,
    }))).toEqual([
      {
        partKey: "final:0000", ordinal: 0, kind: "final", state: "delivered",
        payload: "null", telegramMessageId: null, attemptCount: 0,
        nextAttemptAt: null, lastErrorCode: null, updatedAt: expected.archivedTerminalAt,
      },
      {
        partKey: "final:0001", ordinal: 1, kind: "final", state: "delivered",
        payload: "null", telegramMessageId: null, attemptCount: 0,
        nextAttemptAt: null, lastErrorCode: null, updatedAt: expected.archivedTerminalAt,
      },
    ]);
    expect(parseJson(only(preRepair.inboxUpdates).source_json)).toEqual({
      text: null,
      attachment: null,
      payloadPurged: true,
    });
    expect(only(preRepair.jobQuarantine)).toEqual({
      job_id: expected.jobId,
      reason_code: "malformed_persisted_job",
      fingerprint: createHash("sha256")
        .update(expected.jobId)
        .update("\0")
        .update(String(only(preRepair.jobs).projection_json))
        .digest("hex"),
      quarantined_at_ms: expected.quarantineTime,
    });
  });

  it("rejects non-temporary, existing, and outward-symlink database paths", () => {
    const procPath = `/proc/telecodex-quarantine-repair-${process.pid}.sqlite`;
    expect(() => seedLegacyQuarantineDefect(procPath)).toThrow(
      "Unsafe Telegram quarantine fixture database path",
    );
    expect(existsSync(procPath)).toBe(false);

    writeFileSync(databasePath, "existing-fixture-sentinel", "utf8");
    expect(() => seedLegacyQuarantineDefect(databasePath)).toThrow(
      "Telegram quarantine fixture database already exists",
    );
    expect(readFileSync(databasePath, "utf8")).toBe("existing-fixture-sentinel");

    const outward = path.join(directory, "outward");
    symlinkSync("/proc", outward, "dir");
    const linkedPath = path.join(outward, `telecodex-quarantine-repair-${process.pid}.sqlite`);
    expect(() => seedLegacyQuarantineDefect(linkedPath)).toThrow(
      "Unsafe Telegram quarantine fixture database path",
    );
    expect(existsSync(`/proc/telecodex-quarantine-repair-${process.pid}.sqlite`)).toBe(false);
  });

  it("seeds the complete 446-row defect set without a production special case", () => {
    ownedContext = createLegacyQuarantineDefectFixtureContext();
    const fixtures = Array.from({ length: 446 }, (_, ordinal) => ownedContext!.seed(
      { jobId: `legacy-quarantine-${String(ordinal).padStart(4, "0")}`, ordinal },
    ));

    expect(() => seedLegacyQuarantineDefect(ownedContext!.databasePath, {
      jobId: "forbidden-direct-existing-seed",
      ordinal: 446,
    })).toThrow("Telegram quarantine fixture database already exists");
    for (const fixture of fixtures) expectKnownDefectShape(fixture);
    expect(fixtures.every((fixture) => fixture.preRepair.jobs.length === 1)).toBe(true);
    expect(fixtures.every((fixture) => fixture.preRepair.jobQuarantine.length === 1)).toBe(true);
    const store = new SqliteTelegramJobStore(ownedContext!.databasePath, { readOnly: true });
    try {
      expect(store.countJobs()).toBe(446);
      expect(store.listQuarantined(1_000)).toHaveLength(446);
      expect(store.getMetadata("legacy-json-migration")).toEqual({
        status: "complete",
        version: "1",
        checksum: "c".repeat(64),
        sourceIdentity: "synthetic",
        importedCount: 446,
        quarantinedCount: 0,
        quarantined: [],
      });
    } finally {
      store.close();
    }
    expect(defectSetSnapshot(ownedContext!.databasePath)).toEqual({
      jobs: 446,
      quarantine: 446,
      archivedEvents: 892,
      liveEvents: 446,
      deliveries: 892,
      sources: Array.from({ length: 446 }, (_, ordinal) => ({
        bot_id: `legacy-json-v1:${"c".repeat(64)}`,
        update_id: ordinal,
        job_id: `legacy-quarantine-${String(ordinal).padStart(4, "0")}`,
      })),
    });
  }, 60_000);
});

function defectSetSnapshot(databasePath: string): Record<string, unknown> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      jobs: count(database, "jobs"),
      quarantine: count(database, "job_quarantine"),
      archivedEvents: count(database, "job_event_archive"),
      liveEvents: count(database, "job_events"),
      deliveries: count(database, "deliveries"),
      sources: database.prepare(`SELECT bot_id, update_id, job_id FROM inbox_updates
        ORDER BY update_id, job_id`).all(),
    };
  } finally {
    database.close();
  }
}

function count(database: Database.Database, table: string): number {
  const row = database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as {
    readonly count: number;
  };
  return row.count;
}

function expectKnownDefectShape(fixture: LegacyQuarantineDefectFixture): void {
  const { expected, preRepair } = fixture;
  const live = only(preRepair.jobEvents);
  const event = parseJson(live.payload_json).event as Record<string, unknown>;
  const decision = event.decision as Record<string, unknown>;
  const projection = parseJson(only(preRepair.jobs).projection_json);
  const reconciliation = projection.reconciliation as Record<string, unknown>;
  const projectedDecision = reconciliation.decision as Record<string, unknown>;
  expect({
    archive: preRepair.jobEventArchive.map((row) => row.event_type),
    live: [live.event_id, live.event_type, live.event_at_ms],
    event: [event.type, event.expectedVersion, decision.kind],
    projection: [projection.id, projection.version, projection.source,
      projection.phase, projection.outcome, projection.attention],
    reconciliation: [reconciliation.state, reconciliation.decidedAt,
      reconciliation.appliedAt, projectedDecision.kind],
    responsePlan: projection.responsePlan,
    projectedStates: (projection.deliveries as Array<Record<string, unknown>>)
      .map((part) => part.state),
    physical: preRepair.deliveries.map((row) => [
      row.part_key, row.ordinal, row.kind, row.state, row.telegram_message_id,
    ]),
    quarantine: preRepair.jobQuarantine.map((row) => [
      row.job_id, row.reason_code, row.quarantined_at_ms,
    ]),
  }).toEqual({
    archive: ["update.accepted", "job.terminal"],
    live: [expected.eventId, "reconciliation.decided", expected.eventAt],
    event: ["reconciliation.decided", expected.projectionVersion - 1, "refresh_terminal"],
    projection: [expected.jobId, expected.projectionVersion, {
      botId: `legacy-json-v1:${expected.checksum}`, updateId: expected.ordinal,
    }, "terminal", "completed", { kind: "none" }],
    reconciliation: ["pending", expected.eventAt, null, "refresh_terminal"],
    responsePlan: [
      { partId: "final:0000", kind: "final" },
      { partId: "final:0001", kind: "final" },
    ],
    projectedStates: ["delivered", "delivered"],
    physical: [
      ["final:0000", 0, "final", "delivered", null],
      ["final:0001", 1, "final", "delivered", null],
    ],
    quarantine: [[expected.jobId, "malformed_persisted_job", expected.quarantineTime]],
  });
}

function only(rows: readonly SafeSqliteRow[]): SafeSqliteRow {
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error("Expected one fixture row");
  return row;
}

function parseJson(value: SafeSqliteRow[string]): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Expected fixture JSON");
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected fixture JSON object");
  }
  return parsed as Record<string, unknown>;
}
