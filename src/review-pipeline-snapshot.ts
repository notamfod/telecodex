import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const snapshots = new Map<string, Promise<string>>();

export async function prepareReviewSnapshot(cwd: string, headSha: string): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha) || !path.isAbsolute(cwd)) {
    throw new Error("Invalid pipeline revision");
  }
  const key = createHash("sha256").update(`${cwd}\0${headSha}`).digest("hex");
  let pending = snapshots.get(key);
  if (!pending) {
    pending = prepare(cwd, headSha, key);
    snapshots.set(key, pending);
    void pending.finally(() => snapshots.delete(key)).catch(() => undefined);
  }
  return pending;
}

async function prepare(cwd: string, headSha: string, key: string): Promise<string> {
  const root = path.resolve(process.env.REVIEW_PIPELINE_SNAPSHOT_ROOT || ".telecodex/review-pipeline/snapshots");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, key);
  let head: string | undefined;
  try { head = (await exec("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (head === undefined) {
    await exec("git", ["worktree", "add", "--detach", directory, headSha], { cwd });
    head = (await exec("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
  }
  const dirty = (await exec("git", ["status", "--porcelain"], { cwd: directory })).stdout;
  if (head !== headSha || dirty.trim()) throw new Error("Pipeline snapshot is not the reviewed revision");
  return directory;
}
