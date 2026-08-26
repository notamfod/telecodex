import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { acquireRecipeRunLock } from "../src/recipe-run-lock.js";

describe("recipe run lock", () => {
  it("serializes recipe processes and releases the lock afterwards", () => {
    const lockPath = path.join(mkdtempSync(path.join(tmpdir(), "telecodex-recipe-lock-")), "run.lock");
    const release = acquireRecipeRunLock(lockPath);

    expect(canAcquire(lockPath)).toBe(false);
    release();
    expect(canAcquire(lockPath)).toBe(true);
  });
});

function canAcquire(lockPath: string): boolean {
  return spawnSync("/usr/bin/flock", ["--nonblock", lockPath, "/usr/bin/true"]).status === 0;
}
