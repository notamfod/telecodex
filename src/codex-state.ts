import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  modelProvider: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

export interface RecentCodexThreadRecord extends CodexThreadRecord {
  source: string;
}

export interface CodexModelRecord {
  slug: string;
  displayName: string;
}

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5", displayName: "GPT-5" },
  { slug: "o4-mini", displayName: "o4-mini" },
  { slug: "o3", displayName: "o3" },
  { slug: "o3-mini", displayName: "o3-mini" },
  { slug: "gpt-4o", displayName: "GPT-4o" },
];

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;
type ThreadRow = {
  id: unknown;
  title: unknown;
  cwd: unknown;
  model: unknown;
  model_provider: unknown;
  created_at: unknown;
  updated_at: unknown;
  first_user_message: unknown;
  source?: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
};

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;

export function findLatestDatabase(): string | null {
  const codexDir = getCodexDir();
  if (!codexDir || !existsSync(codexDir)) {
    return null;
  }

  try {
    const candidates = readdirSync(codexDir)
      .filter((file) => /^state_.*\.sqlite$/i.test(file))
      .map((file) => {
        const fullPath = path.join(codexDir, file);
        return {
          path: fullPath,
          modifiedAtMs: statSync(fullPath).mtimeMs,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function listThreads(limit = 20): CodexThreadRecord[] {
  return withDatabase((db) => {
    const query = db.prepare(`
      SELECT id, title, cwd, model, model_provider, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = query.all(limit) as ThreadRow[];
    return rows.map(mapThreadRow);
  }) ?? [];
}

export function listUserThreads(limit = 100): CodexThreadRecord[] {
  return withDatabase((db) => {
    const query = db.prepare(`
      SELECT id, title, cwd, model, model_provider, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
        AND source = 'vscode'
        AND preview <> ''
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = query.all(limit) as ThreadRow[];
    return rows.map(mapThreadRow);
  }) ?? [];
}

export function listRecentRootThreads(
  since: Date,
  limit?: number,
): RecentCodexThreadRecord[] {
  return withDatabase((db) => {
    const query = db.prepare(`
      SELECT id, title, cwd, model, model_provider, created_at, updated_at, first_user_message, source
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
        AND updated_at >= ?
        AND (source IS NULL OR source NOT LIKE '%"subagent"%')
      ORDER BY updated_at DESC
      ${limit === undefined ? "" : "LIMIT ?"}
    `);

    const sinceSeconds = Math.floor(since.getTime() / 1000);
    const rows = (limit === undefined ? query.all(sinceSeconds) : query.all(sinceSeconds, limit)) as ThreadRow[];
    return rows.map((row) => ({
      ...mapThreadRow(row),
      source: sourceLabel(row.source),
    }));
  }) ?? [];
}

export function getThread(id: string): CodexThreadRecord | null {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT id, title, cwd, model, model_provider, created_at, updated_at, first_user_message
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `);

      const row = query.get(id) as ThreadRow | undefined;
      return row ? mapThreadRow(row) : null;
    }) ?? null
  );
}

export function listWorkspaces(): string[] {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT DISTINCT cwd
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
        ORDER BY cwd ASC
      `);

      const rows = query.all() as WorkspaceRow[];
      return rows
        .map((row) => (typeof row.cwd === "string" ? row.cwd : ""))
        .filter(Boolean);
    }) ?? []
  );
}

export function listModels(): CodexModelRecord[] {
  const modelsPath = getModelsCachePath();
  if (!modelsPath || !existsSync(modelsPath)) {
    return FALLBACK_MODELS;
  }

  try {
    const payload = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
      }))
      .filter((model) => model.slug && model.displayName);

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    model: typeof row.model === "string" ? row.model : null,
    modelProvider: typeof row.model_provider === "string" ? row.model_provider : null,
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
}

function sourceLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "?";
  if (value === "vscode") return "vscode";
  if (value === "exec") return "cli";
  if (value === "appServer") return "app-server";

  try {
    const parsed = JSON.parse(value) as { custom?: unknown };
    if (parsed.custom === "telecodex") return "телеграм";
    if (typeof parsed.custom === "string" && parsed.custom) return parsed.custom;
  } catch {
    // Older Codex versions stored the source as a plain string.
  }
  return "?";
}

function withDatabase<T>(fn: (db: DatabaseInstance) => T): T | null {
  if (!BetterSqlite3) {
    return null;
  }

  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return null;
  }

  let db: DatabaseInstance | null = null;
  try {
    db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function getCodexDir(): string | null {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".codex") : null;
}

function getModelsCachePath(): string | null {
  const codexDir = getCodexDir();
  return codexDir ? path.join(codexDir, "models_cache.json") : null;
}
