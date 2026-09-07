# TeleCodex Message Reliability Plan, Part 3: Reconciliation and rollout

> Part of [TeleCodex Message Reliability Implementation Plan](2026-08-22-telecodex-message-reliability.md). Follow its required skills, execution constraints, state contract, and file map.

---

### Task 11: Reconcile unfinished jobs on restart without replaying prompts

**Files:**

- Create: `src/telegram-job-reconciler.ts`
- Create: `test/telegram-job-reconciler.test.ts`
- Modify: `src/telegram-runner.ts`
- Modify: `test/telegram-runner.test.ts`

**Step 1: Write the restart matrix as failing tests**

```text
accepted                              -> restore anchor/materialization, then queue
queued, no dispatch write             -> enqueue the same job
dispatching, proven not sent           -> enqueue the same job
dispatching, write acceptance unknown  -> inspect only; attention required
running, exact turn active             -> attach to that exact turn
running, exact turn completed          -> rebuild normalized result
running, turn absent/ambiguous          -> inspect Guardian; attention required
delivering                              -> resume only pending or safe-retry parts
terminal                                -> no execution; refresh projection only
```

Additionally cover:

- no branch calls the original prompt handler;
- no ambiguous branch calls `turn/start`;
- Guardian restore in progress remains visible and blocks competing TeleCodex recovery;
- Guardian `self-recovered` reconciles the exact turn and continues normal delivery;
- Guardian `restored` terminates the old job as `recovery_interrupted`, never completed;
- Guardian `failed` keeps attention required, and Guardian unavailable disables recovery actions without blocking ordinary jobs;
- reconciliation is idempotent across repeated process restarts;
- polling starts only after initial reconciliation completes or reaches bounded unavailable states;
- one corrupt job is quarantined without hiding other unfinished jobs.

**Step 2: Verify RED**

```bash
npx vitest run test/telegram-job-reconciler.test.ts test/telegram-runner.test.ts
```

Expected: FAIL because the reconciler does not exist and runner calls legacy recovery.

**Step 3: Implement explicit reconciliation**

Inject read-only app-server `thread/read`, exact-turn recovery, Guardian inspection, coordinator enqueue, and delivery outbox. Persist every reconciliation decision as a ledger event before performing its next side effect.

Replace startup re-entry through `handleUserPrompt()` with `reconcileUnfinishedJobs()`. Keep a compatibility shim only until Task 12 removes legacy routes.

**Step 4: Run focused tests**

```bash
npx vitest run test/telegram-job-reconciler.test.ts test/telegram-runner.test.ts
npx tsc --noEmit
```

Expected: PASS.

---

### Task 12: Route all work-producing bot paths through durable ingress

**Files:**

- Create: `src/telegram-work-handlers.ts`
- Create: `test/telegram-work-handlers.test.ts`
- Modify: `src/bot.ts`
- Modify: `src/index.ts`
- Create: `test/bot-message-reliability.test.ts`
- Modify: `test/bot-commands.test.ts`

**Step 1: Add integration tests around the public bot handlers**

For text, voice/audio, photo, document, and explicit retry callbacks, assert the call order:

```text
normalize source
-> durable accept/deduplicate
-> create/update status anchor
-> materialize input
-> queue coordinator
```

Cover:

- duplicate delivery from Telegram causes one job, one turn, and one response plan;
- work-producing commands and confirmation callbacks use the same durable acceptance path;
- photo/document file downloads begin only after durable acceptance;
- Telegram status failure cannot drop an accepted job;
- a bot restart between any two boundaries is handled by Task 11;
- commands that do not start work remain outside this path;
- per-topic `promptTails` no longer owns correctness;
- old JSON store construction and `handleUserPrompt` startup replay disappear.

**Step 2: Verify RED**

```bash
npx vitest run test/telegram-work-handlers.test.ts test/bot-message-reliability.test.ts test/bot-commands.test.ts
```

Expected: FAIL until bot wiring uses the ingress/coordinator.

**Step 3: Extract handlers and dependency wiring**

- Construct store, ingress, coordinator, outbox, reconciler, and projection service in `src/index.ts` or the existing composition root.
- Inject them into `createBot`; do not construct storage inside `bot.ts`.
- Keep `bot.ts` focused on grammY routing and command orchestration.
- Route callbacks using durable job ids and optimistic versions.
- Route an explicit Guardian Restore action through the existing Guardian repair IPC only; never perform archive/resume logic inside TeleCodex.
- Delete obsolete compatibility adapters only after every caller is migrated and tests prove no references remain.

**Step 4: Verify no bypass remains**

```bash
rg -n "handleUserPrompt|new TelegramJobStore|promptTails|recoverPendingJobs" src test
```

Expected: only intentional compatibility/test references remain, with an inline removal reason; no work-producing handler bypasses ingress.

**Step 5: Run focused tests and typecheck**

```bash
npx vitest run test/telegram-work-handlers.test.ts test/bot-message-reliability.test.ts test/bot-commands.test.ts
npx tsc --noEmit
```

Expected: PASS.

---

### Task 13: Expose readiness, health, and unified status in the Dashboard

**Files:**

- Modify: `src/dashboard-api.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `src/config.ts`
- Modify: `test/dashboard-api.test.ts`
- Modify: `test/mini-app-server.test.ts`
- Modify: `test/config.test.ts`
- Modify: `web/src/model.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.svelte`
- Modify: `web/src/ThreadRow.svelte`
- Modify: `web/src/app.css`

**Step 1: Write backend endpoint tests**

Add unauthenticated process probes with no sensitive payload:

- `/healthz`: Node event loop/server responds and store can perform a bounded read;
- `/readyz`: initial migration/reconciliation is complete, store is writable, polling ownership is established, and required local dependencies are reachable;
- return non-2xx with bounded reason codes, never prompts, tokens, paths, or raw errors.

Extend authenticated dashboard DTOs with phase/health/activity/attention/delivery, last real event age, app-server connectivity, Guardian connectivity/mode/scan age, Telegram delivery health, oldest queue age, and counts for ambiguous/stalled/undelivered jobs.

**Step 2: Write frontend component tests/check expectations**

Require:

- separate badges for phase and health;
- delivery progress independent from Codex outcome;
- latest activity plus human-readable age;
- attention reason and only legal actions;
- Guardian unavailable/stalled visually distinct from completed;
- exact thread/job correlation and a details view;
- `In progress`, `Needs attention`, and `Recent` grouping backed by the shared projection;
- an event timeline containing timestamps and safe codes but no prompt/response content;
- no color-only status indication and keyboard-accessible actions.

**Step 3: Verify RED**

```bash
npx vitest run test/dashboard-api.test.ts test/mini-app-server.test.ts test/config.test.ts
npm run check:web
```

Expected: backend tests or web checks FAIL until contracts are updated.

**Step 4: Implement configuration defaults**

```text
TELEGRAM_JOB_DB_PATH=<workspace>/.telecodex/jobs.sqlite
TELEGRAM_JOB_STORE_MODE=json
TELEGRAM_JOB_MAX_ATTEMPTS=5
TELEGRAM_JOB_PAYLOAD_RETENTION_DAYS=7
TELEGRAM_JOB_METADATA_RETENTION_DAYS=90
APP_SERVER_CONNECT_TIMEOUT_SECONDS=10
APP_SERVER_REQUEST_TIMEOUT_SECONDS=15
APP_SERVER_TURN_START_TIMEOUT_SECONDS=30
TELEGRAM_DELIVERY_TIMEOUT_SECONDS=30
```

Validate numeric ranges at startup. Keep secrets out of dashboard/status DTOs and logs.

**Step 5: Implement the Dashboard projection**

Consume the same projection service as Telegram; do not duplicate status derivation in Svelte. Keep the current authenticated dashboard behavior. Poll at most every five seconds while work is active or needs attention, and fall back to the current 15-second interval when idle; user refresh/action calls fetch immediately.

**Step 6: Run backend and web verification**

```bash
npx vitest run test/dashboard-api.test.ts test/mini-app-server.test.ts test/config.test.ts
npm run check:web
npm run build:web
npx tsc --noEmit
```

Expected: PASS. If the repository has no `build:web` script, use the existing web build script shown by `npm run` and update this line before execution.

---

### Task 14: Add retention and the end-to-end fault-injection suite

**Files:**

- Modify: `src/telegram-job-store.ts`
- Create: `test/telegram-job-retention.test.ts`
- Create: `test/telegram-reliability-faults.test.ts`
- Create: `test/telegram-reliability-fixtures.ts`

**Step 1: Write failing retention tests**

Cover:

- payloads/attachment references retained for seven days after terminal delivery or explicit dismissal;
- metadata/events retained for 90 days;
- unresolved, ambiguous, stalled, failed-delivery, and Guardian-recovery jobs are never automatically purged;
- deletion order preserves foreign keys and never removes shared live files;
- cleanup is batched and restart-safe;
- clock rollback cannot cause early deletion;
- structured logs and stored operational metadata never contain prompt text, response text, tool output, credentials, or attachment content.

**Step 2: Write named end-to-end fault scenarios**

Create these exact test cases:

```text
duplicate_update_creates_one_job
crash_after_inbox_commit_recovers_anchor
turn_start_timeout_after_write_never_replays
lost_turn_completed_is_reconciled_from_thread_read
restart_running_reattaches_exact_turn
restart_delivering_sends_only_pending_parts
telegram_send_timeout_marks_new_message_uncertain
telegram_edit_timeout_retries_known_anchor
partial_delivery_never_renders_done
guardian_unavailable_keeps_job_visible
full_disk_fails_before_dispatch
corrupt_schema_fails_before_polling
crash_after_telegram_accepts_send_marks_uncertain
active_subagent_without_text_updates_activity
telegram_retry_after_does_not_consume_attempt
telegram_noop_edit_is_success
```

Drive the real store, ingress, coordinator, reconciler, projection, and outbox with deterministic fake boundaries. Do not mock the state machine itself.

**Step 3: Verify RED, then implement retention and missing seams**

```bash
npx vitest run test/telegram-job-retention.test.ts test/telegram-reliability-faults.test.ts
```

Expected before implementation: FAIL. After implementing batched retention and any required dependency injection: PASS.

**Step 4: Run the full repository verification**

Run sequentially while the checkout is stable:

```bash
npm test
npx tsc --noEmit
npm run check:web
npm run build
git diff --check
```

Expected:

- all test files pass;
- TypeScript reports no errors;
- Svelte checks report no errors;
- production build exits zero;
- diff check emits no output.

If unrelated WIP moves during verification, record the exact changed files, rerun the affected focused tests after the tree settles, and do not hide the race by weakening tests.

**Step 5: Request code review before completion**

Use the `requesting-code-review` skill against the approved spec and this plan. Resolve findings with `receiving-code-review`, then rerun the exact impacted tests and the full verification above. Do not claim completion from a review alone.

---

### Task 15: Stage the live rollout only after separate authorization

**Files:**

- No source changes expected unless runtime evidence exposes a defect.
- Runtime files are deployment-specific and must be resolved read-only before any mutation.

**Step 1: Capture a read-only preflight**

Verify and record:

- exact deployed checkout/ref and diff;
- `telecodex.service` and `codex-session-guardian.service` unit paths, environment files, PIDs, and recent logs;
- current `.telecodex/jobs.json` path/count/checksum and available disk space;
- current Guardian socket/inspection API and scan health;
- current app-server connectivity and diagnostics capability;
- backup target with sufficient space and restrictive permissions.

Do not restart or interrupt TeleCodex, Guardian, or app-server during preflight.

**Step 2: Obtain explicit rollout authorization**

Present the preflight, test evidence, exact migration/cutover commands, rollback triggers, and service impact. Wait for the user's approval before backing up, changing config, or restarting anything.

**Step 3: Run shadow mode**

After approval:

- back up the exact legacy JSON and new SQLite files recoverably;
- enable JSON-authoritative shadow writes;
- restart only TeleCodex;
- verify counts, ids, phase mapping, duplicate acceptance, WAL health, `/healthz`, `/readyz`, status UI, and log noise;
- leave Guardian and app-server running.

Rollback trigger: any missing/mismatched job, schema error, sustained write error, readiness failure, or unexpected Telegram/Codex side effect.

**Step 4: Cut over to SQLite authority**

After a clean shadow window and a second explicit confirmation:

- stop new TeleCodex polling cleanly;
- run final import/checksum comparison;
- enable SQLite authority with compatibility export;
- restart only TeleCodex;
- verify the queue and unfinished jobs before accepting new work.

**Step 5: Run controlled live canaries**

Use a private test topic and verify, in order:

1. four queued prompts plus one active prompt;
2. TeleCodex restart with queued and running jobs;
3. a multi-part response with restart during delivery;
4. a long tool/subagent turn whose activity remains visible;
5. a Guardian-observed stall/recovery using Guardian's own safe test mechanism;
6. Guardian inspection covering TeleCodex, ChatGPT Remote, and CLI root sessions;
7. duplicate Telegram update handling without a second turn;
8. Dashboard and Telegram showing the same state within five seconds.

Never manufacture a stall by killing an active Codex turn or restarting Guardian/app-server.

**Step 6: Verify rollback readiness and report**

Confirm the compatibility export can be read by the previous TeleCodex version and the backup remains intact. Report separately:

- code/test status;
- migration/shadow status;
- live runtime status;
- canary evidence;
- remaining ambiguous or undelivered jobs;
- whether rollback was exercised or only verified.

Do not label the rollout complete until zero committed updates are missing, no automatic duplicate turns occurred, every canary status changed within five seconds, and Guardian observations appeared by the next scan.

---
