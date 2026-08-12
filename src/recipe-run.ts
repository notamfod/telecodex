import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  fingerprintFinding,
  keepExistingFiles,
  parseFindings,
  renderFindingHTML,
  renderRunHTML,
  triageFindings,
} from "./recipes.js";
import {
  RECIPE_MUTES_PATH,
  RECIPE_STATE_PATH,
  RecipeMutes,
  writePendingRun,
} from "./recipe-store.js";
import type { Finding, Triage } from "./recipes.js";
import {
  bumpKind,
  composerDirectDependencies,
  escapeGoModulePath,
  latestStable,
  parseGoMod,
  renderDepsTable,
} from "./deps.js";
import type { DepRequirement, DepUpdate, Ecosystem } from "./deps.js";

/**
 * Scheduled review recipes.
 *
 * A recipe is a deterministic prepare step (run here, not by the agent) plus a
 * prompt that asks for machine-readable findings. Runs are diffed against each
 * other so a stable finding is reported once.
 */

const run = promisify(execFile);

const STATE_PATH = RECIPE_STATE_PATH;
const SHADOW_DIR = ".telecodex/recipes";
const DIFF_LIMIT = 60_000;
const CODEX_TIMEOUT_MS = 20 * 60 * 1000;
/** Keep the seen-set bounded; a fingerprint older than this many entries may re-alert. */
const MAX_SEEN = 500;

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

export const RECIPES: Recipe[] = [
  {
    id: "daily-diff-review",
    deliver: { chatId: -1001234567890, messageThreadId: 635 },
    cwd: "/srv/projects/storefront/mir-back",
    baseRef: "origin/main",
    promptFile: "recipes/daily-diff-review.md",
    paths: ["*.php", "*.sql"],
  },
  {
    id: "dependency-review",
    deliver: { chatId: -1001234567890, messageThreadId: 635 },
    kind: "deps",
    cwd: "/srv/projects/storefront",
    baseRef: "",
    promptFile: "recipes/dependency-review.md",
    paths: [],
  },
  {
    id: "migration-audit",
    deliver: { chatId: -1001234567890, messageThreadId: 635 },
    cwd: "/srv/projects/storefront/mir-back",
    baseRef: "origin/main",
    promptFile: "recipes/migration-audit.md",
    paths: ["src/database/migrations/*"],
  },
];

interface RecipeState {
  lastSha?: string;
  seen?: string[];
}

interface State {
  runs?: Record<string, RecipeState>;
  /** Identifies a delivered batch so its buttons can find their findings again. */
  nextRunId?: number;
  /** Fingerprints muted by hand during calibration; never reported again. */
  ignored?: string[];
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 128 * 1024 * 1024 });
  return stdout;
}

/**
 * Where to start reviewing when a recipe has never run.
 *
 * Deliberately not `<ref>@{1.day.ago}`: that reads the remote-tracking reflog,
 * which is empty on a host that fetches sporadically, and silently yields an
 * empty range instead of an error.
 */
async function firstBaseline(recipe: Recipe): Promise<string> {
  const since = await git(recipe.cwd, [
    "rev-list",
    "-1",
    "--before=24 hours ago",
    recipe.baseRef,
  ]);
  const sha = since.trim();
  return sha || (await git(recipe.cwd, ["rev-parse", `${recipe.baseRef}~1`])).trim();
}

function runCodex(recipe: Recipe, prompt: string, outputFile: string): Promise<void> {
  // The monorepo root is a folder of repositories, not a repository itself.
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    recipe.cwd,
    "-s",
    "read-only",
    "-o",
    outputFile,
  ];
  if (recipe.model) {
    args.push("-m", recipe.model);
  }
  args.push("-");

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["pipe", "inherit", "inherit"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex exec exceeded ${CODEX_TIMEOUT_MS / 60000} minutes`));
    }, CODEX_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`codex exec exited with ${code}`));
      }
    });
    child.stdin.end(prompt);
  });
}

async function sendMessage(
  recipe: Recipe,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !recipe.deliver) {
    throw new Error("delivery requested without a bot token or target topic");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: recipe.deliver.chatId,
      message_thread_id: recipe.deliver.messageThreadId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

/**
 * One message per finding, each with its own buttons.
 *
 * A single message with twenty buttons cannot say which one was pressed once a
 * mute has to grey out just that finding.
 */
async function deliverFindings(recipe: Recipe, runId: number, triage: Triage): Promise<void> {
  const notes = [
    `${triage.fresh.length} ${triage.fresh.length === 1 ? "новая" : "новых"}`,
    triage.repeated.length > 0 ? `повторов: ${triage.repeated.length}` : "",
    triage.suppressed.length > 0 ? `заглушено: ${triage.suppressed.length}` : "",
  ].filter(Boolean);

  await sendMessage(recipe, `\u{1F50D} <b>${recipe.id}</b> \u00B7 ${notes.join(" \u00B7 ")}`);

  for (const [index, finding] of triage.fresh.entries()) {
    await sendMessage(recipe, renderFindingHTML(finding), {
      inline_keyboard: [
        [
          { text: "\u{1F527} Тред-фикс", callback_data: `rfix:${runId}:${index}` },
          { text: "\u{1F507} Игнорировать", callback_data: `rmute:${runId}:${index}` },
        ],
      ],
    });
  }
}

/** The shadow log is read by a human, so undo the Telegram markup and its escaping. */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** During calibration the findings land here so false positives can be muted by hand. */
async function writeShadow(recipe: Recipe, stamp: string, findings: Finding[], html: string): Promise<void> {
  await mkdir(SHADOW_DIR, { recursive: true });
  const lines = [
    `## ${stamp}`,
    "",
    toPlainText(html),
    "",
    "Отпечатки — скопируй в `ignored` в .telecodex/recipes.json, чтобы заглушить:",
    ...findings.map((finding) => `    ${JSON.stringify(fingerprintFinding(finding))},`),
    "",
    "",
  ];
  await appendFile(path.join(SHADOW_DIR, `${recipe.id}.shadow.md`), lines.join("\n"), "utf8");
}

const REGISTRY_TIMEOUT_MS = 15_000;
const REGISTRY_CONCURRENCY = 8;

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
  } catch {
    // One unreachable package must not take the whole weekly run down.
    return undefined;
  }
}

async function latestComposerVersion(name: string): Promise<string | undefined> {
  const body = await fetchJson(`https://repo.packagist.org/p2/${name}.json`);
  const packages = (body?.packages ?? {}) as Record<string, Array<{ version?: string }>>;
  const versions = packages[name];
  return Array.isArray(versions)
    ? latestStable(versions.map((entry) => String(entry.version ?? "")).filter(Boolean))
    : undefined;
}

async function latestGoVersion(module: string): Promise<string | undefined> {
  const body = await fetchJson(`https://proxy.golang.org/${escapeGoModulePath(module)}/@latest`);
  const version = body?.Version;
  // An untagged module answers with a pseudo-version; suggesting one is noise.
  return typeof version === "string" && !version.includes("-") ? version : undefined;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

/**
 * Direct requirements across the monorepo.
 *
 * Neither composer nor go is installed on this host, so the manifests are read
 * from the checkout: Laravel services keep theirs in `<service>/src`, Go ones in
 * `<service>/app`.
 */
async function collectRequirements(
  root: string,
): Promise<Array<DepRequirement & { ecosystem: Ecosystem }>> {
  const found: Array<DepRequirement & { ecosystem: Ecosystem }> = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const composerJson = path.join(root, entry.name, "src/composer.json");
    const composerLock = path.join(root, entry.name, "src/composer.lock");
    if (existsSync(composerJson) && existsSync(composerLock)) {
      found.push(
        ...composerDirectDependencies(
          JSON.parse(await readFile(composerJson, "utf8")),
          JSON.parse(await readFile(composerLock, "utf8")),
        ).map((dep) => ({ ...dep, ecosystem: "composer" as const })),
      );
    }

    const goMod = path.join(root, entry.name, "app/go.mod");
    if (existsSync(goMod)) {
      found.push(
        ...parseGoMod(await readFile(goMod, "utf8")).map((dep) => ({
          ...dep,
          ecosystem: "go" as const,
        })),
      );
    }
  }

  // Several Go services share dependencies; one row per package is enough.
  const unique = new Map(found.map((dep) => [`${dep.ecosystem}:${dep.name}`, dep]));
  return [...unique.values()];
}

async function buildDepsTable(recipe: Recipe): Promise<string> {
  const requirements = await collectRequirements(recipe.cwd);
  console.log(`${recipe.id}: checking ${requirements.length} direct dependencies`);

  const updates = await mapLimit(requirements, REGISTRY_CONCURRENCY, async (requirement) => {
    const latest =
      requirement.ecosystem === "composer"
        ? await latestComposerVersion(requirement.name)
        : await latestGoVersion(requirement.name);
    if (!latest) {
      return undefined;
    }
    const bump = bumpKind(requirement.current, latest);
    return bump === "none" ? undefined : ({ ...requirement, latest, bump } as DepUpdate);
  });

  return renderDepsTable(updates.filter((update): update is DepUpdate => update !== undefined));
}

async function main(): Promise<void> {
  const id = process.argv[2];
  const recipe = RECIPES.find((entry) => entry.id === id);
  if (!recipe) {
    throw new Error(`unknown recipe: ${id ?? "(none)"}; known: ${RECIPES.map((r) => r.id).join(", ")}`);
  }

  // A probe reviews an arbitrary range without moving the daily pointer or
  // poisoning the seen-set, so calibrating on history stays side-effect free.
  const fromIndex = process.argv.indexOf("--from");
  const probe = fromIndex !== -1 ? process.argv[fromIndex + 1] : undefined;
  if (fromIndex !== -1 && !probe) {
    throw new Error("--from needs a commit-ish");
  }

  // Checked before the agent runs: finding out about a missing token after a
  // twenty-minute review means the whole run is wasted.
  if (recipe.deliver && !probe && !process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      `${recipe.id} delivers to Telegram but TELEGRAM_BOT_TOKEN is unset; ` +
        "run it through telecodex-recipe@.service, which loads .env",
    );
  }

  const stamp = new Date().toISOString();
  const state = await loadState();
  const previous = state.runs?.[recipe.id] ?? {};
  const template = await readFile(recipe.promptFile, "utf8");

  let prompt: string;
  let head: string | undefined;
  let range: string;

  if (recipe.kind === "deps") {
    if (probe) {
      throw new Error(`${recipe.id} has no commit range; --from does not apply`);
    }
    prompt = template.replace("{{DEPS}}", await buildDepsTable(recipe));
    range = "зависимости";
  } else {
    await git(recipe.cwd, ["fetch", "origin", "--quiet"]);
    head = (await git(recipe.cwd, ["rev-parse", recipe.baseRef])).trim();
    const from = probe
      ? (await git(recipe.cwd, ["rev-parse", probe])).trim()
      : previous.lastSha ?? (await firstBaseline(recipe));

    if (from === head) {
      console.log(`${recipe.id}: no new commits on ${recipe.baseRef}`);
      return;
    }

    range = `${from}..${head}`;
    const commits = await git(recipe.cwd, ["log", "--oneline", "--no-merges", range]);
    const diffArgs = ["diff", range];
    if (recipe.paths.length > 0) {
      diffArgs.push("--", ...recipe.paths);
    }
    const rawDiff = await git(recipe.cwd, diffArgs);

    // A run with nothing to look at must still advance the pointer, or the same
    // empty range is re-examined every morning.
    if (!rawDiff.trim()) {
      if (!probe) {
        await saveState({
          ...state,
          runs: { ...state.runs, [recipe.id]: { ...previous, lastSha: head } },
        });
      }
      console.log(`${recipe.id}: ${range} touches nothing matching ${recipe.paths.join(" ")}`);
      return;
    }

    const diff =
      rawDiff.length > DIFF_LIMIT
        ? `${rawDiff.slice(0, DIFF_LIMIT)}\n\n[дифф обрезан на ${DIFF_LIMIT} символах]`
        : rawDiff;

    prompt = template
      .replace("{{COMMITS}}", commits.trim() || "(нет коммитов)")
      .replace("{{DIFF}}", diff);
  }

  const outputFile = path.join(SHADOW_DIR, `${recipe.id}.last-message.txt`);
  await mkdir(SHADOW_DIR, { recursive: true });
  await runCodex(recipe, prompt, outputFile);

  const parsed = parseFindings(await readFile(outputFile, "utf8"));
  const findings = keepExistingFiles(parsed, (file) =>
    existsSync(path.join(recipe.cwd, file)),
  );
  if (findings.length < parsed.length) {
    console.log(
      `${recipe.id}: dropped ${parsed.length - findings.length} finding(s) naming files outside the checkout`,
    );
  }
  const triage = triageFindings(findings, {
    seen: previous.seen ?? [],
    // Hand-edited mutes live in recipes.json, button mutes in recipe-mutes.json.
    ignored: [...(state.ignored ?? []), ...new RecipeMutes(RECIPE_MUTES_PATH).list()],
  });
  const html = renderRunHTML({ recipe: recipe.id, ...triage });

  // The shadow log is the permanent record either way; delivery is on top of it.
  await writeShadow(recipe, stamp, triage.fresh, html);

  // A probe never posts: calibrating on history must not wake the topic up.
  let runId: number | undefined;
  if (recipe.deliver && !probe && triage.shouldDeliver) {
    runId = state.nextRunId ?? 1;
    await deliverFindings(recipe, runId, triage);
  }

  if (!probe) {
    const seen = [...(previous.seen ?? []), ...findings.map(fingerprintFinding)];
    await saveState({
      ...state,
      nextRunId: runId === undefined ? state.nextRunId : runId + 1,
      runs: {
        ...state.runs,
        [recipe.id]: {
          lastSha: head ?? previous.lastSha,
          seen: [...new Set(seen)].slice(-MAX_SEEN),
        },
      },
    });
  }

  // After saveState, so the fresh file is the one that gets the pending run.
  if (runId !== undefined) {
    writePendingRun(STATE_PATH, runId, {
      recipe: recipe.id,
      cwd: recipe.cwd,
      findings: triage.fresh,
    });
  }

  console.log(
    `${recipe.id}: ${range} → ${triage.fresh.length} new, ${triage.repeated.length} repeated, ${triage.suppressed.length} muted` +
      (recipe.deliver ? "" : " (shadow, nothing sent)") +
      (probe ? " (probe, state untouched)" : ""),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
