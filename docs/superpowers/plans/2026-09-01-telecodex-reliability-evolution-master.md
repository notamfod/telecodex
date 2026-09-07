# TeleCodex Reliability Evolution Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved TeleCodex reliability program as independently testable and deployable microreleases.

**Architecture:** SQLite remains authoritative for jobs, delivery, and recovery intent. A safe release controller protects planned restarts, bounded background services keep Telegram ingress responsive, one Telegram write coordinator owns rate pressure, and continuous reconciliation applies only evidence-safe recovery effects.

**Tech Stack:** TypeScript, Node.js 20+, grammY, SQLite via `better-sqlite3`, Svelte/Vite, Vitest, systemd.

---

## Authority and execution constraints

- Approved design: [`../specs/2026-08-30-telecodex-reliability-evolution-design.md`](../specs/2026-08-30-telecodex-reliability-evolution-design.md).
- Work in the existing `telecodex-improvements` checkout. It contains substantial uncommitted implementation that is absent from a clean worktree.
- Preserve unrelated modified and untracked files.
- Do not commit, push, merge, or remove files unless the user separately requests it.
- Do not start implementation until the user approves this plan set.
- Implement one microrelease at a time. The next implementation waits until the current release is accepted or rolled back.
- Updating `telecodex.service` after each implemented microrelease is in scope. Guardian and the shared app-server are not restarted unless a later explicit approval names them.

## Plan set

- [Block 0: safe deployment](2026-09-01-telecodex-reliability-block-0-safe-deployment.md)
- [Block A: performance and measurement](2026-09-01-telecodex-reliability-block-a-performance.md)
- [Block B: durable Telegram delivery](2026-09-01-telecodex-reliability-block-b-delivery.md)
- [Block C: continuous recovery](2026-09-01-telecodex-reliability-block-c-recovery.md)

Each block plan defines exact source files, tests, public contracts, focused commands, live checks, and rollback conditions. Before implementation, expand only the next microrelease into its work packet and verify that current line numbers and call sites still match.

## Verified runtime baseline

The planning snapshot on 2026-09-01 found:

```text
service:        /etc/systemd/system/telecodex.service
working dir:    /root/Documents/Codex/2026-08-07-hermes/telecodex
entrypoint:     dist/index.js
service state:  active/running
restart policy: on-failure, 5 seconds
stop timeout:   15 seconds
main PID:       1237187
restart count:  0
```

Resolve these values again before every live mutation. Planning evidence is not deployment evidence.

## Dependency order

```text
0.1 -> 0.1a.1 -> 0.1a.2 -> 0.2 -> 0.3 -> 0.4 -> 0.5 -> 0.6
                                      |
                                      v
A1 -> A2 -> A3 -> A4 -> A5 -> A6 -> A7
                                      |
                                      v
B1 -> B2 -> B3 -> B4 -> B5 -> B6 -> B7 -> B8 -> B9
                                                     |
                                                     v
C1 -> C2 -> C3 -> C4 -> C5 -> C6 -> C7 -> C8 -> C9
```

An item may move earlier only when its block plan lists all dependencies as satisfied and the work packet records the reason. No cutover item may precede its shadow item.

## Release and observation matrix

| ID | Observable result | Minimum observation |
| --- | --- | --- |
| 0.1 | Read-only safe/unsafe preflight | 10 minutes |
| 0.1a.1 | Exact legacy-quarantine audit, no runtime activation | No restart; two stable live audits |
| 0.1a.2 | Guarded repair and retention-proof preservation | 10 minutes after restart |
| 0.2 | Durable drain state blocks new turn launches | 60 minutes and one queued-during-drain job |
| 0.3 | Release waits for a safe boundary or cancels | 60 minutes and one bounded drain |
| 0.4 | Versioned build switches atomically | 60 minutes and one real restart |
| 0.5 | Failed candidate rolls back automatically | 60 minutes and one controlled failed probe |
| 0.6 | Pre/post audit proves job continuity | 60 minutes and one real restart |
| A1 | Critical-path timing snapshot | 10 minutes |
| A2 | Named slow-operation timing | 10 minutes |
| A3 | Periodic tasks are single-flight | 30 minutes |
| A4 | Background work obeys batch/time budgets | 30 minutes |
| A5 | Compact projection shadow comparison | 30 minutes with zero unexplained mismatch |
| A6 | Status Board reads compact projection | 30 minutes |
| A7 | Mini App overview reads compact projection | 30 minutes |
| B1 | Unified write contract in pass-through mode | 10 minutes |
| B2 | Background Telegram writes use low priority | 30 minutes |
| B3 | Inbox/control writes use normal priority | 30 minutes |
| B4 | Job/final delivery uses high priority | 30 minutes and one real answer |
| B5 | Fairness prevents final or normal starvation | 30 minutes under synthetic pressure |
| B6 | Durable `retry_after` survives restart | 30 minutes and one controlled persisted cooldown |
| B7 | Topic creation/binding has durable intent | 60 minutes and one real topic operation |
| B8 | Inbox handoff/state mutation is durable | 60 minutes and one real Inbox flow |
| B9 | Operator can inspect failed/uncertain delivery | 10 minutes |
| C1 | One correlated recovery view | 10 minutes |
| C2 | Periodic reconciler classifies in shadow mode | 30 minutes |
| C3 | Recovery heartbeat reports bounded progress | 30 minutes |
| C4 | Safe states recover continuously | 60 minutes and one controlled safe case |
| C5 | Exact turn reattaches after reconnect | 60 minutes and one controlled reconnect |
| C6 | Persisted reconciliation resumes idempotently | 60 minutes and one restart boundary case |
| C7 | Guardian outcome appears immediately in job state | 60 minutes and one read-only check outcome |
| C8 | Operator recovery actions preserve original job | 60 minutes and one controlled action |
| C9 | Whitelisted auto-repair rejects unknown reasons | 60 minutes and one allowed case |

Planning may continue during these windows. Implementation may not.

## Common TDD loop for every microrelease

- [ ] Read every file named by the block task before editing it.
- [ ] Record `git status --short`, the service PID, restart count, and active job/delivery counts.
- [ ] Add the named failing tests from the block task.
- [ ] Run the focused command and confirm failure for the intended missing behavior.
- [ ] Implement only the contract named by the task.
- [ ] Run the focused command and confirm pass.
- [ ] Run repository verification sequentially:

```bash
npm test
npm run check:web
npm run build
git diff --check
```

Expected: all Vitest files pass, Svelte reports no errors, server and web builds exit zero, and diff check emits no output. If a microrelease does not touch `web/`, `npm run check:web` still runs in the full gate.

- [ ] Use `requesting-code-review`; resolve findings with `receiving-code-review` and rerun impacted plus full checks.
- [ ] Re-resolve the live unit, entrypoint, environment file, PID, restart count, and readiness URL.
- [ ] Run preflight and drain. For 0.1, use the documented manual exception.
- [ ] Install and restart only `telecodex.service` through the newest accepted release tooling.
- [ ] Run the task's target smoke and the common live checks.
- [ ] Observe for the matrix interval, then accept or roll back.

## Common live checks

After each restart, capture exact output from:

```bash
systemctl show telecodex.service -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecStart -p FragmentPath
systemctl is-active telecodex.service
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8787/healthz
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8787/readyz
journalctl -u telecodex.service --since "5 minutes ago" --no-pager
```

Resolve the configured Mini App port before using `8787`; do not assume the planning default. Inspect SQLite through the accepted read-only CLI or bounded store methods, not ad hoc writes.

The live gate rejects:

- readiness failure or restart-loop growth;
- a lost accepted job or orphaned non-terminal job;
- an unexpected duplicate job, turn, topic, or Telegram delivery;
- a new unexplained `uncertain` state;
- target SLO regression attributable to the candidate;
- a Guardian, app-server, or polling ownership regression.

## Rollback rule

Rollback switches code and runtime configuration to the previous accepted release. It does not delete SQLite rows, remove evidence, retry jobs, interrupt turns, or restore a database snapshot over newer user work.

Before block 0.5 exists, rollback commands must be resolved and presented before the restart. From 0.5 onward, use the release controller's recorded previous release and then run the same live checks.

## Completion gate

The program is complete only when 0.1 through C9 are accepted, the final full test/build evidence is fresh, the running release identity matches the final candidate, the observation window is complete, and no required review finding remains open.
