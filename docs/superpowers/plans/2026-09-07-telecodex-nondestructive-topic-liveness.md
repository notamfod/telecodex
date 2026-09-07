# TeleCodex Nondestructive Topic Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop background collectors from reopening and reclosing work topics, while preserving definitive missing-topic detection for explicit actions and recovery.

**Architecture:** A focused liveness module will classify an ephemeral `sendChatAction` request, own a three-second deadline, and coalesce checks per topic with a five-second cache. A dedicated grammY API without transformers will send bot probes in both legacy and canonical modes. Status Board and Dashboard rendering will project saved bindings without any Telegram liveness request. Existing explicit consumers will share the nondestructive probe, while intentional ticket and Status Board lifecycle mutations remain unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 20+, grammY 1.45, Vitest 3, Svelte 5, systemd, curl, rsync.

---

## File map

- Create `src/telegram-topic-liveness.ts`: nondestructive probe, error classification, deadline, single-flight, and short cache.
- Create `test/telegram-topic-liveness.test.ts`: focused behavioral contract for the probe.
- Create `src/telegram-topic-liveness-api.ts`: dedicated grammY API without retry transformers, exposing only `sendChatAction` and accepting client options for transport tests.
- Create `test/telegram-topic-liveness-api.test.ts`: fake-fetch HTTP/API 429 regression proving exactly one request and the original typed failure.
- Create `test/bot-topic-liveness.test.ts`: real bot callback routing through the injected dedicated API in both compatibility modes.
- Modify `src/projects.ts`: remove the reopen/close probe while retaining bound-topic selection and job partitioning.
- Modify `test/projects.test.ts`: remove tests that lock in the destructive implementation.
- Modify `src/telegram-topic-recovery-adapter.ts`: adapt recovery to `sendChatAction` instead of topic mutations.
- Modify `test/telegram-topic-recovery-adapter.test.ts`: prove recovery liveness is nondestructive.
- Modify `src/bot.ts`: create one shared probe for explicit bot consumers and make status-topic binding a pure projection.
- Modify `test/bot-commands.test.ts`: prove status binding performs no lookup or Telegram work.
- Modify `src/dashboard-controller.ts`: remove periodic topic-validation scheduling.
- Modify `test/dashboard-controller.test.ts`: lock the Dashboard collector to local-only snapshot options.
- Modify `src/status-board.ts`: remove the obsolete work-topic validation argument without changing maintenance of the board's own topic.
- Modify `test/status-board-lifecycle.test.ts`: prove board refresh collection no longer requests work-topic validation.

## Task 1: Build the nondestructive liveness primitive

**Files:**
- Create: `src/telegram-topic-liveness.ts`
- Create: `test/telegram-topic-liveness.test.ts`

- [ ] **Step 1: Write the failing behavior tests**

Create `test/telegram-topic-liveness.test.ts` with explicit checks for the Telegram request shape, closed and missing error classification, ambiguous error propagation, single-flight, cache expiry, timeout, and caller abort:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createForumTopicLivenessProbe,
  type ForumTopicDestination,
} from "../src/telegram-topic-liveness.js";

const destination: ForumTopicDestination = { chatId: -1001, messageThreadId: 41 };

describe("forum topic liveness", () => {
  afterEach(() => vi.useRealTimers());

  it("uses an ephemeral typing action in the target topic", async () => {
    const sendChatAction = vi.fn(async () => true);
    const probe = createForumTopicLivenessProbe({ sendChatAction });

    await expect(probe(destination)).resolves.toBe(true);

    expect(sendChatAction).toHaveBeenCalledWith(
      destination.chatId,
      "typing",
      { message_thread_id: destination.messageThreadId },
      expect.any(AbortSignal),
    );
  });

  it.each(["TOPIC_CLOSED", "Bad Request: topic is closed"])(
    "treats a closed topic as existing: %s",
    async (message) => {
      const probe = createForumTopicLivenessProbe({
        sendChatAction: vi.fn().mockRejectedValue(new Error(message)),
      });
      await expect(probe(destination)).resolves.toBe(true);
    },
  );

  it.each(["TOPIC_DELETED", "TOPIC_ID_INVALID", "message thread not found"])(
    "treats only a definitive missing response as missing: %s",
    async (message) => {
      const probe = createForumTopicLivenessProbe({
        sendChatAction: vi.fn().mockRejectedValue(new Error(message)),
      });
      await expect(probe(destination)).resolves.toBe(false);
    },
  );

  it.each(["Too Many Requests: retry after 20", "network failed", "unknown"])(
    "propagates an ambiguous failure: %s",
    async (message) => {
      const error = new Error(message);
      const probe = createForumTopicLivenessProbe({
        sendChatAction: vi.fn().mockRejectedValue(error),
      });
      await expect(probe(destination)).rejects.toBe(error);
    },
  );

  it("shares one request and briefly caches its result", async () => {
    let now = 1_000;
    let release!: () => void;
    const pending = new Promise<true>((resolve) => { release = () => resolve(true); });
    const sendChatAction = vi.fn(() => pending);
    const probe = createForumTopicLivenessProbe({ sendChatAction, now: () => now });

    const first = probe(destination);
    const concurrent = probe(destination);
    expect(sendChatAction).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);

    await expect(probe(destination)).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledOnce();
    now += 5_001;
    sendChatAction.mockResolvedValueOnce(true);
    await expect(probe(destination)).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    const sendChatAction = vi.fn()
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce(true);
    const probe = createForumTopicLivenessProbe({ sendChatAction });

    await expect(probe(destination)).rejects.toThrow("network failed");
    await expect(probe(destination)).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("aborts and rejects a probe after its deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const probe = createForumTopicLivenessProbe({
      sendChatAction: vi.fn((_chatId, _action, _options, signal) => {
        requestSignal = signal;
        return new Promise(() => {});
      }),
    });

    const result = probe(destination);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).rejects.toThrow("Telegram topic probe timed out");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("propagates caller cancellation to Telegram", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const probe = createForumTopicLivenessProbe({
      sendChatAction: vi.fn((_chatId, _action, _options, signal) => {
        requestSignal = signal;
        return new Promise(() => {});
      }),
    });

    const result = probe(destination, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("Telegram topic probe aborted");
    expect(requestSignal?.aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-topic-liveness.test.ts
```

Expected: FAIL because `src/telegram-topic-liveness.ts` does not exist.

- [ ] **Step 3: Implement the minimal focused module**

Create `src/telegram-topic-liveness.ts`. Keep this module independent of grammY so tests use a narrow adapter:

```ts
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
  if (timeoutMs > 2_147_483_647) throw new Error("Invalid timeoutMs");
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
    if (pending) return pending;

    const request = withDeadline(async (signal) => {
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
    }, timeoutMs, callerSignal);

    inFlight.set(key, request);
    void request.then((value) => {
      cache.set(key, { value, expiresAt: now() + cacheTtlMs });
    }).finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    }).catch(() => {});
    return request;
  };
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
    Promise.resolve().then(() => operation(controller.signal)).then(
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
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-topic-liveness.test.ts
```

Expected: one test file passes with all cases green and no unhandled rejection.

- [ ] **Step 5: Commit the primitive**

```bash
git add src/telegram-topic-liveness.ts test/telegram-topic-liveness.test.ts
git commit -m "NO-TICKET fix: probe topics without changing state"
```

## Task 2: Wire all explicit liveness consumers

**Files:**
- Create: `src/telegram-topic-liveness-api.ts`
- Create: `test/telegram-topic-liveness-api.test.ts`
- Create: `test/bot-topic-liveness.test.ts`
- Modify: `src/projects.ts:88-168`
- Modify: `test/projects.test.ts:229-272`
- Modify: `src/bot.ts:69-82,3195-3200`
- Modify: `src/telegram-topic-recovery-adapter.ts:1-51`
- Modify: `test/telegram-topic-recovery-adapter.test.ts:24-74`

- [ ] **Step 1: Change adapter tests to require `sendChatAction` and forbid lifecycle calls**

Update the recovery adapter harness to expose only `sendChatAction`, `createForumTopic`, and `sendMessage`. Replace the reopen/close expectations with:

```ts
expect(harness.api.sendChatAction).toHaveBeenCalledWith(
  destination.chatId,
  "typing",
  { message_thread_id: destination.messageThreadId },
  expect.any(AbortSignal),
);
expect(harness.api).not.toHaveProperty("reopenForumTopic");
expect(harness.api).not.toHaveProperty("closeForumTopic");
```

The harness API must be:

```ts
const api = {
  sendChatAction: vi.fn(async () => true),
  createForumTopic: vi.fn(async () => ({ message_thread_id: 99 })),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
};
```

Delete the `probeForumTopic` tests and `isMissingForumTopicError` tests from `test/projects.test.ts`; Task 1 now owns those contracts.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
TMPDIR=/var/tmp npx vitest run test/projects.test.ts test/telegram-topic-recovery-adapter.test.ts
```

Expected: the recovery adapter test fails because production still calls reopen/close.

- [ ] **Step 3: Replace destructive wiring**

In `src/projects.ts`, delete `probeForumTopic`, `isMissingForumTopicError`, and the private `isTopicNotModifiedError`. Keep `findLiveBoundTopic`, `partitionJobsByTopicLiveness`, and `ensureThreadTopic` unchanged.

In `src/bot.ts`, remove the `probeForumTopic` import and import:

```ts
import { createForumTopicLivenessProbe } from "./telegram-topic-liveness.js";
import { createTelegramTopicLivenessApi, type TelegramTopicLivenessApi }
  from "./telegram-topic-liveness-api.js";
```

Add the narrow optional `topicLivenessApi?: TelegramTopicLivenessApi` dependency to `TeleCodexBotOptions`. Replace the old `topicIsAlive` closure with one shared probe:

```ts
/** Telegram sends no update when a forum topic is deleted. */
const probeTopicLiveness = createForumTopicLivenessProbe({
  sendChatAction: (options.topicLivenessApi
    ?? createTelegramTopicLivenessApi(config.telegramBotToken)).sendChatAction,
});
const topicIsAlive = (chatId: number, messageThreadId: number): Promise<boolean> =>
  probeTopicLiveness({ chatId, messageThreadId });
```

The factory creates `new Api(token, options)` exactly once and wraps its `sendChatAction`; it installs no transformers and does not expose `config.use`. Keep ordinary legacy `bot.api` autoRetry unchanged. Prove this separation through actual bot callbacks in both legacy and canonical modes, and prove an HTTP/API 429 is rejected after exactly one fake-fetch request. Add RED validation for `timeoutMs = 2_147_483_648`; accept integer timeouts from 1 through `2_147_483_647`. Cache TTL has no timer and can remain a positive safe integer.

In `src/telegram-topic-recovery-adapter.ts`, import `createForumTopicLivenessProbe`, narrow `RecoveryApi`, create the probe once, and delegate to it:

```ts
import { createForumTopicLivenessProbe } from "./telegram-topic-liveness.js";

type RecoveryApi = Pick<Api, "sendChatAction" | "createForumTopic" | "sendMessage">;

// Inside createTelegramTopicRecoveryAdapter, after the enabled check:
const topicIsAlive = createForumTopicLivenessProbe({
  sendChatAction: (chatId, action, requestOptions, signal) =>
    options.api.sendChatAction(chatId, action, requestOptions, signal as never),
});

// In the returned adapter:
probeForumTopic: (destination, signal) => topicIsAlive(destination, signal),
```

The recovery adapter is composed only in canonical mode, whose API has no retry transformer, and remains disabled by default.

- [ ] **Step 4: Run explicit-consumer regression tests**

Run:

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-topic-liveness.test.ts \
  test/telegram-topic-liveness-api.test.ts \
  test/bot-topic-liveness.test.ts \
  test/projects.test.ts \
  test/telegram-topic-recovery-adapter.test.ts \
  test/telegram-topic-recovery-runtime.test.ts \
  test/telegram-reliability-runtime.test.ts \
  test/jira-task-thread.test.ts \
  test/bot-inbox.test.ts
TMPDIR=/var/tmp npx tsc --noEmit
```

Expected: all listed tests pass and TypeScript exits 0. Confirm with:

```bash
rg -n "reopenForumTopic|closeForumTopic" \
  src/telegram-topic-liveness.ts src/telegram-topic-recovery-adapter.ts src/projects.ts
```

Expected: no matches.

- [ ] **Step 5: Commit explicit-consumer wiring**

```bash
git add src/projects.ts src/bot.ts src/telegram-topic-recovery-adapter.ts \
  src/telegram-topic-liveness-api.ts test/telegram-topic-liveness-api.test.ts \
  test/bot-topic-liveness.test.ts test/projects.test.ts test/telegram-topic-recovery-adapter.test.ts
git commit -m "NO-TICKET fix: use nondestructive topic probes"
```

## Task 3: Remove Telegram work-topic checks from background collectors

**Files:**
- Modify: `src/bot.ts:342-377,4251-4382`
- Modify: `test/bot-commands.test.ts:1-57`
- Modify: `src/dashboard-controller.ts:56-85`
- Modify: `test/dashboard-controller.test.ts:52-72`
- Modify: `src/status-board.ts:25-32,80-87`
- Modify: `test/status-board-lifecycle.test.ts:222-240`

- [ ] **Step 1: Write failing local-only collector tests**

Replace the status binding tests in `test/bot-commands.test.ts` with pure-projection contracts that make the current registry snapshot authoritative:

```ts
it("invalidates a cached binding deleted from the registry", () => {
  const cache = new Map<string, number>();
  bindSavedStatusTopics([{ threadId: "A", messageThreadId: 42 }], cache);
  const rows = [{ threadId: "A", messageThreadId: undefined }];

  bindSavedStatusTopics(rows, cache);

  expect(rows[0].messageThreadId).toBeUndefined();
  expect(cache.has("A")).toBe(false);
});

it("moves a reassigned topic to its current registry owner", () => {
  const cache = new Map<string, number>();
  bindSavedStatusTopics([{ threadId: "A", messageThreadId: 42 }], cache);
  const rows = [
    { threadId: "A", messageThreadId: undefined },
    { threadId: "B", messageThreadId: 42 },
  ];

  bindSavedStatusTopics(rows, cache);

  expect(rows.map((row) => row.messageThreadId)).toEqual([undefined, 42]);
  expect(cache).toEqual(new Map([["B", 42]]));
});

it("replaces a binding changed for the same thread", () => {
  const cache = new Map<string, number>();
  bindSavedStatusTopics([{ threadId: "A", messageThreadId: 42 }], cache);
  const rows = [{ threadId: "A", messageThreadId: 43 }];

  bindSavedStatusTopics(rows, cache);

  expect(rows[0].messageThreadId).toBe(43);
  expect(cache).toEqual(new Map([["A", 43]]));
});

it("projects a defined binding across duplicate rows in the same snapshot", () => {
  const cache = new Map<string, number>();
  const rows = [
    { threadId: "A", messageThreadId: undefined },
    { threadId: "A", messageThreadId: 42 },
  ];

  bindSavedStatusTopics(rows, cache);

  expect(rows.map((row) => row.messageThreadId)).toEqual([42, 42]);
  expect(cache).toEqual(new Map([["A", 42]]));
});
```

These tests cover registry deletion, topic reassignment, same-thread replacement, and useful propagation within one snapshot. They must not retain a cached binding merely because an unbound row remains visible.

Change the Dashboard collector test to call it three times and require the same local-only options every time:

```ts
expect(collect.mock.calls).toEqual([
  [{ maxRecentThreads: Number.MAX_SAFE_INTEGER, includeCanonicalReliability: false, refreshHostThreads: false }],
  [{ maxRecentThreads: Number.MAX_SAFE_INTEGER, includeCanonicalReliability: false, refreshHostThreads: false }],
  [{ maxRecentThreads: Number.MAX_SAFE_INTEGER, includeCanonicalReliability: false, refreshHostThreads: false }],
]);
```

Update `test/status-board-lifecycle.test.ts` so repeated refreshes expect `collect` to be called with no arguments:

```ts
expect(collect.mock.calls).toEqual([[], [], []]);
```

- [ ] **Step 2: Run collector tests and confirm RED**

Run:

```bash
TMPDIR=/var/tmp npx vitest run \
  test/bot-commands.test.ts \
  test/dashboard-controller.test.ts \
  test/status-board-lifecycle.test.ts
```

Expected: FAIL if `bindSavedStatusTopics` retains stale bindings after registry deletion or topic reassignment, or if the local-only collector contract does not exist.

- [ ] **Step 3: Make status-topic binding a synchronous projection**

In `src/bot.ts`, replace `bindLiveStatusTopics` with:

```ts
export function bindSavedStatusTopics(
  rows: LiveStatusTopicRow[],
  cache: Map<string, number>,
): void {
  const currentBindings = new Map<string, number>();
  for (const row of rows) {
    if (row.messageThreadId !== undefined) {
      currentBindings.set(row.threadId, row.messageThreadId);
    }
  }
  for (const threadId of cache.keys()) {
    if (!currentBindings.has(threadId)) cache.delete(threadId);
  }
  for (const [threadId, messageThreadId] of currentBindings) {
    cache.set(threadId, messageThreadId);
  }
  for (const row of rows) row.messageThreadId = cache.get(row.threadId);
}
```

Defined bindings in the current snapshot are authoritative. A visible row without a current binding invalidates any cached value unless another row for the same thread defines the binding in that same snapshot.

Remove `findLiveBoundTopic` from the `src/bot.ts` imports. Remove `validateTopicBindings` from `collectStatusSnapshot` options and replace the async background binding block with:

```ts
if (boardChatId !== undefined) {
  const actionable = [...snapshot.running, ...snapshot.recentThreads]
    .filter((row): row is typeof row & { threadId: string } => Boolean(row.threadId));
  bindSavedStatusTopics(actionable, liveStatusTopicByThreadId);
}
```

- [ ] **Step 4: Remove obsolete validation scheduling**

Rename `createPeriodicDashboardCollector` to `createDashboardSnapshotCollector` and replace it with:

```ts
export function createDashboardSnapshotCollector(
  collect: (options: {
    maxRecentThreads?: number;
    includeCanonicalReliability?: boolean;
    refreshHostThreads?: boolean;
  }) => Promise<StatusSnapshot>,
): () => Promise<StatusSnapshot> {
  return () => collect({
    maxRecentThreads: Number.MAX_SAFE_INTEGER,
    includeCanonicalReliability: false,
    refreshHostThreads: false,
  });
}
```

Update its import and call in `src/bot.ts`. In `src/status-board.ts`, change the collection interface and call to:

```ts
collect(): Promise<StatusSnapshot>;

// Inside refreshBoard:
const { body, buttons } = renderStatusBoard(
  await this.options.collect(),
  this.options.chatId,
  this.options.miniAppLaunchUrl,
);
```

Keep `healthCheckDue` and the Status Board's own `ensureClosed`, edit, recreate, and pin behavior unchanged.

- [ ] **Step 5: Run collector and integration tests**

Run:

```bash
TMPDIR=/var/tmp npx vitest run \
  test/bot-commands.test.ts \
  test/dashboard-controller.test.ts \
  test/status-board-lifecycle.test.ts \
  test/status-board.test.ts \
  test/mini-app-runtime.test.ts
TMPDIR=/var/tmp npx tsc --noEmit
```

Expected: all listed tests pass and TypeScript exits 0. Confirm no background validation symbol remains:

```bash
rg -n "validateTopicBindings|createPeriodicDashboardCollector|bindLiveStatusTopics" src test
```

Expected: no matches.

- [ ] **Step 6: Commit the background-policy fix**

```bash
git add src/bot.ts src/dashboard-controller.ts src/status-board.ts \
  test/bot-commands.test.ts test/dashboard-controller.test.ts \
  test/status-board-lifecycle.test.ts \
  docs/superpowers/specs/2026-09-07-telecodex-nondestructive-topic-liveness-design.md \
  docs/superpowers/plans/2026-09-07-telecodex-nondestructive-topic-liveness.md
git commit -m "NO-TICKET fix: invalidate stale topic links"
```

## Task 4: Review and verify the complete hotfix

**Files:**
- Review: every file changed since commit `1093d05`
- Modify only if review finds a scoped defect

- [ ] **Step 1: Run the complete verification gate**

```bash
set -euo pipefail
TMPDIR=/var/tmp npm test
TMPDIR=/var/tmp npm run check:web
TMPDIR=/var/tmp npx tsc --noEmit
TELECODEX_VERIFY_ROOT=.telecodex/release-state/topic-liveness-hotfix
install -d -m 0700 "$TELECODEX_VERIFY_ROOT"
TELECODEX_VERIFY_STAGE=$(mktemp -d "$TELECODEX_VERIFY_ROOT/verify.XXXXXX")
TELECODEX_VERIFY_STAGE_ABS=$(realpath "$TELECODEX_VERIFY_STAGE")
TMPDIR=/var/tmp npx --no-install tsc --outDir "$TELECODEX_VERIFY_STAGE_ABS/dist"
TMPDIR=/var/tmp npx --no-install vite build --config web/vite.config.ts \
  --outDir "$TELECODEX_VERIFY_STAGE_ABS/dist-web"
chmod -R go-rwx "$TELECODEX_VERIFY_STAGE"
git diff --check
```

Expected: all Vitest files and tests pass, Svelte reports 0 errors and 0 warnings,
TypeScript and both private staged builds exit 0, and diff check prints nothing. Do
not run `npm run build` because its default outputs are the live `dist` and
`dist-web` trees.

- [ ] **Step 2: Enforce focused structural assertions**

```bash
set -euo pipefail
test "$(wc -l < src/telegram-topic-liveness.ts)" -lt 500
test "$(wc -l < src/telegram-topic-liveness-api.ts)" -lt 500
test "$(wc -l < src/telegram-topic-recovery-adapter.ts)" -lt 500
! rg -n "reopenForumTopic|closeForumTopic" \
  src/telegram-topic-liveness.ts src/telegram-topic-liveness-api.ts \
  src/telegram-topic-recovery-adapter.ts src/projects.ts
! rg -n "validateTopicBindings|createPeriodicDashboardCollector|bindLiveStatusTopics" src test
git status --short
```

Expected: assertions exit 0. `git status --short` is empty after the build because generated trees remain ignored.

- [ ] **Step 3: Run two-stage review**

Dispatch a specification reviewer against the design, plan, and diff from `1093d05`. Resolve every missing or extra behavior. Then dispatch a code-quality reviewer against the reviewed diff and resolve every Critical or Important finding. Rerun the focused tests after each correction and commit each correction separately using one of:

```bash
git commit -am "NO-TICKET fix: correct topic liveness behavior"
git commit -am "NO-TICKET refactor: simplify topic liveness"
git commit -am "NO-TICKET test: strengthen topic liveness regression"
```

Use only the subject that matches the actual correction. Do not create an empty commit.

- [ ] **Step 4: Repeat the complete gate after review**

Run the exact commands from Step 1 again from a clean worktree. Expected: the same all-green result.

## Task 5: Install and observe the hotfix as one live microrelease

**Files:**
- Create privately: `.telecodex/release-state/topic-liveness-hotfix/<timestamp>-stage.*`
- Create privately: `.telecodex/release-state/topic-liveness-hotfix/<timestamp>-rollback.*`
- Replace at the controlled boundary: ignored `dist/` and `dist-web/`
- Restart: `telecodex.service` exactly once

- [ ] **Step 1: Build a private candidate and capture rollback trees**

```bash
set -euo pipefail
cd /root/Documents/Codex/2026-08-07-hermes/telecodex
TELECODEX_RELEASE_ROOT=.telecodex/release-state/topic-liveness-hotfix
install -d -m 0700 "$TELECODEX_RELEASE_ROOT"
TELECODEX_RELEASE_TAG=$(date -u +%Y%m%dT%H%M%SZ)
TELECODEX_STAGE=$(mktemp -d "$TELECODEX_RELEASE_ROOT/${TELECODEX_RELEASE_TAG}-stage.XXXXXX")
TELECODEX_ROLLBACK=$(mktemp -d "$TELECODEX_RELEASE_ROOT/${TELECODEX_RELEASE_TAG}-rollback.XXXXXX")
export TELECODEX_STAGE TELECODEX_ROLLBACK
TELECODEX_STAGE_ABS=$(realpath "$TELECODEX_STAGE")
TMPDIR=/var/tmp npx --no-install tsc --outDir "$TELECODEX_STAGE_ABS/dist"
TMPDIR=/var/tmp npx --no-install vite build --config web/vite.config.ts \
  --outDir "$TELECODEX_STAGE_ABS/dist-web"
cp -a dist "$TELECODEX_ROLLBACK/dist"
cp -a dist-web "$TELECODEX_ROLLBACK/dist-web"
chmod -R go-rwx "$TELECODEX_STAGE" "$TELECODEX_ROLLBACK"
```

- [ ] **Step 2: Verify the candidate and disabled recovery boundary**

```bash
set -euo pipefail
! rg -n "reopenForumTopic|closeForumTopic" \
  "$TELECODEX_STAGE/dist/telegram-topic-liveness.js" \
  "$TELECODEX_STAGE/dist/telegram-topic-liveness-api.js" \
  "$TELECODEX_STAGE/dist/telegram-topic-recovery-adapter.js" \
  "$TELECODEX_STAGE/dist/projects.js"
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

try {
  const serviceProperty = (name) => execFileSync("systemctl", [
    "show", "telecodex.service", "-p", name, "--value",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pid = serviceProperty("MainPID");
  assert.match(pid, /^[1-9]\d*$/);
  const cwd = realpathSync(serviceProperty("WorkingDirectory"));
  assert.equal(cwd, realpathSync(process.cwd()));
  const key = "TELEGRAM_TOPIC_RECOVERY_ENABLED";
  // Retain only this exact key; never forward or print the complete service environment.
  const records = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
    .filter((record) => record.startsWith(`${key}=`));
  assert.ok(records.length <= 1);
  const env = { ...process.env };
  delete env[key];
  if (records.length === 1) env[key] = records[0].slice(key.length + 1);
  const check = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { loadConfig } from "./src/config.ts";
    const config = loadConfig();
    const raw = process.env.TELEGRAM_TOPIC_RECOVERY_ENABLED?.trim() ?? "";
    if (raw !== "" && !/^(true|false)$/i.test(raw)) process.exit(1);
    process.stdout.write(JSON.stringify({
      telegramTopicRecoveryEnabled: config.telegramTopicRecoveryEnabled,
    }));
  `], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  assert.equal(check.status, 0);
  const result = JSON.parse(check.stdout);
  assert.deepEqual(result, { telegramTopicRecoveryEnabled: false });
  assert.equal(serviceProperty("MainPID"), pid);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Suppress raw config values, subprocess warnings, environments, and tokens on failure.
  process.exit(1);
}
NODE
```

Expected: the structural assertion and config gate exit 0; the only config output is `{"telegramTopicRecoveryEnabled":false}`. `/proc/$MainPID/environ` supplies the exact initial process value, including systemd `Environment` and `EnvironmentFile`. An absent key is explicitly unset in the subprocess, allowing source `loadConfig()` to apply the service working directory's `.env` with its normal precedence; an explicitly empty key stays present. Nonempty values other than case-insensitive `true`/`false`, enabled recovery, unreadable process state, PID changes, or any config failure stop the gate without printing raw values. Rerun this gate immediately before installation and after restart.

- [ ] **Step 3: Require two consecutive idle preflight samples**

Use an explicit `if` for the streak check so `set -e` cannot terminate on an ordinary false condition:

```bash
set -euo pipefail
idle_streak=0
for attempt in $(seq 1 60); do
  PREFLIGHT_CODE=0
  PREFLIGHT_JSON=$(node dist/telecodex-release-cli.js preflight --json) || PREFLIGHT_CODE=$?
  export PREFLIGHT_CODE PREFLIGHT_JSON
  if node --input-type=module >/dev/null <<'NODE'
const code = Number(process.env.PREFLIGHT_CODE);
const report = JSON.parse(process.env.PREFLIGHT_JSON ?? "null");
if (code !== 0 && code !== 2) process.exit(1);
if (report.guardian !== "ready") process.exit(1);
if (report.jobs.running !== 0) process.exit(1);
if (report.deliveries.sending !== 0 || report.deliveries.uncertain !== 0) process.exit(1);
if (report.reasons.some((reason) => reason !== "DELIVERY_PENDING")) process.exit(1);
NODE
  then
    idle_streak=$((idle_streak + 1))
  else
    idle_streak=0
  fi
  if test "$idle_streak" -ge 2; then
    break
  fi
  test "$attempt" -lt 60
  sleep 5
done
test "$idle_streak" -ge 2
```

Expected: two consecutive safe samples within five minutes. Stop without restarting if the gate is not reached.

- [ ] **Step 4: Install and restart exactly once**

```bash
set -euo pipefail
BEFORE_PID=$(systemctl show telecodex.service -p MainPID --value)
BEFORE_RESTARTS=$(systemctl show telecodex.service -p NRestarts --value)
systemctl stop telecodex.service
test "$(systemctl is-active telecodex.service || true)" = "inactive"
rsync -a --delete "$TELECODEX_STAGE/dist/" dist/
rsync -a --delete "$TELECODEX_STAGE/dist-web/" dist-web/
systemctl start telecodex.service
test "$(systemctl is-active telecodex.service)" = "active"
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null \
    && curl -fsS http://127.0.0.1:8787/readyz >/dev/null; then
    break
  fi
  test "$attempt" -lt 30
  sleep 1
done
AFTER_PID=$(systemctl show telecodex.service -p MainPID --value)
test "$AFTER_PID" -gt 0
test "$AFTER_PID" != "$BEFORE_PID"
test "$(systemctl show telecodex.service -p NRestarts --value)" = "$BEFORE_RESTARTS"
test -z "$(rsync -ani --delete "$TELECODEX_STAGE/dist/" dist/)"
test -z "$(rsync -ani --delete "$TELECODEX_STAGE/dist-web/" dist-web/)"
```

- [ ] **Step 5: Verify safe runtime state without identifiers or payloads**

Run two fresh preflights and require both to parse, Guardian to be ready, no running job, no sending or uncertain delivery, and no reason except a pre-existing `DELIVERY_PENDING`. Inspect only new journal entries for `429`, background errors, uncaught errors, unhandled rejections, or recovery activity. Check SQLite read-only for schema version 7, `quick_check=ok`, zero foreign-key violations, and zero topic-recovery rows. Print only aggregate counts and booleans.

Expected: service active, stable PID/restart count, both HTTP probes healthy, recovery still disabled, and no new error pattern.

- [ ] **Step 6: Observe one full collector interval**

Take twenty snapshots at 30-second intervals. Each snapshot must check health, readiness, PID, restart count, aggregate delivery states, quarantine count, recovery count, and journal errors without printing identifiers or content. Update the user at least once per minute while waiting.

Expected: all twenty snapshots are clean. No new reopen/close service messages should appear in work topics during this interval. If Telegram history cannot be read programmatically, report that part as a user-visible confirmation boundary instead of claiming it was independently observed.

- [ ] **Step 7: Apply the rollback rule if needed**

Before any missing-topic recovery action has been enabled or invoked, a failed hotfix may be rolled back by stopping only `telecodex.service`, restoring the saved `dist` and `dist-web` trees, starting the service, and repeating the health checks. Do not restore or modify SQLite. Do not retry a timed-out Telegram operation.

## Completion criteria

- The complete focused and full test gates pass twice.
- Specification and code-quality reviews approve the scoped diff.
- Liveness modules contain no topic reopen/close calls.
- Background collectors contain no work-topic validation path.
- The live service restarts once at a proven idle boundary and remains healthy for ten minutes.
- Missing-topic recovery remains disabled and no database mutation is performed by the hotfix.
- Source commits remain on `telecodex-improvements`; nothing is pushed.
