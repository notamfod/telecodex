import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runDeveloperWorkloadRecipe: vi.fn(async (_recipe: unknown, send: (html: string) => Promise<void>) => {
    await send("<b>Нагрузка</b>"); return { message: "<b>Нагрузка</b>" };
  }),
  sendRecipeMessage: vi.fn(),
}));
vi.mock("../src/developer-workload-recipe.js", () => ({ runDeveloperWorkloadRecipe: mocks.runDeveloperWorkloadRecipe }));
vi.mock("../src/recipe-telegram.js", () => ({ sendRecipeMessage: mocks.sendRecipeMessage }));

const originalArgv = process.argv;
const originalConfig = process.env.RECIPES_CONFIG;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalCwd = process.cwd();
afterEach(() => {
  process.argv = originalArgv;
  if (originalConfig === undefined) delete process.env.RECIPES_CONFIG; else process.env.RECIPES_CONFIG = originalConfig;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  process.chdir(originalCwd); mocks.runDeveloperWorkloadRecipe.mockClear(); mocks.sendRecipeMessage.mockReset(); vi.resetModules();
});

it("launches the developer workload recipe without allowing Jira writes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "telecodex-workload-run-"));
  const config = path.join(directory, "recipes.json");
  writeFileSync(config, JSON.stringify({ recipes: [{ id: "weekly-developer-workload", kind: "developer-workload", cwd: directory, jiraClient: "/usr/bin/jira-client", capacityHours: 30, fromStatus: "In Progress", completionStatuses: ["For QA"], deliver: { chatId: -100123, messageThreadId: 42 } }] }));
  process.argv = ["node", "src/recipe-run.ts", "weekly-developer-workload"];
  process.env.RECIPES_CONFIG = config; process.env.TELEGRAM_BOT_TOKEN = "bot-token"; process.chdir(directory);
  try {
    await import("../src/recipe-run.js");
    await vi.waitFor(() => expect(mocks.runDeveloperWorkloadRecipe).toHaveBeenCalledOnce());
    expect(mocks.sendRecipeMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "weekly-developer-workload" }), "<b>Нагрузка</b>");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
