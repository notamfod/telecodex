import { describe, expect, it, vi } from "vitest";

import {
  createJiraMiniAppController,
  type JiraMiniAppThreadResult,
} from "../src/jira-mini-app.js";
import type { JiraClientPort, JiraIssueResult } from "../src/jira-client.js";

const issue: JiraIssueResult = {
  key: "MIR-6886",
  summary: "Услуги должны учитывать выбранный город",
  status: "В работе",
  status_category: "indeterminate",
  assignee: "Anton Vinogradov",
  priority: "High",
  issue_type: "Задача",
  url: "https://jira.example.test/browse/MIR-6886",
  description: "Описание задачи",
  comments: [{ author: "Ольга", created: "2026-08-19T09:41:18.000+0000", body: "Ждём дизайн" }],
  cached: false,
  stale: false,
  cache_age_seconds: 0,
};

function source(): JiraClientPort {
  return {
    getIssue: vi.fn(async () => issue),
    getMySprint: vi.fn(async () => ({
      total: 1,
      issues: [issue],
      filter: { id: "11525", name: "Мой спринт" },
      cached: true,
      stale: false,
      cache_age_seconds: 120,
    })),
    getSprint: vi.fn(async () => ({
      total: 1,
      issues: [issue],
      sprints: [{ id: 246, name: "Mircli sprint 63", state: "ACTIVE" }],
      cached: true,
      stale: false,
      cache_age_seconds: 120,
    })),
    getBacklog: vi.fn(async () => ({
      jql: "project = MIR",
      total: 380,
      start_at: 50,
      limit: 50,
      returned: 1,
      issues: [issue],
      cached: true,
      stale: false,
      cache_age_seconds: 120,
    })),
    getKanban: vi.fn(async () => ({
      title: "Мой спринт",
      total: 1,
      columns: [{ status: "В работе", count: 1, issues: [issue] }],
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    })),
    getFilters: vi.fn(async () => ({
      count: 1,
      filters: [{ id: "11525", name: "Мой спринт", url: "https://jira.example.test/filter/11525" }],
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    })),
    runFilter: vi.fn(async () => ({
      total: 1,
      issues: [issue],
      filter: { id: "11525", name: "Мой спринт" },
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    })),
  };
}

describe("Jira Mini App controller", () => {
  it("loads My Sprint and decorates issues with existing Telegram threads", async () => {
    const client = source();
    const controller = createJiraMiniAppController({
      client,
      findThreadUrl: (key) => key === "MIR-6886" ? "https://t.me/c/123/42" : undefined,
      openThread: vi.fn(),
    });

    await expect(controller.getMySprint(false)).resolves.toMatchObject({
      filter: { id: "11525", name: "Мой спринт" },
      issues: [{ key: "MIR-6886", telegramUrl: "https://t.me/c/123/42" }],
      cached: true,
    });
    expect(client.getMySprint).toHaveBeenCalledWith(false);
  });

  it("decorates kanban columns and selected saved filters", async () => {
    const controller = createJiraMiniAppController({
      client: source(),
      findThreadUrl: () => "https://t.me/c/123/42",
      openThread: vi.fn(),
    });

    await expect(controller.getKanban(true)).resolves.toMatchObject({
      columns: [{ issues: [{ key: "MIR-6886", telegramUrl: "https://t.me/c/123/42" }] }],
    });
    await expect(controller.runFilter("11525", false)).resolves.toMatchObject({
      filter: { id: "11525" },
      issues: [{ key: "MIR-6886", telegramUrl: "https://t.me/c/123/42" }],
    });
  });

  it("loads a backlog page and decorates its existing Telegram threads", async () => {
    const client = source();
    const controller = createJiraMiniAppController({
      client,
      findThreadUrl: () => "https://t.me/c/123/42",
      openThread: vi.fn(),
    });

    await expect(controller.getBacklog(50, 50, false)).resolves.toMatchObject({
      total: 380,
      start_at: 50,
      issues: [{ key: "MIR-6886", telegramUrl: "https://t.me/c/123/42" }],
    });
    expect(client.getBacklog).toHaveBeenCalledWith(50, 50, false);
  });

  it("returns issue details with description, comments and thread state", async () => {
    const controller = createJiraMiniAppController({
      client: source(),
      findThreadUrl: () => "https://t.me/c/123/42",
      openThread: vi.fn(),
    });

    await expect(controller.getIssue("MIR-6886", false)).resolves.toMatchObject({
      key: "MIR-6886",
      description: "Описание задачи",
      comments: [{ author: "Ольга", body: "Ждём дизайн" }],
      telegramUrl: "https://t.me/c/123/42",
    });
  });

  it("refreshes the issue before creating or reusing its thread", async () => {
    const client = source();
    const result: JiraMiniAppThreadResult = {
      created: false,
      url: "https://t.me/c/123/42",
    };
    const openThread = vi.fn(async () => result);
    const controller = createJiraMiniAppController({
      client,
      findThreadUrl: () => undefined,
      openThread,
    });

    await expect(controller.ensureThread("mir-6886")).resolves.toEqual(result);
    expect(client.getIssue).toHaveBeenCalledWith("MIR-6886", true);
    expect(openThread).toHaveBeenCalledWith(issue);
  });
});
