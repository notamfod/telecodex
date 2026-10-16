import { execFile } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { MircliReviewRecipe, Recipe } from "./recipe-config.js";
import { prepareReviewWorktree, type PreparedReviewProject, type ReviewProject } from "./review-worktree.js";
import { prepareReviewSnapshot } from "./review-pipeline-snapshot.js";
import { reviewPortfolioChunk } from "./review-agent.js";
import { chunkChangedFiles, type ReviewChunkInput, type PortfolioProjectResult } from "./review-portfolio.js";
import { enqueueReviewFindings } from "./review-pipeline-enqueue.js";
import type { Finding } from "./recipes.js";
import type { PipelineSource } from "./review-pipeline-store.js";
import { markerProject, renderGitlabReviewResultMarker } from "./gitlab-review-result-marker.js";

const exec = promisify(execFile);
interface PipelineEvent { projectPath: string; after: string; before?: string; }
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function runRequestedPipeline(recipe: Recipe, projectNames: readonly string[] | undefined,
  options: { args: readonly string[]; probe?: string; preview: boolean; webhook: boolean }): Promise<boolean> {
  const index = options.args.indexOf("--pipeline-events");
  if (index === -1) return false;
  if (!options.webhook || recipe.id !== "daily-diff-review" || recipe.kind !== "mircli-review"
    || !projectNames || options.probe || options.preview) throw new Error("Pipeline events require a selected webhook review");
  const events = parsePipelineEvents(options.args[index + 1] ?? "");
  if (events.some((event) => !projectNames.includes(path.posix.basename(event.projectPath)))) {
    throw new Error("Pipeline event outside selected projects");
  }
  const results = await runPipelineEvents(recipe, events, await readFile(recipe.promptFile, "utf8"));
  const byName = new Map(results.map((result) => [result.name, markerProject(result, result.findings.length)]));
  console.log(renderGitlabReviewResultMarker([...byName.values()]));
  if (results.some((result) => result.status === "failed")) throw new Error("Selected pipeline review failed; retry required");
  return true;
}

export function parsePipelineEvents(raw: string): PipelineEvent[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || value.length > 30 || !value.every((item) => item
    && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item).every((key) => ["projectPath", "after", "before"].includes(key))
    && typeof item.projectPath === "string" && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(item.projectPath)
    && !item.projectPath.split("/").some((part: string) => part === "." || part === "..")
    && typeof item.after === "string" && sha.test(item.after) && !/^0+$/.test(item.after)
    && (item.before === undefined || typeof item.before === "string" && sha.test(item.before)))) {
    throw new Error("Invalid pipeline events");
  }
  return value;
}

/** Explicit notifications have their own ranges; scheduled-review progress stays untouched. */
export async function runPipelineEvents(
  recipe: MircliReviewRecipe,
  events: readonly PipelineEvent[],
  template: string,
  dependencies: {
    prepare?: (project: ReviewProject, root: string) => Promise<PreparedReviewProject>;
    snapshot?: typeof prepareReviewSnapshot;
    git?: (cwd: string, args: string[]) => Promise<string>;
    reviewChunk?: (input: ReviewChunkInput) => Promise<Finding[]>;
    enqueue?: (input: Omit<PipelineSource, "finding">, findings: readonly Finding[]) => void;
  } = {},
): Promise<PortfolioProjectResult[]> {
  const git = dependencies.git ?? (async (cwd, args) => (await exec("git", args, { cwd,
    encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })).stdout);
  const results: PortfolioProjectResult[] = [];
  for (const event of events) {
    const name = path.posix.basename(event.projectPath);
    const sourcePath = path.join(recipe.cwd, name);
    try {
      const prepared = await (dependencies.prepare ?? prepareReviewWorktree)({ name, sourcePath }, recipe.worktreeRoot);
      const cwd = await (dependencies.snapshot ?? prepareReviewSnapshot)(prepared.worktreePath, event.after);
      let baseSha = event.before;
      if (baseSha && !/^0+$/.test(baseSha)) {
        try { await git(cwd, ["merge-base", "--is-ancestor", baseSha, event.after]); }
        catch { baseSha = undefined; }
      } else baseSha = undefined;
      baseSha ??= (await git(cwd, ["rev-parse", `${event.after}^`])).trim();
      const files = (await git(cwd, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", `${baseSha}..${event.after}`]))
        .split("\0").filter(Boolean);
      const chunks = chunkChangedFiles(files);
      const findings: Finding[] = [];
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const input: ReviewChunkInput = { project: { ...prepared, worktreePath: cwd, headSha: event.after },
          baseSha, headSha: event.after, files: chunk, chunkIndex, totalChunks: chunks.length };
        findings.push(...await (dependencies.reviewChunk ?? ((item) => reviewPortfolioChunk(template, recipe.model,
          path.resolve(".telecodex/review-pipeline/review-output"), item)))(input));
      }
      (dependencies.enqueue ?? enqueueReviewFindings)({ recipe: recipe.id, project: name, cwd,
        headSha: event.after }, findings);
      results.push({ name, sourcePath, worktreePath: cwd, status: "reviewed", baseSha,
        headSha: event.after, changedFiles: files, findings });
    } catch {
      results.push({ name, sourcePath, status: "failed", headSha: event.after, findings: [], error: "Pipeline review failed" });
    }
  }
  return results;
}
