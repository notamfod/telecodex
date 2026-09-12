# TeleCodex Dashboard Topic Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the pinned Telegram Dashboard message into a compact operational summary with one Mini App launcher and only unambiguous, currently required actions.

**Architecture:** Keep snapshot collection, callback DTOs, Mini App data, publisher lifecycle, and stored Dashboard location unchanged. Replace the Telegram topic projection in `status-board-render`: bounded summary sections first, then a separately releasable required-action selector whose numbered buttons are derived from the same visible attention rows. Keep the callback wire format unchanged and make its shared encoder fail closed for job IDs that the existing bot parser cannot accept.

**Tech Stack:** TypeScript 5.9, Vitest, grammY inline keyboards, existing status-board publisher, SQLite release preflight.

---

## Product intent and boundaries

The operator should understand the state in a few seconds, see the exceptional items first, and use the Mini App for history and detail. The topic keeps Telegram-native typography, one blank line between sections, semantic status markers, and a single stable pinned message. Its signature interaction is a numbered attention row paired with at most one button carrying the same number.

This plan contains two independently releasable checkpoints:

1. **07.3a:** compact summary and launcher-only keyboard.
2. **07.3b:** required-action-only numbered callbacks.

Do not change `StatusSnapshot`, canonical projections, callback wire format, action execution, authorization, stale-version checks, Mini App API, persisted Dashboard location, topic lifecycle, outbox, or database schema. Do not render recent session history or canonical diagnostic facts in the topic. Do not create a replacement Dashboard topic or message.

Files:

- Modify `src/status-board-render.ts` for the compact topic projection.
- Modify `src/telegram-grammy-transport.ts` so the shared callback encoder accepts only parser-compatible job IDs.
- Split the existing oversized `test/status-board.test.ts` before changing its render expectations.
- Modify `test/status-board-render.test.ts` for canonical attention and callback coverage.
- Split callback-specific coverage from `test/telegram-grammy-transport.test.ts` into
  `test/telegram-status-callback.test.ts` and add encoder/parser compatibility fixtures there.
- Modify `test/status-board-lifecycle.test.ts` only for the removed topic-link button behavior.
- Modify this plan only to record checkpoint progress.

## Microrelease 07.3a: Compact body and launcher-only keyboard

### Task 1: Establish focused render tests

- [x] **Step 1: Split the oversized mixed test file without changing behavior**

Move the `renderStatusBoard` and `renderMiniAppLauncher` describes, their local `emptySnapshot` and `task` helpers, and required imports from `test/status-board.test.ts` to `test/status-board-summary.test.ts`. Keep both files below 500 lines. Run both test files before changing expectations.

```bash
TMPDIR=/var/tmp npx vitest run test/status-board.test.ts test/status-board-summary.test.ts
```

- [x] **Step 2: Add failing compact-summary expectations**

Change the focused render tests to require:

```ts
expect(body).toContain("📌 <b>TeleCodex</b> · активны 1 · ждёт 1 · в очереди 2 · ошибок 3");
expect(body).toContain("<b>Требуют внимания</b>");
expect(body).toContain("<b>Сейчас</b>");
expect(body).toContain("<b>Очередь</b>");
expect(body).toContain("<b>Система</b>");
expect(body).not.toContain("Последние 24 часа");
expect(body).not.toContain("Недавно");
expect(body).not.toContain("Задачи TeleCodex");
expect(body).not.toContain("health ");
expect(body).not.toContain("delivery ");
```

Add fixtures proving that active roots are capped at five, queued rows at three, hidden counts are exact, labels remain secret-safe, and the body stays within 4096 UTF-16 units.

- [x] **Step 3: Add the launcher-only RED fixture**

Render many projected jobs with `details`, `abort`, and `refresh` actions and a Mini App URL. Require exactly:

```ts
expect(buttons).toEqual([{
  text: "Открыть Dashboard",
  url: "https://example.test/dashboard",
}]);
```

For the launcher-only 07.3a checkpoint, without a Mini App URL require no buttons; 07.3b later permits required callbacks independently of the launcher. Run RED:

```bash
TMPDIR=/var/tmp npx vitest run test/status-board-summary.test.ts test/status-board-render.test.ts
```

Expected: old recent sections, projected diagnostics, topic links, and repeated `Details` buttons violate the new assertions.

### Task 2: Render the compact topic projection

- [x] **Step 1: Introduce bounded summary rows**

In `src/status-board-render.ts`, use constants `MAX_ACTIVE_ROWS = 5`, `MAX_QUEUE_ROWS = 3`, and `MAX_ATTENTION_ROWS = 7`. Build the heading only from active roots, waiting roots or children, queued rows, and 24-hour failed jobs:

```ts
const heading = [
  `📌 <b>TeleCodex</b> · активны ${snapshot.running.length}`,
  `ждёт ${waiting}`,
  `в очереди ${snapshot.queued.length}`,
  `ошибок ${snapshot.failedJobs24h}`,
].join(" · ");
```

Render in order: optional `Требуют внимания`, `Сейчас`, optional `Очередь`, and `Система`. Number visible rows, append exact `… ещё N` summaries, and omit source labels and child detail. Show waiting roots in `Требуют внимания`; show all bounded active roots in `Сейчас` without duplicating source or workspace text.

- [x] **Step 2: Remove duplicated topic detail**

Delete topic rendering for `recent`, `recentThreads`, projected health/delivery/reason diagnostics, topic open/create buttons, and per-job action allocation. Keep the Mini App launcher as the sole button when configured. Keep `renderMiniAppLauncher` unchanged.

The system section must use:

```ts
snapshot.failedJobs24h > 0
  ? `⚠️ Доставка · ошибок ${snapshot.failedJobs24h} за 24ч`
  : "🟢 Доставка без ошибок за 24ч"
```

- [x] **Step 3: Verify 07.3a locally**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/status-board-summary.test.ts \
  test/status-board-render.test.ts \
  test/status-board-lifecycle.test.ts \
  test/bot-message-reliability.test.ts
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
npm run build
git diff --check
```

Review for unbounded rows, hidden diagnostic leakage, changed callback handling, changed Mini App output, and files outside the plan. Correct findings and repeat affected tests.

- [x] **Step 4: Commit 07.3a**

```bash
git add src/status-board-render.ts test/status-board.test.ts \
  test/status-board-summary.test.ts test/status-board-render.test.ts \
  test/status-board-lifecycle.test.ts \
  docs/superpowers/plans/2026-09-12-telecodex-dashboard-topic-cleanup.md
git diff --cached --check
git commit -m "NO-TICKET fix: compact telegram dashboard topic"
```

- [x] **Step 5: Deploy 07.3a**

Build the exact commit and run `npm run release:preflight`. Require `safeToRestart=true`, `queued=0`, `running=0`, `sending=0`, and `uncertain=0`. Capture the persisted Dashboard chat, topic, and message identity without printing it. Create and verify a mode-`0600` online SQLite backup under `.telecodex/release-state/dashboard-topic-cleanup/`.

Restart `telecodex.service` exactly once. Require a stable new PID, `NRestarts=0`, health/readiness 200, Guardian ready, authenticated `getMe`, SQLite `quick_check=ok`, FK=0, and clean fresh Telegram logs. Verify that the persisted Dashboard identity is byte-for-byte unchanged, the Mini App URL responds, and no topic create, close, reopen, deletion, or replacement event appears after the restart.

## Microrelease 07.3b: Required-action-only callbacks

### Task 3: Derive actions from visible attention rows

- [x] **Step 1: Add failing action-selection fixtures**

In `test/status-board-render.test.ts`, require:

- a board with only healthy queued or running jobs has the launcher and no callbacks;
- `attention.kind = "required"` exposes at most one non-informational action;
- `details` and `inspect` never become topic buttons;
- required callbacks remain available without a Mini App URL;
- a button label begins with the exact number of its visible attention row;
- an action whose job ID or version does not match its projection throws;
- an oversized callback is omitted while its attention row stays visible;
- a parser-incompatible job ID is omitted by the shared encoder while its attention row stays visible;
- a parser-incompatible delivery `partKey` is omitted by the shared encoder while its attention row stays visible;
- without a launcher, eight required rows and eight matching callbacks remain visible; with a launcher, seven remain visible;
- many required jobs keep the body and button count bounded;
- repeated rendering is byte-identical.

Run RED:

```bash
TMPDIR=/var/tmp npx vitest run test/status-board-render.test.ts
```

- [x] **Step 2: Select one exact action per canonical attention item**

Create one internal `AttentionRow` model containing rendered text, optional projected job, and optional selected action. Projected jobs are eligible only when `projection.attention.kind === "required"`. Prefer the first exact action not in `{ details, inspect }`, preserving canonical action order and full DTO fields such as `partKey` or `alertId`. Waiting root sessions remain visible attention rows without callbacks.

Number projected and waiting rows once, then derive both text and buttons from that same bounded array. Derive its limit as `STATUS_BOARD_BUTTON_LIMIT - launcherButtons.length` and use that exact value for visible rows, hidden count, and callbacks. Button text is `${number}. ${actionLabel(kind)}` and is capped at 60 Unicode code points. Keep `telegramStatusActionCallbackData` as the only encoder; omit a button if it cannot fit. Do not synthesize fallback `details` actions.

- [x] **Step 3: Keep callback safety unchanged**

Before encoding, require exact `jobId` and `expectedVersion` equality with the projection. Preserve the existing action DTO so part-specific delivery retries and Guardian alert bindings remain exact. In the common encoder, accept only job IDs matching the existing parser contract `/^[A-Za-z0-9_-]{1,40}$/` and, when present, only part keys matching `/^[A-Za-z0-9_.:-]{1,24}$/`; return `null` for incompatible values so no dead callback is emitted. Do not modify `src/bot.ts` parsing or execution.

- [x] **Step 4: Verify 07.3b locally**

```bash
TMPDIR=/var/tmp npx vitest run \
  test/status-board-render.test.ts \
  test/status-board-summary.test.ts \
  test/status-board-lifecycle.test.ts \
  test/bot-message-reliability.test.ts \
  test/telegram-grammy-transport.test.ts \
  test/telegram-status-callback.test.ts \
  test/telegram-status-projection.test.ts
TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1
npm run check:web
npm run build
git diff --check
```

Review visible-row/button correspondence, first-action determinism, callback bounds, exact DTO preservation, launcher ordering, and unchanged lifecycle behavior. Correct findings and repeat affected tests.

- [x] **Step 5: Commit 07.3b**

```bash
git add src/status-board-render.ts src/telegram-grammy-transport.ts \
  test/status-board-render.test.ts test/status-board-summary.test.ts \
  test/telegram-grammy-transport.test.ts \
  test/telegram-status-callback.test.ts \
  docs/superpowers/plans/2026-09-12-telecodex-dashboard-topic-cleanup.md
git diff --cached --check
git commit -m "NO-TICKET fix: show required dashboard actions"
```

- [ ] **Step 6: Deploy 07.3b and close 07.3**

Repeat the exact-build, idle-preflight, verified-backup, single-restart, service, SQLite, Guardian, `getMe`, and fresh-log gates from 07.3a. Verify the persisted Dashboard identity remains unchanged again. Inspect the canonical live snapshot without message content: if required attention exists, prove every emitted callback decodes to the same job ID, version, and optional part key or alert ID; otherwise prove the launcher is the only button. Verify the Mini App endpoint and confirm no topic lifecycle event was produced.

07.3 is complete only when both commits are green and live, the existing pinned message identity survived both releases, the launcher remains reachable, action mapping is exact, and the full Telegram output-quality cycle is recorded complete.
