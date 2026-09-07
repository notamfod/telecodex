# TeleCodex Reliability Block C: Continuous Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and recover evidence-safe unfinished TeleCodex work continuously without blind prompt replay, wrong-turn mutation, or dependence on a process restart.

**Architecture:** A bounded continuous reconciler reuses the existing classifier and durable decision/effect protocol. It starts in shadow mode, publishes a heartbeat, then enables narrow safe effects. App-server reconnect and Guardian outcomes trigger exact rechecks, while ambiguous cases remain immutable and operator-controlled.

**Tech Stack:** TypeScript, existing SQLite reconciliation ledger, Codex app-server client, Guardian IPC, Vitest, existing Dashboard/status projection.

---

## Recovery rules

- Depend on accepted Blocks 0, A, and B.
- Startup reconciliation remains mandatory before polling. Continuous reconciliation supplements it.
- Never replace an expected turn with the latest turn from a thread.
- Never retry a `turn/start` whose write acceptance is ambiguous.
- Never automatically resend an uncertain new Telegram message or recreate an uncertain topic.
- Guardian remains authoritative for stalled classification and repair. TeleCodex records the outcome against the exact job.
- C9 code ships disabled. Enabling live automatic repair requires separate approval of the exact reason-code whitelist.
- No task commits changes without separate user authorization.

### Task C1: Build one correlated recovery inspection

**Files:**
- Create: `src/telegram-recovery-view.ts`
- Create: `test/telegram-recovery-view.test.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/dashboard-api.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`
- Modify: `test/dashboard-api.test.ts`
- Modify: `test/mini-app-server.test.ts`

- [ ] **Step 1: Write failing view-contract tests**

```ts
export interface TelegramRecoveryView {
  jobId: string;
  jobVersion: number;
  phase: string;
  threadId: string | null;
  turnId: string | null;
  decision: { id: string; kind: string; state: "pending" | "applied" } | null;
  guardian: { availability: string; health: string | null; repairState: string | null };
  delivery: { pending: number; uncertain: number; failed: number };
  reasonCode: string | null;
  legalActions: readonly string[];
}
```

Test exact identity correlation, missing Guardian, pending decision, delivery ambiguity, terminal job, stale version, malformed/quarantined job, and serialization without content or private paths.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telegram-recovery-view.test.ts test/telegram-reliability-runtime.test.ts test/dashboard-api.test.ts test/mini-app-server.test.ts`

Build the view from the canonical job projection, delivery rows, persisted reconciliation intent, and exact Guardian inspection. Add an authenticated job-detail route; do not add a second state classifier.

- [ ] **Step 3: Deploy read-only view**

Deploy through Block 0, inspect one healthy and one historical attention job without mutation, and observe 10 minutes.

### Task C2: Run bounded continuous reconciliation in shadow mode

**Files:**
- Create: `src/telegram-continuous-reconciler.ts`
- Create: `test/telegram-continuous-reconciler.test.ts`
- Modify: `src/telegram-job-reconciler.ts`
- Modify: `src/telegram-reconciliation-runtime.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `test/telegram-job-reconciler.test.ts`
- Modify: `test/telegram-reconciliation-runtime.test.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing shadow-loop tests**

Use `TELEGRAM_CONTINUOUS_RECONCILIATION=off|shadow|safe`, default `off`, and a validated 30-second interval. Test one bounded page per tick, persisted cursor, single-flight behavior, cancellation, unavailable app-server/Guardian, corrupt candidate quarantine, and no effect calls in `shadow`.

```ts
export interface TelegramReconciliationClassification {
  jobId: string;
  jobVersion: number;
  decisionKind: string;
  reasonCode: string;
}
```

- [ ] **Step 2: Verify RED, separate classify from apply, and verify GREEN**

Run: `npm test -- --run test/telegram-continuous-reconciler.test.ts test/telegram-job-reconciler.test.ts test/telegram-reconciliation-runtime.test.ts test/config.test.ts`

Reuse the existing `classify()` decision rules through an exported bounded classifier. Shadow mode may compare a decision with current projection but must not call `recordDecision`, `markApplied`, coordinator, outbox, or Guardian repair.

- [ ] **Step 3: Deploy shadow mode**

Deploy with `off`, verify compatibility, then switch to `shadow` through a separate Block 0 runtime update. Observe 30 minutes with bounded cursor progress and no mutation evidence.

### Task C3: Publish recovery heartbeat and degradation

**Files:**
- Create: `src/telegram-recovery-heartbeat.ts`
- Create: `test/telegram-recovery-heartbeat.test.ts`
- Modify: `src/telegram-continuous-reconciler.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `src/mini-app-runtime.ts`
- Modify: `src/dashboard-api.ts`
- Modify: `test/mini-app-server.test.ts`
- Modify: `test/mini-app-runtime.test.ts`
- Modify: `test/dashboard-api.test.ts`

- [ ] **Step 1: Write failing heartbeat tests**

```ts
export interface TelegramRecoveryHeartbeat {
  mode: "off" | "shadow" | "safe";
  running: boolean;
  lastStartedAt: number | null;
  lastSucceededAt: number | null;
  cursorPresent: boolean;
  candidates: number;
  quarantined: number;
  lastErrorCode: string | null;
}
```

Test success, failure, stale heartbeat, active scan, restart reset, safe error codes, and that recovery degradation does not make durable ingress health fail.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telegram-recovery-heartbeat.test.ts test/mini-app-server.test.ts test/mini-app-runtime.test.ts test/dashboard-api.test.ts`

Expose heartbeat in the authenticated system status and as a bounded readiness detail. Do not fail `/healthz`; `/readyz` may report recovery stale only when startup reconciliation is incomplete, not for an ordinary later scan error.

- [ ] **Step 3: Deploy and observe**

Deploy, prove heartbeat advances for 30 minutes, and simulate a dependency failure only in tests. Roll back if heartbeat collection delays ingress.

### Task C4: Enable only safe continuous effects

**Files:**
- Modify: `src/telegram-continuous-reconciler.ts`
- Modify: `src/telegram-job-reconciler.ts`
- Modify: `src/telegram-reconciliation-runtime.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `test/telegram-continuous-reconciler.test.ts`
- Modify: `test/telegram-job-reconciler.test.ts`
- Modify: `test/telegram-reconciliation-runtime.test.ts`
- Modify: `test/telegram-reliability-faults.test.ts`

- [ ] **Step 1: Write failing safe-policy tests**

Allow only `restore_accepted`, `enqueue`, `requeue_not_sent`, `resume_delivery`, and `refresh_terminal`. Deny `hold_dispatch_unknown`, missing identity, Guardian unavailable, and every attention-required decision. Test version change between classify/record/apply and repeated ticks.

- [ ] **Step 2: Verify RED, implement policy gate, and verify GREEN**

Run: `npm test -- --run test/telegram-continuous-reconciler.test.ts test/telegram-job-reconciler.test.ts test/telegram-reconciliation-runtime.test.ts test/telegram-reliability-faults.test.ts`

In `safe` mode, persist the existing deterministic decision before invoking the existing idempotent effect. Re-read job/version immediately before recording and applying.

- [ ] **Step 3: Controlled safe canary**

Deploy code with `shadow`, review classifications, then activate `safe`. Use a synthetic accepted/queued fixture in an isolated test database and one naturally pending safe live case if available. Do not alter a historical ambiguous job. Observe 60 minutes.

### Task C5: Trigger exact-turn recovery after app-server reconnect

**Files:**
- Modify: `src/app-server-client.ts`
- Modify: `src/app-server-turn-manager.ts`
- Modify: `src/telegram-session-codex-adapter.ts`
- Modify: `src/telegram-continuous-reconciler.ts`
- Modify: `test/app-server-client.test.ts`
- Modify: `test/app-server-turn-reconciliation.test.ts`
- Modify: `test/telegram-session-codex-adapter.test.ts`
- Modify: `test/telegram-continuous-reconciler.test.ts`

- [ ] **Step 1: Write failing reconnect tests**

Add a deduplicated `onReconnect` notification emitted only after initialize succeeds following a disconnect. Assert one bounded reconciliation trigger, exact `threadId + turnId` inspection, active reattachment, completed result recovery, mismatch attention, and no `turn/start` call.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/app-server-client.test.ts test/app-server-turn-reconciliation.test.ts test/telegram-session-codex-adapter.test.ts test/telegram-continuous-reconciler.test.ts`

Reconnect schedules a targeted job-page scan through the continuous reconciler. It never performs recovery inside the socket callback and never substitutes the thread's latest turn.

- [ ] **Step 3: Controlled reconnect canary**

Exercise reconnect with the fake app-server integration. For live verification, use a non-destructive connectivity flap mechanism only if one already exists and is approved; otherwise verify normal reconnect logs and do not restart the shared app-server. Observe 60 minutes.

### Task C6: Resume interrupted reconciliation intent idempotently

**Files:**
- Modify: `src/telegram-reconciliation-runtime.ts`
- Modify: `src/telegram-job-reconciliation-scan.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `test/telegram-reconciliation-runtime.test.ts`
- Modify: `test/telegram-job-reconciliation-scan.test.ts`
- Modify: `test/telegram-job-reconciliation-transition.test.ts`
- Modify: `test/telegram-reliability-faults.test.ts`

- [ ] **Step 1: Write failing crash-boundary tests**

For every safe effect, stop after `reconciliation.decided`, reopen SQLite, run continuous reconciliation, and assert one logical effect plus one `reconciliation.applied`. Cover effect already completed but mark missing, CAS conflict, changed job identity, corrupt decision, and exhausted CAS retries.

- [ ] **Step 2: Verify RED, implement resumable scan, and verify GREEN**

Run: `npm test -- --run test/telegram-reconciliation-runtime.test.ts test/telegram-job-reconciliation-scan.test.ts test/telegram-job-reconciliation-transition.test.ts test/telegram-reliability-faults.test.ts`

Prioritize persisted pending intents ahead of new classifications. Reuse the stored decision ID and exact identity. Mark applied only after the effect's postcondition is observable.

- [ ] **Step 3: Deploy and observe**

Deploy, verify no live pending intent is rewritten, and observe 60 minutes. Use test database process restarts for the crash canary.

### Task C7: Correlate Guardian outcomes immediately

**Files:**
- Modify: `src/guardian-bot-adapter.ts`
- Modify: `src/telegram-guardian-reconciliation.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/telegram-job-transition.ts`
- Modify: `test/guardian-bot-adapter.test.ts`
- Modify: `test/telegram-guardian-reconciliation.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`
- Modify: `test/telegram-job-transition.test.ts`

- [ ] **Step 1: Write failing Guardian correlation tests**

Test check outcomes `healthy|checking|stalled|unavailable` and repair outcomes `self-recovered|restored|failed`. Require exact alert, thread, and turn identity. Reject stale job version, mismatched turn, unknown alert, duplicate outcome, and outcome that contradicts terminal job state.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/guardian-bot-adapter.test.ts test/telegram-guardian-reconciliation.test.ts test/telegram-reliability-runtime.test.ts test/telegram-job-transition.test.ts`

After the existing Guardian IPC response, append one `guardian.observed` event through the reliability runtime. Do not let Guardian write the job database or let TeleCodex invent a repair result.

- [ ] **Step 3: Deploy read-only Guardian canary**

Invoke a Guardian check, not repair, for an eligible controlled thread and verify immediate projection. Do not restart Guardian or mutate a session. Observe 60 minutes.

### Task C8: Add safe operator recovery actions

**Files:**
- Modify: `src/telegram-status-projection.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `src/dashboard-api.ts`
- Modify: `web/src/model.ts`
- Modify: `web/src/App.svelte`
- Modify: `test/telegram-status-projection.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`
- Modify: `test/mini-app-server.test.ts`
- Modify: `test/mini-app-ui.test.ts`

- [ ] **Step 1: Invoke interface design and write failing action tests**

Use `interface-design` and `typeui-fundamentals`. Add exact actions `recheck`, `terminate_recovery_interrupted`, and `retry_new_turn`. Test allowed reason codes, expected version, exact identity, confirmation for terminalization/new retry, duplicate click, stale action, and preservation of the original job history.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run:

```bash
npm test -- --run test/telegram-status-projection.test.ts test/telegram-reliability-runtime.test.ts test/mini-app-server.test.ts test/mini-app-ui.test.ts
npm run check:web
```

`retry_new_turn` creates a new job with `retryOfJobId`; it never rewrites or requeues the original. Terminalization requires an exact still-ambiguous state.

- [ ] **Step 3: Deploy one controlled action**

Use `recheck` on a controlled attention job first. Run mutation actions only on a test job created for this purpose. Verify old/new IDs and observe 60 minutes.

### Task C9: Add disabled-by-default automatic repair whitelist

**Files:**
- Create: `src/telegram-auto-recovery-policy.ts`
- Create: `test/telegram-auto-recovery-policy.test.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `src/telegram-continuous-reconciler.ts`
- Modify: `src/telegram-guardian-reconciliation.ts`
- Modify: `test/config.test.ts`
- Modify: `test/telegram-continuous-reconciler.test.ts`
- Modify: `test/telegram-guardian-reconciliation.test.ts`

- [ ] **Step 1: Write failing policy tests**

```ts
export interface TelegramAutoRecoveryPolicy {
  enabled: boolean;
  allowedReasonCodes: ReadonlySet<string>;
}
```

Reject unknown codes at startup. Require exact identity, current Guardian eligibility, no active repair, no ambiguous dispatch/delivery, job version match, and one durable repair claim. Test disabled mode, allowed code, denied code, concurrent claim, changed evidence, Guardian unavailable, and restart.

- [ ] **Step 2: Verify RED, implement disabled mode, and verify GREEN**

Run: `npm test -- --run test/telegram-auto-recovery-policy.test.ts test/config.test.ts test/telegram-continuous-reconciler.test.ts test/telegram-guardian-reconciliation.test.ts`

Add `TELEGRAM_AUTO_RECOVERY_ENABLED=false` and an empty whitelist default. Ship code and UI visibility with automatic mutation disabled.

- [ ] **Step 3: Deploy disabled and review evidence**

Deploy through Block 0, prove zero repair calls for 60 minutes, and present shadow classifications plus the proposed exact whitelist to the user.

- [ ] **Step 4: Activate only after separate approval**

After explicit approval of the exact codes, change configuration through Block 0 and run one controlled eligible case. Unknown cases must remain manual. Observe 60 minutes, then run fresh full verification and final review.

Block C closes only after safe continuous recovery is proven, ambiguous cases remain visible without replay, and the final running release matches the accepted manifest.
