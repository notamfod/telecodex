import type Database from "better-sqlite3";

const SCHEMA_VERSION = 2;
const VERSION_ONE_ALERTS_DEFINITION = `CREATE TABLE alerts (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 22 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
    thread_id TEXT NOT NULL CHECK(length(thread_id) > 0), turn_id TEXT NOT NULL CHECK(length(turn_id) > 0),
    fingerprint_updated_at REAL NOT NULL CHECK(fingerprint_updated_at >= 0),
    item_count INTEGER NOT NULL CHECK(typeof(item_count) = 'integer' AND item_count >= 0),
    last_item_type TEXT CHECK(last_item_type IS NULL OR length(last_item_type) > 0),
    route_chat_id INTEGER NOT NULL CHECK(typeof(route_chat_id) = 'integer' AND route_chat_id != 0 AND abs(route_chat_id) <= 4503599627370495),
    route_message_thread_id INTEGER CHECK(route_message_thread_id IS NULL OR (typeof(route_message_thread_id) = 'integer' AND route_message_thread_id > 0 AND route_message_thread_id <= 2147483647)),
    delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','failed','delivered')),
    delivery_message_id INTEGER,
    status_delivery_state TEXT NOT NULL DEFAULT 'none' CHECK(status_delivery_state IN ('none','pending','failed','delivered')),
    state TEXT NOT NULL CHECK(state IN ('open','checking','restored','self-recovered','observation-only','repair-disabled','expired','failed')),
    detail TEXT, created_at REAL NOT NULL CHECK(created_at >= 0),
    CHECK((delivery_state = 'delivered' AND typeof(delivery_message_id) = 'integer' AND delivery_message_id > 0 AND delivery_message_id <= 2147483647) OR (delivery_state IN ('pending','failed') AND delivery_message_id IS NULL)),
    CHECK((status_delivery_state = 'none' AND (delivery_state != 'delivered' OR state IN ('open','checking'))) OR (status_delivery_state IN ('pending','failed','delivered') AND delivery_state = 'delivered' AND state IN ('restored','self-recovered','observation-only','repair-disabled','expired','failed')))
  ) STRICT`;
const TABLE_DEFINITIONS = {
  observations: `CREATE TABLE observations (
    thread_id TEXT PRIMARY KEY NOT NULL CHECK(length(thread_id) > 0),
    turn_id TEXT NOT NULL CHECK(length(turn_id) > 0),
    fingerprint_updated_at REAL NOT NULL CHECK(fingerprint_updated_at >= 0),
    item_count INTEGER NOT NULL CHECK(typeof(item_count) = 'integer' AND item_count >= 0),
    last_item_type TEXT CHECK(last_item_type IS NULL OR length(last_item_type) > 0),
    first_observed_at REAL NOT NULL CHECK(first_observed_at >= 0), last_observed_at REAL NOT NULL CHECK(last_observed_at >= 0),
    unchanged_count INTEGER NOT NULL CHECK(typeof(unchanged_count) = 'integer' AND unchanged_count >= 1),
    CHECK(first_observed_at <= last_observed_at)
  ) STRICT`,
  alerts: VERSION_ONE_ALERTS_DEFINITION.replace(
    "detail TEXT, created_at REAL NOT NULL CHECK(created_at >= 0),",
    `detail TEXT, created_at REAL NOT NULL CHECK(created_at >= 0),
    thread_name TEXT CHECK(thread_name IS NULL OR (length(thread_name) > 0 AND length(thread_name) <= 512)),`,
  ),
  repair_attempts: `CREATE TABLE repair_attempts (
    alert_id TEXT PRIMARY KEY NOT NULL REFERENCES alerts(id),
    claim_token TEXT NOT NULL CHECK(length(claim_token) = 22 AND claim_token NOT GLOB '*[^A-Za-z0-9_-]*'), started_at REAL NOT NULL CHECK(started_at >= 0),
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('restored','self-recovered','observation-only','repair-disabled','expired','failed')),
    detail TEXT, finished_at REAL CHECK(finished_at IS NULL OR finished_at >= 0),
    CHECK((outcome IS NULL AND finished_at IS NULL) OR (outcome IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at))
  ) STRICT`,
} as const;
const ALERT_INDEX_DEFINITION =
  "CREATE UNIQUE INDEX alerts_thread_turn_unique ON alerts(thread_id, turn_id)";

export function initializeAndValidateGuardianSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("Malformed guardian schema: invalid user_version");
  }
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported guardian schema version: ${version}`);
  const tables = userTableNames(database);
  if (version === 0) {
    if (tables.length > 0) {
      throw new Error("Malformed guardian schema: unversioned database is not empty");
    }
    const initialize = database.transaction(() => {
      for (const definition of Object.values(TABLE_DEFINITIONS)) database.exec(definition);
      database.exec(ALERT_INDEX_DEFINITION);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();
  } else if (version === 1) {
    validateSchema(database, { ...TABLE_DEFINITIONS, alerts: VERSION_ONE_ALERTS_DEFINITION }, 1);
    const migrate = database.transaction(() => {
      database.exec(`ALTER TABLE alerts ADD COLUMN thread_name TEXT CHECK(
        thread_name IS NULL OR (length(thread_name) > 0 AND length(thread_name) <= 512)
      )`);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    migrate.immediate();
  }
  validateSchema(database, TABLE_DEFINITIONS, SCHEMA_VERSION);
}

function validateSchema(database: Database.Database,
  definitions: Readonly<Record<string, string>>, version: number): void {
  const expectedTables = Object.keys(definitions).sort();
  if (JSON.stringify(userTableNames(database)) !== JSON.stringify(expectedTables)) {
    throw new Error(`Malformed guardian schema: table set does not match version ${version}`);
  }
  for (const [name, definition] of Object.entries(definitions)) {
    const row = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name);
    if (!isRecord(row) || typeof row.sql !== "string"
      || normalizeSql(row.sql) !== normalizeSql(definition)) {
      throw new Error(`Malformed guardian schema: ${name} definition does not match version ${version}`);
    }
  }
  const index = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'alerts_thread_turn_unique'",
  ).get();
  if (!isRecord(index) || typeof index.sql !== "string"
    || normalizeSql(index.sql) !== normalizeSql(ALERT_INDEX_DEFINITION)) {
    throw new Error(`Malformed guardian schema: alert uniqueness does not match version ${version}`);
  }
}

function userTableNames(database: Database.Database): string[] {
  return database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).pluck().all().map(String);
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/g, " ").replaceAll(/\s*([(),])\s*/g, "$1").trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
