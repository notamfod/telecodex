import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface OwnedProcessGroupOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly terminateGraceMs?: number;
  readonly outputLogPath?: string;
}

export interface OwnedProcessGroupResult {
  readonly stdout: string;
  readonly stderr: string;
}

type TerminationReason = "abort" | "timeout" | "overflow" | "failed";

export function runOwnedProcessGroup(
  options: OwnedProcessGroupOptions,
): Promise<OwnedProcessGroupResult> {
  validateOptions(options);
  if (options.signal?.aborted) return Promise.reject(new Error("GitLab review runner abort"));

  return new Promise((resolve, reject) => {
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let reason: TerminationReason | undefined;
    let closeSeen = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let forceKillDone = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => beginTermination("timeout"), options.timeoutMs);
    const abort = () => beginTermination("abort");
    options.signal?.addEventListener("abort", abort, { once: true });

    const capture = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      const remaining = Math.max(0, options.maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        target.push(buffer.subarray(0, remaining));
        capturedBytes += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) beginTermination("overflow");
    };
    child.stdout?.on("data", (chunk) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk) => capture(stderr, chunk));

    child.once("error", () => {
      reason ??= "failed";
      forceKillDone = true;
    });
    child.once("close", (code, signal) => {
      closeSeen = true;
      closeCode = code;
      closeSignal = signal;
      clearTimeout(timeout);
      if (!reason && code !== 0) beginTermination("failed");
      if (!reason) {
        killGroup(child, "SIGKILL");
        forceKillDone = true;
      }
      void finishIfReady();
    });

    function beginTermination(nextReason: TerminationReason): void {
      if (reason) return;
      reason = nextReason;
      clearTimeout(timeout);
      killGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        killGroup(child, "SIGKILL");
        forceKillDone = true;
        void finishIfReady();
      }, options.terminateGraceMs ?? 1_000);
    }

    async function finishIfReady(): Promise<void> {
      if (settled || !closeSeen || (reason && !forceKillDone)) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      try {
        if (options.outputLogPath) {
          await persistLastRunLog(options.outputLogPath, result, reason, closeCode, closeSignal);
        }
      } catch {
        reject(new Error("GitLab review runner log write failed"));
        return;
      }
      if (reason) reject(new Error(`GitLab review runner ${reason}`));
      else resolve(result);
    }
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.pid <= 0) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function persistLastRunLog(
  outputLogPath: string,
  output: OwnedProcessGroupResult,
  reason: TerminationReason | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  if (!path.isAbsolute(outputLogPath) || path.normalize(outputLogPath) !== outputLogPath) {
    throw new Error("runner output log path must be absolute and normalized");
  }
  const directory = path.dirname(outputLogPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${outputLogPath}.tmp-${process.pid}-${randomUUID()}`;
  const metadata = JSON.stringify({
    completedAt: new Date().toISOString(),
    outcome: reason ?? "completed",
    code,
    signal,
    stdoutBytes: Buffer.byteLength(output.stdout),
    stderrBytes: Buffer.byteLength(output.stderr),
  });
  try {
    await writeFile(
      temporary,
      `${metadata}\n--- stdout ---\n${output.stdout}\n--- stderr ---\n${output.stderr}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporary, outputLogPath);
    await chmod(outputLogPath, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function validateOptions(options: OwnedProcessGroupOptions): void {
  if (process.platform !== "linux") throw new Error("GitLab review process groups require Linux");
  if (!path.isAbsolute(options.file) || !path.isAbsolute(options.cwd)) {
    throw new Error("GitLab review runner file and cwd must be absolute");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("GitLab review runner timeout must be positive");
  }
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new Error("GitLab review runner output limit must be positive");
  }
  if (options.terminateGraceMs !== undefined
    && (!Number.isInteger(options.terminateGraceMs) || options.terminateGraceMs < 1)) {
    throw new Error("GitLab review runner termination grace must be positive");
  }
}
