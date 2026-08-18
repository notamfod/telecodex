import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { escapeHTML } from "./format.js";
import type { JiraFilterRecipe } from "./recipe-config.js";
import { jiraTaskCallbackData } from "./jira-task-thread.js";

const run = promisify(execFile);
const DEFAULT_STATE_DIR = ".telecodex/jira-recipes";

interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  priority?: string;
  assignee?: string;
  url: string;
}

interface JiraRecipeState {
  seenIssueKeys: string[];
}

export interface JiraRecipeResult {
  total: number;
  delivered: number;
  repeated: number;
}

type ExecuteJiraClient = (command: string, args: string[], cwd: string) => Promise<string>;
type SendJiraIssue = (html: string, replyMarkup?: Record<string, unknown>) => Promise<void>;

interface JiraRecipeDependencies {
  execute?: ExecuteJiraClient;
  statePath?: string;
}

async function executeJiraClient(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await run(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`jira-client response needs ${field}`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requireHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`jira-client response needs ${field}`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.href;
    }
  } catch {
    // Fall through to the field-specific error below.
  }
  throw new Error(`jira-client response needs a safe HTTP(S) ${field}`);
}

function parseIssues(raw: string): JiraIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("jira-client returned invalid JSON");
  }

  const issues = (parsed as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) {
    throw new Error("jira-client response needs an issues list");
  }

  return issues.map((value, index) => {
    const issue = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const where = `issues[${index}]`;
    return {
      key: requireText(issue.key, `${where}.key`),
      summary: requireText(issue.summary, `${where}.summary`),
      status: requireText(issue.status, `${where}.status`),
      priority: optionalText(issue.priority),
      assignee: optionalText(issue.assignee),
      url: requireHttpUrl(issue.url, `${where}.url`),
    };
  });
}

async function loadState(statePath: string): Promise<JiraRecipeState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as { seenIssueKeys?: unknown };
    if (!Array.isArray(parsed.seenIssueKeys) || parsed.seenIssueKeys.some((key) => typeof key !== "string")) {
      throw new Error("seenIssueKeys must be a list of strings");
    }
    return { seenIssueKeys: parsed.seenIssueKeys };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { seenIssueKeys: [] };
    }
    throw new Error(`invalid Jira recipe state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveState(statePath: string, state: JiraRecipeState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, statePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function renderIssue(issue: JiraIssue): string {
  const lines = [
    `🆕 <b>${escapeHTML(issue.key)}</b>`,
    escapeHTML(issue.summary),
    `Статус: ${escapeHTML(issue.status)}`,
  ];
  if (issue.priority) lines.push(`Приоритет: ${escapeHTML(issue.priority)}`);
  if (issue.assignee) lines.push(`Исполнитель: ${escapeHTML(issue.assignee)}`);
  return lines.join("\n");
}

function issueButtons(recipeId: string, issue: JiraIssue): Record<string, unknown> {
  return {
    inline_keyboard: [[
      { text: "🧵 Создать тред", callback_data: jiraTaskCallbackData(recipeId, issue.key) },
      { text: "Открыть в Jira", url: issue.url },
    ]],
  };
}

export async function runJiraFilterRecipe(
  recipe: JiraFilterRecipe,
  send: SendJiraIssue,
  dependencies: JiraRecipeDependencies = {},
): Promise<JiraRecipeResult> {
  const execute = dependencies.execute ?? executeJiraClient;
  const statePath = dependencies.statePath
    ?? path.join(DEFAULT_STATE_DIR, `${recipe.id}.json`);
  const issues = parseIssues(await execute(
    recipe.jiraClient,
    ["filter", recipe.filterId, "--limit", "100", "--refresh"],
    recipe.cwd,
  ));
  const state = await loadState(statePath);
  const seen = new Set(state.seenIssueKeys);
  let delivered = 0;
  let repeated = 0;

  for (const issue of issues) {
    if (seen.has(issue.key)) {
      repeated += 1;
      continue;
    }

    await send(renderIssue(issue), issueButtons(recipe.id, issue));
    delivered += 1;
    seen.add(issue.key);
    await saveState(statePath, { seenIssueKeys: [...seen] });
  }

  return { total: issues.length, delivered, repeated };
}
