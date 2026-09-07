# TeleCodex Missing Status Anchor Recovery Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this operational plan checkpoint-by-checkpoint. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install each missing-anchor microrelease safely, then recover and verify the one historical blocked response plan.

**Architecture:** Every candidate is built outside live trees, installed only at a proven idle delivery boundary, and retained with a complete code rollback. The historical Retry uses the authenticated versioned Dashboard action after a fresh online SQLite backup and is verified only with bounded aggregates.

**Tech Stack:** Bash, Node.js, better-sqlite3, Vitest, systemd, curl, rsync.

---

## Boundaries

- Implementation plan: `docs/superpowers/plans/2026-09-04-telecodex-missing-status-anchor-recovery.md`.
- Use `TMPDIR=/var/tmp`; never build into live `dist` or `dist-web` before acceptance.
- Do not expose live job/message IDs or message content in terminal output.
- Do not commit, push, merge, or create a PR.
- Keep the current SQLite after any confirmed or uncertain Telegram send.

### Task 1: Verify and install one microrelease

**Files:**
- Inspect: source and tests listed by the current implementation task
- Create: private candidate and rollback directories under `.telecodex/release-state/missing-status-anchor/`
- Replace: live `dist/` and `dist-web/` only after the idle gate passes

- [ ] **Step 1: Run the focused test and full gate**

Run the focused command from the implementation task, then:

```bash
set -euo pipefail
cd /root/Documents/Codex/2026-08-07-hermes/telecodex
TMPDIR=/var/tmp npm test
TMPDIR=/var/tmp npm run check:web
git diff --check
```

Expected: all Vitest files pass, Svelte reports 0 errors and 0 warnings, and diff check prints nothing. Both builds run only into the private candidate directories in Step 3.

- [ ] **Step 2: Export the task's literal microrelease tag**

Use exactly one command matching the completed implementation task:

```bash
export TELECODEX_RELEASE_TAG=01-classifier
export TELECODEX_RELEASE_TAG=02-ledger
export TELECODEX_RELEASE_TAG=03-live-recovery
export TELECODEX_RELEASE_TAG=04-outbox-recovery
```

Execute only one of these four exports for a checkpoint.

- [ ] **Step 3: Build a private candidate and save the current release**

```bash
set -euo pipefail
cd /root/Documents/Codex/2026-08-07-hermes/telecodex
: "${TELECODEX_RELEASE_TAG:?missing microrelease tag}"
TELECODEX_RELEASE_ROOT=.telecodex/release-state/missing-status-anchor
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

- [ ] **Step 4: Prove the restart boundary**

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
const allowed = report.reasons.length === 0
  || (report.reasons.length === 1 && report.reasons[0] === "DELIVERY_PENDING");
if (!allowed) throw new Error("Unexpected preflight reason");
NODE
```

Expected before historical recovery: exit code 2 with only `DELIVERY_PENDING`. Expected afterward: exit code 0 and no reasons.

- [ ] **Step 5: Install complete trees and probe**

```bash
BEFORE_RESTARTS=$(systemctl show telecodex.service -p NRestarts --value)
test "$(systemctl show telecodex.service -p MainPID --value)" -gt 0
systemctl stop telecodex.service
test "$(systemctl is-active telecodex.service || true)" = "inactive"
rsync -a --delete "$TELECODEX_STAGE/dist/" dist/
rsync -a --delete "$TELECODEX_STAGE/dist-web/" dist-web/
systemctl start telecodex.service
test "$(systemctl is-active telecodex.service)" = "active"
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz | node -e '
    let v="";process.stdin.on("data",c=>v+=c).on("end",()=>{if(JSON.parse(v).status!=="ok")process.exit(1)});' \
    && curl -fsS http://127.0.0.1:8787/readyz | node -e '
    let v="";process.stdin.on("data",c=>v+=c).on("end",()=>{if(JSON.parse(v).status!=="ok")process.exit(1)});'; then
    break
  fi
  test "$attempt" -lt 30
  sleep 1
done
test "$(systemctl show telecodex.service -p NRestarts --value)" = "$BEFORE_RESTARTS"
printf 'stage=%s\nrollback=%s\n' "$TELECODEX_STAGE" "$TELECODEX_ROLLBACK"
```

- [ ] **Step 6: Observe for ten minutes**

Record `OBSERVED_FROM=$(date --iso-8601=seconds)`, PID, and restart count. Twenty times at 30-second spacing, run health/readiness, `systemctl show`, and a read-only SQLite count for `sending` plus `job_quarantine`. Reduce journal output since `OBSERVED_FROM` to counts for `429`, `background error`, `uncaught`, and `unhandled`; never print raw matching lines. Post a user update at least once per minute.

Use these bounded checks for each snapshot and cumulative journal sample:

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
systemctl show telecodex.service -p ActiveState -p SubState -p MainPID -p NRestarts --no-pager
node --input-type=module <<'NODE'
import Database from "better-sqlite3";
const db = new Database(".telecodex/jobs.sqlite", { readonly: true, fileMustExist: true });
const sending = db.prepare("SELECT count(*) count FROM deliveries WHERE state='sending'").get().count;
const quarantine = db.prepare("SELECT count(*) count FROM job_quarantine").get().count;
db.close();
console.log(JSON.stringify({ sending, quarantine }));
NODE
journalctl -u telecodex.service --since "$OBSERVED_FROM" --no-pager | node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const n=p=>(s.match(p)||[]).length;
console.log(JSON.stringify({rate429:n(/429/g),background:n(/background error/gi),
uncaught:n(/uncaught/gi),unhandled:n(/unhandled/gi)}))});'
```

Expected on all snapshots: active/running, stable PID and restart count, both probes OK, all six error/state counts zero.

- [ ] **Step 7: Roll back code if the candidate fails before a Telegram replacement send**

```bash
systemctl stop telecodex.service
test "$(systemctl is-active telecodex.service || true)" = "inactive"
rsync -a --delete "$TELECODEX_ROLLBACK/dist/" dist/
rsync -a --delete "$TELECODEX_ROLLBACK/dist-web/" dist-web/
systemctl start telecodex.service
test "$(systemctl is-active telecodex.service)" = "active"
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```

Do not use this SQLite-independent rollback after an accepted or uncertain replacement send unless the current database is retained.

### Task 2: Recover the historical response plan

**Files:**
- Inspect: `.telecodex/jobs.sqlite`
- Create: one private online backup under `.telecodex/release-state/missing-status-anchor/`
- Modify: none directly; the authenticated Dashboard action performs the ledger transition

- [ ] **Step 1: Reconfirm the exact bounded predicate**

Run a read-only better-sqlite3 query with this target CTE and output counts only:

```sql
WITH target AS (
  SELECT a.job_id
  FROM deliveries a
  JOIN jobs j ON j.id = a.job_id
  JOIN status_anchor_plans p ON p.job_id = a.job_id
  WHERE a.part_key = 'status-anchor' AND a.kind = 'status-anchor' AND a.ordinal = 0
    AND a.state = 'failed' AND a.telegram_message_id IS NOT NULL
    AND a.last_error_code = 'telegram_status_edit_failed'
    AND json_valid(a.payload_json)
    AND json_extract(a.payload_json, '$.operation') = 'edit_text'
    AND a.payload_json = p.payload_json AND a.content_hash = p.content_hash
    AND json_valid(j.projection_json)
    AND json_extract(j.projection_json, '$.phase') = 'delivering'
    AND (SELECT count(*) FROM deliveries f
      WHERE f.job_id = a.job_id AND f.kind = 'final' AND f.state = 'pending') = 1
    AND (SELECT count(*) FROM deliveries n
      WHERE n.job_id = a.job_id AND n.kind = 'notice' AND n.state = 'pending') = 1
)
SELECT
  (SELECT count(*) FROM target) AS matchingFailedAnchors,
  (SELECT count(*) FROM deliveries d JOIN target t ON t.job_id = d.job_id
    WHERE d.part_key != 'status-anchor' AND d.state = 'pending') AS pendingFollowers,
  (SELECT count(*) FROM deliveries WHERE state = 'sending') AS sending,
  (SELECT count(*) FROM jobs WHERE json_valid(projection_json)
    AND json_extract(projection_json, '$.phase') = 'running') AS activeTurns,
  (SELECT count(*) FROM job_quarantine) AS quarantine;
```

Require exactly `1,2,0,0,0`. Do not select or print `target.job_id`.

- [ ] **Step 2: Create and verify a fresh online backup**

```bash
set -euo pipefail
cd /root/Documents/Codex/2026-08-07-hermes/telecodex
install -d -m 0700 .telecodex/release-state/missing-status-anchor
TELECODEX_BACKUP=.telecodex/release-state/missing-status-anchor/jobs-before-recovery-$(date -u +%Y%m%dT%H%M%SZ).sqlite
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

Record only path, SHA-256, size, and mode.

- [ ] **Step 3: Execute one versioned Dashboard Retry**

Refresh the pinned TeleCodex Dashboard once. On the only card whose failed part is `status-anchor`, press `Retry delivery` exactly once. If the call times out or its result is unclear, do not press again.

- [ ] **Step 4: Verify the exact plan without exposing its ID**

Open the backup and live databases in one read-only Node process. Select the single target ID internally from the backup using Step 1's predicate, bind it to live aggregate queries, and print only:

```json
{"failed":0,"pending":0,"sending":0,"uncertain":0,"delivered":3,"anchorKnown":1,"terminalCompleted":1,"quickCheck":"ok","foreignKeys":0,"quarantine":0}
```

Use:

```bash
: "${TELECODEX_BACKUP:?missing verified backup path}"
export TELECODEX_BACKUP
node --input-type=module <<'NODE'
import Database from "better-sqlite3";
const backup = new Database(process.env.TELECODEX_BACKUP, { readonly: true, fileMustExist: true });
const live = new Database(".telecodex/jobs.sqlite", { readonly: true, fileMustExist: true });
const target = backup.prepare(`SELECT a.job_id id FROM deliveries a
  JOIN jobs j ON j.id=a.job_id JOIN status_anchor_plans p ON p.job_id=a.job_id
  WHERE a.part_key='status-anchor' AND a.kind='status-anchor' AND a.ordinal=0
    AND a.state='failed' AND a.telegram_message_id IS NOT NULL
    AND a.last_error_code='telegram_status_edit_failed'
    AND json_valid(a.payload_json) AND json_extract(a.payload_json,'$.operation')='edit_text'
    AND a.payload_json=p.payload_json AND a.content_hash=p.content_hash
    AND json_valid(j.projection_json) AND json_extract(j.projection_json,'$.phase')='delivering'
    AND (SELECT count(*) FROM deliveries f WHERE f.job_id=a.job_id
      AND f.kind='final' AND f.state='pending')=1
    AND (SELECT count(*) FROM deliveries n WHERE n.job_id=a.job_id
      AND n.kind='notice' AND n.state='pending')=1`).all();
if (target.length !== 1) throw new Error("Historical recovery target changed");
const id = target[0].id;
const states = live.prepare(`SELECT
  sum(state='failed') failed, sum(state='pending') pending, sum(state='sending') sending,
  sum(state='uncertain') uncertain, sum(state='delivered') delivered,
  sum(part_key='status-anchor' AND telegram_message_id IS NOT NULL) anchorKnown
  FROM deliveries WHERE job_id=?`).get(id);
const job = live.prepare(`SELECT (json_extract(projection_json,'$.phase')='terminal'
  AND json_extract(projection_json,'$.outcome')='completed') terminalCompleted
  FROM jobs WHERE id=?`).get(id);
const report = {
  ...states,
  terminalCompleted: job?.terminalCompleted ?? 0,
  quickCheck: live.pragma("quick_check", { simple: true }),
  foreignKeys: live.pragma("foreign_key_check").length,
  quarantine: live.prepare("SELECT count(*) count FROM job_quarantine").get().count,
};
backup.close(); live.close();
console.log(JSON.stringify(report));
NODE
```

Run `node dist/telecodex-release-cli.js preflight --json` twice. Require `safeToRestart=true`, equal bounded counts, and no `DELIVERY_PENDING`.

- [ ] **Step 5: Observe and complete**

Repeat Task 1 Step 6 for ten minutes. Also require no new failed/uncertain delivery, Guardian ready/app-server connected, and unchanged historical legacy-delivery hash.

Invoke `verification-before-completion`. Re-run the full test/check/build/diff gate from a fresh stage and compare the installed `dist` and `dist-web` tree hashes with the accepted `04-outbox-recovery` stage.

## Mutation and rollback boundaries

- Before Dashboard Retry, code rollback is permitted and SQLite stays untouched.
- After a confirmed replacement send, keep live SQLite; restoring the backup could cause a duplicate.
- After an uncertain replacement send, stop and inspect manually. Never retry, restore the backup, or release followers.
- On 429, keep the row pending until its stored deadline.
- On any other 4xx, keep the anchor failed and followers blocked.
