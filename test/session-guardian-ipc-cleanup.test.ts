import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SessionGuardianIpcClient,
  SessionGuardianIpcServer,
  type GuardianIpcCleanupDependencies,
} from "../src/session-guardian-ipc.js";
import { GuardianStartupOwnership } from "../src/session-guardian-ipc-lifecycle.js";
import { makeStaleSocket } from "./session-guardian-ipc-fixtures.js";

const ALERT_ID = "abcdefghijklmnopqrstuv";
const THREAD_ID = "01a02451-2fc4-76c0-9f14-c75034c10017";

describe("session guardian IPC cleanup", () => {
  let directory: string;
  let socketPath: string;
  const servers: SessionGuardianIpcServer[] = [];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-cleanup-"));
    socketPath = path.join(directory, "run", "guardian.sock");
  });

  afterEach(async () => {
    await Promise.allSettled(servers.map((server) => server.close()));
    rmSync(directory, { recursive: true, force: true });
  });

  function subject(options: {
    socketPath?: string;
    handlerDrainTimeoutMs?: number;
    status?: () => Promise<{ outcome: "ok"; message: string }>;
    cleanup?: Partial<GuardianIpcCleanupDependencies>;
  } = {}) {
    const server = new SessionGuardianIpcServer({
      socketPath: options.socketPath ?? socketPath,
      handlerDrainTimeoutMs: options.handlerDrainTimeoutMs,
      status: options.status ?? (async () => ({ outcome: "ok", message: "ready" })),
      checkAlert: async () => ({ outcome: "observation-only", threadId: THREAD_ID, detail: "checked" }),
      repairAlert: async () => ({ outcome: "restored", threadId: THREAD_ID, detail: "restored" }),
      cleanup: options.cleanup,
    });
    servers.push(server);
    return server;
  }

  it("keeps ownership after a bounded drain timeout and permits a later cleanup retry", async () => {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let finishResolve!: (value: { outcome: "ok"; message: string }) => void;
    const finish = new Promise<{ outcome: "ok"; message: string }>((resolve) => {
      finishResolve = resolve;
    });
    const owner = subject({
      handlerDrainTimeoutMs: 40,
      status: async () => {
        enteredResolve();
        return await finish;
      },
    });
    await owner.start();
    const requestResult = new SessionGuardianIpcClient(socketPath).status().catch(() => undefined);
    await entered;

    await expect(owner.close()).rejects.toThrow("Guardian IPC handlers did not drain");
    await expect(owner.start()).rejects.toThrow("Guardian IPC server is closed");
    const competitor = subject();
    await expect(competitor.start()).rejects.toThrow("Guardian IPC startup is already owned");

    finishResolve({ outcome: "ok", message: "done" });
    await requestResult;
    await expect(owner.close()).resolves.toBeUndefined();
    const successor = subject();
    await expect(successor.start()).resolves.toBeUndefined();
    await successor.close();
  });

  it("uses atomic startup ownership so only one concurrent stale cleanup can win", async () => {
    makeStaleSocket(socketPath);
    const first = subject();
    const second = subject();

    const results = await Promise.allSettled([first.start(), second.start()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ message: "Guardian IPC startup is already owned" });
    await expect(new SessionGuardianIpcClient(socketPath).status()).resolves.toMatchObject({
      outcome: "ok",
    });
    const winner = results[0]!.status === "fulfilled" ? first : second;
    await winner.close();

    const afterRelease = subject();
    await expect(afterRelease.start()).resolves.toBeUndefined();
    await afterRelease.close();
  });

  it("canonicalizes repeated separators before acquiring startup ownership", async () => {
    makeStaleSocket(socketPath);
    const aliasPath = `${path.dirname(socketPath)}//${path.basename(socketPath)}`;
    const first = subject({ socketPath });
    const second = subject({ socketPath: aliasPath });

    const results = await Promise.allSettled([first.start(), second.start()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ message: "Guardian IPC startup is already owned" });
    await expect(new SessionGuardianIpcClient(socketPath).status()).resolves.toMatchObject({
      outcome: "ok",
    });
  });

  it("canonicalizes a symlinked ancestor before acquiring startup ownership", async () => {
    const realRoot = path.join(directory, "real-runtime");
    const realSocketPath = path.join(realRoot, "run", "guardian.sock");
    makeStaleSocket(realSocketPath);
    const aliasRoot = path.join(directory, "runtime-alias");
    symlinkSync(realRoot, aliasRoot);
    const aliasSocketPath = path.join(aliasRoot, "run", "guardian.sock");
    const first = subject({ socketPath: realSocketPath });
    const second = subject({ socketPath: aliasSocketPath });

    const results = await Promise.allSettled([first.start(), second.start()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ message: "Guardian IPC startup is already owned" });
    await expect(new SessionGuardianIpcClient(realSocketPath).status()).resolves.toMatchObject({
      outcome: "ok",
    });
  });

  it("keeps the advisory lock file private inside the canonical runtime directory", async () => {
    const owner = subject();
    await owner.start();

    const parent = path.dirname(socketPath);
    const lockPath = path.join(parent, `.${path.basename(socketPath)}.startup.lock`);
    expect(lstatSync(parent).mode & 0o777).toBe(0o700);
    expect(lstatSync(lockPath).isFile()).toBe(true);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);

    await owner.close();
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlink at the advisory lock path without touching its target", async () => {
    const parent = path.dirname(socketPath);
    makeStaleSocket(socketPath);
    const target = path.join(directory, "lock-target");
    writeFileSync(target, "unchanged");
    symlinkSync(target, path.join(parent, `.${path.basename(socketPath)}.startup.lock`));
    const owner = subject();

    await expect(owner.start()).rejects.toThrow("Guardian IPC startup ownership failed");
    expect(readFileSync(target, "utf8")).toBe("unchanged");
    expect(lstatSync(socketPath).isSocket()).toBe(true);
  });

  it("releases advisory ownership when the holder process crashes and closes its pipe", async () => {
    makeStaleSocket(socketPath);
    const holder = await startOwnershipHolder(socketPath);
    const blocked = subject();
    await expect(blocked.start()).rejects.toThrow("Guardian IPC startup is already owned");

    holder.kill("SIGKILL");
    await waitForChildExit(holder);

    let successor: SessionGuardianIpcServer | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = subject();
      try {
        await candidate.start();
        successor = candidate;
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Guardian IPC startup is already owned") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(successor).toBeDefined();
    await successor!.close();
  });

  it("keeps advisory ownership when lifecycle signals target the holder directly", async () => {
    makeStaleSocket(socketPath);
    const ownership = await GuardianStartupOwnership.acquire(socketPath);
    const holder = ownershipChild(ownership);

    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.kill(holder.pid!, signal);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(GuardianStartupOwnership.acquire(socketPath)).rejects.toThrow(
        "Guardian IPC startup is already owned",
      );
    }

    await ownership.release();
    const successor = await GuardianStartupOwnership.acquire(socketPath);
    await successor.release();
  });

  it("detects unexpected holder loss and still cleans the running transport", async () => {
    const owner = subject();
    await owner.start();
    const ownership = serverOwnership(owner);
    const holder = ownershipChild(ownership);

    process.kill(holder.pid!, "SIGKILL");
    await waitForChildExit(holder);
    const successor = await GuardianStartupOwnership.acquire(socketPath);
    await successor.release();

    await expect(owner.close()).rejects.toThrow("Guardian IPC startup ownership was lost");
    expect(() => lstatSync(socketPath)).toThrow();
    await expect(owner.close()).resolves.toBeUndefined();
  });

  it("rejects a symlinked parent alias before touching the canonical socket", async () => {
    makeStaleSocket(socketPath);
    const aliasParent = path.join(directory, "run-alias");
    symlinkSync(path.dirname(socketPath), aliasParent);
    const aliasPath = path.join(aliasParent, path.basename(socketPath));
    const owner = subject({ socketPath: aliasPath });

    await expect(owner.start()).rejects.toThrow("Guardian IPC parent is not a safe directory");
    expect(lstatSync(socketPath).isSocket()).toBe(true);
  });

  it.each(["lstat", "rename"])(
    "continues stopping connections after an injected %s preserve failure",
    async (stage) => {
      let failPreserve = true;
      let stopCalls = 0;
      let removeCalls = 0;
      const cleanup: Partial<GuardianIpcCleanupDependencies> = {
        preserveReplacement: async () => {
          if (failPreserve) {
            failPreserve = false;
            throw new Error(`${stage} preserve failed`);
          }
          return undefined;
        },
        stopTransport: async (server, connections) => {
          stopCalls += 1;
          await stopForTest(server, connections);
        },
        removeOwnSocket: async () => { removeCalls += 1; },
      };
      const owner = subject({ cleanup });
      await owner.start();
      const connection = createConnection({ path: socketPath });
      await new Promise<void>((resolve) => connection.once("connect", resolve));
      const disconnected = new Promise<void>((resolve) => connection.once("close", resolve));

      await expect(owner.close()).rejects.toBeInstanceOf(AggregateError);
      await disconnected;
      expect(stopCalls).toBe(1);
      expect(removeCalls).toBe(1);
      await expect(owner.close()).resolves.toBeUndefined();
    },
  );

  it("attempts replacement restoration even when own-socket removal fails", async () => {
    let failRemoval = true;
    let restoreCalls = 0;
    const owner = subject({
      cleanup: {
        removeOwnSocket: async () => {
          if (failRemoval) {
            failRemoval = false;
            throw new Error("remove failed");
          }
        },
        restoreReplacement: async (preserved, target) => {
          restoreCalls += 1;
          await rename(preserved, target);
        },
      },
    });
    await owner.start();
    renameSync(socketPath, `${socketPath}.original`);
    writeFileSync(socketPath, "replacement");

    await expect(owner.close()).rejects.toBeInstanceOf(AggregateError);
    expect(restoreCalls).toBe(1);
    expect(readFileSync(socketPath, "utf8")).toBe("replacement");
    await expect(owner.close()).resolves.toBeUndefined();
  });

  it("keeps ownership after transport cleanup fails and retries every stage", async () => {
    let failStop = true;
    let stopCalls = 0;
    let removeCalls = 0;
    const owner = subject({
      cleanup: {
        stopTransport: async (server, connections) => {
          stopCalls += 1;
          if (failStop) {
            failStop = false;
            throw new Error("transport close failed");
          }
          await stopForTest(server, connections);
        },
        removeOwnSocket: async () => { removeCalls += 1; },
      },
    });
    await owner.start();
    const connection = createConnection({ path: socketPath });
    await new Promise<void>((resolve) => connection.once("connect", resolve));
    const disconnected = new Promise<void>((resolve) => connection.once("close", resolve));

    await expect(owner.close()).rejects.toBeInstanceOf(AggregateError);
    await disconnected;
    const competitor = subject();
    await expect(competitor.start()).rejects.toThrow("Guardian IPC startup is already owned");
    await expect(owner.close()).resolves.toBeUndefined();
    expect(stopCalls).toBe(2);
    expect(removeCalls).toBe(2);
    expect(() => lstatSync(socketPath)).toThrow();
  });

  it("rejects a non-positive handler drain deadline", () => {
    expect(() => subject({ handlerDrainTimeoutMs: 0 })).toThrow(
      "handlerDrainTimeoutMs must be a positive integer",
    );
  });
});

async function stopForTest(
  server: import("node:http").Server,
  connections: Set<Socket>,
): Promise<void> {
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

async function startOwnershipHolder(socketPath: string): Promise<ChildProcess> {
  const moduleUrl = pathToFileURL(path.resolve("src/session-guardian-ipc-lifecycle.ts")).href;
  const code = [
    "const { GuardianStartupOwnership } = await import(process.argv[1])",
    "await GuardianStartupOwnership.acquire(process.argv[2])",
    'process.stdout.write("HOLDER_READY\\n")',
    "process.stdin.resume()",
  ].join(";");
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    code,
    moduleUrl,
    socketPath,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const deadline = setTimeout(() => reject(new Error("ownership holder did not start")), 2_000);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("HOLDER_READY\n")) {
        clearTimeout(deadline);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`ownership holder exited: ${code}`)));
  });
  return child;
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("ownership holder did not exit")), 2_000);
    child.once("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

function ownershipChild(ownership: GuardianStartupOwnership): ChildProcess {
  return (ownership as unknown as { child: ChildProcess }).child;
}

function serverOwnership(server: SessionGuardianIpcServer): GuardianStartupOwnership {
  return (server as unknown as { ownership: GuardianStartupOwnership }).ownership;
}
import { spawn, type ChildProcess } from "node:child_process";
