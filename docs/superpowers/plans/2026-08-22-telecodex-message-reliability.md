# TeleCodex Message Reliability Implementation Plan

> **For Codex:** REQUIRED SKILL: Use `subagent-driven-development` to execute this plan task-by-task in the current session, or `executing-plans` for inline execution. Apply `test-driven-development` for every behavior change and `verification-before-completion` before claiming completion.

**Goal:** Make every accepted Telegram work item durable before execution, expose one honest thread/job status model, prevent ambiguous automatic replay, coordinate recovery with the global Codex Session Guardian, and deliver replies through an idempotent outbox.

**Architecture:** Replace the coarse JSON job file with a SQLite WAL event ledger plus current projections. Route every work-producing Telegram update through a durable ingress and coordinator. Treat Codex dispatch, Codex activity, Guardian observations, and Telegram delivery as separate state dimensions, then render one projection in Telegram and the Dashboard. Keep recovery ownership split: Guardian classifies and restores global Codex sessions; TeleCodex reconciles its own jobs and deliveries.

**Tech Stack:** TypeScript 5.9, Node.js, Vitest 3, grammY, `better-sqlite3`, WebSocket JSON-RPC, Svelte 5, Vite, systemd.

---

## Execution constraints

- Work in `/root/Documents/Codex/2026-08-07-hermes/telecodex` on the existing `telecodex-improvements` branch.
- The checkout contains substantial unrelated WIP. Read every file before editing it, inspect `git diff` for the exact file, and preserve all existing changes.
- Do not create a worktree from this dirty checkout unless the user explicitly chooses isolation and the current WIP has a safe base.
- Do not commit, push, deploy, restart services, migrate the live runtime, or mutate Guardian state without separate explicit authorization.
- After each task, keep a diff checkpoint instead of the commit requested by the generic Superpowers template:

```bash
git status --short -- <task-files>
git diff --check -- <task-files>
git diff -- <task-files>
```

- Use deterministic clocks and injected adapters in tests. Do not rely on sleeps, live Telegram, or a live Codex app-server.
- Preserve compatibility with the current public bot API until the final routing task.
- Never automatically resend an ambiguous `turn/start`. An operator-triggered retry must create a new job linked by `retryOfJobId`.

## State contract used throughout the plan

```ts
export type JobPhase =
  | "accepted"
  | "queued"
  | "dispatching"
  | "running"
  | "delivering"
  | "terminal";

export type JobHealth =
  | "healthy"
  | "quiet"
  | "checking"
  | "stalled"
  | "unavailable";

export type JobOutcome =
  | "completed"
  | "failed"
  | "aborted"
  | "recovery_interrupted"
  | null;

export type DeliveryState =
  | "pending"
  | "sending"
  | "delivered"
  | "uncertain"
  | "failed";

export type JobActivity =
  | "model"
  | "tool"
  | "subagent"
  | "waiting"
  | "unknown";

export type JobAttention =
  | { kind: "none" }
  | {
      kind: "required";
      code: string;
      actions: readonly string[];
    };
```

Allowed phase transitions are exact and monotonic:

```text
accepted    -> accepted | queued | terminal
queued      -> queued | dispatching | terminal
dispatching -> dispatching | queued | running | terminal
running     -> running | delivering | terminal
delivering  -> delivering | terminal
terminal    -> terminal
```

The display label `Done` is legal only when `outcome === "completed"` and all planned delivery parts are `delivered`.

## File map

New focused modules:

- `src/telegram-job-types.ts`
- `src/telegram-job-transition.ts`
- `src/telegram-job-migration.ts`
- `src/telegram-job-ingress.ts`
- `src/telegram-job-coordinator.ts`
- `src/telegram-turn-result.ts`
- `src/telegram-response-plan.ts`
- `src/telegram-delivery-outbox.ts`
- `src/telegram-job-reconciler.ts`
- `src/telegram-status-projection.ts`
- `src/telegram-work-handlers.ts`

Existing integration points:

- `src/telegram-job-store.ts`
- `src/app-server-client.ts`
- `src/app-server-turn-manager.ts`
- `src/codex-session.ts`
- `src/bot.ts`
- `src/telegram-runner.ts`
- `src/turn-progress.ts`
- `src/status-board.ts`
- `src/status-board-render.ts`
- `src/session-guardian-store.ts`
- `src/session-guardian-service.ts`
- `src/session-guardian-ipc-client.ts`
- `src/session-guardian-ipc-protocol.ts`
- `src/dashboard-api.ts`
- `src/mini-app-server.ts`
- `src/config.ts`
- `src/index.ts`
- `web/src/model.ts`
- `web/src/api.ts`
- `web/src/App.svelte`
- `web/src/ThreadRow.svelte`
- `web/src/app.css`

---

## Execution documents

Run the parts in order. Every part inherits the skills, constraints, state contract, and file map above.

1. [Part 1: durable state, SQLite, migration, and Codex transport](2026-08-22-telecodex-message-reliability-part-1-foundations.md) - Tasks 1-5.
2. [Part 2: ingress, coordinator, outbox, Guardian, and status](2026-08-22-telecodex-message-reliability-part-2-runtime.md) - Tasks 6-10.
3. [Part 3: restart reconciliation, bot routing, UI, fault tests, and rollout](2026-08-22-telecodex-message-reliability-part-3-reconciliation-rollout.md) - Tasks 11-15.

## Task order

- [Task 1: Define durable job types and enforce state invariants](2026-08-22-telecodex-message-reliability-part-1-foundations.md#task-1-define-durable-job-types-and-enforce-state-invariants)
- [Task 2: Replace the JSON store with a transactional SQLite WAL ledger](2026-08-22-telecodex-message-reliability-part-1-foundations.md#task-2-replace-the-json-store-with-a-transactional-sqlite-wal-ledger)
- [Task 3: Add shadow import, compatibility export, and rollback controls](2026-08-22-telecodex-message-reliability-part-1-foundations.md#task-3-add-shadow-import-compatibility-export-and-rollback-controls)
- [Task 4: Put bounded deadlines and dispatch-boundary evidence into app-server RPC](2026-08-22-telecodex-message-reliability-part-1-foundations.md#task-4-put-bounded-deadlines-and-dispatch-boundary-evidence-into-app-server-rpc)
- [Task 5: Emit exact dispatch, turn, and activity facts from Codex execution](2026-08-22-telecodex-message-reliability-part-1-foundations.md#task-5-emit-exact-dispatch-turn-and-activity-facts-from-codex-execution)
- [Task 6: Persist every work-producing Telegram update before materialization](2026-08-22-telecodex-message-reliability-part-2-runtime.md#task-6-persist-every-work-producing-telegram-update-before-materialization)
- [Task 7: Centralize queueing and Codex lifecycle in a durable coordinator](2026-08-22-telecodex-message-reliability-part-2-runtime.md#task-7-centralize-queueing-and-codex-lifecycle-in-a-durable-coordinator)
- [Task 8: Build an idempotent response plan and Telegram delivery outbox](2026-08-22-telecodex-message-reliability-part-2-runtime.md#task-8-build-an-idempotent-response-plan-and-telegram-delivery-outbox)
- [Task 9: Read Guardian observations through its existing inspection IPC](2026-08-22-telecodex-message-reliability-part-2-runtime.md#task-9-read-guardian-observations-through-its-existing-inspection-ipc)
- [Task 10: Produce one honest status projection and one durable Telegram anchor](2026-08-22-telecodex-message-reliability-part-2-runtime.md#task-10-produce-one-honest-status-projection-and-one-durable-telegram-anchor)
- [Task 11: Reconcile unfinished jobs on restart without replaying prompts](2026-08-22-telecodex-message-reliability-part-3-reconciliation-rollout.md#task-11-reconcile-unfinished-jobs-on-restart-without-replaying-prompts)
- [Task 12: Route all work-producing bot paths through durable ingress](2026-08-22-telecodex-message-reliability-part-3-reconciliation-rollout.md#task-12-route-all-work-producing-bot-paths-through-durable-ingress)
- [Task 13: Expose readiness, health, and unified status in the Dashboard](2026-08-22-telecodex-message-reliability-part-3-reconciliation-rollout.md#task-13-expose-readiness-health-and-unified-status-in-the-dashboard)
- [Task 14: Add retention and the end-to-end fault-injection suite](2026-08-22-telecodex-message-reliability-part-3-reconciliation-rollout.md#task-14-add-retention-and-the-end-to-end-fault-injection-suite)
- [Task 15: Stage the live rollout only after separate authorization](2026-08-22-telecodex-message-reliability-part-3-reconciliation-rollout.md#task-15-stage-the-live-rollout-only-after-separate-authorization)

## Final acceptance checklist

- Every work-producing Telegram update is committed under `botId + updateId` before external work.
- Duplicate updates cannot create duplicate Codex turns.
- Dispatch unknown after socket write is never automatically replayed.
- Exact `threadId` and `turnId` are persisted as soon as known.
- Status separates phase, health, activity, outcome, delivery, and attention.
- Timer heartbeats never masquerade as Codex activity.
- Guardian is the only owner of global stall classification/restoration.
- TeleCodex can continue showing jobs when Guardian is unavailable.
- Restart reconciliation never re-enters the prompt handler.
- Response plans and delivery parts are durable and idempotent where Telegram identity permits.
- `Done` means Codex completed and every response part was delivered.
- `/healthz`, `/readyz`, Telegram status, and Dashboard agree on the same projection.
- Payload and metadata retention follow the approved 7/90-day policy without deleting unresolved work.
- Full tests, typecheck, web checks, production build, diff check, and code review pass.
- No commit, push, migration, deployment, or service restart occurs without explicit user authorization.

---
