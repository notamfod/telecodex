/**
 * Which reviews run, where, and where their findings go. Deployment-specific, so
 * it lives in a file rather than in the code: see recipes/recipes.example.json.
 */
export interface Recipe {
  id: string;
  /** "diff" reviews new commits; "deps" reviews outdated dependencies. */
  kind?: "diff" | "deps";
  cwd: string;
  baseRef: string;
  promptFile: string;
  /** Pathspec limiting the diff; empty means the whole tree. */
  paths: string[];
  model?: string;
  /** Absent means shadow mode: findings go to a file, nothing reaches Telegram. */
  deliver?: { chatId: number; messageThreadId: number };
}

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
  const promptFile = requireString(entry.promptFile, "promptFile", where);

  const kind = entry.kind;
  if (kind !== undefined && kind !== "diff" && kind !== "deps") {
    throw new Error(`Invalid recipes config: ${where} has an unknown kind "${String(kind)}"`);
  }

  const paths = entry.paths ?? [];
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new Error(`Invalid recipes config: ${where} has a non-string paths entry`);
  }

  const recipe: Recipe = {
    id,
    cwd,
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
