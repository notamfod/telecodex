import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ReviewProject {
  name: string;
  sourcePath: string;
}

export interface PreparedReviewProject extends ReviewProject {
  worktreePath: string;
  headSha: string;
  baseRef: "origin/main";
}

type Git = (cwd: string, args: string[]) => Promise<string>;

interface DiscoveryDependencies {
  listDirectories?: (root: string) => Promise<string[]>;
  git?: Git;
}

interface WorktreeDependencies {
  git?: Git;
  pathExists?: (target: string) => boolean;
  mkdir?: (target: string) => Promise<unknown>;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

async function listDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export async function discoverReviewProjects(
  root: string,
  dependencies: DiscoveryDependencies = {},
): Promise<ReviewProject[]> {
  const list = dependencies.listDirectories ?? listDirectories;
  const git = dependencies.git ?? runGit;
  const projects: ReviewProject[] = [];

  for (const name of await list(root)) {
    const sourcePath = path.join(root, name);
    try {
      await git(sourcePath, ["rev-parse", "--git-dir"]);
      const topLevel = (await git(sourcePath, ["rev-parse", "--show-toplevel"])).trim();
      if (path.resolve(topLevel) !== path.resolve(sourcePath)) continue;
      projects.push({ name, sourcePath });
    } catch {
      // First-level non-repository directories are outside the review portfolio.
    }
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

export async function prepareReviewWorktree(
  project: ReviewProject,
  worktreeRoot: string,
  dependencies: WorktreeDependencies = {},
): Promise<PreparedReviewProject> {
  const git = dependencies.git ?? runGit;
  const pathExists = dependencies.pathExists ?? existsSync;
  const makeDirectory = dependencies.mkdir ?? ((target) => mkdir(target, { recursive: true }));
  const worktreePath = path.join(worktreeRoot, project.name);

  await git(project.sourcePath, ["fetch", "--quiet", "origin", "main"]);
  const headSha = (
    await git(project.sourcePath, ["rev-parse", "refs/remotes/origin/main^{commit}"])
  ).trim();
  if (!headSha) {
    throw new Error(`${project.name}: origin/main did not resolve to a commit`);
  }

  await makeDirectory(worktreeRoot);
  if (!pathExists(worktreePath)) {
    await git(project.sourcePath, ["worktree", "add", "--detach", worktreePath, headSha]);
  } else {
    const sourceCommonDir = path.resolve(
      project.sourcePath,
      (await git(project.sourcePath, ["rev-parse", "--git-common-dir"])).trim(),
    );
    const worktreeCommonDir = path.resolve(
      worktreePath,
      (await git(worktreePath, ["rev-parse", "--git-common-dir"])).trim(),
    );
    if (sourceCommonDir !== worktreeCommonDir) {
      throw new Error(`${project.name}: existing review worktree does not belong to source repository`);
    }
    const status = await git(worktreePath, ["status", "--porcelain"]);
    if (status.trim()) {
      throw new Error(`${project.name}: managed review worktree is dirty: ${worktreePath}`);
    }
    await git(worktreePath, ["checkout", "--detach", headSha]);
  }

  return {
    ...project,
    worktreePath,
    headSha,
    baseRef: "origin/main",
  };
}
