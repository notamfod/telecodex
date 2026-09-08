# TeleCodex Existing Topic Resume Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build typed topic liveness, exact resume eligibility, a schema-v8 ledger, and a default-off runtime.

**Architecture:** The liveness classifier remains compatible with boolean callers. The resume ledger owns every pre-delivery state transition, and the existing outbox remains the only message sender. No action is reachable while this plan runs.

**Tech Stack:** TypeScript 5.9, Node.js 20+, better-sqlite3, grammY 1.45, Vitest 3.

---

Use the boundaries and shared verification, installation, and observation gates in `docs/superpowers/plans/2026-09-08-telecodex-existing-topic-resume.md`. Finish and install each task before starting the next one.

### Task 1: Microrelease 06.1, typed topic liveness

**Files:**
- Modify: `src/telegram-topic-liveness.ts`
- Modify: `test/telegram-topic-liveness.test.ts`
- Verify: `test/telegram-topic-liveness-api.test.ts`
- Verify: `test/telegram-topic-recovery-adapter.test.ts`
- Verify: `test/bot-topic-liveness.test.ts`

- [ ] **Step 1: Write failing live, closed, and missing classification tests**

Import `createForumTopicLivenessClassifier` and assert exact values:

```ts
const classify = createForumTopicLivenessClassifier({ sendChatAction });
await expect(classify(destination)).resolves.toBe("live");

await expect(createForumTopicLivenessClassifier({
  sendChatAction: vi.fn().mockRejectedValue(new Error("TOPIC_CLOSED")),
})(destination)).resolves.toBe("closed");

await expect(createForumTopicLivenessClassifier({
  sendChatAction: vi.fn().mockRejectedValue(new Error("TOPIC_DELETED")),
})(destination)).resolves.toBe("missing");
```

Retain the existing timeout, caller-abort, shared-request, cache-expiry, negative-cache, no-cache-on-error, and ambiguous-error assertions.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-topic-liveness.test.ts
```

Expected: FAIL because `createForumTopicLivenessClassifier` is not exported.

- [ ] **Step 3: Add the typed classifier and boolean compatibility adapter**

Use these public signatures:

```ts
export type ForumTopicLiveness = "live" | "closed" | "missing";

export function createForumTopicLivenessClassifier(
  options: ForumTopicLivenessOptions,
): (
  destination: ForumTopicDestination,
  callerSignal?: AbortSignal,
) => Promise<ForumTopicLiveness>;

export function createForumTopicLivenessProbe(
  options: ForumTopicLivenessOptions,
): (
  destination: ForumTopicDestination,
  callerSignal?: AbortSignal,
) => Promise<boolean> {
  const classify = createForumTopicLivenessClassifier(options);
  return async (destination, signal) => (await classify(destination, signal)) !== "missing";
}
```

Move the existing deadline, single-flight, and cache implementation into the classifier. Cache the typed result. Map a successful `sendChatAction` to `live`, only the bounded closed patterns to `closed`, and only the existing bounded missing patterns to `missing`. Propagate every other error object unchanged.

- [ ] **Step 4: Prove compatibility and one-request 429 behavior**

Run:

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-topic-liveness.test.ts \
  test/telegram-topic-liveness-api.test.ts \
  test/telegram-topic-recovery-adapter.test.ts \
  test/bot-topic-liveness.test.ts
```

Expected: all tests pass, existing boolean consumers still treat `live` and `closed` as existing, and the dedicated API makes one HTTP request on 429.

- [ ] **Step 5: Verify, commit, install, and observe 06.1**

Run the shared code gate and review. Commit:

```bash
git commit -m "NO-TICKET refactor: classify telegram topic liveness"
```

Set `TELECODEX_RELEASE_TAG=06.1-topic-liveness`, run the shared installation gate, and complete twenty clean snapshots. Confirm schema remains v7 and `topic_recoveries=1` without printing its identity.

### Task 2: Microrelease 06.2a, resume eligibility and schema-v8 ledger

**Files:**
- Create: `src/telegram-topic-resume.ts`
- Create: `src/telegram-topic-resume-ledger.ts`
- Create: `test/telegram-topic-resume.test.ts`
- Create: `test/telegram-topic-resume-ledger.test.ts`
- Modify: `src/telegram-job-ledger-schema.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `test/telegram-job-store-sqlite.test.ts`
- Modify: `test/telegram-job-reconciliation-scan.test.ts`
- Modify: `test/telegram-job-retention.test.ts`

- [ ] **Step 1: Write the failing exact eligibility test**

Build a fixture with one failed replacement recovery, the unchanged original binding, one failed status anchor, two pending followers including rich fallback data, the canonical anchor plan, no resume row, no quarantine, and a matching Codex thread. Assert:

```ts
const candidate = planTelegramTopicResume(fixture());
expect(candidate).toEqual({
  jobId: "job-1",
  expectedVersion: 541,
  threadId: "018f0000-0000-7000-8000-000000000001",
  destination: { chatId: -100123, messageThreadId: 41 },
  anchorPartKey: "status-anchor",
  anchorAttemptCount: 1,
});
```

- [ ] **Step 2: Add rejection and immutability cases, then verify RED**

Reject each of these names in a table test: non-failed recovery, recovery with a new topic, recovery destination mismatch, stale recovery version, existing resume row, quarantined job, missing binding, forum mismatch, missing thread, malformed source, missing or mismatched anchor plan, non-failed anchor, known anchor message, delivered follower, sending follower, uncertain follower, missing follower, extra follower, mixed primary destination, and mixed rich fallback destination. Assert the input fixture is unchanged.

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-topic-resume.test.ts
```

Expected: FAIL because `src/telegram-topic-resume.ts` does not exist.

- [ ] **Step 3: Implement the pure candidate contract**

Export these exact types:

```ts
export interface TelegramTopicResumeCandidate {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly threadId: string;
  readonly destination: TelegramTopicDestination;
  readonly anchorPartKey: "status-anchor";
  readonly anchorAttemptCount: number;
}

export interface TelegramTopicResumeEligibilityInput {
  readonly job: TelegramJob;
  readonly source: TelegramWorkSource;
  readonly deliveries: readonly DeliveryPart[];
  readonly anchorPlan: { readonly payload: unknown; readonly contentHash: string } | null;
  readonly thread: CodexThreadRecord | null;
  readonly recovery: TelegramTopicRecoveryRecord | null;
  readonly hasExistingAttempt: boolean;
  readonly forumChatId: number;
  readonly hasThreadTopicBinding: boolean;
  readonly quarantined: boolean;
}

export function planTelegramTopicResume(
  input: TelegramTopicResumeEligibilityInput,
): TelegramTopicResumeCandidate | null;
```

Reuse canonical payload normalization and hashing. Validate every primary and rich fallback destination, exact response-plan ordering, exact recovery state, job version, thread, forum, binding, and quarantine evidence. Do not rewrite payloads or source data.

- [ ] **Step 4: Write the failing v7-to-v8 migration test**

Require `user_version=8`, a foreign key to `jobs(id)`, a primary key on `job_id`, a unique action token, and this exact table:

```sql
CREATE TABLE topic_resume_attempts (
  job_id TEXT PRIMARY KEY, action_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, chat_id INTEGER NOT NULL, message_thread_id INTEGER NOT NULL,
  reserved_job_version INTEGER NOT NULL, current_job_version INTEGER NOT NULL,
  next_attempt_at_ms INTEGER, reason_code TEXT,
  started_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
)
```

Run:

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-job-store-sqlite.test.ts
```

Expected: FAIL because the current schema version is 7.

- [ ] **Step 5: Add schema v8 and the strict record decoder**

Set `SCHEMA_VERSION = 8`, define `TABLES_V8`, create `topic_resume_attempts` after every supported v1-v7 path, and validate `TABLES_V8`. Define:

```ts
export type TelegramTopicResumeState =
  | "probe_in_flight" | "probe_retry_wait"
  | "reopen_in_flight" | "reopen_retry_wait" | "reopen_unknown"
  | "delivery_handoff" | "complete" | "failed";

export type TelegramTopicResumeReasonCode =
  | "TOPIC_RESUME_PROBE_RATE_LIMITED"
  | "TOPIC_RESUME_PROBE_UNKNOWN"
  | "TOPIC_RESUME_REOPEN_RATE_LIMITED"
  | "TOPIC_RESUME_REOPEN_UNKNOWN"
  | "TOPIC_RESUME_SOURCE_MISSING"
  | "TOPIC_RESUME_REOPEN_FAILED"
  | "TOPIC_RESUME_DELIVERY_FAILED"
  | "TOPIC_RESUME_DELIVERY_UNCERTAIN";

export interface TelegramTopicResumeRecord {
  readonly jobId: string;
  readonly actionToken: string;
  readonly state: TelegramTopicResumeState;
  readonly destination: TelegramTopicDestination;
  readonly reservedJobVersion: number;
  readonly currentJobVersion: number;
  readonly nextAttemptAt: number | null;
  readonly reasonCode: TelegramTopicResumeReasonCode | null;
  readonly startedAt: number;
  readonly updatedAt: number;
}
```

Reject unknown state/reason combinations, invalid deadlines, invalid IDs, non-64-character lowercase hex tokens, non-monotonic timestamps, and version regressions.

- [ ] **Step 6: Write failing reservation and legal-transition tests**

Assert reservation inserts `probe_in_flight`, advances the job once, and sets `TOPIC_RESUME_PROBE_IN_FLIGHT`. Test this exact state matrix:

```ts
const LEGAL_TRANSITIONS = {
  probe_in_flight: ["probe_retry_wait", "reopen_in_flight", "delivery_handoff", "failed"],
  probe_retry_wait: ["probe_in_flight"],
  reopen_in_flight: ["reopen_retry_wait", "reopen_unknown", "delivery_handoff", "failed"],
  reopen_retry_wait: ["reopen_in_flight"],
  reopen_unknown: ["reopen_unknown", "delivery_handoff"],
  delivery_handoff: [], complete: [], failed: [],
} as const;
```

Each transition must require the exact prior state, action token, current job version, deadline rules, and bounded reason code.

- [ ] **Step 7: Implement the ledger and store surface**

Expose only these methods through `SqliteTelegramJobStore`:

```ts
reserveTopicResume(input: ReserveTopicResumeInput): TelegramTopicResumeResult;
transitionTopicResume(input: TransitionTopicResumeInput): TelegramTopicResumeResult;
settleTopicResumeDelivery(input: SettleTopicResumeDeliveryInput): TelegramTopicResumeRecord;
getTopicResume(jobId: string): TelegramTopicResumeRecord | null;
listTopicResumes(states: readonly TelegramTopicResumeState[], limit?: number): readonly TelegramTopicResumeRecord[];
getStatusAnchorPlan(jobId: string): { readonly payload: unknown; readonly contentHash: string } | null;
hasJobQuarantine(jobId: string): boolean;
```

`reserveTopicResume` must recompute all database-backed eligibility inside one immediate transaction. It requires the existing `topic_recoveries` row to remain `failed`, have no new topic, name the current destination, and match the current job version. It compares exact canonical raw JSON for source, anchor plan, anchor, every follower, and rich fallbacks before inserting the resume row.

`transitionTopicResume` advances the job and ledger together for every pre-handoff transition. A `reopen_unknown` self-transition may only record a safe-probe 429 deadline. `settleTopicResumeDelivery` accepts only `delivery_handoff`, observes the current job and delivery rows, and changes only the resume row to:

- `complete` for a terminal completed job with three delivered rows and a known anchor message ID;
- `failed/TOPIC_RESUME_DELIVERY_FAILED` for a later failed anchor;
- `failed/TOPIC_RESUME_DELIVERY_UNCERTAIN` for a later uncertain anchor.

Pending or sending delivery evidence leaves `delivery_handoff` unchanged.

- [ ] **Step 8: Add atomic rollback, read-only, and retention coverage**

For stale version, token, state, recovery row, source JSON, anchor plan, delivery state, payload JSON, content hash, destination, or quarantine, snapshot all affected tables before the call and assert byte-for-byte logical equality afterward. Test two concurrent store instances reserving the same job and require one winner. Assert read-only inspection succeeds, mutations fail, and retention deletes `topic_resume_attempts` before deleting the parent job.

- [ ] **Step 9: Run focused GREEN verification**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-topic-resume.test.ts \
  test/telegram-topic-resume-ledger.test.ts \
  test/telegram-job-store-sqlite.test.ts \
  test/telegram-job-reconciliation-scan.test.ts \
  test/telegram-job-retention.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 10: Back up and rehearse schema rollback before live installation**

Create a private online SQLite backup with mode `0600`. Require `quick_check=ok`, zero foreign-key violations, schema version 7, exactly one failed `topic_recoveries` row, and no pre-existing `topic_resume_attempts` table. Do not print record identity.

Open a copy with the 06.2a candidate so it migrates to v8. Require an empty resume table. In one immediate transaction, drop only `topic_resume_attempts` and set `user_version=7`. Require `quick_check=ok`, zero foreign-key violations, and successful read-only validation by the saved 06.1 build.

- [ ] **Step 11: Verify, commit, install, and observe 06.2a**

Run the shared code gate and review. Commit:

```bash
git commit -m "NO-TICKET feat: add existing topic resume ledger"
```

Set `TELECODEX_RELEASE_TAG=06.2a-resume-ledger`, then run the shared installation gate. Verify schema v8, `topic_resume_attempts=0`, `topic_recoveries=1`, unchanged delivery aggregates, `quick_check=ok`, and zero foreign-key violations. After twenty clean snapshots, v8 becomes the database rollback floor.

### Task 3: Microrelease 06.2b, default-off resume runtime

**Files:**
- Create: `src/telegram-topic-resume-api.ts`
- Create: `src/telegram-topic-resume-adapter.ts`
- Create: `src/telegram-topic-resume-runtime.ts`
- Create: `test/telegram-topic-resume-api.test.ts`
- Create: `test/telegram-topic-resume-adapter.test.ts`
- Create: `test/telegram-topic-resume-runtime.test.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `src/index.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `test/config.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`

- [ ] **Step 1: Write the failing strict default-off config test**

```ts
delete process.env.TELEGRAM_TOPIC_RESUME_ENABLED;
expect(loadConfig().telegramTopicResumeEnabled).toBe(false);
process.env.TELEGRAM_TOPIC_RESUME_ENABLED = "true";
expect(loadConfig().telegramTopicResumeEnabled).toBe(true);
```

For every value except literal `true` or `false`, require `false` and one bounded warning that names only the variable. Add `TELEGRAM_TOPIC_RESUME_ENABLED=false` to `.env.example`.

- [ ] **Step 2: Implement config and verify GREEN**

Add `telegramTopicResumeEnabled: boolean` to `TeleCodexConfig`, parse it with the existing strict boolean helper, and run:

```bash
TMPDIR=/var/tmp npx vitest run test/config.test.ts
```

- [ ] **Step 3: Write the dedicated API one-request tests**

Define the narrow API:

```ts
export interface TelegramTopicResumeApi {
  sendChatAction(
    chatId: number, action: "typing",
    options: { readonly message_thread_id: number }, signal: AbortSignal,
  ): Promise<unknown>;
  reopenForumTopic(chatId: number, messageThreadId: number, signal: AbortSignal): Promise<true>;
}
```

Use a fake fetch with `createTelegramTopicResumeApi(token, clientOptions)`. Assert `sendChatAction` and `reopenForumTopic` each issue exactly one HTTP request on 429 and reject with the original grammY error. No auto-retry transformer may be installed.

- [ ] **Step 4: Write failing runtime flow tests**

Cover these exact flows with fake ledger, classifier, reopen API, outbox, clock, and scheduler:

- `live -> delivery_handoff -> retryFailed("status-anchor", expectedVersion) -> complete`;
- `closed -> reopen_in_flight -> one reopen -> delivery_handoff`;
- `missing -> failed/TOPIC_RESUME_SOURCE_MISSING`, with no reopen or delivery;
- probe 429 -> `probe_retry_wait`, then one due probe;
- ambiguous initial probe -> `failed/TOPIC_RESUME_PROBE_UNKNOWN`;
- reopen 429 -> `reopen_retry_wait`, then one due reopen;
- definitive reopen 4xx -> `failed/TOPIC_RESUME_REOPEN_FAILED`;
- timeout, connection loss, cancellation after dispatch, and process death in `reopen_in_flight` -> `reopen_unknown`, never a second reopen;
- inherited `probe_in_flight` repeats only the nondestructive probe;
- inherited `reopen_unknown` probes once, continues only on confirmed `live`, and stores a 429 deadline without reopening;
- inherited `delivery_handoff` retries the failed anchor only when the job version still equals the handoff version, otherwise calls `outbox.pump()` and settles from durable evidence;
- pending delivery remains in handoff; uncertain and permanent failure stop; three delivered rows plus terminal completion mark complete;
- duplicate concurrent `resume(action)` calls reserve at most one attempt;
- `dispose()` aborts timers and in-process requests without converting cancellation into another Telegram call.

- [ ] **Step 5: Implement the runtime contract**

Export:

```ts
export interface TelegramTopicResumeRuntime {
  resume(action: TelegramStatusAction): Promise<void>;
  reconcile(): Promise<void>;
  dispose(): void;
}

export interface TelegramTopicResumeRuntimeOptions {
  readonly store: TopicResumeStore;
  readonly forumChatId: number;
  readonly classifyForumTopic: (
    destination: TelegramTopicDestination, signal: AbortSignal,
  ) => Promise<ForumTopicLiveness>;
  readonly reopenForumTopic: (
    destination: TelegramTopicDestination, signal: AbortSignal,
  ) => Promise<true>;
  readonly getThread: (threadId: string) => CodexThreadRecord | null;
  readonly hasThreadTopicBinding: (
    threadId: string, destination: TelegramTopicDestination,
  ) => boolean;
  readonly outboxRetryFailed: (
    jobId: string, partKey: "status-anchor", expectedJobVersion: number,
  ) => Promise<void>;
  readonly outboxPump: () => Promise<void>;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly operationTimeoutMs?: number;
  readonly scheduleWakeup?: (at: number, wake: () => void | Promise<void>) => void;
  readonly trackEffect?: (effect: Promise<void>) => void;
}
```

Serialize effects per job. Reserve before the first probe. Transition to `reopen_in_flight` before calling Telegram. Never call `reopenForumTopic` from `reopen_unknown`. Before delivery, transition to `delivery_handoff`, then call the existing outbox with the handoff job version. After every outbox return or scheduled pump, settle only from durable delivery evidence.

Use `telegramRetryAfterMs` for bounded 429 deadlines. Treat only an immediate recognized 4xx response as definitive reopen failure. Treat every timeout, connection loss, unreadable response, process death, and cancellation after dispatch as reopen ambiguity.

- [ ] **Step 6: Compose the runtime with no live reachability**

`src/telegram-topic-resume-adapter.ts` creates one typed classifier and uses the dedicated API. `src/index.ts` constructs it only when `telegramTopicResumeEnabled` is true. `src/telegram-reliability-runtime.ts` owns the runtime, calls `reconcile()` at startup, routes its outbox callbacks, tracks its effects, and disposes it on shutdown. Do not add `resume_existing_topic` to any action union in this checkpoint.

- [ ] **Step 7: Run focused GREEN verification**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/config.test.ts \
  test/telegram-topic-resume-api.test.ts \
  test/telegram-topic-resume-adapter.test.ts \
  test/telegram-topic-resume-runtime.test.ts \
  test/telegram-reliability-runtime.test.ts
```

Expected: all focused tests pass and no status projection can produce the new action.

- [ ] **Step 8: Verify, commit, install, and observe 06.2b with the flag off**

Inspect `systemctl cat telecodex.service` and its environment without printing secret values. Require that `TELEGRAM_TOPIC_RESUME_ENABLED` is absent or false. Run the shared code gate and review. Commit:

```bash
git commit -m "NO-TICKET feat: add existing topic resume runtime"
```

Set `TELECODEX_RELEASE_TAG=06.2b-resume-runtime-disabled`, run the shared installation gate, and complete twenty clean snapshots. Require schema v8, zero resume rows, and no `reopenForumTopic` call in aggregate logs.

