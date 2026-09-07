import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

const SOCKET_PROBE_TIMEOUT_MS = 250;
const OWNERSHIP_ACQUIRE_TIMEOUT_MS = 1_000;
const OWNERSHIP_RELEASE_TIMEOUT_MS = 1_000;
const FLOCK_PATH = "/usr/bin/flock";
const FLOCK_CHILD_CODE = [
  'const { spawnSync } = require("node:child_process")',
  "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {})",
  `const result = spawnSync(${JSON.stringify(FLOCK_PATH)}, ["-n", "3"], `
    + "{ stdio: ['ignore', 'ignore', 'ignore', 3] })",
  "if (result.error) process.exit(74)",
  "if (result.status !== 0) process.exit(result.status === 1 ? 73 : 74)",
  'process.stdout.write("READY\\n")',
  "process.stdin.resume()",
  "process.stdin.once('end', () => process.exit(0))",
].join(";");

export interface GuardianSocketIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface GuardianIpcCleanupDependencies {
  preserveReplacement(
    socketPath: string,
    identity: GuardianSocketIdentity | undefined,
  ): Promise<string | undefined>;
  stopTransport(server: HttpServer, connections: Set<Socket>): Promise<void>;
  removeOwnSocket(
    socketPath: string,
    identity: GuardianSocketIdentity | undefined,
  ): Promise<void>;
  restoreReplacement(preserved: string, socketPath: string): Promise<void>;
}

export const DEFAULT_GUARDIAN_IPC_CLEANUP: GuardianIpcCleanupDependencies = {
  preserveReplacement,
  stopTransport,
  removeOwnSocket,
  restoreReplacement,
};

export class GuardianStartupOwnership {
  private releasePromise: Promise<void> | undefined;
  private releasing = false;
  private ownershipLost = false;

  private constructor(private readonly child: ChildProcess) {
    const recordLoss = () => {
      if (!this.releasing) this.ownershipLost = true;
    };
    child.once("exit", recordLoss);
    child.once("error", recordLoss);
    child.stdin?.on("error", () => undefined);
    if (child.exitCode !== null || child.signalCode !== null) recordLoss();
  }

  static async acquire(socketPath: string): Promise<GuardianStartupOwnership> {
    const lockPath = path.join(
      path.dirname(socketPath),
      `.${path.basename(socketPath)}.startup.lock`,
    );
    let handle;
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      const stat = await handle.stat({ bigint: true });
      if (
        !stat.isFile()
        || !isOwnedByCurrentUser(stat.uid)
        || (Number(stat.mode) & 0o077) !== 0
      ) throw new Error("unsafe lock file");
      const child = spawn(process.execPath, [
        "--input-type=commonjs",
        "-e",
        FLOCK_CHILD_CODE,
      ], {
        stdio: ["pipe", "pipe", "pipe", handle.fd],
      });
      child.stderr?.resume();
      await waitForOwnership(child);
      await handle.close();
      handle = undefined;
      return new GuardianStartupOwnership(child);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof OwnershipUnavailableError) {
        throw new Error("Guardian IPC startup is already owned");
      }
      throw new Error("Guardian IPC startup ownership failed");
    }
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    try { this.assertHeld(); } catch (error) { return Promise.reject(error); }
    this.releasing = true;
    const attempt = releaseOwnershipChild(this.child);
    this.releasePromise = attempt;
    void attempt.catch(() => {
      if (this.releasePromise === attempt) this.releasePromise = undefined;
      this.releasing = false;
    });
    return attempt;
  }

  assertHeld(): void {
    if (
      this.ownershipLost
      || (!this.releasing && (this.child.exitCode !== null || this.child.signalCode !== null))
    ) {
      this.ownershipLost = true;
      throw new Error("Guardian IPC startup ownership was lost");
    }
  }

  hasLostOwnership(): boolean {
    try {
      this.assertHeld();
      return false;
    } catch {
      return true;
    }
  }
}

class OwnershipUnavailableError extends Error {}

export async function canonicalizeGuardianSocketPath(socketPath: string): Promise<string> {
  const rawParent = path.dirname(socketPath);
  await ensurePrivateParent(rawParent);
  const canonicalParent = await realpath(rawParent);
  const basename = path.basename(path.resolve(socketPath));
  return path.join(canonicalParent, basename);
}

export async function ensurePrivateParent(parent: string): Promise<void> {
  let existed = true;
  try { await lstat(parent); } catch (error) {
    if (!isMissing(error)) throw error;
    existed = false;
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stat = await lstat(parent, { bigint: true });
  if (
    !stat.isDirectory()
    || !isOwnedByCurrentUser(stat.uid)
    || (Number(stat.mode) & 0o077) !== 0
  ) throw new Error("Guardian IPC parent is not a safe directory");
  if (!existed) await chmod(parent, 0o700);
}

export async function removeOwnedStaleSocket(socketPath: string): Promise<void> {
  let stat;
  try { stat = await lstat(socketPath, { bigint: true }); } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try { assertOwnedSocket(stat); } catch {
    throw new Error("Guardian IPC path is not a safe stale socket");
  }
  const probe = await probeUnixSocket(socketPath);
  if (probe === "live") throw new Error("Guardian IPC socket is already active");
  if (probe === "missing") return;
  let confirmed;
  try { confirmed = await lstat(socketPath, { bigint: true }); } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (confirmed.dev !== stat.dev || confirmed.ino !== stat.ino || !confirmed.isSocket()) {
    throw new Error("Guardian IPC path changed before stale socket removal");
  }
  await unlink(socketPath);
}

export async function listenAndSecure(
  server: HttpServer,
  socketPath: string,
): Promise<GuardianSocketIdentity> {
  await listenHttp(server, socketPath);
  const before = await lstat(socketPath, { bigint: true });
  assertOwnedSocket(before);
  await chmod(socketPath, constants.S_IRUSR | constants.S_IWUSR);
  const after = await lstat(socketPath, { bigint: true });
  assertOwnedSocket(after);
  if (after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("Guardian IPC socket changed during startup");
  }
  return { dev: after.dev, ino: after.ino };
}

async function preserveReplacement(
  socketPath: string,
  identity: GuardianSocketIdentity | undefined,
): Promise<string | undefined> {
  if (!identity) return undefined;
  try {
    const current = await lstat(socketPath, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) return undefined;
    const preserved = `${socketPath}.replacement-${randomBytes(16).toString("hex")}`;
    await rename(socketPath, preserved);
    return preserved;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function removeOwnSocket(
  socketPath: string,
  identity: GuardianSocketIdentity | undefined,
): Promise<void> {
  if (!identity) return;
  try {
    const current = await lstat(socketPath, { bigint: true });
    if (
      current.isSocket()
      && current.dev === identity.dev
      && current.ino === identity.ino
      && isOwnedByCurrentUser(current.uid)
    ) await unlink(socketPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function restoreReplacement(preserved: string, socketPath: string): Promise<void> {
  try {
    await lstat(socketPath);
    throw new Error("Guardian IPC path was replaced again during shutdown");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await rename(preserved, socketPath);
}

async function stopTransport(server: HttpServer, connections: Set<Socket>): Promise<void> {
  if (!server.listening) {
    for (const socket of connections) socket.destroy();
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const socket of connections) socket.destroy();
    server.closeAllConnections?.();
  });
}

function probeUnixSocket(socketPath: string): Promise<"live" | "stale" | "missing"> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Guardian IPC socket probe timed out"));
    }, SOCKET_PROBE_TIMEOUT_MS);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    socket.once("connect", () => {
      finish(() => resolve("live"));
      socket.destroy();
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "ECONNREFUSED") resolve("stale");
        else if (error.code === "ENOENT") resolve("missing");
        else reject(new Error("Guardian IPC socket probe failed"));
      });
    });
  });
}

function listenHttp(server: HttpServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function assertOwnedSocket(stat: Awaited<ReturnType<typeof lstat>>): void {
  if (!stat.isSocket() || !isOwnedByCurrentUser(stat.uid)) throw new Error("Unsafe guardian IPC socket");
}

function isOwnedByCurrentUser(uid: number | bigint): boolean {
  const current = process.getuid?.();
  return current === undefined || BigInt(uid) === BigInt(current);
}

function isMissing(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function waitForOwnership(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > 64) {
        finish(() => reject(new Error("invalid ownership marker")));
        child.kill("SIGKILL");
        return;
      }
      const lineEnd = output.indexOf("\n");
      if (lineEnd >= 0) {
        if (output.slice(0, lineEnd) === "READY") finish(resolve);
        else {
          finish(() => reject(new Error("invalid ownership marker")));
          child.kill("SIGKILL");
        }
      }
    };
    const onError = () => finish(() => reject(new Error("ownership spawn failed")));
    const onExit = (code: number | null) => finish(() => reject(
      code === 73 ? new OwnershipUnavailableError() : new Error("ownership child exited"),
    ));
    const deadline = setTimeout(() => {
      finish(() => reject(new Error("ownership acquisition timed out")));
      child.kill("SIGKILL");
    }, OWNERSHIP_ACQUIRE_TIMEOUT_MS);
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function releaseOwnershipChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  if (await waitForExit(child, OWNERSHIP_RELEASE_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, OWNERSHIP_RELEASE_TIMEOUT_MS)) {
    throw new Error("Guardian IPC startup ownership release failed");
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(deadline);
      child.off("exit", onExit);
    };
    const onExit = () => { cleanup(); resolve(true); };
    const deadline = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}
