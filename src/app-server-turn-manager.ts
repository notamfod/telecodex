import type { AppServerNotification } from "./app-server-client.js";
import { TurnScheduler, type TurnSchedulerCallbacks } from "./turn-scheduler.js";

export type AppServerUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export interface AppServerTurnCallbacks {
  onQueued?: (status: AppServerQueueStatus) => void;
  onStarted?: (turnId: string) => void;
  onTextDelta: (delta: string) => void;
  onAgentMessageStart?: (message: AppServerAgentMessage) => void;
  onAgentMessageEnd?: (message: AppServerAgentMessage) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onGeneratedImage?: (image: { path?: string; base64?: string }) => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
  onHookBlocked?: (block: AppServerHookBlock) => void;
}

/** A hook that refused to let the turn proceed, and what it wants said about it. */
export interface AppServerHookBlock {
  eventName: string;
  reason: string;
}

export interface AppServerAgentMessage {
  itemId: string;
  phase?: string;
}

export type AppServerQueueStatus =
  | { position: number; reason: "thread-active" }
  | { position: number; active: number; limit: number; reason: "global-limit" };

export interface AppServerTurnRequest {
  threadId: string;
  input: AppServerUserInput[];
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy: string;
  sandbox: string;
  callbacks: AppServerTurnCallbacks;
}

export interface AppServerRequestClient {
  connect(): Promise<void>;
  request<T>(method: string, params?: unknown): Promise<T>;
  onNotification(listener: (notification: AppServerNotification) => void): () => void;
}

interface ThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
}

interface ThreadState {
  status: ThreadStatus["type"] | "unknown";
  initializePromise?: Promise<void>;
  queue: TurnJob[];
  activeJob?: TurnJob;
  startingJob?: TurnJob;
  scheduledJob?: TurnJob;
}

interface TurnJob {
  request: AppServerTurnRequest;
  turnId?: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  errorMessage?: string;
  schedulerCallbacks?: TurnSchedulerCallbacks;
  releaseSlot?: () => void;
  settled?: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ThreadResumeResponse {
  thread: { id: string; status: ThreadStatus };
}

interface TurnStartResponse {
  turn: { id: string; status: string };
}

interface ThreadReadResponse {
  thread: { turns?: unknown[] };
}

export class AppServerTurnManager {
  private readonly threads = new Map<string, ThreadState>();
  private readonly unsubscribe: () => void;
  private readonly scheduler: TurnScheduler;

  constructor(private readonly client: AppServerRequestClient, maxActiveTopics = 4) {
    this.scheduler = new TurnScheduler(maxActiveTopics);
    this.unsubscribe = client.onNotification((notification) => this.handleNotification(notification));
  }

  runTurn(request: AppServerTurnRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const job: TurnJob = { request, resolve, reject };
      void this.enqueue(job).catch(reject);
    });
  }

  recoverTurn(request: AppServerTurnRequest, turnId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const job: TurnJob = { request, turnId, resolve, reject };
      void this.recoverJob(job).catch((error) => this.rejectJob(job, asError(error)));
    });
  }

  /**
   * Makes the daemon re-read the thread from disk. `thread/unsubscribe` will not
   * do it — a thread stays loaded after its last subscriber leaves, and a resume
   * then just rejoins the copy already in memory. Archiving evicts it for real.
   */
  async reloadThread(threadId: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (state?.activeJob || state?.startingJob) {
      throw new Error(`Cannot reload thread ${threadId}: a turn is in flight`);
    }

    await this.client.request("thread/archive", { threadId });
    try {
      await this.client.request("thread/unarchive", { threadId });
    } catch (error) {
      throw new Error(
        `Thread ${threadId} is left archived after a failed reload: ${asError(error).message}`,
      );
    }

    const response = await this.client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
    });
    this.getThreadState(threadId).status = response.thread.status.type;
  }

  trackThread(threadId: string, status: ThreadStatus["type"]): void {
    const state = this.getThreadState(threadId);
    state.status = status;
  }

  async cancelTurn(threadId: string, callbacks: AppServerTurnCallbacks): Promise<void> {
    const state = this.threads.get(threadId);
    if (!state) return;

    const queuedIndex = state.queue.findIndex((job) => job.request.callbacks === callbacks);
    if (queuedIndex >= 0) {
      const [job] = state.queue.splice(queuedIndex, 1);
      this.rejectJob(job, new Error("Codex turn aborted"));
      return;
    }

    const scheduledJob = state.scheduledJob;
    if (
      scheduledJob?.request.callbacks === callbacks &&
      !state.activeJob &&
      !state.startingJob &&
      scheduledJob.schedulerCallbacks &&
      this.scheduler.cancel(threadId, scheduledJob.schedulerCallbacks)
    ) {
      state.scheduledJob = undefined;
      this.rejectJob(scheduledJob, new Error("Codex turn aborted"));
      void this.drain(state);
      return;
    }

    const activeJob = state.activeJob;
    if (activeJob?.request.callbacks === callbacks && activeJob.turnId) {
      await this.client.request("turn/interrupt", {
        threadId,
        turnId: activeJob.turnId,
      });
    }
  }

  dispose(): void {
    this.unsubscribe();
    const error = new Error("App-server turn manager disposed");
    for (const state of this.threads.values()) {
      if (state.scheduledJob?.schedulerCallbacks && !state.activeJob && !state.startingJob) {
        this.scheduler.cancel(
          state.scheduledJob.request.threadId,
          state.scheduledJob.schedulerCallbacks,
        );
      }
      if (state.activeJob) this.rejectJob(state.activeJob, error);
      if (state.startingJob && state.startingJob !== state.activeJob) {
        this.rejectJob(state.startingJob, error);
      }
      if (
        state.scheduledJob &&
        state.scheduledJob !== state.activeJob &&
        state.scheduledJob !== state.startingJob
      ) {
        this.rejectJob(state.scheduledJob, error);
      }
      for (const job of state.queue) {
        this.rejectJob(job, error);
      }
    }
    this.threads.clear();
  }

  private async enqueue(job: TurnJob): Promise<void> {
    const state = this.getThreadState(job.request.threadId);
    await this.ensureThread(job.request, state);

    if (state.status === "idle" && !state.activeJob && !state.startingJob) {
      this.scheduleJob(state, job);
      return;
    }

    state.queue.push(job);
    job.request.callbacks.onQueued?.({
      position: state.queue.length,
      reason: "thread-active",
    });
  }

  private getThreadState(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = { status: "unknown", queue: [] };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private async ensureThread(request: AppServerTurnRequest, state: ThreadState): Promise<void> {
    if (state.status !== "unknown") {
      return;
    }
    if (state.initializePromise) {
      await state.initializePromise;
      return;
    }

    state.initializePromise = (async () => {
      await this.client.connect();
      const response = await this.client.request<ThreadResumeResponse>("thread/resume", {
        threadId: request.threadId,
      });
      state.status = response.thread.status.type;
    })();

    try {
      await state.initializePromise;
    } finally {
      state.initializePromise = undefined;
    }
  }

  private scheduleJob(state: ThreadState, job: TurnJob): void {
    state.scheduledJob = job;
    const slot = deferred();
    job.releaseSlot = slot.resolve;
    const schedulerCallbacks: TurnSchedulerCallbacks = {
      onQueued: ({ position, active, limit }) => {
        job.request.callbacks.onQueued?.({
          position,
          active,
          limit,
          reason: "global-limit",
        });
      },
    };
    job.schedulerCallbacks = schedulerCallbacks;

    void this.scheduler.run(
      job.request.threadId,
      async () => {
        if (state.status !== "idle" || state.activeJob || state.startingJob) {
          state.scheduledJob = undefined;
          job.releaseSlot = undefined;
          state.queue.unshift(job);
          job.request.callbacks.onQueued?.({ position: 1, reason: "thread-active" });
          return;
        }
        const started = await this.startJob(state, job);
        if (started) await slot.promise;
      },
      schedulerCallbacks,
    ).catch((error) => {
      if (!job.settled) this.rejectJob(job, asError(error));
    });
  }

  private async startJob(state: ThreadState, job: TurnJob): Promise<boolean> {
    state.startingJob = job;
    state.status = "active";

    try {
      const response = await this.client.request<TurnStartResponse>("turn/start", {
        threadId: job.request.threadId,
        input: job.request.input,
        cwd: job.request.cwd,
        model: job.request.model,
        effort: job.request.reasoningEffort,
        approvalPolicy: job.request.approvalPolicy,
        sandboxPolicy: toSandboxPolicy(job.request.sandbox, job.request.cwd),
      });
      job.turnId = response.turn.id;
      state.activeJob = job;
      state.startingJob = undefined;
      job.request.callbacks.onStarted?.(response.turn.id);
      return true;
    } catch (error) {
      state.startingJob = undefined;
      if (isBusyError(error)) {
        state.scheduledJob = undefined;
        state.status = "active";
        state.queue.unshift(job);
        job.request.callbacks.onQueued?.({ position: 1, reason: "thread-active" });
        this.releaseJobSlot(job);
        return false;
      }
      state.scheduledJob = undefined;
      state.status = "idle";
      this.rejectJob(job, asError(error));
      this.releaseJobSlot(job);
      void this.drain(state);
      return false;
    }
  }

  private handleNotification(notification: AppServerNotification): void {
    const params = asRecord(notification.params);
    const threadId = readString(params, "threadId");
    if (!threadId) {
      return;
    }
    const state = this.threads.get(threadId);
    if (!state) {
      return;
    }

    if (notification.method === "thread/status/changed") {
      const status = asRecord(params.status);
      const statusType = readString(status, "type") as ThreadState["status"] | undefined;
      if (statusType) {
        state.status = statusType;
        if (statusType === "idle") {
          void this.drain(state);
        }
      }
      return;
    }

    const turnId = readString(params, "turnId") ?? readString(asRecord(params.turn), "id");
    if (!turnId) {
      return;
    }

    const job = findJobForTurn(state, turnId);
    if (notification.method === "turn/completed") {
      this.completeTurn(state, job, params);
      return;
    }
    if (!job) {
      return;
    }

    this.routeJobNotification(job, notification.method, params);
  }

  private async recoverJob(job: TurnJob): Promise<void> {
    const state = this.getThreadState(job.request.threadId);
    await this.ensureThread(job.request, state);

    if (state.status !== "active") {
      await this.replayStoredTurn(job);
      return;
    }
    if (state.activeJob || state.startingJob || state.scheduledJob) {
      throw new Error(`Cannot recover turn ${job.turnId ?? "unknown"}: thread already tracked`);
    }

    const slot = deferred();
    job.releaseSlot = slot.resolve;
    const schedulerCallbacks: TurnSchedulerCallbacks = {};
    job.schedulerCallbacks = schedulerCallbacks;
    state.activeJob = job;
    state.scheduledJob = job;
    void this.scheduler.run(
      job.request.threadId,
      () => slot.promise,
      schedulerCallbacks,
    ).catch((error) => {
      if (!job.settled) this.rejectJob(job, asError(error));
    });
    job.request.callbacks.onStarted?.(job.turnId!);
  }

  private async replayStoredTurn(job: TurnJob): Promise<void> {
    const response = await this.client.request<ThreadReadResponse>("thread/read", {
      threadId: job.request.threadId,
      includeTurns: true,
    });
    const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
    const turn = turns.map(asRecord).find((entry) => readString(entry, "id") === job.turnId);
    if (!turn) throw new Error(`No rollout found for turn ${job.turnId ?? "unknown"}`);

    const status = readString(turn, "status");
    if (status !== "completed") {
      throw new Error(readString(asRecord(turn.error), "message") ?? `Codex turn ${status ?? "failed"}`);
    }

    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const value of items) {
      const item = asRecord(value);
      const itemId = readString(item, "id") ?? "recovered-item";
      const itemType = readString(item, "type");
      if (itemType === "agentMessage") {
        const phase = readString(item, "phase");
        const message = phase ? { itemId, phase } : { itemId };
        job.request.callbacks.onAgentMessageStart?.(message);
        const text = readString(item, "text");
        if (text) job.request.callbacks.onTextDelta(text);
        job.request.callbacks.onAgentMessageEnd?.(message);
      } else if (itemType === "imageGeneration") {
        const savedPath = readString(item, "savedPath");
        const result = readString(item, "result");
        if (savedPath || result) {
          job.request.callbacks.onGeneratedImage?.(savedPath ? { path: savedPath } : { base64: result });
        }
      } else if (itemType === "commandExecution") {
        job.request.callbacks.onToolStart(readString(item, "command") ?? "command", itemId);
        job.request.callbacks.onToolEnd(itemId, false);
      }
    }
    job.request.callbacks.onAgentEnd();
    this.resolveJob(job);
  }

  private routeJobNotification(job: TurnJob, method: string, params: Record<string, unknown>): void {
    const callbacks = job.request.callbacks;
    if (method === "item/agentMessage/delta") {
      const delta = readString(params, "delta");
      if (delta) callbacks.onTextDelta(delta);
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = readString(params, "itemId");
      const delta = readString(params, "delta");
      if (itemId && delta) callbacks.onToolUpdate(itemId, delta);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const last = asRecord(asRecord(params.tokenUsage).last);
      job.usage = {
        inputTokens: readNumber(last, "inputTokens"),
        cachedInputTokens: readNumber(last, "cachedInputTokens"),
        outputTokens: readNumber(last, "outputTokens"),
      };
      return;
    }
    if (method === "hook/completed") {
      // A blocked hook still ends the turn as `completed`, just with nothing in
      // it, so this is the only place the reason is ever stated.
      const run = asRecord(params.run);
      if (readString(run, "status") === "blocked") {
        callbacks.onHookBlocked?.({
          eventName: readString(run, "eventName") ?? "hook",
          reason: hookBlockReason(run),
        });
      }
      return;
    }
    if (method === "error") {
      job.errorMessage = readString(asRecord(params.error), "message") ?? "Codex turn failed";
      return;
    }
    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      callbacks.onTodoUpdate?.(
        plan.map((entry) => {
          const item = asRecord(entry);
          return {
            text: readString(item, "step") ?? "",
            completed: readString(item, "status") === "completed",
          };
        }),
      );
      return;
    }
    if (method !== "item/started" && method !== "item/completed") {
      return;
    }

    const item = asRecord(params.item);
    const itemId = readString(item, "id");
    const itemType = readString(item, "type");
    if (!itemId || !itemType) {
      return;
    }

    if (itemType === "agentMessage") {
      const phase = readString(item, "phase");
      const message = phase ? { itemId, phase } : { itemId };
      if (method === "item/started") {
        callbacks.onAgentMessageStart?.(message);
      } else {
        callbacks.onAgentMessageEnd?.(message);
      }
      return;
    }

    if (method === "item/started") {
      if (itemType === "commandExecution") {
        callbacks.onToolStart(readString(item, "command") ?? "command", itemId);
      } else if (itemType === "webSearch") {
        callbacks.onToolStart(`🔍 ${readString(item, "query") ?? "search"}`, itemId);
      }
      return;
    }

    const failed = readString(item, "status") === "failed" || readString(item, "status") === "declined";
    if (itemType === "commandExecution" || itemType === "webSearch") {
      callbacks.onToolEnd(itemId, failed);
    } else if (itemType === "imageGeneration" && !failed) {
      const savedPath = readString(item, "savedPath");
      const result = readString(item, "result");
      if (savedPath || result) {
        callbacks.onGeneratedImage?.(savedPath ? { path: savedPath } : { base64: result });
      }
    } else if (itemType === "fileChange") {
      callbacks.onToolStart("file_change", itemId);
      callbacks.onToolUpdate(itemId, summarizeFileChanges(item.changes));
      callbacks.onToolEnd(itemId, failed);
    } else if (itemType === "mcpToolCall") {
      callbacks.onToolStart(`mcp:${readString(item, "server") ?? "?"}/${readString(item, "tool") ?? "?"}`, itemId);
      const error = readString(asRecord(item.error), "message");
      if (error) callbacks.onToolUpdate(itemId, error);
      callbacks.onToolEnd(itemId, failed);
    }
  }

  private completeTurn(state: ThreadState, job: TurnJob | undefined, params: Record<string, unknown>): void {
    state.status = "idle";
    if (!job) {
      void this.drain(state);
      return;
    }

    state.activeJob = undefined;
    state.startingJob = undefined;
    state.scheduledJob = undefined;
    const turn = asRecord(params.turn);
    const status = readString(turn, "status");
    if (status === "completed") {
      if (job.usage) job.request.callbacks.onTurnComplete?.(job.usage);
      job.request.callbacks.onAgentEnd();
      this.resolveJob(job);
    } else {
      const message = job.errorMessage ?? readString(asRecord(turn.error), "message") ?? `Codex turn ${status ?? "failed"}`;
      this.rejectJob(job, new Error(message));
    }
    this.releaseJobSlot(job);
    void this.drain(state);
  }

  private async drain(state: ThreadState): Promise<void> {
    if (state.status !== "idle" || state.activeJob || state.startingJob || state.scheduledJob) {
      return;
    }
    const next = state.queue.shift();
    if (next) {
      this.scheduleJob(state, next);
    }
  }

  private resolveJob(job: TurnJob): void {
    if (job.settled) return;
    job.settled = true;
    job.resolve();
  }

  private rejectJob(job: TurnJob, error: Error): void {
    if (job.settled) return;
    job.settled = true;
    job.reject(error);
  }

  private releaseJobSlot(job: TurnJob): void {
    const release = job.releaseSlot;
    job.releaseSlot = undefined;
    release?.();
  }
}

/**
 * What a blocking hook wants the user to read. `context` entries are addressed to
 * the model rather than to a person, so they are left out.
 */
export function hookBlockReason(run: unknown): string {
  const record = asRecord(run);
  const entries = Array.isArray(record.entries) ? record.entries : [];
  const text = entries
    .map(asRecord)
    .filter((entry) => readString(entry, "kind") !== "context")
    .map((entry) => readString(entry, "text") ?? "")
    .filter(Boolean)
    .join("\n");
  return text || readString(record, "statusMessage") || "The hook stopped this turn without saying why.";
}

function findJobForTurn(state: ThreadState, turnId: string): TurnJob | undefined {
  if (state.activeJob?.turnId === turnId) return state.activeJob;
  if (state.startingJob?.turnId === turnId) return state.startingJob;
  return undefined;
}

function toSandboxPolicy(sandbox: string, cwd: string): object {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: true };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function summarizeFileChanges(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const change = asRecord(entry);
      return `${readString(change, "kind") ?? "update"} ${readString(change, "path") ?? "file"}`;
    })
    .join(", ");
}

function isBusyError(error: unknown): boolean {
  const message = asError(error).message.toLowerCase();
  return message.includes("active turn") || message.includes("already running") || message.includes("busy");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  return typeof record[key] === "number" ? record[key] : 0;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
