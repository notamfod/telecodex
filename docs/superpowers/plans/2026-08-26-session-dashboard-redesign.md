# Session Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the technical Dashboard with a paginated, virtualized session list whose navigation matches Jira and whose cards swipe to ChatGPT or Telegram.

**Architecture:** The server converts status, recent-thread, guardian, and canonical-job inputs into one deduplicated session projection and returns one requested page plus exact view counts. The Svelte client requests one view at a time, merges recent pages by thread ID, renders them through the existing virtual-list dependency, and reuses the established swipe gesture model for ChatGPT and Telegram handoffs.

**Tech Stack:** TypeScript, Node HTTP server, SQLite via `better-sqlite3`, Svelte, Carbon Components Svelte, TanStack Svelte Virtual, Vitest.

**Execution constraint:** Work in the current `telecodex-improvements` checkout because the Mini App implementation is uncommitted WIP and is absent from a clean worktree. Preserve unrelated changes. Do not commit unless the user separately requests it.

---

### Task 1: Define and build the session projection

**Files:**
- Modify: `src/status-board-snapshot.ts`
- Replace Dashboard-specific types and builder in: `src/dashboard-api.ts`
- Modify: `test/status-board.test.ts`
- Modify: `test/dashboard-api.test.ts`

- [ ] **Step 1: Write failing snapshot tests for child identity and an unbounded Dashboard recent set**

Add assertions that `RunningChild` retains `threadId`, that a waiting child promotes its root during Dashboard classification, and that `buildStatusSnapshot(..., { maxRecentThreads: 30 })` exposes 30 recent roots while retaining the full `recentThreadCount`.

```ts
expect(snapshot.running[0]?.children[0]).toMatchObject({
  threadId: "child-waiting",
  waitingOn: "input",
});
expect(snapshot.recentThreads).toHaveLength(30);
expect(snapshot.recentThreadCount).toBe(42);
```

- [ ] **Step 2: Run the snapshot test and verify RED**

Run: `npm test -- --run test/status-board.test.ts`

Expected: FAIL because `RunningChild` has no `threadId` and the fixture cannot classify a child by identity.

- [ ] **Step 3: Preserve child IDs in the status snapshot**

Extend `RunningChild` and `groupRunningThreads()`:

```ts
export interface RunningChild {
  threadId: string;
  label: string;
  since: number;
  waitingOn?: WaitingOn;
}

children: children.sort((left, right) => left.since - right.since).map((child) => ({
  threadId: child.id,
  label: child.agentNickname ? `${child.agentNickname} · ${child.label}` : child.label,
  since: child.since,
  ...(child.waitingOn ? { waitingOn: child.waitingOn } : {}),
})),
```

- [ ] **Step 4: Write failing Dashboard projection tests**

Replace the old metrics/reliability expectation with tests for this contract:

```ts
const payload = buildDashboardPayload(snapshotValue, CHAT_ID, reliability, {
  view: "attention",
  offset: 0,
  limit: 30,
});

expect(payload.counts).toEqual({ active: 1, recent: 37, attention: 2 });
expect(payload.page).toEqual({ offset: 0, returned: 2, total: 2, hasMore: false });
expect(payload.sessions.map((row) => row.id)).toEqual(["stalled-root", "waiting-root"]);
expect(payload.sessions.every((row) => [...row.label].length <= 160)).toBe(true);
```

Cover precedence `attention > active > recent`, canonical projections without `threadId`, child-to-root promotion, newest-first ordering, offset pagination, safe workspace basenames, topic URLs, and exact `codex://threads/<id>` links.

- [ ] **Step 5: Run the Dashboard API test and verify RED**

Run: `npm test -- --run test/dashboard-api.test.ts`

Expected: FAIL because the existing payload exposes `metrics`, `threads`, and raw `reliability` instead of `counts`, `page`, and `sessions`.

- [ ] **Step 6: Implement the normalized Dashboard contract**

Use these public types in `src/dashboard-api.ts`:

```ts
export type DashboardView = "active" | "recent" | "attention";
export type DashboardSessionState = "active" | "recent" | "waiting" | "stalled";

export interface DashboardQuery {
  view: DashboardView;
  offset: number;
  limit: number;
}

export interface DashboardSession {
  id: string;
  label: string;
  workspace: string;
  source?: string;
  state: DashboardSessionState;
  timestamp: number;
  telegramUrl?: string;
  codexUrl: string;
  canCreateTopic: boolean;
}

export interface DashboardPayload {
  generatedAt: number;
  counts: { active: number; recent: number; attention: number };
  page: { offset: number; returned: number; total: number; hasMore: boolean };
  sessions: DashboardSession[];
  system: { codexAvailable: boolean };
}
```

Normalize labels by collapsing whitespace and truncating at 160 Unicode code points with an ellipsis. Derive safe workspace names with `workspaceLabel()`. Build a child-to-root map, attach canonical attention by `threadId`, classify each root once, sort by timestamp descending, then slice the selected set with `offset` and `limit`.

- [ ] **Step 7: Run projection tests and verify GREEN**

Run: `npm test -- --run test/status-board.test.ts test/dashboard-api.test.ts`

Expected: PASS.

### Task 2: Thread paging query through the controller and HTTP server

**Files:**
- Modify: `src/dashboard-controller.ts`
- Modify: `src/mini-app-server.ts`
- Modify: `src/mini-app-runtime.ts`
- Modify: `src/bot.ts`
- Modify: `test/dashboard-controller.test.ts`
- Modify: `test/mini-app-server.test.ts`
- Modify: `test/mini-app-runtime.test.ts`

- [ ] **Step 1: Write failing controller and HTTP query tests**

Specify that the controller receives the query unchanged and the server accepts only bounded values:

```ts
await fetch(`${server.url}/api/dashboard?view=recent&offset=30&limit=30`, {
  headers: { "x-telegram-init-data": signedInitData },
});

expect(loadDashboard).toHaveBeenCalledWith({ view: "recent", offset: 30, limit: 30 });
```

Also assert defaults `{ view: "active", offset: 0, limit: 30 }`, maximum `limit=100`, rejection of unknown views, and propagation through `startConfiguredMiniApp()`.

- [ ] **Step 2: Run controller/server tests and verify RED**

Run: `npm test -- --run test/dashboard-controller.test.ts test/mini-app-server.test.ts test/mini-app-runtime.test.ts`

Expected: FAIL because `loadDashboard()` currently takes no query and `/api/dashboard` ignores query parameters.

- [ ] **Step 3: Implement query parsing and propagation**

Change the contracts to:

```ts
interface DashboardController {
  loadDashboard(query: DashboardQuery): Promise<DashboardPayload>;
  ensureTopic(threadId: string): Promise<{ created: boolean; url: string }>;
}

interface MiniAppServerOptions {
  loadDashboard(query: DashboardQuery): Promise<unknown>;
}
```

Parse `view`, `offset`, and `limit` in the GET route, authenticate before loading, and pass the normalized query through `mini-app-runtime.ts` to the controller.

- [ ] **Step 4: Make topic bindings available to every returned session**

In `src/bot.ts`, stop slicing the binding candidates to `STATUS_BOARD_BUTTON_LIMIT` before `bindLiveStatusTopics()`. Keep the ten-minute validation interval and cached bindings, but bind cached topic IDs onto all active and recent roots so sessions beyond the first eight do not falsely offer topic creation.

Load every unarchived root updated during the 24-hour window for Dashboard classification, and pass `maxRecentThreads: Number.MAX_SAFE_INTEGER` only from `createPeriodicDashboardCollector()`. Keep the Telegram text board collector on the existing six-row `MAX_RECENT_THREADS` cap. Remove the SQL `LIMIT 1000` from the 24-hour Dashboard read so its count and pages describe the same complete set.

- [ ] **Step 5: Run server flow tests and verify GREEN**

Run: `npm test -- --run test/dashboard-controller.test.ts test/mini-app-server.test.ts test/mini-app-runtime.test.ts test/status-board.test.ts`

Expected: PASS.

### Task 3: Add the paged web model and authenticated client

**Files:**
- Replace Dashboard model portion in: `web/src/model.ts`
- Replace Dashboard API portion in: `web/src/api.ts`
- Modify: `test/mini-app-ui.test.ts`

- [ ] **Step 1: Write failing API and page-merge tests**

Define the browser call and merge behavior:

```ts
await loadDashboard("signed-data", {
  view: "recent",
  offset: 30,
  limit: 30,
}, fetcher);

expect(fetcher).toHaveBeenCalledWith(
  "/api/dashboard?view=recent&offset=30&limit=30",
  { headers: { "x-telegram-init-data": "signed-data" } },
);

expect(mergeDashboardPage(first, second).sessions.map((row) => row.id))
  .toEqual(["thread-1", "thread-2", "thread-3"]);
```

Test duplicate IDs, server cursor advancement using `page.offset + page.returned`, stale request gates, view-specific poll intervals, and `hasMore` termination.

- [ ] **Step 2: Run the UI model tests and verify RED**

Run: `npm test -- --run test/mini-app-ui.test.ts`

Expected: FAIL because the current client has no query, paging metadata, or Dashboard page merger.

- [ ] **Step 3: Implement the page model**

Add:

```ts
export function mergeDashboardPage(
  current: DashboardPayload,
  next: DashboardPayload,
): DashboardPayload {
  const seen = new Set<string>();
  const sessions = [...current.sessions, ...next.sessions]
    .filter((session) => !seen.has(session.id) && seen.add(session.id));
  return { ...next, sessions, page: { ...next.page, returned: current.page.returned + next.page.returned } };
}

export function dashboardPollInterval(view: DashboardView): number {
  return view === "recent" ? 15_000 : 5_000;
}
```

Keep the existing gesture-axis, reveal, and commit helpers. Rename the user-facing swipe action from `codex` to `chatgpt` while preserving the right-positive and left-negative direction mapping.

- [ ] **Step 4: Implement query serialization in `web/src/api.ts`**

Build the URL with `URLSearchParams`, preserve Telegram authentication, and remove the unused canonical job action client from the Dashboard module.

- [ ] **Step 5: Run UI model tests and verify GREEN**

Run: `npm test -- --run test/mini-app-ui.test.ts`

Expected: PASS.

### Task 4: Rebuild the Svelte Dashboard around sessions

**Files:**
- Rewrite: `web/src/App.svelte`
- Simplify: `web/src/ThreadRow.svelte`
- Create: `web/src/SessionList.svelte`
- Rewrite Dashboard rules in: `web/src/app.css`
- Create: `test/session-dashboard-ui.test.ts`
- Modify: `test/mini-app-ui.test.ts`

- [ ] **Step 1: Write failing structural UI tests**

Assert the approved surface:

```ts
expect(app).toContain("Сессии · Codex");
expect(app).toContain('{ id: "active", label: "Активные"');
expect(app).toContain('{ id: "recent", label: "Недавние"');
expect(app).toContain('{ id: "attention", label: "Зависшие и ожидающие"');
expect(app).not.toContain("Runtime status");
expect(app).not.toContain("Canonical jobs");
expect(css).toMatch(/\.dashboard__tabs[\s\S]*overflow-x:\s*auto/);
expect(css).toMatch(/\.session-title[\s\S]*-webkit-line-clamp:\s*2/);
expect(list).toContain("@tanstack/svelte-virtual");
```

Test the three empty labels, page-boundary retry, and absence of thread/job/turn identifiers.

- [ ] **Step 2: Run structural tests and verify RED**

Run: `npm test -- --run test/session-dashboard-ui.test.ts test/mini-app-ui.test.ts`

Expected: FAIL because the current App renders technical reliability sections and full titles.

- [ ] **Step 3: Build `SessionList.svelte` with dynamic virtualization**

Follow the proven Jira backlog pattern: `createVirtualizer`, stable thread ID keys, dynamic `measureElement`, overscan of eight rows, and automatic `loadNext()` when the last virtual index reaches within eight rows of the loaded boundary. Keep loaded rows mounted during next-page loading and show a boundary retry without clearing them.

- [ ] **Step 4: Simplify `ThreadRow.svelte`**

Render the semantic rail, two-line title, workspace/source metadata, and age only. Keep pointer gesture arbitration. Label the right reveal action `ChatGPT` and the left action `Telegram` or `Создать топик`. Use one in-flight promise per thread ID in the parent so repeated Telegram gestures cannot duplicate topic creation.

- [ ] **Step 5: Rewrite `App.svelte` for the three views**

Use the Jira header and tag navigation pattern. Invalidate stale requests on view changes, reset paging on manual refresh, poll only while visible, preserve rows during background errors, and pass the selected page to `SessionList`.

The component must not import or render canonical job action helpers, reliability groups, job timelines, system strips, queue cards, or recent-job cards.

- [ ] **Step 6: Apply the approved visual system in `app.css`**

Use Carbon dark surfaces, borders-only depth, the Jira spacing rhythm, a non-wrapping horizontally scrollable `.dashboard__tabs`, 44px touch targets, semantic rails, two-line title clamping, visible focus rings, and reduced-motion overrides.

- [ ] **Step 7: Run UI tests and web checks and verify GREEN**

Run:

```bash
npm test -- --run test/session-dashboard-ui.test.ts test/mini-app-ui.test.ts
npm run check:web
```

Expected: all tests pass and Svelte reports 0 errors and 0 warnings.

### Task 5: Regression, build, and live Telegram rollout

**Files:**
- Verify all modified files
- No commit

- [ ] **Step 1: Run focused Dashboard and Jira regression tests**

Run:

```bash
npm test -- --run test/status-board.test.ts test/dashboard-api.test.ts test/dashboard-controller.test.ts test/mini-app-server.test.ts test/mini-app-runtime.test.ts test/mini-app-ui.test.ts test/session-dashboard-ui.test.ts test/jira-backlog-ui.test.ts test/jira-mini-app.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run check:web
npm run build
git diff --check
```

Expected: 0 failed tests, 0 Svelte errors or warnings, successful server/web builds, and no whitespace errors.

- [ ] **Step 3: Restart the existing TeleCodex user service**

Resolve the service's actual user scope environment, restart `telecodex.service`, and verify `ActiveState=active`, `SubState=running`, a fresh start timestamp, and no immediate restart loop. Do not modify unit files.

- [ ] **Step 4: Verify the live Mini App API**

Use a freshly signed local Telegram init payload without printing credentials. Verify all three views return HTTP 200, exact counts, bounded 160-code-point labels, newest-first recent pages, no duplicate IDs, and correct `hasMore` behavior.

- [ ] **Step 5: Verify health and readiness**

Request `/healthz` and `/readyz` from the configured local Mini App listener and expect HTTP 200 with healthy/ready payloads.

- [ ] **Step 6: Hand off phone-only acceptance checks**

Ask the user to confirm from Telegram on the target phone:

1. horizontal tab scrolling;
2. right swipe opening the exact ChatGPT session;
3. left swipe opening an existing Telegram topic;
4. left swipe creating and opening a missing topic.

Report the exact verified server state and keep the mobile ChatGPT handoff explicitly unconfirmed until the user performs this check.
