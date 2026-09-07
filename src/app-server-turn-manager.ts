import {
  AppServerRequestError,
  type AppServerNotification,
  type AppServerRequestOptions,
} from "./app-server-client.js";
import { mapAppServerActivity } from "./app-server-activity.js";
import type { JobActivity } from "./telegram-job-types.js";
import { TurnScheduler, type TurnSchedulerCallbacks } from "./turn-scheduler.js";

export type AppServerUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export interface AppServerTurnCallbacks {
  onQueued?: (status: AppServerQueueStatus) => void;
  /** Blocking persistence barrier. Throwing prevents the corresponding turn/start write. */
  beforeDispatchWrite?: (event: {
    threadId: string;
    previousTurnId: string | null;
    previousTurnKnown: boolean;
    attempt: number;
  }) => void;
  onDispatching?: (event: { previousTurnId: string | null; attempt: number }) => void;
  onDispatchWritten?: () => void;
  onStarted?: (turnId: string) => void;
  onActivity?: (event: {
    activity: JobActivity;
    eventAt: number;
    method: string;
  }) => void;
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
  onTurnOutcome?: (event: { status: string; eventAt: number }) => void;
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
  | { position: number; active: number; limit: number; reason: "global-limit" }
  | { position: number; reason: "app-server-unavailable" };

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
  request<T>(method: string, params?: unknown, options?: AppServerRequestOptions): Promise<T>;
  onNotification(listener: (notification: AppServerNotification) => void): () => void;
  onDisconnect(listener: () => void): () => void;
}

interface ThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: string[];
}

interface ThreadState {
  status: ThreadStatus["type"] | "unknown";
  dispatchAmbiguous: boolean;
  latestTurnId: string | null;
  latestTurnKnown: boolean;
  externalActiveTurnId?: string;
  initializePromise?: Promise<void>;
  reconcilePromise?: Promise<void>;
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
  errorObserved?: boolean;
  terminalReconciliation?: Promise<void>;
  dispatchAttempt?: number;
  dispatchWritten?: boolean;
  previousTurnId?: string | null;
  previousTurnKnown?: boolean;
  startedNotified?: boolean;
  provisionalTurnId?: string;
  provisionalNotifications?: Array<{
    notification: AppServerNotification;
    receiptAt: number;
  }>;
  provisionalExternalCompleted?: boolean;
  lastActivityObservation?: {
    activity: JobActivity;
    receiptAt: number;
    sample: boolean;
  };
  schedulerCallbacks?: TurnSchedulerCallbacks;
  releaseSlot?: () => void;
  settled?: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ThreadResumeResponse {
  thread: { id: string; status: ThreadStatus; turns?: unknown[] };
}

interface TurnStartResponse {
  turn: { id: string; status: string };
}

interface ThreadReadResponse {
  thread: { turns?: unknown[] };
}

export interface AppServerTurnManagerOptions {
  activityCoalesceMs?: number;
  now?: () => number;
}

const DEFAULT_ACTIVITY_COALESCE_MS = 1_000;
const MAX_PROVISIONAL_NOTIFICATIONS = 256;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "aborted"]);

export class AppServerTurnManager {
  private readonly threads = new Map<string, ThreadState>();
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeDisconnect: () => void;
  private readonly scheduler: TurnScheduler;
  private readonly activityCoalesceMs: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(
    private readonly client: AppServerRequestClient,
    maxActiveTopics = 4,
    options: AppServerTurnManagerOptions = {},
  ) {
    this.scheduler = new TurnScheduler(maxActiveTopics);
    this.activityCoalesceMs = nonNegativeInterval(
      options.activityCoalesceMs ?? DEFAULT_ACTIVITY_COALESCE_MS,
    );
    this.now = options.now ?? Date.now;
    this.unsubscribeNotification = client.onNotification((notification) =>
      this.handleNotification(notification),
    );
    this.unsubscribeDisconnect = client.onDisconnect(() => this.handleDisconnect());
  }

  runTurn(request: AppServerTurnRequest): Promise<void> {
    if (this.disposed) return Promise.reject(disposedError());
    return new Promise<void>((resolve, reject) => {
      const job: TurnJob = { request, resolve, reject };
      void this.enqueue(job).catch((error) => this.rejectJob(job, asError(error)));
    });
  }

  recoverTurn(request: AppServerTurnRequest, turnId: string): Promise<void> {
    if (this.disposed) return Promise.reject(disposedError());
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
    this.assertNotDisposed();
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

    this.assertNotDisposed();
    const response = await this.client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
    });
    this.assertNotDisposed();
    this.getThreadState(threadId).status = response.thread.status.type;
  }

  trackThread(
    threadId: string,
    status: ThreadStatus["type"],
    latestTurnId?: string | null,
  ): void {
    this.assertNotDisposed();
    const state = this.getThreadState(threadId);
    state.status = status;
    if (latestTurnId !== undefined) {
      if (latestTurnId === null) {
        state.latestTurnId = null;
      } else {
        const validated = boundedNonblankString(latestTurnId, 512);
        if (!validated) throw new Error("latestTurnId must be a bounded non-empty string or null");
        state.latestTurnId = validated;
      }
      state.latestTurnKnown = true;
      state.externalActiveTurnId = undefined;
    }
  }

  async cancelTurn(threadId: string, callbacks: AppServerTurnCallbacks): Promise<void> {
    this.assertNotDisposed();
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

    const runningJob = state.activeJob ?? state.startingJob;
    if (runningJob?.request.callbacks === callbacks && runningJob.turnId) {
      await this.client.request("turn/interrupt", {
        threadId,
        turnId: runningJob.turnId,
      });
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.assertNotDisposed();
    await this.client.request("turn/interrupt", { threadId, turnId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeNotification();
    this.unsubscribeDisconnect();
    const error = disposedError();
    for (const state of this.threads.values()) {
      if (state.scheduledJob?.schedulerCallbacks && !state.activeJob && !state.startingJob) {
        this.scheduler.cancel(
          state.scheduledJob.request.threadId,
          state.scheduledJob.schedulerCallbacks,
        );
      }
      const jobs = new Set(
        [state.activeJob, state.startingJob, state.scheduledJob, ...state.queue].filter(
          (job): job is TurnJob => Boolean(job),
        ),
      );
      for (const job of jobs) {
        this.rejectJob(job, error);
        this.releaseJobSlot(job);
      }
      state.queue.length = 0;
      state.activeJob = undefined;
      state.startingJob = undefined;
      state.scheduledJob = undefined;
      state.initializePromise = undefined;
      state.reconcilePromise = undefined;
    }
    this.threads.clear();
  }

  private async enqueue(job: TurnJob): Promise<void> {
    this.assertNotDisposed();
    const state = this.getThreadState(job.request.threadId);
    if (state.dispatchAmbiguous) {
      state.queue.push(job);
      this.notifyQueued(job, {
        position: state.queue.length,
        reason: "thread-active",
      });
      return;
    }
    await this.ensureThread(job.request, state);
    this.assertNotDisposed();

    if (
      state.status === "idle" &&
      !state.activeJob &&
      !state.startingJob &&
      !state.scheduledJob &&
      state.queue.length === 0
    ) {
      this.scheduleJob(state, job);
      return;
    }

    state.queue.push(job);
    this.notifyQueued(job, {
      position: state.queue.length,
      reason: "thread-active",
    });
  }

  private getThreadState(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        status: "unknown",
        dispatchAmbiguous: false,
        latestTurnId: null,
        latestTurnKnown: false,
        queue: [],
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private async ensureThread(request: AppServerTurnRequest, state: ThreadState): Promise<void> {
    this.assertNotDisposed();
    if (state.status !== "unknown") {
      return;
    }
    if (state.initializePromise) {
      await state.initializePromise;
      this.assertNotDisposed();
      return;
    }

    state.initializePromise = (async () => {
      await this.client.connect();
      this.assertNotDisposed();
      const response = await this.client.request<ThreadResumeResponse>("thread/resume", {
        threadId: request.threadId,
      });
      this.assertNotDisposed();
      state.status = response.thread.status.type;
      if (Array.isArray(response.thread.turns)) {
        state.latestTurnId = latestTurnIdFromTurns(response.thread.turns);
        state.latestTurnKnown = true;
      }
    })();

    try {
      await state.initializePromise;
    } finally {
      if (!this.disposed) state.initializePromise = undefined;
    }
  }

  private scheduleJob(state: ThreadState, job: TurnJob): void {
    if (state.dispatchAmbiguous) {
      state.queue.unshift(job);
      this.notifyQueued(job, { position: 1, reason: "thread-active" });
      return;
    }
    state.scheduledJob = job;
    const slot = deferred();
    job.releaseSlot = slot.resolve;
    const schedulerCallbacks: TurnSchedulerCallbacks = {
      onQueued: ({ position, active, limit }) => {
        this.notifyQueued(job, {
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
        if (this.disposed || job.settled) return;
        if (state.dispatchAmbiguous) {
          state.scheduledJob = undefined;
          job.releaseSlot = undefined;
          state.queue.unshift(job);
          this.notifyQueued(job, { position: 1, reason: "thread-active" });
          return;
        }
        if (state.status === "unknown" && !state.activeJob && !state.startingJob) {
          try {
            await this.ensureThread(job.request, state);
          } catch (error) {
            if (this.disposed || job.settled) return;
            state.scheduledJob = undefined;
            job.releaseSlot = undefined;
            this.rejectJob(job, asError(error));
            void this.drain(state);
            return;
          }
        }
        if (this.disposed || job.settled) return;
        if (
          state.dispatchAmbiguous ||
          state.status !== "idle" ||
          state.activeJob ||
          state.startingJob
        ) {
          state.scheduledJob = undefined;
          job.releaseSlot = undefined;
          state.queue.unshift(job);
          this.notifyQueued(job, { position: 1, reason: "thread-active" });
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
    if (this.disposed || job.settled) return false;
    state.startingJob = job;
    state.status = "active";

    try {
      const response = await this.startTurnWithRecovery(state, job);
      if (this.disposed || job.settled) return false;
      this.confirmTurnIdentity(state, job, response.turn.id);
      if (this.disposed || job.settled) return false;
      state.activeJob = job;
      state.startingJob = undefined;
      return true;
    } catch (error) {
      if (this.disposed || job.settled) return false;
      if (isAppServerFailure(error, "APP_SERVER_NOT_SENT")) {
        state.startingJob = undefined;
        state.scheduledJob = undefined;
        state.status = "unknown";
        state.queue.unshift(job);
        this.notifyQueued(job, {
          position: 1,
          reason: "app-server-unavailable",
        });
        this.releaseJobSlot(job);
        return false;
      }
      if (isAppServerFailure(error, "APP_SERVER_ACCEPTANCE_UNKNOWN")) {
        state.startingJob = undefined;
        state.scheduledJob = undefined;
        state.status = "active";
        state.dispatchAmbiguous = true;
        this.rejectJob(job, asError(error));
        this.releaseJobSlot(job);
        return false;
      }
      if (isConnectionClosedError(error)) {
        try {
          const reconciliation = await this.reconcileLostTurnStart(state, job);
          if (this.disposed) return false;
          state.startingJob = undefined;
          if (reconciliation === "active") {
            if (job.settled) return false;
            state.activeJob = job;
            return true;
          }
          state.scheduledJob = undefined;
          this.releaseJobSlot(job);
          void this.drain(state);
          return false;
        } catch (reconciliationError) {
          if (this.disposed || job.settled) return false;
          state.startingJob = undefined;
          state.scheduledJob = undefined;
          state.status = "active";
          state.dispatchAmbiguous = true;
          this.rejectJob(job, asError(reconciliationError));
          this.releaseJobSlot(job);
          return false;
        }
      }
      state.startingJob = undefined;
      if (isBusyError(error)) {
        state.scheduledJob = undefined;
        const externalCompleted = job.provisionalExternalCompleted === true;
        job.provisionalExternalCompleted = undefined;
        state.status = externalCompleted ? "idle" : "active";
        state.queue.unshift(job);
        this.notifyQueued(job, { position: 1, reason: "thread-active" });
        this.releaseJobSlot(job);
        if (externalCompleted) void this.drain(state);
        return false;
      }
      state.scheduledJob = undefined;
      state.status = isThreadNotFoundError(error) ? "unknown" : "idle";
      this.rejectJob(job, asError(error));
      this.releaseJobSlot(job);
      void this.drain(state);
      return false;
    }
  }

  private async reconcileLostTurnStart(
    state: ThreadState,
    job: TurnJob,
  ): Promise<"active" | "settled"> {
    try {
      const resumed = await this.client.request<ThreadResumeResponse>("thread/resume", {
        threadId: job.request.threadId,
      });
      this.assertNotDisposed();
      state.status = resumed.thread.status.type;
      const response = await this.client.request<ThreadReadResponse>("thread/read", {
        threadId: job.request.threadId,
        includeTurns: true,
      });
      this.assertNotDisposed();
      if (!job.previousTurnKnown) {
        throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
      }
      const candidates = turnsAfter(response.thread.turns, job.previousTurnId ?? null);
      if (candidates.length !== 1) {
        throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
      }
      const turn = candidates[0]!;
      const turnId = boundedNonblankString(turn.id, 512);
      if (!turnId) throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
      const status = readString(turn, "status");
      if (status === "inProgress" || status === "active") {
        this.confirmTurnIdentity(state, job, turnId);
        if (job.settled) return "settled";
        state.status = "active";
        return "active";
      }
      if (job.provisionalTurnId && job.provisionalTurnId !== turnId) {
        throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
      }
      job.provisionalTurnId = undefined;
      job.provisionalNotifications = undefined;
      this.bindTurnIdentity(state, job, turnId);
      if (this.disposed || job.settled) return "settled";
      state.status = "idle";
      try {
        this.replayTurn(job, turn);
      } catch (error) {
        this.rejectJob(job, asError(error));
      }
      return "settled";
    } catch {
      if (this.disposed) throw disposedError();
      state.status = "unknown";
      throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
    }
  }

  private async startTurnWithRecovery(
    state: ThreadState,
    job: TurnJob,
  ): Promise<TurnStartResponse> {
    const params = {
      threadId: job.request.threadId,
      input: job.request.input,
      cwd: job.request.cwd,
      model: job.request.model,
      effort: job.request.reasoningEffort,
      approvalPolicy: job.request.approvalPolicy,
      sandboxPolicy: toSandboxPolicy(job.request.sandbox, job.request.cwd),
    };

    try {
      return await this.dispatchTurnStart(state, job, params);
    } catch (error) {
      if (!isThreadNotFoundError(error)) throw error;
    }

    this.assertNotDisposed();
    let resumed: ThreadResumeResponse;
    try {
      resumed = await this.client.request<ThreadResumeResponse>("thread/resume", {
        threadId: job.request.threadId,
      });
    } catch (error) {
      if (
        isAppServerFailure(error, "APP_SERVER_NOT_SENT") ||
        isAppServerFailure(error, "APP_SERVER_ACCEPTANCE_UNKNOWN")
      ) {
        throw new AppServerRequestError("APP_SERVER_NOT_SENT");
      }
      throw error;
    }
    this.assertNotDisposed();
    state.status = resumed.thread.status.type;
    if (Array.isArray(resumed.thread.turns)) {
      state.latestTurnId = latestTurnIdFromTurns(resumed.thread.turns);
      state.latestTurnKnown = true;
    }
    return this.dispatchTurnStart(state, job, params);
  }

  private async dispatchTurnStart(
    state: ThreadState,
    job: TurnJob,
    params: object,
  ): Promise<TurnStartResponse> {
    if (job.previousTurnId === undefined) {
      job.previousTurnId = state.latestTurnId;
      job.previousTurnKnown = state.latestTurnKnown;
    }
    const attempt = (job.dispatchAttempt ?? 0) + 1;
    job.dispatchAttempt = attempt;
    job.dispatchWritten = false;
    this.notifyObserver(() => job.request.callbacks.onDispatching?.({
      previousTurnId: job.previousTurnId!,
      attempt,
    }));
    this.assertNotDisposed();
    if (job.settled) throw disposedError();

    let value: unknown;
    try {
      value = await this.client.request<unknown>(
        "turn/start",
        params,
        {
          beforeSend: () => job.request.callbacks.beforeDispatchWrite?.({
            threadId: job.request.threadId,
            previousTurnId: job.previousTurnId!,
            previousTurnKnown: job.previousTurnKnown === true,
            attempt,
          }),
          onWritten: () => {
            job.dispatchWritten = true;
            this.notifyObserver(job.request.callbacks.onDispatchWritten);
          },
        },
      );
    } catch (error) {
      if (isBusyError(error) && job.provisionalTurnId) {
        const provisionalTurnId = job.provisionalTurnId;
        const completed = job.provisionalNotifications?.some(({ notification }) => {
          if (notification.method !== "turn/completed") return false;
          const notificationParams = asRecord(notification.params);
          const completedTurnId = boundedNonblankString(notificationParams.turnId, 512) ??
            boundedNonblankString(asRecord(notificationParams.turn).id, 512);
          return completedTurnId === provisionalTurnId;
        }) === true;
        if (completed) {
          state.latestTurnId = provisionalTurnId;
          state.latestTurnKnown = true;
          state.externalActiveTurnId = undefined;
          job.provisionalExternalCompleted = true;
        } else {
          state.externalActiveTurnId = provisionalTurnId;
        }
      }
      if (
        isAppServerFailure(error, "APP_SERVER_NOT_SENT") ||
        isAppServerFailure(error, "APP_SERVER_REJECTED") ||
        isBusyError(error) ||
        isThreadNotFoundError(error)
      ) {
        job.provisionalTurnId = undefined;
        job.provisionalNotifications = undefined;
        job.previousTurnId = undefined;
        job.previousTurnKnown = undefined;
      }
      throw error;
    }
    const response = turnStartResponse(value);
    if (job.turnId && job.turnId !== response.turn.id) {
      throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
    }
    return response;
  }

  private confirmTurnIdentity(state: ThreadState, job: TurnJob, turnId: string): void {
    if (job.provisionalTurnId && job.provisionalTurnId !== turnId) {
      throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
    }
    const buffered = job.provisionalNotifications ?? [];
    job.provisionalTurnId = undefined;
    job.provisionalNotifications = undefined;
    this.bindTurnIdentity(state, job, turnId);
    if (this.disposed || job.settled) return;
    for (const { notification, receiptAt } of buffered) {
      this.handleNotification(notification, receiptAt);
      if (this.disposed || job.settled) return;
    }
  }

  private bindTurnIdentity(state: ThreadState, job: TurnJob, turnId: string): void {
    if (job.turnId && job.turnId !== turnId) {
      throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
    }
    job.turnId = turnId;
    state.latestTurnId = turnId;
    state.latestTurnKnown = true;
    state.externalActiveTurnId = undefined;
    if (job.startedNotified) return;
    job.startedNotified = true;
    this.notifyObserver(() => job.request.callbacks.onStarted?.(turnId));
  }

  private bindRecoveredTurnIdentity(state: ThreadState, job: TurnJob, turnId: string): void {
    if (job.turnId && job.turnId !== turnId) {
      throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
    }
    job.turnId = turnId;
    if (!state.latestTurnKnown) {
      state.latestTurnId = turnId;
      state.latestTurnKnown = true;
    }
    if (job.startedNotified) return;
    job.startedNotified = true;
    this.notifyObserver(() => job.request.callbacks.onStarted?.(turnId));
  }

  private notifyQueued(job: TurnJob, status: AppServerQueueStatus): void {
    try {
      job.request.callbacks.onQueued?.(status);
    } catch {
      // Queue observers cannot corrupt job or scheduler state.
    }
  }

  private notifyObserver(observer: (() => void) | undefined): void {
    try {
      observer?.();
    } catch {
      // Observers cannot alter execution state or scheduler ownership.
    }
  }

  private handleDisconnect(): void {
    if (this.disposed) return;
    for (const state of this.threads.values()) {
      if (state.activeJob?.turnId) {
        state.status = "unknown";
        this.reconcileActiveJob(state, state.activeJob);
        continue;
      }
      if (state.activeJob || state.startingJob) continue;

      state.status = "unknown";
      if (!state.scheduledJob && state.queue.length > 0) void this.drain(state);
    }
  }

  private reconcileActiveJob(state: ThreadState, job: TurnJob): void {
    if (state.reconcilePromise) return;

    state.reconcilePromise = this.reconcileActiveJobAfterDisconnect(state, job).finally(() => {
      if (!this.disposed) state.reconcilePromise = undefined;
    });
  }

  private async reconcileActiveJobAfterDisconnect(
    state: ThreadState,
    job: TurnJob,
  ): Promise<void> {
    try {
      const resumed = await this.client.request<ThreadResumeResponse>("thread/resume", {
        threadId: job.request.threadId,
      });
      if (this.disposed || job.settled || state.activeJob !== job) return;

      state.status = resumed.thread.status.type;
      if (state.status === "active") {
        const response = await this.client.request<ThreadReadResponse>("thread/read", {
          threadId: job.request.threadId,
          includeTurns: true,
        });
        if (this.disposed || job.settled || state.activeJob !== job) return;

        const activeTurnId = findActiveTurnId(response);
        if (activeTurnId === job.turnId) return;

        state.activeJob = undefined;
        state.startingJob = undefined;
        state.scheduledJob = undefined;
        const detail = activeTurnId
          ? `thread resumed with different active turn ${activeTurnId}`
          : "thread resumed active but the original active turn could not be confirmed";
        this.rejectJob(
          job,
          new Error(
            `Codex connection was lost while recovering turn ${job.turnId}: ${detail}. ` +
            "Reopen the thread to recover the original result.",
          ),
        );
        this.releaseJobSlot(job);
        void this.drain(state);
        return;
      }

      state.activeJob = undefined;
      state.startingJob = undefined;
      state.scheduledJob = undefined;
      try {
        await this.replayStoredTurn(state, job);
      } catch (error) {
        this.rejectJob(
          job,
          new Error(
            `Codex connection was lost while recovering turn ${job.turnId}: ${asError(error).message}`,
          ),
        );
      }
      this.releaseJobSlot(job);
      void this.drain(state);
    } catch (error) {
      if (this.disposed || job.settled || state.activeJob !== job) return;
      state.activeJob = undefined;
      state.startingJob = undefined;
      state.scheduledJob = undefined;
      state.status = "unknown";
      this.rejectJob(
        job,
        new Error(
          `Codex connection was lost while recovering turn ${job.turnId}: ${asError(error).message}`,
        ),
      );
      this.releaseJobSlot(job);
      void this.drain(state);
    }
  }

  private handleNotification(
    notification: AppServerNotification,
    receiptAt = this.now(),
  ): void {
    if (this.disposed) return;
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
      this.emitActivity(state.activeJob, notification, params, receiptAt);
      if (this.disposed) return;
      const status = asRecord(params.status);
      const statusType = readString(status, "type") as ThreadState["status"] | undefined;
      if (statusType) {
        state.status = statusType;
        if (statusType === "idle") {
          const active = state.activeJob;
          if (active?.errorObserved) this.reconcileTerminalAfterError(state, active);
          void this.drain(state);
        }
      }
      return;
    }

    const turnId = boundedNonblankString(params.turnId, 512) ??
      boundedNonblankString(asRecord(params.turn).id, 512);
    if (!turnId) {
      return;
    }

    let job = findJobForTurn(state, turnId);
    if (
      !job &&
      state.startingJob &&
      !state.startingJob.turnId &&
      state.startingJob.dispatchWritten
    ) {
      const startingJob = state.startingJob;
      if (notification.method === "turn/started" && !startingJob.provisionalTurnId) {
        startingJob.provisionalTurnId = turnId;
      }
      if (startingJob.provisionalTurnId === turnId) {
        const buffered = startingJob.provisionalNotifications ?? [];
        startingJob.provisionalNotifications = buffered;
        if (buffered.length >= MAX_PROVISIONAL_NOTIFICATIONS) {
          state.startingJob = undefined;
          state.scheduledJob = undefined;
          state.status = "active";
          state.dispatchAmbiguous = true;
          this.rejectJob(
            startingJob,
            new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN"),
          );
          this.releaseJobSlot(startingJob);
          return;
        }
        buffered.push({ notification, receiptAt });
        return;
      }
    }
    if (notification.method === "turn/started") {
      if (
        !job &&
        !state.activeJob &&
        !state.startingJob &&
        !state.scheduledJob &&
        !state.dispatchAmbiguous
      ) {
        state.externalActiveTurnId = turnId;
      }
      this.emitActivity(job, notification, params, receiptAt);
      return;
    }
    if (notification.method === "turn/completed") {
      const completesObservedExternal = !job && state.externalActiveTurnId === turnId;
      if (job || completesObservedExternal || (state.latestTurnKnown && state.latestTurnId === null)) {
        state.latestTurnId = turnId;
        state.latestTurnKnown = true;
      }
      if (completesObservedExternal) state.externalActiveTurnId = undefined;
      this.emitActivity(job, notification, params, receiptAt);
      if (this.disposed || job?.settled) return;
      const eventAt = isUtcMilliseconds(notification.emittedAtMs)
        ? notification.emittedAtMs
        : receiptAt;
      this.completeTurn(state, job, params, eventAt);
      return;
    }
    if (!job) {
      return;
    }

    this.emitActivity(job, notification, params, receiptAt);
    if (this.disposed || job.settled) return;
    this.routeJobNotification(state, job, notification.method, params);
  }

  private emitActivity(
    job: TurnJob | undefined,
    notification: AppServerNotification,
    params: Record<string, unknown>,
    receiptAt: number,
  ): void {
    if (!job || job.settled) return;
    const mapping = mapAppServerActivity(notification.method, params);
    if (!mapping) return;
    const previous = job.lastActivityObservation;
    if (
      mapping.sample &&
      previous?.sample === true &&
      previous?.activity === mapping.activity &&
      receiptAt - previous.receiptAt < this.activityCoalesceMs
    ) {
      return;
    }
    job.lastActivityObservation = {
      activity: mapping.activity,
      receiptAt,
      sample: mapping.sample,
    };
    const eventAt = isUtcMilliseconds(notification.emittedAtMs)
      ? notification.emittedAtMs
      : receiptAt;
    this.notifyObserver(() => job.request.callbacks.onActivity?.({
      activity: mapping.activity,
      eventAt,
      method: notification.method,
    }));
  }

  private async recoverJob(job: TurnJob): Promise<void> {
    this.assertNotDisposed();
    const state = this.getThreadState(job.request.threadId);
    await this.ensureThread(job.request, state);
    this.assertNotDisposed();
    const recoveredTurnId = boundedNonblankString(job.turnId, 512);
    if (!recoveredTurnId) throw new Error("Recovered turn id must be a bounded non-empty string");
    if (state.activeJob || state.startingJob || state.scheduledJob) {
      throw new Error(`Cannot recover turn ${job.turnId ?? "unknown"}: thread already tracked`);
    }
    state.startingJob = job;
    this.bindRecoveredTurnIdentity(state, job, recoveredTurnId);
    if (this.disposed || job.settled) return;

    if (state.status !== "active") {
      try {
        await this.replayStoredTurn(state, job);
      } finally {
        if (!this.disposed && state.startingJob === job) {
          state.startingJob = undefined;
          void this.drain(state);
        }
      }
      return;
    }

    const slot = deferred();
    job.releaseSlot = slot.resolve;
    const schedulerCallbacks: TurnSchedulerCallbacks = {};
    job.schedulerCallbacks = schedulerCallbacks;
    state.activeJob = job;
    state.startingJob = undefined;
    state.scheduledJob = job;
    void this.scheduler.run(
      job.request.threadId,
      () => slot.promise,
      schedulerCallbacks,
    ).catch((error) => {
      if (!job.settled) this.rejectJob(job, asError(error));
    });
  }

  private async replayStoredTurn(state: ThreadState, job: TurnJob): Promise<void> {
    const response = await this.client.request<ThreadReadResponse>("thread/read", {
      threadId: job.request.threadId,
      includeTurns: true,
    });
    this.assertNotDisposed();
    const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
    state.latestTurnId = latestTurnIdFromTurns(turns);
    state.latestTurnKnown = true;
    const turn = turns
      .map(asRecord)
      .find((entry) => boundedNonblankString(entry.id, 512) === job.turnId);
    if (!turn) throw new Error(`No rollout found for turn ${job.turnId ?? "unknown"}`);

    this.replayTurn(job, turn);
  }

  private replayTurn(job: TurnJob, turn: Record<string, unknown>): void {
    const status = readString(turn, "status");
    if (status) this.notifyObserver(() => job.request.callbacks.onTurnOutcome?.({ status, eventAt: this.now() }));
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
    this.notifyObserver(job.request.callbacks.onAgentEnd);
    this.resolveJob(job);
  }

  private routeJobNotification(
    state: ThreadState,
    job: TurnJob,
    method: string,
    params: Record<string, unknown>,
  ): void {
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
      job.errorObserved = true;
      if (state.status === "idle") this.reconcileTerminalAfterError(state, job);
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

  private reconcileTerminalAfterError(state: ThreadState, job: TurnJob): void {
    if (job.terminalReconciliation || job.settled || !job.turnId) return;
    const promise = this.reconcileTerminalAfterErrorNow(state, job).finally(() => {
      if (job.terminalReconciliation === promise) job.terminalReconciliation = undefined;
    });
    job.terminalReconciliation = promise;
    void promise.catch(() => undefined);
  }

  private async reconcileTerminalAfterErrorNow(state: ThreadState, job: TurnJob): Promise<void> {
    const turnId = job.turnId;
    if (!turnId) return;
    let response: ThreadReadResponse;
    try {
      response = await this.client.request<ThreadReadResponse>("thread/read", {
        threadId: job.request.threadId,
        includeTurns: true,
      });
    } catch {
      return;
    }
    if (this.disposed || job.settled || state.activeJob !== job) return;
    const turns = Array.isArray(response.thread?.turns) ? response.thread.turns : [];
    const exact = turns.map(asRecord)
      .filter((turn) => boundedNonblankString(turn.id, 512) === turnId);
    if (exact.length !== 1) return;
    const turn = exact[0]!;
    const status = boundedNonblankString(turn.status, 128);
    if (!status || !TERMINAL_TURN_STATUSES.has(status)) return;

    state.latestTurnId = turnId;
    state.latestTurnKnown = true;
    state.status = "idle";
    state.activeJob = undefined;
    state.startingJob = undefined;
    state.scheduledJob = undefined;
    try {
      const replay = Object.hasOwn(turn, "error") || !job.errorMessage
        ? turn : { ...turn, error: { message: job.errorMessage } };
      this.replayTurn(job, replay);
    } catch (error) {
      this.rejectJob(job, asError(error));
    } finally {
      this.releaseJobSlot(job);
      void this.drain(state);
    }
  }

  private completeTurn(
    state: ThreadState,
    job: TurnJob | undefined,
    params: Record<string, unknown>,
    eventAt: number,
  ): void {
    if (this.disposed) return;
    if (!job && state.dispatchAmbiguous) return;
    state.status = "idle";
    if (!job) {
      void this.drain(state);
      return;
    }

    state.activeJob = undefined;
    state.startingJob = undefined;
    state.scheduledJob = undefined;
    const turn = asRecord(params.turn);
    const status = boundedNonblankString(turn.status, 128);
    if (status) this.notifyObserver(() => job.request.callbacks.onTurnOutcome?.({ status, eventAt }));
    if (status === "completed") {
      if (job.usage) {
        this.notifyObserver(() => job.request.callbacks.onTurnComplete?.(job.usage!));
      }
      this.notifyObserver(job.request.callbacks.onAgentEnd);
      this.resolveJob(job);
    } else {
      const message = job.errorMessage ?? readString(asRecord(turn.error), "message") ?? `Codex turn ${status ?? "failed"}`;
      this.rejectJob(job, new Error(message));
    }
    this.releaseJobSlot(job);
    void this.drain(state);
  }

  private async drain(state: ThreadState): Promise<void> {
    if (this.disposed) return;
    if (state.dispatchAmbiguous) return;
    if (
      state.activeJob ||
      state.startingJob ||
      state.scheduledJob ||
      state.initializePromise
    ) {
      return;
    }

    if (state.status === "unknown") {
      const queued = state.queue[0];
      if (!queued) return;
      try {
        await this.ensureThread(queued.request, state);
      } catch (error) {
        if (this.disposed) return;
        if (state.queue[0] === queued) state.queue.shift();
        this.rejectJob(queued, asError(error));
        void this.drain(state);
        return;
      }
    }

    if (state.status !== "idle" || state.activeJob || state.startingJob || state.scheduledJob) {
      return;
    }
    const next = state.queue.shift();
    if (next) {
      this.scheduleJob(state, next);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw disposedError();
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

function findActiveTurnId(response: ThreadReadResponse): string | undefined {
  const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
  for (const value of turns) {
    const turn = asRecord(value);
    const status = readString(turn, "status");
    if (status === "inProgress" || status === "active") {
      return boundedNonblankString(turn.id, 512);
    }
  }
  return undefined;
}

function latestTurnIdFromTurns(turns: unknown[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const id = boundedNonblankString(asRecord(turns[index]).id, 512);
    if (id) return id;
  }
  return null;
}

function turnsAfter(
  value: unknown,
  previousTurnId: string | null,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const turns = value.map(asRecord);
  if (previousTurnId === null) return turns;
  const previousIndex = turns.findIndex(
    (turn) => boundedNonblankString(turn.id, 512) === previousTurnId,
  );
  return previousIndex < 0 ? [] : turns.slice(previousIndex + 1);
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
  if (appServerReason(error) === "THREAD_BUSY") return true;
  const message = asError(error).message
    .replace(/ \(code -?\d+\)$/, "")
    .trim()
    .toLowerCase();
  return (
    message === "thread busy" ||
    message === "thread has an active turn" ||
    message === "turn is already running"
  );
}

function isThreadNotFoundError(error: unknown): boolean {
  if (appServerReason(error) === "THREAD_NOT_FOUND") return true;
  return /^thread not found: .+ \(code -32600\)$/i.test(asError(error).message);
}

function isAppServerFailure(error: unknown, code: string): boolean {
  return asRecord(error).code === code;
}

function appServerReason(error: unknown): string | undefined {
  const value = asRecord(error).reason;
  return typeof value === "string" ? value : undefined;
}

function isConnectionClosedError(error: unknown): boolean {
  return asError(error).message === "App-server connection closed";
}

function disposedError(): Error {
  return new Error("App-server turn manager disposed");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function turnStartResponse(value: unknown): TurnStartResponse {
  if (!isPlainRecord(value)) throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
  const turn = value.turn;
  if (!isPlainRecord(turn)) throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
  const id = boundedNonblankString(turn.id, 512);
  const status = boundedNonblankString(turn.status, 128);
  if (!id || !status) throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
  return { turn: { id, status } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function boundedNonblankString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length > maxLength || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function isUtcMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonNegativeInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("activityCoalesceMs must be a non-negative safe integer");
  }
  return value;
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
