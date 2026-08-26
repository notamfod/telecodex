import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

/**
 * Hold an advisory flock in this process for the whole recipe run.
 *
 * The short-lived flock child locks an inherited file description. The parent
 * keeps that same description open, so the kernel releases the lock on normal
 * exit, exceptions, signals, and crashes without stale lock files.
 */
export function acquireRecipeRunLock(lockPath: string): () => void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const descriptor = openSync(lockPath, "a", 0o600);
  const result = spawnSync("/usr/bin/flock", ["--exclusive", "3"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe", descriptor],
  });
  if (result.status !== 0 || result.error) {
    closeSync(descriptor);
    throw new Error(
      `failed to acquire recipe lock: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }

  let released = false;
  return () => {
    if (!released) {
      released = true;
      closeSync(descriptor);
    }
  };
}
