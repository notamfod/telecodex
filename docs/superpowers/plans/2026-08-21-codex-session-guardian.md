# Codex Session Guardian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone daemon that detects stalled root Codex sessions across all clients, asks for confirmation in Telegram, and repairs only the exact confirmed turn.

**Architecture:** A separate TypeScript systemd process connects to the shared app-server control socket, persists observation and alert state in SQLite, and sends Telegram alerts without polling for updates. TeleCodex remains the sole Telegram update consumer and forwards authorized repair callbacks to the guardian over a local Unix socket. A local CLI and registered Codex skill expose the same guarded inspection and repair operations.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest, `ws`, `better-sqlite3`, grammY Bot API, Unix sockets, systemd.

---

## Execution constraints

- Repository: `/root/Documents/Codex/2026-08-07-hermes/telecodex`.
- The current `telecodex-improvements` checkout contains extensive unrelated and overlapping WIP. Do not reset, discard, bulk-format, or overwrite it.
- Before edits, use `using-git-worktrees` to assess isolation. If a worktree cannot contain the current uncommitted app-server and bot changes without copying unrelated WIP, stay in the current checkout and limit edits to the files listed here.
- Do not create commits unless the user explicitly authorizes them. Each task ends with a diff checkpoint instead of a commit.
- Never print or commit `.env`, Telegram tokens, API keys, conversation text, or tool output.
- Use TDD for each behavior change. Run the focused test in RED, implement the minimum behavior, then rerun it in GREEN.
- The first live deployment remains observation-only. Repair is enabled only after real alerts have been reviewed.

## File map

- `src/session-guardian-types.ts`: app-server thread normalization, fingerprints, alerts, and public result types.
- `src/session-guardian-app-server.ts`: paginated app-server reads, deadlines, exact-turn interrupt, and cold reload primitives.
- `src/session-guardian-store.ts`: SQLite schema and idempotent observation/alert/repair persistence.
- `src/session-guardian-detector.ts`: root-thread filtering and two-observation stale detection.
- `src/session-guardian-recovery.ts`: guarded recovery state machine.
- `src/session-guardian-routing.ts`: thread-to-Telegram-topic routing from persisted TeleCodex contexts.
- `src/session-guardian-telegram.ts`: safe alert send/edit rendering.
- `src/session-guardian-ipc.ts`: Unix-socket server and client for alert confirmation.
- `src/session-guardian-service.ts`: scan loop, backoff, alert delivery, and lifecycle.
- `src/session-guardian-config.ts`: guardian-only environment parsing.
- `src/session-guardian.ts`: daemon entrypoint.
- `src/session-guardian-cli.ts`: `status`, `scan`, `inspect`, and `repair` commands.
- `src/guardian-bot-adapter.ts`: focused TeleCodex callback registration.
- `src/config.ts`: optional guardian socket for the Telegram adapter.
- `src/bot.ts`: register the guardian callback after the global authorization middleware.
- `src/index.ts`: close the guardian callback client during shutdown if needed.
- `systemd/codex-session-guardian.service`: standalone production unit.
- `.env.example`: non-secret guardian settings.
- `package.json`, `package-lock.json`: daemon scripts and required SQLite dependency.
- `skills/codex-session-repair/SKILL.md`: tracked source for the registered skill.
- `skills/codex-session-repair/scripts/codex-session-repair`: deterministic CLI wrapper.
- `test/session-guardian-*.test.ts`: focused unit and integration coverage.
- `test/guardian-bot-adapter.test.ts`: callback authorization and rendering boundary.
- `test/config.test.ts`: optional socket configuration.

### Task 1: Define normalized thread state and app-server gateway

**Files:**
- Create: `src/session-guardian-types.ts`
- Create: `src/session-guardian-app-server.ts`
- Create: `test/session-guardian-app-server.test.ts`
- Reuse: `src/app-server-client.ts`

- [ ] **Step 1: Write failing tests for pagination, root filtering inputs, deadlines, and exact RPC calls**

Use a fake client with `request` and `close` spies. Assert that two `thread/list` pages are combined, `thread/read` returns a normalized snapshot, timeout closes the client, and repair primitives send these exact calls:

```ts
expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
  threadId: THREAD_ID,
  turnId: TURN_ID,
});
expect(methods).toEqual([
  "thread/read",
  "turn/interrupt",
  "thread/read",
  "thread/archive",
  "thread/unarchive",
  "thread/resume",
  "thread/read",
]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/session-guardian-app-server.test.ts`

Expected: FAIL because `SessionGuardianAppServer` and the normalized types do not exist.

- [ ] **Step 3: Add the domain types and fingerprint function**

Define these public contracts exactly:

```ts
export interface GuardianThreadSnapshot {
  threadId: string;
  turnId: string | null;
  threadStatus: "active" | "idle" | "notLoaded" | "systemError";
  turnStatus: string | null;
  updatedAt: number;
  itemCount: number;
  lastItemType: string | null;
  source: unknown;
  cwd: string;
  name: string | null;
  canAcceptDirectInput: boolean;
  root: boolean;
}

export interface GuardianFingerprint {
  threadId: string;
  turnId: string;
  updatedAt: number;
  itemCount: number;
  lastItemType: string | null;
}

export function fingerprintOf(snapshot: GuardianThreadSnapshot): GuardianFingerprint | null {
  if (snapshot.threadStatus !== "active" || snapshot.turnStatus !== "inProgress" || !snapshot.turnId) {
    return null;
  }
  return {
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    updatedAt: snapshot.updatedAt,
    itemCount: snapshot.itemCount,
    lastItemType: snapshot.lastItemType,
  };
}
```

- [ ] **Step 4: Implement the app-server gateway**

`SessionGuardianAppServer` must expose:

```ts
listRootThreads(): Promise<GuardianThreadSnapshot[]>;
readThread(threadId: string): Promise<GuardianThreadSnapshot>;
interrupt(threadId: string, turnId: string): Promise<void>;
waitForIdle(threadId: string, timeoutMs: number): Promise<GuardianThreadSnapshot>;
coldReload(threadId: string): Promise<GuardianThreadSnapshot>;
close(): void;
```

Page with `{ limit: 100, sortKey: "updated_at", cursor }` until `nextCursor` is absent. Treat `source.subAgent` or a non-null `parentThreadId` as non-root. Wrap every request in a deadline; on timeout call `client.close()` and throw `App-server request timed out: <method>`. In `coldReload`, always attempt `thread/unarchive` after a successful archive, even if resume or read fails.

- [ ] **Step 5: Run focused tests and TypeScript build**

Run:

```bash
npx vitest run test/session-guardian-app-server.test.ts
npm run build:server
```

Expected: all focused tests pass and `tsc` exits 0.

- [ ] **Step 6: Review the task diff without committing**

Run: `git diff --check -- src/session-guardian-types.ts src/session-guardian-app-server.ts test/session-guardian-app-server.test.ts`

Expected: no whitespace errors. Do not commit without user authorization.

### Task 2: Add durable SQLite observation and alert state

**Files:**
- Create: `src/session-guardian-store.ts`
- Create: `test/session-guardian-store.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Promote `better-sqlite3` to a required runtime dependency**

Run: `npm install --save better-sqlite3@^11.0.0`

Expected: `better-sqlite3` appears under `dependencies`, not only `optionalDependencies`; no unrelated package upgrades occur.

- [ ] **Step 2: Write failing persistence and idempotency tests**

Use a temporary database. Cover reopening the store, mode-independent schema initialization, one alert per `threadId + turnId`, atomic claim of one repair attempt, terminal outcomes, and no storage of conversation content.

```ts
const first = store.upsertObservation(snapshot, fingerprint, 1_000);
const second = store.upsertObservation(snapshot, fingerprint, 61_000);
expect(first.unchangedCount).toBe(1);
expect(second.unchangedCount).toBe(2);

const alert = store.createAlert(fingerprint, route, 61_000);
expect(store.createAlert(fingerprint, route, 62_000).id).toBe(alert.id);
expect(store.claimRepair(alert.id, 63_000)).toBe(true);
expect(store.claimRepair(alert.id, 63_001)).toBe(false);
```

- [ ] **Step 3: Run the store test and verify RED**

Run: `npx vitest run test/session-guardian-store.test.ts`

Expected: FAIL because `SessionGuardianStore` does not exist.

- [ ] **Step 4: Implement schema and store API**

Use tables `observations`, `alerts`, and `repair_attempts`. Store the fingerprint as separate columns, use a unique index on `(thread_id, turn_id)`, enable WAL, set `busy_timeout`, and chmod the database to `0600` after creation.

Expose:

```ts
upsertObservation(snapshot, fingerprint, observedAt): GuardianObservation;
clearObservation(threadId: string): void;
createAlert(fingerprint, route, createdAt): GuardianAlert;
getAlert(alertId: string): GuardianAlert | undefined;
markAlert(alertId: string, state: GuardianAlertState, detail?: string): void;
claimRepair(alertId: string, startedAt: number): boolean;
finishRepair(alertId: string, outcome: GuardianRepairOutcome, detail: string, finishedAt: number): void;
listOpenAlerts(): GuardianAlert[];
close(): void;
```

Generate a 16-byte base64url alert ID with `randomBytes(16).toString("base64url")`.

- [ ] **Step 5: Run focused tests and inspect dependency changes**

Run:

```bash
npx vitest run test/session-guardian-store.test.ts
npm run build:server
git diff --check -- package.json package-lock.json src/session-guardian-store.ts test/session-guardian-store.test.ts
```

Expected: tests and build pass; lockfile changes are limited to dependency placement/resolution.

### Task 3: Implement stale detection and routing

**Files:**
- Create: `src/session-guardian-detector.ts`
- Create: `src/session-guardian-routing.ts`
- Create: `test/session-guardian-detector.test.ts`
- Create: `test/session-guardian-routing.test.ts`

- [ ] **Step 1: Write failing detector tests with a fake clock**

Cover idle, completed, subagent, changed fingerprint, first stale observation, second confirmed observation, and deduplication after daemon restart.

```ts
expect(detector.observe(activeSnapshot, 0)).toEqual({ kind: "observed" });
expect(detector.observe(activeSnapshot, 10 * 60_000)).toEqual({ kind: "suspected" });
expect(detector.observe(activeSnapshot, 11 * 60_000)).toEqual({
  kind: "alert",
  threadId: THREAD_ID,
  turnId: TURN_ID,
});
```

- [ ] **Step 2: Write failing routing tests**

Create a temporary `contexts.json`. Verify a matching thread routes to its parsed `chatId` and `messageThreadId`; missing, malformed, or unbound data routes to the configured fallback chat/topic.

- [ ] **Step 3: Run both tests and verify RED**

Run: `npx vitest run test/session-guardian-detector.test.ts test/session-guardian-routing.test.ts`

Expected: FAIL because detector and routing modules do not exist.

- [ ] **Step 4: Implement detector and routing**

The detector receives `staleAfterMs` and `confirmationsRequired`. It delegates persistence to `SessionGuardianStore`, clears observations for non-candidates, and returns one of `observed`, `suspected`, `alert`, or `cleared`.

The router must parse only this persisted shape:

```ts
interface PersistedContext {
  contextKey: string;
  threadId: string | null;
}
```

Never import or instantiate `SessionRegistry` in the guardian process because it would create app-server session objects and duplicate ownership.

- [ ] **Step 5: Run focused tests and build**

Run:

```bash
npx vitest run test/session-guardian-detector.test.ts test/session-guardian-routing.test.ts
npm run build:server
```

Expected: tests pass and `tsc` exits 0.

### Task 4: Implement the guarded recovery state machine

**Files:**
- Create: `src/session-guardian-recovery.ts`
- Create: `test/session-guardian-recovery.test.ts`

- [ ] **Step 1: Write failing state-machine tests**

Cover these exact branches:

- unknown/closed alert: no app-server mutation;
- live fingerprint changed: `self-recovered`;
- observation-only: recheck only;
- same active turn with repair disabled: `repair-disabled`;
- same active turn with repair enabled: exact interrupt, idle wait, cold reload, verification;
- interrupt timeout: no archive;
- cold reload failure: failed outcome with unarchive attempted by the gateway;
- repeated/concurrent requests: one claim and one interrupt.

```ts
expect(appServer.interrupt).toHaveBeenCalledWith(THREAD_ID, TURN_ID);
expect(appServer.coldReload).toHaveBeenCalledWith(THREAD_ID);
expect(result).toEqual(expect.objectContaining({ outcome: "restored", threadId: THREAD_ID }));
```

- [ ] **Step 2: Run the recovery test and verify RED**

Run: `npx vitest run test/session-guardian-recovery.test.ts`

Expected: FAIL because `SessionGuardianRecovery` does not exist.

- [ ] **Step 3: Implement one guarded method**

Expose:

```ts
recoverAlert(alertId: string, options: { repairEnabled: boolean }): Promise<GuardianRepairResult>;
repairThread(threadId: string, options: { repairEnabled: boolean }): Promise<GuardianRepairResult>;
```

`recoverAlert` must claim the alert before mutation. `repairThread` must validate a UUID, read the current snapshot, and use the same private comparison/recovery path. Neither method may fall back to restarting the daemon or selecting a recent thread.

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
npx vitest run test/session-guardian-recovery.test.ts
npm run build:server
```

Expected: all recovery branches pass.

### Task 5: Add Telegram alert rendering and delivery

**Files:**
- Create: `src/session-guardian-telegram.ts`
- Create: `test/session-guardian-telegram.test.ts`

- [ ] **Step 1: Write failing rendering and delivery tests**

Assert that output contains full UUID, source, cwd, stale duration, and last item type; excludes preview, prompt, response, and tool output; uses callback `guardian_restore:<alertId>`; routes through `message_thread_id`; and edits the same message for terminal outcomes.

- [ ] **Step 2: Run the Telegram test and verify RED**

Run: `npx vitest run test/session-guardian-telegram.test.ts`

Expected: FAIL because the notifier does not exist.

- [ ] **Step 3: Implement a narrow notifier interface**

```ts
export interface GuardianTelegramApi {
  sendMessage(chatId: number, text: string, options: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, options: Record<string, unknown>): Promise<unknown>;
}
```

Use HTML escaping for names and cwd. The button contains only the opaque alert ID. Retry delivery through grammY auto-retry, but let the service persist a failed delivery for the next scan.

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
npx vitest run test/session-guardian-telegram.test.ts
npm run build:server
```

Expected: tests pass and no conversation content enters the rendered alert fixture.

### Task 6: Add Unix-socket IPC and the TeleCodex callback adapter

**Files:**
- Create: `src/session-guardian-ipc.ts`
- Create: `src/guardian-bot-adapter.ts`
- Create: `test/session-guardian-ipc.test.ts`
- Create: `test/guardian-bot-adapter.test.ts`
- Modify: `src/config.ts:44-79,81-230`
- Modify: `test/config.test.ts`
- Modify: `src/bot.ts:2608-2636`

- [ ] **Step 1: Write failing IPC tests**

Use a temporary Unix socket. Verify `GET /v1/status`, `POST /v1/alerts/:id/check`, `POST /v1/alerts/:id/repair`, invalid IDs, malformed JSON, bounded client timeouts, socket mode, and cleanup on shutdown.

- [ ] **Step 2: Write failing callback tests**

Register `guardian_restore:<alertId>`. Verify the existing global middleware rejects unauthorized users before the adapter, the adapter answers `Проверяю...`, calls only `repairAlert(alertId)`, and reports restored, self-recovered, observation-only, expired, and failed outcomes without exposing stack traces.

- [ ] **Step 3: Run IPC, callback, and config tests to verify RED**

Run:

```bash
npx vitest run test/session-guardian-ipc.test.ts test/guardian-bot-adapter.test.ts test/config.test.ts
```

Expected: FAIL because the IPC modules and optional config are absent.

- [ ] **Step 4: Implement IPC server/client**

Use `node:http` with `server.listen(socketPath)`. Remove only the exact stale socket path before listening, chmod it to `0600`, cap request bodies at 4 KiB, and return JSON with a stable `outcome`, `message`, and optional `threadId`.

- [ ] **Step 5: Add optional TeleCodex configuration**

Add `sessionGuardianSocketPath?: string` to `TeleCodexConfig`, parsed from `SESSION_GUARDIAN_SOCKET_PATH`. Absence must preserve current behavior and all existing config defaults.

- [ ] **Step 6: Register the focused callback adapter**

In `createBot`, after the authorization middleware is registered, call:

```ts
if (config.sessionGuardianSocketPath) {
  registerGuardianCallbacks(bot, {
    socketPath: config.sessionGuardianSocketPath,
    requestTimeoutMs: 15_000,
  });
}
```

Do not add a second Telegram runner or polling loop.

- [ ] **Step 7: Run focused tests and build**

Run:

```bash
npx vitest run test/session-guardian-ipc.test.ts test/guardian-bot-adapter.test.ts test/config.test.ts
npm run build:server
```

Expected: tests pass; existing configuration without guardian variables remains unchanged.

### Task 7: Assemble daemon, CLI, configuration, and scan loop

**Files:**
- Create: `src/session-guardian-config.ts`
- Create: `src/session-guardian-service.ts`
- Create: `src/session-guardian.ts`
- Create: `src/session-guardian-cli.ts`
- Create: `test/session-guardian-config.test.ts`
- Create: `test/session-guardian-service.test.ts`
- Create: `test/session-guardian-cli.test.ts`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Write failing configuration tests**

Cover defaults and validation for:

```text
SESSION_GUARDIAN_APP_SERVER_SOCKET
SESSION_GUARDIAN_SOCKET_PATH
SESSION_GUARDIAN_DB_PATH
SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS
SESSION_GUARDIAN_STALE_AFTER_SECONDS
SESSION_GUARDIAN_CONFIRMATIONS
SESSION_GUARDIAN_FALLBACK_CHAT_ID
SESSION_GUARDIAN_FALLBACK_TOPIC_ID
SESSION_GUARDIAN_OBSERVATION_ONLY
SESSION_GUARDIAN_REPAIR_ENABLED
```

Reject repair enabled while observation-only is true, intervals below 10 seconds, a stale threshold shorter than two scan intervals, and incomplete fallback routing.

- [ ] **Step 2: Write failing service and CLI tests**

The service test uses fake app-server, detector, store, router, and notifier dependencies. Verify one full scan, delivery retry, no overlapping scans, backoff after disconnect, graceful shutdown, and alert status editing after recovery.

The CLI test verifies exact exit codes and JSON output for `status`, `scan`, `inspect`, `repair`, invalid UUID, and unavailable socket.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
npx vitest run test/session-guardian-config.test.ts test/session-guardian-service.test.ts test/session-guardian-cli.test.ts
```

Expected: FAIL because the daemon assembly is absent.

- [ ] **Step 4: Implement configuration and orchestration**

The service uses a condition-based loop: schedule the next scan only after the previous scan settles. On app-server failure, close the client and use backoff delays of 1, 2, 4, 8, and 30 seconds capped at 30 seconds. Reset backoff after a successful scan.

The daemon entrypoint must install `SIGINT` and `SIGTERM` handlers that stop the loop, close IPC, close app-server, close SQLite, and exit only after cleanup finishes.

Call `process.umask(0o077)` before creating the SQLite database or Unix socket so WAL and shared-memory side files cannot inherit broader permissions.

- [ ] **Step 5: Add package scripts and example configuration**

Add:

```json
"guardian": "node dist/session-guardian.js",
"guardian:cli": "node dist/session-guardian-cli.js"
```

Document the guardian variables in `.env.example` with observation-only and repair-disabled defaults. Do not add real chat IDs, topic IDs, paths containing credentials, or tokens.

- [ ] **Step 6: Run focused tests and server build**

Run:

```bash
npx vitest run test/session-guardian-config.test.ts test/session-guardian-service.test.ts test/session-guardian-cli.test.ts
npm run build:server
node dist/session-guardian-cli.js --help
```

Expected: tests pass, build exits 0, and help lists the four commands without connecting to app-server.

### Task 8: Add systemd service and registered skill

**Files:**
- Create: `systemd/codex-session-guardian.service`
- Create: `skills/codex-session-repair/SKILL.md`
- Create: `skills/codex-session-repair/scripts/codex-session-repair`
- Test: `/root/.codex/skills/.system/skill-creator/scripts/quick_validate.py`

- [ ] **Step 1: Use `skill-creator` and `writing-skills` before creating skill files**

Follow their current instructions rather than inventing metadata. Keep the skill focused on exact UUID inspection and repair through the guardian CLI.

- [ ] **Step 2: Write the service unit**

Use these security and lifecycle properties:

```ini
[Unit]
Description=Monitor and recover stalled Codex sessions
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/Documents/Codex/2026-08-07-hermes/telecodex
Environment=HOME=/root
ExecStart=/usr/bin/node /root/Documents/Codex/2026-08-07-hermes/telecodex/dist/session-guardian.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

The app-server may start before or after guardian; startup ordering is handled by reconnect backoff, not by restarting either service.

- [ ] **Step 3: Create the skill and wrapper**

The wrapper resolves the repository root explicitly and executes:

```bash
exec /usr/bin/node \
  /root/Documents/Codex/2026-08-07-hermes/telecodex/dist/session-guardian-cli.js \
  "$@"
```

The skill must require a full UUID, default to `inspect`, and call `repair` only for explicit verbs such as repair, restore, reopen, fix, `почини`, `восстанови`, or `перезагрузи`. It must never infer a recent thread.

- [ ] **Step 4: Validate and register the skill**

Run:

```bash
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/codex-session-repair
test ! -e /root/.codex/skills/codex-session-repair
cp -a skills/codex-session-repair /root/.codex/skills/codex-session-repair
test -f /root/.codex/skills/codex-session-repair/SKILL.md
```

Expected: validation passes, the target did not previously exist, and the registered `SKILL.md` is readable. Start a fresh Codex process and confirm `codex-session-repair` appears in the available skill list.

- [ ] **Step 5: Verify service and skill files without installation**

Run:

```bash
systemd-analyze verify systemd/codex-session-guardian.service
bash -n skills/codex-session-repair/scripts/codex-session-repair
git diff --check -- systemd/codex-session-guardian.service skills/codex-session-repair
```

Expected: all commands exit 0.

### Task 9: Full verification and observation-only deployment

**Files:**
- Modify runtime only after all tests pass: `/etc/systemd/system/codex-session-guardian.service`
- Modify runtime only: `.env` with non-secret guardian settings; never print or commit it
- Runtime state: `.telecodex/session-guardian.sqlite`
- Runtime socket: configured guardian socket path

- [ ] **Step 1: Inspect the final diff and preserve unrelated WIP**

Run:

```bash
git status --short
git diff --stat
git diff --check
git diff -- src/app-server-client.ts src/config.ts src/bot.ts package.json .env.example
```

Expected: guardian changes are identifiable; unrelated pre-existing changes remain present and untouched.

- [ ] **Step 2: Run all focused tests**

Run:

```bash
npx vitest run \
  test/session-guardian-app-server.test.ts \
  test/session-guardian-store.test.ts \
  test/session-guardian-detector.test.ts \
  test/session-guardian-routing.test.ts \
  test/session-guardian-recovery.test.ts \
  test/session-guardian-telegram.test.ts \
  test/session-guardian-ipc.test.ts \
  test/guardian-bot-adapter.test.ts \
  test/session-guardian-config.test.ts \
  test/session-guardian-service.test.ts \
  test/session-guardian-cli.test.ts \
  test/config.test.ts
```

Expected: zero failed tests.

- [ ] **Step 3: Run the full project verification**

Run:

```bash
npm test
npm run check:web
npm run build
```

Expected: Vitest reports zero failures, Svelte check reports zero errors, and both server and web builds exit 0.

- [ ] **Step 4: Run read-only live smoke checks before installing the service**

Start the built daemon in a temporary unified exec session with observation-only enabled and repair disabled. Wait until it reports that both IPC and app-server are ready, then run:

```bash
node dist/session-guardian-cli.js status
node dist/session-guardian-cli.js scan
node dist/session-guardian-cli.js inspect 01a02451-2fc4-76c0-9f14-c75034c10017
```

Expected: the temporary daemon and app-server are reachable, scan reports counts without mutation, and inspect returns the exact requested thread. Stop the temporary daemon cleanly before installing the unit.

- [ ] **Step 5: Install and start in observation-only mode**

Copy the verified unit to `/etc/systemd/system/codex-session-guardian.service`, add only the non-secret guardian values to the existing runtime `.env`, keep `SESSION_GUARDIAN_OBSERVATION_ONLY=true` and `SESSION_GUARDIAN_REPAIR_ENABLED=false`, then run:

```bash
systemctl daemon-reload
systemctl enable --now codex-session-guardian.service
systemctl restart telecodex.service
```

Expected: both services are active. The shared app-server daemon is not restarted.

- [ ] **Step 6: Verify runtime boundaries**

Run:

```bash
systemctl is-active codex-session-guardian.service telecodex.service
systemctl show codex-session-guardian.service -p MainPID -p NRestarts -p Result
journalctl -u codex-session-guardian.service -n 80 --no-pager
node dist/session-guardian-cli.js status
```

Expected: both services are active, guardian has zero unexpected restarts, logs contain no secrets or conversation text, IPC is reachable, and observation-only is reported.

- [ ] **Step 7: Review real alerts before enabling repair**

Observe at least one full stale threshold. Compare every alert with two fresh `thread/read` snapshots. If any healthy long-running turn is classified as stale, leave repair disabled and adjust detection tests and thresholds before deployment.

- [ ] **Step 8: Enable repair only after explicit runtime approval**

Set `SESSION_GUARDIAN_OBSERVATION_ONLY=false` and `SESSION_GUARDIAN_REPAIR_ENABLED=true`, restart only `codex-session-guardian.service`, and use one controlled stalled thread. Press `Restore`, then verify the exact thread with both `thread/resume` and CLI `codex resume <UUID>`.

Expected: the selected turn becomes interrupted, the thread becomes idle and readable, history remains present, other active threads remain untouched, and the Telegram alert is edited to `restored`.

- [ ] **Step 9: Report status without committing**

Report focused/full verification counts, build results, service PIDs/restarts, observation findings, the exact controlled thread ID, and any remaining limitation. Do not create a commit, push, or merge request unless the user explicitly requests it.
