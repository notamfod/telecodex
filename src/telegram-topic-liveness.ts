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
  const inFlight = new Map<string, SharedRequest>();

  return (
    destination: ForumTopicDestination,
    callerSignal?: AbortSignal,
  ): Promise<boolean> => {
    validateDestination(destination);
    const key = `${destination.chatId}:${destination.messageThreadId}`;
    const currentTime = now();
    for (const [cachedKey, cachedValue] of cache) {
      if (cachedValue.expiresAt <= currentTime) cache.delete(cachedKey);
    }
    const cached = cache.get(key);
    if (cached && currentTime < cached.expiresAt) return Promise.resolve(cached.value);
    let request = inFlight.get(key);
    if (!request) {
      request = createSharedRequest(
        key,
        destination,
        options.sendChatAction,
        timeoutMs,
        cache,
        cacheTtlMs,
        now,
        inFlight,
      );
    }
    return subscribe(request, callerSignal);
  };
}

interface SharedRequest {
  readonly promise: Promise<boolean>;
  readonly controller: AbortController;
  readonly subscribers: Set<symbol>;
  cancel(): void;
  settled: boolean;
}

function createSharedRequest(
  key: string,
  destination: ForumTopicDestination,
  sendChatAction: ForumTopicLivenessOptions["sendChatAction"],
  timeoutMs: number,
  cache: Map<string, { readonly value: boolean; readonly expiresAt: number }>,
  cacheTtlMs: number,
  now: () => number,
  inFlight: Map<string, SharedRequest>,
): SharedRequest {
  const controller = new AbortController();
  let resolveRequest!: (value: boolean) => void;
  let rejectRequest!: (error: unknown) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request: SharedRequest = {
    promise: new Promise<boolean>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    }),
    controller,
    subscribers: new Set<symbol>(),
    cancel: () => {},
    settled: false,
  };
  void request.promise.catch(() => {});
  inFlight.set(key, request);
  const finish = (complete: () => void) => {
    if (request.settled) return;
    request.settled = true;
    if (inFlight.get(key) === request) inFlight.delete(key);
    complete();
  };
  request.cancel = () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    finish(() => rejectRequest(new Error("Telegram topic probe aborted")));
  };
  timer = setTimeout(() => {
    controller.abort();
    finish(() => rejectRequest(new Error("Telegram topic probe timed out")));
  }, timeoutMs);
  const operation = (async () => {
      try {
        await sendChatAction(
          destination.chatId,
          "typing",
          { message_thread_id: destination.messageThreadId },
          controller.signal,
        );
        return true;
      } catch (error) {
        if (isClosedForumTopicError(error)) return true;
        if (isMissingForumTopicError(error)) return false;
        throw error;
      }
    })();
  operation.then(
      (value) => {
        clearTimeout(timer);
        finish(() => {
          cache.set(key, { value, expiresAt: now() + cacheTtlMs });
          resolveRequest(value);
        });
      },
      (error) => {
        clearTimeout(timer);
        finish(() => rejectRequest(error));
      },
  );
  return request;
}

function subscribe(request: SharedRequest, callerSignal?: AbortSignal): Promise<boolean> {
  const token = Symbol();
  request.subscribers.add(token);
  const subscription = new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = () => callerSignal?.removeEventListener("abort", abort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      request.subscribers.delete(token);
      cleanup();
      complete();
    };
    const abort = () => {
      finish(() => reject(new Error("Telegram topic probe aborted")));
      if (request.subscribers.size === 0 && !request.settled) {
        request.cancel();
      }
    };
    if (callerSignal?.aborted) {
      abort();
      return;
    }
    callerSignal?.addEventListener("abort", abort, { once: true });
    request.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
  void subscription.catch(() => {});
  return subscription;
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
