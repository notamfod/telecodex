# TeleCodex Existing Topic Resume Activation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the versioned resume action, enable exactly one live action, and invoke it once.

**Architecture:** Action wiring is installed first while the runtime flag is off. A read-only live preflight gates flag enablement, and a second preflight plus verified backup gates the single operator POST.

**Tech Stack:** TypeScript 5.9, Node.js 20+, grammY 1.45, Vitest 3, systemd, curl, better-sqlite3.

---

Use the boundaries and shared verification, installation, and observation gates in `docs/superpowers/plans/2026-09-08-telecodex-existing-topic-resume.md`. Begin only after the core plan has reached 06.2b with schema v8 and zero resume rows.

### Task 4: Microrelease 06.3a, action wiring while disabled

**Files:**
- Modify: `src/telegram-status-projection.ts`
- Modify: `src/telegram-grammy-transport.ts`
- Modify: `src/status-board-render.ts`
- Modify: `src/bot.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `src/telegram-reliability-runtime.ts`
- Modify: `test/telegram-status-projection.test.ts`
- Modify: `test/telegram-grammy-transport.test.ts`
- Modify: `test/status-board-render.test.ts`
- Modify: `test/bot-message-reliability.test.ts`
- Modify: `test/mini-app-server.test.ts`
- Modify: `test/dashboard-controller.test.ts`
- Modify: `test/telegram-reliability-runtime.test.ts`

- [ ] **Step 1: Write failing projection tests**

Add `resume_existing_topic` to `TelegramStatusActionKind`. Define:

```ts
export type TelegramTopicResumeActionState = Exclude<TelegramTopicResumeState, "complete" | "failed">;

export function enrichTopicResumeAction(
  projection: TelegramJobStatusProjection,
  candidate: TelegramTopicResumeCandidate | null,
  attemptState?: TelegramTopicResumeActionState,
): TelegramJobStatusProjection;
```

For a matching server-proven candidate, require this first action:

```ts
{
  kind: "resume_existing_topic",
  jobId: projection.jobId,
  expectedVersion: projection.expectedVersion,
}
```

For every active/waiting/unknown/handoff resume state, suppress only the status-anchor `retry_delivery` action. Preserve follower retry actions and `details`. Reject candidate/projection version mismatch.

- [ ] **Step 2: Implement projection and runtime action routing**

After the existing missing-topic enrichment, compute resume eligibility from the exact anchor plan, failed recovery row, resume row, quarantine state, forum, thread, and current binding. Add the action only when no resume attempt exists. `runDashboardAction` must reload the projection, require exact action equality, and call `topicResume.resume(action)` only for `resume_existing_topic`.

The runtime must remain absent while the flag is false, so this code cannot project or execute the action in the installed 06.3a configuration.

- [ ] **Step 3: Add callback and rendered-label tests**

Use code `u` and label `Resume topic`:

```ts
expect(telegramStatusActionCallbackData({
  kind: "resume_existing_topic", jobId: "job-exact", expectedVersion: 541,
})).toBe("tcj:u:job-exact:541");
```

Extend `CANONICAL_STATUS_ACTION_PATTERN` with `u`, the bot code map with `u: "resume_existing_topic"`, and both label maps with `Resume topic`. Assert callback data stays within Telegram's 64-byte limit and the callback answer is `Topic resume started`.

- [ ] **Step 4: Add authenticated HTTP allowlist tests**

Accept only:

```http
POST /api/dashboard/jobs/<job>/actions/resume_existing_topic
Content-Type: application/json

{"expectedVersion":541}
```

Require 401 without valid Telegram init data, 400 for an unknown action, and 400 if the body contains `chatId`, `messageThreadId`, `threadId`, `partKey`, `actionToken`, or any other extra key. Assert exactly one canonical DTO reaches `runJobAction`.

- [ ] **Step 5: Run focused GREEN verification**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-status-projection.test.ts \
  test/telegram-grammy-transport.test.ts \
  test/status-board-render.test.ts \
  test/bot-message-reliability.test.ts \
  test/mini-app-server.test.ts \
  test/dashboard-controller.test.ts \
  test/telegram-reliability-runtime.test.ts
```

- [ ] **Step 6: Verify, commit, install, and observe 06.3a with the flag off**

Run the shared code gate and review. Commit:

```bash
git commit -m "NO-TICKET feat: expose existing topic resume action"
```

Set `TELECODEX_RELEASE_TAG=06.3a-resume-action-disabled`, run the shared installation gate, and complete twenty clean snapshots. An authenticated Dashboard refresh must contain zero `resume_existing_topic` actions, and the database must contain zero resume rows.

### Task 5: Microrelease 06.3b, enable exactly one action

**Files:**
- Inspect: live systemd unit and drop-ins
- Modify externally: one TeleCodex systemd environment drop-in
- Verify: authenticated Dashboard projection and live SQLite aggregates

- [ ] **Step 1: Reconfirm the live bounded predicate read-only**

Use one read-only process. Resolve identity and version internally. Print only:

```json
{"eligible":1,"failedRecoveries":1,"failedAnchors":1,"pendingFollowers":2,"sending":0,"uncertain":0,"activeTurns":0,"resumeAttempts":0,"quarantine":0}
```

Require `quick_check=ok`, zero foreign-key violations, schema v8, Guardian ready, and service restart count unchanged. Stop on any differing value.

- [ ] **Step 2: Inspect and merge the service configuration**

Run `systemctl cat telecodex.service` and inspect the existing drop-in names. Do not print environment values. Add or update one focused drop-in through `apply_patch`:

```ini
[Service]
Environment=TELEGRAM_TOPIC_RESUME_ENABLED=true
```

Preserve the existing `TELEGRAM_TOPIC_RECOVERY_ENABLED=true` setting. Run `systemctl daemon-reload`.

- [ ] **Step 3: Restart at the shared idle boundary**

Set `TELECODEX_RELEASE_TAG=06.3b-resume-action-enabled`. No source build is needed if the 06.3a trees are unchanged. Run the shared preflight and restart checks without replacing the installed code trees.

- [ ] **Step 4: Verify one action without invoking it**

Load Dashboard once through its authenticated API. Require exactly one `resume_existing_topic` action and zero resume rows. Do not print the action URL, job ID, expected version, callback data, or topic identity. Do not POST.

- [ ] **Step 5: Observe twenty bounded snapshots**

Run the shared observation gate. Require the one action to remain stable, zero resume rows, stable PID and restart count, no Telegram reopen call, and no new error loop.

### Task 6: Microrelease 06.4, resume the historical response once

**Files:**
- Read: `.telecodex/jobs.sqlite`
- Create privately: `.telecodex/release-state/existing-topic-resume/jobs-before-resume-YYYYMMDDTHHMMSSZ.sqlite`
- Modify externally: at most one Telegram topic reopen and the existing three-part delivery plan through one authenticated action

- [ ] **Step 1: Reconfirm the exact action boundary**

Reload Dashboard and recompute the bounded predicate in the same operator process. Require exactly one action, its version to equal the live job version, zero active turns, zero sending or uncertain deliveries, zero resume attempts, zero quarantine rows, Guardian ready, and stable service state. Print only the aggregate JSON from Task 5 Step 1.

- [ ] **Step 2: Create and verify an online SQLite backup**

```bash
set -euo pipefail
install -d -m 0700 .telecodex/release-state/existing-topic-resume
TELECODEX_BACKUP=.telecodex/release-state/existing-topic-resume/jobs-before-resume-$(date -u +%Y%m%dT%H%M%SZ).sqlite
export TELECODEX_BACKUP
node --input-type=module <<'NODE'
import { chmod } from "node:fs/promises";
import Database from "better-sqlite3";
const source = new Database(".telecodex/jobs.sqlite", { readonly: true, fileMustExist: true });
try {
  if (source.pragma("quick_check", { simple: true }) !== "ok") throw new Error("quick_check failed");
  if (source.pragma("foreign_key_check").length !== 0) throw new Error("foreign key check failed");
  if (source.pragma("user_version", { simple: true }) !== 8) throw new Error("schema mismatch");
  const count = source.prepare("SELECT count(*) AS count FROM topic_resume_attempts").get().count;
  if (count !== 0) throw new Error("resume attempt already exists");
  await source.backup(process.env.TELECODEX_BACKUP);
} finally { source.close(); }
await chmod(process.env.TELECODEX_BACKUP, 0o600);
NODE
sha256sum "$TELECODEX_BACKUP"
stat -c '%a %s %n' "$TELECODEX_BACKUP"
```

Open the backup read-only and repeat `quick_check`, foreign-key, schema, and zero-resume assertions.

- [ ] **Step 3: Invoke the authenticated action exactly once**

Create a private marker with mode `0600` before the request. The operator helper must refuse to run if the marker already exists. Resolve the action URL and expected version only in memory, submit one POST with body `{"expectedVersion":<resolved>}`, and print only:

```json
{"attempts":1,"http":200,"ok":true}
```

On timeout, disconnect, cancellation, or unreadable response, leave the marker and stop without repeating the POST. Do not restore the backup.

- [ ] **Step 4: Follow only durable states**

Poll bounded aggregates without identifiers or content until one of these states:

- `complete`: verify the success contract in Step 5;
- `failed`: report only its bounded reason code and stop without retry;
- `reopen_unknown`: allow only the runtime's nondestructive probe, never reopen manually or automatically a second time;
- `probe_retry_wait` or `reopen_retry_wait`: wait only until the stored Telegram deadline, then let the registered scheduler perform the one allowed retry;
- `delivery_handoff`: let the outbox handle its durable pending/sending evidence; never call delivery manually.

If the service restarts, require inherited `reopen_in_flight` to become `reopen_unknown` before any Telegram call. Never repeat the operator action.

- [ ] **Step 5: Verify successful completion**

Resolve the target internally from the private backup and require this aggregate report:

```json
{"resume":"complete","priorRecovery":"failed","failed":0,"pending":0,"sending":0,"uncertain":0,"delivered":3,"anchorKnown":1,"terminalCompleted":1,"sameBinding":1,"quickCheck":"ok","foreignKeys":0,"quarantine":0}
```

Also require the original destination in every primary and rich fallback payload, the same Codex thread binding, one resume row, one unchanged failed recovery row, stable service PID and restart count, and no second reopen request. Do not print any compared value.

- [ ] **Step 6: Observe twenty post-action snapshots**

Take twenty snapshots at 30-second intervals. Require health and readiness OK, stable PID and restart count, zero sending, uncertain, or quarantined rows, no new 429 loop, and no background, uncaught, or unhandled error. A completed resume row and the historical failed recovery row must remain stable.

## Rollback and stop rules

- Before 06.2a acceptance, schema v8 may return to v7 only when `topic_resume_attempts` is empty, service is stopped, integrity checks pass, and the drop occurs in one immediate transaction. Restore the saved 06.1 code trees afterward.
- After 06.2a acceptance, v8 is the rollback floor. Later code rollback must keep the live v8 database.
- Before 06.4, code-only rollback is allowed only with zero resume rows and no external resume request.
- After 06.4 starts, never restore an older database, delete or rewrite either saga row, repeat the POST, repeat an ambiguous reopen, repeat an uncertain send, create a replacement topic, or release followers manually.
- Stop on candidate count other than one, version conflict, active turn, sending or uncertain delivery before the action, Guardian failure, quarantine growth, schema mismatch, SQLite integrity failure, unstable PID, restart, unexpected journal error, or unclassified Telegram result.

