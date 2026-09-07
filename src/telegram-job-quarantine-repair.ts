import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

import {
  hashTelegramQuarantineAuditCandidates,
  type TelegramQuarantineAuditHashCandidate as RepairableCandidate,
} from "./telegram-job-quarantine-audit-hash.js";
import {
  prepareTelegramQuarantineCandidateReader,
  TELEGRAM_QUARANTINE_PROJECTION_JSON_MAX_CHARS,
  type TelegramQuarantineAuditRow as Row,
} from "./telegram-job-quarantine-audit-reader.js";
import { decodeTelegramJobProjection } from "./telegram-job-ledger.js";
import { validateTelegramJobSchema } from "./telegram-job-ledger-schema.js";
import { TELEGRAM_STATUS_ANCHOR_PART_KEY, type TelegramJob } from "./telegram-job-types.js";

export const TELEGRAM_QUARANTINE_AUDIT_LIMIT = 1_000;

export interface TelegramQuarantineAuditReport {
  readonly schemaVersion: 1;
  readonly checkedAt: number;
  readonly repairable: number;
  readonly unknown: number;
  readonly criticalDeliveries: number;
  readonly auditHash: string;
}

export interface TelegramQuarantineAuditInput {
  readonly databasePath: string;
  readonly checkedAt: number;
  readonly limit?: number;
}

export const TELEGRAM_QUARANTINE_CONDITION_CODES = [
  "condition01_quarantine_reason", "condition02_projection_shape",
  "condition03_terminal_state", "condition04_reconciliation_intent",
  "condition05_projection_version", "condition06_projection_timestamp",
  "condition07_synthetic_source", "condition08_scrubbed_source",
  "condition09_migration_marker", "condition10_archived_history",
  "condition11_live_history", "condition12_delivery_state",
  "condition13_plan_mapping", "condition14_synthetic_deliveries",
  "condition15_foreign_keys",
] as const;
export type TelegramQuarantineConditionCode = typeof TELEGRAM_QUARANTINE_CONDITION_CODES[number];
export interface TelegramQuarantineDiagnosisReport {
  readonly schemaVersion: 1;
  readonly checkedAt: number;
  readonly total: number;
  readonly repairable: number;
  readonly unknown: number;
  readonly criticalDeliveries: number;
  readonly rejections: Readonly<Record<TelegramQuarantineConditionCode, number>>;
}

interface MigrationMarker {
  readonly version: string;
  readonly checksum: string;
  readonly importedCount: number;
}

const AUDIT_ERROR = "Unable to audit Telegram legacy quarantine";
const BUSY_TIMEOUT_MS = 5_000;
const ID_MAX_LENGTH = 128;
const ID_MAX_BYTES = ID_MAX_LENGTH * 4;
const MARKER_MAX_CHARS = 256 * 1024;
const MARKER_MAX_BYTES = MARKER_MAX_CHARS * 4;
const MARKER_KEYS = [
  "status", "version", "checksum", "sourceIdentity", "importedCount",
  "quarantinedCount", "quarantined",
] as const;

export function auditTelegramLegacyQuarantine(
  input: TelegramQuarantineAuditInput,
): TelegramQuarantineAuditReport {
  return inspectTelegramLegacyQuarantine(input).audit;
}

export function diagnoseTelegramLegacyQuarantine(
  input: TelegramQuarantineAuditInput,
): TelegramQuarantineDiagnosisReport {
  return inspectTelegramLegacyQuarantine(input).diagnosis;
}

function inspectTelegramLegacyQuarantine(input: TelegramQuarantineAuditInput): {
  readonly audit: TelegramQuarantineAuditReport;
  readonly diagnosis: TelegramQuarantineDiagnosisReport;
} {
  const limit = auditLimit(input.limit);
  if (!nonNegativeSafeInteger(input.checkedAt)) throw new Error("Invalid Telegram quarantine audit input");
  let database: Database.Database | null = null;
  let report: ReturnType<typeof inspectDatabase> | null = null;
  let failed = false;
  try {
    database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.pragma("foreign_keys = ON");
    const inspect = database.transaction(() => inspectDatabase(database!, input.checkedAt, limit));
    report = inspect.deferred();
  } catch {
    failed = true;
  } finally {
    if (database) {
      try { database.close(); } catch { failed = true; }
    }
  }
  if (failed || !report) throw new Error(AUDIT_ERROR);
  return report;
}

function inspectDatabase(
  database: Database.Database,
  checkedAt: number,
  limit: number,
): {
  readonly audit: TelegramQuarantineAuditReport;
  readonly diagnosis: TelegramQuarantineDiagnosisReport;
} {
  validateTelegramJobSchema(database);
  if (database.prepare("SELECT 1 AS violation FROM pragma_foreign_key_check LIMIT 1").get()) {
    throw new Error(AUDIT_ERROR);
  }
  const rows = database.prepare(`SELECT
      CASE WHEN typeof(quarantine.job_id) = 'text'
        AND length(quarantine.job_id) BETWEEN 1 AND ${ID_MAX_LENGTH}
        AND length(CAST(quarantine.job_id AS BLOB)) BETWEEN 1 AND ${ID_MAX_BYTES}
        THEN quarantine.job_id ELSE NULL END AS job_id,
      quarantine.reason_code = 'malformed_persisted_job' AS reason_is_malformed,
      CASE WHEN typeof(quarantine.fingerprint) = 'text'
        AND length(quarantine.fingerprint) = 64
        AND length(CAST(quarantine.fingerprint AS BLOB)) = 64
        AND quarantine.fingerprint NOT GLOB '*[^0-9a-f]*'
        THEN quarantine.fingerprint ELSE NULL END AS fingerprint,
      ${boundedIntegerSql("quarantine.quarantined_at_ms", "quarantined_at_ms")},
      CASE WHEN typeof(jobs.id) = 'text' AND length(jobs.id) BETWEEN 1 AND ${ID_MAX_LENGTH}
        AND length(CAST(jobs.id AS BLOB)) BETWEEN 1 AND ${ID_MAX_BYTES}
        THEN jobs.id ELSE NULL END AS projection_row_id,
      ${boundedIntegerSql("jobs.version", "projection_row_version")},
      ${boundedIntegerSql("jobs.updated_at_ms", "projection_row_updated_at")},
      CASE WHEN typeof(inbox_updates.bot_id) = 'text'
        AND length(inbox_updates.bot_id) = 79
        AND length(CAST(inbox_updates.bot_id AS BLOB)) = 79
        AND substr(inbox_updates.bot_id, 1, 15) = 'legacy-json-v1:'
        AND substr(inbox_updates.bot_id, 16) NOT GLOB '*[^0-9a-f]*'
        THEN inbox_updates.bot_id ELSE NULL END AS inbox_bot_id,
      ${boundedIntegerSql("inbox_updates.update_id", "inbox_update_id")},
      ${boundedIntegerSql("inbox_updates.accepted_at_ms", "inbox_accepted_at_ms")},
      CASE WHEN typeof(inbox_updates.job_id) = 'text'
        AND length(inbox_updates.job_id) BETWEEN 1 AND ${ID_MAX_LENGTH}
        AND length(CAST(inbox_updates.job_id AS BLOB)) BETWEEN 1 AND ${ID_MAX_BYTES}
        THEN inbox_updates.job_id ELSE NULL END AS inbox_job_id
    FROM job_quarantine AS quarantine
    LEFT JOIN jobs ON jobs.id = quarantine.job_id
    LEFT JOIN inbox_updates ON inbox_updates.job_id = quarantine.job_id
    ORDER BY quarantine.quarantined_at_ms ASC, quarantine.job_id ASC
    LIMIT ?`).all(limit + 1) as Row[];
  if (rows.length > limit) throw new Error(AUDIT_ERROR);

  const marker = readMigrationMarker(database);
  const loadCandidateRows = prepareTelegramQuarantineCandidateReader(database);
  const repairable: RepairableCandidate[] = [];
  const rejections = Object.fromEntries(
    TELEGRAM_QUARANTINE_CONDITION_CODES.map((code) => [code, 0]),
  ) as Record<TelegramQuarantineConditionCode, number>;
  let unknown = 0;
  let criticalDeliveries = 0;
  for (const row of rows) {
    const loaded = loadCandidateRows(row);
    criticalDeliveries += loaded.criticalDeliveries;
    if (!loaded.rows) {
      unknown += 1;
      rejections.condition02_projection_shape += 1;
      continue;
    }
    try {
      const result = classifyCandidate(
        loaded.rows.row, marker, loaded.rows.archives, loaded.rows.liveEvents, loaded.rows.deliveries,
      );
      if ("candidate" in result) repairable.push(result.candidate);
      else { unknown += 1; rejections[result.rejection] += 1; }
    } catch {
      unknown += 1;
      rejections.condition02_projection_shape += 1;
    }
  }
  const audit = {
    schemaVersion: 1,
    checkedAt,
    repairable: repairable.length,
    unknown,
    criticalDeliveries,
    auditHash: hashTelegramQuarantineAuditCandidates(repairable),
  } satisfies TelegramQuarantineAuditReport;
  return { audit, diagnosis: {
    schemaVersion: 1, checkedAt, total: rows.length, repairable: repairable.length,
    unknown, criticalDeliveries, rejections,
  } };
}

function classifyCandidate(
  row: Row,
  marker: MigrationMarker | null,
  archives: readonly Row[],
  liveEvents: readonly Row[],
  deliveries: readonly Row[],
): { readonly candidate: RepairableCandidate }
  | { readonly rejection: TelegramQuarantineConditionCode } {
  const jobId = boundedText(row.job_id, ID_MAX_LENGTH);
  const fingerprint = lowercaseSha256(row.fingerprint);
  const quarantinedAt = timestamp(row.quarantined_at_ms);
  if (row.reason_is_malformed !== 1) return reject("condition01_quarantine_reason");
  const projectionJson = boundedText(
    row.projection_json, TELEGRAM_QUARANTINE_PROJECTION_JSON_MAX_CHARS,
  );
  const job = decodeTelegramJobProjection(projectionJson);
  if (!projectionMatchesRows(job, row)) return reject("condition02_projection_shape");
  if (!terminalSignature(job)) return reject("condition03_terminal_state");
  if (!reconciliationSignature(job)) return reject("condition04_reconciliation_intent");
  const live = liveEventFacts(job, liveEvents);
  if (!live) return reject("condition11_live_history");
  if (job.version !== live.expectedVersion + 1) return reject("condition05_projection_version");
  if (job.updatedAt !== live.eventAt) return reject("condition06_projection_timestamp");
  const checksum = syntheticChecksum(job);
  if (checksum === null || row.inbox_job_id !== job.id || row.inbox_bot_id !== job.source.botId
    || row.inbox_update_id !== job.source.updateId || row.inbox_accepted_at_ms !== job.acceptedAt) {
    return reject("condition07_synthetic_source");
  }
  if (!sourcePayloadPurged(row.inbox_source_json)) return reject("condition08_scrubbed_source");
  if (marker === null || checksum !== marker.checksum || job.source.updateId >= marker.importedCount) {
    return reject("condition09_migration_marker");
  }
  if (!archiveSignature(job, archives)) return reject("condition10_archived_history");
  if (!liveHistorySignature(live, archives)) return reject("condition11_live_history");
  if (!deliveryStateSignature(job, deliveries)) return reject("condition12_delivery_state");
  if (!responsePlanSignature(job, deliveries)) return reject("condition13_plan_mapping");
  if (!syntheticDeliveriesSignature(job, deliveries)) {
    return reject("condition14_synthetic_deliveries");
  }
  return { candidate: {
    jobId,
    projectionVersion: job.version,
    projectionUpdatedAt: job.updatedAt,
    quarantineFingerprint: fingerprint,
    quarantinedAt,
    liveEventId: live.eventId,
    liveEventAt: live.eventAt,
    checksum,
    ordinal: job.source.updateId,
  } };
}

function reject(rejection: TelegramQuarantineConditionCode): { readonly rejection: TelegramQuarantineConditionCode } {
  return { rejection };
}

function projectionMatchesRows(job: TelegramJob, row: Row): boolean {
  return row.projection_row_id === job.id
    && row.job_id === job.id
    && row.projection_row_version === job.version
    && row.projection_row_updated_at === job.updatedAt
    && row.inbox_job_id === job.id
    && row.inbox_bot_id === job.source.botId
    && row.inbox_update_id === job.source.updateId
    && row.inbox_accepted_at_ms === job.acceptedAt;
}

function terminalSignature(job: TelegramJob): boolean {
  return job.phase === "terminal"
    && job.outcome === "completed"
    && job.attention.kind === "none"
    && nonNegativeSafeInteger(job.retainUntil);
}

function reconciliationSignature(job: TelegramJob): boolean {
  const intent = job.reconciliation;
  return intent !== undefined && intent.state === "pending" && intent.appliedAt === null
    && intent.decision.kind === "refresh_terminal";
}

function syntheticChecksum(job: TelegramJob): string | null {
  const match = /^legacy-json-v1:([0-9a-f]{64})$/.exec(job.source.botId);
  return match && nonNegativeSafeInteger(job.source.updateId) ? match[1]! : null;
}

function sourcePayloadPurged(value: unknown): boolean {
  const source = parseJsonRecord(value);
  return source.payloadPurged === true
    && source.text === null
    && source.attachment === null
    && !Object.hasOwn(source, "migration");
}

function archiveSignature(job: TelegramJob, rows: readonly Row[]): boolean {
  if (rows.length !== 2 || job.terminalAt === null) return false;
  const accepted = rows[0]!, terminal = rows[1]!;
  const acceptedSequence = positiveSafeInteger(accepted.sequence);
  const terminalSequence = positiveSafeInteger(terminal.sequence);
  const acceptedId = boundedText(accepted.event_id, ID_MAX_LENGTH);
  const terminalId = boundedText(terminal.event_id, ID_MAX_LENGTH);
  return accepted.job_id === job.id
    && terminal.job_id === job.id
    && acceptedSequence < terminalSequence
    && acceptedId !== terminalId
    && accepted.event_type_is_accepted === 1
    && terminal.event_type_is_terminal === 1
    && timestamp(accepted.event_at_ms) === job.acceptedAt
    && timestamp(terminal.event_at_ms) === job.terminalAt;
}

function liveEventFacts(
  job: TelegramJob,
  rows: readonly Row[],
): { readonly eventId: string; readonly eventAt: number; readonly sequence: number;
  readonly expectedVersion: number } | null {
  if (rows.length !== 1 || !job.reconciliation) return null;
  const row = rows[0]!;
  const sequence = positiveSafeInteger(row.sequence);
  const eventId = boundedText(row.event_id, ID_MAX_LENGTH);
  const eventAt = timestamp(row.event_at_ms);
  const stored = parseJsonRecord(row.payload_json);
  if (!onlyKeys(stored, ["jobId", "event"]) || stored.jobId !== job.id) return null;
  const event = plainRecord(stored.event);
  if (!event || !onlyKeys(event, ["schemaVersion", "type", "eventAt", "expectedVersion", "decision"])) {
    return null;
  }
  const expectedVersion = nonNegativeInteger(event.expectedVersion);
  const decision = plainRecord(event.decision);
  if (!decision || !onlyKeys(decision, ["id", "kind", "threadId", "turnId", "reasonCode"])) return null;
  return row.job_id === job.id
    && row.event_type_is_reconciliation === 1
    && event.schemaVersion === 1
    && event.type === "reconciliation.decided"
    && timestamp(event.eventAt) === eventAt
    && expectedVersion < Number.MAX_SAFE_INTEGER
    && decision.kind === "refresh_terminal"
    && isDeepStrictEqual(decision, job.reconciliation.decision)
    && job.reconciliation.decidedAt === eventAt
    && job.reconciliation.appliedAt === null
    ? { eventId, eventAt, sequence, expectedVersion }
    : null;
}

function liveHistorySignature(
  live: { readonly eventId: string; readonly sequence: number },
  archives: readonly Row[],
): boolean {
  const terminalSequence = positiveSafeInteger(archives[1]!.sequence);
  const archivedIds = new Set(archives.map((archive) => boundedText(archive.event_id, ID_MAX_LENGTH)));
  return live.sequence > terminalSequence && !archivedIds.has(live.eventId);
}

function deliveryStateSignature(job: TelegramJob, rows: readonly Row[]): boolean {
  return job.deliveries.every((delivery) => delivery.state === "delivered")
    && rows.every((row) => row.state === "delivered");
}

function responsePlanSignature(job: TelegramJob, rows: readonly Row[]): boolean {
  if (!job.responsePlan) return false;
  for (const row of rows) validateDeliveryRow(row, job.id);
  const anchors = rows.filter((row) =>
    row.part_key === TELEGRAM_STATUS_ANCHOR_PART_KEY || row.kind === TELEGRAM_STATUS_ANCHOR_PART_KEY);
  const planned = rows.filter((row) => !anchors.includes(row));
  if (planned.length !== job.responsePlan.length) return false;
  return job.responsePlan.every((part, ordinal) => {
    const row = planned[ordinal];
    return row?.part_key === part.partId && row.kind === part.kind && row.ordinal === ordinal;
  });
}

function validateDeliveryRow(row: Row, jobId: string): void {
  if (row.job_id !== jobId) throw new Error();
  boundedText(row.part_key, 256);
  boundedText(row.kind, ID_MAX_LENGTH);
  nonNegativeInteger(row.ordinal);
  boundedText(row.state, 32);
  if (typeof row.payload_is_null !== "boolean") throw new Error();
  lowercaseSha256(row.content_hash);
  if (row.telegram_message_id_type_valid !== 1 || row.next_attempt_at_ms_type_valid !== 1) throw new Error();
  if (row.telegram_message_id !== null) positiveSafeInteger(row.telegram_message_id);
  nonNegativeInteger(row.attempt_count);
  if (row.next_attempt_at_ms !== null) timestamp(row.next_attempt_at_ms);
  if (row.last_error_code !== null) boundedText(row.last_error_code, ID_MAX_LENGTH);
  timestamp(row.updated_at_ms);
}

function syntheticDeliveriesSignature(job: TelegramJob, rows: readonly Row[]): boolean {
  return rows.every((row) => row.part_key !== TELEGRAM_STATUS_ANCHOR_PART_KEY
    && row.kind === "final" && row.state === "delivered" && row.telegram_message_id === null
    && row.attempt_count === 0 && row.next_attempt_at_ms === null && row.last_error_code === null
    && row.updated_at_ms === job.terminalAt && row.payload_is_null === true);
}

function readMigrationMarker(database: Database.Database): MigrationMarker | null {
  const lengths = database.prepare(`SELECT length(value) AS char_length,
    length(CAST(value AS BLOB)) AS byte_length FROM metadata
    WHERE key = 'legacy-json-migration' LIMIT 1`).get() as Row | undefined;
  if (!lengths || !boundedSize(lengths.char_length, MARKER_MAX_CHARS)
    || !boundedSize(lengths.byte_length, MARKER_MAX_BYTES)) return null;
  const row = database.prepare("SELECT value FROM metadata WHERE key = 'legacy-json-migration' LIMIT 1")
    .get() as Row | undefined;
  if (!row || typeof row.value !== "string" || row.value.length > MARKER_MAX_CHARS
    || Buffer.byteLength(row.value, "utf8") > MARKER_MAX_BYTES) return null;
  const raw = plainRecord(parseJson(row.value));
  if (!raw || !onlyKeys(raw, MARKER_KEYS) || Object.keys(raw).length !== MARKER_KEYS.length
    || raw.status !== "complete" || typeof raw.version !== "string"
    || !/^[A-Za-z0-9._-]{1,32}$/.test(raw.version) || typeof raw.checksum !== "string"
    || !/^[0-9a-f]{64}$/.test(raw.checksum) || raw.sourceIdentity !== "synthetic") return null;
  const importedCount = safeCount(raw.importedCount);
  const quarantinedCount = safeCount(raw.quarantinedCount);
  if (importedCount === null || quarantinedCount === null || !validQuarantine(raw.quarantined, quarantinedCount)) {
    return null;
  }
  return { version: raw.version, checksum: raw.checksum, importedCount };
}

function validQuarantine(value: unknown, count: number): boolean {
  if (!Array.isArray(value) || value.length > TELEGRAM_QUARANTINE_AUDIT_LIMIT || count < value.length) return false;
  return value.every((item) => {
    const row = plainRecord(item);
    return Boolean(row && onlyKeys(row, ["index", "jobId", "reasonCode"])
      && nonNegativeSafeInteger(row.index)
      && (row.jobId === undefined || (typeof row.jobId === "string" && row.jobId.length >= 1
        && row.jobId.length <= ID_MAX_LENGTH))
      && typeof row.reasonCode === "string" && /^[A-Z0-9_]{1,64}$/.test(row.reasonCode));
  });
}

function auditLimit(value: number | undefined): number {
  const limit = value ?? TELEGRAM_QUARANTINE_AUDIT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TELEGRAM_QUARANTINE_AUDIT_LIMIT) {
    throw new Error("Invalid Telegram quarantine audit input");
  }
  return limit;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error();
  return JSON.parse(value) as unknown;
}

function parseJsonRecord(value: unknown): Row {
  const parsed = plainRecord(parseJson(value));
  if (!parsed) throw new Error();
  return parsed;
}

function plainRecord(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Row
    : null;
}

function onlyKeys(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error();
  return value;
}

function lowercaseSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error();
  return value;
}

function timestamp(value: unknown): number {
  return nonNegativeInteger(value);
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error();
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!nonNegativeSafeInteger(value)) throw new Error();
  return value;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeCount(value: unknown): number | null {
  return nonNegativeSafeInteger(value) && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

function boundedSize(value: unknown, maximum: number): boolean {
  return nonNegativeSafeInteger(value) && value <= maximum;
}

function boundedIntegerSql(column: string, alias: string): string {
  return `CASE WHEN typeof(${column}) = 'integer' THEN ${column} ELSE NULL END AS ${alias}`;
}
