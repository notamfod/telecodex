import type { TelegramSourceKey } from "./telegram-job-types.js";

export interface SyntheticMigrationProof {
  readonly version: string;
  readonly checksum: string;
  readonly sourceIdentity: "synthetic";
  readonly ordinal: number;
}

/**
 * SQL equivalent of readSyntheticMigrationProof for queries joining jobs to
 * inbox_updates with those exact table names.
 */
export const SYNTHETIC_MIGRATION_PROOF_WHERE = `(CASE
  WHEN json_valid(inbox_updates.source_json) THEN (
    length(inbox_updates.bot_id) = 79
    AND substr(inbox_updates.bot_id, 1, 15) = 'legacy-json-v1:'
    AND substr(inbox_updates.bot_id, 16) NOT GLOB '*[^0-9a-f]*'
    AND json_type(inbox_updates.source_json, '$.migration') = 'object'
    AND (SELECT count(*) FROM json_each(inbox_updates.source_json, '$.migration')) = 4
    AND NOT EXISTS (
      SELECT 1 FROM json_each(inbox_updates.source_json, '$.migration')
      WHERE key NOT IN ('version', 'checksum', 'sourceIdentity', 'ordinal')
    )
    AND json_type(inbox_updates.source_json, '$.migration.version') = 'text'
    AND length(json_extract(inbox_updates.source_json, '$.migration.version')) BETWEEN 1 AND 32
    AND json_extract(inbox_updates.source_json, '$.migration.version')
      NOT GLOB '*[^A-Za-z0-9._-]*'
    AND json_type(inbox_updates.source_json, '$.migration.checksum') = 'text'
    AND json_extract(inbox_updates.source_json, '$.migration.checksum')
      = substr(inbox_updates.bot_id, 16)
    AND json_type(inbox_updates.source_json, '$.migration.sourceIdentity') = 'text'
    AND json_extract(inbox_updates.source_json, '$.migration.sourceIdentity') = 'synthetic'
    AND json_type(inbox_updates.source_json, '$.migration.ordinal') = 'integer'
    AND json_extract(inbox_updates.source_json, '$.migration.ordinal') >= 0
    AND json_extract(inbox_updates.source_json, '$.migration.ordinal') = inbox_updates.update_id
    AND json_type(jobs.projection_json, '$.source.botId') = 'text'
    AND json_extract(jobs.projection_json, '$.source.botId') = inbox_updates.bot_id
    AND json_type(jobs.projection_json, '$.source.updateId') = 'integer'
    AND json_extract(jobs.projection_json, '$.source.updateId') = inbox_updates.update_id
  ) ELSE 0 END)`;

export function readSyntheticMigrationProof(
  sourcePayload: unknown,
  source: TelegramSourceKey,
): SyntheticMigrationProof | null {
  const payload = record(sourcePayload);
  const migration = record(payload?.migration);
  if (!migration || !onlyKeys(migration, ["version", "checksum", "sourceIdentity", "ordinal"])) {
    return null;
  }
  const match = /^legacy-json-v1:([0-9a-f]{64})$/.exec(source.botId);
  if (!match || typeof migration.version !== "string"
    || !/^[A-Za-z0-9._-]{1,32}$/.test(migration.version)
    || migration.checksum !== match[1] || migration.sourceIdentity !== "synthetic"
    || migration.ordinal !== source.updateId || !nonNegativeInteger(migration.ordinal)) {
    return null;
  }
  return {
    version: migration.version,
    checksum: match[1],
    sourceIdentity: "synthetic",
    ordinal: source.updateId,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
