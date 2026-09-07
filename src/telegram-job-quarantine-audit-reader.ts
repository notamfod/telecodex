import type Database from "better-sqlite3";

import { TELEGRAM_RESPONSE_PLAN_MAX_PARTS } from "./telegram-job-types.js";

export type TelegramQuarantineAuditRow = Readonly<Record<string, unknown>>;

export interface LoadedTelegramQuarantineCandidateRows {
  readonly row: TelegramQuarantineAuditRow;
  readonly archives: readonly TelegramQuarantineAuditRow[];
  readonly liveEvents: readonly TelegramQuarantineAuditRow[];
  readonly deliveries: readonly TelegramQuarantineAuditRow[];
}

export const TELEGRAM_QUARANTINE_PROJECTION_JSON_MAX_CHARS = 4 * 1024 * 1024;
const PROJECTION_JSON_MAX_BYTES = 8 * 1024 * 1024;
const SOURCE_JSON_MAX_CHARS = 1024 * 1024;
const SOURCE_JSON_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_JSON_MAX_CHARS = 1024 * 1024;
const LIVE_JSON_MAX_BYTES = 4 * 1024 * 1024;
const DELIVERY_JSON_MAX_CHARS = 1024 * 1024;
const DELIVERY_JSON_MAX_BYTES = 4 * 1024 * 1024;
const DELIVERY_ROW_LIMIT = TELEGRAM_RESPONSE_PLAN_MAX_PARTS + 2;
const CRITICAL_DELIVERY_STATES = new Set(["pending", "sending", "uncertain", "failed"]);
const ID_MAX_CHARS = 128;
const ID_MAX_BYTES = ID_MAX_CHARS * 4;
const PART_KEY_MAX_CHARS = 256;
const PART_KEY_MAX_BYTES = PART_KEY_MAX_CHARS * 4;
const DELIVERY_TEXT_MAX_CHARS = 128;
const DELIVERY_TEXT_MAX_BYTES = DELIVERY_TEXT_MAX_CHARS * 4;

export function prepareTelegramQuarantineCandidateReader(database: Database.Database): (
  row: TelegramQuarantineAuditRow,
) => { readonly rows: LoadedTelegramQuarantineCandidateRows | null; readonly criticalDeliveries: number } {
  const projectionLengths = database.prepare(`SELECT length(projection_json) AS char_length,
    length(CAST(projection_json AS BLOB)) AS byte_length FROM jobs WHERE id = ? LIMIT 1`);
  const projectionBody = database.prepare("SELECT projection_json FROM jobs WHERE id = ? LIMIT 1");
  const sourceLengths = database.prepare(`SELECT length(source_json) AS char_length,
    length(CAST(source_json AS BLOB)) AS byte_length FROM inbox_updates WHERE job_id = ? LIMIT 1`);
  const sourceBody = database.prepare("SELECT source_json FROM inbox_updates WHERE job_id = ? LIMIT 1");
  const archives = database.prepare(`SELECT ${boundedIntegerSql("sequence", "sequence")},
    ${boundedTextSql("job_id", "job_id", ID_MAX_CHARS, ID_MAX_BYTES)},
    ${boundedTextSql("event_id", "event_id", ID_MAX_CHARS, ID_MAX_BYTES)},
    event_type = 'update.accepted' AS event_type_is_accepted,
    event_type = 'job.terminal' AS event_type_is_terminal,
    ${boundedIntegerSql("event_at_ms", "event_at_ms")}
    FROM job_event_archive WHERE job_id = ? ORDER BY sequence LIMIT 3`);
  const live = database.prepare(`SELECT ${boundedIntegerSql("sequence", "sequence")},
    ${boundedTextSql("job_id", "job_id", ID_MAX_CHARS, ID_MAX_BYTES)},
    ${boundedTextSql("event_id", "event_id", ID_MAX_CHARS, ID_MAX_BYTES)},
    event_type = 'reconciliation.decided' AS event_type_is_reconciliation,
    ${boundedIntegerSql("event_at_ms", "event_at_ms")},
    length(payload_json) AS payload_char_length,
    length(CAST(payload_json AS BLOB)) AS payload_byte_length
    FROM job_events WHERE job_id = ? ORDER BY sequence LIMIT 2`);
  const liveBody = database.prepare(
    "SELECT payload_json FROM job_events WHERE job_id = ? AND sequence = ? LIMIT 1",
  );
  const deliveries = database.prepare(`SELECT
    ${boundedTextSql("job_id", "job_id", ID_MAX_CHARS, ID_MAX_BYTES)},
    ${boundedTextSql("part_key", "part_key", PART_KEY_MAX_CHARS, PART_KEY_MAX_BYTES)},
    ${boundedIntegerSql("ordinal", "ordinal")},
    ${boundedTextSql("kind", "kind", DELIVERY_TEXT_MAX_CHARS, DELIVERY_TEXT_MAX_BYTES)},
    CASE WHEN state IN ('pending', 'sending', 'delivered', 'uncertain', 'failed')
      THEN state ELSE NULL END AS state,
    length(payload_json) AS payload_char_length,
    length(CAST(payload_json AS BLOB)) AS payload_byte_length,
    CASE WHEN typeof(content_hash) = 'text' AND length(content_hash) = 64
      AND length(CAST(content_hash AS BLOB)) = 64
      AND content_hash NOT GLOB '*[^0-9a-f]*' THEN content_hash ELSE NULL END AS content_hash,
    ${nullableIntegerSql("telegram_message_id", "telegram_message_id")},
    ${boundedIntegerSql("attempt_count", "attempt_count")},
    ${nullableIntegerSql("next_attempt_at_ms", "next_attempt_at_ms")},
    CASE WHEN last_error_code IS NULL THEN NULL
      WHEN typeof(last_error_code) = 'text' AND length(last_error_code) BETWEEN 1 AND ${DELIVERY_TEXT_MAX_CHARS}
        AND length(CAST(last_error_code AS BLOB)) BETWEEN 1 AND ${DELIVERY_TEXT_MAX_BYTES}
      THEN last_error_code ELSE 0 END AS last_error_code,
    ${boundedIntegerSql("updated_at_ms", "updated_at_ms")}
    FROM deliveries WHERE job_id = ? ORDER BY ordinal, part_key
    LIMIT ${DELIVERY_ROW_LIMIT}`);
  const deliveryBody = database.prepare(
    "SELECT payload_json FROM deliveries WHERE job_id = ? AND part_key = ? LIMIT 1",
  );
  return (row) => loadCandidateRows(row, {
    projectionLengths, projectionBody, sourceLengths, sourceBody, archives,
    live, liveBody, deliveries, deliveryBody,
  });
}

interface Statements {
  readonly projectionLengths: Database.Statement;
  readonly projectionBody: Database.Statement;
  readonly sourceLengths: Database.Statement;
  readonly sourceBody: Database.Statement;
  readonly archives: Database.Statement;
  readonly live: Database.Statement;
  readonly liveBody: Database.Statement;
  readonly deliveries: Database.Statement;
  readonly deliveryBody: Database.Statement;
}

function loadCandidateRows(
  row: TelegramQuarantineAuditRow,
  statements: Statements,
): { readonly rows: LoadedTelegramQuarantineCandidateRows | null; readonly criticalDeliveries: number } {
  const projection = boundedBody(statements.projectionLengths, statements.projectionBody,
    [row.job_id], [row.job_id], "projection_json",
    TELEGRAM_QUARANTINE_PROJECTION_JSON_MAX_CHARS, PROJECTION_JSON_MAX_BYTES);
  const source = boundedBody(statements.sourceLengths, statements.sourceBody,
    [row.job_id], [row.job_id], "source_json", SOURCE_JSON_MAX_CHARS, SOURCE_JSON_MAX_BYTES);
  const archives = statements.archives.all(row.job_id) as TelegramQuarantineAuditRow[];
  const liveMetadata = statements.live.all(row.job_id) as TelegramQuarantineAuditRow[];
  const deliveryMetadata = statements.deliveries.all(row.job_id) as TelegramQuarantineAuditRow[];
  const criticalDeliveries = deliveryMetadata.filter((delivery) =>
    typeof delivery.state === "string" && CRITICAL_DELIVERY_STATES.has(delivery.state)).length;
  if (projection === null || source === null || archives.length > 2 || liveMetadata.length !== 1
    || deliveryMetadata.length > TELEGRAM_RESPONSE_PLAN_MAX_PARTS + 1) {
    return { rows: null, criticalDeliveries };
  }
  const liveRow = liveMetadata[0]!;
  if (!boundedLengths(liveRow, "payload", LIVE_JSON_MAX_CHARS, LIVE_JSON_MAX_BYTES)) {
    return { rows: null, criticalDeliveries };
  }
  const livePayload = bodyValue(
    statements.liveBody.get(row.job_id, liveRow.sequence) as TelegramQuarantineAuditRow | undefined,
    "payload_json", LIVE_JSON_MAX_CHARS, LIVE_JSON_MAX_BYTES,
  );
  if (livePayload === null || deliveryMetadata.some((delivery) =>
    !boundedLengths(delivery, "payload", DELIVERY_JSON_MAX_CHARS, DELIVERY_JSON_MAX_BYTES))) {
    return { rows: null, criticalDeliveries };
  }
  const deliveryRows: TelegramQuarantineAuditRow[] = [];
  for (const delivery of deliveryMetadata) {
    const body = bodyValue(
      statements.deliveryBody.get(row.job_id, delivery.part_key) as TelegramQuarantineAuditRow | undefined,
      "payload_json", DELIVERY_JSON_MAX_CHARS, DELIVERY_JSON_MAX_BYTES,
    );
    if (body === null) return { rows: null, criticalDeliveries };
    let payloadIsNull = false;
    try { payloadIsNull = JSON.parse(body) === null; } catch { return { rows: null, criticalDeliveries }; }
    deliveryRows.push({ ...delivery, payload_is_null: payloadIsNull });
  }
  return { rows: {
    row: { ...row, projection_json: projection, inbox_source_json: source }, archives,
    liveEvents: [{ ...liveRow, payload_json: livePayload }], deliveries: deliveryRows,
  }, criticalDeliveries };
}

function boundedBody(
  lengthStatement: Database.Statement,
  bodyStatement: Database.Statement,
  lengthParameters: readonly unknown[],
  bodyParameters: readonly unknown[],
  column: string,
  maximumChars: number,
  maximumBytes: number,
): string | null {
  const lengths = lengthStatement.get(...lengthParameters) as TelegramQuarantineAuditRow | undefined;
  if (!boundedLengths(lengths, "", maximumChars, maximumBytes)) return null;
  return bodyValue(bodyStatement.get(...bodyParameters) as TelegramQuarantineAuditRow | undefined,
    column, maximumChars, maximumBytes);
}

function boundedLengths(
  row: TelegramQuarantineAuditRow | undefined,
  prefix: "" | "payload",
  maximumChars: number,
  maximumBytes: number,
): boolean {
  const charLength = row?.[prefix ? `${prefix}_char_length` : "char_length"];
  const byteLength = row?.[prefix ? `${prefix}_byte_length` : "byte_length"];
  return safeNonNegative(charLength) && charLength <= maximumChars
    && safeNonNegative(byteLength) && byteLength <= maximumBytes;
}

function bodyValue(
  row: TelegramQuarantineAuditRow | undefined,
  column: string,
  maximumChars: number,
  maximumBytes: number,
): string | null {
  const value = row?.[column];
  return typeof value === "string" && value.length <= maximumChars
    && Buffer.byteLength(value, "utf8") <= maximumBytes ? value : null;
}

function safeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedTextSql(column: string, alias: string, maximumChars: number, maximumBytes: number): string {
  return `CASE WHEN typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND ${maximumChars}
    AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${maximumBytes}
    THEN ${column} ELSE NULL END AS ${alias}`;
}

function boundedIntegerSql(column: string, alias: string): string {
  return `CASE WHEN typeof(${column}) = 'integer' THEN ${column} ELSE NULL END AS ${alias}`;
}

function nullableIntegerSql(column: string, alias: string): string {
  return `${boundedIntegerSql(column, alias)},
    typeof(${column}) IN ('integer', 'null') AS ${alias}_type_valid`;
}
