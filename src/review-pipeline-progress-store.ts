import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PortfolioProjectResult } from "./review-portfolio.js";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROJECT = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
const JOB_ID = /^[0-9a-f]{24}$/;
const MAX_JSON = 256 * 1024;

export interface ProgressEvent { projectPath: string; after: string; before?: string; }
export interface ProgressBatch {
  id: string;
  events: ProgressEvent[];
  target: { chatId: number; messageThreadId: number };
  messageId?: number;
  deliveredText?: string;
  finished?: boolean;
  sendState?: "sending" | "unknown";
}
export interface ProgressRange {
  phase: "reviewing" | "reviewed" | "failed";
  chunk?: number;
  totalChunks?: number;
  result?: PortfolioProjectResult;
}
type Row = { key: string; payload: string };

function valid(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid review pipeline progress data"); }
function positive(value: unknown): asserts value is number { valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0); }
function absolute(value: unknown): asserts value is string { valid(typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value)); }
function eventKey(event: ProgressEvent): string { return `${event.projectPath}\0${event.before ?? ""}\0${event.after}`; }
function validateEvent(value: unknown): asserts value is ProgressEvent {
  valid(value !== null && typeof value === "object" && !Array.isArray(value)); const event = value as Record<string, unknown>;
  valid(Object.keys(event).every((key) => ["projectPath", "after", "before"].includes(key)) && typeof event.projectPath === "string" && PROJECT.test(event.projectPath) && !event.projectPath.split("/").includes(".."));
  valid(typeof event.after === "string" && SHA.test(event.after) && !/^0+$/.test(event.after));
  valid(event.before === undefined || typeof event.before === "string" && SHA.test(event.before));
}
function validateResult(value: unknown, event: ProgressEvent): asserts value is PortfolioProjectResult {
  valid(value !== null && typeof value === "object" && !Array.isArray(value)); const result = value as Record<string, unknown>;
  valid(typeof result.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(result.name)); absolute(result.sourcePath);
  valid(result.worktreePath === undefined || (typeof result.worktreePath === "string" && path.isAbsolute(result.worktreePath) && result.worktreePath.length <= 4096));
  valid(result.status === "reviewed" && result.name === path.posix.basename(event.projectPath) && result.headSha === event.after && (result.baseSha === undefined || typeof result.baseSha === "string" && SHA.test(result.baseSha)));
  valid(Array.isArray(result.findings) && result.findings.length <= 10_000 && result.findings.every(validateFinding) && (result.changedFiles === undefined || Array.isArray(result.changedFiles) && result.changedFiles.length <= 10_000 && result.changedFiles.every((file) => typeof file === "string" && file.length > 0 && file.length <= 1024 && !path.posix.isAbsolute(file) && !file.split("/").includes(".."))));
}
function validateFinding(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  if (!Object.keys(finding).every((key) => ["severity", "priority", "aspect", "file", "line", "category", "description", "author", "commitSha", "commitUrl"].includes(key))) return false;
  if (!["critical", "high", "medium", "low"].includes(finding.severity as string) || typeof finding.file !== "string" || finding.file.length === 0 || finding.file.length > 1024 || path.posix.isAbsolute(finding.file) || finding.file.split("/").includes("..") || typeof finding.category !== "string" || finding.category.length === 0 || finding.category.length > 256 || typeof finding.description !== "string" || finding.description.length === 0 || finding.description.length > 2048) return false;
  return finding.line === undefined || typeof finding.line === "number" && Number.isSafeInteger(finding.line) && finding.line > 0;
}
function validateRange(value: unknown, event: ProgressEvent): asserts value is ProgressRange {
  valid(value !== null && typeof value === "object" && !Array.isArray(value)); const range = value as Record<string, unknown>;
  valid(Object.keys(range).every((key) => ["phase", "chunk", "totalChunks", "result"].includes(key)));
  valid(range.phase === "reviewing" || range.phase === "reviewed" || range.phase === "failed");
  if (range.phase === "reviewing") { valid(range.result === undefined); if (range.chunk !== undefined) positive(range.chunk); if (range.totalChunks !== undefined) positive(range.totalChunks); valid(range.chunk === undefined || range.totalChunks === undefined || range.chunk <= range.totalChunks); }
  else if (range.phase === "reviewed") { valid(range.chunk === undefined && range.totalChunks === undefined); validateResult(range.result, event); }
  else valid(range.chunk === undefined && range.totalChunks === undefined && range.result === undefined);
}
function validateBatch(value: unknown): asserts value is ProgressBatch {
  valid(value !== null && typeof value === "object" && !Array.isArray(value)); const batch = value as Record<string, unknown>;
  valid(Object.keys(batch).every((key) => ["id", "events", "target", "messageId", "deliveredText", "finished", "sendState"].includes(key)) && typeof batch.id === "string" && /^[0-9a-f]{24}$/.test(batch.id));
  valid(Array.isArray(batch.events) && batch.events.length > 0 && batch.events.length <= 30); for (const event of batch.events) validateEvent(event);
  valid(batch.target !== null && typeof batch.target === "object" && !Array.isArray(batch.target)); const target = batch.target as Record<string, unknown>;
  valid(Object.keys(target).length === 2 && typeof target.chatId === "number" && Number.isSafeInteger(target.chatId) && target.chatId !== 0); positive(target.messageThreadId);
  valid(batch.messageId === undefined || typeof batch.messageId === "number" && Number.isSafeInteger(batch.messageId) && batch.messageId > 0);
  valid(batch.deliveredText === undefined || typeof batch.deliveredText === "string" && batch.deliveredText.length <= 4096); valid(batch.finished === undefined || typeof batch.finished === "boolean");
  valid(batch.sendState === undefined || batch.sendState === "sending" || batch.sendState === "unknown");
  valid(batch.messageId === undefined || batch.sendState === undefined);
}
function decodeBatch(row: Row): ProgressBatch { valid(row.payload.length <= MAX_JSON); const batch: ProgressBatch = JSON.parse(row.payload); validateBatch(batch); valid(batch.id === row.key); return batch; }
function decodeRange(row: Row, event: ProgressEvent): ProgressRange { valid(row.payload.length <= MAX_JSON); const range: ProgressRange = JSON.parse(row.payload); validateRange(range, event); return range; }

export class ReviewPipelineProgressStore {
  private readonly database: Database.Database;
  constructor(file: string) {
    absolute(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const fd = openSync(file, "a", 0o600);
    try { chmodSync(file, 0o600); } finally { closeSync(fd); }
    this.database = new Database(file);
    try { this.database.pragma("journal_mode = WAL"); this.database.pragma("busy_timeout = 1000"); this.database.transaction(() => {
      const version = this.database.pragma("user_version", { simple: true }); valid(version === 0 || version === 1);
      if (version === 0) { this.database.exec("CREATE TABLE progress_batches (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL); CREATE TABLE progress_ranges (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL); CREATE TABLE progress_agents (id TEXT PRIMARY KEY NOT NULL, phase TEXT NOT NULL)"); this.database.pragma("user_version = 1"); }
      for (const row of this.database.prepare("SELECT id AS key, payload FROM progress_batches").all() as Row[]) decodeBatch(row);
    }).immediate(); } catch (error) { this.database.close(); throw error; }
  }
  close(): void { if (this.database.open) this.database.close(); }
  trackBatch(events: readonly ProgressEvent[], target: { chatId: number; messageThreadId: number }): ProgressBatch {
    valid(Array.isArray(events) && events.length > 0 && events.length <= 30); events.forEach(validateEvent); valid(Number.isSafeInteger(target.chatId) && target.chatId !== 0); positive(target.messageThreadId);
    const canonical = [...events].map(eventKey).sort().join("\n") + `\n${target.chatId}:${target.messageThreadId}`;
    const id = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
    return this.database.transaction(() => { const row = this.database.prepare("SELECT id AS key, payload FROM progress_batches WHERE id = ?").get(id) as Row | undefined; if (row) return decodeBatch(row); const batch: ProgressBatch = { id, events: events.map(event => ({ ...event })), target: { ...target } }; validateBatch(batch); this.database.prepare("INSERT INTO progress_batches(id, payload) VALUES (?, ?)").run(id, JSON.stringify(batch)); return batch; }).immediate();
  }
  listBatches(): ProgressBatch[] { return (this.database.prepare("SELECT id AS key, payload FROM progress_batches ORDER BY id").all() as Row[]).map(decodeBatch); }
  claimMessage(id: string): boolean {
    valid(/^[0-9a-f]{24}$/.test(id));
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT id AS key, payload FROM progress_batches WHERE id = ?").get(id) as Row | undefined;
      valid(row); const batch = decodeBatch(row); if (batch.messageId !== undefined || batch.sendState !== undefined) return false;
      const next: ProgressBatch = { ...batch, sendState: "sending" }; this.saveBatch(next); return true;
    }).immediate();
  }
  failMessage(id: string, definitive: boolean): void {
    valid(/^[0-9a-f]{24}$/.test(id) && typeof definitive === "boolean");
    this.database.transaction(() => {
      const row = this.database.prepare("SELECT id AS key, payload FROM progress_batches WHERE id = ?").get(id) as Row | undefined;
      valid(row); const batch = decodeBatch(row); if (batch.sendState !== "sending") return;
      const { sendState: _sendState, ...withoutState } = batch;
      this.saveBatch(definitive ? withoutState : { ...withoutState, sendState: "unknown" });
    }).immediate();
  }
  recoverMessages(): void {
    this.database.transaction(() => {
      for (const row of this.database.prepare("SELECT id AS key, payload FROM progress_batches").all() as Row[]) {
        const batch = decodeBatch(row); if (batch.sendState === "sending") this.saveBatch({ ...batch, sendState: "unknown" });
      }
    }).immediate();
  }
  markMessage(id: string, messageId: number, text: string, finished: boolean): void { valid(/^[0-9a-f]{24}$/.test(id)); positive(messageId); valid(typeof text === "string" && text.length <= 4096 && typeof finished === "boolean"); this.database.transaction(() => { const row = this.database.prepare("SELECT id AS key, payload FROM progress_batches WHERE id = ?").get(id) as Row | undefined; valid(row); const { sendState: _sendState, ...batch } = decodeBatch(row); this.saveBatch({ ...batch, messageId, deliveredText: text, finished }); }).immediate(); }
  range(event: ProgressEvent): ProgressRange | undefined { validateEvent(event); const row = this.database.prepare("SELECT id AS key, payload FROM progress_ranges WHERE id = ?").get(eventKey(event)) as Row | undefined; return row && decodeRange(row, event); }
  markRange(event: ProgressEvent, state: ProgressRange): void { validateEvent(event); validateRange(state, event); const payload = JSON.stringify(state); valid(Buffer.byteLength(payload) <= MAX_JSON); const id = eventKey(event); this.database.prepare("INSERT INTO progress_ranges(id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(id, payload); }
  markAgent(jobId: string, phase: "analyst" | "verifier"): void { valid(typeof jobId === "string" && JOB_ID.test(jobId) && (phase === "analyst" || phase === "verifier")); this.database.prepare("INSERT INTO progress_agents(id, phase) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET phase = excluded.phase").run(jobId, phase); }
  agent(jobId: string): "analyst" | "verifier" | undefined { valid(typeof jobId === "string" && JOB_ID.test(jobId)); const row = this.database.prepare("SELECT phase FROM progress_agents WHERE id = ?").get(jobId) as { phase: unknown } | undefined; valid(!row || row.phase === "analyst" || row.phase === "verifier"); return row?.phase as "analyst" | "verifier" | undefined; }
  private saveBatch(batch: ProgressBatch): void { validateBatch(batch); this.database.prepare("UPDATE progress_batches SET payload = ? WHERE id = ?").run(JSON.stringify(batch), batch.id); }
}
