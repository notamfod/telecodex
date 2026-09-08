# TeleCodex Existing Topic Warning Replay Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the two never-attempted response followers while explicitly accepting that the small failed status anchor may be duplicated.

**Architecture:** Schema v9 persists the exact anchor attempt baseline, recovery version baseline, delivery topology hash, and resume mode at reservation. A distinct warning action and independent default-off flag expose only warning replay. The existing outbox remains the only message sender, but every resume-owned anchor or follower network attempt passes a resume-aware authorization fence immediately before its sending CAS. Deterministic rich fallback replans atomically advance the stored topology hash. Action flags gate new reservations, never protection or reconciliation of an existing saga. Installation, enablement, and the one replay are separate gates.

**Tech Stack:** TypeScript 5.9, Node.js 20+, better-sqlite3, grammY 1.45, Vitest 3, systemd, curl.

---

## Non-negotiable boundaries

- This plan replaces, and never executes, Task 5 and Task 6 from `2026-09-08-telecodex-existing-topic-resume-activation.md`.
- Never print job, user, chat, topic, message, thread, action-token, source, payload, title, or attachment identity. Report only aggregate counts, booleans, reason codes, schema versions, health, and hashes of private release manifests.
- Never call Telegram while Tasks 1 and 2 run. Keep both topic-resume flags false.
- Do not enable or expose the executable warning action before the final Task 3 confirmation. That confirmation authorizes one tightly coupled enable-and-invoke window; implementation and readiness checks alone do not.
- Invoke once and create at most one durable replay reservation. Automated mutation retries are allowed only after a typed, definitive non-acceptance: Telegram `429` with its bounded `retry_after`, or delivery `not_sent`. Never retry a reopen or delivery mutation after a timeout, cancellation, 5xx, ambiguous response, lost connection, or uncertain delivery. A liveness probe is nondestructive, but the runtime may run at most one unsolicited unknown-state probe per action token per process lifetime. After restart, the new process may run one. Further probes in the same process require a persisted confirmed-429 deadline; an ambiguous probe leaves `reopen_unknown` without a scheduler loop. A probe never authorizes repeating an ambiguous reopen or send.
- Never restore the database after any external probe, reopen, or delivery may have been accepted. Before any reservation, rollback from v9 requires the explicit stopped-service schema gate in Task 1; code-only rollback to a v8 binary is invalid.
- Preserve `TELEGRAM_TOPIC_RECOVERY_ENABLED=true`. Keep `TELEGRAM_TOPIC_RESUME_ENABLED=false` throughout this plan.
- Use the shared code, private candidate, installation, rollback, and twenty-snapshot gates from `2026-09-08-telecodex-existing-topic-resume.md` unless this plan strengthens them.

## Live acceptance predicate

The read-only planner must derive identity internally and print only:

```json
{"warningEligible":1,"standardEligible":0,"failedRecoveries":1,"failedAnchors":1,"pendingFollowers":2,"sending":0,"uncertain":0,"activeTurns":0,"resumeAttempts":0,"quarantine":0}
```

Warning eligibility requires all existing exact source, thread, forum, binding, anchor-plan, canonical payload, rich fallback, response-plan ordering, destination, quarantine, and follower checks plus:

- the recovery is terminal `failed/TOPIC_RECOVERY_FAILED`, has no replacement topic, names the current destination, and has `currentJobVersion <= job.version`;
- the anchor is a canonical `send_text`, is `failed`, has no Telegram message ID or retry deadline, has `lastErrorCode=telegram_permanent`, and has a positive attempt count greater than the standard baseline;
- both followers are still `pending`, have zero attempts and no message IDs, retry deadlines, or errors;
- no resume row exists and the job has no active turn.

The recovery version relaxation is valid only because reservation and every later effect-authorizing transition re-read the exact current job, recovery, anchor, followers, source, plan, binding, destination, and quarantine. It does not reconstruct historical certainty; the distinct warning action represents the operator's duplicate-risk acceptance.

Before Task 2 exists, use the same raw checks but report `warningPrerequisites=1` instead of `warningEligible=1`; schema-only code must not broaden action eligibility.

### Task 1: Microrelease 06.3b-v9, durable replay baseline only

**Files:**
- Modify: `src/telegram-job-ledger-schema.ts`
- Modify: `src/telegram-topic-resume.ts`
- Modify: `src/telegram-topic-resume-ledger.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `test/telegram-job-store-sqlite.test.ts`
- Modify: `test/telegram-job-reconciliation-scan.test.ts`
- Modify: `test/telegram-job-retention.test.ts`
- Modify: `test/telegram-topic-resume.test.ts`
- Modify: `test/telegram-topic-resume-ledger.test.ts`

- [ ] **Step 1: Write failing schema-v9 migration tests**

Define the exact v9 table with four new reservation fields:

```sql
CREATE TABLE topic_resume_attempts (
  job_id TEXT PRIMARY KEY, action_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, resume_mode TEXT NOT NULL,
  anchor_attempt_baseline INTEGER NOT NULL,
  recovery_job_version_baseline INTEGER NOT NULL,
  delivery_topology_hash TEXT NOT NULL,
  chat_id INTEGER NOT NULL, message_thread_id INTEGER NOT NULL,
  reserved_job_version INTEGER NOT NULL, current_job_version INTEGER NOT NULL,
  next_attempt_at_ms INTEGER, reason_code TEXT,
  started_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
)
```

Require `user_version=9`, exact table SQL, the existing primary/unique/foreign-key guarantees, and unchanged indexes. The v8-to-v9 migration must run in one immediate transaction and fail closed unless `topic_resume_attempts` is empty; reservation baselines for old rows cannot be reconstructed safely. Recreate only that empty table, then set `user_version=9`. Fresh and v1-v7 databases create the v9 table directly.

- [ ] **Step 2: Write failing record and reservation-baseline tests**

Add:

```ts
export type TelegramTopicResumeMode = "standard" | "warning_replay";

interface TelegramTopicResumeRecord {
  readonly mode: TelegramTopicResumeMode;
  readonly anchorAttemptBaseline: number;
  readonly recoveryJobVersionBaseline: number;
  readonly deliveryTopologyHash: string;
}
```

Reject unknown modes, non-positive baselines, and topology hashes other than 64-character lowercase hex. Decode `standard` only when its anchor baseline is one and its recovery baseline equals the reserved job version. Decode `warning_replay` only when its anchor baseline is at least two and its recovery baseline is no greater than the reserved job version. Any future recovery baseline or mode/baseline contradiction is malformed, not a later transition conflict. Task 1 continues to create only `standard` records: reservation persists the literal standard mode, exact current anchor count of one, exact terminal recovery `currentJobVersion`, and a canonical topology hash in the same immediate transaction that inserts the row and advances the job. Candidate mode, warning candidates, and anchor baselines above one remain unavailable until Task 2.

The topology hash covers the ordered current response plan plus every delivery part's key, ordinal, kind, canonical payload, and content hash, including the status anchor. Delivery state, attempt count, deadlines, errors, and Telegram message IDs are excluded so ordinary state transitions do not change it. Only the deterministic rich fallback transaction in Task 2 may replace this hash.

- [ ] **Step 3: Replace hard-coded settlement causality with the persisted baseline**

Keep initial standard eligibility unchanged: before reservation, recovery `currentJobVersion` must equal the current job version. Add a distinct continuation validator rather than creating a synthetic job or weakening initial eligibility. For an existing standard resume it requires the actual job version to equal the resume row's current version, recovery `currentJobVersion` to equal the persisted recovery baseline and the reserved job version, and all other current evidence to remain exact. Warning continuation in Task 2 uses its persisted recovery baseline, which may predate the reserved job version.

At standard reservation, re-read the current anchor and recovery and require exact equality with their baselines. At every `reopen_in_flight` or `delivery_handoff` transition, run the continuation validator against the actual current job and require exact mode, both baselines, topology hash, destination, thread, recovery state/reason/no-new-topic, source, plans, followers, and binding equality.

At handoff, call the existing failed-delivery outbox only if the anchor is still `failed`, has the stored attempt count and error, and the job version equals the resume row. At settlement, a failed or uncertain anchor is causally later only when its attempt count equals the stored baseline plus one, its update is not earlier than handoff, and the job version advanced after handoff. A sending row or unchanged baseline leaves `delivery_handoff` unchanged. A later anchor uncertainty settles once as `TOPIC_RESUME_DELIVERY_UNCERTAIN` and can never trigger another send on reconciliation.

Add `TOPIC_RESUME_FOLLOWER_FAILED` and `TOPIC_RESUME_FOLLOWER_UNCERTAIN`. Because both followers are proven pending with zero attempts at reservation, a follower failed or uncertain after handoff is causal only when its update is not earlier than handoff and the job version advanced. Settle that outcome once as failed; never leave a terminal follower failure parked forever in `delivery_handoff`. Confirmed 429/`not_sent` pending rows remain in handoff for their safe scheduled retry.

- [ ] **Step 4: Prove schema and standard-ledger race behavior**

Test stale standard baseline, changed recovery, anchor, follower, raw JSON, payload hash, destination, binding, quarantine, current version, mode, token, and state. Reject a recovery baseline above the reserved job version and any standard recovery baseline not exactly equal to it. Require byte-for-byte logical equality after every rejected mutation. Test two stores reserving concurrently and require one winner. Prove the decoder and settlement logic against unchanged, exactly-plus-one, and greater-than-plus-one anchor counts plus later failed/uncertain followers. Runtime crash/reconciliation coverage for warning mode belongs to Task 2.

- [ ] **Step 5: Run focused RED/GREEN and shared verification**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-job-store-sqlite.test.ts \
  test/telegram-job-reconciliation-scan.test.ts \
  test/telegram-job-retention.test.ts \
  test/telegram-topic-resume.test.ts \
  test/telegram-topic-resume-ledger.test.ts
```

Then run the shared full test, typecheck, web check, build, diff check, and two independent review gates.

- [ ] **Step 6: Rehearse migration and rollback on private copies**

Create a private online backup with mode `0600`. Require schema v8, quick check OK, zero foreign-key violations, and zero resume rows without printing identities. Migrate a copy to v9 and verify exact schema and unchanged aggregate business rows. With the copied service stopped and the resume table still empty, recreate the v8 table and set `user_version=8` in one immediate transaction; require quick check OK, zero foreign-key violations, and successful read-only validation by the accepted 06.3a build.

- [ ] **Step 7: Commit, install, and observe with both flags off**

```bash
git commit -m "NO-TICKET feat: persist topic anchor replay baseline"
```

Install as `06.3b-v9-replay-baseline`. Require schema v9, zero resume rows, `warningPrerequisites=1` with all other acceptance aggregates unchanged, recovery flag on, both resume flags off, and no Telegram call attributable to this release. Complete twenty clean 30-second snapshots.

Before the first reservation, a failed v9 release may be rolled back only by this live gate: stop the service; prove zero resume rows and no external request attributable to resume; require quick check OK and zero foreign-key violations; recreate the exact empty v8 resume table and set `user_version=8` in one immediate transaction; validate with the accepted 06.3a binary; then restore the accepted 06.3a code and start once. After any resume row exists, schema rollback and database restore are forbidden and v9 is the database floor.

### Task 2: Microrelease 06.3c, warning action wiring while disabled

**Files:**
- Modify: `src/telegram-topic-resume.ts`
- Modify: `src/telegram-topic-resume-ledger.ts`
- Modify: `src/telegram-topic-resume-runtime.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Create: `src/telegram-topic-resume-delivery-guard.ts`
- Modify: `src/telegram-delivery-outbox.ts`
- Modify: `src/telegram-delivery-ledger.ts`
- Modify: `src/telegram-delivery-replan.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `src/telegram-status-projection.ts`
- Modify: `src/telegram-grammy-transport.ts`
- Modify: `src/status-board-render.ts`
- Modify: `src/bot.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `.env.example`
- Create: `test/telegram-topic-warning-replay-integration.test.ts`
- Modify: `test/telegram-topic-resume.test.ts`
- Modify: `test/telegram-topic-resume-ledger.test.ts`
- Modify: `test/telegram-topic-resume-runtime.test.ts`
- Create: `test/telegram-topic-resume-delivery-guard.test.ts`
- Modify: `test/telegram-delivery-outbox.test.ts`
- Modify: `test/telegram-delivery-replan.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`
- Modify: `test/telegram-status-projection.test.ts`
- Modify: `test/telegram-grammy-transport.test.ts`
- Modify: `test/status-board-render.test.ts`
- Modify: `test/bot-message-reliability.test.ts`
- Modify: `test/mini-app-server.test.ts`
- Modify: `test/dashboard-controller.test.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing warning eligibility tests**

Return an exact candidate mode: `standard` only for the original one-attempt contract, and `warning_replay` only for the live acceptance predicate. Permit the terminal failed recovery version to trail the current job only for warning mode. Preserve standard behavior and reject warning candidates for any other anchor error, state, deadline, message ID, attempt count, follower state, recovery outcome, destination, source, plan, binding, active turn, existing row, or quarantine. Reservation must persist the exact warning baseline above one and revalidate all evidence atomically.

- [ ] **Step 2: Add an independent strict default-off flag**

Parse `TELEGRAM_TOPIC_WARNING_REPLAY_ENABLED` strictly, default false. In canonical mode with a configured forum, always construct the dormant resume reconciler and delivery guard so persisted rows remain protected even when both action flags are false. Pass an immutable allowed-mode set derived from the flags; it controls only projection and new reservation. With only the warning flag true, standard candidates must not project or execute; with only the standard flag true, warning candidates must not project or execute. Reject a mismatched action kind during the final projection reload and again before reservation. With both flags false and zero rows, startup performs no Telegram call.

- [ ] **Step 3: Add a distinct warning action**

Add `resume_existing_topic_warning` to the canonical action union. Map it to one unused callback code and explicit labels such as `Resume; status may duplicate` and `Resume topic (may resend status)`. The callback answer must state that warning replay started. Keep callback data within 64 bytes.

The authenticated HTTP endpoint accepts only:

```http
POST /api/dashboard/jobs/<job>/actions/resume_existing_topic_warning
Content-Type: application/json

{"expectedVersion":541}
```

Reject unknown and extra fields. Reload the exact projection, require exact action equality, exact warning mode, and exact version immediately before reservation. The existing `resume_existing_topic` action must remain unchanged and unavailable when its flag is false.

- [ ] **Step 4: Fence every resume-owned delivery attempt**

Add `TOPIC_RESUME_EVIDENCE_STALE`. The outbox calls a synchronous resume-aware authorization hook immediately before every resume-owned transition to `sending`, including failed, pending, and uncertain sources; the initial anchor handoff; each follower after anchor success; every scheduled 429/`not_sent` retry; direct `retryFailed`; and direct `sendAgainWithWarning`. Unrelated jobs retain the existing path.

For an active `delivery_handoff`, the guard reads the current external binding and atomically revalidates the actual job, resume token/state/mode/versions/baselines, terminal failed recovery and its persisted version, source, destination, anchor plan, raw canonical payloads, topology hash, quarantine, and ordered delivery prefix. It permits only these shapes:

- anchor fresh replay: failed at the stored baseline with `telegram_permanent`, no message ID, and no deadline; every follower remains pristine pending at zero;
- anchor safe retry: pending at the stored baseline, no message ID, exact `telegram_retry_after` or `telegram_not_sent`, and a non-null deadline that is due;
- follower fresh send: the anchor has the exact delivered tuple at baseline plus one, every earlier current response-plan row has the exact fresh delivered tuple at attempt one, the selected row is pristine pending at zero with no message ID/deadline/error, and every later row is equally pristine;
- follower safe retry: the same ordered prefix and suffix hold, while the selected row remains at zero with no message ID and has exact `telegram_retry_after` or `telegram_not_sent` plus a non-null due deadline.

The authorization result carries the action token, exact job/resume version, part evidence, and external snapshot into the existing sending CAS. Any database drift makes that CAS fail before Telegram. Wrong, missing, or future retry deadlines; wrong errors; unexpected attempts or message IDs; or non-pristine suffix rows are stale evidence. Any external or durable evidence drift atomically settles the resume as failed/evidence-stale without changing the delivery rows, and the outbox performs no Telegram call. This is a just-before-attempt fence, not a claim that external state cannot change after the check.

An exact delivered tuple requires `state=delivered`, a positive Telegram message ID, null deadline and error, canonical payload/hash, and exact job projection equality. The anchor attempt count must equal baseline plus one; every original or fallback follower attempt count must equal one. Any contradictory delivered predecessor is malformed and must be quarantined before a later Telegram call.

Keep `resume.currentJobVersion` equal to the actual job version throughout handoff. In the same immediate transaction as every resume-owned delivery transition, CAS the resume token/state/current version and advance it to the job version produced by that transition. Do this for sending, delivered, pending-after-429/`not_sent`, failed, uncertain, deterministic replan, and terminal job finalization. The Telegram outcome must always be durably recorded; the paired resume-version update prevents later work from using a stale fence. Settlement requires equality, not a loose version catch-up rule.

Prevent terminal or malformed resume ownership from becoming a generic outbox loop. Due, sending-recovery, and next-wakeup queries must exclude every job that has a resume row outside `delivery_handoff`. A malformed handoff row or malformed source/recovery/plan/delivery/binding evidence is denied before Telegram and durably quarantined with a bounded reason and fingerprint when it cannot be safely settled. Repeated pumps and restarts must neither call Telegram nor reschedule that job, while unrelated due jobs continue normally.

- [ ] **Step 5: Preserve deterministic rich fallback lineage**

When a resume-owned `send_rich` follower receives a definitive rich-format or method rejection, or the outbox has already proven that the rich method is unavailable, permit the existing deterministic fallback replan only for the currently authorized next follower. Both the post-API and pre-known-unavailable paths must pass the current external binding and quarantine snapshot into the replan transaction; there is no pre-sending shortcut. In that immediate transaction, revalidate ownership and ordered delivery evidence, verify the old stored topology hash and resume/job version, apply the canonical replan, then CAS both the exact new topology hash and new current job version. Run the guard again before every subsequent fallback send. No Telegram call occurs during this local rewrite.

After replan, the guard accepts only the current canonical response plan whose ordered keys, ordinals, kinds, payloads, content hashes, destination, and topology hash match the stored value. It then applies the same delivered-prefix, next-pending, pending-suffix rule to all fallback descendants and untouched later followers. A replan conflict, malformed fallback, or hash mismatch settles or quarantines before another send.

Completion is dynamic: require one exact-delivered anchor plus an exact-delivered tuple for every row in the current canonical response plan, with projection equality. Do not require exactly three rows after a valid replan. Extra deadline/error, wrong attempt count, missing message ID, or payload/projection mismatch is malformed and quarantined rather than completed. A failed or uncertain fallback descendant uses the bounded follower terminal reason and never leaves the saga active.

- [ ] **Step 6: Preserve fail-closed action suppression**

Malformed resume, source, recovery, plan, delivery, or binding evidence must keep Dashboard available while hiding both resume actions. Treat an undecodable resume row as potentially active. Once any resume row exists, decoded active or terminal, suppress `retry_delivery` and `send_again_warning` for every resume-owned anchor, original follower, and fallback descendant; direct forged Dashboard actions must fail on reload, and direct outbox calls must be denied by the same guard. When the resume row is positively absent, malformed source, recovery, plan, delivery, or binding evidence hides resume actions but preserves the existing anchor-retry semantics. Preserve follower inspection and unrelated actions.

- [ ] **Step 7: Prove one warning replay path without real Telegram**

Using fakes, prove the exact sequence: warning action reload, atomic reservation with baseline, liveness probe, optional reopen only when definitively closed, delivery handoff, one anchor replay sequence, then follower pump only after anchor success. A definitive 429 may repeat probe, reopen, anchor, or follower work only after its exact bounded deadline; typed delivery `not_sent` may retry without incrementing the attempt count. Every other ambiguous result forbids repetition.

Require this restart matrix:

- inherited `reopen_in_flight` becomes `reopen_unknown` before any Telegram call;
- an inherited `probe_in_flight` or `reopen_unknown` may perform one unsolicited nondestructive liveness probe per action token per process lifetime; repeated reconcile calls do nothing, a new process gets one probe, and further same-process probes require a persisted confirmed-429 deadline; an ambiguous probe creates no scheduler loop, and `reopen_unknown` never reopens even if the new probe says closed;
- `reopen_retry_wait` may repeat reopen only after the persisted 429 deadline;
- inherited delivery `sending` first becomes `uncertain` and is never resent;
- `delivery_handoff` calls the outbox only while anchor count equals the stored baseline and resume/job versions match exactly;
- later failed or uncertain anchor settlement requires count exactly baseline plus one;
- a known delivered anchor releases followers, whose existing 429, `not_sent`, and uncertain no-repeat rules remain unchanged;
- a later failed or uncertain follower settles the resume once with its bounded follower reason instead of leaving handoff active.

Test drift immediately before the initial anchor, between anchor success and the first follower, between followers, and at every scheduled retry boundary. Each drift case must settle evidence-stale with zero additional Telegram calls and no subsequent due/wakeup loop. Test malformed handoff, source, recovery, plan, delivery, and binding evidence across repeated pumps and restart; include delivered rows corrupted with an extra deadline/error or wrong attempt count. The affected job is durably blocked while an unrelated due job progresses. For terminal failed and malformed resume ownership, test forged retry/send-again DTOs plus direct `retryFailed` and `sendAgainWithWarning`; all must make zero writes and zero Telegram calls. Also test definitive failure, timeout/unknown, cancellation, restart at every state, duplicate clicks, and concurrent stores. Assert no retry after uncertain external outcomes, no second warning reservation, and no follower attempt before an exact-delivered anchor.

Add full in-process persistence tests using a real temporary SQLite store, real status projection/action routing, real resume ledger, real delivery replan/outbox, and fake Telegram APIs. With warning-only mode, require one warning action, reject the standard and mode/version-mismatched DTOs without writes or calls, execute the warning DTO, persist both baselines and the topology hash, survive runtime reconstruction, and reach the exact dynamic completion aggregate. Add a rich rejection followed by multi-part fallback success and a partial fallback uncertainty; verify the stored topology CAS, pre-attempt fences, dynamic completion, and terminal follower containment. These tests must not mock the store boundary.

- [ ] **Step 8: Run focused RED/GREEN and shared verification**

Run all topic-resume, status projection, transport, bot callback, status board, Mini App, config, and reliability-runtime tests, then the shared full verification and two independent review gates.

- [ ] **Step 9: Commit, install, and observe with the warning flag off**

```bash
git commit -m "NO-TICKET feat: expose warning topic resume action"
```

Install as `06.3c-warning-replay-disabled`. Require schema v9, zero resume rows, the live acceptance predicate, recovery flag on, both resume flags off, and zero warning actions in authenticated Dashboard output. Complete twenty clean snapshots with no Telegram action.

### Task 3: Microrelease 06.4, enable and invoke once after duplicate-risk confirmation

- [ ] **Step 1: Stop for the final explicit confirmation**

State: `The small status anchor may duplicate; the two response followers have never been attempted.` Ask the operator to authorize one tightly coupled workflow: enable `TELEGRAM_TOPIC_WARNING_REPLAY_ENABLED=true`, expose exactly one warning action, and invoke it once. The earlier plan choice, implementation authorization, or a generic `continue` is insufficient. Before this confirmation the executable action remains absent from Telegram and HTTP routing.

- [ ] **Step 2: Final pre-enable read-only gate and rollback capture**

Require the exact acceptance JSON, schema v9, quick check OK, zero foreign-key violations, stable service, zero resume rows, no sending/uncertain delivery, no active turn, no quarantine, and no new suspicious logs. Save a private online backup with mode `0600`; do not print its path or identity. Save and verify the exact prior state of the focused warning-replay systemd drop-in without printing environment values.

- [ ] **Step 3: Open a bounded execution window**

Inspect the complete systemd unit and all drop-ins without printing secrets. Enable only `TELEGRAM_TOPIC_WARNING_REPLAY_ENABLED=true`, keep standard resume false, daemon-reload, and restart once. Immediately require health/readiness, schema v9, recovery on, standard resume off, warning replay on, zero resume rows, exactly one `resume_existing_topic_warning`, and no Telegram call from startup reconciliation. Do not run a twenty-snapshot wait with an executable action exposed.

If this enablement gate fails while there are still zero resume rows and no resume-attributable Telegram calls, restore the exact saved drop-in state, daemon-reload, restart once, and reverify health/readiness plus both resume flags off. If a row or possible external call exists, do not roll back automatically; stop and inspect durable evidence.

- [ ] **Step 4: Invoke exactly once**

Before resolving the action, create a private one-shot marker with exclusive-create semantics and mode `0600`, then `fsync` the file and its parent directory before dispatch. The helper must refuse if the marker already exists and must never delete it. Resolve the action URL and expected version only in memory, repeat the final aggregate predicate, then POST the authenticated canonical warning action once with a bounded client timeout and no automatic retry. Print only aggregate attempt count and HTTP/ok state. If the HTTP outcome is ambiguous, keep the marker, stop, and inspect durable state only. Never issue another POST, including after restart or operator handoff. Concurrent callback or HTTP requests are harmless only because reservation is a single immediate-transaction winner; tests must prove all losers perform no external call.

- [ ] **Step 5: Close new execution and follow durable state**

As soon as one resume row exists, require the warning action to disappear for both callback and HTTP paths. Restore the warning flag to false at the first persisted state with no owned external operation in flight, then daemon-reload and restart once. Because Task 2 always constructs the dormant reconciler and guard, the existing saga remains protected and resumable while both action flags are off. If the action request is ambiguous and no row is yet visible, do not restart or repeat; the in-process per-job queue and eventual reservation CAS must still allow at most one winner.

Track only aggregate state and reason codes. A live topic skips reopen; a definitively closed topic has one reopen sequence, with another request allowed only after a confirmed 429 rejection; missing evidence fails closed. Nondestructive probes may repeat after restart, but an ambiguous reopen never repeats. After handoff, the outbox has one anchor replay sequence above the persisted baseline; requests rejected by confirmed 429 or typed `not_sent` may repeat without advancing the attempt count. Only a known delivered anchor releases the current canonical follower plan; either original follower may expand into its validated fallback descendants. Any anchor uncertainty settles failed and leaves followers pending. Any later original or fallback follower failure or uncertainty settles with its follower reason and is never retried automatically.

- [ ] **Step 6: Accept or contain**

Success requires one terminal completed resume, one known-delivered anchor, every row in the current canonical response plan known delivered, exact projection equality, zero pending/sending/uncertain/quarantine, service healthy, both resume flags off, and no repeated action. The delivered count is `1 + current responsePlan length`, not a fixed three after fallback expansion. Complete twenty clean snapshots using the shared zero-uncertainty predicate.

A definitive permanent failure or uncertainty is contained without replay. For containment, record a private aggregate snapshot immediately after the terminal failed resume and require twenty subsequent snapshots to have the same bounded reason, delivery-state counts, attempt-count aggregate, and aggregate hash, with zero sending, zero new attempts, zero quarantine, both resume flags off, stable PID/restart count, and healthy service. The shared `uncertain=0` requirement is intentionally replaced by exact stable uncertainty counts for this failure-only gate. A malformed-evidence quarantine is a contained but unaccepted rollout: require a stable quarantine count of one, keep delivery blocked, and stop for a separate read-only audit rather than applying the ordinary acceptance gate. Never delete the resume row or restore the pre-action database.
