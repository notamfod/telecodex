import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { safeWeeklyText, type Period, type WeeklyProject } from "./weekly-activity.js";
const exec = promisify(execFile);

/** Local corroboration only: commits by other authors are not personal accomplishments. */
export async function weeklyCommitEvidence(project: WeeklyProject, period: Period): Promise<string> {
  const repositories = new Set<string>();
  async function visit(root: string, depth: number): Promise<void> {
    if (existsSync(path.join(root, ".git"))) { repositories.add(root); return; }
    if (depth === 0) return;
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        await visit(path.join(root, entry.name), depth - 1);
      }
    }
  }
  for (const root of project.roots) await visit(root, 2);
  const output: string[] = [];
  for (const cwd of repositories) {
    try {
      const { stdout } = await exec("git", ["log", "--all", "--max-count=150",
        `--since=${new Date(period.start).toISOString()}`, `--until=${new Date(period.end - 1).toISOString()}`,
        "--format=%h %s"], { cwd, timeout: 10_000, maxBuffer: 256 * 1024 });
      if (stdout.trim()) output.push(`${path.basename(cwd)}:\n${safeWeeklyText(stdout).slice(0, 12000)}`);
    } catch { output.push(`${path.basename(cwd)}: локальная история git недоступна`); }
  }
  return output.join("\n").slice(0, 24000);
}
