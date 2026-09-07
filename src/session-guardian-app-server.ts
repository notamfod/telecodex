import { performance } from "node:perf_hooks";

import { AppServerRequestError } from "./app-server-client.js";
import type { GuardianThreadSnapshot } from "./session-guardian-types.js";

const MAX_LOADED_THREAD_IDS = 10_000;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const READ_ONLY_RETRY_METHODS = new Set([
  "thread/loaded/list",
  "thread/read",
]);
const OVERLOAD_RETRY_BACKOFF_MS = [100, 250, 500, 1_000, 1_500, 2_500] as const;

export interface SessionGuardianAppServerClient {
  request<T>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

export interface SessionGuardianAppServerOptions {
  requestTimeoutMs?: number;
  listRootThreadsTimeoutMs?: number;
  pollIntervalMs?: number;
  monotonicClock?: () => number;
}

export interface GuardianRootThreadScope {
  readonly recentCutoffMs: number;
  readonly trackedThreadIds: readonly string[];
}

interface LoadedThreadListResponse {
  data: unknown;
}

interface LoadedThreadHeader {
  readonly threadStatus: GuardianThreadSnapshot["threadStatus"];
  readonly ephemeral: boolean;
  readonly root: boolean;
}

interface ThreadResponse {
  thread: unknown;
}

export class SessionGuardianAppServer {
  private readonly requestTimeoutMs: number;
  private readonly listRootThreadsTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly monotonicClock: () => number;
  private readonly pendingRequestCancels = new Set<(error: Error) => void>();
  private readonly pollWaitCancels = new Set<(error: Error) => void>();
  private closed = false;

  constructor(
    private readonly client: SessionGuardianAppServerClient,
    options: SessionGuardianAppServerOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.listRootThreadsTimeoutMs = options.listRootThreadsTimeoutMs ?? this.requestTimeoutMs;
    if (
      !Number.isSafeInteger(this.listRootThreadsTimeoutMs)
      || this.listRootThreadsTimeoutMs <= 0
    ) {
      throw new Error("listRootThreadsTimeoutMs must be a positive safe integer");
    }
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  async listRootThreads(scope: GuardianRootThreadScope): Promise<GuardianThreadSnapshot[]> {
    assertRootThreadScope(scope);
    const deadline = this.readMonotonicClock() + this.listRootThreadsTimeoutMs;
    const loadedThreadIds = await this.listLoadedThreadIds(deadline);
    const candidates = new Set(scope.trackedThreadIds);

    // recentCutoffMs remains validated for API/config compatibility. Guardian does not
    // deep-scan history: app-server loaded IDs are the source of active candidates,
    // while persisted tracked IDs preserve alert self-recovery.
    for (const threadId of loadedThreadIds) {
      const header = await this.readLoadedThreadHeader(threadId, deadline);
      if (!header.ephemeral && header.root && header.threadStatus === "active") {
        candidates.add(threadId);
      }
    }

    const snapshots: GuardianThreadSnapshot[] = [];
    for (const threadId of candidates) {
      const snapshot = await this.readThreadWithin(
        threadId,
        this.remainingListRootThreadsTimeout(deadline, "thread/read"),
      );
      if (snapshot.root) snapshots.push(snapshot);
    }
    return snapshots;
  }

  async readThread(threadId: string): Promise<GuardianThreadSnapshot> {
    return this.readThreadWithin(threadId, this.requestTimeoutMs);
  }

  private async listLoadedThreadIds(deadline: number): Promise<string[]> {
    const response = asRecord(
      await this.request<LoadedThreadListResponse>(
        "thread/loaded/list",
        {},
        this.remainingListRootThreadsTimeout(deadline, "thread/loaded/list"),
      ),
    );
    if (!Array.isArray(response.data)) {
      throw invalidLoadedList("data must be an array");
    }
    if (response.data.length > MAX_LOADED_THREAD_IDS) {
      throw invalidLoadedList(`data must contain at most ${MAX_LOADED_THREAD_IDS} IDs`);
    }
    const seen = new Set<string>();
    for (const value of response.data) {
      if (typeof value !== "string" || !THREAD_ID_PATTERN.test(value)) {
        throw invalidLoadedList("ID must be a UUID");
      }
      if (seen.has(value)) throw invalidLoadedList("IDs must be unique");
      seen.add(value);
    }
    return [...seen];
  }

  private async readLoadedThreadHeader(
    threadId: string,
    deadline: number,
  ): Promise<LoadedThreadHeader> {
    const response = asRecord(
      await this.request<ThreadResponse>(
        "thread/read",
        { threadId, includeTurns: false },
        this.remainingListRootThreadsTimeout(deadline, "thread/read"),
      ),
    );
    if (!isRecord(response.thread)) {
      throw new Error("Invalid app-server response: thread/read.thread must be an object");
    }
    if (readString(response.thread.id) !== threadId) {
      throw new Error(
        `Invalid app-server response: thread/read.thread.id must match ${threadId}`,
      );
    }
    const threadStatus = readThreadStatus(asRecord(response.thread.status).type);
    const root = isRootThread(response.thread);
    if (typeof response.thread.ephemeral !== "boolean") {
      throw invalidThreadField("ephemeral", "must be a boolean");
    }
    return Object.freeze({ threadStatus, ephemeral: response.thread.ephemeral, root });
  }

  private remainingListRootThreadsTimeout(deadline: number, method: string): number {
    const remaining = deadline - this.readMonotonicClock();
    if (remaining <= 0) {
      try { this.client.close(); } catch { /* Preserve the required timeout error. */ }
      throw new Error(`App-server request timed out: ${method}`);
    }
    return Math.max(1, Math.floor(Math.min(this.requestTimeoutMs, Math.ceil(remaining))));
  }

  private readMonotonicClock(): number {
    const value = this.monotonicClock();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("monotonicClock must return a non-negative finite number");
    }
    return value;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async waitForIdle(threadId: string, timeoutMs: number): Promise<GuardianThreadSnapshot> {
    this.assertOpen();
    const deadline = Date.now() + Math.max(0, timeoutMs);

    while (true) {
      this.assertOpen();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw idleTimeoutError(threadId);

      const snapshot = await this.readThreadWithin(
        threadId,
        Math.min(this.requestTimeoutMs, remaining),
      );
      if (snapshot.threadStatus === "idle") return snapshot;

      const delayMs = Math.min(this.pollIntervalMs, deadline - Date.now());
      if (delayMs <= 0) throw idleTimeoutError(threadId);
      await this.waitForNextPoll(delayMs);
    }
  }

  async coldReload(threadId: string): Promise<GuardianThreadSnapshot> {
    try {
      await this.request("thread/archive", { threadId });
    } catch (error) {
      try {
        await this.request("thread/unarchive", { threadId });
      } catch {
        // The archive error is the primary failure; compensation is best-effort.
      }
      throw error;
    }
    await this.request("thread/unarchive", { threadId });
    await this.request("thread/resume", { threadId });
    return this.readThread(threadId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = closedError();
    for (const cancel of [...this.pendingRequestCancels]) cancel(error);
    for (const cancel of [...this.pollWaitCancels]) cancel(error);
    this.client.close();
  }

  private async readThreadWithin(
    threadId: string,
    timeoutMs: number,
  ): Promise<GuardianThreadSnapshot> {
    const response = asRecord(
      await this.request<ThreadResponse>(
        "thread/read",
        { threadId, includeTurns: true },
        timeoutMs,
      ),
    );
    if (!isRecord(response.thread)) {
      throw new Error("Invalid app-server response: thread/read.thread must be an object");
    }
    if (readString(response.thread.id) !== threadId) {
      throw new Error(
        `Invalid app-server response: thread/read.thread.id must match ${threadId}`,
      );
    }
    return normalizeThread(response.thread);
  }

  private request<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(closedError());

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let retryTimeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (retryTimeout !== undefined) clearTimeout(retryTimeout);
        this.pendingRequestCancels.delete(cancel);
      };
      const resolveOnce = (value: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const cancel = (error: Error): void => rejectOnce(error);
      this.pendingRequestCancels.add(cancel);

      timeout = setTimeout(() => {
        rejectOnce(new Error(`App-server request timed out: ${method}`));
        try {
          this.client.close();
        } catch {
          // Preserve the required timeout error even if transport cleanup fails.
        }
      }, Math.max(0, timeoutMs));

      let attempt: (retryIndex: number) => void;
      const handleFailure = (error: unknown, retryIndex: number): void => {
        const backoffMs = OVERLOAD_RETRY_BACKOFF_MS[retryIndex];
        if (!isRetryableReadOnlyFailure(method, error) || backoffMs === undefined) {
          rejectOnce(error);
          return;
        }
        retryTimeout = setTimeout(() => {
          retryTimeout = undefined;
          attempt(retryIndex + 1);
        }, backoffMs);
      };
      attempt = (retryIndex: number): void => {
        if (settled) return;
        let pending: Promise<T>;
        try {
          pending = this.client.request<T>(method, params);
        } catch (error) {
          handleFailure(error, retryIndex);
          return;
        }
        pending.then(resolveOnce, (error) => handleFailure(error, retryIndex));
      };
      attempt(0);
    });
  }

  private waitForNextPoll(timeoutMs: number): Promise<void> {
    this.assertOpen();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.pollWaitCancels.delete(cancel);
        resolve();
      };
      const cancel = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.pollWaitCancels.delete(cancel);
        reject(error);
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.pollWaitCancels.add(cancel);
    });
  }

  private assertOpen(): void {
    if (this.closed) throw closedError();
  }
}

function isRetryableReadOnlyFailure(method: string, error: unknown): boolean {
  if (!READ_ONLY_RETRY_METHODS.has(method) || !(error instanceof AppServerRequestError)) {
    return false;
  }
  return error.code === "APP_SERVER_NOT_SENT"
    || error.code === "APP_SERVER_ACCEPTANCE_UNKNOWN"
    || (error.code === "APP_SERVER_REJECTED" && error.rpcCode === -32001);
}

function normalizeThread(value: unknown): GuardianThreadSnapshot {
  const thread = asRecord(value);
  const threadStatus = readThreadStatus(asRecord(thread.status).type);
  if (!Array.isArray(thread.turns)) {
    throw invalidThreadField("turns", "must be an array");
  }
  if (typeof thread.updatedAt !== "number" || !Number.isFinite(thread.updatedAt)) {
    throw invalidThreadField("updatedAt", "must be a finite number");
  }
  if (typeof thread.cwd !== "string") {
    throw invalidThreadField("cwd", "must be a string");
  }
  if (
    thread.canAcceptDirectInput !== null
    && typeof thread.canAcceptDirectInput !== "boolean"
  ) {
    throw invalidThreadField("canAcceptDirectInput", "must be a boolean or null");
  }

  const turns = thread.turns;
  if (threadStatus === "active" && turns.length === 0) {
    throw invalidThreadField("turns", "must include a current turn for an active thread");
  }

  const lastTurnValue = turns.at(-1);
  if (lastTurnValue !== undefined && !isRecord(lastTurnValue)) {
    throw invalidThreadField("turns[last]", "must be an object");
  }
  const lastTurn = asRecord(lastTurnValue);
  const turnId = turns.length > 0 ? readString(lastTurn.id) : undefined;
  if (turns.length > 0 && !turnId) {
    throw invalidThreadField("turns[last].id", "must be a non-empty string");
  }
  const turnStatus = turns.length > 0 ? readString(lastTurn.status) : undefined;
  if (turns.length > 0 && !turnStatus) {
    throw invalidThreadField("turns[last].status", "must be a non-empty string");
  }
  if (turns.length > 0 && !Array.isArray(lastTurn.items)) {
    throw invalidThreadField("turns[last].items", "must be an array");
  }
  const items = turns.length > 0 ? lastTurn.items as unknown[] : [];
  const lastItem = asRecord(items.at(-1));

  return {
    threadId: readString(thread.id)!,
    turnId: turnId ?? null,
    threadStatus,
    turnStatus: turnStatus ?? null,
    updatedAt: thread.updatedAt,
    itemCount: items.length,
    lastItemType: readString(lastItem.type) ?? null,
    source: thread.source,
    cwd: thread.cwd,
    name: readThreadName(thread.name),
    canAcceptDirectInput: thread.canAcceptDirectInput === true,
    root: isRootThread(thread),
  };
}

function isRootThread(thread: Record<string, unknown>): boolean {
  const sourceValue = thread.source;
  if ((typeof sourceValue !== "string" || sourceValue.length === 0) && !isRecord(sourceValue)) {
    throw invalidThreadField("source", "must be a non-empty string or object");
  }
  let hasSubagent = false;
  if (isRecord(sourceValue) && Object.hasOwn(sourceValue, "subAgent")) {
    if (sourceValue.subAgent !== null && !isRecord(sourceValue.subAgent)) {
      throw invalidThreadField("source.subAgent", "must be an object or null");
    }
    hasSubagent = sourceValue.subAgent !== null;
  }
  const parentThreadId = thread.parentThreadId;
  if (parentThreadId !== undefined && parentThreadId !== null
    && (typeof parentThreadId !== "string" || parentThreadId.length === 0)) {
    throw invalidThreadField(
      "parentThreadId",
      "must be a non-empty string, null, or absent",
    );
  }
  const hasParent = typeof parentThreadId === "string";
  return !hasSubagent && !hasParent;
}

function readThreadStatus(
  value: unknown,
): GuardianThreadSnapshot["threadStatus"] {
  if (value === "active"
    || value === "idle"
    || value === "notLoaded"
    || value === "systemError") {
    return value;
  }
  throw invalidThreadField(
    "status.type",
    "must be active, idle, notLoaded, or systemError",
  );
}


function assertRootThreadScope(scope: GuardianRootThreadScope): void {
  if (!Number.isSafeInteger(scope.recentCutoffMs) || scope.recentCutoffMs < 0) {
    throw new Error("recentCutoffMs must be a non-negative safe integer");
  }
  if (!Array.isArray(scope.trackedThreadIds)
    || scope.trackedThreadIds.some((threadId) => !readString(threadId))) {
    throw new Error("trackedThreadIds must contain non-empty strings");
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readThreadName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw invalidThreadField("name", "must be a string or null");
  }
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (Array.from(normalized).length > 512) {
    throw invalidThreadField("name", "must be at most 512 code points");
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idleTimeoutError(threadId: string): Error {
  return new Error(`Timed out waiting for thread ${threadId} to become idle`);
}

function closedError(): Error {
  return new Error("Session guardian app-server is closed");
}

function invalidThreadField(field: string, reason: string): Error {
  return new Error(`Invalid app-server response: thread/read.thread.${field} ${reason}`);
}

function invalidLoadedList(reason: string): Error {
  return new Error(`Invalid app-server response: thread/loaded/list ${reason}`);
}
