import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BATCH_ID = /^[0-9a-f]{24}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT = 64 * 1024;
const MAX_JSON = 256 * 1024;
const MAX_EVENTS = 64;

export interface JournalSession {
  batchId: string;
  title: string;
  cwd: string;
  threadId?: string;
  creationState?: "creating" | "unknown";
  pending?: { key: string; eventIds: number[]; text: string; state: "prepared" | "written" };
}
export interface JournalEvent { id: number; key: string; text: string; }
type SessionRow = { key: string; payload: string };
type EventRow = { id: number; key: string; text: string };

function valid(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid review pipeline journal data"); }
function text(value: unknown): asserts value is string { valid(typeof value === "string" && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= MAX_TEXT); }
function batchId(value: unknown): asserts value is string { valid(typeof value === "string" && BATCH_ID.test(value)); }
function title(value: unknown): asserts value is string { valid(typeof value === "string" && value.length > 0 && value.length <= 512); }
function cwd(value: unknown): asserts value is string { valid(typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value)); }
function eventKey(value: unknown): asserts value is string { valid(typeof value === "string" && value.length > 0 && value.length <= 256); }
function validateSession(value: unknown): asserts value is JournalSession {
  valid(value !== null && typeof value === "object" && !Array.isArray(value)); const session = value as Record<string, unknown>;
  valid(Object.keys(session).every((key) => ["batchId", "title", "cwd", "threadId", "creationState", "pending"].includes(key)));
  batchId(session.batchId); title(session.title); cwd(session.cwd);
  valid(session.threadId === undefined || typeof session.threadId === "string" && THREAD_ID.test(session.threadId));
  valid(session.creationState === undefined || session.creationState === "creating" || session.creationState === "unknown");
  valid(session.threadId === undefined || session.creationState === undefined);
  if (session.pending !== undefined) {
    valid(session.pending !== null && typeof session.pending === "object" && !Array.isArray(session.pending)); const pending = session.pending as Record<string, unknown>;
    valid(Object.keys(pending).every((key) => ["key", "eventIds", "text", "state"].includes(key))); eventKey(pending.key); text(pending.text);
    valid((pending.state === "prepared" || pending.state === "written") && Array.isArray(pending.eventIds) && pending.eventIds.length > 0 && pending.eventIds.length <= MAX_EVENTS && pending.eventIds.every((id) => Number.isSafeInteger(id) && (id as number) > 0) && new Set(pending.eventIds).size === pending.eventIds.length);
  }
}
function decodeSession(row: SessionRow): JournalSession { valid(Buffer.byteLength(row.payload) <= MAX_JSON); const session: JournalSession = JSON.parse(row.payload); validateSession(session); valid(session.batchId === row.key); return session; }
function decodeEvent(row: EventRow): JournalEvent { valid(Number.isSafeInteger(row.id) && row.id > 0); eventKey(row.key); text(row.text); return row; }

export class ReviewPipelineJournalStore {
  private readonly database: Database.Database;
  constructor(file: string) {
    cwd(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const fd = openSync(file, "a", 0o600);
    try { chmodSync(file, 0o600); } finally { closeSync(fd); }
    this.database = new Database(file);
    try { this.database.pragma("journal_mode = WAL"); this.database.pragma("busy_timeout = 1000"); this.database.transaction(() => {
      const version = this.database.pragma("user_version", { simple: true }); valid(version === 0 || version === 1);
      if (version === 0) { this.database.exec("CREATE TABLE journal_sessions (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL); CREATE TABLE journal_events (id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, event_key TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(batch_id, event_key))"); this.database.pragma("user_version = 1"); }
      for (const row of this.database.prepare("SELECT id AS key, payload FROM journal_sessions").all() as SessionRow[]) decodeSession(row);
    }).immediate(); } catch (error) { this.database.close(); throw error; }
  }
  close(): void { if (this.database.open) this.database.close(); }
  ensureSession(id: string, sessionTitle: string, sessionCwd: string): JournalSession {
    batchId(id); title(sessionTitle); cwd(sessionCwd);
    return this.database.transaction(() => {
      const row = this.row(id); if (row) return decodeSession(row);
      const session: JournalSession = { batchId: id, title: sessionTitle, cwd: sessionCwd }; this.insertSession(session); return session;
    }).immediate();
  }
  sessions(): JournalSession[] { return (this.database.prepare("SELECT id AS key, payload FROM journal_sessions ORDER BY id").all() as SessionRow[]).map(decodeSession); }
  claimSession(id: string): boolean {
    batchId(id); return this.database.transaction(() => {
      const session = this.session(id); if (session.threadId !== undefined || session.creationState !== undefined) return false;
      this.saveSession({ ...session, creationState: "creating" }); return true;
    }).immediate();
  }
  attachSession(id: string, threadId: string): void {
    batchId(id); valid(typeof threadId === "string" && THREAD_ID.test(threadId)); this.database.transaction(() => {
      const session = this.session(id); valid(session.threadId === undefined || session.threadId === threadId);
      const { creationState: _creationState, ...withoutState } = session; this.saveSession({ ...withoutState, threadId });
    }).immediate();
  }
  failSession(id: string, definitive: boolean): void {
    batchId(id); valid(typeof definitive === "boolean"); this.database.transaction(() => {
      const session = this.session(id); if (session.creationState === undefined) return;
      const { creationState: _creationState, ...withoutState } = session;
      this.saveSession(definitive ? withoutState : { ...withoutState, creationState: "unknown" });
    }).immediate();
  }
  recoverCreations(): void {
    this.database.transaction(() => {
      for (const row of this.database.prepare("SELECT id AS key, payload FROM journal_sessions").all() as SessionRow[]) {
        const session = decodeSession(row); if (session.creationState === "creating") this.saveSession({ ...session, creationState: "unknown" });
      }
    }).immediate();
  }
  appendEvent(id: string, key: string, value: string): void { batchId(id); eventKey(key); text(value); this.database.transaction(() => { this.session(id); this.database.prepare("INSERT INTO journal_events(batch_id, event_key, text) VALUES (?, ?, ?) ON CONFLICT(batch_id, event_key) DO NOTHING").run(id, key, value); }).immediate(); }
  hasEvent(id: string, key: string): boolean { batchId(id); eventKey(key); return this.database.prepare("SELECT 1 FROM journal_events WHERE batch_id = ? AND event_key = ?").get(id, key) !== undefined; }
  pendingEvents(id: string, limit = 8): JournalEvent[] { batchId(id); valid(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_EVENTS); return (this.database.prepare("SELECT id, event_key AS key, text FROM journal_events WHERE batch_id = ? AND delivered = 0 ORDER BY id LIMIT ?").all(id, limit) as EventRow[]).map(decodeEvent); }
  prepareAppend(id: string, key: string, eventIds: number[], value: string): JournalSession {
    batchId(id); eventKey(key); text(value); valid(Array.isArray(eventIds) && eventIds.length > 0 && eventIds.length <= MAX_EVENTS && eventIds.every((eventId) => Number.isSafeInteger(eventId) && eventId > 0) && new Set(eventIds).size === eventIds.length);
    return this.database.transaction(() => {
      const session = this.session(id);
      if (session.pending !== undefined && (session.pending.state !== "prepared" || session.pending.key !== key)) return session;
      const placeholders = eventIds.map(() => "?").join(","); const rows = this.database.prepare(`SELECT id FROM journal_events WHERE batch_id = ? AND delivered = 0 AND id IN (${placeholders})`).all(id, ...eventIds) as Array<{ id: number }>;
      valid(rows.length === eventIds.length); const next: JournalSession = { ...session, pending: { key, eventIds: [...eventIds], text: value, state: "prepared" } }; this.saveSession(next); return next;
    }).immediate();
  }
  markWritten(id: string): void { batchId(id); this.database.transaction(() => { const session = this.session(id); valid(session.pending !== undefined); if (session.pending.state === "prepared") this.saveSession({ ...session, pending: { ...session.pending, state: "written" } }); }).immediate(); }
  /** Call only after App Server conclusively reports that the append was not accepted. */
  resetAppend(id: string): void { batchId(id); this.database.transaction(() => { const session = this.session(id); valid(session.pending !== undefined && session.pending.state === "written"); this.saveSession({ ...session, pending: { ...session.pending, state: "prepared" } }); }).immediate(); }
  acknowledgeAppend(id: string): void { batchId(id); this.database.transaction(() => { const session = this.session(id); valid(session.pending !== undefined && session.pending.state === "written"); const { pending, ...withoutPending } = session; const placeholders = pending.eventIds.map(() => "?").join(","); const changed = this.database.prepare(`UPDATE journal_events SET delivered = 1 WHERE batch_id = ? AND delivered = 0 AND id IN (${placeholders})`).run(id, ...pending.eventIds); valid(changed.changes === pending.eventIds.length); this.saveSession(withoutPending); }).immediate(); }
  private row(id: string): SessionRow | undefined { return this.database.prepare("SELECT id AS key, payload FROM journal_sessions WHERE id = ?").get(id) as SessionRow | undefined; }
  private session(id: string): JournalSession { const row = this.row(id); valid(row); return decodeSession(row); }
  private insertSession(session: JournalSession): void { validateSession(session); this.database.prepare("INSERT INTO journal_sessions(id, payload) VALUES (?, ?)").run(session.batchId, JSON.stringify(session)); }
  private saveSession(session: JournalSession): void { validateSession(session); this.database.prepare("UPDATE journal_sessions SET payload = ? WHERE id = ?").run(JSON.stringify(session), session.batchId); }
}
