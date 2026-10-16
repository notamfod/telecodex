import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { acquireRecipeRunLock } from "./recipe-run-lock.js";
import { isValidGitlabReviewDetails, type GitlabReviewDetails } from "./gitlab-review-details.js";

const STATE_VERSION = 1;
const MAX_EVENTS = 500;

export interface GitlabReviewEvent {
  readonly pipeline?: true;
  readonly dedupId: string;
  readonly projectId: number;
  readonly projectPath: string;
  readonly ref: "refs/heads/main";
  readonly after: string;
  readonly before?: string;
  readonly receivedAt: number;
}

interface CompletedEvent {
  readonly dedupId: string;
  readonly completedAt: number;
  readonly result?: GitlabReviewResult;
}

interface QueueState {
  version: 1;
  pending: GitlabReviewEvent[];
  inFlight: GitlabReviewEvent[];
  completed: CompletedEvent[];
  firstPendingAt: number | null;
  nextRunAt: number | null;
  retryAttempt: number;
}

export interface GitlabReviewQueueOptions {
  readonly statePath: string;
  readonly runReview: (
    events: readonly GitlabReviewEvent[],
    signal: AbortSignal,
  ) => Promise<void | GitlabReviewRunResults>;
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly autoSchedule?: boolean;
}

export interface GitlabReviewQueueStatus {
  readonly pending: number;
  readonly inFlight: number;
  readonly completed: number;
  readonly retryAttempt: number;
  readonly nextRunAt: number | null;
  readonly running: boolean;
}

export type GitlabReviewEnqueueResult = "accepted" | "duplicate";
export type GitlabReviewResult =
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "reviewed"; readonly findings: number; readonly freshFindings: number;
    readonly details?: GitlabReviewDetails };
export type GitlabReviewRunResults = Readonly<Record<string, GitlabReviewResult>>;
export type GitlabReviewFeedback =
  | { readonly phase: "queued" | "running" | "retrying" }
  | { readonly phase: "completed"; readonly result?: GitlabReviewResult };

export class GitlabReviewQueue {
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private state: QueueState;
  private mutation = Promise.resolve();
  private activeRun: Promise<void> | undefined;
  private pendingCompletion: { ids: Set<string>; attempt: number; retryAt: number } | undefined;
  private abortController: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    private readonly options: GitlabReviewQueueOptions,
    state: QueueState,
    private readonly releaseWriterLock: () => Promise<void>,
  ) {
    this.state = state;
    this.now = options.now ?? Date.now;
    this.debounceMs = boundedInteger(options.debounceMs ?? 30_000, 1, 300_000, "debounceMs");
    this.retryBaseMs = boundedInteger(options.retryBaseMs ?? 30_000, 1, 300_000, "retryBaseMs");
    this.retryMaxMs = boundedInteger(options.retryMaxMs ?? 300_000, this.retryBaseMs, 300_000, "retryMaxMs");
  }

  static async open(options: GitlabReviewQueueOptions): Promise<GitlabReviewQueue> {
    if (!path.isAbsolute(options.statePath)) throw new Error("GitLab review queue state path must be absolute");
    const releaseWriterLock = await acquireWriterLock(options.statePath);
    try {
      const state = await loadState(options.statePath);
      const queue = new GitlabReviewQueue(options, state, releaseWriterLock);
      if (state.inFlight.length > 0) {
        state.pending = uniqueEvents([...state.inFlight, ...state.pending]);
        state.inFlight = [];
        state.firstPendingAt = queue.now();
        state.nextRunAt = queue.now();
        await queue.persist();
      }
      queue.schedule();
      return queue;
    } catch (error) {
      await releaseWriterLock();
      throw error;
    }
  }

  enqueue(event: GitlabReviewEvent): Promise<GitlabReviewEnqueueResult> {
    validateEvent(event);
    return this.mutate(async () => {
      this.assertOpen();
      if (this.hasDedupId(event.dedupId)) return "duplicate";
      if (this.state.pending.length + this.state.inFlight.length >= MAX_EVENTS) {
        throw new Error("GitLab review queue is full");
      }
      const previous = structuredClone(this.state);
      this.state.pending.push({ ...event });
      if (this.state.firstPendingAt === null) {
        this.state.firstPendingAt = event.receivedAt;
        this.state.nextRunAt = event.receivedAt + this.debounceMs;
      }
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      this.schedule();
      return "accepted";
    });
  }

  async runDue(): Promise<boolean> {
    if (this.closed || this.activeRun) return false;
    const controller = new AbortController();
    this.abortController = controller;
    const lifecycle = this.runDueLifecycle(controller.signal);
    const tracked = lifecycle.then(() => undefined, () => undefined);
    this.activeRun = tracked;
    try {
      return await lifecycle;
    } finally {
      if (this.activeRun === tracked) {
        this.activeRun = undefined;
        this.abortController = undefined;
        this.schedule();
      }
    }
  }

  private async runDueLifecycle(signal: AbortSignal): Promise<boolean> {
    if (this.pendingCompletion) {
      let attempted = false;
      await this.mutate(async () => {
        const completion = this.pendingCompletion;
        if (!completion || completion.retryAt > this.now()) return;
        attempted = true;
        try {
          await this.persist();
        } catch (error) {
          completion.attempt = Math.min(completion.attempt + 1, 31);
          completion.retryAt = this.now() + this.retryDelay(completion.attempt);
          throw error;
        }
      });
      return attempted;
    }
    let batch: GitlabReviewEvent[] | undefined;
    await this.mutate(async () => {
      if (this.closed || this.state.pending.length === 0) return;
      if (this.state.nextRunAt === null || this.state.nextRunAt > this.now()) return;
      const previous = structuredClone(this.state);
      batch = this.state.pending;
      this.state.pending = [];
      this.state.inFlight = batch;
      this.state.firstPendingAt = null;
      this.state.nextRunAt = null;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        this.state.retryAttempt = Math.min(this.state.retryAttempt + 1, 31);
        this.state.nextRunAt = this.now() + this.retryDelay();
        batch = undefined;
        throw error;
      }
    });
    if (!batch) {
      return false;
    }
    if (this.closed || signal.aborted) {
      await this.mutate(async () => {
        this.state.pending = uniqueEvents([...batch!, ...this.state.pending]);
        this.state.inFlight = [];
        this.state.firstPendingAt = this.state.firstPendingAt ?? this.now();
        this.state.nextRunAt = this.state.nextRunAt ?? this.now();
        await this.persist();
      });
      return false;
    }
    await this.executeBatch(batch, signal);
    return true;
  }

  status(): GitlabReviewQueueStatus {
    const awaitingPersistence = this.pendingCompletion?.ids.size ?? 0;
    return {
      pending: this.state.pending.length,
      inFlight: this.state.inFlight.length + awaitingPersistence,
      completed: this.state.completed.length - awaitingPersistence,
      retryAttempt: this.state.retryAttempt,
      nextRunAt: this.pendingCompletion?.retryAt ?? this.state.nextRunAt,
      running: this.activeRun !== undefined,
    };
  }

  feedback(dedupId: string): GitlabReviewFeedback | undefined {
    if (this.pendingCompletion?.ids.has(dedupId)) return { phase: "running" };
    if (this.state.inFlight.some((event) => event.dedupId === dedupId)) return { phase: "running" };
    if (this.state.pending.some((event) => event.dedupId === dedupId)) {
      return { phase: this.state.retryAttempt > 0 ? "retrying" : "queued" };
    }
    const completed = this.state.completed.find((event) => event.dedupId === dedupId);
    return completed ? {
      phase: "completed",
      ...(completed.result ? { result: { ...completed.result } } : {}),
    } : undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    try {
      await this.activeRun;
      await this.mutation;
      if (this.pendingCompletion) await this.mutate(() => this.persist());
    } finally {
      await this.releaseWriterLock();
    }
  }

  private async executeBatch(batch: GitlabReviewEvent[], signal: AbortSignal): Promise<void> {
    let failure: unknown;
    let results: void | GitlabReviewRunResults;
    try {
      results = await this.options.runReview(batch, signal);
      validateRunResults(results, batch);
    } catch (error) {
      failure = error;
    }
    await this.mutate(async () => {
      const previous = structuredClone(this.state);
      if (failure === undefined) {
        const completedAt = this.now();
        this.state.completed.push(...batch.map(({ dedupId }) => ({
          dedupId,
          completedAt,
          ...(ownResult(results, dedupId) ? { result: ownResult(results, dedupId) } : {}),
        })));
        this.state.completed = this.state.completed.slice(-MAX_EVENTS);
        this.state.inFlight = [];
        this.state.retryAttempt = 0;
        if (this.state.pending.length > 0 && this.state.nextRunAt === null) {
          this.state.firstPendingAt = this.now();
          this.state.nextRunAt = this.now() + this.debounceMs;
        }
      } else {
        this.state.pending = uniqueEvents([...batch, ...this.state.pending]);
        this.state.inFlight = [];
        this.state.retryAttempt = Math.min(this.state.retryAttempt + 1, 31);
        this.state.firstPendingAt = this.state.firstPendingAt ?? this.now();
        this.state.nextRunAt = this.now() + this.retryDelay();
      }
      try {
        await this.persist();
      } catch (error) {
        if (failure === undefined) {
          this.pendingCompletion = {
            ids: new Set(batch.map(({ dedupId }) => dedupId)),
            attempt: 1,
            retryAt: this.now() + this.retryBaseMs,
          };
          throw error;
        }
        this.state = previous;
        this.state.pending = uniqueEvents([...batch, ...this.state.pending]);
        this.state.inFlight = [];
        this.state.retryAttempt = Math.min(this.state.retryAttempt + 1, 31);
        this.state.firstPendingAt = this.state.firstPendingAt ?? this.now();
        this.state.nextRunAt = this.now() + this.retryBaseMs;
        throw error;
      }
    });
  }

  private hasDedupId(dedupId: string): boolean {
    return this.state.pending.some((event) => event.dedupId === dedupId)
      || this.state.inFlight.some((event) => event.dedupId === dedupId)
      || this.state.completed.some((event) => event.dedupId === dedupId);
  }

  private retryDelay(attempt = this.state.retryAttempt): number {
    const multiplier = 2 ** Math.max(0, attempt - 1);
    return Math.min(this.retryMaxMs, this.retryBaseMs * multiplier);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private schedule(): void {
    if (this.options.autoSchedule === false || this.closed || this.activeRun) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const nextRunAt = this.pendingCompletion?.retryAt ?? this.state.nextRunAt;
    if (nextRunAt === null) return;
    const delay = Math.max(0, Math.min(2_147_483_647, nextRunAt - this.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDue().catch(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  private async persist(): Promise<void> {
    await persistState(this.options.statePath, this.state);
    this.pendingCompletion = undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("GitLab review queue is closed");
  }
}

async function loadState(statePath: string): Promise<QueueState> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isValidState(value)) throw new Error("invalid shape");
    return value;
  } catch (error) {
    throw new Error("GitLab review queue state is invalid", { cause: error });
  }
}

async function persistState(statePath: string, state: QueueState): Promise<void> {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, statePath);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function acquireWriterLock(statePath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  try {
    const release = acquireRecipeRunLock(lockPath, { nonBlocking: true });
    return async () => release();
  } catch (error) {
    if (error instanceof Error && error.message === "recipe lock is busy") {
      throw new Error("GitLab review queue already has an active writer");
    }
    throw error;
  }
}

function emptyState(): QueueState {
  return {
    version: STATE_VERSION,
    pending: [],
    inFlight: [],
    completed: [],
    firstPendingAt: null,
    nextRunAt: null,
    retryAttempt: 0,
  };
}

function isValidState(value: unknown): value is QueueState {
  if (!isRecord(value) || value.version !== STATE_VERSION) return false;
  if (!Array.isArray(value.pending) || value.pending.length > MAX_EVENTS) return false;
  if (!Array.isArray(value.inFlight) || value.inFlight.length > MAX_EVENTS) return false;
  if (value.pending.length + value.inFlight.length > MAX_EVENTS) return false;
  if (!Array.isArray(value.completed) || value.completed.length > MAX_EVENTS) return false;
  if (!value.pending.every(isValidEvent) || !value.inFlight.every(isValidEvent)) return false;
  if (!value.completed.every(isValidCompleted)) return false;
  if (!nullableTimestamp(value.firstPendingAt) || !nullableTimestamp(value.nextRunAt)) return false;
  if ((value.pending.length === 0) !== (value.firstPendingAt === null)
    || (value.pending.length === 0) !== (value.nextRunAt === null)) return false;
  if (!Number.isInteger(value.retryAttempt) || (value.retryAttempt as number) < 0 || (value.retryAttempt as number) > 31) return false;
  const ids = [...value.pending, ...value.inFlight, ...value.completed].map((item) => item.dedupId);
  return new Set(ids).size === ids.length;
}

function validateEvent(value: GitlabReviewEvent): void {
  if (!isValidEvent(value)) throw new Error("GitLab review event is invalid");
}

function isValidEvent(value: unknown): value is GitlabReviewEvent {
  if (!isRecord(value)) return false;
  return (value.pipeline === undefined || value.pipeline === true)
    && typeof value.dedupId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value.dedupId)
    && Number.isInteger(value.projectId) && (value.projectId as number) > 0
    && typeof value.projectPath === "string" && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value.projectPath)
    && value.projectPath.length <= 300
    && value.ref === "refs/heads/main"
    && typeof value.after === "string" && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value.after)
    && (value.before === undefined || typeof value.before === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.before))
    && nullableTimestamp(value.receivedAt) && value.receivedAt !== null;
}

function isValidCompleted(value: unknown): value is CompletedEvent {
  return isRecord(value)
    && typeof value.dedupId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value.dedupId)
    && nullableTimestamp(value.completedAt) && value.completedAt !== null
    && (value.result === undefined || isValidResult(value.result));
}

function validateRunResults(value: void | GitlabReviewRunResults, batch: readonly GitlabReviewEvent[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > batch.length) {
    throw new Error("GitLab review results are invalid");
  }
  const ids = new Set(batch.map(({ dedupId }) => dedupId));
  if (Object.entries(value).some(([dedupId, result]) => !ids.has(dedupId) || !isValidResult(result))) {
    throw new Error("GitLab review results are invalid");
  }
}

function ownResult(value: void | GitlabReviewRunResults, dedupId: string): GitlabReviewResult | undefined {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, dedupId)
    ? value[dedupId] : undefined;
}

export function isValidResult(value: unknown): value is GitlabReviewResult {
  if (!isRecord(value)) return false;
  if (value.outcome === "unchanged") return Object.keys(value).length === 1;
  return value.outcome === "reviewed"
    && Object.keys(value).every((key) => ["outcome", "findings", "freshFindings", "details"].includes(key))
    && (value.details === undefined || isValidGitlabReviewDetails(value.details))
    && Number.isSafeInteger(value.findings) && (value.findings as number) >= 0
    && (value.findings as number) <= 10_000
    && Number.isSafeInteger(value.freshFindings) && (value.freshFindings as number) >= 0
    && (value.freshFindings as number) <= (value.findings as number);
}

function nullableTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function uniqueEvents(events: GitlabReviewEvent[]): GitlabReviewEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => !seen.has(event.dedupId) && Boolean(seen.add(event.dedupId)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
