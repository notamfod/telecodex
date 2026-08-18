import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runJiraFilterRecipe } from "../src/jira-recipe.js";
import type { JiraFilterRecipe } from "../src/recipe-config.js";

const recipe: JiraFilterRecipe = {
  id: "hourly-jira-new-issues",
  kind: "jira-filter",
  cwd: "/root/dev/Projects/mircli",
  jiraClient: "/opt/jira-client",
  filterId: "11525",
  deliver: { chatId: -1003981282865, messageThreadId: 999 },
};

const issue = (key: string, summary = `Задача ${key}`) => ({
  key,
  summary,
  status: "В работе",
  priority: "High",
  assignee: "Anton Vinogradov",
  url: `https://jira.fashionhouse.by/browse/${key}`,
});

const snapshot = (...issues: ReturnType<typeof issue>[]) => JSON.stringify({
  filter: { id: "11525", name: "Мой спринт" },
  total: issues.length,
  issues,
  cached: false,
  stale: false,
  cache_age_seconds: 0,
});

function stateKeys(file: string): string[] {
  return JSON.parse(readFileSync(file, "utf8")).seenIssueKeys;
}

describe("runJiraFilterRecipe", () => {
  it("sends every issue on the first run and records each delivered key", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-jira-recipe-"));
    const statePath = path.join(dir, "state.json");
    const execute = vi.fn().mockResolvedValue(snapshot(
      issue("MIR-100", "Цена < лимита"),
      issue("MIR-101"),
    ));
    const send = vi.fn().mockResolvedValue(undefined);

    try {
      const result = await runJiraFilterRecipe(recipe, send, { execute, statePath });

      expect(result).toEqual({ total: 2, delivered: 2, repeated: 0 });
      expect(execute).toHaveBeenCalledWith(
        "/opt/jira-client",
        ["filter", "11525", "--limit", "100", "--refresh"],
        "/root/dev/Projects/mircli",
      );
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]?.[0]).toContain("Цена &lt; лимита");
      expect(send.mock.calls[0]?.[1]).toEqual({
        inline_keyboard: [[
          {
            text: "🧵 Создать тред",
            callback_data: "jtask:hourly-jira-new-issues:MIR-100",
          },
          {
            text: "Открыть в Jira",
            url: "https://jira.fashionhouse.by/browse/MIR-100",
          },
        ]],
      });
      expect(stateKeys(statePath)).toEqual(["MIR-100", "MIR-101"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent for issue keys recorded by an earlier run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-jira-recipe-"));
    const statePath = path.join(dir, "state.json");
    const execute = vi.fn().mockResolvedValue(snapshot(issue("MIR-100")));
    const send = vi.fn().mockResolvedValue(undefined);

    try {
      await runJiraFilterRecipe(recipe, send, { execute, statePath });
      send.mockClear();

      const result = await runJiraFilterRecipe(recipe, send, { execute, statePath });

      expect(result).toEqual({ total: 1, delivered: 0, repeated: 1 });
      expect(send).not.toHaveBeenCalled();
      expect(stateKeys(statePath)).toEqual(["MIR-100"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records successful sends before a partial Telegram failure", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-jira-recipe-"));
    const statePath = path.join(dir, "state.json");
    const execute = vi.fn().mockResolvedValue(snapshot(
      issue("MIR-100"),
      issue("MIR-101"),
      issue("MIR-102"),
    ));
    const send = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Telegram unavailable"));

    try {
      await expect(runJiraFilterRecipe(recipe, send, { execute, statePath }))
        .rejects.toThrow("Telegram unavailable");
      expect(stateKeys(statePath)).toEqual(["MIR-100"]);

      send.mockReset();
      send.mockResolvedValue(undefined);
      const result = await runJiraFilterRecipe(recipe, send, { execute, statePath });

      expect(result).toEqual({ total: 3, delivered: 2, repeated: 1 });
      expect(send.mock.calls.map(([html]) => html)).toEqual([
        expect.stringContaining("MIR-101"),
        expect.stringContaining("MIR-102"),
      ]);
      expect(stateKeys(statePath)).toEqual(["MIR-100", "MIR-101", "MIR-102"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed client output without sending or creating state", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-jira-recipe-"));
    const statePath = path.join(dir, "state.json");
    const execute = vi.fn().mockResolvedValue("not-json");
    const send = vi.fn().mockResolvedValue(undefined);

    try {
      await expect(runJiraFilterRecipe(recipe, send, { execute, statePath }))
        .rejects.toThrow(/invalid JSON/i);
      expect(send).not.toHaveBeenCalled();
      expect(() => readFileSync(statePath)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an issue without a safe Jira link before sending anything", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-jira-recipe-"));
    const statePath = path.join(dir, "state.json");
    const unsafe = { ...issue("MIR-100"), url: "javascript:alert(1)" };
    const execute = vi.fn().mockResolvedValue(snapshot(unsafe));
    const send = vi.fn().mockResolvedValue(undefined);

    try {
      await expect(runJiraFilterRecipe(recipe, send, { execute, statePath }))
        .rejects.toThrow(/issues\[0\]\.url/);
      expect(send).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
