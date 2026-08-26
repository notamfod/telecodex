import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding } from "./recipes.js";

const exec = promisify(execFile);

type Git = (cwd: string, args: string[]) => Promise<string>;

interface MetadataContext {
  worktreePath: string;
  baseSha?: string;
  headSha: string;
}

interface MetadataDependencies {
  git?: Git;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function safeReviewPath(worktreePath: string, file: string): boolean {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) return false;
  const resolvedRoot = path.resolve(worktreePath);
  const resolvedFile = path.resolve(resolvedRoot, file);
  if (!isInside(resolvedRoot, resolvedFile)) return false;

  try {
    const realRoot = realpathSync(resolvedRoot);
    const realFile = realpathSync(resolvedFile);
    return isInside(realRoot, realFile);
  } catch {
    // Deleted files do not exist at head; lexical containment plus changed-file
    // membership below is the available trust boundary for those findings.
    return true;
  }
}

export function keepSafeReviewFindings(
  findings: Finding[],
  worktreePath: string,
  changedFiles: string[],
): Finding[] {
  const changed = new Set(changedFiles);
  return findings.filter((finding) =>
    changed.has(finding.file) && safeReviewPath(worktreePath, finding.file)
  );
}

export function gitRemoteWebUrl(remote: string): string | undefined {
  const value = remote.trim();
  const scp = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (scp) return `https://${scp[1]}/${scp[2].replace(/\.git$/, "")}`;

  try {
    const url = new URL(value);
    if (url.protocol === "ssh:") {
      return `https://${url.hostname}/${url.pathname.replace(/^\/+|\.git$/g, "")}`;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    url.pathname = url.pathname.replace(/\.git$/, "");
    return url.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function parseBlame(raw: string): { commitSha: string; author: string } | undefined {
  const lines = raw.split("\n");
  const commitSha = lines[0]?.split(/\s+/)[0];
  const author = lines.find((line) => line.startsWith("author "))?.slice("author ".length).trim();
  return commitSha && author ? { commitSha, author } : undefined;
}

function parseLog(raw: string): { commitSha: string; author: string } | undefined {
  const [commitSha, author] = raw.trim().split("\0");
  return commitSha && author ? { commitSha, author } : undefined;
}

export async function enrichFindingMetadata(
  finding: Finding,
  context: MetadataContext,
  dependencies: MetadataDependencies = {},
): Promise<Finding> {
  const git = dependencies.git ?? runGit;
  let metadata: { commitSha: string; author: string } | undefined;

  if (finding.line !== undefined) {
    try {
      metadata = parseBlame(await git(context.worktreePath, [
        "blame",
        "--line-porcelain",
        "-L",
        `${finding.line},${finding.line}`,
        context.headSha,
        "--",
        finding.file,
      ]));
    } catch {
      // Deleted paths and line-number drift fall back to the range history.
    }
  }
  const revision = context.baseSha
    ? `${context.baseSha}..${context.headSha}`
    : context.headSha;
  metadata ??= parseLog(await git(context.worktreePath, [
    "log",
    "-1",
    "--format=%H%x00%aN",
    revision,
    "--",
    finding.file,
  ]));
  if (!metadata) return finding;

  const remote = gitRemoteWebUrl(
    await git(context.worktreePath, ["remote", "get-url", "origin"]),
  );
  return {
    ...finding,
    author: metadata.author,
    commitSha: metadata.commitSha,
    ...(remote ? { commitUrl: `${remote}/-/commit/${metadata.commitSha}` } : {}),
  };
}
