import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

  it("supports nonblocking contention and kernel release after a holder dies", async () => {
    const lockPath = path.join(mkdtempSync(path.join(tmpdir(), "telecodex-recipe-lock-")), "run.lock");
    const holder = spawn(process.execPath, ["-e", `
      const { closeSync, openSync } = require("node:fs");
      const { spawnSync } = require("node:child_process");
      const descriptor = openSync(process.argv[1], "a", 0o600);
      const result = spawnSync("/usr/bin/flock", ["--exclusive", "3"], {
        stdio: ["ignore", "ignore", "ignore", descriptor],
      });
      if (result.status !== 0) process.exit(1);
      process.on("exit", () => closeSync(descriptor));
      setInterval(() => {}, 1000);
    `, lockPath], {
      stdio: "ignore",
    });
    await waitForLock(lockPath);

    expect(() => acquireRecipeRunLock(lockPath, { nonBlocking: true })).toThrow("lock is busy");
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("close", () => resolve()));

    const release = acquireRecipeRunLock(lockPath, { nonBlocking: true });
    release();
    expect(canAcquire(lockPath)).toBe(true);
  });
});

function canAcquire(lockPath: string): boolean {
  return spawnSync("/usr/bin/flock", ["--nonblock", lockPath, "/usr/bin/true"]).status === 0;
}

async function waitForLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!canAcquire(lockPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("external lock holder did not start");
}
