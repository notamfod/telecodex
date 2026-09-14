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
  readonly requireDefinitiveErrors?: boolean;
}

/** A typing acknowledgement does not establish topic existence or openness. */
export type ForumTopicLiveness = "live" | "closed" | "missing" | "unknown";

export class ForumTopicAvailabilityUnknownError extends Error {
  constructor() { super("Telegram topic availability is unknown"); }
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

export function isMissingForumTopicError(error: unknown): boolean {
  return /message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(describe(error));
}

function isClosedForumTopicError(error: unknown): boolean {
  return /TOPIC_CLOSED|topic is closed/i.test(describe(error));
}

export function createForumTopicLivenessClassifier(
  options: ForumTopicLivenessOptions,
): (
  destination: ForumTopicDestination,
  callerSignal?: AbortSignal,
) => Promise<ForumTopicLiveness> {
  const now = options.now ?? Date.now;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  if (timeoutMs > 2_147_483_647) throw new Error("Invalid timeoutMs");
  const cacheTtlMs = positiveInteger(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "cacheTtlMs");
  const cache = new Map<
    string,
    { readonly value: ForumTopicLiveness; readonly expiresAt: number }
  >();
  const inFlight = new Map<string, SharedRequest>();

  return (
    destination: ForumTopicDestination,
    callerSignal?: AbortSignal,
  ): Promise<ForumTopicLiveness> => {
    validateDestination(destination);
    if (callerSignal?.aborted) {
      return Promise.reject(new Error("Telegram topic probe aborted"));
    }
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
        options.requireDefinitiveErrors ?? false,
      );
    }
    return subscribe(request, callerSignal);
  };
}

export function createForumTopicLivenessProbe(
  options: ForumTopicLivenessOptions,
): (
  destination: ForumTopicDestination,
  callerSignal?: AbortSignal,
) => Promise<boolean> {
  const classify = createForumTopicLivenessClassifier(options);
  return (destination, signal) => {
    const probe = classify(destination, signal)
      .then((liveness) => {
        if (liveness === "unknown") throw new ForumTopicAvailabilityUnknownError();
        return liveness !== "missing";
      });
    void probe.catch(() => {});
    return probe;
  };
}

interface SharedRequest {
  readonly promise: Promise<ForumTopicLiveness>;
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
  cache: Map<string, { readonly value: ForumTopicLiveness; readonly expiresAt: number }>,
  cacheTtlMs: number,
  now: () => number,
  inFlight: Map<string, SharedRequest>,
  requireDefinitiveErrors: boolean,
): SharedRequest {
  const controller = new AbortController();
  let resolveRequest!: (value: ForumTopicLiveness) => void;
  let rejectRequest!: (error: unknown) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request: SharedRequest = {
    promise: new Promise<ForumTopicLiveness>((resolve, reject) => {
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
        return "unknown" as const;
      } catch (error) {
        const description = requireDefinitiveErrors ? definitiveDescription(error) : error;
        if (description !== undefined && isClosedForumTopicError(description)) return "closed" as const;
        if (description !== undefined && isMissingForumTopicError(description)) return "missing" as const;
        throw error;
      }
    })();
  operation.then(
      (value) => {
        clearTimeout(timer);
        finish(() => {
          // Deleted topic IDs cannot become live again. Keep that definitive evidence;
          // the short TTL only throttles closed/unknown checks, never grants confidence.
          cache.set(key, { value, expiresAt: value === "missing" ? Infinity : now() + cacheTtlMs });
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

function subscribe(
  request: SharedRequest,
  callerSignal?: AbortSignal,
): Promise<ForumTopicLiveness> {
  const token = Symbol();
  request.subscribers.add(token);
  const subscription = new Promise<ForumTopicLiveness>((resolve, reject) => {
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

function definitiveDescription(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const response = error as { error_code?: unknown; description?: unknown };
  return response.error_code === 400 && typeof response.description === "string" ? response.description : undefined;
}
