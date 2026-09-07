# TeleCodex Message Reliability Plan, Part 2: Runtime reliability

> Part of [TeleCodex Message Reliability Implementation Plan](2026-08-22-telecodex-message-reliability.md). Follow its required skills, execution constraints, state contract, and file map.

---

### Task 6: Persist every work-producing Telegram update before materialization

**Files:**

- Create: `src/telegram-job-ingress.ts`
- Create: `test/telegram-job-ingress.test.ts`
- Modify: `src/telegram-job-types.ts`

**Step 1: Write failing ingress tests**

Normalize text, voice/audio, photo, document, callback-triggered retry, and future work-producing commands into one envelope:

```ts
interface TelegramWorkSource {
  botId: string;
  updateId: number;
  chatId: number;
  messageThreadId: number | null;
  messageId: number;
  kind: "text" | "voice" | "audio" | "photo" | "document" | "command" | "confirmation" | "retry";
  text: string | null;
  attachment: TelegramAttachmentRef | null;
  retryOfJobId: string | null;
}
```

Cover:

- `accept()` commits before any Telegram edit/send, file download, transcription, staging, or Codex call;
- duplicate `botId + updateId` returns the existing job and does no downstream work;
- the job and pending `status-anchor` delivery part are inserted in the same acceptance transaction;
- Telegram `file_id` and metadata are durable before file bytes are downloaded;
- a download/materialization failure leaves a visible retryable job;
- attachment directories and materialized files use private permissions;
- a full/corrupt database rejects the update before external side effects;
- retry creates a new source/job link and never mutates/replays the old job.

**Step 2: Verify RED**

```bash
npx vitest run test/telegram-job-ingress.test.ts
```

Expected: FAIL because ingress does not exist.

**Step 3: Implement ingress and materialization boundary**

Expose separate operations:

```ts
accept(source: TelegramWorkSource): AcceptUpdateResult;
materialize(jobId: string): Promise<MaterializedPrompt>;
```

Persist source identity, attachment references, and the pending status anchor in `accept`. Perform downloads/transcription/staging only in `materialize`; record success/failure as job events. Store durable relative paths, not temporary absolute paths that cannot survive restart.

**Step 4: Run tests**

```bash
npx vitest run test/telegram-job-ingress.test.ts
npx tsc --noEmit
```

Expected: PASS.

---

### Task 7: Centralize queueing and Codex lifecycle in a durable coordinator

**Files:**

- Create: `src/telegram-job-coordinator.ts`
- Create: `src/telegram-turn-result.ts`
- Create: `test/telegram-job-coordinator.test.ts`
- Create: `test/telegram-turn-result.test.ts`

**Step 1: Write failing coordinator tests**

Cover:

- `accepted -> queued -> dispatching -> running` with one ledger event per fact;
- per-topic or bound-Codex-thread FIFO and global concurrency limits survive process recreation;
- `dispatching` persists the exact `threadId`, previous latest `turnId`, attempt number, start time, and transport-write state before `turn/start`;
- transition conflict reloads current projection and never performs a second dispatch;
- pre-write failure returns to queued with bounded backoff;
- explicit app-server rejection becomes terminal `failed` with a bounded safe code;
- post-write acceptance timeout sets attention code `dispatch_acceptance_unknown`;
- known `turnId` is persisted before subsequent activity;
- abort of queued work is terminal without contacting Codex;
- abort of a known running turn records request and final observed outcome separately;
- Codex completion produces a normalized `TelegramTurnResult`, not Telegram sends;
- attempt budget defaults to five; a `retry_after` pause does not consume an attempt.

**Step 2: Verify RED**

```bash
npx vitest run test/telegram-job-coordinator.test.ts test/telegram-turn-result.test.ts
```

Expected: FAIL because coordinator/result modules do not exist.

**Step 3: Implement the coordinator**

Inject:

- job store;
- ingress materializer;
- Codex session adapter;
- clock/id generator;
- concurrency policy;
- wakeup scheduler.

The coordinator is the only component allowed to initiate `turn/start` for a persisted job. It consumes callbacks from Task 5 and stores each observation with optimistic version checks.

**Step 4: Implement result normalization**

Make `TelegramTurnResult` contain ordered logical content and attachment references. It must be serializable and independent of grammY message objects. Do not mark completion or perform delivery here.

**Step 5: Run focused verification**

```bash
npx vitest run test/telegram-job-coordinator.test.ts test/telegram-turn-result.test.ts
npx tsc --noEmit
```

Expected: PASS.

---

### Task 8: Build an idempotent response plan and Telegram delivery outbox

**Files:**

- Create: `src/telegram-response-plan.ts`
- Create: `src/telegram-delivery-outbox.ts`
- Create: `test/telegram-response-plan.test.ts`
- Create: `test/telegram-delivery-outbox.test.ts`
- Modify: `src/telegram-job-store.ts`

**Step 1: Write failing response-plan tests**

For the same normalized result, assert deterministic ordered part keys and payloads for:

- a short text response;
- Telegram-length text chunks;
- documents/media plus captions;
- partial text plus failure detail;
- status anchor finalization;
- restart/rebuild producing byte-for-byte identical part keys.

**Step 2: Write failing outbox tests**

Cover:

- each part transitions `pending -> sending -> delivered`;
- known-message edits use stable `chatId + messageId` idempotency;
- a new-message send timeout becomes `uncertain`, never silently retried;
- retrying an edit after timeout is safe because the target message is known;
- Telegram `message is not modified` counts as delivered for known edits;
- `retry_after` reschedules the part without consuming an attempt;
- permanent Telegram errors become `failed` with bounded operator actions;
- restart sends only pending/safe-retry parts;
- job becomes terminal/completed only after every planned part is delivered;
- partial/uncertain delivery never renders `Done`.

**Step 3: Verify RED**

```bash
npx vitest run test/telegram-response-plan.test.ts test/telegram-delivery-outbox.test.ts
```

Expected: FAIL because response-plan/outbox modules and delivery persistence do not exist.

**Step 4: Implement delivery persistence over the schema from Task 2**

Add prepared store operations for deterministic plan insertion, compare-and-swap delivery transitions, due-part selection, and job delivery summaries. Persist the response plan and all pending parts in one transaction before the first Telegram call. Verify stored payloads against `content_hash` before sending.

**Step 5: Implement safe delivery policy**

Wrap all Telegram calls in a 30-second deadline. Classify outcomes by whether the message identity is known. Expose an explicit `send again with warning` operation for uncertain new-message delivery; never perform it automatically.

**Step 6: Run tests**

```bash
npx vitest run test/telegram-response-plan.test.ts test/telegram-delivery-outbox.test.ts
npx tsc --noEmit
```

Expected: PASS.

---

### Task 9: Read Guardian observations through its existing inspection IPC

**Files:**

- Modify: `src/session-guardian-ipc-protocol.ts`
- Modify: `src/session-guardian-store.ts`
- Modify: `src/session-guardian-service.ts`
- Modify: `src/session-guardian-ipc-client.ts`
- Modify: `test/session-guardian-service.test.ts`
- Modify: `test/session-guardian-ipc-commands.test.ts`

**Step 1: Write failing backward-compatibility tests**

Extend the existing `GET /v1/threads/<UUID>` response with an optional field:

```ts
interface GuardianObservationInspection {
  guardianHealth: "healthy" | "checking" | "stalled";
  lastObservedAt: number;
  unchangedSince: number;
  staleForMs: number;
  alertId: string | null;
  repairState: "none" | "eligible" | "in_progress" | "terminal";
  repairOutcome: GuardianRepairOutcome | null;
}
```

Cover:

- old clients can ignore the optional field;
- unknown thread returns the existing response shape/status;
- current observation and recovery attempt are selected deterministically;
- an active child keeps classification non-stalled;
- unavailable Guardian storage is reported, not converted to healthy;
- reads do not trigger restore, interrupt, resume, archive, or service restart.

**Step 2: Verify RED**

```bash
npx vitest run test/session-guardian-service.test.ts test/session-guardian-ipc-commands.test.ts
```

Expected: FAIL because inspection does not expose observations.

**Step 3: Extend the existing endpoint only**

Add a bounded store query for the latest alert/repair attempt associated with an exact thread, then reuse Guardian's current observation and recovery records. Do not add a second stall detector in TeleCodex. Keep current restore endpoints and ownership unchanged.

**Step 4: Add bounded TeleCodex reads**

Guardian inspection should time out and return `unavailable` to the status projection without blocking job execution or delivery.

**Step 5: Run tests**

```bash
npx vitest run test/session-guardian-service.test.ts test/session-guardian-ipc-commands.test.ts
npx tsc --noEmit
```

Expected: PASS.

---

### Task 10: Produce one honest status projection and one durable Telegram anchor

**Files:**

- Create: `src/telegram-status-projection.ts`
- Create: `test/telegram-status-projection.test.ts`
- Modify: `src/turn-progress.ts`
- Modify: `src/status-board.ts`
- Modify: `src/status-board-render.ts`
- Modify: `test/turn-progress.test.ts`
- Modify: `test/status-board.test.ts`
- Modify: `test/status-board-render.test.ts`

**Step 1: Write failing projection tests**

Combine the job projection, latest event, Guardian observation, and deliveries. Assert:

- queued shows queue position and age;
- dispatching distinguishes not-sent, written/unknown, and identified turn;
- running shows activity kind and age of last real Codex/Guardian event;
- a Node timer alone cannot refresh Codex activity;
- Guardian `stalled` overrides optimistic local health;
- Guardian unavailable remains visible while the job remains actionable;
- delivering shows delivered/total parts and uncertain/failed parts;
- completed but undelivered is not Done;
- the global board lists unfinished jobs whose anchor is not known to be delivered;
- all timestamps and reason codes are visible in details;
- the same projection powers Telegram, `/status`, and Dashboard DTOs.

**Step 2: Define exact button rules in tests**

```text
queued/running       -> Abort, Refresh, Details
dispatch unknown     -> Inspect, Retry as new turn, Details
stalled              -> Guardian Restore, Details
delivery failed      -> Retry delivery, Details
delivery uncertain   -> Send again with warning, Details
terminal delivered   -> Details
```

Buttons must carry job id plus expected version to reject stale callbacks.

**Step 3: Verify RED**

```bash
npx vitest run test/telegram-status-projection.test.ts test/turn-progress.test.ts test/status-board.test.ts test/status-board-render.test.ts
```

Expected: FAIL because there is no unified projection.

**Step 4: Implement a single status presenter**

- Replace optimistic `TurnProgressPresenter.complete()` with projection-driven finalization.
- Persist the progress/status anchor message id as a delivery part.
- Render age, latest activity, Guardian classification, delivery state, attention reason, and available actions.
- Suppress redundant edits by comparing the last successfully delivered rendered payload.
- Continue treating `message is not modified` as success.
- Refresh active projections frequently enough that a state change is visible within five seconds, without treating the refresh timer as work activity.

**Step 5: Run tests and typecheck**

```bash
npx vitest run test/telegram-status-projection.test.ts test/turn-progress.test.ts test/status-board.test.ts test/status-board-render.test.ts
npx tsc --noEmit
```

Expected: PASS.

---
