import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import { readSyntheticMigrationProof } from "./telegram-job-migration-provenance.js";
import type { TelegramJob } from "./telegram-job-types.js";
import { STATUS_CANDIDATE_WHERE } from "./telegram-status-anchor-ledger.js";

const JOB_ID_MAX_LENGTH = 128;
const JOB_WITH_INBOX = `SELECT jobs.*, inbox_updates.bot_id AS inbox_bot_id, inbox_updates.update_id AS inbox_update_id,
  inbox_updates.accepted_at_ms AS inbox_accepted_at_ms, inbox_updates.job_id AS inbox_job_id,
  inbox_updates.source_json AS inbox_source_json
  FROM jobs LEFT JOIN inbox_updates ON inbox_updates.job_id = jobs.id`;

export interface TelegramJobQuarantine {
  readonly jobId: string;
  readonly reasonCode: "malformed_persisted_job";
  readonly fingerprint: string;
  readonly quarantinedAt: number;
}
export interface TelegramReconciliationScanCursor { readonly acceptedAt: number; readonly jobId: string; }
export interface TelegramReconciliationScanInput {
  readonly limit: number;
  readonly quarantinedAt: number;
  readonly cursor?: TelegramReconciliationScanCursor;
}
export interface TelegramReconciliationScanResult {
  readonly jobs: readonly TelegramJob[];
  readonly quarantined: readonly TelegramJobQuarantine[];
  readonly nextCursor: TelegramReconciliationScanCursor | null;
}

export interface TelegramReconciliationScanHost {
  statement(sql: string): Database.Statement;
  decode(row: Record<string, unknown>): TelegramJob;
}

export function scanTelegramReconciliationCandidates(
  host: TelegramReconciliationScanHost,
  input: TelegramReconciliationScanInput,
): TelegramReconciliationScanResult {
  positive(input.limit, "limit"); nonNegative(input.quarantinedAt, "quarantinedAt");
  const cursor = input.cursor;
  if (cursor) { nonNegative(cursor.acceptedAt, "cursor acceptedAt"); bounded(cursor.jobId, "cursor jobId"); }
  const rows = host.statement(`${JOB_WITH_INBOX}
    LEFT JOIN job_quarantine ON job_quarantine.job_id = jobs.id
    WHERE job_quarantine.job_id IS NULL
      AND (? IS NULL OR inbox_updates.accepted_at_ms > ?
        OR (inbox_updates.accepted_at_ms = ? AND jobs.id > ?))
    ORDER BY inbox_updates.accepted_at_ms ASC, jobs.id ASC LIMIT ?`).all(
    cursor?.acceptedAt ?? null, cursor?.acceptedAt ?? 0, cursor?.acceptedAt ?? 0, cursor?.jobId ?? "", input.limit,
  ) as Record<string, unknown>[];
  const jobs: TelegramJob[] = [];
  const quarantined: TelegramJobQuarantine[] = [];
  for (const row of rows) {
    try {
      const candidate = host.decode(row);
      if (candidate.phase !== "terminal"
        || (!hasSyntheticLegacyProvenance(candidate, row) && terminalNeedsStatus(host, candidate.id))) {
        jobs.push(candidate);
      }
    } catch {
      quarantined.push(quarantineRow(host, row, input.quarantinedAt));
    }
  }
  const last = rows.at(-1);
  const nextCursor = rows.length < input.limit || !last ? null : {
    acceptedAt: nonNegative(last.inbox_accepted_at_ms, "accepted_at_ms"),
    jobId: bounded(last.id, "jobId"),
  };
  return { jobs: structuredClone(jobs), quarantined: structuredClone(quarantined), nextCursor };
}

function hasSyntheticLegacyProvenance(job: TelegramJob, row: Record<string, unknown>): boolean {
  const payload = jsonRecord(row.inbox_source_json);
  return readSyntheticMigrationProof(payload, job.source) !== null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function terminalNeedsStatus(
  host: Pick<TelegramReconciliationScanHost, "statement">,
  jobId: string,
): boolean {
  const row = host.statement(`SELECT CASE WHEN ${STATUS_CANDIDATE_WHERE} THEN 1 ELSE 0 END AS candidate
    FROM jobs WHERE jobs.id = ?`).get(jobId) as { candidate?: unknown } | undefined;
  return row?.candidate === 1;
}

export function listTelegramJobQuarantine(
  host: Pick<TelegramReconciliationScanHost, "statement">,
  limit: number,
): readonly TelegramJobQuarantine[] {
  positive(limit, "limit");
  return host.statement(`SELECT job_id, reason_code, fingerprint, quarantined_at_ms
    FROM job_quarantine ORDER BY quarantined_at_ms ASC, job_id ASC LIMIT ?`).all(limit).map((value) => {
    const row = value as Record<string, unknown>;
    if (row.reason_code !== "malformed_persisted_job") malformed();
    return {
      jobId: bounded(row.job_id, "jobId"), reasonCode: row.reason_code,
      fingerprint: fingerprint(row.fingerprint),
      quarantinedAt: nonNegative(row.quarantined_at_ms, "quarantinedAt"),
    };
  });
}

function quarantineRow(
  host: Pick<TelegramReconciliationScanHost, "statement">,
  row: Record<string, unknown>,
  quarantinedAt: number,
): TelegramJobQuarantine {
  const jobId = bounded(row.id, "jobId");
  const digest = createHash("sha256").update(jobId).update("\0")
    .update(typeof row.projection_json === "string" ? row.projection_json : String(row.projection_json)).digest("hex");
  host.statement(`INSERT INTO job_quarantine (job_id, reason_code, fingerprint, quarantined_at_ms)
    VALUES (?, 'malformed_persisted_job', ?, ?) ON CONFLICT(job_id) DO NOTHING`)
    .run(jobId, digest, quarantinedAt);
  const stored = host.statement(`SELECT job_id, reason_code, fingerprint, quarantined_at_ms
    FROM job_quarantine WHERE job_id = ?`).get(jobId) as Record<string, unknown> | undefined;
  if (!stored || stored.reason_code !== "malformed_persisted_job") malformed();
  return {
    jobId: bounded(stored.job_id, "jobId"), reasonCode: stored.reason_code,
    fingerprint: fingerprint(stored.fingerprint),
    quarantinedAt: nonNegative(stored.quarantined_at_ms, "quarantinedAt"),
  };
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) malformed();
  return value;
}
function bounded(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > JOB_ID_MAX_LENGTH) throw new Error(`Invalid ${name}`);
  return value;
}
function positive(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
}
function nonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
function malformed(): never { throw new Error("Malformed Telegram job quarantine"); }
