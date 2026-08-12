import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Finding } from "./recipes.js";

/**
 * The two files the recipe machinery shares between processes.
 *
 * The runner owns recipes.json and the bot owns recipe-mutes.json. Keeping them
 * apart means neither process can overwrite what the other just wrote — the
 * scheduled run and a button press can land at the same second.
 */
export const RECIPE_STATE_PATH = ".telecodex/recipes.json";
export const RECIPE_MUTES_PATH = ".telecodex/recipe-mutes.json";

/** How many delivered runs stay actionable; older buttons answer "run expired". */
const MAX_PENDING_RUNS = 20;

export interface PendingRun {
  recipe: string;
  /** The repository the findings are about; a fix thread starts here. */
  cwd: string;
  findings: Finding[];
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as T) : fallback;
  } catch (error) {
    console.warn(
      `Failed to read ${filePath}:`,
      error instanceof Error ? error.message : String(error),
    );
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readPendingRun(filePath: string, runId: number): PendingRun | undefined {
  const state = readJson<{ pending?: Record<string, PendingRun> }>(filePath, {});
  return state.pending?.[String(runId)];
}

export function writePendingRun(filePath: string, runId: number, run: PendingRun): void {
  const state = readJson<Record<string, unknown> & { pending?: Record<string, PendingRun> }>(
    filePath,
    {},
  );
  const pending = { ...state.pending, [String(runId)]: run };

  // Bound the file: only the most recent runs keep working buttons.
  const trimmed = Object.entries(pending)
    .sort(([a], [b]) => Number(b) - Number(a))
    .slice(0, MAX_PENDING_RUNS);

  writeJson(filePath, { ...state, pending: Object.fromEntries(trimmed) });
}

/**
 * Fingerprints muted from Telegram.
 *
 * Written only by the bot, read by both. Hand-edited mutes in recipes.json are
 * still honoured; the runner unions the two.
 */
export class RecipeMutes {
  constructor(private readonly filePath: string = RECIPE_MUTES_PATH) {}

  list(): string[] {
    return readJson<{ ignored?: string[] }>(this.filePath, {}).ignored ?? [];
  }

  add(fingerprint: string): void {
    const ignored = this.list();
    if (ignored.includes(fingerprint)) {
      return;
    }
    try {
      writeJson(this.filePath, { ignored: [...ignored, fingerprint] });
    } catch (error) {
      console.warn(
        "Failed to persist recipe mute:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
