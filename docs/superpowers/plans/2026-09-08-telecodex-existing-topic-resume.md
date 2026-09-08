# TeleCodex Existing Topic Resume Roadmap and Release Gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate the deployable plans that safely resume the one historical response plan in its original Telegram topic.

**Architecture:** A typed nondestructive probe distinguishes live, closed, and missing topics. A separate schema-v8 resume saga records probe, reopen, and delivery-handoff boundaries, while the existing delivery outbox remains the only message sender. Every code slice is installed with the action disabled first; the operator-facing action is enabled only after the live candidate count is exactly one.

**Tech Stack:** TypeScript 5.9, Node.js 20+, better-sqlite3, grammY 1.45, Vitest 3, Svelte 5, systemd, curl, rsync.

---

## Boundaries

- Design: `docs/superpowers/specs/2026-09-08-telecodex-existing-topic-resume-design.md`.
- Repository: `/root/Documents/Codex/2026-08-07-hermes/telecodex`.
- Branch: `telecodex-improvements`. Preserve unrelated tracked and ignored state.
- Read every target file before editing it and use `apply_patch` for source changes.
- Use `TMPDIR=/var/tmp` for tests and builds. Never build directly over live `dist` or `dist-web`.
- Never print job, user, chat, topic, message, thread, payload, title, token, callback token, or response content. Print aggregate counts and bounded reason codes only.
- Do not create a topic, rebind a topic, regenerate a Codex response, release follower parts manually, restore an old live database, or repeat an ambiguous Telegram action.
- Commit each code microrelease after its full verification. Do not push, merge, or open a PR.
- Install and observe each microrelease before starting the next one.

## Deployable checkpoints

| Checkpoint | Change | Live reachability |
| --- | --- | --- |
| 06.1 | Typed liveness classification with boolean compatibility | Existing behavior only |
| 06.2a | Pure resume eligibility and schema-v8 ledger | No runtime caller |
| 06.2b | Resume runtime and dedicated Telegram API | Default-off flag |
| 06.3a | Dashboard, callback, and HTTP action wiring | Flag remains off |
| 06.3b | Enable action after exact live preflight | One action, not invoked |
| 06.4 | Invoke the historical action once | One guarded external operation |

## File map

- Modify `src/telegram-topic-liveness.ts` and `test/telegram-topic-liveness.test.ts` for the typed liveness primitive and boolean adapter.
- Create `src/telegram-topic-resume.ts` and `test/telegram-topic-resume.test.ts` for the pure eligibility contract.
- Create `src/telegram-topic-resume-ledger.ts` and `test/telegram-topic-resume-ledger.test.ts` for schema-v8 saga state and compare-and-swap transitions.
- Modify `src/telegram-job-ledger-schema.ts`, `src/telegram-job-ledger.ts`, and related SQLite tests for schema v8, store methods, read-only inspection, and retention.
- Create `src/telegram-topic-resume-api.ts`, `src/telegram-topic-resume-adapter.ts`, `src/telegram-topic-resume-runtime.ts`, and their focused tests for one-shot reopen and outbox handoff.
- Modify `src/config.ts`, `.env.example`, `src/index.ts`, and `src/telegram-reliability-runtime.ts` to compose the runtime behind `TELEGRAM_TOPIC_RESUME_ENABLED=false`.
- Modify `src/telegram-status-projection.ts`, `src/telegram-grammy-transport.ts`, `src/status-board-render.ts`, `src/bot.ts`, and `src/mini-app-server.ts` for the versioned `resume_existing_topic` action.
- Modify the matching tests under `test/` for projection, transport, callback parsing, HTTP allowlisting, runtime routing, and restart reconciliation.

## Shared code verification gate

- [ ] **Step 1: Run the checkpoint's focused RED and GREEN commands**

Use the exact focused commands listed in that checkpoint. A new behavior must first fail for the stated reason, then pass after the minimal implementation.

- [ ] **Step 2: Run the full repository gate**

```bash
set -euo pipefail
cd /root/Documents/Codex/2026-08-07-hermes/telecodex
TMPDIR=/var/tmp npm test
TMPDIR=/var/tmp npm run check:web
TMPDIR=/var/tmp npx tsc --noEmit
git diff --check
```

Expected: every Vitest file passes, Svelte reports 0 errors and 0 warnings, TypeScript exits 0, and `git diff --check` prints nothing.

- [ ] **Step 3: Review the checkpoint before committing**

Invoke `requesting-code-review`. Check the diff specifically for repeated external calls, stale-version gaps, broad error substring matching, payload logging, and writes outside an immediate transaction. Resolve every actionable finding and rerun Step 2.

- [ ] **Step 4: Commit only the checkpoint files**

Use the commit subject specified in the checkpoint. Do not include private release state, live database files, `.env`, `dist`, `dist-web`, or unrelated changes.

## Shared installation and observation gate

- [ ] **Step 1: Build a private candidate and save the live code trees**

```bash
set -euo pipefail
: "${TELECODEX_RELEASE_TAG:?missing release tag}"
TELECODEX_RELEASE_ROOT=.telecodex/release-state/existing-topic-resume
install -d -m 0700 "$TELECODEX_RELEASE_ROOT"
TELECODEX_STAGE=$(mktemp -d "$TELECODEX_RELEASE_ROOT/${TELECODEX_RELEASE_TAG}-stage.XXXXXX")
TELECODEX_ROLLBACK=$(mktemp -d "$TELECODEX_RELEASE_ROOT/${TELECODEX_RELEASE_TAG}-rollback.XXXXXX")
TELECODEX_STAGE_ABS=$(realpath "$TELECODEX_STAGE")
TMPDIR=/var/tmp npx --no-install tsc --outDir "$TELECODEX_STAGE_ABS/dist"
TMPDIR=/var/tmp npx --no-install vite build --config web/vite.config.ts \
  --outDir "$TELECODEX_STAGE_ABS/dist-web"
cp -a dist "$TELECODEX_ROLLBACK/dist"
cp -a dist-web "$TELECODEX_ROLLBACK/dist-web"
find "$TELECODEX_STAGE/dist" "$TELECODEX_STAGE/dist-web" -type f -print0 \
  | sort -z | xargs -0 sha256sum > "$TELECODEX_STAGE/SHA256SUMS"
chmod 0600 "$TELECODEX_STAGE/SHA256SUMS"
```

- [ ] **Step 2: Prove an idle restart boundary**

```bash
set -euo pipefail
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

- [ ] **Step 3: Install and restart**

```bash
set -euo pipefail
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

- [ ] **Step 4: Observe twenty bounded snapshots**

Record the installation timestamp, PID, and restart count. At 30-second intervals, take twenty snapshots. Each must show health and readiness OK, the same PID and restart count, `sending=0`, `uncertain=0`, `quarantine=0`, and no new 429 loop, background error, uncaught error, or unhandled rejection. Query only aggregate SQLite counts and aggregate journal match counts. Update the user at least once per minute.

Stop and restore only the saved code trees if a code-only checkpoint fails before any resume row or external resume request exists. Never restore the database after a reopen or delivery request is confirmed or ambiguous.

## Execution order

1. Execute `docs/superpowers/plans/2026-09-08-telecodex-existing-topic-resume-core.md` through 06.2b.
2. Execute `docs/superpowers/plans/2026-09-08-telecodex-existing-topic-resume-activation.md` through 06.4.
3. After every checkpoint, return here for the shared code, installation, and twenty-snapshot gates.

