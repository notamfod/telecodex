import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  fingerprintFinding,
  parseFindings,
  renderRunHTML,
  triageFindings,
} from "./recipes.js";
import {
  RECIPE_MUTES_PATH,
  RECIPE_STATE_PATH,
  RecipeMutes,
  reservePendingRun,
} from "./recipe-store.js";
import type { PendingRun } from "./recipe-store.js";
import type { Finding } from "./recipes.js";
import { prepareDependencyReview } from "./dependency-review.js";
import { runJiraFilterRecipe } from "./jira-recipe.js";
import { runSentryTopRecipe } from "./sentry-recipe.js";
import {
  RECIPE_CONFIG_PATH,
  parseRecipes,
  type MircliReviewRecipe,
  type Recipe,
  type ReviewRecipe,
} from "./recipe-config.js";
import { sendRecipeMessage } from "./recipe-telegram.js";
import { deliverReviewDigest } from "./recipe-review-delivery.js";
import { acquireRecipeRunLock } from "./recipe-run-lock.js";
import {
  reviewPortfolioChunk,
  runCodexReadOnly,
} from "./review-agent.js";
import { enrichFindingMetadata, keepSafeReviewFindings } from "./review-metadata.js";
import {
  advancePortfolioState,
  chunkChangedFiles,
  projectStateFor,
  runReviewPortfolio,
  type PortfolioReviewState,
} from "./review-portfolio.js";
import { prepareReviewWorktree } from "./review-worktree.js";

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
/** Keep the seen-set bounded; a fingerprint older than this many entries may re-alert. */
const MAX_SEEN = 500;

type RecipeState = PortfolioReviewState;

interface State {
  runs?: Record<string, RecipeState>;
  /** Identifies a delivered batch so its buttons can find their findings again. */
  nextRunId?: number;
  /** Fingerprints muted by hand during calibration; never reported again. */
  ignored?: string[];
  pending?: Record<string, PendingRun>;
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
async function firstBaseline(cwd: string, headSha: string): Promise<string> {
  const since = await git(cwd, [
    "rev-list",
    "-1",
    "--before=24 hours ago",
    headSha,
  ]);
  const sha = since.trim();
  return sha || (await git(cwd, ["rev-parse", `${headSha}~1`])).trim();
}

type CodeReviewRecipe = ReviewRecipe | MircliReviewRecipe;

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
async function writeShadow(
  recipe: CodeReviewRecipe,
  project: string,
  stamp: string,
  findings: Finding[],
  html: string,
): Promise<void> {
  await mkdir(SHADOW_DIR, { recursive: true });
  const lines = [
    `## ${stamp} · ${project}`,
    "",
    toPlainText(html),
    "",
    "Отпечатки — скопируй в `ignored` в .telecodex/recipes.json, чтобы заглушить:",
    ...findings.map((finding) => `    ${JSON.stringify(fingerprintFinding(finding))},`),
    "",
    "",
  ];
  await appendFile(
    path.join(SHADOW_DIR, `${recipe.id}-${project}.shadow.md`),
    lines.join("\n"),
    "utf8",
  );
}

/** Which recipes exist is deployment-specific, so it comes from a file. */
async function loadRecipes(): Promise<Recipe[]> {
  const configPath = process.env.RECIPES_CONFIG ?? RECIPE_CONFIG_PATH;
  try {
    return parseRecipes(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No recipes config at ${configPath}; copy recipes/recipes.example.json and edit it`,
      );
    }
    throw error;
  }
}

async function runRecipe(): Promise<void> {
  const id = process.argv[2];
  const recipes = await loadRecipes();
  const recipe = recipes.find((entry) => entry.id === id);
  if (!recipe) {
    throw new Error(
      `unknown recipe: ${id ?? "(none)"}; known: ${recipes.map((entry) => entry.id).join(", ")}`,
    );
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

  if (recipe.kind === "jira-filter") {
    if (probe) {
      throw new Error(`${recipe.id} has no commit range; --from does not apply`);
    }
    const result = await runJiraFilterRecipe(
      recipe,
      async (html, replyMarkup) => {
        await sendRecipeMessage(recipe, html, replyMarkup);
      },
    );
    console.log(
      `${recipe.id}: ${result.total} total, ${result.delivered} new, ${result.repeated} repeated`,
    );
    return;
  }

  if (recipe.kind === "sentry-top") {
    if (probe) {
      throw new Error(`${recipe.id} has no commit range; --from does not apply`);
    }
    const result = await runSentryTopRecipe(
      recipe,
      async (html, replyMarkup) => {
        await sendRecipeMessage(recipe, html, replyMarkup);
      },
    );
    console.log(
      `${recipe.id}: ${result.total} total, ${result.delivered} delivered, ${result.suppressed} noise suppressed`,
    );
    return;
  }

  const stamp = new Date().toISOString();
  const state = await loadState();
  const previous = state.runs?.[recipe.id] ?? {};
  const template = await readFile(recipe.promptFile, "utf8");
  const ignored = [...(state.ignored ?? []), ...new RecipeMutes(RECIPE_MUTES_PATH).list()];

  if (recipe.kind === "mircli-review") {
    if (probe) {
      throw new Error(`${recipe.id} reviews multiple repositories; --from does not apply`);
    }
    const outputRoot = path.join(SHADOW_DIR, "output", recipe.id);
    const result = await runReviewPortfolio(recipe, previous, {
      reviewChunk: (input) => reviewPortfolioChunk(
        template,
        recipe.model,
        outputRoot,
        input,
      ),
    });
    let nextRunId = state.nextRunId ?? 1;

    for (const project of result.projects) {
      if (project.status === "failed") {
        console.error(`${recipe.id}/${project.name}: ${project.error}`);
        continue;
      }
      const triage = triageFindings(project.findings, {
        seen: projectStateFor(previous, project.name).seen ?? [],
        ignored,
      });
      const html = renderRunHTML({ recipe: `${recipe.id}/${project.name}`, ...triage });
      await writeShadow(recipe, project.name, stamp, triage.fresh, html);
      if (recipe.deliver && triage.shouldDeliver) {
        const runId = nextRunId++;
        reservePendingRun(STATE_PATH, runId, {
          recipe: recipe.id,
          cwd: project.sourcePath,
          project: project.name,
          repeatedCount: triage.repeated.length,
          suppressedCount: triage.suppressed.length,
          findings: triage.fresh,
        });
        await deliverReviewDigest(recipe, project.name, runId, triage);
      }
    }

    const latestState = await loadState();
    await saveState({
      ...latestState,
      nextRunId: Math.max(latestState.nextRunId ?? 1, nextRunId),
      runs: {
        ...latestState.runs,
        [recipe.id]: advancePortfolioState(previous, result.projects),
      },
    });
    const reviewed = result.projects.filter((project) => project.status === "reviewed").length;
    const unchanged = result.projects.filter((project) => project.status === "unchanged").length;
    const failed = result.projects.filter((project) => project.status === "failed").length;
    console.log(
      `${recipe.id}: ${reviewed} reviewed, ${unchanged} unchanged, ${failed} failed`,
    );
    return;
  }

  let prompt: string;
  let head: string | undefined;
  let range: string;
  let findings: Finding[];
  let project = path.basename(recipe.cwd);
  let reviewCwd = recipe.cwd;

  if (recipe.kind === "deps") {
    if (probe) {
      throw new Error(`${recipe.id} has no commit range; --from does not apply`);
    }
    const prepared = await prepareDependencyReview(recipe);
    reviewCwd = recipe.worktreeRoot;
    prompt = template
      .replaceAll("{{CWD}}", recipe.worktreeRoot)
      .replace("{{DEPS}}", prepared.table);
    range = "зависимости";
    const outputFile = path.join(SHADOW_DIR, `${recipe.id}.last-message.txt`);
    await mkdir(SHADOW_DIR, { recursive: true });
    await runCodexReadOnly(reviewCwd, recipe.model, prompt, outputFile);
    const parsed = parseFindings(await readFile(outputFile, "utf8"));
    const safe = keepSafeReviewFindings(
      parsed,
      recipe.worktreeRoot,
      parsed.map((finding) => finding.file),
    ).filter((finding) => existsSync(path.join(recipe.worktreeRoot, finding.file)));
    findings = [];
    for (const finding of safe) {
      const [projectName, ...relativeParts] = finding.file.split("/");
      const preparedProject = prepared.projects.find((entry) => entry.name === projectName);
      if (!preparedProject || relativeParts.length === 0) continue;
      const enriched = await enrichFindingMetadata(
        { ...finding, file: relativeParts.join("/") },
        {
          worktreePath: preparedProject.worktreePath,
          headSha: preparedProject.headSha,
        },
      );
      findings.push({ ...enriched, file: finding.file });
    }
  } else {
    const prepared = await prepareReviewWorktree(
      { name: project, sourcePath: recipe.cwd },
      recipe.worktreeRoot,
    );
    reviewCwd = prepared.worktreePath;
    head = prepared.headSha;
    let from = probe
      ? (await git(reviewCwd, ["rev-parse", probe])).trim()
      : previous.lastSha;
    if (from) {
      try {
        await git(reviewCwd, ["merge-base", "--is-ancestor", from, head]);
      } catch {
        from = undefined;
      }
    }
    from ??= await firstBaseline(reviewCwd, head);

    if (from === head) {
      console.log(`${recipe.id}: no new commits on origin/main`);
      return;
    }

    range = `${from}..${head}`;
    const diffArgs = ["-c", "core.quotePath=false", "diff", "--name-only", "-z", range];
    if (recipe.paths.length > 0) {
      diffArgs.push("--", ...recipe.paths);
    }
    const changedFiles = (await git(reviewCwd, diffArgs))
      .split("\0")
      .filter(Boolean);

    // A run with nothing to look at must still advance the pointer, or the same
    // empty range is re-examined every morning.
    if (changedFiles.length === 0) {
      if (!probe) {
        await saveState({
          ...state,
          runs: { ...state.runs, [recipe.id]: { ...previous, lastSha: head } },
        });
      }
      console.log(`${recipe.id}: ${range} touches nothing matching ${recipe.paths.join(" ")}`);
      return;
    }

    findings = [];
    const chunks = chunkChangedFiles(changedFiles);
    for (const [chunkIndex, files] of chunks.entries()) {
      findings.push(...await reviewPortfolioChunk(
        template,
        recipe.model,
        path.join(SHADOW_DIR, "output", recipe.id),
        {
          project: prepared,
          baseSha: from,
          headSha: head,
          files,
          chunkIndex,
          totalChunks: chunks.length,
        },
      ));
    }
    prompt = "";
  }
  const triage = triageFindings(findings, {
    seen: previous.seen ?? [],
    ignored,
  });
  const html = renderRunHTML({ recipe: recipe.id, ...triage });

  // The shadow log is the permanent record either way; delivery is on top of it.
  await writeShadow(recipe, project, stamp, triage.fresh, html);

  // A probe never posts: calibrating on history must not wake the topic up.
  let runId: number | undefined;
  if (recipe.deliver && !probe && triage.shouldDeliver) {
    runId = state.nextRunId ?? 1;
    reservePendingRun(STATE_PATH, runId, {
      recipe: recipe.id,
      cwd: recipe.kind === "deps" ? recipe.cwd : reviewCwd,
      project,
      repeatedCount: triage.repeated.length,
      suppressedCount: triage.suppressed.length,
      findings: triage.fresh,
    });
    await deliverReviewDigest(recipe, project, runId, triage);
  }

  if (!probe) {
    const seen = [...(previous.seen ?? []), ...findings.map(fingerprintFinding)];
    const latestState = await loadState();
    await saveState({
      ...latestState,
      nextRunId: runId === undefined
        ? latestState.nextRunId
        : Math.max(latestState.nextRunId ?? 1, runId + 1),
      runs: {
        ...latestState.runs,
        [recipe.id]: {
          lastSha: head ?? previous.lastSha,
          seen: [...new Set(seen)].slice(-MAX_SEEN),
        },
      },
    });
  }

  console.log(
    `${recipe.id}: ${range} → ${triage.fresh.length} new, ${triage.repeated.length} repeated, ${triage.suppressed.length} muted` +
      (recipe.deliver ? "" : " (shadow, nothing sent)") +
      (probe ? " (probe, state untouched)" : ""),
  );
}

async function main(): Promise<void> {
  const releaseLock = acquireRecipeRunLock(path.resolve(SHADOW_DIR, "recipe-run.lock"));
  try {
    await runRecipe();
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
