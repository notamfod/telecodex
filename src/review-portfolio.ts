import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MircliReviewRecipe } from "./recipe-config.js";
import type { Finding } from "./recipes.js";
import { fingerprintFinding } from "./recipes.js";
import {
  discoverReviewProjects,
  prepareReviewWorktree,
  type PreparedReviewProject,
  type ReviewProject,
} from "./review-worktree.js";

const exec = promisify(execFile);
const DEFAULT_CHUNK_FILES = 20;
const MAX_SEEN = 500;

export interface ProjectReviewState {
  lastSha?: string;
  seen?: string[];
}

export interface PortfolioReviewState extends ProjectReviewState {
  projects?: Record<string, ProjectReviewState>;
}

export interface ReviewChunkInput {
  project: PreparedReviewProject;
  baseSha: string;
  headSha: string;
  files: string[];
  chunkIndex: number;
  totalChunks: number;
}

export interface PortfolioProjectResult {
  name: string;
  sourcePath: string;
  worktreePath?: string;
  status: "reviewed" | "unchanged" | "failed";
  headSha: string;
  baseSha?: string;
  changedFiles?: string[];
  findings: Finding[];
  error?: string;
}

export interface PortfolioReviewResult {
  projects: PortfolioProjectResult[];
}

type Git = (cwd: string, args: string[]) => Promise<string>;

interface PortfolioDependencies {
  discover?: (root: string) => Promise<ReviewProject[]>;
  prepare?: (
    project: ReviewProject,
    worktreeRoot: string,
  ) => Promise<PreparedReviewProject>;
  git?: Git;
  reviewChunk: (input: ReviewChunkInput) => Promise<Finding[]>;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

export function chunkChangedFiles(files: string[], limit = DEFAULT_CHUNK_FILES): string[][] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("changed-file chunk limit must be a positive integer");
  }
  const chunks: string[][] = [];
  for (let index = 0; index < files.length; index += limit) {
    chunks.push(files.slice(index, index + limit));
  }
  return chunks;
}

export function projectStateFor(
  state: PortfolioReviewState,
  projectName: string,
): ProjectReviewState {
  const current = state.projects?.[projectName];
  if (current) return current;
  if (projectName === "mir-back" && (state.lastSha || state.seen)) {
    return { lastSha: state.lastSha, seen: state.seen };
  }
  return {};
}

export function advancePortfolioState(
  previous: PortfolioReviewState,
  results: Array<Pick<PortfolioProjectResult, "name" | "status" | "headSha" | "findings" | "error">>,
): PortfolioReviewState {
  const projects = { ...previous.projects };
  for (const result of results) {
    if (result.status === "failed") continue;
    const old = projectStateFor(previous, result.name);
    const seen = [
      ...(old.seen ?? []),
      ...result.findings.map(fingerprintFinding),
    ];
    projects[result.name] = {
      lastSha: result.headSha,
      seen: [...new Set(seen)].slice(-MAX_SEEN),
    };
  }
  return { ...previous, projects };
}

async function initialBaseSha(project: PreparedReviewProject, git: Git): Promise<string> {
  const since = (
    await git(project.worktreePath, [
      "rev-list",
      "-1",
      "--before=24 hours ago",
      project.headSha,
    ])
  ).trim();
  return since || (
    await git(project.worktreePath, ["rev-parse", `${project.headSha}~1`])
  ).trim();
}

export async function runReviewPortfolio(
  recipe: MircliReviewRecipe,
  state: PortfolioReviewState,
  dependencies: PortfolioDependencies,
): Promise<PortfolioReviewResult> {
  const discover = dependencies.discover ?? discoverReviewProjects;
  const prepare = dependencies.prepare ?? prepareReviewWorktree;
  const git = dependencies.git ?? runGit;
  const results: PortfolioProjectResult[] = [];

  for (const project of await discover(recipe.cwd)) {
    const previous = projectStateFor(state, project.name);
    let prepared: PreparedReviewProject | undefined;
    let baseSha = previous.lastSha;
    let changedFiles: string[] = [];
    try {
      prepared = await prepare(project, recipe.worktreeRoot);
      if (baseSha) {
        try {
          await git(prepared.worktreePath, [
            "merge-base",
            "--is-ancestor",
            baseSha,
            prepared.headSha,
          ]);
        } catch {
          baseSha = undefined;
        }
      }
      baseSha ??= await initialBaseSha(prepared, git);
      if (baseSha === prepared.headSha) {
        results.push({
          name: project.name,
          sourcePath: project.sourcePath,
          worktreePath: prepared.worktreePath,
          status: "unchanged",
          baseSha,
          headSha: prepared.headSha,
          changedFiles,
          findings: [],
        });
        continue;
      }

      const rawFiles = await git(prepared.worktreePath, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-only",
        "-z",
        `${baseSha}..${prepared.headSha}`,
        "--",
      ]);
      changedFiles = rawFiles.split("\0").filter(Boolean);
      if (changedFiles.length === 0) {
        results.push({
          name: project.name,
          sourcePath: project.sourcePath,
          worktreePath: prepared.worktreePath,
          status: "unchanged",
          baseSha,
          headSha: prepared.headSha,
          changedFiles,
          findings: [],
        });
        continue;
      }

      const chunks = chunkChangedFiles(changedFiles);
      const findings: Finding[] = [];
      for (const [chunkIndex, files] of chunks.entries()) {
        findings.push(...await dependencies.reviewChunk({
          project: prepared,
          baseSha,
          headSha: prepared.headSha,
          files,
          chunkIndex,
          totalChunks: chunks.length,
        }));
      }
      results.push({
        name: project.name,
        sourcePath: project.sourcePath,
        worktreePath: prepared.worktreePath,
        status: "reviewed",
        baseSha,
        headSha: prepared.headSha,
        changedFiles,
        findings,
      });
    } catch (error) {
      results.push({
        name: project.name,
        sourcePath: project.sourcePath,
        worktreePath: prepared?.worktreePath,
        status: "failed",
        baseSha,
        headSha: prepared?.headSha ?? previous.lastSha ?? "",
        changedFiles,
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { projects: results };
}
