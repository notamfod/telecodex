# TeleCodex Missing Topic Job Recovery Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this operational plan checkpoint-by-checkpoint. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install microreleases 05.1 through 05.4 safely, then run the one historical missing-topic recovery as 05.5.

**Architecture:** Every candidate is built outside the live trees and installed only at a proven idle boundary. The live action follows a fresh SQLite backup and never repeats after an ambiguous Telegram result.

**Tech Stack:** Bash, Node.js, better-sqlite3, Vitest, Svelte, systemd, curl, rsync.

---

## Shared verification and release gate

- [ ] **Step 1: Run the task's focused command, then the full gate**

```bash
set -euo pipefail
cd /root/Documents/Codex/2026-08-07-hermes/telecodex
TMPDIR=/var/tmp npm test
TMPDIR=/var/tmp npm run check:web
TMPDIR=/var/tmp npx tsc --noEmit
git diff --check
```

Expected: all Vitest files pass, Svelte reports 0 errors and 0 warnings,
TypeScript exits 0, and diff check prints nothing.

- [ ] **Step 2: Build a private candidate and save rollback trees**

```bash
set -euo pipefail
: "${TELECODEX_RELEASE_TAG:?missing release tag}"
TELECODEX_RELEASE_ROOT=.telecodex/release-state/missing-topic-recovery
install -d -m 0700 "$TELECODEX_RELEASE_ROOT"
TELECODEX_STAGE=$(mktemp -d "$TELECODEX_RELEASE_ROOT/${TELECODEX_RELEASE_TAG}-stage.XXXXXX")
TELECODEX_ROLLBACK=$(mktemp -d "$TELECODEX_RELEASE_ROOT/${TELECODEX_RELEASE_TAG}-rollback.XXXXXX")
TELECODEX_STAGE_ABS=$(realpath "$TELECODEX_STAGE")
TMPDIR=/var/tmp npx --no-install tsc --outDir "$TELECODEX_STAGE_ABS/dist"
TMPDIR=/var/tmp npx --no-install vite build --config web/vite.config.ts --outDir "$TELECODEX_STAGE_ABS/dist-web"
cp -a dist "$TELECODEX_ROLLBACK/dist"
cp -a dist-web "$TELECODEX_ROLLBACK/dist-web"
find "$TELECODEX_STAGE/dist" "$TELECODEX_STAGE/dist-web" -type f -print0 \
  | sort -z | xargs -0 sha256sum > "$TELECODEX_STAGE/SHA256SUMS"
chmod 0600 "$TELECODEX_STAGE/SHA256SUMS"
```

- [ ] **Step 3: Prove the controlled restart boundary**

```bash
PREFLIGHT_CODE=0
PREFLIGHT_JSON=$(node dist/telecodex-release-cli.js preflight --json) || PREFLIGHT_CODE=$?
export PREFLIGHT_CODE PREFLIGHT_JSON
node --input-type=module <<'NODE'
const code = Number(process.env.PREFLIGHT_CODE);
const report = JSON.parse(process.env.PREFLIGHT_JSON ?? "null");
if (code !== 0 && code !== 2) throw new Error("Preflight invocation failed");
if (report.guardian !== "ready") throw new Error("Guardian is not ready");
if (report.jobs.running !== 0) throw new Error("A TeleCodex turn is active");
if (report.deliveries.sending !== 0) throw new Error("A delivery is sending");
if (report.deliveries.uncertain !== 0) throw new Error("A delivery is uncertain");
if (report.reasons.some((reason) => reason !== "DELIVERY_PENDING")) {
  throw new Error("Unexpected preflight reason");
}
NODE
```

- [ ] **Step 4: Install and start the candidate**

```bash
BEFORE_RESTARTS=$(systemctl show telecodex.service -p NRestarts --value)
systemctl stop telecodex.service
test "$(systemctl is-active telecodex.service || true)" = "inactive"
rsync -a --delete "$TELECODEX_STAGE/dist/" dist/
rsync -a --delete "$TELECODEX_STAGE/dist-web/" dist-web/
systemctl start telecodex.service
test "$(systemctl is-active telecodex.service)" = "active"
for attempt in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null \
    && curl -fsS http://127.0.0.1:8787/readyz >/dev/null && break
  test "$attempt" -lt 30
  sleep 1
done
test "$(systemctl show telecodex.service -p NRestarts --value)" = "$BEFORE_RESTARTS"
```

- [ ] **Step 5: Observe the installed microrelease**

Take twenty snapshots at 30-second intervals. Each must show health and
readiness OK, stable PID and restart count, `sending=0`, `uncertain=0`,
`quarantine=0`, and no new 429 loop, background error, uncaught error, or
unhandled rejection. Update the user at least once per minute.

Repeat Steps 1 through 5 once for each literal tag, and never combine tags:

```bash
export TELECODEX_RELEASE_TAG=05.1-eligibility
export TELECODEX_RELEASE_TAG=05.2-ledger
export TELECODEX_RELEASE_TAG=05.3-runtime-disabled
export TELECODEX_RELEASE_TAG=05.4-dashboard-action
```

## Task 5: Microrelease 05.5, recover the historical job once

**Files:**
- Read: `.telecodex/jobs.sqlite`
- Create: `.telecodex/release-state/missing-topic-recovery/jobs-before-topic-recovery-YYYYMMDDTHHMMSSZ.sqlite`
- Modify externally: one Telegram forum topic and the exact historical job through the authenticated action

- [ ] **Step 1: Reconfirm the bounded predicate**

Use one read-only better-sqlite3 process. Resolve the target ID internally and
print only:

```json
{"eligible":1,"failedAnchors":1,"pendingFollowers":2,"sending":0,"uncertain":0,"activeTurns":0,"recoveries":0,"quarantine":0}
```

Require its current version to equal the version in the freshly loaded
Dashboard action. Do not print either value.

- [ ] **Step 2: Create and verify an online backup**

```bash
set -euo pipefail
install -d -m 0700 .telecodex/release-state/missing-topic-recovery
TELECODEX_BACKUP=.telecodex/release-state/missing-topic-recovery/jobs-before-topic-recovery-$(date -u +%Y%m%dT%H%M%SZ).sqlite
export TELECODEX_BACKUP
node --input-type=module <<'NODE'
import { chmod } from "node:fs/promises";
import Database from "better-sqlite3";
const db = new Database(".telecodex/jobs.sqlite", { readonly: true, fileMustExist: true });
try {
  if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("quick_check failed");
  await db.backup(process.env.TELECODEX_BACKUP);
} finally { db.close(); }
await chmod(process.env.TELECODEX_BACKUP, 0o600);
NODE
sha256sum "$TELECODEX_BACKUP"
stat -c '%a %s %n' "$TELECODEX_BACKUP"
```

- [ ] **Step 3: Invoke the authenticated action exactly once**

Refresh Dashboard immediately before the call and submit its
`recover_missing_topic` action once. Require HTTP 200 with `{ "ok": true }`.
On timeout, disconnect, or unreadable output, stop without retrying.

- [ ] **Step 4: Verify the target without printing identifiers**

Resolve the target internally from the backup and require this live report:

```json
{"recovery":"complete","failed":0,"pending":0,"sending":0,"uncertain":0,"delivered":3,"anchorKnown":1,"terminalCompleted":1,"newBinding":1,"oldBinding":0,"quickCheck":"ok","foreignKeys":0,"quarantine":0}
```

For `retry_wait`, observe only until the stored deadline and scheduler result.
For `unknown` or `failed`, stop. Do not retry, restore the backup, or release
followers manually.

- [ ] **Step 5: Complete final operational verification**

Run preflight twice and require equal counts, `safeToRestart=true`, no reasons,
Guardian ready, no running job, and no pending/sending/uncertain delivery.
Repeat the twenty-snapshot observation. Build a fresh server and web stage,
compare its hashes with the installed trees, and invoke
`verification-before-completion` before reporting success.

## Acceptance, stop, and rollback rules

Stop on any active turn, sending or uncertain delivery, Guardian failure,
quarantine growth, schema mismatch, candidate count other than one, version
conflict, ambiguous Telegram result, unstable PID, restart, probe failure, or
unexpected journal error.

Before topic creation, restore only the saved code trees. After topic creation
is confirmed or ambiguous, keep the live SQLite database and never repeat the
action. Any later code rollback must preserve that database and must not make
reconciliation repeat external work.
