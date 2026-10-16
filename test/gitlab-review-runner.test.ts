import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runOwnedProcessGroup } from "../src/gitlab-review-runner.js";

describe("GitLab review owned process group", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("stores bounded runner output in a protected last-run log", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-review-runner-"));
    directories.push(directory);
    const outputLogPath = path.join(directory, "state", "queue.json.runner.log");
    const result = await runOwnedProcessGroup({
      file: process.execPath,
      args: ["-e", "process.stdout.write('useful output'); process.stderr.write('useful warning')"],
      cwd: directory,
      timeoutMs: 1_000,
      maxOutputBytes: 256 * 1024,
      outputLogPath,
    });

    expect(result).toEqual({ stdout: "useful output", stderr: "useful warning" });
    expect(readFileSync(outputLogPath, "utf8")).toContain("useful output");
    expect(readFileSync(outputLogPath, "utf8")).toContain("useful warning");
    expect(statSync(outputLogPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(outputLogPath)).mode & 0o777).toBe(0o700);
  });

  it.each(["abort", "timeout", "overflow"] as const)(
    "kills the runner and its descendant on %s",
    async (reason) => {
      const directory = mkdtempSync(path.join(tmpdir(), "telecodex-review-runner-"));
      directories.push(directory);
      const pidPath = path.join(directory, "pids.json");
      const scriptPath = path.join(directory, "runner.cjs");
      writeFileSync(scriptPath, dummyRunnerScript(reason === "overflow"), { mode: 0o700 });
      const controller = new AbortController();
      const operation = runOwnedProcessGroup({
        file: process.execPath,
        args: [scriptPath, pidPath],
        cwd: directory,
        signal: controller.signal,
        timeoutMs: reason === "timeout" ? 500 : 10_000,
        maxOutputBytes: reason === "overflow" ? 1024 : 256 * 1024,
        terminateGraceMs: 25,
      });
      const rejection = expect(operation).rejects.toThrow(`GitLab review runner ${reason}`);
      const pids = await waitForPids(pidPath);
      if (reason === "abort") controller.abort();

      await rejection;
      await waitForExit(pids.parent);
      await waitForExit(pids.child);
      expect(isAlive(pids.parent)).toBe(false);
      expect(isAlive(pids.child)).toBe(false);
    },
  );
});

function dummyRunnerScript(writeOverflow: boolean): string {
  return `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
${writeOverflow ? "setInterval(() => process.stdout.write('x'.repeat(4096)), 1);" : ""}
setInterval(() => {}, 1000);
`;
}

async function waitForPids(pidPath: string): Promise<{ parent: number; child: number }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(readFileSync(pidPath, "utf8")) as { parent: number; child: number };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("runner did not publish process ids");
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
