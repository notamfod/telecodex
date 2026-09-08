import type Database from "better-sqlite3";

const SCHEMA_VERSION = 8;

const TABLES_V1 = {
  inbox_updates: `CREATE TABLE inbox_updates (
    bot_id TEXT NOT NULL, update_id INTEGER NOT NULL, accepted_at_ms INTEGER NOT NULL,
    source_json TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, PRIMARY KEY (bot_id, update_id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
  jobs: `CREATE TABLE jobs (
    id TEXT PRIMARY KEY, version INTEGER NOT NULL, projection_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
  )`,
  job_events: `CREATE TABLE job_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL, event_at_ms INTEGER NOT NULL, payload_json TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
  metadata: "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  deliveries: `CREATE TABLE deliveries (
    job_id TEXT NOT NULL, part_key TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL,
    telegram_message_id INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER, last_error_code TEXT, updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (job_id, part_key), FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
} as const;

const TABLES_V2 = {
  ...TABLES_V1,
  job_quarantine: `CREATE TABLE job_quarantine (
    job_id TEXT PRIMARY KEY, reason_code TEXT NOT NULL, fingerprint TEXT NOT NULL,
    quarantined_at_ms INTEGER NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
} as const;

const TABLES_V3 = {
  ...TABLES_V2,
  job_event_archive: `CREATE TABLE job_event_archive (
    job_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL, event_at_ms INTEGER NOT NULL,
    PRIMARY KEY (job_id, sequence), FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
} as const;

const TABLES_V4 = {
  ...TABLES_V3,
  job_retry_reservations: `CREATE TABLE job_retry_reservations (
    parent_job_id TEXT PRIMARY KEY, parent_version INTEGER NOT NULL,
    child_job_id TEXT NOT NULL UNIQUE, reserved_at_ms INTEGER NOT NULL,
    FOREIGN KEY (parent_job_id) REFERENCES jobs(id), FOREIGN KEY (child_job_id) REFERENCES jobs(id)
  )`,
} as const;

const TABLES_V5 = {
  ...TABLES_V4,
  retention_file_cleanup: `CREATE TABLE retention_file_cleanup (
    relative_path TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL
  )`,
} as const;

const TABLES_V6 = {
  ...TABLES_V5,
  status_anchor_plans: `CREATE TABLE status_anchor_plans (
    job_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL,
    installed_at_ms INTEGER NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
  status_anchor_plan_bootstrap_eligibility: `CREATE TABLE status_anchor_plan_bootstrap_eligibility (
    job_id TEXT PRIMARY KEY, FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
} as const;

const TABLES_V7 = {
  ...TABLES_V6,
  topic_recoveries: `CREATE TABLE topic_recoveries (
    job_id TEXT PRIMARY KEY, action_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, old_chat_id INTEGER NOT NULL,
    old_message_thread_id INTEGER NOT NULL, new_message_thread_id INTEGER,
    reserved_job_version INTEGER NOT NULL, current_job_version INTEGER NOT NULL,
    next_attempt_at_ms INTEGER, reason_code TEXT,
    started_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
} as const;

const TABLES_V8 = {
  ...TABLES_V7,
  topic_resume_attempts: `CREATE TABLE topic_resume_attempts (
    job_id TEXT PRIMARY KEY, action_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, chat_id INTEGER NOT NULL, message_thread_id INTEGER NOT NULL,
    reserved_job_version INTEGER NOT NULL, current_job_version INTEGER NOT NULL,
    next_attempt_at_ms INTEGER, reason_code TEXT,
    started_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
} as const;

export function initializeTelegramJobSchema(database: Database.Database): void {
  database.transaction(() => {
    const version = database.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) malformed();
    if (version > SCHEMA_VERSION) throw new Error("Unsupported telegram job schema version");
    if (version === 0) {
      if (tableNames(database).length > 0) malformed();
      for (const schema of Object.values(TABLES_V8)) database.exec(schema);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version === 1) {
      validateSchema(database, TABLES_V1);
      database.exec(TABLES_V2.job_quarantine);
      database.exec(TABLES_V3.job_event_archive);
      database.exec(TABLES_V4.job_retry_reservations);
      database.exec(TABLES_V5.retention_file_cleanup);
      migrateStatusAnchorPlans(database);
      database.exec(TABLES_V7.topic_recoveries);
      database.exec(TABLES_V8.topic_resume_attempts);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version === 2) {
      validateSchema(database, TABLES_V2);
      database.exec(TABLES_V3.job_event_archive);
      database.exec(TABLES_V4.job_retry_reservations);
      database.exec(TABLES_V5.retention_file_cleanup);
      migrateStatusAnchorPlans(database);
      database.exec(TABLES_V7.topic_recoveries);
      database.exec(TABLES_V8.topic_resume_attempts);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version === 3) {
      validateSchema(database, TABLES_V3);
      database.exec(TABLES_V4.job_retry_reservations);
      database.exec(TABLES_V5.retention_file_cleanup);
      migrateStatusAnchorPlans(database);
      database.exec(TABLES_V7.topic_recoveries);
      database.exec(TABLES_V8.topic_resume_attempts);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version === 4) {
      validateSchema(database, TABLES_V4);
      database.exec(TABLES_V5.retention_file_cleanup);
      migrateStatusAnchorPlans(database);
      database.exec(TABLES_V7.topic_recoveries);
      database.exec(TABLES_V8.topic_resume_attempts);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version === 5) {
      validateSchema(database, TABLES_V5);
      migrateStatusAnchorPlans(database);
      database.exec(TABLES_V7.topic_recoveries);
      database.exec(TABLES_V8.topic_resume_attempts);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version === 6) {
      validateSchema(database, TABLES_V6);
      database.exec(TABLES_V7.topic_recoveries);
      database.exec(TABLES_V8.topic_resume_attempts);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version === 7) {
      validateSchema(database, TABLES_V7);
      database.exec(TABLES_V8.topic_resume_attempts);
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    validateSchema(database, TABLES_V8);
    database.exec(`CREATE INDEX IF NOT EXISTS inbox_updates_queue_order
      ON inbox_updates (accepted_at_ms, job_id)`);
    database.exec(`CREATE INDEX IF NOT EXISTS job_events_job_sequence
      ON job_events (job_id, sequence)`);
    database.exec(`CREATE INDEX IF NOT EXISTS job_event_archive_job_sequence
      ON job_event_archive (job_id, sequence)`);
  }).immediate();
}

export function validateTelegramJobSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) malformed();
  if (version !== SCHEMA_VERSION) throw new Error("Unsupported telegram job schema version");
  validateSchema(database, TABLES_V8);
}

function migrateStatusAnchorPlans(database: Database.Database): void {
  database.exec(TABLES_V6.status_anchor_plans);
  database.exec(TABLES_V6.status_anchor_plan_bootstrap_eligibility);
  database.exec(`INSERT INTO status_anchor_plan_bootstrap_eligibility (job_id)
    SELECT id FROM jobs`);
}

function validateSchema(database: Database.Database, tables: Readonly<Record<string, string>>): void {
  if (JSON.stringify(tableNames(database)) !== JSON.stringify(Object.keys(tables).sort())) malformed();
  for (const [name, definition] of Object.entries(tables)) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { sql?: unknown } | undefined;
    if (!row || typeof row.sql !== "string" || normalizeSql(row.sql) !== normalizeSql(definition)) malformed();
  }
}

function tableNames(database: Database.Database): string[] {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck().all().map(String);
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/g, " ").replaceAll(/\s*([(),])\s*/g, "$1").trim().toLowerCase();
}

function malformed(): never { throw new Error("Malformed telegram job schema"); }
