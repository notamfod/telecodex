# TeleCodex Secret-Safe Telegram Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Telegram credentials and user data from entering TeleCodex logs while retaining bounded operational diagnostics for rate limits, topic failures, rich rejection, and ambiguous delivery.

**Architecture:** A pure `telegram-error-log` module inspects only an allowlisted error surface, sanitizes text for local classification, and emits one bounded structured line without free-form error text. Runtime callers pass that string as the only `console` argument; durable delivery classifiers remain unchanged. Three small microreleases protect the main runner first, then the remaining bot boundaries, then enforce the rule structurally.

**Tech Stack:** TypeScript 5.9, Node.js 20+, grammY 1.45, Vitest 3, systemd, existing SQLite release preflight.

---

## Boundaries

- This plan implements Step 07.0 from `docs/superpowers/specs/2026-09-10-telecodex-telegram-output-quality-cycle-design.md` only.
- Do not change Telegram delivery state transitions, retry timing, outbox payloads, schema version, or response rendering.
- Do not log identifiers, prompts, message or response text, payloads, filenames, workspace paths, or raw error objects.
- Do not read, print, copy into a command, or commit the live token; revoke and replace it before microrelease 07.0a starts in production.
- `.env` remains runtime-only, mode `0600`, and outside Git; commits, rotation, restarts, and smoke actions require separate approval at their checkpoints.
- The contained existing-topic warning replay remains terminal. Do not retry its anchor, release its followers, restore SQLite, or enable its flag.

## Microrelease 07.0a: Protect the main runner

### Task 1: Add the pure sanitizer and diagnostic model

**Files:**
- Create: `src/telegram-error-log.ts`
- Create: `test/telegram-error-log.test.ts`
- Verify: `src/telegram-rate-limit.ts`

- [ ] **Step 1: Write failing sanitizer tests**

Create table tests using synthetic values only:

```ts
const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
describe("sanitizeTelegramLogText", () => {
  it.each([
    `Network request for 'https://api.telegram.org/bot${TOKEN}/getUpdates' failed`,
    `GET https://api.telegram.org/file/bot${TOKEN}/documents/a.txt`,
    `https://user:password@example.test/path?access_token=${TOKEN}&key=value`,
    `telegram token ${TOKEN}`,
  ])("removes credentials from %s", (input) => {
    const output = sanitizeTelegramLogText(input);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toMatch(/password|access_token=123456789/i);
    expect(output).toContain("[REDACTED]");
  });
  it("removes controls and bounds Unicode output", () => {
    const output = sanitizeTelegramLogText(`safe\n\r\u0000${"😀".repeat(600)}`);
    expect(output).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(Array.from(output).length).toBeLessThanOrEqual(512);
  });
});
```

- [ ] **Step 2: Write failing hostile-error and category tests**

Use grammY-shaped plain objects, nested causes, cycles, throwing getters, and throwing `toString` values. Assert exact safe categories:

```ts
it.each([
  [{ error_code: 429, parameters: { retry_after: 24 } }, "delivery_send", "rate_limited"],
  [{ error_code: 400, description: "Bad Request: TOPIC_CLOSED" }, "topic", "topic_closed"],
  [{ error_code: 400, description: "Bad Request: message thread not found" }, "topic", "topic_missing"],
  [{ error_code: 400, description: "message to edit not found" }, "status_edit", "message_missing"],
  [{ error_code: 403, description: "Forbidden" }, "bot_handler", "forbidden"],
  [{ error_code: 400, description: "can't parse rich message" }, "rich_send", "rich_rejected"],
  [{ error_code: 400, description: "Bad Request" }, "bot_handler", "bad_request_other"],
  [new Error("fetch failed"), "status_edit", "network_retryable"],
  [new Error("fetch failed"), "delivery_send", "acceptance_unknown"],
  [new Error("local invariant"), "reliability", "internal_local"],
] as const)("classifies %j", (error, operation, category) => {
  expect(inspectTelegramErrorForLog(error, operation).category).toBe(category);
});

it("does not inspect arbitrary hostile properties", () => {
  const hostile = Object.defineProperties({}, {
    message: { get: () => { throw new Error("getter secret"); } },
    payload: { get: () => { throw new Error("must not read payload"); } },
    toString: { get: () => { throw new Error("must not stringify"); } },
  });
  expect(() => formatTelegramErrorLog("bot_handler", hostile)).not.toThrow();
  expect(formatTelegramErrorLog("bot_handler", hostile)).toBe(
    "telegram event=bot_handler category=internal_local",
  );
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-error-log.test.ts
```
Expected: FAIL because `src/telegram-error-log.ts` does not exist.

- [ ] **Step 4: Implement the public contract**

Use these exact exported types and functions:

```ts
export type TelegramLogOperation =
  | "startup" | "cleanup" | "polling" | "reliability" | "bot_handler" | "keyboard_edit"
  | "topic" | "status_send" | "status_edit" | "delivery_send" | "delivery_edit"
  | "rich_send" | "rich_edit" | "attachment_download" | "artifact_send" | "inbox" | "dashboard_store";
export type TelegramLogCategory =
  | "rate_limited" | "topic_closed" | "topic_missing" | "message_missing"
  | "forbidden" | "rich_rejected" | "bad_request_other" | "network_retryable"
  | "acceptance_unknown" | "internal_local";
export interface TelegramErrorDiagnostic {
  readonly category: TelegramLogCategory;
  readonly telegramCode?: number;
  readonly retryAfterMs?: number;
}
export function sanitizeTelegramLogText(value: string, limit = 512): string;
export function inspectTelegramErrorForLog(error: unknown, operation: TelegramLogOperation): TelegramErrorDiagnostic;
export function formatTelegramErrorLog(operation: TelegramLogOperation, error: unknown): string;
export function isTelegramPollingConflict(error: unknown): boolean;
export function isTelegramTopicNotModified(error: unknown): boolean;
```

Implementation rules: bound input before regex work; redact complete and boundary-truncated Telegram tokens, API URLs, URI userinfo, and credential queries; remove controls; then bound output in Unicode code points. Inspect only `name`, `message`, `cause`, `error`, `error_code`, `description`, and `parameters.retry_after`, with guarded reads, four-level traversal, and cycle detection. Never stringify objects.

Accept numeric Telegram codes only in `100..599`. Select one coherent code candidate and use only its own text and retry value. Without a code candidate, select one text-only rate-limit candidate using the existing `telegramRetryAfterMs` precedence. Match the existing bounded topic, message, and rich-rejection predicates exactly; do not classify generic timeout configuration as a network failure.

Emit fields in this fixed order:

```text
telegram event=<operation> category=<category> code=<integer> retryAfterMs=<integer>
```
Omit unavailable optional fields. `isTelegramPollingConflict` accepts code 409 or the current bounded `Conflict` pattern. `isTelegramTopicNotModified` checks only the bounded Telegram description for `TOPIC_NOT_MODIFIED`. Neither predicate emits raw text.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-error-log.test.ts \
  test/status-board.test.ts
```
Expected: PASS with no snapshot containing the synthetic token.

### Task 2: Route startup, reliability, and polling errors through the sanitizer

**Files:**
- Modify: `src/index.ts:88-97`
- Modify: `src/index.ts:233-243`
- Modify: `src/index.ts:365-367`
- Modify: `src/index.ts:378-379`
- Modify: `src/index.ts:419-440`
- Delete from: `src/index.ts:456-499`
- Modify: `test/telegram-error-log.test.ts`
- Create: `test/index-telegram-log-safety.test.ts`
- Verify: `test/polling-lifecycle.test.ts`
- Verify: `test/lifecycle.test.ts`

- [ ] **Step 1: Add a failing main-runner source regression test**

Create `test/index-telegram-log-safety.test.ts` so the production integration, not only the helper, drives RED:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main Telegram runner log boundary", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  it("routes caught values through the structured formatter", () => {
    expect(source).toContain('from "./telegram-error-log.js"');
    expect(source).not.toMatch(/const message = error instanceof Error/);
    expect(source).not.toMatch(/job=\$\{jobId/);
    expect(source).not.toMatch(/function (?:boundedErrorText|telegramErrorCodeForLog)/);
  });
});
```

- [ ] **Step 2: Verify RED for the exact runner behavior**

```bash
TMPDIR=/var/tmp npx vitest run test/index-telegram-log-safety.test.ts test/polling-lifecycle.test.ts
```
Expected: FAIL because `src/index.ts` still extracts and logs raw messages and job identity.

- [ ] **Step 3: Replace unsafe `src/index.ts` calls**

Import `formatTelegramErrorLog` and `isTelegramPollingConflict`. Apply these forms:

```ts
console.warn(formatTelegramErrorLog("cleanup", error));
console.error(formatTelegramErrorLog("startup", error));
console.error(formatTelegramErrorLog("reliability", error));
```

The reliability callback must no longer include `jobId`. Map its exact typed union without interpolation:

```ts
const RUNTIME_LOG_OPERATION: Record<TelegramReliabilityRuntimeOperation, TelegramLogOperation> = {
  status_refresh: "status_edit", delivery: "reliability",
  coordinator: "reliability", reconciliation: "reliability",
};
```

Replace polling control and logging with:

```ts
if (isTelegramPollingConflict(error) && restartAttempts < MAX_RESTART_ATTEMPTS) {
  restartAttempts += 1;
  console.warn(formatTelegramErrorLog("polling", error));
  console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
  return restartPollingAfterDelay({
    delayMs: RESTART_DELAY_MS,
    isShuttingDown: () => shuttingDown,
    restart: startPolling,
  });
}

console.error(formatTelegramErrorLog("polling", error));
await lifecycle.terminate({ exitCode: 1, runner: "inactive" });
```

Delete `boundedErrorText`, `telegramErrorCodeForLog`, `errorRecord`, and `telegramRetryAfterMsForLog` from `src/index.ts`. Keep static warnings that contain no error data unchanged.

- [ ] **Step 4: Verify 07.0a locally**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-error-log.test.ts \
  test/index-telegram-log-safety.test.ts \
  test/status-board.test.ts \
  test/polling-lifecycle.test.ts \
  test/lifecycle.test.ts \
  test/telegram-grammy-transport.test.ts \
  test/telegram-grammy-rich-transport.test.ts
npm run build:server
git diff --check
```

Expected: all focused tests pass, TypeScript builds, and the diff has no whitespace errors.

- [ ] **Step 5: Review and checkpoint 07.0a**

Inspect the diff for raw token patterns and raw console arguments without printing `.env`:

```bash
git diff -- src/telegram-error-log.ts src/index.ts test/telegram-error-log.test.ts test/index-telegram-log-safety.test.ts
rg -n 'console\.(warn|error).*\b(error|reason)\b|api\.telegram\.org/(file/)?bot' src/index.ts src/telegram-error-log.ts
git status --short
```
Expected: the only Telegram API URL pattern is the sanitizer's test or redaction expression, and no runner catch variable reaches `console` directly. Stop for review. Commit only if the user explicitly authorizes it.

- [ ] **Step 6: Rotate and release 07.0a after explicit approval**

The operator revokes the exposed token in BotFather, creates its replacement, and edits only `TELEGRAM_BOT_TOKEN` in the private repository `.env` through a local secret-safe editor. The value is never sent in chat or placed in a shell argument. Verify only metadata:

```bash
stat -c '%n mode=%a owner=%U:%G size=%s' .env
git status --short -- .env
```
Expected: `.env` is owned by `root:root`, mode `600`, and not reported as a Git change.

Run the existing read-only release preflight. Proceed only when it reports `safeToRestart=true`, zero active turns, zero sending deliveries, and no uncertain delivery. Build the reviewed revision, restart `telecodex.service` once, then verify:

```bash
systemctl show telecodex.service \
  --property=ActiveState --property=SubState --property=MainPID --property=NRestarts --no-pager
```

Expected: `ActiveState=active`, `SubState=running`, one stable nonzero `MainPID`, and `NRestarts=0`. Inspect only fresh post-restart log lines through a redacting filter and assert no credential-shaped Telegram URL. Confirm SQLite `quick_check=ok`, zero foreign-key violations, and no new sending or uncertain delivery.

Rollback code to the previously recorded revision if readiness fails, but never restore the revoked token. Leave the service stopped and report the blocker if the replacement credential does not authenticate.

## Microrelease 07.0b: Protect remaining bot delivery boundaries

### Task 3: Replace raw bot, Inbox, and Dashboard error logging

**Files:**
- Modify: `src/bot.ts:740-815`
- Modify: `src/bot.ts:902-908`
- Modify: `src/bot.ts:1128-1145`
- Modify: `src/bot.ts:1197-1210`
- Modify: `src/bot.ts:1220-1454`
- Modify: `src/bot.ts:1513-1567`
- Modify: `src/bot.ts:4149-4153`
- Modify: `src/bot.ts:4368-4371`
- Modify: `src/bot.ts:4828-4845`
- Modify: `src/bot-inbox.ts:117-132`
- Modify: `src/bot-inbox.ts:228-245`
- Modify: `src/bot-inbox.ts:429-433`
- Modify: `src/status-board-store.ts:35-72`
- Modify: `test/bot-inbox.test.ts`
- Modify: `test/status-board-store.test.ts`

- [ ] **Step 1: Write failing captured-console tests**

For Inbox topic creation and Dashboard persistence, reject an `Error` whose message contains a synthetic token, absolute path, message ID, and payload marker. Capture the single console argument:

```ts
const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
createForumTopic.mockRejectedValueOnce(new Error(
  `https://api.telegram.org/bot${TOKEN}/createForumTopic message=77 payload=PRIVATE`,
));

await flushInboxBurst();

expect(logged).toHaveBeenCalledOnce();
expect(logged.mock.calls[0]).toHaveLength(1);
expect(logged.mock.calls[0]![0]).toMatch(/^telegram event=inbox category=/);
expect(String(logged.mock.calls[0]![0])).not.toMatch(/123456789:|message=77|PRIVATE/);
```

Use the same one-argument assertion with `console.warn` for Dashboard store load and persist failures.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
TMPDIR=/var/tmp npx vitest run test/bot-inbox.test.ts test/status-board-store.test.ts
```
Expected: FAIL because current calls log multiple arguments and preserve raw descriptions.

- [ ] **Step 3: Replace every caught Telegram-facing error**

Use one formatter call as the only console argument:

```ts
console.error(formatTelegramErrorLog("artifact_send", error));
console.warn(formatTelegramErrorLog("inbox", error));
console.warn(formatTelegramErrorLog("dashboard_store", error));
```

Map bot sites deterministically:

- keyboard editing to `keyboard_edit`;
- Telegram documents, generated images, queue messages, tool messages, error replies, and recovery sends to `delivery_send`;
- progress/status updates to `status_edit`;
- topic create, reopen, rename, or liveness failures to `topic`;
- artifact delivery to `artifact_send`;
- top-level `bot.catch` to `bot_handler`;
- Inbox forwarding and topic creation to `inbox`;
- Dashboard state persistence to `dashboard_store`;
- non-Telegram local failures that remain inside `bot.ts` to `internal_local` through operation `bot_handler`.

Replace all three `TOPIC_NOT_MODIFIED` checks with `isTelegramTopicNotModified(error)`, then remove `formatError` after its final caller is gone. Do not include prefixes containing filenames, realm names, paths, ticket numbers, context keys, or message IDs. Where two errors are currently logged together, emit two separate sanitized one-argument lines with the same stable operation rather than an object containing both errors.

- [ ] **Step 4: Verify 07.0b locally**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/telegram-error-log.test.ts \
  test/bot-inbox.test.ts \
  test/status-board-store.test.ts \
  test/bot-message-reliability.test.ts \
  test/telegram-grammy-transport.test.ts \
  test/telegram-grammy-rich-transport.test.ts
npm run build:server
git diff --check
```

Expected: all tests pass, every tested failure logs one sanitized argument, and transport state tests remain unchanged.

- [ ] **Step 5: Review, checkpoint, and release 07.0b**

```bash
rg -n -C 1 'console\.(warn|error)' src/bot.ts src/bot-inbox.ts src/status-board-store.ts
git diff --check
git status --short
```
Expected: caught errors reach `console` only through `formatTelegramErrorLog`; static operational warnings contain no user-controlled data. Stop for review and separate commit authorization.

After explicit live approval, run preflight, deploy at an idle boundary, restart once, and repeat the 07.0a process, SQLite, backlog, and fresh-log checks. Do not send a synthetic Telegram message. Normal user traffic supplies the observation sample.

## Microrelease 07.0c: Prevent regression

### Task 4: Add an AST boundary guard and finish repository verification

**Files:**
- Create: `test/telegram-log-boundaries.test.ts`
- Modify: `src/bot.ts` only if the guard finds a remaining raw catch path
- Modify: `src/bot-inbox.ts` only if the guard finds a remaining raw catch path
- Modify: `src/index.ts` only if the guard finds a remaining raw catch path
- Modify: `src/status-board-store.ts` only if the guard finds a remaining raw catch path

- [ ] **Step 1: Write the source-boundary guard**

Parse the four source files with the installed TypeScript compiler. For each `catch (name)` clause, find descendant `console.warn` and `console.error` calls that reference that catch variable. Require exactly one argument and require that argument to be a direct `formatTelegramErrorLog(...)` call. Also reject `formatError` definitions and calls in those files.

Use this assertion shape:

```ts
expect(violations).toEqual([]);
```

Each violation reports only repository-relative filename and line number. It must not include source text, string literals, or error values.

- [ ] **Step 2: Verify the guard detects an unsafe fixture**

Factor the AST walker as a local test helper and run it against this in-memory fixture:

```ts
try {
  await work();
} catch (error) {
  console.error("failed", error);
}
```

Expected violation: `fixture.ts:4`. Then run it against:

```ts
try {
  await work();
} catch (error) {
  console.error(formatTelegramErrorLog("bot_handler", error));
}
```

Expected: no violations.

- [ ] **Step 3: Run the guard and correct only reported boundaries**

```bash
TMPDIR=/var/tmp npx vitest run test/telegram-log-boundaries.test.ts
```
Expected: PASS. If it fails, replace only the reported raw console path with the correct stable operation and rerun until green.

- [ ] **Step 4: Run complete verification**

```bash
TMPDIR=/var/tmp npm test
npm run check:web
npm run build
git diff --check
```
Expected: all Vitest files pass, Svelte reports zero errors, both server and web builds succeed, and Git reports no whitespace errors.

- [ ] **Step 5: Perform manual secret and scope review**

```bash
git diff --name-only
git status --short
rg -n 'console\.(warn|error)' src/index.ts src/bot.ts src/bot-inbox.ts src/status-board-store.ts
rg -n 'TELEGRAM_BOT_TOKEN|api\.telegram\.org/(file/)?bot' \
  src/telegram-error-log.ts test/telegram-error-log.test.ts test/telegram-log-boundaries.test.ts
```

Expected changed scope is limited to this plan. Token references are variable names or synthetic fixtures only. There is no live value, `.env`, database, release-state file, generated `dist`, or unrelated modification in the commit candidate.

- [ ] **Step 6: Review, checkpoint, and release 07.0c**

Stop for user review. Commit only with explicit authorization using the repository convention:

```bash
git add \
  src/telegram-error-log.ts src/index.ts src/bot.ts src/bot-inbox.ts src/status-board-store.ts \
  test/telegram-error-log.test.ts test/telegram-log-boundaries.test.ts \
  test/bot-inbox.test.ts test/status-board-store.test.ts
git commit -m "NO-TICKET fix: redact telegram errors in logs"
```

Do not add `.env`, `dist`, `dist-web`, `.telecodex`, or unrelated files.

After separate live approval, run the same idle preflight and one-restart procedure. Verify the exact running revision, stable PID, `NRestarts=0`, readiness, SQLite health, zero sending or uncertain deliveries, and fresh sanitized logs. Observe normal traffic without sending an automatic smoke message.

## 07.0 completion gate

Step 07.0 is complete only when:

- all three microreleases pass local and live checks, and the replacement token authenticates after the exposed token is revoked;
- no fresh log contains a credential-shaped Telegram URL, while 429 retains category, code, and bounded retry delay without content or identities;
- delivery and status transition regressions remain green, and the reviewed service revision has one stable process without a restart loop;
- the existing-topic warning replay remains contained and untouched.

Only then start the separate implementation plan for Step 07.1, hybrid rich selection.
