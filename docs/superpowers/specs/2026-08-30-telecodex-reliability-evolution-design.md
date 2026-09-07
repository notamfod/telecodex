# TeleCodex Reliability Evolution Design

## Status

The design was approved section by section on 2026-08-30. This document is the parent specification for planning. Implementation must not start until the user reviews this file and approves the master implementation plan.

No commit, push, merge, or deployment is implied by approval of this document. Those remain separate actions. Runtime updates are authorized only as part of an approved microrelease implementation.

## Goal

Develop TeleCodex through small, independently deployable reliability improvements. Each change must be tested, reviewed, installed into the running service, and observed before implementation of the next change begins.

The program covers four areas in this order:

1. safe frequent deployment;
2. performance and measurement;
3. durable Telegram delivery;
4. continuous recovery after failures.

The work extends the existing SQLite job ledger, delivery outbox, Telegram rate-limit gate, startup reconciler, Status Board, Mini App, and Codex Session Guardian. It does not replace working reliability mechanisms with a second stack.

## Success criteria

The target operating profile is a balanced reliability SLO:

- no lost accepted job in restart and fault-injection tests;
- no automatically duplicated job and no automatic repeat of an ambiguous Telegram send;
- Telegram ingress acknowledgement p95 below 1 second under the agreed synthetic load;
- status and overview read p95 below 250 milliseconds under the agreed synthetic load;
- no overlapping accumulation of periodic collectors;
- safe recovery work is reconsidered within 30 seconds while the service is healthy;
- Guardian keeps its separate configured stale-session threshold and remains authoritative for stalled-session classification;
- every microrelease has a proven rollback path and a recorded live verification result.

The latency SLO excludes upstream Telegram delivery time, Codex model execution time, and an explicit Telegram `retry_after` interval. Measurements must label those waits separately instead of hiding them inside TeleCodex latency.

## Non-goals

This program does not:

- promise exactly-once delivery when Telegram accepted a request but its response was lost;
- replay an ambiguous Codex `turn/start` or ambiguous Telegram send automatically;
- introduce Redis, RabbitMQ, or another external broker;
- restart the shared Codex app-server as a recovery shortcut;
- store prompt text, response text, tool output, credentials, or attachments in operational metrics;
- redesign unrelated Telegram UI or Jira features;
- batch an entire block into one deployment.

## Selected approach

Use a staged sequence of microreleases. A block is a thematic and dependency boundary, not a release boundary. Every numbered item below is intended to ship independently. If implementation planning finds that an item is still too large, it must be split before code is written.

The rejected alternatives are:

- one integrated reliability release, which raises regression and rollback risk;
- a parallel replacement runtime, which duplicates delivery and recovery ownership before the current path is fully measured.

SQLite remains the source of truth. New read models and schedulers are rebuildable helpers around it.

## Architecture

The critical path is:

```text
Telegram update
  -> durable ingress
  -> materialization
  -> dispatch intent
  -> Codex turn
  -> turn result
  -> delivery outbox
  -> Telegram write coordinator
  -> Telegram
```

Supporting paths are isolated from the critical path:

```text
job ledger -> compact projection -> Status Board / Mini App

job ledger + app-server + Guardian
  -> reconciliation decision
  -> durable intent
  -> idempotent recovery effect

release controller
  -> preflight
  -> drain
  -> atomic version switch
  -> readiness and smoke
  -> accept or rollback
```

### Ownership rules

- SQLite job and delivery state is authoritative.
- In-memory queues, cooldowns, metrics, and caches are disposable and reconstructable.
- Status Board and Mini App never participate in accepting or delivering work.
- Guardian observes and repairs Codex sessions. It does not rewrite Telegram jobs directly.
- Reconciler correlates Guardian and app-server facts with an exact job identity.
- Telegram write coordinator owns scheduling and rate pressure for Telegram mutations.
- Release controller owns planned drain, version switching, live verification, and rollback.

### Side-effect rule

Every critical external side effect has a durable intent before the call and a durable outcome after it. Recovery must match exact `jobId`, `threadId`, `turnId`, operation identity, and expected state version before applying an effect.

### Compatibility rule

Schema changes are additive or otherwise backward compatible with the previous runnable release. A version switch must never require an irreversible data rewrite. An old path is removed only after a shadow comparison and a separate successful cutover microrelease.

## Microrelease contract

Each microrelease follows this sequence:

1. Write a work packet with purpose, changed behavior, acceptance criteria, risk, live check, and rollback.
2. Change one observable aspect of behavior.
3. Preserve data and configuration compatibility.
4. Add focused unit, integration, and fault tests before implementation completion.
5. Run the relevant tests, full `npm test`, and `npm run build`.
6. Obtain an independent code review.
7. Run deployment preflight and drain.
8. Install the version atomically into the running TeleCodex service.
9. Check readiness, logs, target behavior, ledger, outbox, and Guardian as applicable.
10. Observe the result for the required interval.
11. Accept the release or roll it back before implementing the next item.

Planning for the next item may continue during observation. Its implementation may not start until the current item is accepted.

### Observation intervals

- Low-risk additive instrumentation or read-only UI: at least 10 minutes after smoke verification.
- Runtime scheduling or Telegram delivery behavior: at least 30 minutes after smoke verification.
- Deployment or recovery behavior: at least 60 minutes and one complete real target scenario.

An unresolved warning, unexplained latency regression, restart, duplicate, lost job, or new `uncertain` outcome extends the observation. It never counts as a successful window.

## Block 0: Safe deployment

Block 0 is required before frequent runtime updates. The current shutdown path disposes the runtime and session registry, so a planned restart must not occur blindly while a turn is active.

The first 0.1 deployment uses the current process only after a manual read-only check confirms that no active turn or critical delivery is in flight.

### 0.1 Read-only deployment preflight

Add one bounded inspection that reports active turns, queued and running jobs, pending or sending deliveries, Guardian availability, current release identity, and explicit reasons a restart is unsafe.

Acceptance: the check performs no mutation, times out predictably, and returns a machine-readable safe or unsafe result.

### 0.2 Drain mode

Add a local administrative drain control. Telegram updates continue to enter the durable inbox, but no new Codex turn starts while drain is active. Existing turns and delivery work continue.

Acceptance: work received during drain is preserved once, remains visible, and starts after drain ends.

### 0.3 Bounded drain wait

Wait for active turns and critical delivery work to reach a safe boundary. If the configured deadline expires, cancel the deployment and leave user work untouched.

Acceptance: timeout never aborts the turn as a side effect of deployment.

### 0.4 Versioned atomic release

Build into a versioned release location and switch the service entrypoint atomically. Do not expose a partially written `dist` tree to the running service.

Acceptance: the active release identity is inspectable and the previous release remains available for rollback.

### 0.5 Automatic rollback

After restart, verify process stability, readiness, SQLite access, app-server and Guardian connectivity, and a bounded Telegram smoke path. Restore the previous release when a mandatory check fails.

Acceptance: rollback does not reverse or corrupt compatible schema changes and reports why the candidate failed.

### 0.6 Post-deployment audit

Compare preflight and post-start job state. Report accepted jobs, safe queued work, active exact turns, delivery backlog, quarantined records, and unexpected orphans.

Acceptance: the audit can prove that every pre-deploy non-terminal job still has a valid post-deploy representation.

## Block A: Performance and measurement

The existing SQLite event indexes and bounded Status Board reliability list are the baseline. This block starts after those changes and does not repeat them.

### A1 Critical-path timing

Measure event-loop lag and timestamps for Telegram receipt, durable acceptance, queue wait, turn start, turn completion, and final delivery. Keep upstream waits as separate fields.

### A2 Slow-operation timing

Add bounded structured timing for SQLite operations, Status Board collection, Dashboard collection, reconciliation, and delivery pumping. Do not log message content or sensitive paths.

### A3 Single-flight periodic work

Make each periodic collector single-flight. A tick that arrives while the previous run is active coalesces into at most one follow-up run.

### A4 Time and batch budgets

Give each background cycle a bounded item count and elapsed-time budget. Yield between batches so Telegram polling and final delivery can run.

### A5 Shadow compact projection

Build a compact, rebuildable reliability projection and compare it with the current result without serving it to users. Record mismatches by safe reason and count.

### A6 Status Board cutover

Serve Status Board from the compact projection with a guarded fallback to the previous read path. Remove the fallback only in a later accepted release.

### A7 Mini App overview cutover

Serve the Mini App overview from the same compact projection. Keep detail views explicitly paginated and bounded.

Block A is complete when the selected latency SLO is met without overlapping collectors or unexplained projection mismatches.

## Block B: Durable Telegram delivery

Block B extends the existing ingress deduplication, SQLite delivery outbox, `retry_after` parsing, per-chat gate, status coalescing, and final-delivery cancellation behavior.

### Delivery guarantee

TeleCodex guarantees no silent loss and no silent automatic replay. It cannot guarantee exactly-once Telegram delivery after an ambiguous new send. Such a send becomes `uncertain` and requires inspection or explicit operator action.

### B1 Unified write contract in pass-through mode

Introduce one Telegram mutation contract carrying purpose, priority, chat and topic identity, timeout, cancellation signal, operation identity, and normalized outcome. Initial routing preserves current behavior.

### B2 Low-priority background routing

Route Status Board refreshes, typing indicators, and disposable presence updates through the coordinator as low-priority, replaceable work.

### B3 Normal-priority interaction routing

Route Inbox panels, callbacks, and ordinary control-message updates through the coordinator as normal-priority work.

### B4 High-priority job delivery routing

Route durable job status and final response delivery as high-priority work. Cancel obsolete status writes once a final delivery plan is ready.

### B5 Fair scheduling

Serialize mutations within a chat, enforce global pressure, prioritize final delivery, and prevent permanent starvation of normal work.

### B6 Durable rate cooldown

Persist an active Telegram `retry_after` when it affects durable work. Restore the cooldown after process restart without consuming an ordinary retry attempt.

### B7 Durable topic creation and binding

Record topic creation and binding intent before Telegram mutation. Store the confirmed topic identity afterward. An ambiguous create result must not be repeated without reconciliation.

### B8 Durable Inbox state mutations

Make ticket acknowledgement, work-topic handoff, and final ticket state durable. Each operation correlates the Inbox record, Telegram target, and resulting job.

### B9 Operator delivery view

Show delivery state, attempts, next attempt time, safe error reason, and legal actions for `failed` and `uncertain` work. Manual resend must warn when a duplicate is possible.

Block B is complete when final delivery remains responsive under background load and all tested 429, timeout, duplicate-update, and restart paths preserve the delivery contract.

## Block C: Continuous recovery

The existing startup reconciler already handles accepted, queued, delivering, terminal, and exact running-turn cases. Block C makes that mechanism continuous, bounded, observable, and policy-driven.

### C1 Unified recovery inspection

Expose one correlated view of job, thread, turn, delivery, reconciliation decision, Guardian observation, and safe reason code.

### C2 Shadow periodic reconciliation

Scan one bounded page per cycle and classify candidates without applying effects. Compare decisions with current status and startup behavior.

### C3 Recovery heartbeat

Expose last successful scan, cursor progress, candidate count, quarantined count, and safe error codes. Recovery degradation must not stop durable ingress.

### C4 Safe continuous effects

Enable continuous effects only for proved-safe states: accepted materialization, a job proved not sent, an ordinary queued job, and pending safe delivery.

### C5 Exact-turn reattachment

After app-server reconnection, recover an active or completed turn only when `jobId`, `threadId`, and `turnId` still match. Never substitute the latest turn.

### C6 Interrupted reconciliation resumption

Resume a persisted reconciliation decision after a crash between decision and effect completion. Effect application and completion marking must be idempotent under CAS conflicts.

### C7 Immediate Guardian correlation

Project a Guardian check or repair outcome into the related job view immediately. Guardian remains the authority for stalled-session classification and repair outcome.

### C8 Safe operator recovery actions

Provide recheck, terminate-as-interrupted, and create-new-retry-job actions when identity or acceptance is ambiguous. Preserve the original job history.

### C9 Whitelisted automatic repair

After shadow evidence is accepted, enable automatic repair only for explicit reason codes whose preconditions and idempotency are proven. Unknown, corrupt, or mismatched cases remain manual.

Block C is complete when planned and unplanned restart tests preserve work, safe cases recover automatically, and ambiguous cases remain visible without blind replay.

## Failure model

| Class | Examples | Required behavior |
| --- | --- | --- |
| Retryable | Telegram 429, temporary network failure, App Server unavailable | Persist next attempt, use bounded retry and jitter, respect `retry_after` |
| Ambiguous | New Telegram send timed out, `turn/start` crossed write boundary without acknowledgement | Mark `uncertain` or attention-required, inspect exact identity, never replay automatically |
| Permanent | Invalid payload, forbidden operation, exhausted safe attempt limit | Stop automatic work, record safe reason, expose legal operator action |
| Invariant or corruption | Contradictory ledger row, malformed identity, impossible state transition | Quarantine, preserve evidence, require manual inspection |
| Version conflict | Concurrent transition won the CAS race | Reload, reclassify, and retry only a bounded number of times |

Errors exposed to Telegram, Mini App, logs, or metrics use bounded reason codes and sanitized text. They exclude prompts, responses, tool output, secrets, tokens, attachment content, and private filesystem paths.

## Testing strategy

Every microrelease includes the smallest applicable set from this matrix and then runs the full suite and build:

- state-transition unit tests;
- scheduler priority, fairness, cancellation, and single-flight tests;
- SQLite transaction and compatibility tests;
- fault tests before and after each durable intent or outcome write;
- Telegram 429, timeout, not-modified, forbidden, and ambiguous-send tests;
- app-server disconnect, lost acknowledgement, exact-turn mismatch, and reconnect tests;
- process restart tests for each affected persisted phase;
- load tests for ingress latency, status-read latency, event-loop lag, and background backlog;
- release tests for drain timeout, atomic switch, readiness failure, rollback, and post-deploy audit.

Tests must assert both positive outcomes and forbidden effects, especially no second job, no blind prompt replay, no duplicate ambiguous send, and no mutation of the wrong turn.

## Live acceptance and rollback

Each release records:

- previous and candidate release identity;
- preflight and drain result;
- migration result;
- process PID, restart count, readiness, and dependency health;
- target smoke result;
- before and after latency evidence;
- job, delivery, reconciliation, and Guardian anomalies;
- observation start, end, and disposition.

Rollback is mandatory when any of these is confirmed:

- readiness fails or the service enters a restart loop;
- an accepted job disappears or loses a valid representation;
- a new duplicate job or delivery is created;
- an unexpected ambiguous state appears;
- the target path no longer works;
- latency breaches the selected SLO because of the candidate;
- a schema or compatibility check fails.

Rollback restores code and runtime configuration. It does not delete operational evidence or rewrite user data. Additive schema must remain readable by the previous release.

## Planning and execution order

After this specification is approved:

1. Write one master implementation plan covering all numbered microreleases, dependencies, verification commands, live checks, and rollback commands.
2. Review and approve the master plan before changing code.
3. Before each microrelease, expand its work packet into exact files, tests, steps, and runtime commands.
4. Implement only that microrelease using test-driven development.
5. Review, deploy, observe, and accept or roll back it.
6. Continue with the next dependency-ready item.

The default sequence is `0.1` through `0.6`, then `A1` through `A7`, `B1` through `B9`, and `C1` through `C9`. A later item may move earlier only when its dependencies are satisfied and the master plan explains why. No implementation from blocks A, B, or C may bypass the accepted safe-deployment controls available at that point.
