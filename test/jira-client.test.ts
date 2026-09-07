import { describe, expect, it, vi } from "vitest";

import { JiraClient } from "../src/jira-client.js";

describe("JiraClient", () => {
  it("gets one issue by key and refreshes Jira data", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      key: "MIR-6789",
      summary: "Лист замера",
      status: "В работе",
      priority: "High",
      assignee: "Anton Vinogradov",
      url: "https://jira.fashionhouse.by/browse/MIR-6789",
      cached: false,
      stale: false,
      cache_age_seconds: 0,
      description: "Описание задачи",
      comments: [],
    }));
    const client = new JiraClient("/opt/jira-client", execute);

    const result = await client.getIssue("mir-6789", true);

    expect(execute).toHaveBeenCalledWith("/opt/jira-client", [
      "issue",
      "MIR-6789",
      "--refresh",
    ]);
    expect(result.summary).toBe("Лист замера");
  });

  it("rejects an invalid issue key without launching jira-client", async () => {
    const execute = vi.fn();
    const client = new JiraClient("jira-client", execute);

    await expect(client.getIssue("../../etc/passwd", true))
      .rejects.toThrow("Invalid Jira issue key");
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs sprint through the configured executable and parses JSON", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      total: 1,
      issues: [{
        key: "MIR-6789",
        summary: "Лист замера",
        status: "В работе",
        url: "https://jira.fashionhouse.by/browse/MIR-6789",
      }],
      sprints: [{ id: 245, name: "Mircli sprint 62", state: "ACTIVE" }],
      cached: true,
      stale: false,
      cache_age_seconds: 120,
    }));
    const client = new JiraClient("/opt/jira-client", execute);

    const result = await client.getSprint(false);

    expect(execute).toHaveBeenCalledWith("/opt/jira-client", [
      "sprint",
      "--project",
      "MIR",
      "--limit",
      "500",
    ]);
    expect(result.issues[0]?.key).toBe("MIR-6789");
  });

  it("loads one MIR backlog page with newest issues first", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      jql: "project = MIR AND statusCategory != Done AND (sprint IS EMPTY OR sprint in futureSprints()) ORDER BY created DESC, key DESC",
      total: 380,
      start_at: 50,
      limit: 50,
      returned: 1,
      issues: [{
        key: "MIR-190",
        summary: "Backlog task",
        status: "Сделать",
        url: "https://jira.fashionhouse.by/browse/MIR-190",
      }],
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }));
    const client = new JiraClient("/opt/jira-client", execute);

    const result = await client.getBacklog(50, 50, true);

    expect(execute).toHaveBeenCalledWith("/opt/jira-client", [
      "search",
      "project = MIR AND statusCategory != Done AND (sprint IS EMPTY OR sprint in futureSprints()) ORDER BY created DESC, key DESC",
      "--start-at",
      "50",
      "--limit",
      "50",
      "--refresh",
    ]);
    expect(result).toMatchObject({ total: 380, start_at: 50, returned: 1 });
  });

  it("rejects unsafe backlog page boundaries without launching jira-client", async () => {
    const execute = vi.fn();
    const client = new JiraClient("jira-client", execute);

    await expect(client.getBacklog(-1, 50, false)).rejects.toThrow("Invalid Jira backlog page");
    await expect(client.getBacklog(0, 101, false)).rejects.toThrow("Invalid Jira backlog page");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a malformed backlog page returned by the external client", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      jql: "project = MIR",
      total: 1,
      start_at: -1,
      limit: 50,
      returned: 2,
      issues: [],
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }));
    const client = new JiraClient("jira-client", execute);

    await expect(client.getBacklog(0, 50, false)).rejects.toThrow("invalid backlog response");
  });

  it("rejects a backlog page that does not match the requested cursor and query", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      jql: "project = OTHER",
      total: 100,
      start_at: 50,
      limit: 100,
      returned: 51,
      issues: Array.from({ length: 51 }, (_, index) => ({
        key: `MIR-${index + 1}`,
        summary: "Task",
        status: "Сделать",
        url: `https://jira.fashionhouse.by/browse/MIR-${index + 1}`,
      })),
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }));
    const client = new JiraClient("jira-client", execute);

    await expect(client.getBacklog(0, 50, false)).rejects.toThrow("invalid backlog response");
  });

  it("bypasses the cache when refresh is requested", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      title: "Мой спринт",
      total: 0,
      columns: [],
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }));
    const client = new JiraClient("jira-client", execute);

    await client.getKanban(true);

    expect(execute).toHaveBeenCalledWith("jira-client", [
      "kanban",
      "Мой спринт",
      "--limit",
      "100",
      "--json",
      "--refresh",
    ]);
  });

  it("runs a saved filter by numeric id", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      total: 0,
      issues: [],
      filter: { id: "11525", name: "Мой спринт" },
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }));
    const client = new JiraClient("jira-client", execute);

    await client.runFilter("11525", true);

    expect(execute).toHaveBeenCalledWith("jira-client", [
      "filter",
      "11525",
      "--limit",
      "100",
      "--refresh",
    ]);
  });

  it("runs the My Sprint saved filter by name", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      total: 0,
      issues: [],
      filter: { id: "11525", name: "Мой спринт" },
      cached: true,
      stale: false,
      cache_age_seconds: 60,
    }));
    const client = new JiraClient("jira-client", execute);

    await client.getMySprint(false);

    expect(execute).toHaveBeenCalledWith("jira-client", [
      "filter",
      "Мой спринт",
      "--limit",
      "100",
    ]);
  });

  it("rejects invalid JSON without exposing raw output", async () => {
    const execute = vi.fn().mockResolvedValue("not-json");
    const client = new JiraClient("jira-client", execute);

    await expect(client.getFilters(false)).rejects.toThrow("invalid JSON");
  });

  it("rejects JSON with the wrong response shape", async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify({ total: 1 }));
    const client = new JiraClient("jira-client", execute);

    await expect(client.getSprint(false)).rejects.toThrow("invalid sprint response");
  });
});
