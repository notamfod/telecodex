import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runJiraFilterRecipe: vi.fn(async (
    recipe: unknown,
    send: (html: string, replyMarkup: Record<string, unknown>) => Promise<void>,
  ) => {
    await send("<b>MIR-7000</b>", { inline_keyboard: [] });
    return { total: 10, delivered: 1, repeated: 9 };
  }),
  sendRecipeMessage: vi.fn(),
}));

vi.mock("../src/jira-recipe.js", () => ({
  runJiraFilterRecipe: mocks.runJiraFilterRecipe,
}));

vi.mock("../src/recipe-telegram.js", () => ({
  sendRecipeMessage: mocks.sendRecipeMessage,
}));

describe("Jira recipe launcher lifecycle", () => {
  const originalArgv = process.argv;
  const originalRecipesConfig = process.env.RECIPES_CONFIG;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalLaunchUrl = process.env.MINI_APP_LAUNCH_URL;
  const originalPanelChatId = process.env.JIRA_PANEL_CHAT_ID;
  const originalPanelTopicId = process.env.JIRA_PANEL_TOPIC_ID;
  const originalCwd = process.cwd();

  afterEach(() => {
    process.argv = originalArgv;
    restoreEnv("RECIPES_CONFIG", originalRecipesConfig);
    restoreEnv("TELEGRAM_BOT_TOKEN", originalToken);
    restoreEnv("MINI_APP_LAUNCH_URL", originalLaunchUrl);
    restoreEnv("JIRA_PANEL_CHAT_ID", originalPanelChatId);
    restoreEnv("JIRA_PANEL_TOPIC_ID", originalPanelTopicId);
    process.chdir(originalCwd);
    mocks.runJiraFilterRecipe.mockClear();
    mocks.sendRecipeMessage.mockReset();
    vi.resetModules();
  });

  it("leaves the launcher untouched during an automatic Jira recipe run", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-recipe-run-"));
    const configPath = path.join(directory, "recipes.json");
    writeFileSync(configPath, JSON.stringify({
      recipes: [{
        id: "hourly-jira-new-issues",
        kind: "jira-filter",
        cwd: directory,
        jiraClient: "/usr/bin/jira-client",
        filterId: "12345",
        deliver: { chatId: -100123, messageThreadId: 42 },
      }],
    }));

    process.argv = ["node", "src/recipe-run.ts", "hourly-jira-new-issues"];
    process.env.RECIPES_CONFIG = configPath;
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.MINI_APP_LAUNCH_URL = "https://t.me/dofmatbot/dashboard";
    process.env.JIRA_PANEL_CHAT_ID = "-100123";
    process.env.JIRA_PANEL_TOPIC_ID = "42";
    process.chdir(directory);

    try {
      await import("../src/recipe-run.js");
      await vi.waitFor(() => expect(mocks.runJiraFilterRecipe).toHaveBeenCalledOnce());

      expect(mocks.sendRecipeMessage).toHaveBeenCalledOnce();
      expect(mocks.sendRecipeMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "hourly-jira-new-issues" }),
        "<b>MIR-7000</b>",
        { inline_keyboard: [] },
      );
      expect(existsSync(path.join(directory, ".telecodex", "jira-panel.json"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
