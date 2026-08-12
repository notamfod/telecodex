import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CodexPromptInput } from "./codex-session.js";
import type { TelegramContextKey } from "./context-key.js";

export type TelegramJobState =
  | "waiting"
  | "active"
  | "delivering"
  | "completed"
  | "failed"
  | "aborted";

export interface PersistentTelegramJob {
  id: string;
  contextKey: TelegramContextKey;
  chatId: number;
  messageThreadId?: number;
  threadId: string | null;
  turnId?: string;
  input: CodexPromptInput;
  state: TelegramJobState;
  sentPartKeys: string[];
  createdAt: number;
  updatedAt: number;
}

export type NewTelegramJob = Pick<
  PersistentTelegramJob,
  "contextKey" | "chatId" | "messageThreadId" | "threadId" | "input"
>;

export class TelegramJobStore {
  private readonly jobs = new Map<string, PersistentTelegramJob>();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  create(input: NewTelegramJob): PersistentTelegramJob {
    const timestamp = this.now();
    const job: PersistentTelegramJob = {
      ...input,
      id: randomUUID(),
      state: "waiting",
      sentPartKeys: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    this.persist();
    return structuredClone(job);
  }

  get(id: string): PersistentTelegramJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  update(
    id: string,
    changes: Partial<Pick<PersistentTelegramJob, "state" | "threadId" | "turnId">>,
  ): PersistentTelegramJob {
    const job = this.requireJob(id);
    Object.assign(job, changes, { updatedAt: this.now() });
    this.persist();
    return structuredClone(job);
  }

  listRecoverable(): PersistentTelegramJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.state === "waiting" || job.state === "active" || job.state === "delivering")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((job) => structuredClone(job));
  }

  hasPart(id: string, partKey: string): boolean {
    return this.requireJob(id).sentPartKeys.includes(partKey);
  }

  markPartSent(id: string, partKey: string): boolean {
    const job = this.requireJob(id);
    if (job.sentPartKeys.includes(partKey)) return false;
    job.sentPartKeys.push(partKey);
    job.updatedAt = this.now();
    this.persist();
    return true;
  }

  private requireJob(id: string): PersistentTelegramJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown Telegram job: ${id}`);
    return job;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistentTelegramJob[];
      if (!Array.isArray(parsed)) return;
      for (const job of parsed) {
        if (job?.id && job.contextKey && Array.isArray(job.sentPartKeys)) {
          this.jobs.set(job.id, job);
        }
      }
    } catch (error) {
      console.warn(
        "Failed to load Telegram job store:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporaryPath, JSON.stringify([...this.jobs.values()], null, 2), "utf8");
    renameSync(temporaryPath, this.filePath);
  }
}
