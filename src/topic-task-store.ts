import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { containsSecret } from "./topic-sync.js";

export type TopicTaskTitleSource = "auto" | "manual";
export type TopicTaskAgentState = "idle" | "accepted" | "queued" | "running" | "needs_input" | "needs_approval" | "stalled" | "delivering" | "result_ready" | "failed" | "unknown";
export type TopicTaskLifecycle = "open" | "completed";
export type TopicTaskPresence = "open" | "closed" | "missing" | "unknown";
export type TopicTaskCardState = "none" | "sending" | "ready" | "unknown";
export type TopicTaskPinState = "none" | "pinned" | "forbidden" | "unknown";

export interface TopicTaskIdentity {
  chatId: number;
  messageThreadId: number;
  title: string;
  workspace: string;
  threadId?: string | null;
  ticketId?: number | null;
}

export interface TopicTaskRecord {
  contextKey: string;
  taskId: string;
  chatId: number;
  messageThreadId: number;
  version: number;
  enabled: boolean;
  title: string;
  titleSource: TopicTaskTitleSource;
  workspace: string;
  threadId: string | null;
  ticketId: number | null;
  latestJobId: string | null;
  latestJobAt: number;
  latestJobVersion: number;
  latestJobOrder: number;
  agentState: TopicTaskAgentState;
  lifecycle: TopicTaskLifecycle;
  presence: TopicTaskPresence;
  lastEventAt: number | null;
  lastResultMessageId: number | null;
  cardMessageId: number | null;
  cardState: TopicTaskCardState;
  cardAttemptId: string | null;
  contentHash: string | null;
  pinState: TopicTaskPinState;
  updatedAt: number;
}

export type TopicTaskPatch = Partial<Omit<TopicTaskRecord, "contextKey" | "taskId" | "chatId" | "messageThreadId" | "version">>;
type Row = { context_key: string; version: number; payload: string };
const immutable = new Set(["contextKey", "taskId", "chatId", "messageThreadId", "version"]);
const fields = new Set("contextKey taskId chatId messageThreadId version enabled title titleSource workspace threadId ticketId latestJobId latestJobAt latestJobVersion latestJobOrder agentState lifecycle presence lastEventAt lastResultMessageId cardMessageId cardState cardAttemptId contentHash pinState updatedAt".split(" "));

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid topic task data");
}
function integer(value: unknown, min: number): void {
  requireValid(typeof value === "number" && Number.isSafeInteger(value) && value >= min);
}
function text(value: unknown, max: number): void {
  requireValid(typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && !containsSecret(value));
}
function validate(task: TopicTaskRecord): void {
  requireValid(task && typeof task === "object" && Object.keys(task).length === fields.size && Object.keys(task).every((key) => fields.has(key)));
  requireValid(Number.isSafeInteger(task.chatId) && task.chatId !== 0);
  integer(task.messageThreadId, 1);
  requireValid(task.contextKey === `${task.chatId}:${task.messageThreadId}`);
  requireValid(typeof task.taskId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task.taskId));
  integer(task.version, 1);
  requireValid(typeof task.enabled === "boolean");
  text(task.title, 256); text(task.workspace, 4096);
  for (const value of [task.threadId, task.latestJobId, task.cardAttemptId, task.contentHash]) if (value !== null) text(value, 256);
  for (const value of [task.ticketId, task.lastResultMessageId, task.cardMessageId]) if (value !== null) integer(value, 1);
  for (const value of [task.latestJobAt, task.latestJobVersion, task.latestJobOrder, task.updatedAt]) integer(value, 0);
  if (task.lastEventAt !== null) integer(task.lastEventAt, 0);
  const enums: [unknown, string[]][] = [
    [task.titleSource, ["auto", "manual"]],
    [task.agentState, ["idle", "accepted", "queued", "running", "needs_input", "needs_approval", "stalled", "delivering", "result_ready", "failed", "unknown"]],
    [task.lifecycle, ["open", "completed"]], [task.presence, ["open", "closed", "missing", "unknown"]],
    [task.cardState, ["none", "sending", "ready", "unknown"]], [task.pinState, ["none", "pinned", "forbidden", "unknown"]],
  ];
  for (const [value, allowed] of enums) requireValid(typeof value === "string" && allowed.includes(value));
  requireValid(task.cardState !== "ready" || task.cardMessageId !== null);
  requireValid(task.cardState !== "sending" || task.cardAttemptId !== null);
  requireValid(task.cardState !== "none" || (task.cardMessageId === null && task.cardAttemptId === null));
  requireValid(task.pinState !== "pinned" || task.cardMessageId !== null);
}
function decode(row: Row): TopicTaskRecord {
  requireValid(typeof row.payload === "string" && row.payload.length <= 16384);
  const task: TopicTaskRecord = JSON.parse(row.payload);
  validate(task);
  requireValid(task.contextKey === row.context_key && task.version === row.version);
  return task;
}

export class TopicTaskStore {
  private readonly database: Database.Database;

  constructor(filePath: string) {
    requireValid(typeof filePath === "string" && filePath.length > 0 && filePath !== ":memory:");
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const descriptor = openSync(filePath, "a", 0o600);
    try { chmodSync(filePath, 0o600); } finally { closeSync(descriptor); }
    this.database = new Database(filePath);
    try {
      this.database.pragma("busy_timeout = 1000");
      this.database.transaction(() => {
        const version = this.database.pragma("user_version", { simple: true });
        if (version === 0) {
          const tables = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
          requireValid(tables.length === 0);
          this.database.exec("CREATE TABLE topic_tasks (context_key TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL)");
          this.database.pragma("user_version = 1");
        } else {
          requireValid(version === 1);
        }
        const columns = this.database.pragma("table_info(topic_tasks)") as { name: string; type: string; notnull: number; pk: number }[];
        requireValid(columns.length === 3 && columns.every((column, index) => column.name === ["context_key", "version", "payload"][index] && column.type === ["TEXT", "INTEGER", "TEXT"][index] && column.notnull === 1 && column.pk === (index === 0 ? 1 : 0)));
        for (const row of this.database.prepare("SELECT context_key, version, payload FROM topic_tasks").iterate()) decode(row as Row);
      }).immediate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  ensure(input: TopicTaskIdentity): TopicTaskRecord {
    const task: TopicTaskRecord = {
      contextKey: `${input.chatId}:${input.messageThreadId}`, taskId: randomUUID(),
      chatId: input.chatId, messageThreadId: input.messageThreadId, version: 1, enabled: true,
      title: input.title, titleSource: "auto", workspace: input.workspace, threadId: input.threadId ?? null,
      ticketId: input.ticketId ?? null, latestJobId: null, latestJobAt: 0, latestJobVersion: 0, latestJobOrder: 0,
      agentState: "idle", lifecycle: "open", presence: "unknown", lastEventAt: null,
      lastResultMessageId: null, cardMessageId: null, cardState: "none", cardAttemptId: null,
      contentHash: null, pinState: "none", updatedAt: Date.now(),
    };
    validate(task);
    return this.database.transaction(() => {
      const existing = this.get(task.contextKey);
      if (existing) return existing;
      this.database.prepare("INSERT INTO topic_tasks (context_key, version, payload) VALUES (?, ?, ?)").run(task.contextKey, task.version, JSON.stringify(task));
      return task;
    }).immediate();
  }

  get(contextKey: string): TopicTaskRecord | null {
    text(contextKey, 64);
    const row = this.database.prepare("SELECT context_key, version, payload FROM topic_tasks WHERE context_key = ?").get(contextKey) as Row | undefined;
    return row ? decode(row) : null;
  }

  update(contextKey: string, expectedVersion: number, patch: TopicTaskPatch): TopicTaskRecord | null {
    integer(expectedVersion, 1);
    requireValid(patch && typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).every((key) => fields.has(key) && !immutable.has(key)));
    return this.database.transaction(() => {
      const existing = this.get(contextKey);
      if (!existing || existing.version !== expectedVersion) return null;
      const updated = { ...existing, ...patch, version: existing.version + 1, updatedAt: Date.now() };
      validate(updated);
      const result = this.database.prepare("UPDATE topic_tasks SET version = ?, payload = ? WHERE context_key = ? AND version = ?").run(updated.version, JSON.stringify(updated), contextKey, expectedVersion);
      return result.changes === 1 ? updated : null;
    }).immediate();
  }

  listEnabled(): TopicTaskRecord[] {
    return (this.database.prepare("SELECT context_key, version, payload FROM topic_tasks ORDER BY context_key").all() as Row[]).map(decode).filter((task) => task.enabled);
  }

  close(): void {
    if (this.database.open) this.database.close();
  }
}
