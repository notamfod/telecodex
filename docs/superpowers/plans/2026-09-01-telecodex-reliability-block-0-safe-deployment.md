# TeleCodex Reliability Block 0: Safe Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every planned TeleCodex update wait for a safe work boundary, switch a complete version atomically, verify it, and roll it back without altering user data.

**Architecture:** A typed release CLI reads the canonical SQLite ledger, stores only deployment control metadata, and drives a runtime drain gate. Versioned release directories hold immutable build output; systemd starts the `current` symlink, while the external CLI survives a service restart and owns verification or rollback.

**Tech Stack:** TypeScript, Node.js filesystem and child-process APIs, SQLite metadata, Vitest, systemd.

---

## Boundaries

- Release state lives under `.telecodex/releases/` and `.telecodex/release-state/` with private permissions.
- Runtime drain state uses one namespaced SQLite metadata key. It contains no prompt or response data.
- The release CLI calls `systemctl` through `execFile` with fixed arguments. Never build a shell command from user input.
- Release IDs match `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$`.
- The first 0.1 deployment uses the existing `/etc/systemd/system/telecodex.service` only after manual proof that no turn or critical delivery is active.
- No task commits changes unless the user separately authorizes a commit.

### Task 0.1: Add read-only release preflight

**Files:**
- Create: `src/telecodex-release-preflight.ts`
- Create: `src/telecodex-release-cli.ts`
- Create: `test/telecodex-release-preflight.test.ts`
- Create: `test/telecodex-release-cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing report tests**

Define this public contract and test safe, unsafe, timeout, malformed-row, and dependency-unavailable cases:

```ts
export interface TeleCodexReleasePreflightReport {
  schemaVersion: 1;
  checkedAt: number;
  safeToRestart: boolean;
  reasons: readonly string[];
  jobs: { queued: number; running: number; delivering: number; attention: number };
  deliveries: { pending: number; sending: number; uncertain: number; failed: number };
  guardian: "ready" | "unavailable";
  releaseId: string | null;
}
```

Assert that reasons are bounded codes such as `ACTIVE_TURN`, `DELIVERY_SENDING`, `STORE_UNAVAILABLE`, and `GUARDIAN_UNAVAILABLE`. Serialized output must not contain source payloads, prompts, responses, tokens, or absolute paths.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run test/telecodex-release-preflight.test.ts test/telecodex-release-cli.test.ts`

Expected: FAIL because the preflight modules do not exist.

- [ ] **Step 3: Implement bounded read-only inspection**

Use `SqliteTelegramJobStore.listUnfinished()`, `listDeliveries(jobId)`, and the existing Guardian IPC status client. Open the store read-only for the CLI. Count `sending` as unsafe, count `pending` as unsafe only when its parent job is already terminal/delivering and due, and never transition a job.

Expose:

```text
node dist/telecodex-release-cli.js preflight --json
```

Exit `0` when safe, `2` when unsafe, and `1` for an invalid invocation or unavailable store. Add `release:preflight` to `package.json` as `node dist/telecodex-release-cli.js preflight --json`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- --run test/telecodex-release-preflight.test.ts test/telecodex-release-cli.test.ts test/telegram-job-store-sqlite.test.ts
npm run build:server
```

Expected: PASS and `dist/telecodex-release-cli.js` exists.

- [ ] **Step 5: Deploy 0.1 with the manual exception**

Before the current-style build/restart, inspect live jobs, exact app-server turns, delivery rows, and Guardian status read-only. Proceed only with zero active turns and zero sending deliveries. After restart, run the new preflight, common live checks, and the 10-minute observation.

Rollback: restore the previously saved complete `dist` and `dist-web` directories, restart only TeleCodex, and repeat the live checks. Do not overwrite SQLite.

Live preflight is currently blocked by the confirmed synthetic legacy quarantine defect. Complete and separately accept [microsteps 0.1a.1 and 0.1a.2](2026-09-01-telecodex-quarantine-repair.md) before Task 0.2. The repair plan does not weaken Task 0.1 fail-closed behavior.

### Task 0.2: Add durable drain mode

**Files:**
- Create: `src/telecodex-runtime-control.ts`
- Create: `test/telecodex-runtime-control.test.ts`
- Modify: `src/telegram-job-coordinator.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `src/index.ts`
- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telegram-job-coordinator.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`
- Modify: `test/telecodex-release-cli.test.ts`

- [ ] **Step 1: Write failing drain tests**

Use this persisted value under metadata key `telecodex.runtime-control`:

```ts
export interface TeleCodexRuntimeControlState {
  schemaVersion: 1;
  drain: boolean;
  changedAt: number;
  owner: string;
}
```

Assert that a drained coordinator materializes and queues accepted jobs but never calls `resolveThread()` or `turn/start`. Existing running and delivery work continues. Clearing drain triggers one pump, and restart restores the stored state.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run test/telecodex-runtime-control.test.ts test/telegram-job-coordinator.test.ts test/telegram-reliability-runtime.test.ts`

Expected: FAIL because coordinator dispatch has no drain predicate.

- [ ] **Step 3: Implement runtime control and watcher**

Add `isDispatchPaused(): boolean` to coordinator options and check it after `queueAccepted()` but before `listDispatchable()`. Add a one-second watcher that reads only the namespaced metadata row, calls `coordinator.pump()` on `true -> false`, and stops during lifecycle cleanup.

Expose `drain enter --owner <release-id>`, `drain leave --owner <release-id>`, and `drain status --json`. Reject an owner mismatch instead of clearing another deployment's drain.

- [ ] **Step 4: Verify GREEN and live behavior**

Run focused tests plus `npm run build`. Deploy through 0.1 preflight. Enter drain, send one private test prompt, prove it is accepted once and not dispatched, leave drain, and prove that exact job starts once. Observe 60 minutes.

Rollback: leave drain with the recorded owner before switching code back. If the candidate cannot clear it, use the previous CLI against the same metadata contract.

### Task 0.3: Wait for a safe boundary

**Files:**
- Create: `src/telecodex-release-drain.ts`
- Create: `test/telecodex-release-drain.test.ts`
- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telecodex-release-cli.test.ts`

- [ ] **Step 1: Write failing wait tests**

Specify `waitForSafeDrain()` with injected clock, sleep, control, and preflight dependencies. Cover immediate safety, active turn completion, delivery completion, timeout, owner mismatch, store failure, and signal cancellation.

```ts
export interface SafeDrainResult {
  outcome: "safe" | "timed_out" | "cancelled";
  waitedMs: number;
  finalReport: TeleCodexReleasePreflightReport;
}
```

Timeout or cancellation must clear only the caller's drain and must not abort a job.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telecodex-release-drain.test.ts test/telecodex-release-cli.test.ts`

Add `drain wait --owner <release-id> --timeout-ms <bounded>` with a default 30-minute deadline and a one-second polling interval. Expected after implementation: PASS.

- [ ] **Step 3: Deploy and canary**

Deploy through 0.2. Run one safe immediate drain and one controlled timeout against a fake long deadline in the test environment, not by interrupting a real turn. Prove timeout leaves the service accepting and dispatching after drain clears. Observe 60 minutes.

### Task 0.4: Add versioned atomic releases

**Files:**
- Create: `src/telecodex-release-layout.ts`
- Create: `test/telecodex-release-layout.test.ts`
- Create: `systemd/telecodex.service`
- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telecodex-release-cli.test.ts`

- [ ] **Step 1: Write failing filesystem tests**

Use temporary directories and assert private creation, release-ID validation, complete copy of `dist/` and `dist-web/`, immutable manifest creation, atomic `current.next -> current` rename, and preservation of the previous target.

```ts
export interface TeleCodexReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  createdAt: number;
  sourceRevision: string;
  sourceDirty: boolean;
  files: readonly { path: string; sha256: string; bytes: number }[];
}
```

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telecodex-release-layout.test.ts test/telecodex-release-cli.test.ts`

Implement `release stage --id <id>` and `release activate --id <id>`. Reject symlinks inside staged input, path traversal, a changed manifest, incomplete output, and an existing release with different content.

- [ ] **Step 3: Track the service template**

Copy the current unit hardening options into `systemd/telecodex.service`, change only `ExecStart` to:

```ini
ExecStart=/usr/bin/node /root/Documents/Codex/2026-08-07-hermes/telecodex/.telecodex/current/dist/index.js
```

Keep `WorkingDirectory` at the repository root so state and relative configuration do not move with a release.

- [ ] **Step 4: Deploy atomically**

Stage the candidate, enter and wait for drain, install the reviewed unit, run `systemctl daemon-reload`, activate the candidate symlink, and restart only TeleCodex. Keep drain active through restart. After `ExecStart`, manifest identity, and readiness pass, clear only the recorded owner and verify one queued job pumps once. Run one real prompt and the 60-minute window.

Rollback: keep drain active, atomically point `current` at the saved previous release, restart only TeleCodex, verify previous-release readiness, then clear the recorded owner. If previous-release readiness fails, leave drain active and report the failure instead of launching new turns.

### Task 0.5: Verify candidates and roll back automatically

**Files:**
- Create: `src/telecodex-release-probe.ts`
- Create: `src/telecodex-release-controller.ts`
- Create: `test/telecodex-release-probe.test.ts`
- Create: `test/telecodex-release-controller.test.ts`
- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telecodex-release-cli.test.ts`

- [ ] **Step 1: Write failing controller tests**

Model fixed process dependencies for `systemctl restart/show`, HTTP health/readiness, manifest inspection, and symlink activation. Cover candidate success, restart failure, probe timeout, PID churn, readiness failure, rollback success, and rollback failure reporting.

```ts
export interface TeleCodexDeploymentResult {
  outcome: "accepted" | "rolled_back" | "rollback_failed";
  candidateId: string;
  previousId: string;
  reasons: readonly string[];
}
```

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telecodex-release-probe.test.ts test/telecodex-release-controller.test.ts test/telecodex-release-cli.test.ts`

Implement `release deploy --id <id> --service telecodex.service`. Allow only the exact service name, use fixed `systemctl` arguments, bound each probe to three seconds, require a stable PID and restart count across the verification interval, and always record the previous release before activation.

The controller state machine is exact: enter drain, wait safe, record previous, activate candidate, restart, verify candidate, clear drain on success. On candidate failure it keeps drain active, reactivates previous, restarts, verifies previous, then clears drain. If rollback verification fails, it leaves drain active and returns `rollback_failed`.

- [ ] **Step 3: Controlled rollback canary**

Use a staged candidate whose probe configuration intentionally fails before it can accept work. Prove automatic return to the previous release, unchanged SQLite, stable service, and a recorded `rolled_back` result. Observe 60 minutes after the accepted follow-up candidate.

### Task 0.6: Add pre/post job continuity audit

**Files:**
- Create: `src/telecodex-release-audit.ts`
- Create: `test/telecodex-release-audit.test.ts`
- Modify: `src/telecodex-release-controller.ts`
- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telecodex-release-controller.test.ts`
- Modify: `test/telecodex-release-cli.test.ts`

- [ ] **Step 1: Write failing audit tests**

Capture only identifiers and operational state:

```ts
export interface TeleCodexReleaseAuditSnapshot {
  schemaVersion: 1;
  capturedAt: number;
  jobs: readonly {
    jobId: string;
    version: number;
    phase: string;
    threadId: string | null;
    turnId: string | null;
    deliveryStates: readonly string[];
  }[];
}
```

Compare before/after snapshots and reject a missing job, version rollback, identity mismatch, impossible terminal reversal, or missing delivery. Permit valid forward transitions while the service was draining/delivering.

- [ ] **Step 2: Verify RED, implement, and verify GREEN**

Run: `npm test -- --run test/telecodex-release-audit.test.ts test/telecodex-release-controller.test.ts`

Write audit files with mode `0600`, fsync before rename, and bounded retention by count without deleting the active deployment's evidence. Integrate capture before activation and comparison after readiness.

- [ ] **Step 3: Final Block 0 verification and rollout**

Run the common full gate and independent review. Deploy through 0.5, run one real prompt across a planned restart boundary only after it reaches a safe state, verify the audit result, and observe 60 minutes.

Block 0 acceptance requires that all later releases can use `release deploy` without manually overwriting `dist`, interrupting an active turn, or losing the previous runnable version.
