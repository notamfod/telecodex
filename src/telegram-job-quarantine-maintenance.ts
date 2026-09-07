import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { validateTelegramJobSchema } from "./telegram-job-ledger-schema.js";
import { auditTelegramLegacyQuarantine } from "./telegram-job-quarantine-repair.js";

export interface TelegramQuarantineRepairInput {
  readonly databasePath: string;
  readonly expectedAuditHash: string;
  readonly backupSha256: string;
  readonly checkedAt: number;
}

export interface TelegramQuarantineRepairResult {
  readonly schemaVersion: 1;
  readonly repaired: number;
  readonly auditHash: string;
  readonly backupSha256: string;
}

export interface TelegramJobBackupResult {
  readonly backupPath: string;
  readonly backupSha256: string;
}

export interface TelegramLogicalLedgerDigest {
  readonly schemaVersion: 1;
  readonly userVersion: number;
  readonly tables: readonly { readonly name: string; readonly rows: number }[];
  readonly sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

export class TelegramQuarantineCandidateSetChangedError extends Error {
  constructor() { super("Telegram quarantine candidate set changed"); }
}

export function repairTelegramLegacyQuarantine(
  input: TelegramQuarantineRepairInput,
): TelegramQuarantineRepairResult {
  if (!SHA256.test(input.expectedAuditHash) || !SHA256.test(input.backupSha256)
    || !Number.isSafeInteger(input.checkedAt) || input.checkedAt < 0) {
    throw new Error("Invalid Telegram quarantine repair input");
  }
  const database = new Database(input.databasePath, { fileMustExist: true });
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  let begun = false;
  try {
    validateTelegramJobSchema(database);
    database.exec("BEGIN IMMEDIATE");
    begun = true;
    const audit = auditTelegramLegacyQuarantine({
      databasePath: input.databasePath,
      checkedAt: input.checkedAt,
    });
    if (audit.auditHash !== input.expectedAuditHash || audit.unknown !== 0
      || audit.criticalDeliveries !== 0) {
      throw new TelegramQuarantineCandidateSetChangedError();
    }
    const targets = database.prepare(
      "SELECT job_id FROM job_quarantine ORDER BY quarantined_at_ms, job_id",
    ).all() as Array<{ job_id: unknown }>;
    if (targets.length !== audit.repairable) {
      throw new TelegramQuarantineCandidateSetChangedError();
    }
    const marker = migrationMarker(database);
    for (const target of targets) repairCandidate(database, boundedId(target.job_id), marker.version);
    if (database.prepare("SELECT 1 FROM job_quarantine LIMIT 1").get()
      || database.prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get()) {
      throw new Error("Telegram quarantine repair verification failed");
    }
    database.exec("COMMIT");
    begun = false;
    return {
      schemaVersion: 1,
      repaired: targets.length,
      auditHash: input.expectedAuditHash,
      backupSha256: input.backupSha256,
    };
  } catch (error) {
    if (begun) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function createVerifiedTelegramJobBackup(input: {
  readonly databasePath: string;
  readonly destinationPath: string;
}): Promise<TelegramJobBackupResult> {
  const destination = prepareDestination(input.databasePath, input.destinationPath);
  const source = new Database(input.databasePath, { readonly: true, fileMustExist: true });
  try {
    validateTelegramJobSchema(source);
    await source.backup(destination);
  } finally {
    source.close();
  }
  chmodSync(destination, 0o600);
  verifyBackup(input.databasePath, destination);
  return {
    backupPath: destination,
    backupSha256: createHash("sha256").update(readFileSync(destination)).digest("hex"),
  };
}

export function digestTelegramLogicalLedger(databasePath: string): TelegramLogicalLedgerDigest {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    validateTelegramJobSchema(database);
    const userVersion = database.pragma("user_version", { simple: true });
    if (!Number.isSafeInteger(userVersion) || (userVersion as number) < 0) {
      throw new Error("Invalid Telegram ledger version");
    }
    const tableRows = database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: unknown }>;
    const tableNames = tableRows.map((row) => boundedName(row.name));
    const hash = createHash("sha256");
    const tables = tableNames.map((name) => {
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
        name: unknown; pk: unknown;
      }>;
      const primary = columns.filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => boundedName(column.name));
      if (primary.length === 0) throw new Error("Telegram ledger table lacks primary key");
      const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(name)} ORDER BY ${
        primary.map(quoteIdentifier).join(", ")}`).all() as Array<Record<string, unknown>>;
      hashField(hash, name);
      for (const row of rows) {
        for (const column of columns) {
          const columnName = boundedName(column.name);
          hashField(hash, columnName);
          hashSqliteValue(hash, row[columnName]);
        }
      }
      return { name, rows: rows.length };
    });
    return { schemaVersion: 1, userVersion: userVersion as number, tables, sha256: hash.digest("hex") };
  } finally {
    database.close();
  }
}

function repairCandidate(database: Database.Database, jobId: string, version: string): void {
  const row = database.prepare(`SELECT jobs.projection_json, jobs.version AS row_version,
    inbox_updates.source_json, inbox_updates.bot_id, inbox_updates.update_id
    FROM jobs JOIN inbox_updates ON inbox_updates.job_id = jobs.id WHERE jobs.id = ?`).get(jobId) as Record<string, unknown> | undefined;
  const eventRow = database.prepare(`SELECT sequence, payload_json FROM job_events
    WHERE job_id = ? AND event_type = 'reconciliation.decided'`).get(jobId) as Record<string, unknown> | undefined;
  if (!row || !eventRow) throw new Error("Telegram quarantine repair verification failed");
  const projection = jsonRecord(row.projection_json);
  const source = jsonRecord(row.source_json);
  const storedEvent = jsonRecord(eventRow.payload_json);
  const event = record(storedEvent.event);
  const expectedVersion = safeInteger(event?.expectedVersion);
  const terminalAt = safeInteger(projection.terminalAt);
  const checksum = /^legacy-json-v1:([0-9a-f]{64})$/.exec(String(row.bot_id))?.[1];
  const ordinal = safeInteger(row.update_id);
  if (expectedVersion === null || terminalAt === null || !checksum || ordinal === null
    || row.row_version !== projection.version || !Object.hasOwn(projection, "reconciliation")) {
    throw new Error("Telegram quarantine repair verification failed");
  }
  const repairedProjection: Record<string, unknown> = {
    ...projection, version: expectedVersion, updatedAt: terminalAt,
  };
  delete repairedProjection.reconciliation;
  const repairedSource = { ...source, migration: {
    version, checksum, sourceIdentity: "synthetic", ordinal,
  } };
  const jobUpdate = database.prepare(`UPDATE jobs SET version = ?, projection_json = ?, updated_at_ms = ?
    WHERE id = ? AND version = ?`).run(
    expectedVersion, JSON.stringify(repairedProjection), terminalAt, jobId, row.row_version,
  );
  const sourceUpdate = database.prepare("UPDATE inbox_updates SET source_json = ? WHERE job_id = ?")
    .run(JSON.stringify(repairedSource), jobId);
  const eventDelete = database.prepare(
    "DELETE FROM job_events WHERE job_id = ? AND sequence = ? AND event_type = 'reconciliation.decided'",
  ).run(jobId, eventRow.sequence);
  const quarantineDelete = database.prepare("DELETE FROM job_quarantine WHERE job_id = ?").run(jobId);
  if ([jobUpdate, sourceUpdate, eventDelete, quarantineDelete].some((result) => result.changes !== 1)) {
    throw new Error("Telegram quarantine repair verification failed");
  }
}

function migrationMarker(database: Database.Database): { readonly version: string } {
  const row = database.prepare("SELECT value FROM metadata WHERE key = 'legacy-json-migration'").get() as { value?: unknown } | undefined;
  const marker = jsonRecord(row?.value);
  if (marker.status !== "complete" || typeof marker.version !== "string"
    || !/^[A-Za-z0-9._-]{1,32}$/.test(marker.version)) {
    throw new Error("Telegram quarantine repair verification failed");
  }
  return { version: marker.version };
}

function prepareDestination(sourcePath: string, destinationPath: string): string {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination || existsSync(destination)) throw new Error("Unsafe Telegram backup destination");
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || realpathSync(parent) !== parent) {
    throw new Error("Unsafe Telegram backup destination");
  }
  return destination;
}

function verifyBackup(sourcePath: string, backupPath: string): void {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    validateTelegramJobSchema(source);
    validateTelegramJobSchema(backup);
    for (const database of [source, backup]) {
      if (database.pragma("quick_check", { simple: true }) !== "ok"
        || database.prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get()) {
        throw new Error("Telegram backup verification failed");
      }
    }
    const sourceDigest = digestTelegramLogicalLedger(sourcePath);
    const backupDigest = digestTelegramLogicalLedger(backupPath);
    if (JSON.stringify(sourceDigest) !== JSON.stringify(backupDigest)) {
      throw new Error("Telegram backup verification failed");
    }
  } finally {
    source.close();
    backup.close();
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Telegram quarantine repair verification failed");
  const parsed = record(JSON.parse(value));
  if (!parsed) throw new Error("Telegram quarantine repair verification failed");
  return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("Telegram quarantine repair verification failed");
  }
  return value;
}

function boundedName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw new Error("Invalid Telegram ledger identifier");
  }
  return value;
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function hashField(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

function hashSqliteValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null) { hashField(hash, "null"); return; }
  if (Buffer.isBuffer(value)) { hashField(hash, "blob"); hashField(hash, value.toString("base64")); return; }
  if (typeof value === "number") { hashField(hash, Number.isInteger(value) ? "integer" : "real"); hashField(hash, String(value)); return; }
  if (typeof value === "string") { hashField(hash, "text"); hashField(hash, value); return; }
  throw new Error("Invalid Telegram ledger value");
}
