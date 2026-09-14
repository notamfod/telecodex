import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { inspectTelegramErrorForLog, type TelegramLogCategory } from "./telegram-error-log.js";

export interface TaskProvisioningInput {
  operationId: string;
  sourceContextKey: string;
  sourceMessageIds: number[];
  title: string;
  workspace: string;
  launchProfileId?: string;
  userId?: number;
  kind: "manual" | "inbox" | "extract" | "sync";
  metadata?: Record<string, unknown>;
}
export interface TaskProvisioningRecord extends TaskProvisioningInput {
  state: "accepted" | "provisioning" | "bound" | "ready" | "failed" | "unknown";
  messageThreadId?: number;
  failureStage?: "create" | "bind" | "ready";
  failureCategory?: TelegramLogCategory;
  updatedAt: number;
}
export interface TaskProvisioningTransport {
  createTopic(record: TaskProvisioningRecord): Promise<number>;
  bind(record: TaskProvisioningRecord): Promise<void> | void;
  ready(record: TaskProvisioningRecord): Promise<void>;
}

/** SQLite FULL commits form the boundary before non-idempotent Telegram calls. */
export class TaskProvisioningStore {
  private readonly db: Database.Database;
  constructor(filePath: string) {
    if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new Database(filePath);
    if (filePath !== ":memory:") chmodSync(filePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS provisioning (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inbox_pending (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  }
  get(operationId: string): TaskProvisioningRecord | undefined {
    const row = this.db.prepare("SELECT payload FROM provisioning WHERE id = ?").get(operationId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  list(sourceContextKey?: string): TaskProvisioningRecord[] {
    return (this.db.prepare("SELECT payload FROM provisioning").all() as { payload: string }[]).map(row => JSON.parse(row.payload) as TaskProvisioningRecord).filter(row => !sourceContextKey || row.sourceContextKey === sourceContextKey);
  }
  accept(input: TaskProvisioningInput): TaskProvisioningRecord {
    if (!input.operationId || input.operationId.length > 256 || !/^-?\d+(?::\d+)?$/.test(input.sourceContextKey)
      || !Array.isArray(input.sourceMessageIds) || input.sourceMessageIds.some(id => !Number.isSafeInteger(id) || id <= 0)
      || !input.title.trim() || [...input.title].length > 128 || !path.isAbsolute(input.workspace)
      || !["manual", "inbox", "extract", "sync"].includes(input.kind)) throw new Error("Invalid provisioning input");
    const record: TaskProvisioningRecord = { ...input, state: "accepted", updatedAt: Date.now() };
    this.db.prepare("INSERT OR IGNORE INTO provisioning (id,payload) VALUES (?,?)").run(input.operationId, JSON.stringify(record));
    const accepted = this.get(input.operationId)!;
    if (accepted.sourceContextKey !== input.sourceContextKey || accepted.kind !== input.kind || accepted.workspace !== input.workspace
      || accepted.userId !== input.userId || accepted.launchProfileId !== input.launchProfileId
      || JSON.stringify([...accepted.sourceMessageIds].sort()) !== JSON.stringify([...input.sourceMessageIds].sort())) throw new Error("Provisioning operation identity mismatch");
    return accepted;
  }
  patch(operationId: string, patch: Partial<Pick<TaskProvisioningRecord, "state" | "messageThreadId" | "failureStage" | "failureCategory" | "metadata">>): TaskProvisioningRecord {
    const record = this.get(operationId);
    if (!record) throw new Error("Provisioning operation missing");
    const next = { ...record, ...patch, updatedAt: Date.now() };
    this.db.prepare("UPDATE provisioning SET payload = ? WHERE id = ?").run(JSON.stringify(next), operationId);
    return next;
  }
  pending<T>(id: string): T | undefined {
    const row = this.db.prepare("SELECT payload FROM inbox_pending WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  setPending(id: string, value: unknown): void {
    this.db.prepare("INSERT INTO inbox_pending(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(id, JSON.stringify(value));
  }
  listPending<T>(): Array<[string, T]> {
    return (this.db.prepare("SELECT id,payload FROM inbox_pending").all() as { id: string; payload: string }[]).map(row => [row.id, JSON.parse(row.payload)]);
  }
  close(): void { this.db.close(); }
}

export class TaskProvisioningService {
  private readonly active = new Map<string, Promise<TaskProvisioningRecord>>();
  private stopping = false;
  private disposal?: Promise<void>;
  constructor(readonly store: TaskProvisioningStore) {}
  dispose(): Promise<void> {
    this.stopping = true;
    return this.disposal ??= Promise.allSettled([...this.active.values()]).then(() => { this.store.close(); });
  }
  provision(input: TaskProvisioningInput, transport: TaskProvisioningTransport): Promise<TaskProvisioningRecord> {
    if (this.stopping) return Promise.reject(new Error("Provisioning is stopping"));
    try { this.store.accept(input); } catch (error) { return Promise.reject(error); }
    const active = this.active.get(input.operationId);
    if (active) return active;
    const running = this.run(input, transport).finally(() => this.active.delete(input.operationId));
    this.active.set(input.operationId, running);
    return running;
  }
  private async run(input: TaskProvisioningInput, transport: TaskProvisioningTransport): Promise<TaskProvisioningRecord> {
    let record = this.store.accept(input);
    if (["ready", "failed", "unknown"].includes(record.state)) return record;
    if (record.state === "provisioning" && !record.messageThreadId) return this.store.patch(record.operationId, { state: "unknown", failureStage: "create" });
    if (record.state === "bound") return this.store.patch(record.operationId, { state: "unknown", failureStage: "ready" });
    let stage: "create" | "bind" | "ready" = "create";
    try {
      if (record.state === "accepted") {
        record = this.store.patch(record.operationId, { state: "provisioning" });
        const messageThreadId = await transport.createTopic(record);
        if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0) throw new Error("Invalid created topic ID");
        record = this.store.patch(record.operationId, { messageThreadId });
      }
      stage = "bind";
      await transport.bind(record);
      record = this.store.patch(record.operationId, { state: "bound" });
      stage = "ready";
      await transport.ready(record);
      return this.store.patch(record.operationId, { state: "ready" });
    } catch (error) {
      const code = (error as { error_code?: unknown })?.error_code;
      const definitive = typeof code === "number" && code >= 400 && code < 500;
      return this.store.patch(record.operationId, { state: stage === "create" && !definitive ? "unknown" : "failed", failureStage: stage, failureCategory: inspectTelegramErrorForLog(error, "inbox").category });
    }
  }
}
