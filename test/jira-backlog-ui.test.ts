import { readFile } from "node:fs/promises";
import * as jiraApi from "../web/src/jira-api.js";
import * as jiraModel from "../web/src/jira-model.js";
import type { JiraIssue } from "../web/src/jira-model.js";

describe("Jira backlog UI", () => {
  it("loads one authenticated Jira backlog page with bounded paging parameters", async () => {
    const loadJiraBacklog = (jiraApi as typeof jiraApi & {
      loadJiraBacklog?: (
        initData: string,
        options: { startAt: number; limit: number; refresh?: boolean },
        fetcher: typeof fetch,
      ) => Promise<unknown>;
    }).loadJiraBacklog;
    expect(loadJiraBacklog).toBeTypeOf("function");
    if (!loadJiraBacklog) return;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      total: 380,
      start_at: 50,
      limit: 50,
      returned: 0,
      issues: [],
      cached: true,
      stale: false,
      cache_age_seconds: 10,
    }), { status: 200 }));

    await loadJiraBacklog("signed-data", { startAt: 50, limit: 50, refresh: true }, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/jira/backlog?startAt=50&limit=50&refresh=1",
      { headers: { "x-telegram-init-data": "signed-data" } },
    );
  });

  it("renders the backlog through a dynamically measured virtual list", async () => {
    const app = await readFile(new URL("../web/src/JiraApp.svelte", import.meta.url), "utf8");
    const list = await readFile(
      new URL("../web/src/JiraBacklogList.svelte", import.meta.url),
      "utf8",
    );
    const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");

    expect(app).toContain('{ id: "backlog", label: "Бэклог" }');
    expect(app).toContain("JiraBacklogList");
    expect(list).toContain("@tanstack/svelte-virtual");
    expect(list).toContain("createVirtualizer");
    expect(list).toContain("updateVirtualizer(issues, viewport)");
    expect(list).toContain("measureElement");
    expect(list).toContain("overscan");
    expect(list).toContain("loadNext");
    expect(list).toContain("loadingNext");
    expect(list).toContain("export let hasMore: boolean");
    expect(list).toContain("export let loadedCount: number");
    expect(list).toContain("export let pagingBlocked: boolean");
    expect(list).toContain("autoRequestedCursor");
    expect(list).toMatch(/destroy\(\)[\s\S]*measureElement\(null\)/);
    expect(list).toContain("queueMicrotask");
    expect(app).toContain("startAt: current.returned");
    expect(app).toContain("loadedCount={backlogResult.returned}");
    expect(app).toContain("pagingBlocked={refreshing}");
    expect(app).toContain("refresh: backlogRefreshPaging");
    expect(app).toMatch(/if \(!current \|\| refreshing \|\| backlogLoadingNext/);
    expect(packageJson).toContain('"@tanstack/svelte-virtual"');
  });

  it("keeps the measured virtual backlog mounted while issue details are open", async () => {
    const app = await readFile(new URL("../web/src/JiraApp.svelte", import.meta.url), "utf8");

    expect(app).toMatch(/{#if selectedIssue}[\s\S]*{\/if}\s*{#if view === "backlog" && backlogResult}/);
    expect(app).toContain("hidden={Boolean(selectedIssue)}");
  });

  it("uses the server cursor, not unique card count, to unlock automatic paging", () => {
    const shouldRequestNextBacklog = (jiraModel as typeof jiraModel & {
      shouldRequestNextBacklog?: (
        hasMore: boolean,
        loadingNext: boolean,
        requestedCursor: number,
        loadedCount: number,
      ) => boolean;
    }).shouldRequestNextBacklog;
    expect(shouldRequestNextBacklog).toBeTypeOf("function");
    if (!shouldRequestNextBacklog) return;

    expect(shouldRequestNextBacklog(true, false, 50, 50)).toBe(false);
    expect(shouldRequestNextBacklog(true, false, 50, 100)).toBe(true);
    expect(shouldRequestNextBacklog(false, false, 50, 100)).toBe(false);
  });

  it("maps individual backlog statuses to the existing Carbon rail colors", () => {
    const jiraIssueStatusType = (jiraModel as typeof jiraModel & {
      jiraIssueStatusType?: (issue: JiraIssue) => string;
    }).jiraIssueStatusType;
    expect(jiraIssueStatusType).toBeTypeOf("function");
    if (!jiraIssueStatusType) return;

    expect(jiraIssueStatusType({
      key: "MIR-1", summary: "Blocked", status: "Blocked", url: "https://jira/MIR-1",
    })).toBe("red");
    expect(jiraIssueStatusType({
      key: "MIR-2", summary: "Work", status: "В работе", status_category: "indeterminate", url: "https://jira/MIR-2",
    })).toBe("purple");
    expect(jiraIssueStatusType({
      key: "MIR-3", summary: "Todo", status: "Сделать", status_category: "new", url: "https://jira/MIR-3",
    })).toBe("blue");
  });

  it("merges consecutive backlog pages in Jira rank order without duplicate issues", () => {
    const mergeBacklogPage = (jiraModel as typeof jiraModel & {
      mergeBacklogPage?: (current: unknown, next: unknown) => {
        total: number;
        returned: number;
        issues: JiraIssue[];
      };
    }).mergeBacklogPage;
    expect(mergeBacklogPage).toBeTypeOf("function");
    if (!mergeBacklogPage) return;
    const metadata = { cached: false, stale: false, cache_age_seconds: 0 };
    const first = {
      ...metadata,
      total: 3,
      start_at: 0,
      limit: 2,
      returned: 2,
      issues: [
        { key: "MIR-1", summary: "First", status: "Сделать", url: "https://jira/MIR-1" },
        { key: "MIR-2", summary: "Second", status: "Сделать", url: "https://jira/MIR-2" },
      ],
    };
    const second = {
      ...metadata,
      total: 3,
      start_at: 2,
      limit: 2,
      returned: 2,
      issues: [
        { key: "MIR-2", summary: "Second", status: "Сделать", url: "https://jira/MIR-2" },
        { key: "MIR-3", summary: "Third", status: "Сделать", url: "https://jira/MIR-3" },
      ],
    };

    const merged = mergeBacklogPage(first, second);

    expect(merged.total).toBe(3);
    expect(merged.returned).toBe(4);
    expect(merged.issues.map((issue) => issue.key)).toEqual(["MIR-1", "MIR-2", "MIR-3"]);
  });
});
