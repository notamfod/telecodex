# TeleCodex Missing Topic Job Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the one historical response plan from its deleted Telegram forum topic into a replacement topic bound to the same Codex session.

**Architecture:** A strict pure predicate identifies a recoverable plan. A versioned SQLite saga reserves topic creation, records rate-limit or ambiguous outcomes, and atomically rewrites every undelivered payload plus the status-anchor plan before scheduling one outbox retry. Runtime and Dashboard wiring stay behind a default-off feature flag until the fourth microrelease.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, grammY, Vitest, Svelte, systemd, curl, rsync.

---

## Boundaries

- Design: `docs/superpowers/specs/2026-09-06-telecodex-missing-topic-job-recovery-design.md`.
- Repository: `/root/Documents/Codex/2026-08-07-hermes/telecodex`.
- Preserve all existing dirty-worktree changes. Read every target file before editing it.
- Use `apply_patch` for edits and `TMPDIR=/var/tmp` for builds and tests.
- Do not print job, user, chat, topic, message, thread, payload, title, token, or response content.
- Do not commit, push, merge, or open a PR without a separate user instruction.
- Do not restore an old database after Telegram has confirmed or may have accepted topic creation or message sending.
- Finish and release each numbered microrelease before starting the next one.

## File map

- Create `src/telegram-topic-recovery.ts`, `src/telegram-topic-recovery-source-codec.ts`,
  `src/telegram-topic-recovery-ledger.ts`, and `src/telegram-topic-recovery-runtime.ts`
  for the pure contract, exact-raw source boundary, SQLite saga, and runtime.
- Modify `src/telegram-job-ledger-schema.ts` and `src/telegram-job-ledger.ts` for schema v7, store methods, and retention.
- Modify `src/session-registry.ts`, `src/config.ts`, `.env.example`, `src/telegram-reliability-runtime.ts`, and `src/index.ts` for binding, configuration, and composition.
- Modify `src/telegram-status-projection.ts`, `src/telegram-grammy-transport.ts`, `src/status-board-render.ts`, `src/bot.ts`, and `src/mini-app-server.ts` for the versioned action.
- Add focused tests beside each boundary under `test/`.

## Companion rollout procedure

After each task, use the exact verification, private staging, restart, rollback,
and observation commands in
`docs/superpowers/plans/2026-09-06-telecodex-missing-topic-job-recovery-rollout.md`.
That companion plan also contains the only authorized live action in 05.5.

### Task 1: Microrelease 05.1, pure eligibility and payload rewriting

**Files:**
- Create: `src/telegram-topic-recovery.ts`
- Create: `test/telegram-topic-recovery.test.ts`

- [ ] **Step 1: Write the failing exact-candidate test**

Define a fixture with a `delivering` job, one failed topic-bound status anchor, two pending response-plan parts, one `send_rich` fallback, a matching durable source, and a live thread descriptor. Assert:

```ts
const candidate = planTelegramTopicRecovery(fixture());
expect(candidate).toMatchObject({
  jobId: "job-1",
  expectedVersion: 7,
  oldDestination: { chatId: -100123, messageThreadId: 41 },
  threadId: "018f0000-0000-7000-8000-000000000001",
});
expect(candidate?.parts).toHaveLength(3);
```

- [ ] **Step 2: Run the new test and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-topic-recovery.test.ts
```

Expected: FAIL because `telegram-topic-recovery.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure contract**

Export these exact public types and functions:

```ts
export interface TelegramTopicDestination {
  readonly chatId: number;
  readonly messageThreadId: number;
}

export interface TelegramTopicRecoveryCandidate {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly threadId: string;
  readonly topicName: string;
  readonly oldDestination: TelegramTopicDestination;
  readonly parts: readonly ReboundTelegramDelivery[];
  readonly anchorPlan: ReboundTelegramDelivery;
}

export interface ReboundTelegramDelivery {
  readonly partKey: string;
  readonly payload: TelegramDeliveryPayload;
  readonly contentHash: string;
}

export interface TelegramTopicRecoveryEligibilityInput {
  readonly job: TelegramJob;
  readonly source: TelegramWorkSource;
  readonly deliveries: readonly DeliveryPart[];
  readonly anchorPlan: { readonly payload: unknown; readonly contentHash: string } | null;
  readonly thread: CodexThreadRecord | null;
}

export function planTelegramTopicRecovery(
  input: TelegramTopicRecoveryEligibilityInput,
): TelegramTopicRecoveryCandidate | null;

export function rebindTelegramTopicPayload(
  payload: unknown,
  oldDestination: TelegramTopicDestination,
  newDestination: TelegramTopicDestination,
): { readonly payload: TelegramDeliveryPayload; readonly contentHash: string };
```

Use `normalizeTelegramDeliveryPayload` and `hashTelegramDeliveryPayload`. Reject edits, mixed destinations, missing or extra response parts, any delivered/sending/uncertain part, a non-failed anchor, a missing anchor plan, and fallback mismatch. Do not modify input objects.

- [ ] **Step 4: Add rejection and immutability cases**

Use a table test whose mutations cover these names exactly:

```ts
it.each([
  "stale job phase", "missing thread", "delivered follower", "sending follower",
  "uncertain follower", "mixed primary destination", "mixed fallback destination",
  "missing plan part", "extra plan part", "anchor plan mismatch",
])("rejects %s", (caseName) => {
  expect(planTelegramTopicRecovery(invalidFixture(caseName))).toBeNull();
});
```

Also assert deep equality of the original fixture before and after planning.

- [ ] **Step 5: Run 05.1 verification and install it**

Run the focused command, then the shared full gate:

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-topic-recovery.test.ts
```

Set:

```bash
export TELECODEX_RELEASE_TAG=05.1-eligibility
```

Run the shared build, preflight, install, and ten-minute observation. Confirm through a read-only import/test probe that no production code calls `planTelegramTopicRecovery` yet.

### Task 2: Microrelease 05.2, schema and atomic ledger saga

**Files:**
- Create: `src/telegram-topic-recovery-source-codec.ts`
- Create: `src/telegram-topic-recovery-ledger.ts`
- Create: `test/telegram-topic-recovery-ledger.test.ts`
- Modify: `src/telegram-job-ledger-schema.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `test/telegram-job-store-sqlite.test.ts`
- Modify: `test/telegram-job-reconciliation-scan.test.ts`
- Modify: `test/telegram-delivery-outbox.test.ts`

The source codec is a narrow safety boundary, not a generic JSON helper. It
reconstructs the canonical `TelegramWorkSource` property order and rejects any
raw SQLite serialization that differs by whitespace, key order, shape, or
value normalization. The ledger separately requires exact canonical raw JSON
for every delivery payload and the installed anchor plan before reservation
and completion.

- [ ] **Step 1: Write the failing v6-to-v7 migration test**

Assert `user_version=7`, the exact `topic_recoveries` columns, a primary key on `job_id`, a unique `action_token`, and a foreign key to `jobs(id)`. The table definition is:

```sql
CREATE TABLE topic_recoveries (
  job_id TEXT PRIMARY KEY, action_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, old_chat_id INTEGER NOT NULL,
  old_message_thread_id INTEGER NOT NULL, new_message_thread_id INTEGER,
  reserved_job_version INTEGER NOT NULL, current_job_version INTEGER NOT NULL,
  next_attempt_at_ms INTEGER, reason_code TEXT,
  started_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
)
```

- [ ] **Step 2: Run the schema tests and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-job-store-sqlite.test.ts
```

Expected: FAIL because the current schema version is 6.

- [ ] **Step 3: Add schema v7**

Set `SCHEMA_VERSION = 7`, define `TABLES_V7`, create the table for versions 1 through 6 after existing migrations, validate `TABLES_V7`, and keep the whole migration inside the current immediate transaction.

- [ ] **Step 4: Write failing reserve and complete tests**

Assert these store calls and results:

```ts
const reserved = store.reserveTopicRecovery({
  jobId: job.id, expectedVersion: job.version, eventId: "reserve-1",
  actionToken: "token-1", eventAt: NOW,
});
expect(reserved.recovery.state).toBe("in_flight");
expect(reserved.job.version).toBe(job.version + 1);

const completed = store.completeTopicRecovery({
  jobId: job.id, expectedVersion: reserved.job.version, eventId: "complete-1",
  actionToken: "token-1", target: { chatId: -100123, messageThreadId: 99 },
  eventAt: NOW + 1,
});
expect(completed.recovery.state).toBe("complete");
expect(completed.anchor.state).toBe("pending");
expect(completed.job.version).toBe(reserved.job.version + 1);
```

- [ ] **Step 5: Define recovery records and store surface**

Create `TelegramTopicRecoveryLedger` and expose these methods through `SqliteTelegramJobStore`:

```ts
type TelegramTopicRecoveryState = "in_flight" | "retry_wait" | "unknown" | "complete" | "failed";
interface TelegramTopicRecoveryRecord {
  readonly jobId: string; readonly actionToken: string;
  readonly state: TelegramTopicRecoveryState;
  readonly oldDestination: TelegramTopicDestination;
  readonly newMessageThreadId: number | null;
  readonly reservedJobVersion: number; readonly currentJobVersion: number;
  readonly nextAttemptAt: number | null;
  readonly reasonCode: "TOPIC_RECOVERY_RATE_LIMITED" | "TOPIC_RECOVERY_UNKNOWN" | "TOPIC_RECOVERY_FAILED" | null;
  readonly startedAt: number; readonly updatedAt: number;
}
interface TelegramTopicRecoveryResult {
  readonly job: TelegramJob; readonly recovery: TelegramTopicRecoveryRecord;
}
interface TelegramTopicRecoveryCompletion extends TelegramTopicRecoveryResult {
  readonly anchor: DeliveryPart;
}

reserveTopicRecovery(input: {
  readonly candidate: TelegramTopicRecoveryCandidate; readonly eventId: string;
  readonly actionToken: string; readonly eventAt: number; // token is exactly 64 lowercase hex
}): TelegramTopicRecoveryResult;
deferTopicRecovery(input: {
  readonly jobId: string; readonly expectedVersion: number; readonly actionToken: string;
  readonly nextAttemptAt: number; readonly updatedAt: number;
}): TelegramTopicRecoveryRecord;
resumeTopicRecovery(input: {
  readonly jobId: string; readonly expectedVersion: number; readonly actionToken: string;
  readonly updatedAt: number;
}): TelegramTopicRecoveryResult;
markTopicRecoveryUnknown(input: {
  readonly jobId: string; readonly expectedVersion: number; readonly actionToken: string;
  readonly reasonCode: "TOPIC_RECOVERY_UNKNOWN"; readonly updatedAt: number;
}): TelegramTopicRecoveryRecord;
failTopicRecovery(input: {
  readonly jobId: string; readonly expectedVersion: number; readonly actionToken: string;
  readonly reasonCode: "TOPIC_RECOVERY_FAILED"; readonly updatedAt: number;
}): TelegramTopicRecoveryRecord;
completeTopicRecovery(input: {
  readonly jobId: string; readonly expectedVersion: number; readonly eventId: string;
  readonly actionToken: string; readonly target: TelegramTopicDestination;
  readonly eventAt: number;
}): TelegramTopicRecoveryCompletion;
getTopicRecovery(jobId: string): TelegramTopicRecoveryRecord | null;
listTopicRecoveries(states: readonly TelegramTopicRecoveryState[], limit?: number): readonly TelegramTopicRecoveryRecord[];
```

Decode rows strictly and reject unknown states, nullable-field mismatches, or
out-of-range values.

- [ ] **Step 6: Implement versioned reservation**

Validate the candidate, recheck every database-backed field inside one
immediate transaction, insert `in_flight`, advance the job version, and set
bounded recovery attention. The runtime rechecks the Codex thread immediately
before this call. Require exact canonical raw serialization for the durable
source, anchor plan, anchor delivery, and every follower before advancing the
job or inserting the reservation.

- [ ] **Step 7: Implement outcome transitions**

Add compare-and-swap transitions from `in_flight` to `retry_wait`, `unknown`,
or `failed`. Require the token and current job version; advance the job version
and attention on each transition. Add a public compare-and-swap transition
from due `retry_wait` back to `in_flight`; reject an early deadline or stale
state, token, or version without writes. Accept only 64-character lowercase
hex action tokens and the closed operational outcome codes.

- [ ] **Step 8: Implement atomic completion**

Recheck the exact raw canonical source, plan, and delivery serialization. In
one immediate transaction, update source, every delivery payload/hash, the
anchor plan, anchor state, recovery record, and job projection. Roll back on
any mismatch.

- [ ] **Step 9: Add rollback and isolation tests**

For stale job version, token, recovery state, source, delivery state, payload, content hash, and anchor plan, snapshot all affected tables before the call and assert exact equality afterward. Insert a second job and assert its rows are unchanged after successful completion.

- [ ] **Step 10: Cover retention and read-only behavior**

Delete `topic_recoveries` before deleting a retained job. Assert archive/scrub does not leak response content into the recovery row. Assert the read-only store can inspect recovery rows but rejects mutations through SQLite.

- [ ] **Step 11: Run 05.2 verification and install it**

Run the focused command, then the shared full gate:

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-topic-recovery-ledger.test.ts test/telegram-job-store-sqlite.test.ts
```

Set:

```bash
export TELECODEX_RELEASE_TAG=05.2-ledger
```

Run the shared build, preflight, install, and observation. Read-only verification must show schema version 7, zero recovery rows, unchanged historical delivery counts, quick check `ok`, and zero foreign-key violations.

### Task 3: Microrelease 05.3, disabled runtime and restart reconciliation

**Files:**
- Create: `src/telegram-topic-recovery-runtime.ts`
- Create: `test/telegram-topic-recovery-runtime.test.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `test/config.test.ts`
- Modify: `src/session-registry.ts`
- Modify: `test/session-registry.test.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/index.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`

- [ ] **Step 1: Write the failing default-off config test**

```ts
delete process.env.TELEGRAM_TOPIC_RECOVERY_ENABLED;
expect(loadConfig().telegramTopicRecoveryEnabled).toBe(false);
process.env.TELEGRAM_TOPIC_RECOVERY_ENABLED = "true";
expect(loadConfig().telegramTopicRecoveryEnabled).toBe(true);
```

For any value other than `true` or `false`, fail closed to `false` through the
repository's boolean parser and assert its bounded warning. Document
`TELEGRAM_TOPIC_RECOVERY_ENABLED=false` in `.env.example`.

- [ ] **Step 2: Implement the config field and verify it**

Add `telegramTopicRecoveryEnabled: boolean` to `TeleCodexConfig` and parse it with the repository's strict boolean helper. Run:

```bash
TMPDIR=/var/tmp npx vitest run test/config.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write failing registry rebind tests**

Start with old context `-100123:41` bound to the fixture thread. Call:

```ts
registry.rebindThreadTopic("-100123:41", "-100123:99", thread);
expect(registry.listContexts()).toEqual([
  expect.objectContaining({ contextKey: "-100123:99", threadId: thread.id }),
]);
```

Assert the old active session is disposed, callbacks clear the old key, and persisted JSON always contains the new binding. Mock a replace-safe temporary write and rename; on rename failure, keep the prior file readable and report failure to the caller.

- [ ] **Step 4: Implement replace-safe registry rebind**

Add `rebindThreadTopic(oldContextKey, newContextKey, thread): void`. Update the in-memory map once, dispose the old session, persist through a sibling temporary file plus `renameSync`, and restore the in-memory map if persistence fails.

- [ ] **Step 5: Write failing runtime outcome tests**

Construct the runtime with fake probe, create, ledger, registry, scheduler, and outbox adapters. Cover these exact outcomes:

```ts
await runtime.recover(action); // missing probe, one create, complete, bind, pump
expect(createForumTopic).toHaveBeenCalledTimes(1);
expect(store.completeTopicRecovery).toHaveBeenCalledTimes(1);
expect(outboxPump).toHaveBeenCalledTimes(1);
```

Also cover live/closed topic cancellation, 429 `retry_wait`, timeout `unknown`, permanent creation failure, startup `in_flight -> unknown`, due `retry_wait -> in_flight`, and `complete` local-binding reconciliation without topic creation.

- [ ] **Step 6: Implement the successful recovery path**

Export:

```ts
export interface TelegramTopicRecoveryRuntime {
  recover(action: TelegramStatusAction): Promise<void>;
  reconcile(): Promise<void>;
  dispose(): void;
}

export function createTelegramTopicRecoveryRuntime(
  options: TelegramTopicRecoveryRuntimeOptions,
): TelegramTopicRecoveryRuntime;
```

Keep per-job effects serialized. On success, complete the ledger transaction,
rebind the registry, send the welcome best-effort, and pump the existing
outbox.

- [ ] **Step 7: Implement definitive error outcomes**

Use `telegramRetryAfterMs` to persist `retry_wait` with its deadline. Persist
bounded `failed` reason codes for definitive non-429 errors and never pump the
outbox from either branch.

- [ ] **Step 8: Implement ambiguity and restart reconciliation**

Persist timeout and write ambiguity as `unknown` and never schedule it. At
startup convert inherited `in_flight` to `unknown`, schedule due `retry_wait`,
and repair only the registry binding for `complete`.

- [ ] **Step 9: Compose it without making it reachable**

Instantiate the recovery runtime only when `telegramTopicRecoveryEnabled` is true. Pass adapters from `src/index.ts` for `probeForumTopic`, `createForumTopic`, `getThread`, registry rebind, and welcome. Call its reconciliation from the reliability startup path and dispose its timers during shutdown. Do not add the action kind yet.

- [ ] **Step 10: Run 05.3 verification and install with the flag off**

Run the focused command, then the shared full gate:

```bash
TMPDIR=/var/tmp npx vitest run test/config.test.ts test/session-registry.test.ts test/telegram-topic-recovery-runtime.test.ts test/telegram-reliability-runtime.test.ts
```

Confirm no systemd drop-in or environment currently enables the new variable. Set:

```bash
export TELECODEX_RELEASE_TAG=05.3-runtime-disabled
```

Run the shared build, preflight, install, and observation. Read-only checks must show zero recovery rows and unchanged historical job version and delivery counts.

### Task 4: Microrelease 05.4, versioned Dashboard action and enablement

**Files:**
- Modify source: `src/telegram-status-projection.ts`, `src/telegram-reliability-runtime.ts`, `src/telegram-grammy-transport.ts`, `src/status-board-render.ts`, `src/bot.ts`, `src/mini-app-server.ts`
- Modify tests: `test/telegram-status-projection.test.ts`, `test/telegram-reliability-runtime.test.ts`, `test/telegram-grammy-transport.test.ts`, `test/status-board-render.test.ts`, `test/bot-message-reliability.test.ts`, `test/mini-app-server.test.ts`

- [ ] **Step 1: Write failing action-projection tests**

Add `recover_missing_topic` to `TelegramStatusActionKind`. Enrich only a server-proven candidate:

```ts
expect(enrichTopicRecoveryAction(projection, candidate).actions[0]).toEqual({
  kind: "recover_missing_topic",
  jobId: projection.jobId,
  expectedVersion: projection.expectedVersion,
});
```

Assert ordinary `retry_delivery` for the anchor is absent while recovery is `in_flight`, `retry_wait`, or `unknown`. Keep `details` and `inspect` as appropriate.

- [ ] **Step 2: Implement action enrichment**

Add the action only inside `loadDashboardReliability` after resolving the
current source, deliveries, recovery record, and Codex thread through the pure
predicate.

- [ ] **Step 3: Implement runtime action validation**

In `runDashboardAction`, special-case `recover_missing_topic`: recompute the
candidate under `expectedVersion`, reject stale actions, then call the recovery
runtime. Other actions keep their current path.

- [ ] **Step 4: Add transport and parser tests**

Use callback code `o` for `recover_missing_topic`, label it `Recover topic`, parse it in the bot callback map, allow it in `ACTION_KINDS`, and render the same bounded label in the status board. Assert callback data remains within Telegram's 64-byte limit and tampered job/version values are rejected.

- [ ] **Step 5: Implement transport, bot, board, and HTTP wiring**

Update the exhaustive action maps in all named files. The HTTP body remains:

```json
{"expectedVersion":541}
```

No destination or thread identifier may be accepted from the client. Runtime derives them from the canonical store and Codex database.

- [ ] **Step 6: Prove exactly one live action before enablement**

Run a read-only candidate scan against `.telecodex/jobs.sqlite` and the Codex state DB. Print only:

```json
{"eligible":1,"sending":0,"uncertain":0,"activeTurns":0,"quarantine":0}
```

Abort enablement on any other result.

- [ ] **Step 7: Run 05.4 verification, stage, and enable**

Run the exact focused command, then the shared full gate:

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-status-projection.test.ts test/telegram-reliability-runtime.test.ts test/telegram-grammy-transport.test.ts test/status-board-render.test.ts test/bot-message-reliability.test.ts test/mini-app-server.test.ts
```

Set:

```bash
export TELECODEX_RELEASE_TAG=05.4-dashboard-action
```

Build the candidate and rollback trees. Before stopping the service, create `/etc/systemd/system/telecodex.service.d/30-topic-recovery.conf` with `apply_patch` and this exact content:

```ini
[Service]
Environment=TELEGRAM_TOPIC_RECOVERY_ENABLED=true
```

Run `systemctl daemon-reload`, the shared preflight, install, and observation. Verify through one authenticated Dashboard refresh that exactly one recovery action is present and no recovery row was created. Do not invoke the action.
