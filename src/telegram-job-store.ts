import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { Worker } from "node:worker_threads";
import path from "node:path";

import type { CodexPromptInput } from "./codex-session.js";
import type { TelegramContextKey } from "./context-key.js";

export type { TelegramJob, TelegramJobEvent, TelegramSourceKey } from "./telegram-job-types.js";
export { replayTelegramJobEvents, SqliteTelegramJobStore } from "./telegram-job-ledger.js";
export type {
  AcceptRetryUpdateInput, AcceptUpdateInput, AcceptUpdateResult, DeliveryCompletionCandidate,
  DeliveryCompletionScanCursor, DeliveryCompletionScanInput, DeliveryCompletionScanResult,
  DeliveryPart, DeliveryTransitionInput, NewDeliveryPart,
  FinishStatusAnchorRevisionInput, PrepareStatusAnchorRevisionInput, PrepareStatusAnchorRevisionResult,
  ReplaceMissingStatusAnchorEditInput,
  InstallDeliveryPlanInput, InstallLiveCommentaryInput,
  ProjectedDeliveryTransitionInput, ProjectedDeliveryTransitionResult,
  ReplanRichDeliveryInput, ReplanRichDeliveryResult,
  TelegramDeliverySummary,
  TelegramDashboardAggregates,
  SqliteTelegramJobStoreOptions,
  StoredAcceptedTelegramJobEvent, StoredTelegramJobEvent, StoredTransitionTelegramJobEvent,
  StoredTelegramJobEventSummary, TelegramJobRetentionInput, TelegramJobRetentionResult,
  TelegramJobQuarantine, TelegramReconciliationScanCursor, TelegramReconciliationScanInput,
  TelegramReconciliationScanResult, TransitionEvent, TransitionInput,
} from "./telegram-job-ledger.js";

export type TelegramJobState =
  | "awaiting-model"
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
  selectionToken?: string;
  modelChoiceId?: string;
  cleanupInbox?: { workspace: string; turnId: string };
  state: TelegramJobState;
  sentPartKeys: string[];
  createdAt: number;
  updatedAt: number;
}

export type NewTelegramJob = Pick<
  PersistentTelegramJob,
  "contextKey" | "chatId" | "messageThreadId" | "threadId" | "input"
> & Pick<Partial<PersistentTelegramJob>, "modelChoiceId" | "cleanupInbox">;

const MAX_LEGACY_PROBE_BYTES = 64 * 1024 * 1024;
const DEFAULT_LEGACY_PROBE_TIMEOUT_MS = 250;
const LEGACY_PROBE_WORKER_SOURCE = String.raw`
const { closeSync, constants, fstatSync, openSync, readFileSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
let descriptor;
try {
  descriptor = openSync(workerData.filePath, constants.O_RDONLY);
  if (fstatSync(descriptor).size > workerData.maxBytes) {
    parentPort.postMessage("invalid");
  } else {
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    parentPort.postMessage(Array.isArray(parsed) ? "ok" : "invalid");
  }
} catch {
  parentPort.postMessage("unavailable");
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
}
`;

export class LegacyTelegramJobStoreProbe {
  constructor(private readonly filePath: string) {}

  probeReadable(timeoutMs = DEFAULT_LEGACY_PROBE_TIMEOUT_MS): Promise<void> {
    if (!existsSync(this.filePath)) return Promise.resolve();
    const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? timeoutMs : DEFAULT_LEGACY_PROBE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(LEGACY_PROBE_WORKER_SOURCE, {
        eval: true,
        workerData: { filePath: this.filePath, maxBytes: MAX_LEGACY_PROBE_BYTES },
      });
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        void worker.terminate();
        action();
      };
      const deadline = setTimeout(() => finish(() => reject(
        new Error("Legacy Telegram job store is unavailable"),
      )), boundedTimeoutMs);
      worker.once("message", (outcome: unknown) => finish(() => {
        if (outcome === "ok") resolve();
        else reject(new Error(outcome === "invalid"
          ? "Legacy Telegram job store is invalid"
          : "Legacy Telegram job store is unavailable"));
      }));
      worker.once("error", () => finish(() => reject(
        new Error("Legacy Telegram job store is unavailable"),
      )));
      worker.once("exit", () => finish(() => reject(
        new Error("Legacy Telegram job store is unavailable"),
      )));
    });
  }

  probeWritable(): void {
    if (!existsSync(this.filePath)) {
      accessSync(path.dirname(this.filePath), constants.W_OK);
      return;
    }
    const descriptor = openSync(this.filePath, constants.O_RDWR);
    closeSync(descriptor);
  }
}

/** Legacy JSON facade. Bot routing moves to the canonical ledger in Task 12. */
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

  list(): PersistentTelegramJob[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  listRecoverable(): PersistentTelegramJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.state === "waiting" || job.state === "active" || job.state === "delivering")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((job) => structuredClone(job));
  }

  awaitModelSelection(id: string): PersistentTelegramJob {
    const job = this.requireJob(id);
    if (job.state !== "waiting" && job.state !== "awaiting-model") {
      throw new Error(`Telegram job ${id} cannot await model selection from state ${job.state}`);
    }
    job.state = "awaiting-model";
    job.selectionToken ??= randomUUID().replaceAll("-", "").slice(0, 12);
    job.updatedAt = this.now();
    this.persist();
    return structuredClone(job);
  }

  findAwaitingModel(
    selectionToken: string,
    contextKey: TelegramContextKey,
  ): PersistentTelegramJob | undefined {
    const job = [...this.jobs.values()].find(
      (candidate) =>
        candidate.state === "awaiting-model"
        && candidate.selectionToken === selectionToken
        && candidate.contextKey === contextKey,
    );
    return job ? structuredClone(job) : undefined;
  }

  listAwaitingModel(): PersistentTelegramJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.state === "awaiting-model")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((job) => structuredClone(job));
  }

  selectModel(
    selectionToken: string,
    contextKey: TelegramContextKey,
    modelChoiceId: string,
    threadId: string,
  ): PersistentTelegramJob {
    const job = [...this.jobs.values()].find(
      (candidate) =>
        candidate.state === "awaiting-model"
        && candidate.selectionToken === selectionToken
        && candidate.contextKey === contextKey,
    );
    if (!job) throw new Error("Invalid or expired model selection");

    job.state = "waiting";
    job.modelChoiceId = modelChoiceId;
    job.threadId = threadId;
    delete job.selectionToken;
    job.updatedAt = this.now();
    this.persist();
    return structuredClone(job);
  }

  useDefaultModel(id: string): PersistentTelegramJob {
    const job = this.requireJob(id);
    if (job.state !== "awaiting-model") {
      throw new Error(`Telegram job ${id} cannot use the default model from state ${job.state}`);
    }
    job.state = "waiting";
    delete job.selectionToken;
    delete job.modelChoiceId;
    job.updatedAt = this.now();
    this.persist();
    return structuredClone(job);
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
