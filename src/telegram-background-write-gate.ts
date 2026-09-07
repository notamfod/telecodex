import { telegramRetryAfterMs } from "./telegram-rate-limit.js";

export type TelegramBackgroundPriority = "ordinary" | "urgent";

export interface TelegramBackgroundWriteGateOptions {
  maxPerWindow?: number;
  windowMs?: number;
  burst?: number;
  now?: () => number;
}

type QueuedOperation = {
  priority: TelegramBackgroundPriority;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  clearAdmissionCancellation?: () => void;
};

type StateTimerKind = "drain" | "cleanup";

type ChatState = {
  queue: QueuedOperation[];
  attemptStarts: number[];
  tokens: number;
  lastRefillAt: number;
  blockedUntil: number;
  inFlight: number;
  running: boolean;
  failed?: unknown;
  timer?: ReturnType<typeof setTimeout>;
  timerKind?: StateTimerKind;
};

const DEFAULT_MAX_PER_WINDOW = 12;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BURST = 3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DISPOSED_MESSAGE = "Telegram background write gate disposed";
const ADMISSION_CANCELLED_MESSAGE = "Telegram background write admission cancelled";

export class TelegramBackgroundWriteGateAdmissionCancelledError extends Error {
  constructor() {
    super(ADMISSION_CANCELLED_MESSAGE);
    this.name = "TelegramBackgroundWriteGateAdmissionCancelledError";
  }
}

export class TelegramBackgroundWriteGateDisposedError extends Error {
  constructor() {
    super(DISPOSED_MESSAGE);
  }
}

export class TelegramBackgroundWriteGate {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly burst: number;
  private readonly refillIntervalMs: number;
  private readonly clock: () => number;
  private readonly states = new Map<number, ChatState>();
  private lastClockReading?: number;
  private disposed = false;

  constructor(options: TelegramBackgroundWriteGateOptions = {}) {
    this.maxPerWindow = options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.burst = options.burst ?? DEFAULT_BURST;
    this.clock = options.now ?? (() => performance.now());

    assertPositiveSafeInteger("maxPerWindow", this.maxPerWindow);
    assertPositiveSafeInteger("windowMs", this.windowMs);
    assertPositiveSafeInteger("burst", this.burst);
    if (this.burst > this.maxPerWindow) {
      throw new Error("burst must be less than or equal to maxPerWindow");
    }
    if (typeof this.clock !== "function") {
      throw new Error("now must be a function");
    }

    this.refillIntervalMs = this.windowMs / this.maxPerWindow;
  }

  run<T>(
    chatId: number,
    priority: TelegramBackgroundPriority,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new TelegramBackgroundWriteGateDisposedError());
    if (signal?.aborted) {
      return Promise.reject(new TelegramBackgroundWriteGateAdmissionCancelledError());
    }
    if (!Number.isSafeInteger(chatId)) {
      return Promise.reject(new Error("chatId must be a safe integer"));
    }

    let state = this.states.get(chatId);
    if (!state) {
      let initialNow: number;
      try {
        initialNow = this.readNow();
      } catch (error) {
        return Promise.reject(error);
      }
      state = {
        queue: [],
        attemptStarts: [],
        tokens: this.burst,
        lastRefillAt: initialNow,
        blockedUntil: 0,
        inFlight: 0,
        running: false,
      };
      this.states.set(chatId, state);
    } else if (state.failed !== undefined) {
      return Promise.reject(state.failed);
    } else if (state.timerKind === "cleanup") {
      this.clearStateTimer(state);
    }

    const queued = new Promise<T>((resolve, reject) => {
      const entry: QueuedOperation = {
        priority,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
      };
      state.queue.push(entry);
      if (signal) {
        const cancel = () => this.cancelAdmission(chatId, state, entry);
        entry.clearAdmissionCancellation = () => signal.removeEventListener("abort", cancel);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
    this.startDrain(chatId, state);
    return queued;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const [chatId, state] of this.states) {
      this.clearStateTimer(state);
      for (const queued of state.queue.splice(0)) {
        queued.clearAdmissionCancellation?.();
        queued.reject(new TelegramBackgroundWriteGateDisposedError());
      }
      if (!state.running && state.inFlight === 0) this.states.delete(chatId);
    }
  }

  private startDrain(chatId: number, state: ChatState): void {
    if (this.disposed || state.failed !== undefined || state.running || state.timer) return;
    state.running = true;
    void this.drain(chatId, state).catch((error: unknown) => {
      this.failState(chatId, state, error);
    });
  }

  private async drain(chatId: number, state: ChatState): Promise<void> {
    while (!this.disposed && state.queue.length > 0) {
      const now = this.readNow();
      this.refreshPermits(state, now);
      const dueAt = Math.max(
        state.blockedUntil,
        this.rollingWindowDueAt(state, now),
        state.tokens >= 1 ? now : state.lastRefillAt + this.refillIntervalMs,
      );

      if (dueAt > now) {
        state.running = false;
        this.scheduleStateTimer(chatId, state, "drain", dueAt, now);
        return;
      }

      const urgentIndex = state.queue.findIndex((queued) => queued.priority === "urgent");
      const [queued] = state.queue.splice(urgentIndex >= 0 ? urgentIndex : 0, 1);
      queued.clearAdmissionCancellation?.();
      state.tokens -= 1;
      state.attemptStarts.push(now);
      state.inFlight += 1;

      let operation: Promise<unknown>;
      try {
        operation = Promise.resolve(queued.operation());
      } catch (error) {
        this.settleOperation(chatId, state, queued, { error });
        continue;
      }
      void operation.then(
        (value) => this.settleOperation(chatId, state, queued, { value }),
        (error: unknown) => this.settleOperation(chatId, state, queued, { error }),
      );
    }

    state.running = false;
    if (this.states.get(chatId) !== state) return;
    if (this.disposed || state.failed !== undefined) {
      if (state.inFlight === 0) this.states.delete(chatId);
      return;
    }
    this.scheduleIdleCleanup(chatId, state);
  }

  private settleOperation(
    chatId: number,
    state: ChatState,
    queued: QueuedOperation,
    outcome: { value: unknown } | { error: unknown },
  ): void {
    state.inFlight -= 1;
    let cooldownChanged = false;

    if ("error" in outcome) {
      try {
        const retryAfterMs = telegramRetryAfterMs(outcome.error);
        if (retryAfterMs !== undefined) {
          const blockedUntil = this.readNow() + retryAfterMs;
          if (blockedUntil > state.blockedUntil) {
            state.blockedUntil = blockedUntil;
            cooldownChanged = true;
          }
        }
      } catch (terminalError) {
        queued.reject(terminalError);
        this.failState(chatId, state, terminalError);
        return;
      }
      queued.reject(outcome.error);
    } else {
      queued.resolve(outcome.value);
    }

    if (this.states.get(chatId) !== state) return;
    if (this.disposed || state.failed !== undefined) {
      if (!state.running && state.inFlight === 0) this.states.delete(chatId);
      return;
    }
    try {
      if (cooldownChanged && state.timerKind === "drain") this.clearStateTimer(state);
      if (state.queue.length > 0) {
        this.startDrain(chatId, state);
        return;
      }
      if (!state.running) this.scheduleIdleCleanup(chatId, state);
    } catch (error) {
      this.failState(chatId, state, error);
    }
  }

  private readNow(): number {
    const value = this.clock();
    if (!Number.isFinite(value)) {
      throw new Error("now must return a finite number");
    }
    if (this.lastClockReading !== undefined && value < this.lastClockReading) {
      throw new Error("now must be nondecreasing");
    }
    this.lastClockReading = value;
    return value;
  }

  private scheduleIdleCleanup(chatId: number, state: ChatState): void {
    if (
      this.states.get(chatId) !== state
      || state.running
      || state.inFlight > 0
      || state.queue.length > 0
    ) return;

    const now = this.readNow();
    this.refreshPermits(state, now);
    if (this.canEvict(state, now)) {
      this.states.delete(chatId);
      return;
    }

    const historyExpiresAt = state.attemptStarts.length > 0
      ? state.attemptStarts[state.attemptStarts.length - 1] + this.windowMs
      : now;
    const tokensRefillAt = state.tokens < this.burst
      ? state.lastRefillAt + (this.burst - state.tokens) * this.refillIntervalMs
      : now;
    this.scheduleStateTimer(
      chatId,
      state,
      "cleanup",
      Math.max(state.blockedUntil, historyExpiresAt, tokensRefillAt),
      now,
    );
  }

  private canEvict(state: ChatState, now: number): boolean {
    return state.inFlight === 0
      && state.attemptStarts.length === 0
      && state.tokens === this.burst
      && state.blockedUntil <= now;
  }

  private scheduleStateTimer(
    chatId: number,
    state: ChatState,
    kind: StateTimerKind,
    dueAt: number,
    now: number,
  ): void {
    const delay = Math.min(Math.max(1, Math.ceil(dueAt - now)), MAX_TIMER_DELAY_MS);
    state.timerKind = kind;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.timerKind = undefined;
      if (this.disposed || this.states.get(chatId) !== state) return;
      if (kind === "drain") {
        this.startDrain(chatId, state);
        return;
      }
      try {
        this.scheduleIdleCleanup(chatId, state);
      } catch (error) {
        this.failState(chatId, state, error);
      }
    }, delay);
  }

  private clearStateTimer(state: ChatState): void {
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    state.timerKind = undefined;
  }

  private cancelAdmission(chatId: number, state: ChatState, queued: QueuedOperation): void {
    const index = state.queue.indexOf(queued);
    if (index < 0) return;
    state.queue.splice(index, 1);
    queued.clearAdmissionCancellation?.();
    queued.reject(new TelegramBackgroundWriteGateAdmissionCancelledError());
    if (this.states.get(chatId) !== state || this.disposed || state.failed !== undefined) return;
    if (state.queue.length > 0) return;
    if (state.timerKind === "drain") this.clearStateTimer(state);
    if (!state.running) {
      try {
        this.scheduleIdleCleanup(chatId, state);
      } catch (error) {
        this.failState(chatId, state, error);
      }
    }
  }

  private failState(chatId: number, state: ChatState, error: unknown): void {
    if (this.states.get(chatId) !== state) return;
    this.clearStateTimer(state);
    state.running = false;
    state.failed = error;
    for (const queued of state.queue.splice(0)) {
      queued.clearAdmissionCancellation?.();
      queued.reject(error);
    }
    if (state.inFlight === 0) this.states.delete(chatId);
  }

  private refreshPermits(state: ChatState, now: number): void {
    const cutoff = now - this.windowMs;
    while (state.attemptStarts.length > 0 && state.attemptStarts[0] <= cutoff) {
      state.attemptStarts.shift();
    }

    const wholeTokens = Math.floor((now - state.lastRefillAt) / this.refillIntervalMs);
    if (wholeTokens <= 0) return;
    state.tokens = Math.min(this.burst, state.tokens + wholeTokens);
    state.lastRefillAt += wholeTokens * this.refillIntervalMs;
  }

  private rollingWindowDueAt(state: ChatState, now: number): number {
    return state.attemptStarts.length >= this.maxPerWindow
      ? state.attemptStarts[0] + this.windowMs
      : now;
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
