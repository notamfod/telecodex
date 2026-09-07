import {
  dashboardPollInterval,
  mergeDashboardPage,
  relativeTime,
  settleThreadSwipe,
  threadGestureAxis,
  threadSwipeIntent,
  type DashboardPayload,
  type DashboardSession,
} from "../web/src/model.js";
import { ensureThreadTopic, loadDashboard } from "../web/src/api.js";
import {
  ensureJiraThread,
  loadJiraIssue,
  loadJiraView,
  openJiraIssueThread,
} from "../web/src/jira-api.js";
import {
  assigneeInitials,
  createRequestGate,
  filterIssuesByAssignees,
  filterIssuesByStatuses,
  groupIssuesByStatus,
  jiraAssigneeOptions,
  jiraStatusOptions,
  jiraResultCount,
  UNASSIGNED_ASSIGNEE_ID,
  type JiraIssue,
} from "../web/src/jira-model.js";
import { resolveMiniAppRoute } from "../web/src/route.js";
import { readFile } from "node:fs/promises";

const NOW = Date.UTC(2026, 7, 20, 7, 0, 0);
const session = (overrides: Partial<DashboardSession> = {}): DashboardSession => ({
  id: "019fef85-92e7-7841-a26a-dbb311b50e31",
  label: "Session",
  workspace: "telecodex",
  state: "active",
  timestamp: NOW,
  codexUrl: "codex://threads/019fef85-92e7-7841-a26a-dbb311b50e31",
  canCreateTopic: true,
  ...overrides,
});

const page = (overrides: Partial<DashboardPayload> = {}): DashboardPayload => ({
  generatedAt: NOW,
  counts: { active: 1, recent: 0, attention: 0 },
  page: { view: "active", offset: 0, limit: 30, total: 1, hasMore: false },
  sessions: [session()],
  system: { codexAvailable: true },
  ...overrides,
});

describe("Mini App view model", () => {
  it("appends pages without duplicating sessions refreshed in place", () => {
    const first = page({
      sessions: [session({ id: "one", label: "One" }), session({ id: "two", label: "Two" })],
      page: { view: "recent", offset: 0, limit: 2, total: 3, hasMore: true },
    });
    const next = page({
      sessions: [session({ id: "two", label: "Two updated" }), session({ id: "three", label: "Three" })],
      page: { view: "recent", offset: 2, limit: 2, total: 3, hasMore: false },
    });

    expect(mergeDashboardPage(first.sessions, next.sessions).map(({ id, label }) => [id, label]))
      .toEqual([["one", "One"], ["two", "Two updated"], ["three", "Three"]]);
  });

  it("formats compact relative timestamps", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("сейчас");
    expect(relativeTime(NOW - 4 * 60_000, NOW)).toBe("4 мин");
    expect(relativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe("3 ч");
  });

  it("polls active or attention work at five seconds and idle work at fifteen", () => {
    expect(dashboardPollInterval("active")).toBe(5_000);
    expect(dashboardPollInterval("attention")).toBe(5_000);
    expect(dashboardPollInterval("recent")).toBe(15_000);
  });

  it("recognizes only available horizontal thread gestures", () => {
    expect(threadGestureAxis(30, 4)).toBe("horizontal");
    expect(threadGestureAxis(-30, 4)).toBe("horizontal");
    expect(threadGestureAxis(8, 30)).toBe("vertical");
    expect(threadGestureAxis(4, 4)).toBeNull();
    expect(threadSwipeIntent(30, 4, true, true)).toBe("codex");
    expect(threadSwipeIntent(-30, 4, true, true)).toBe("telegram");
    expect(threadSwipeIntent(8, 30, true, true)).toBeNull();
    expect(threadSwipeIntent(30, 4, false, true)).toBeNull();
    expect(threadSwipeIntent(-30, 4, true, false)).toBeNull();
  });

  it("reveals short swipes and commits full swipes", () => {
    expect(settleThreadSwipe(70, 360, true, true)).toEqual({
      action: "codex",
      commit: false,
      offset: 88,
    });
    expect(settleThreadSwipe(-70, 360, true, true)).toEqual({
      action: "telegram",
      commit: false,
      offset: -88,
    });
    expect(settleThreadSwipe(180, 360, true, true)).toEqual({
      action: "codex",
      commit: true,
      offset: 0,
    });
    expect(settleThreadSwipe(20, 360, true, true)).toEqual({
      action: null,
      commit: false,
      offset: 0,
    });
  });
});

describe("Mini App API client", () => {
  it("sends Telegram initData with dashboard requests", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ threads: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await loadDashboard("signed-data", { view: "recent", offset: 30, limit: 30 }, fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/dashboard?view=recent&offset=30&limit=30", {
      headers: { "x-telegram-init-data": "signed-data" },
    });
  });

  it("posts topic creation and surfaces server errors", async () => {
    const success = vi.fn(async () => new Response(JSON.stringify({
      created: true,
      url: "https://t.me/c/123/42",
    }), { status: 200 }));
    await expect(ensureThreadTopic("thread/id", "signed-data", success)).resolves.toEqual({
      created: true,
      url: "https://t.me/c/123/42",
    });
    expect(success).toHaveBeenCalledWith("/api/dashboard/threads/thread%2Fid/topic", {
      method: "POST",
      headers: { "x-telegram-init-data": "signed-data" },
    });

    const failure = vi.fn(async () => new Response(JSON.stringify({ error: "No thread" }), {
      status: 404,
    }));
    await expect(loadDashboard(
      "signed-data",
      { view: "active", offset: 0, limit: 30 },
      failure,
    )).rejects.toThrow("No thread");
  });

});

describe("Mini App bootstrap", () => {
  it("loads the Telegram Web App bridge before the Svelte entrypoint", async () => {
    const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    expect(html).toMatch(
      /telegram-web-app\.js[\s\S]*<script type="module" src="\/src\/main\.ts"><\/script>/,
    );
  });
});

describe("Mini App responsive theme", () => {
  it("uses Carbon layer tokens without leaking Svelte selectors into global CSS", async () => {
    const css = await readFile(new URL("../web/src/app.css", import.meta.url), "utf8");

    expect(css).not.toContain("--cds-layer-01");
    expect(css).not.toContain(":global(");
    expect(css).toContain("background: var(--cds-layer, #262626)");
  });

  it("clamps session titles and keeps swipe actions inside narrow Telegram viewports", async () => {
    const css = await readFile(new URL("../web/src/app.css", import.meta.url), "utf8");
    const row = await readFile(new URL("../web/src/ThreadRow.svelte", import.meta.url), "utf8");
    const app = await readFile(new URL("../web/src/App.svelte", import.meta.url), "utf8");

    expect(css).toMatch(/html, body, #app\s*\{[^}]*width:\s*100%[^}]*overflow-x:\s*hidden/s);
    expect(css).toMatch(/\.thread h2\s*\{[^}]*-webkit-line-clamp:\s*2/s);
    expect(css).toMatch(/\.thread__surface\s*\{[^}]*touch-action:\s*pan-y/s);
    expect(row).toContain("on:pointerdown");
    expect(row).toContain("thread__swipe-action--codex");
    expect(row).toContain("thread__swipe-action--telegram");
    expect(row).toContain("on:focus={() => onReveal");
    expect(row).not.toContain("children");
    expect(row).not.toContain("ButtonSet");
    expect(row).not.toContain('role={thread.codexUrl ? "button"');
    expect(app).toContain("revealedSwipe");
  });

  it("renders three Jira-like scrollable views and virtualizes the session list", async () => {
    const app = await readFile(new URL("../web/src/App.svelte", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/src/app.css", import.meta.url), "utf8");
    const list = await readFile(new URL("../web/src/SessionList.svelte", import.meta.url), "utf8");

    expect(app).toContain("Активные");
    expect(app).toContain("Недавние");
    expect(app).toContain("Зависшие и ожидающие");
    expect(app).toContain("dashboardPollInterval");
    expect(app).toContain("await ensureThreadTopic(session.id, initData)");
    expect(app).not.toContain("if (session.telegramUrl)");
    expect(app).not.toContain("Canonical");
    expect(app).not.toContain("Runtime status");
    expect(list).toContain("createVirtualizer");
    expect(list).toContain("loadMore");
    expect(css).toMatch(/\.dashboard__tabs\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px/s);
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("keeps every Jira workflow status in one scrollable row on wide screens", async () => {
    const css = await readFile(new URL("../web/src/jira.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.jira\s*\{[^}]*max-width:\s*48rem/s);
    expect(css).toMatch(
      /@media\s*\(min-width:\s*64rem\)\s*\{[\s\S]*\.jira\.jira--wide\s*\{[^}]*max-width:\s*none[^}]*\}[\s\S]*\.jira-groups\s*\{[^}]*grid-auto-flow:\s*column[^}]*grid-auto-columns:\s*minmax\(15rem,\s*1fr\)[^}]*overflow-x:\s*auto[^}]*align-items:\s*start/s,
    );
  });

  it("renders assignee initials as compact Carbon chips without avatar loading", async () => {
    const card = await readFile(new URL("../web/src/JiraApp.svelte", import.meta.url), "utf8");
    const detail = await readFile(new URL("../web/src/JiraIssueDetail.svelte", import.meta.url), "utf8");
    const api = await readFile(new URL("../web/src/jira-api.ts", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/src/jira.css", import.meta.url), "utf8");

    expect(card).toMatch(/jira-assignee-chip[\s\S]*assigneeInitials\(issue\.assignee\)/);
    expect(detail).toMatch(/jira-assignee-chip[\s\S]*assigneeInitials\(issue\.assignee\)/);
    expect(card).not.toContain("JiraAssignee");
    expect(detail).not.toContain("JiraAssignee");
    expect(api).not.toContain("loadJiraAssigneeAvatar");
    expect(css).toMatch(/\.jira-assignee-chip\s+\.bx--tag\s*\{[^}]*margin:\s*0/s);
  });

  it("pairs assignee and status filters responsively in the current sprint", async () => {
    const app = await readFile(new URL("../web/src/JiraApp.svelte", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/src/jira.css", import.meta.url), "utf8");

    expect(app).toMatch(/jira__sprint-filters[\s\S]*bind:selectedIds=\{selectedAssigneeIds\}[\s\S]*bind:selectedIds=\{selectedStatusIds\}/);
    expect(app).toContain('labelText="Фильтр по статусу"');
    expect(app.match(/filterable=\{true\}/g)).toHaveLength(2);
    expect(app).not.toContain('type="inline"');
    expect(css).toMatch(/\.jira__sprint-filters\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*14rem\)\)[^}]*gap:\s*0\.25rem/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*40rem\)\s*\{[\s\S]*\.jira__sprint-filters\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  });

});

describe("Jira Mini App routing and model", () => {
  it("selects Jira from either its path or Telegram start parameter", () => {
    expect(resolveMiniAppRoute("/jira", "", undefined)).toBe("jira");
    expect(resolveMiniAppRoute("/", "?tgWebAppStartParam=jira", undefined)).toBe("jira");
    expect(resolveMiniAppRoute("/", "", "jira")).toBe("jira");
    expect(resolveMiniAppRoute("/", "", "dashboard")).toBe("dashboard");
  });

  it("groups Jira issues in the product workflow order", () => {
    const issues: JiraIssue[] = [
      { key: "MIR-7", summary: "Done", status: "Готово", status_category: "done", url: "https://jira/MIR-7" },
      { key: "MIR-5", summary: "QA", status: "In QA", url: "https://jira/MIR-5" },
      { key: "MIR-2", summary: "Blocked", status: "Blocked", url: "https://jira/MIR-2" },
      { key: "MIR-4", summary: "For QA", status: "For QA", url: "https://jira/MIR-4" },
      { key: "MIR-1", summary: "Todo", status: "Сделать", status_category: "new", url: "https://jira/MIR-1" },
      { key: "MIR-6", summary: "Verification", status: "For verification", url: "https://jira/MIR-6" },
      { key: "MIR-3", summary: "Work", status: "В работе", status_category: "indeterminate", url: "https://jira/MIR-3" },
      { key: "MIR-8", summary: "Custom", status: "Уточнение", url: "https://jira/MIR-8" },
    ];

    expect(groupIssuesByStatus(issues).map((group) => group.status)).toEqual([
      "Сделать",
      "Blocked",
      "В работе",
      "For QA",
      "In QA",
      "For verification",
      "Готово",
      "Уточнение",
    ]);
  });

  it("keeps only the latest async tab request and reports Jira totals", () => {
    const gate = createRequestGate();
    const first = gate.start();
    const second = gate.start();

    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
    gate.invalidate();
    expect(gate.isLatest(second)).toBe(false);
    expect(jiraResultCount({
      total: 125,
      issues: [],
      cached: true,
      stale: false,
      cache_age_seconds: 10,
    })).toBe(125);
  });

  it("builds assignee options and filters the current sprint by several people", () => {
    const issues: JiraIssue[] = [
      { key: "MIR-1", summary: "Anton 1", status: "Сделать", assignee: "Anton Vinogradov", url: "https://jira/MIR-1" },
      { key: "MIR-2", summary: "Olga", status: "В работе", assignee: "Ольга Петрова", url: "https://jira/MIR-2" },
      { key: "MIR-3", summary: "Anton 2", status: "For QA", assignee: "Anton Vinogradov", url: "https://jira/MIR-3" },
      { key: "MIR-4", summary: "Free", status: "Сделать", url: "https://jira/MIR-4" },
    ];

    expect(jiraAssigneeOptions(issues)).toEqual([
      { id: "Anton Vinogradov", text: "Anton Vinogradov" },
      { id: "Ольга Петрова", text: "Ольга Петрова" },
      { id: UNASSIGNED_ASSIGNEE_ID, text: "Не назначен" },
    ]);
    expect(filterIssuesByAssignees(issues, ["Anton Vinogradov", UNASSIGNED_ASSIGNEE_ID])
      .map((issue) => issue.key)).toEqual(["MIR-1", "MIR-3", "MIR-4"]);
    expect(filterIssuesByAssignees(issues, [])).toEqual(issues);
    expect(assigneeInitials("Anton Vinogradov")).toBe("AV");
    expect(assigneeInitials(undefined)).toBe("?");
  });

  it("builds workflow-ordered status options and combines sprint filters", () => {
    const issues: JiraIssue[] = [
      { key: "MIR-1", summary: "Anton todo", status: "Сделать", assignee: "Anton Vinogradov", url: "https://jira/MIR-1" },
      { key: "MIR-2", summary: "Olga work", status: "В работе", assignee: "Ольга Петрова", url: "https://jira/MIR-2" },
      { key: "MIR-3", summary: "Anton QA", status: "For QA", assignee: "Anton Vinogradov", url: "https://jira/MIR-3" },
      { key: "MIR-4", summary: "Anton blocked", status: "Blocked", assignee: "Anton Vinogradov", url: "https://jira/MIR-4" },
    ];

    expect(jiraStatusOptions(issues)).toEqual([
      { id: "Сделать", text: "Сделать" },
      { id: "Blocked", text: "Blocked" },
      { id: "В работе", text: "В работе" },
      { id: "For QA", text: "For QA" },
    ]);
    expect(filterIssuesByStatuses(issues, ["Blocked", "For QA"])
      .map((issue) => issue.key)).toEqual(["MIR-3", "MIR-4"]);
    expect(filterIssuesByStatuses(
      filterIssuesByAssignees(issues, ["Anton Vinogradov"]),
      ["For QA"],
    ).map((issue) => issue.key)).toEqual(["MIR-3"]);
    expect(filterIssuesByStatuses(issues, [])).toEqual(issues);
  });
});

describe("Jira Mini App API client", () => {
  it("loads a selected Jira view with Telegram auth and refresh", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ issues: [] }), { status: 200 }));

    await loadJiraView("my-sprint", "signed-data", { refresh: true }, fetcher);
    await loadJiraView("filter", "signed-data", { filterId: "11525" }, fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/jira/my-sprint?refresh=1", {
      headers: { "x-telegram-init-data": "signed-data" },
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/jira/filters/11525", {
      headers: { "x-telegram-init-data": "signed-data" },
    });
  });

  it("loads issue details and creates or reuses its Telegram thread", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      key: "MIR-6886",
      created: false,
      url: "https://t.me/c/123/42",
    }), { status: 200 }));

    await loadJiraIssue("MIR-6886", "signed-data", false, fetcher);
    await ensureJiraThread("MIR-6886", "signed-data", fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/jira/issues/MIR-6886", {
      headers: { "x-telegram-init-data": "signed-data" },
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/jira/issues/MIR-6886/thread", {
      method: "POST",
      headers: { "x-telegram-init-data": "signed-data" },
    });
  });

  it("always validates the Jira thread before opening its Telegram URL", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      created: false,
      url: "https://t.me/c/123/42",
    }), { status: 200 }));
    const open = vi.fn();

    await openJiraIssueThread("MIR-6886", "signed-data", open, fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/jira/issues/MIR-6886/thread", {
      method: "POST",
      headers: { "x-telegram-init-data": "signed-data" },
    });
    expect(open).toHaveBeenCalledWith("https://t.me/c/123/42");
  });

  it("does not open Telegram after the issue operation was invalidated", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      created: false,
      url: "https://t.me/c/123/42",
    }), { status: 200 }));
    const open = vi.fn();

    await openJiraIssueThread("MIR-6886", "signed-data", open, fetcher, () => false);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});
