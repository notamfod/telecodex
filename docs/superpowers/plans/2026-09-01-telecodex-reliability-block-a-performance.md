# TeleCodex Reliability Block A: Performance and Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Telegram ingress and final delivery responsive while TeleCodex measures and bounds every background workload.

**Architecture:** A safe in-memory performance monitor records bounded histograms and emits structured summaries. Reusable single-flight and batch-budget helpers constrain periodic work. A compact SQLite-backed read model runs in shadow mode before Status Board and Mini App cut over separately.

**Tech Stack:** TypeScript, Node.js `perf_hooks`, SQLite, Vitest, existing Mini App and Status Board modules.

---

## Block constraints

- Depend on accepted Block 0 tooling for every rollout.
- Do not re-add the existing `(job_id, sequence)` indexes or the current Status Board eight-job limit.
- Metrics contain labels, counts, and durations only. They never contain Telegram text, Codex output, tokens, attachment names, or filesystem paths.
- Do not add Prometheus, OpenTelemetry, or another service in this block.
- No task commits changes without separate user authorization.

### Task A1: Measure critical-path latency and event-loop lag

**Files:**
- Create: `src/telecodex-performance.ts`
- Create: `test/telecodex-performance.test.ts`
- Modify: `src/index.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/telegram-job-ingress.ts`
- Modify: `src/telegram-job-coordinator.ts`
- Modify: `src/telegram-delivery-outbox.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`

- [ ] **Step 1: Write failing metric-contract tests**

Use bounded metric names and histogram output:

```ts
export type TeleCodexLatencyMetric =
  | "ingress_accept_ms"
  | "queue_wait_ms"
  | "turn_start_ms"
  | "turn_run_ms"
  | "final_delivery_ms";

export interface TeleCodexPerformanceSnapshot {
  windowStartedAt: number;
  generatedAt: number;
  eventLoopLagMs: { p50: number; p95: number; p99: number; max: number };
  latency: Readonly<Record<TeleCodexLatencyMetric, {
    count: number; p50: number; p95: number; p99: number; max: number;
  }>>;
}
```

Test empty windows, bounded sample count, monotonic duration validation, window rotation, disabled monitor behavior, and serialization without dynamic user labels.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run test/telecodex-performance.test.ts test/telegram-reliability-runtime.test.ts`

Expected: FAIL because no monitor exists.

- [ ] **Step 3: Implement and wire exact boundaries**

Use `monitorEventLoopDelay()` for event-loop data. Record ingress around durable `acceptUpdate`, queue wait from `acceptedAt` to first dispatch attempt, turn start around the acknowledged app-server call, turn runtime from exact start to terminal result, and final delivery from delivery-plan install to all required parts delivered. Label Telegram `retry_after` separately and exclude it from TeleCodex latency.

Emit one JSON summary per minute through an injected logger. Stop and disable the histogram during lifecycle cleanup.

- [ ] **Step 4: Verify, deploy, and observe**

Run focused tests, full gate, and Block 0 release. Confirm the journal contains bounded `telecodex_performance` records and no content fields. Record baseline p95 values for 10 minutes.

Rollback: switch to the previous release. Metrics are in-memory, so no data rollback is required.

### Task A2: Time named slow operations

**Files:**
- Create: `src/telecodex-operation-timing.ts`
- Create: `test/telecodex-operation-timing.test.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `src/status-board.ts`
- Modify: `src/dashboard-controller.ts`
- Modify: `src/telegram-reconciliation-runtime.ts`
- Modify: `src/telegram-delivery-outbox.ts`
- Modify: `test/status-board-lifecycle.test.ts`
- Modify: `test/dashboard-controller.test.ts`

- [ ] **Step 1: Write failing timing tests**

```ts
export type TeleCodexOperationName =
  | "sqlite_read" | "sqlite_write" | "status_collect"
  | "dashboard_collect" | "reconciliation_page" | "delivery_pump";

export interface TimedOperationResult<T> {
  value: T;
  durationMs: number;
}
```

Test synchronous and async success, failure, threshold filtering, nested calls, monotonic-clock rejection, safe error classification, and no argument/result logging.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telecodex-operation-timing.test.ts test/status-board-lifecycle.test.ts test/dashboard-controller.test.ts`

Wrap only the named boundaries. Default warning thresholds: 50 ms for SQLite, 100 ms for delivery/reconciliation pages, and 250 ms for Status Board/Dashboard collection. Emit operation name, duration, outcome, and bounded count only.

- [ ] **Step 3: Deploy and observe**

Deploy through Block 0. Compare named timings to A1 latency for 10 minutes. Any high-volume log loop or sensitive value is a rollback condition.

### Task A3: Make periodic tasks single-flight

**Files:**
- Create: `src/telecodex-single-flight.ts`
- Create: `test/telecodex-single-flight.test.ts`
- Modify: `src/status-board.ts`
- Modify: `src/dashboard-controller.ts`
- Modify: `src/telegram-job-retention-runtime.ts`
- Modify: `src/session-guardian-service.ts`
- Modify: `test/status-board-lifecycle.test.ts`
- Modify: `test/dashboard-controller.test.ts`
- Modify: `test/telegram-job-retention-runtime.test.ts`
- Modify: `test/session-guardian-service.test.ts`

- [ ] **Step 1: Write failing coalescing tests**

Define `SingleFlightTask.run()` so one active call plus any number of overlapping triggers produces at most one coalesced follow-up. `dispose()` prevents a follow-up but waits for the current promise to settle.

```ts
export interface SingleFlightTask<T> {
  run(): Promise<T>;
  dispose(): Promise<void>;
  inspect(): { running: boolean; followUpQueued: boolean };
}
```

- [ ] **Step 2: Verify RED, implement, and integrate**

Run: `npm test -- --run test/telecodex-single-flight.test.ts test/status-board-lifecycle.test.ts test/dashboard-controller.test.ts test/telegram-job-retention-runtime.test.ts test/session-guardian-service.test.ts`

Replace local boolean/promise guards only where behavior matches the contract. Preserve Guardian's exact operation serialization and do not let a periodic scan jump ahead of an explicit repair.

- [ ] **Step 3: Deploy and observe**

Deploy TeleCodex only. Guardian source changes are not activated until separately authorized; verify its tests now and leave its running process unchanged. Observe TeleCodex for 30 minutes with zero overlapping collector evidence.

### Task A4: Bound background batches and yield

**Files:**
- Create: `src/telecodex-background-budget.ts`
- Create: `test/telecodex-background-budget.test.ts`
- Modify: `src/telegram-reconciliation-runtime.ts`
- Modify: `src/telegram-delivery-outbox.ts`
- Modify: `src/telegram-job-retention-runtime.ts`
- Modify: `test/telegram-reconciliation-runtime.test.ts`
- Modify: `test/telegram-delivery-outbox.test.ts`
- Modify: `test/telegram-job-retention-runtime.test.ts`

- [ ] **Step 1: Write failing budget tests**

```ts
export interface BackgroundBudget {
  shouldContinue(processed: number): boolean;
  yield(): Promise<void>;
  elapsedMs(): number;
}
```

Use defaults of 100 rows or 25 ms per slice. Test row limit, time limit, clock rollback, yielding via `setImmediate`, cancellation, cursor preservation, and eventual completion across slices.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telecodex-background-budget.test.ts test/telegram-reconciliation-runtime.test.ts test/telegram-delivery-outbox.test.ts test/telegram-job-retention-runtime.test.ts`

Replace full reconciliation accumulation with cursor-page processing. Limit each delivery due query and retention delete page, persist or retain cursors between slices, and yield before scheduling the next slice.

- [ ] **Step 3: Deploy under synthetic backlog**

Use test fixtures to create load without modifying live user jobs. Deploy, observe 30 minutes, and prove p95 ingress stays below 1 second while background cursors progress. Roll back on stalled cursors or SLO breach.

### Task A5: Build compact reliability projection in shadow mode

**Files:**
- Create: `src/telegram-reliability-read-model.ts`
- Create: `test/telegram-reliability-read-model.test.ts`
- Modify: `src/telegram-job-ledger-schema.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `test/telegram-job-store-sqlite.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing read-model tests**

Store only compact operational fields keyed by `job_id` and source job version. Rebuild from current `jobs.projection_json`, never by replaying every event.

```ts
export interface TelegramReliabilityReadRow {
  jobId: string;
  jobVersion: number;
  phase: string;
  health: string;
  attention: boolean;
  updatedAt: number;
  deliveryPending: number;
  deliveryFailed: number;
}
```

Test transactional update, rebuild, corrupt-row quarantine, bounded listing, version monotonicity, and semantic comparison with `loadDashboardReliability()`.

- [ ] **Step 2: Verify RED, implement shadow mode, and verify GREEN**

Run: `npm test -- --run test/telegram-reliability-read-model.test.ts test/telegram-job-store-sqlite.test.ts test/telegram-reliability-runtime.test.ts test/config.test.ts`

Add additive table/index migration and `TELEGRAM_RELIABILITY_READ_MODEL=off|shadow|primary`, default `off`. In `shadow`, serve the current result and compare the compact result asynchronously by job/version and safe fields. Emit counts and reason codes, not payloads.

- [ ] **Step 3: Deploy shadow mode**

Deploy first with `off`, verify compatibility, then activate `shadow` in a separate runtime configuration update through Block 0. Observe 30 minutes with zero unexplained mismatch before A6.

### Task A6: Cut Status Board over to compact projection

**Files:**
- Modify: `src/status-board-snapshot.ts`
- Modify: `src/status-board.ts`
- Modify: `src/bot.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `test/status-board.test.ts`
- Modify: `test/status-board-lifecycle.test.ts`
- Modify: `test/bot-message-reliability.test.ts`

- [ ] **Step 1: Write failing primary/fallback tests**

Assert identical board output for current and compact sources, a bounded compact query of eight jobs, fallback on read-model unavailability, no event-history scan, and one safe fallback warning per interval.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/status-board.test.ts test/status-board-lifecycle.test.ts test/bot-message-reliability.test.ts test/telegram-reliability-runtime.test.ts`

Switch only the Status Board collector when mode is `primary`; leave Dashboard on its existing session/status loader. Keep shadow comparison during fallback.

- [ ] **Step 3: Deploy and observe**

Activate primary mode for Status Board, verify output parity and p95 read below 250 ms for 30 minutes. Roll back configuration to `shadow` before switching code if parity or latency fails.

### Task A7: Cut Mini App overview over to compact projection

**Files:**
- Modify: `src/dashboard-controller.ts`
- Modify: `src/dashboard-api.ts`
- Modify: `src/mini-app-runtime.ts`
- Modify: `src/bot.ts`
- Modify: `test/dashboard-controller.test.ts`
- Modify: `test/dashboard-api.test.ts`
- Modify: `test/mini-app-runtime.test.ts`
- Modify: `test/mini-app-server.test.ts`

- [ ] **Step 1: Write failing overview tests**

Assert that active/attention counts and first-page state come from the compact model, detail actions still load the exact canonical job/version, paging remains bounded, and fallback does not authorize stale actions.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/dashboard-controller.test.ts test/dashboard-api.test.ts test/mini-app-runtime.test.ts test/mini-app-server.test.ts`

Use the compact source for overview classification only. Keep `loadReliabilityForAction()` on the canonical job store and verify the exact action DTO immediately before mutation.

- [ ] **Step 3: Deploy and close Block A**

Deploy, exercise active/recent/attention pages and one read-only detail, then observe 30 minutes. Block A closes only with p95 ingress below 1 second, p95 status reads below 250 ms, no overlapping collectors, no unexplained shadow mismatch, and fresh full verification.
