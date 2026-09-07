# TeleCodex Reliability Block B: Durable Telegram Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every important Telegram mutation through one fair, rate-aware contract while preserving durable delivery and refusing blind repeats after ambiguous side effects.

**Architecture:** A new write coordinator generalizes the existing per-chat background gate into three priorities without replacing the SQLite delivery outbox. Surfaces migrate one at a time. Durable cooldown, topic operations, and Inbox operations add intent/outcome rows before external mutation; operator views expose only safe state and legal actions.

**Tech Stack:** TypeScript, grammY, SQLite, existing delivery outbox, Vitest, Svelte for the final operator view.

---

## Delivery rules

- Depend on accepted Block 0 and Block A releases.
- `final` outranks `interactive`, which outranks `background`, but normal work must receive a permit within a bounded number of completed higher-priority operations.
- Serialize writes within a chat. A global budget limits aggregate starts without making one chat's 429 permanently block unrelated chats.
- A known-message edit may retry after ambiguity. A new send or topic create may not.
- Keep the current outbox as authority for job response delivery. The coordinator schedules API calls but does not own job completion.
- No task commits changes without separate user authorization.

### Task B1: Add the unified write contract in pass-through mode

**Files:**
- Create: `src/telegram-write-coordinator.ts`
- Create: `test/telegram-write-coordinator.test.ts`
- Modify: `src/telegram-background-write-gate.ts`
- Modify: `src/index.ts`
- Modify: `src/lifecycle.ts`
- Modify: `test/telegram-background-write-gate.test.ts`
- Modify: `test/lifecycle.test.ts`

- [ ] **Step 1: Write failing contract tests**

```ts
export type TelegramWritePriority = "background" | "interactive" | "final";
export type TelegramWritePurpose =
  | "presence" | "status" | "panel" | "callback"
  | "job_delivery" | "topic" | "guardian_alert";

export interface TelegramWriteRequest<T> {
  chatId: number;
  topicId?: number;
  purpose: TelegramWritePurpose;
  priority: TelegramWritePriority;
  operationId: string;
  replaceKey?: string;
  signal?: AbortSignal;
  execute(signal: AbortSignal): Promise<T>;
}
```

Test validation, synchronous throw, cancellation before admission, cancellation in flight, exact result propagation, safe error normalization, dispose, and operation IDs excluded from user-facing errors.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run test/telegram-write-coordinator.test.ts test/telegram-background-write-gate.test.ts test/lifecycle.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement pass-through adapter**

Initially map `background -> ordinary`, `interactive|final -> urgent` onto the accepted `TelegramBackgroundWriteGate`. Preserve current limits and ordering. Construct one coordinator in `src/index.ts` with the current gate as a non-owning dependency. Add a `telegram-write-coordinator` lifecycle step before the existing gate step so queued coordinator requests cancel first and each object is disposed exactly once.

- [ ] **Step 4: Verify, deploy, and observe**

Run focused tests and the full gate. Deploy through Block 0 with no callers migrated. Verify identical Telegram behavior and 10 minutes without new coordinator/gate errors.

### Task B2: Route replaceable background writes at low priority

**Files:**
- Modify: `src/status-board.ts`
- Modify: `src/bot.ts`
- Modify: `src/index.ts`
- Modify: `test/status-board-lifecycle.test.ts`
- Modify: `test/bot-commands.test.ts`
- Modify: `test/bot-message-reliability.test.ts`

- [ ] **Step 1: Write failing routing/coalescing tests**

Assert that Status Board edit/pin/cleanup and typing/upload actions use `priority: "background"`. Repeated pending status edits for the same target use one stable `replaceKey`; the newest not-started operation supersedes older content and settles the older promise with a typed replacement outcome.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/status-board-lifecycle.test.ts test/bot-commands.test.ts test/bot-message-reliability.test.ts test/telegram-write-coordinator.test.ts`

Do not route durable final response parts in this task. Keep fire-and-forget typing failures non-fatal and bounded in logs.

- [ ] **Step 3: Deploy and observe**

Deploy, force several ordinary Status Board refreshes through test controls, and verify one physical edit per replacement key, no 429 loop, and normal ingress for 30 minutes.

### Task B3: Route Inbox and control interactions at normal priority

**Files:**
- Modify: `src/bot-inbox.ts`
- Modify: `src/bot.ts`
- Modify: `src/guardian-bot-adapter.ts`
- Modify: `test/bot-inbox.test.ts`
- Modify: `test/bot-commands.test.ts`
- Modify: `test/guardian-bot-adapter.test.ts`

- [ ] **Step 1: Write failing interaction tests**

Cover Inbox confirmation edits, reply-markup edits, panel messages, callback acknowledgements, and Guardian callback status edits. Assert `priority: "interactive"`, exact chat/topic correlation, bounded timeout, and no replacement of a distinct callback operation.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/bot-inbox.test.ts test/bot-commands.test.ts test/guardian-bot-adapter.test.ts test/telegram-write-coordinator.test.ts`

Route only Telegram mutations. Preserve existing Inbox and Guardian domain state. A callback answer may fail without undoing an already durable job, but the failure must be logged by safe reason.

- [ ] **Step 3: Deploy and observe**

Deploy and exercise one read-only panel/callback plus one Inbox confirmation that does not create external Jira work. Observe 30 minutes. Do not restart Guardian.

### Task B4: Route durable job and final delivery at high priority

**Files:**
- Modify: `src/telegram-grammy-transport.ts`
- Modify: `src/telegram-delivery-outbox.ts`
- Modify: `src/telegram-durable-status.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `test/telegram-grammy-transport.test.ts`
- Modify: `test/telegram-delivery-outbox.test.ts`
- Modify: `test/telegram-durable-status.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`

- [ ] **Step 1: Write failing priority/cancellation tests**

Assert that final text, rich response, and document parts use `priority: "final"`; durable status anchors use `final` while required and become replaceable once only progress changes. Installing a final response plan cancels queued progress writes without cancelling a started edit or a final part.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telegram-grammy-transport.test.ts test/telegram-delivery-outbox.test.ts test/telegram-durable-status.test.ts test/telegram-reliability-runtime.test.ts`

Pass the coordinator into the existing Telegram adapter. Keep outbox state transitions, `uncertain` classification, part keys, and attempt accounting unchanged.

- [ ] **Step 3: Deploy with a real answer**

Deploy, run one private prompt that produces commentary and a final answer, and prove the final result bypasses queued background work while delivering each part once. Observe 30 minutes.

### Task B5: Add global pressure and bounded fairness

**Files:**
- Modify: `src/telegram-write-coordinator.ts`
- Modify: `test/telegram-write-coordinator.test.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Use deterministic clocks to test per-chat serialization, global concurrent-start limit, per-chat token budget, global 429 pause, chat-local pause, replacement, and fairness. After eight consecutive `final` starts while `interactive` waits, the next available permit must serve `interactive`; after eight non-background starts while background waits, one background operation may run unless a final delivery deadline is due.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telegram-write-coordinator.test.ts test/config.test.ts test/telegram-background-write-gate.test.ts`

Add validated configuration for global concurrency, rate window, burst, and fairness streak, with current gate values as defaults. Keep the old gate as a compatibility adapter until all callers migrate and tests show no direct use.

- [ ] **Step 3: Deploy under synthetic pressure**

Use deterministic test traffic, not repeated live Telegram spam, to prove order. Deploy and observe real background/status/final traffic for 30 minutes with no starvation or SLO breach.

### Task B6: Persist durable Telegram cooldown

**Files:**
- Create: `src/telegram-rate-limit-store.ts`
- Create: `test/telegram-rate-limit-store.test.ts`
- Modify: `src/telegram-job-ledger-schema.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `src/telegram-write-coordinator.ts`
- Modify: `test/telegram-job-store-sqlite.test.ts`
- Modify: `test/telegram-write-coordinator.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
export interface TelegramRateLimitRecord {
  scope: "global" | "chat";
  chatId: number | null;
  blockedUntil: number;
  updatedAt: number;
}
```

Test additive schema migration, later-deadline wins, expiry, clock rollback, restart restoration, corrupt-row quarantine, and that `retry_after` does not consume an outbox attempt.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telegram-rate-limit-store.test.ts test/telegram-write-coordinator.test.ts test/telegram-job-store-sqlite.test.ts test/telegram-delivery-outbox.test.ts`

Persist only cooldowns raised by durable `interactive` or `final` work. Treat Telegram responses without proven scope as global. Background-only cooldown may remain in memory.

- [ ] **Step 3: Controlled restart proof**

Use a fake Telegram adapter in an integration process to create a cooldown, restart that process, and prove no early call. Deploy and observe 30 minutes. Do not intentionally trigger production Telegram 429.

### Task B7: Make topic creation and binding durable

**Files:**
- Create: `src/telegram-topic-operation.ts`
- Create: `test/telegram-topic-operation.test.ts`
- Modify: `src/telegram-job-ledger-schema.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `src/projects.ts`
- Modify: `src/index.ts`
- Modify: `src/bot-inbox.ts`
- Modify: `test/projects.test.ts`
- Modify: `test/bot-inbox.test.ts`

- [ ] **Step 1: Write failing intent/outcome tests**

```ts
export type TelegramTopicOperationState =
  | "planned" | "sending" | "confirmed" | "uncertain" | "failed";
```

Persist stable operation ID, purpose, chat ID, requested safe title hash, resulting topic ID when known, state, attempts, and reason code. Test crash before call, explicit failure, timeout after call, restart, concurrent duplicate intent, and confirmed binding reuse.

- [ ] **Step 2: Verify RED, implement one canonical creator, and verify GREEN**

Run: `npm test -- --run test/telegram-topic-operation.test.ts test/projects.test.ts test/bot-inbox.test.ts test/telegram-job-store-sqlite.test.ts`

Route `ensureThreadTopic()` and Inbox work-topic creation through the durable operation. New topic create timeout becomes `uncertain`; do not call create again. Existing confirmed topic binding stays idempotent.

- [ ] **Step 3: Deploy one real topic operation**

Create only the user-requested private test topic or use an already required Inbox handoff. Verify one operation row, one Telegram topic, one binding, and the 60-minute window. Rollback must keep the confirmed binding.

### Task B8: Make critical Inbox mutations durable

**Files:**
- Create: `src/telegram-inbox-operation.ts`
- Create: `test/telegram-inbox-operation.test.ts`
- Modify: `src/telegram-job-ledger-schema.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `src/inbox.ts`
- Modify: `src/bot-inbox.ts`
- Modify: `src/telegram-inbox-completion.ts`
- Modify: `test/inbox.test.ts`
- Modify: `test/bot-inbox.test.ts`
- Modify: `test/telegram-inbox-completion.test.ts`

- [ ] **Step 1: Write failing Inbox operation tests**

Track stable operation ID, ticket ID, operation kind `acknowledge|handoff|complete`, job ID when present, topic operation ID when present, expected ticket version, state, and safe reason. Test duplicate callback, crash before/after each external effect, stale ticket version, restart, and no completion before final job delivery.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telegram-inbox-operation.test.ts test/inbox.test.ts test/bot-inbox.test.ts test/telegram-inbox-completion.test.ts`

Write the operation before Telegram/Jira side effects, advance it with CAS, and preserve the current ticket record as the domain source. Ambiguous external creation remains visible and is not repeated automatically.

- [ ] **Step 3: Deploy a controlled Inbox flow**

Use one real Inbox item approved for processing. Verify exact ticket, topic, job, final delivery, and completion correlation, then observe 60 minutes. Do not retry unrelated historical Inbox rows.

### Task B9: Expose delivery evidence and safe actions

**Files:**
- Modify: `src/telegram-status-projection.ts`
- Modify: `src/telegram-durable-status.ts`
- Modify: `src/dashboard-api.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `src/turn-progress.ts`
- Modify: `web/src/model.ts`
- Modify: `web/src/App.svelte`
- Modify: `test/telegram-status-projection.test.ts`
- Modify: `test/dashboard-api.test.ts`
- Modify: `test/mini-app-server.test.ts`
- Modify: `test/mini-app-ui.test.ts`

- [ ] **Step 1: Invoke interface design before UI work**

Use `interface-design` and `typeui-fundamentals` to fit delivery evidence into the existing session detail surface. Do not redesign the Dashboard navigation.

- [ ] **Step 2: Write failing API/action tests**

Expose part state, attempt count, next attempt time, safe error code, and exact legal action DTO. `retry_delivery` is legal only for safe failed edits/parts; `send_again_warning` requires explicit confirmation for an uncertain new send. Stale expected version must return conflict.

- [ ] **Step 3: Verify RED, implement, and verify GREEN**

Run:

```bash
npm test -- --run test/telegram-status-projection.test.ts test/dashboard-api.test.ts test/mini-app-server.test.ts test/mini-app-ui.test.ts
npm run check:web
```

Expected after implementation: PASS and no raw Telegram errors or content in the DTO.

- [ ] **Step 4: Deploy and close Block B**

Inspect one delivered job and a synthetic failed/uncertain fixture through the operator API. Do not manufacture a duplicate-prone live send. Observe 10 minutes, then require fresh full verification and review before Block C.
