import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  SqliteTelegramJobStore,
  type NewDeliveryPart,
  type TelegramJob,
} from "../src/telegram-job-store.js";
import type {
  TelegramDeliveryPart,
  TelegramResponsePlanPart,
} from "../src/telegram-job-types.js";

const DAY = 24 * 60 * 60 * 1_000;
const DEFAULT_ACCEPTED_AT = 1_700_000_000_000;
const DEFAULT_CHECKSUM = "c".repeat(64);

export interface LegacyQuarantineDefectOverrides {
  readonly jobId?: string;
  readonly checksum?: string;
  readonly ordinal?: number;
  readonly acceptedAt?: number;
  readonly archivedTerminalAt?: number;
  readonly eventAt?: number;
  readonly quarantineTime?: number;
}

export interface LegacyQuarantineDefectExpectedMetadata {
  readonly jobId: string;
  readonly checksum: string;
  readonly ordinal: number;
  readonly archivedTerminalAt: number;
  readonly eventId: string;
  readonly eventAt: number;
  readonly projectionVersion: number;
  readonly quarantineTime: number;
}

export type SafeSqliteValue = string | number | null;
export type SafeSqliteRow = Readonly<Record<string, SafeSqliteValue>>;

export interface LegacyQuarantineDefectTableSnapshots {
  readonly jobs: readonly SafeSqliteRow[];
  readonly inboxUpdates: readonly SafeSqliteRow[];
  readonly jobEvents: readonly SafeSqliteRow[];
  readonly jobEventArchive: readonly SafeSqliteRow[];
  readonly deliveries: readonly SafeSqliteRow[];
  readonly jobQuarantine: readonly SafeSqliteRow[];
}

export interface LegacyQuarantineDefectFixture {
  readonly expected: LegacyQuarantineDefectExpectedMetadata;
  readonly preRepair: LegacyQuarantineDefectTableSnapshots;
}

export interface LegacyQuarantineDefectFixtureContext {
  readonly databasePath: string;
  seed(overrides?: LegacyQuarantineDefectOverrides): LegacyQuarantineDefectFixture;
  cleanup(): void;
}

export function createLegacyQuarantineDefectFixtureContext(): LegacyQuarantineDefectFixtureContext {
  const temporaryRoot = realpathSync.native(tmpdir());
  const directory = realpathSync.native(mkdtempSync(
    path.join(temporaryRoot, "telecodex-owned-quarantine-"),
  ));
  const databasePath = path.join(directory, "jobs.sqlite");
  let initialized = false;
  let cleaned = false;
  let sharedChecksum: string | null = null;
  const ordinals = new Set<number>();
  const jobIds = new Set<string>();
  return {
    databasePath,
    seed(overrides = {}) {
      if (cleaned) throw new Error("Telegram quarantine fixture context is cleaned");
      const checksum = overrides.checksum ?? DEFAULT_CHECKSUM;
      const ordinal = overrides.ordinal ?? 0;
      const jobId = overrides.jobId ?? `legacy-quarantine-${ordinal}`;
      if ((sharedChecksum !== null && checksum !== sharedChecksum)
        || ordinals.has(ordinal) || jobIds.has(jobId)) {
        throw new Error("Telegram quarantine fixture context conflict");
      }
      const safeDatabasePath = initialized
        ? ownedExistingDatabasePath(databasePath, directory)
        : newTemporaryDatabasePath(databasePath);
      const fixture = seedLegacyQuarantineDefectAt(safeDatabasePath, overrides);
      initialized = true;
      sharedChecksum = checksum;
      ordinals.add(ordinal);
      jobIds.add(jobId);
      return fixture;
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function seedLegacyQuarantineDefect(
  databasePath: string,
  overrides: LegacyQuarantineDefectOverrides = {},
): LegacyQuarantineDefectFixture {
  const safeDatabasePath = newTemporaryDatabasePath(databasePath);
  return seedLegacyQuarantineDefectAt(safeDatabasePath, overrides);
}

function seedLegacyQuarantineDefectAt(
  safeDatabasePath: string,
  overrides: LegacyQuarantineDefectOverrides,
): LegacyQuarantineDefectFixture {
  const ordinal = overrides.ordinal ?? 0;
  const jobId = overrides.jobId ?? `legacy-quarantine-${ordinal}`;
  const checksum = overrides.checksum ?? DEFAULT_CHECKSUM;
  const acceptedAt = overrides.acceptedAt ?? DEFAULT_ACCEPTED_AT;
  const archivedTerminalAt = overrides.archivedTerminalAt ?? acceptedAt + 1_000;
  const eventAt = overrides.eventAt ?? archivedTerminalAt + 7 * DAY + 1;
  const quarantineTime = overrides.quarantineTime ?? eventAt + 1;
  const eventId = `legacy-reconcile:${ordinal}`;
  const source = { botId: `legacy-json-v1:${checksum}`, updateId: ordinal };
  const responsePlan: readonly TelegramResponsePlanPart[] = [
    { partId: "final:0000", kind: "final" },
    { partId: "final:0001", kind: "final" },
  ];
  const projectedDeliveries: readonly TelegramDeliveryPart[] = responsePlan.map((part) => ({
    partId: part.partId,
    state: "delivered",
    attempts: 0,
    messageId: null,
    deliveredAt: archivedTerminalAt,
  }));
  const initialJob: TelegramJob = {
    schemaVersion: 1,
    version: 1,
    id: jobId,
    source,
    attachments: [],
    phase: "accepted",
    health: "healthy",
    activity: "unknown",
    attention: { kind: "none" },
    outcome: null,
    dispatchId: null,
    threadId: `legacy-thread-${ordinal}`,
    turnId: `legacy-turn-${ordinal}`,
    responsePlan: undefined,
    deliveries: [],
    acceptedAt,
    updatedAt: acceptedAt,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
  const initialDeliveries: readonly NewDeliveryPart[] = [
    ...responsePlan.map((part, partOrdinal) => delivery(
      jobId,
      part.partId,
      partOrdinal,
      part.kind,
      archivedTerminalAt,
    )),
  ];

  const store = new SqliteTelegramJobStore(safeDatabasePath);
  let projectionVersion: number;
  try {
    const marker = migrationMarker(store.getMetadata("legacy-json-migration"), checksum, ordinal);
    store.setMetadata("legacy-json-migration", marker);
    store.acceptUpdate({
      job: initialJob,
      eventId: `legacy-accepted:${ordinal}`,
      sourcePayload: {
        migration: { version: "1", checksum, sourceIdentity: "synthetic", ordinal },
        legacy: {
          id: jobId,
          state: "completed",
          sentPartKeys: responsePlan.map((part) => part.partId),
        },
      },
      initialDeliveries,
    });
    const terminal = store.transitionLegacyMigration({
      jobId,
      eventId: `legacy-terminal:${ordinal}`,
      expectedVersion: initialJob.version,
      event: {
        schemaVersion: 1,
        type: "job.terminal",
        eventAt: archivedTerminalAt,
        outcome: "completed",
        responsePlan,
        deliveries: projectedDeliveries,
      },
    });
    const retention = store.runRetention({
      now: archivedTerminalAt + 7 * DAY,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      batchSize: 100,
    });
    if (retention.payloadsPurged !== 1 || retention.jobsDeleted !== 0) {
      throw new Error("Unable to seed retained legacy quarantine fixture");
    }
    // Reproduce the historical scrubber bug even after the production scrubber
    // is fixed: old live rows lost this non-secret provenance before the fix.
    store.replaceSourcePayload(jobId, source, {
      text: null,
      attachment: null,
      payloadPurged: true,
    });
    const decided = store.transition({
      jobId,
      eventId,
      expectedVersion: terminal.version,
      event: {
        schemaVersion: 1,
        type: "reconciliation.decided",
        eventAt,
        decision: {
          id: `refresh-terminal:${ordinal}`,
          kind: "refresh_terminal",
          threadId: terminal.threadId,
          turnId: terminal.turnId,
          reasonCode: "restart_terminal",
        },
      },
    });
    projectionVersion = decided.version;
    const scan = store.scanReconciliationCandidates({ limit: 1, quarantinedAt: quarantineTime });
    if (scan.jobs.length !== 0 || scan.quarantined.length !== 1
      || scan.quarantined[0]?.jobId !== jobId) {
      throw new Error("Unable to seed scanner quarantine fixture");
    }
  } finally {
    store.close();
  }

  return {
    expected: {
      jobId,
      checksum,
      ordinal,
      archivedTerminalAt,
      eventId,
      eventAt,
      projectionVersion,
      quarantineTime,
    },
    preRepair: snapshotPreRepairTables(safeDatabasePath, jobId),
  };
}

function newTemporaryDatabasePath(databasePath: string): string {
  const temporaryRoot = realpathSync.native(tmpdir());
  const requestedPath = path.resolve(databasePath);
  const parent = realpathSync.native(path.dirname(requestedPath));
  if (!parent.startsWith(`${temporaryRoot}${path.sep}`)) {
    throw new Error("Unsafe Telegram quarantine fixture database path");
  }
  const target = path.join(parent, path.basename(requestedPath));
  try {
    lstatSync(target);
    throw new Error("Telegram quarantine fixture database already exists");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return target;
}

function ownedExistingDatabasePath(databasePath: string, ownedDirectory: string): string {
  const parent = realpathSync.native(path.dirname(databasePath));
  if (parent !== ownedDirectory) {
    throw new Error("Unsafe Telegram quarantine fixture database path");
  }
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()
    || realpathSync.native(databasePath) !== databasePath) {
    throw new Error("Unsafe Telegram quarantine fixture database path");
  }
  return databasePath;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function delivery(
  jobId: string,
  partKey: string,
  ordinal: number,
  kind: string,
  updatedAt: number,
): NewDeliveryPart {
  const payload = { sourceIdentity: "synthetic", legacyPartKey: partKey };
  return {
    jobId,
    partKey,
    ordinal,
    kind,
    state: "delivered",
    payload,
    contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    telegramMessageId: null,
    attemptCount: 0,
    updatedAt,
  };
}

function migrationMarker(
  value: unknown,
  checksum: string,
  ordinal: number,
): Record<string, unknown> {
  const previous = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const previousImportedCount = previous?.checksum === checksum
    && typeof previous.importedCount === "number"
    && Number.isSafeInteger(previous.importedCount)
    && previous.importedCount >= 0
    ? previous.importedCount
    : 0;
  return {
    status: "complete",
    version: "1",
    checksum,
    sourceIdentity: "synthetic",
    importedCount: Math.max(previousImportedCount, ordinal + 1),
    quarantinedCount: 0,
    quarantined: [],
  };
}

function snapshotPreRepairTables(
  databasePath: string,
  jobId: string,
): LegacyQuarantineDefectTableSnapshots {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      jobs: rows(database, "SELECT * FROM jobs WHERE id = ? ORDER BY id", jobId),
      inboxUpdates: rows(database, "SELECT * FROM inbox_updates WHERE job_id = ? ORDER BY job_id", jobId),
      jobEvents: rows(database, "SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence", jobId),
      jobEventArchive: rows(database,
        "SELECT * FROM job_event_archive WHERE job_id = ? ORDER BY sequence", jobId),
      deliveries: rows(database,
        "SELECT * FROM deliveries WHERE job_id = ? ORDER BY ordinal, part_key", jobId),
      jobQuarantine: rows(database,
        "SELECT * FROM job_quarantine WHERE job_id = ? ORDER BY job_id", jobId),
    };
  } finally {
    database.close();
  }
}

function rows(
  database: Database.Database,
  sql: string,
  jobId: string,
): readonly SafeSqliteRow[] {
  return (database.prepare(sql).all(jobId) as Record<string, unknown>[]).map((row) => {
    const safe: Record<string, SafeSqliteValue> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "string" && typeof value !== "number" && value !== null) {
        throw new Error("Unsafe SQLite fixture snapshot value");
      }
      safe[key] = value;
    }
    return safe;
  });
}
