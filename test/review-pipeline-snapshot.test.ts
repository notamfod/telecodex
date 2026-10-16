import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareReviewSnapshot } from "../src/review-pipeline-snapshot.js";

it("pins an immutable reviewed revision and coalesces concurrent requests", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tc-snapshot-"));
  const previous = process.env.REVIEW_PIPELINE_SNAPSHOT_ROOT;
  process.env.REVIEW_PIPELINE_SNAPSHOT_ROOT = directory;
  let snapshot: string | undefined;
  try {
    const cwd = process.cwd();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const paths = await Promise.all([prepareReviewSnapshot(cwd, head), prepareReviewSnapshot(cwd, head)]);
    snapshot = paths[0];
    expect(paths[1]).toBe(snapshot);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: snapshot, encoding: "utf8" }).trim()).toBe(head);
    expect(readFileSync(path.join(snapshot, "src/recipe-review-digest.ts"), "utf8"))
      .toBe(execFileSync("git", ["show", `${head}:src/recipe-review-digest.ts`], { cwd, encoding: "utf8" }));
    expect(await prepareReviewSnapshot(cwd, head)).toBe(snapshot);
  } finally {
    if (snapshot) execFileSync("git", ["worktree", "remove", snapshot], { cwd: process.cwd() });
    if (previous === undefined) delete process.env.REVIEW_PIPELINE_SNAPSHOT_ROOT;
    else process.env.REVIEW_PIPELINE_SNAPSHOT_ROOT = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
