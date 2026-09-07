export interface ForumTopicDestination {
  readonly chatId: number;
  readonly messageThreadId: number;
}

export interface ForumTopicLivenessOptions {
  readonly sendChatAction: (
    chatId: number,
    action: "typing",
    options: { readonly message_thread_id: number },
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

export function isMissingForumTopicError(error: unknown): boolean {
  return /message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(describe(error));
}

function isClosedForumTopicError(error: unknown): boolean {
  return /TOPIC_CLOSED|topic is closed/i.test(describe(error));
}

export function createForumTopicLivenessProbe(options: ForumTopicLivenessOptions) {
  const now = options.now ?? Date.now;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const cacheTtlMs = positiveInteger(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "cacheTtlMs");
  const cache = new Map<string, { readonly value: boolean; readonly expiresAt: number }>();
  const inFlight = new Map<string, Promise<boolean>>();

  return (
    destination: ForumTopicDestination,
    callerSignal?: AbortSignal,
  ): Promise<boolean> => {
    validateDestination(destination);
    const key = `${destination.chatId}:${destination.messageThreadId}`;
    const currentTime = now();
    const cached = cache.get(key);
    if (cached && currentTime < cached.expiresAt) return Promise.resolve(cached.value);
    if (cached) cache.delete(key);
    const pending = inFlight.get(key);
    if (pending) return abortForCaller(pending, callerSignal);

    let resolveRequest!: (value: boolean) => void;
    let rejectRequest!: (error: unknown) => void;
    const request = new Promise<boolean>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    void request.catch(() => {});
    inFlight.set(key, request);

    void withDeadline(async (signal) => {
      try {
        await options.sendChatAction(
          destination.chatId,
          "typing",
          { message_thread_id: destination.messageThreadId },
          signal,
        );
        return true;
      } catch (error) {
        if (isClosedForumTopicError(error)) return true;
        if (isMissingForumTopicError(error)) return false;
        throw error;
      }
    }, timeoutMs, callerSignal).then(
      (value) => {
        if (inFlight.get(key) === request) inFlight.delete(key);
        cache.set(key, { value, expiresAt: now() + cacheTtlMs });
        resolveRequest(value);
      },
      (error) => {
        if (inFlight.get(key) === request) inFlight.delete(key);
        rejectRequest(error);
      },
    );
    return request;
  };
}

function abortForCaller<T>(promise: Promise<T>, callerSignal?: AbortSignal): Promise<T> {
  if (callerSignal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => callerSignal.removeEventListener("abort", abort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const abort = () => finish(() => reject(new Error("Telegram topic probe aborted")));
    if (callerSignal.aborted) {
      abort();
      return;
    }
    callerSignal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const abort = () => {
      controller.abort();
      finish(() => reject(new Error("Telegram topic probe aborted")));
    };
    if (callerSignal?.aborted) {
      abort();
      return;
    }
    callerSignal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error("Telegram topic probe timed out")));
    }, timeoutMs);
    operation(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function validateDestination(destination: ForumTopicDestination): void {
  if (!Number.isSafeInteger(destination.chatId) || destination.chatId === 0) {
    throw new Error("Invalid Telegram chat id");
  }
  if (!Number.isSafeInteger(destination.messageThreadId) || destination.messageThreadId < 1) {
    throw new Error("Invalid Telegram topic id");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
