import path from "node:path";
import type { DeveloperWorkloadRecipe } from "./developer-workload-recipe.js";
import type { WeeklyProject } from "./weekly-activity.js";

/**
 * Which reviews run, where, and where their findings go. Deployment-specific, so
 * it lives in a file rather than in the code: see recipes/recipes.example.json.
 */
interface RecipeBase {
  id: string;
  cwd: string;
  deliver?: { chatId: number; messageThreadId: number };
}

export interface ReviewRecipe extends RecipeBase {
  /** "diff" reviews new commits; "deps" reviews outdated dependencies. */
  kind?: "diff" | "deps";
  baseRef: string;
  worktreeRoot: string;
  promptFile: string;
  /** Pathspec limiting the diff; empty means the whole tree. */
  paths: string[];
  model?: string;
}

export interface MircliReviewRecipe extends RecipeBase {
  kind: "mircli-review";
  worktreeRoot: string;
  promptFile: string;
  model?: string;
}

export interface JiraFilterRecipe extends RecipeBase {
  kind: "jira-filter";
  jiraClient: string;
  filterId: string;
  deliver: { chatId: number; messageThreadId: number };
}

export interface SentryTopRecipe extends RecipeBase {
  kind: "sentry-top";
  dofboxConfigModule: string;
  realm: string;
  period: string;
  limit: number;
  deliver: { chatId: number; messageThreadId: number };
}

export interface WeeklySummaryRecipe extends RecipeBase {
  kind: "weekly-summary";
  databasePath: string;
  projects: WeeklyProject[];
  model?: string;
  deliver: { chatId: number; messageThreadId: number };
}

export type Recipe = ReviewRecipe | MircliReviewRecipe | JiraFilterRecipe | SentryTopRecipe | WeeklySummaryRecipe | DeveloperWorkloadRecipe;

export const RECIPE_CONFIG_PATH = "recipes/recipes.json";

export function parseRecipes(raw: string): Recipe[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid recipes config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = (parsed as { recipes?: unknown } | null)?.recipes;
  if (!Array.isArray(entries)) {
    throw new Error('Invalid recipes config: "recipes" must be a list');
  }

  const recipes = entries.map((entry, index) => parseRecipe(entry, index));
  const seen = new Set<string>();
  for (const recipe of recipes) {
    if (seen.has(recipe.id)) {
      // Run state is keyed by id, so a duplicate would quietly share a pointer.
      throw new Error(`Invalid recipes config: two recipes share the id "${recipe.id}"`);
    }
    seen.add(recipe.id);
  }

  return recipes;
}

function parseRecipe(value: unknown, index: number): Recipe {
  const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const where = typeof entry.id === "string" ? `recipe "${entry.id}"` : `recipe #${index + 1}`;

  const id = requireString(entry.id, "id", where);
  const cwd = requireString(entry.cwd, "cwd", where);

  const kind = entry.kind;
  if (
    kind !== undefined
    && kind !== "diff"
    && kind !== "deps"
    && kind !== "jira-filter"
    && kind !== "sentry-top"
    && kind !== "mircli-review"
    && kind !== "weekly-summary"
    && kind !== "developer-workload"
  ) {
    throw new Error(`Invalid recipes config: ${where} has an unknown kind "${String(kind)}"`);
  }

  if (kind === "developer-workload") {
    if (entry.deliver === undefined) throw new Error(`Invalid recipes config: ${where} needs a deliver target`);
    const capacityHours = requireNumber(entry.capacityHours, "capacityHours", where);
    if (!Number.isInteger(capacityHours) || capacityHours < 1 || capacityHours > 80) {
      throw new Error(`Invalid recipes config: ${where} needs capacityHours from 1 to 80`);
    }
    const completionStatuses = entry.completionStatuses;
    if (!Array.isArray(completionStatuses) || completionStatuses.length === 0 || completionStatuses.length > 20
      || completionStatuses.some((status) => typeof status !== "string" || !status.trim())) {
      throw new Error(`Invalid recipes config: ${where} needs 1-20 completionStatuses`);
    }
    return {
      id, kind, cwd,
      jiraClient: requireString(entry.jiraClient, "jiraClient", where),
      capacityHours,
      fromStatus: requireString(entry.fromStatus, "fromStatus", where),
      completionStatuses: completionStatuses as string[],
      deliver: parseDeliver(entry.deliver, where),
    };
  }

  if (kind === "weekly-summary") {
    if (entry.deliver === undefined) throw new Error(`Invalid recipes config: ${where} needs a deliver target`);
    if (!Array.isArray(entry.projects) || entry.projects.length === 0 || entry.projects.length > 20) {
      throw new Error(`Invalid recipes config: ${where} needs 1-20 projects`);
    }
    const names = new Set<string>();
    const projects = entry.projects.map((value: unknown): WeeklyProject => {
      const project = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const name = requireString(project.name, "project name", where);
      if (name.length > 60 || names.has(name)) throw new Error(`Invalid recipes config: ${where} has an invalid or duplicate project name`);
      names.add(name);
      if (!Array.isArray(project.roots) || project.roots.length === 0
        || project.roots.some((root: unknown) => typeof root !== "string" || !path.isAbsolute(root) || root === "/")) {
        throw new Error(`Invalid recipes config: ${where} needs absolute project roots`);
      }
      return { name, roots: project.roots as string[] };
    });
    const databasePath = requireString(entry.databasePath, "databasePath", where);
    if (!path.isAbsolute(databasePath)) throw new Error(`Invalid recipes config: ${where} needs an absolute databasePath`);
    const recipe: WeeklySummaryRecipe = { id, kind, cwd, databasePath, projects, deliver: parseDeliver(entry.deliver, where) };
    if (typeof entry.model === "string") recipe.model = entry.model;
    return recipe;
  }

  if (kind === "jira-filter") {
    if (entry.deliver === undefined) {
      throw new Error(`Invalid recipes config: ${where} needs a deliver target`);
    }
    return {
      id,
      kind,
      cwd,
      jiraClient: requireString(entry.jiraClient, "jiraClient", where),
      filterId: requireString(entry.filterId, "filterId", where),
      deliver: parseDeliver(entry.deliver, where),
    };
  }

  if (kind === "sentry-top") {
    if (entry.deliver === undefined) {
      throw new Error(`Invalid recipes config: ${where} needs a deliver target`);
    }
    const period = requireString(entry.period, "period", where);
    if (!/^(24h|7d|30d)$/.test(period)) {
      throw new Error(`Invalid recipes config: ${where} has an unsupported period "${period}"`);
    }
    const limit = requireNumber(entry.limit, "limit", where);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new Error(`Invalid recipes config: ${where} needs an integer limit from 1 to 30`);
    }
    return {
      id,
      kind,
      cwd,
      dofboxConfigModule: requireString(
        entry.dofboxConfigModule,
        "dofboxConfigModule",
        where,
      ),
      realm: requireString(entry.realm, "realm", where),
      period,
      limit,
      deliver: parseDeliver(entry.deliver, where),
    };
  }

  if (kind === "mircli-review") {
    const recipe: MircliReviewRecipe = {
      id,
      kind,
      cwd,
      worktreeRoot: requireString(entry.worktreeRoot, "worktreeRoot", where),
      promptFile: requireString(entry.promptFile, "promptFile", where),
    };
    if (typeof entry.model === "string") recipe.model = entry.model;
    if (entry.deliver !== undefined) recipe.deliver = parseDeliver(entry.deliver, where);
    return recipe;
  }

  const promptFile = requireString(entry.promptFile, "promptFile", where);
  const worktreeRoot = requireString(entry.worktreeRoot, "worktreeRoot", where);

  const paths = entry.paths ?? [];
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new Error(`Invalid recipes config: ${where} has a non-string paths entry`);
  }

  const recipe: Recipe = {
    id,
    cwd,
    worktreeRoot,
    promptFile,
    baseRef: typeof entry.baseRef === "string" ? entry.baseRef : "",
    paths: paths as string[],
  };
  if (kind) recipe.kind = kind;
  if (typeof entry.model === "string") recipe.model = entry.model;
  if (entry.deliver !== undefined) recipe.deliver = parseDeliver(entry.deliver, where);

  return recipe;
}

function parseDeliver(value: unknown, where: string): { chatId: number; messageThreadId: number } {
  const target = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    chatId: requireNumber(target.chatId, "deliver.chatId", where),
    messageThreadId: requireNumber(target.messageThreadId, "deliver.messageThreadId", where),
  };
}

function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid recipes config: ${where} needs a ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid recipes config: ${where} needs a numeric ${field}`);
  }
  return value;
}
