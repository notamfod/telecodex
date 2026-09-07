# TeleCodex Combined Reliability Maintenance Plan

> Execute one task at a time with RED, GREEN, review, and verification. Do not
> mutate the live ledger until Tasks 1-6 pass and the maintenance stop gate is
> satisfied.

**Goal:** Correct the quarantine classifier, prevent recurrence, repair the
stable live quarantine set, and make failed Codex turns settle so Telegram jobs
and their queue cannot remain stuck.

**Designs:**

- [`../specs/2026-09-01-telecodex-quarantine-repair-design.md`](../specs/2026-09-01-telecodex-quarantine-repair-design.md)
- [`../specs/2026-09-04-telecodex-failed-turn-recovery-design.md`](../specs/2026-09-04-telecodex-failed-turn-recovery-design.md)

## Boundaries

- Preserve every unrelated worktree change. Do not commit, push, or clean.
- Build only into a fresh private staging directory while the live service runs.
- Diagnostic output contains counts and condition codes only.
- Do not stop TeleCodex while an app-server exact turn is genuinely active or a
  Telegram delivery is `sending`.
- Repair only the complete set proven twice by the same count and hash after the
  service stops.
- Never retry or redeliver historical work.

## Task 1: Add safe condition diagnostics

**Files:** `src/telegram-job-quarantine-repair.ts`,
`src/telegram-job-quarantine-audit-reader.ts`, `src/telecodex-release-cli.ts`,
their existing quarantine and CLI tests.

1. Add a first-rejection condition code for each of the 15 signature checks.
2. Add `quarantine diagnose --json` with bounded totals only.
3. Prove output has no IDs, paths, source/event/delivery payloads, prompts,
   responses, or attachment data.
4. Run focused tests, stage-compile the CLI, and run the command read-only on the
   live ledger.

Expected live evidence: every current unknown row rejects at condition 14, the
legacy status-anchor assumption.

## Task 2: Correct the legacy delivery contract

**Files:** quarantine fixture, classifier, audit reader, hash tests, CLI tests.

1. Change the fixture to one or more synthetic `final` delivery rows and zero
   anchors.
2. Require a one-to-one response-plan mapping plus the exact final-row
   invariants from the repair design.
3. Keep critical-delivery detection independent and fail-closed.
4. Run focused tests and two live read-only audits.

Gate: both audits cover every current quarantine row, report `unknown=0` and
`criticalDeliveries=0`, and return identical count and hash.

## Task 3: Settle failed app-server turns

**Files:** `src/app-server-turn-manager.ts`,
`src/telegram-exact-turn-inspector.ts`, `src/telegram-job-reconciler.ts`, and new
focused test files.

1. Write failing tests for error/idle ordering, exact failed reads, rich input,
   late completion races, restart recovery, and queue drain.
2. Implement exact-turn terminal reconciliation without treating `error` alone
   as terminal.
3. Route recognized failed exact turns through existing recovery and durable
   failure settlement.
4. Run manager, inspector, reconciler, coordinator, and Codex-session tests.

## Task 4: Preserve migration proof

**Files:** `src/telegram-job-ledger.ts`, retention and reconciliation tests.

1. Write the retention recurrence test first.
2. Preserve only a strictly valid synthetic migration proof while still purging
   text and attachments.
3. Reject malformed or spoofed proofs.
4. Exclude fully delivered synthetic legacy jobs from status refresh without
   hiding incomplete physical deliveries.
5. Prove two reconciliation scans produce no event or quarantine recurrence.

## Task 5: Implement guarded repair and verified backup

**Files:** quarantine repair module, CLI, and focused tests.

1. Implement hash-bound all-or-nothing repair with per-row change-count checks.
2. Implement a private mode-0600 SQLite backup and logical verification.
3. Require exact `systemctl is-active telecodex.service` result `inactive`.
4. Add logical ledger digest for the post-repair rollback boundary.
5. Prove stale hashes, unknown rows, critical deliveries, writer locks, injected
   failures, and backup failures write nothing.

## Task 6: Build and review the candidate

1. Run focused verification for every changed subsystem.
2. Review the complete scoped diff and resolve Critical or Important findings.
3. Record live `MainPID`, `NRestarts`, `ExecStart`, and `FragmentPath`.
4. Snapshot current complete `dist` and `dist-web` trees.
5. Compile TypeScript and Vite into a fresh private stage, never live paths.
6. Run `npm test`, `npm run check:web`, staged TypeScript build, staged Vite
   build, and `git diff --check`.
7. Record candidate file digests and repeat the live read-only audit twice.

## Task 7: Maintenance stop gate

1. Re-read all non-terminal jobs and deliveries from live SQLite.
2. Resolve every recorded exact turn through app-server. Historical terminal
   failed turns are allowed because the candidate will settle them; genuinely
   active or ambiguous turns block the stop.
3. Require zero `sending` deliveries.
4. Stop only `telecodex.service` and prove it is inactive.
5. Repeat the audit twice. Require identical count/hash, no unknown rows, and no
   critical deliveries.

## Task 8: Backup, repair, and activation

1. Create and verify the private SQLite backup.
2. Run the transaction using the final audit hash.
3. Verify integrity, foreign keys, zero remaining known quarantine rows, and the
   unchanged archive/delivery invariants.
4. Record the post-repair logical ledger digest.
5. Verify candidate digests, install complete staged `dist` and `dist-web`, and
   start TeleCodex.

If any pre-start check fails, restore the verified backup and previous complete
build. After start, never restore SQLite unless the current logical digest still
equals the post-repair boundary.

## Task 9: Runtime verification and observation

1. Prove service active, stable PID/restart count, expected candidate files, and
   clean targeted startup logs.
2. Run release preflight, Guardian status, integrity checks, and a fresh
   quarantine audit.
3. Confirm app-server exact evidence settles the previously stuck failed turns
   and the queue advances without retry or duplicate delivery.
4. Observe for ten minutes, polling at intervals under 60 seconds. Accept only
   with no recurrence, new stall, 429 loop, duplicate delivery, or restart.
5. Leave all source changes uncommitted and report exact runtime evidence and
   rollback artifacts.
