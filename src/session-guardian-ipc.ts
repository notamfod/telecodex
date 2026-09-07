import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { assertGuardianSocketPath, type GuardianIpcResponse,
  type GuardianScanSummary, type GuardianThreadInspection } from "./session-guardian-ipc-client.js";
import { guardianInspectResponse, guardianRepairResponse, guardianRouteMethod,
  guardianScanResponse, guardianStatusResponse, parseGuardianIpcRoute }
  from "./session-guardian-ipc-protocol.js";
import {
  DEFAULT_GUARDIAN_IPC_CLEANUP,
  GuardianStartupOwnership,
  canonicalizeGuardianSocketPath,
  listenAndSecure,
  removeOwnedStaleSocket,
  type GuardianIpcCleanupDependencies,
  type GuardianSocketIdentity,
} from "./session-guardian-ipc-lifecycle.js";
import type { GuardianRepairResult } from "./session-guardian-types.js";

export { GuardianIpcTimeoutError, SessionGuardianIpcClient } from "./session-guardian-ipc-client.js";
export type {
  GuardianIpcClientOptions,
  GuardianIpcOutcome,
  GuardianIpcResponse,
} from "./session-guardian-ipc-client.js";
export type { GuardianIpcCleanupDependencies } from "./session-guardian-ipc-lifecycle.js";

const MAX_REQUEST_BYTES = 4 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 5_000;
const DEFAULT_HANDLER_DRAIN_TIMEOUT_MS = 120_000;

export interface GuardianIpcServerOptions {
  readonly socketPath: string;
  readonly status: () => GuardianIpcResponse | Promise<GuardianIpcResponse>;
  readonly checkAlert: (alertId: string) => GuardianRepairResult | Promise<GuardianRepairResult>;
  readonly repairAlert: (alertId: string) => GuardianRepairResult | Promise<GuardianRepairResult>;
  readonly scan?: () => GuardianScanSummary | Promise<GuardianScanSummary>;
  readonly inspectThread?: (threadId: string) => GuardianThreadInspection | Promise<GuardianThreadInspection>;
  readonly repairThread?: (threadId: string) => GuardianRepairResult | Promise<GuardianRepairResult>;
  readonly bodyReadTimeoutMs?: number;
  readonly handlerDrainTimeoutMs?: number;
  readonly cleanup?: Partial<GuardianIpcCleanupDependencies>;
}

type LifecycleState = "new" | "starting" | "running" | "closing" | "closed";

class HttpFailure extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly closeTransport = false,
  ) {
    super(message);
  }
}

export class SessionGuardianIpcServer {
  readonly dependencies: GuardianIpcServerOptions;
  private readonly bodyReadTimeoutMs: number;
  private readonly handlerDrainTimeoutMs: number;
  private readonly cleanup: GuardianIpcCleanupDependencies;
  private readonly connections = new Set<Socket>();
  private readonly activeHandlers = new Set<Promise<void>>();
  private server: Server | undefined;
  private ownership: GuardianStartupOwnership | undefined;
  private socketPath: string | undefined;
  private socketIdentity: GuardianSocketIdentity | undefined;
  private preservedReplacement: string | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private state: LifecycleState = "new";

  constructor(options: GuardianIpcServerOptions) {
    assertGuardianSocketPath(options.socketPath);
    this.bodyReadTimeoutMs = positiveInteger(
      options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS,
      "bodyReadTimeoutMs",
    );
    this.handlerDrainTimeoutMs = positiveInteger(
      options.handlerDrainTimeoutMs ?? DEFAULT_HANDLER_DRAIN_TIMEOUT_MS,
      "handlerDrainTimeoutMs",
    );
    this.cleanup = { ...DEFAULT_GUARDIAN_IPC_CLEANUP, ...options.cleanup };
    this.dependencies = options;
  }

  start(): Promise<void> {
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(new Error("Guardian IPC server is closed"));
    }
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.state = "starting";
    const started = this.startInternal();
    this.startPromise = started;
    void started.then(
      () => { if (this.state === "starting") this.state = "running"; },
      () => {
        if (this.state === "starting") this.state = this.ownership ? "closing" : "closed";
      },
    );
    return started;
  }

  close(): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    const attempt = this.closeInternal();
    this.closePromise = attempt;
    void attempt.then(
      () => {
        this.state = "closed";
        this.closePromise = undefined;
      },
      () => {
        this.state = "closing";
        this.closePromise = undefined;
      },
    );
    return attempt;
  }

  private async startInternal(): Promise<void> {
    try {
      this.socketPath = await canonicalizeGuardianSocketPath(this.dependencies.socketPath);
      this.ownership = await GuardianStartupOwnership.acquire(this.socketPath);
      this.ownership.assertHeld();
      await removeOwnedStaleSocket(this.socketPath);
      this.ownership.assertHeld();
      const server = createServer((req, res) => this.trackHandler(this.handle(req, res)));
      server.on("connection", (socket) => {
        this.connections.add(socket);
        socket.once("close", () => this.connections.delete(socket));
      });
      this.server = server;
      this.ownership.assertHeld();
      this.socketIdentity = await listenAndSecure(server, this.socketPath);
      this.ownership.assertHeld();
    } catch (error) {
      if (!this.ownership) throw error;
      const cleanupErrors = await this.tryCleanupStages();
      if (cleanupErrors.length > 0) throw lifecycleAggregate([error, ...cleanupErrors]);
      throw error;
    }
  }

  private trackHandler(operation: Promise<void>): void {
    this.activeHandlers.add(operation);
    void operation.then(
      () => this.activeHandlers.delete(operation),
      () => this.activeHandlers.delete(operation),
    );
  }

  private async closeInternal(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const errors = await this.tryCleanupStages();
    if (errors.length > 0) throw lifecycleAggregate(errors);
  }

  private async tryCleanupStages(): Promise<unknown[]> {
    const errors: unknown[] = [];
    let ownershipLost = false;
    if (this.ownership) {
      try { this.ownership.assertHeld(); }
      catch (error) {
        errors.push(error);
        ownershipLost = true;
      }
    }
    const socketPath = this.socketPath;
    if (socketPath && !this.preservedReplacement) {
      try {
        this.preservedReplacement = await this.cleanup.preserveReplacement(
          socketPath,
          this.socketIdentity,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.server) {
      try { await this.cleanup.stopTransport(this.server, this.connections); }
      catch (error) {
        errors.push(error);
        try { this.forceStopTransport(); }
        catch (fallbackError) { errors.push(fallbackError); }
      }
    }

    try { await this.drainHandlers(); }
    catch (error) {
      errors.push(error);
      return errors;
    }

    if (socketPath) {
      try {
        await this.cleanup.removeOwnSocket(socketPath, this.socketIdentity);
        this.socketIdentity = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (socketPath && this.preservedReplacement) {
      try {
        await this.cleanup.restoreReplacement(
          this.preservedReplacement,
          socketPath,
        );
        this.preservedReplacement = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.ownership && !ownershipLost) {
      try { this.ownership.assertHeld(); }
      catch (error) {
        errors.push(error);
        ownershipLost = true;
      }
    }
    if (ownershipLost) {
      this.ownership = undefined;
    } else if (errors.length === 0 && this.ownership) {
      const ownership = this.ownership;
      try {
        await ownership.release();
        this.ownership = undefined;
      } catch (error) {
        errors.push(error);
        if (ownership.hasLostOwnership()) this.ownership = undefined;
      }
    }
    return errors;
  }

  private forceStopTransport(): void {
    for (const socket of this.connections) socket.destroy();
    this.server?.closeAllConnections?.();
    if (this.server?.listening) this.server.close();
  }

  private async drainHandlers(): Promise<void> {
    if (this.activeHandlers.size === 0) return;
    let deadline: NodeJS.Timeout | undefined;
    const drained = (async () => {
      while (this.activeHandlers.size > 0) {
        await Promise.allSettled([...this.activeHandlers]);
      }
    })();
    try {
      await Promise.race([
        drained,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Guardian IPC handlers did not drain")),
            this.handlerDrainTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = parseGuardianIpcRoute(req.url);
    if (!route) return writeJson(res, 404, failure("Guardian IPC route not found"));
    const expectedMethod = guardianRouteMethod(route);
    if (req.method !== expectedMethod) {
      res.setHeader("allow", expectedMethod);
      return writeJson(res, 405, failure("Guardian IPC method not allowed"));
    }
    try {
      await validateBody(req, expectedMethod === "GET", this.bodyReadTimeoutMs);
      if (route.kind === "status") {
        return writeJson(res, 200, guardianStatusResponse(await this.dependencies.status()));
      }
      if (route.kind === "scan") {
        if (!this.dependencies.scan) throw new Error("Guardian scan is unavailable");
        return writeJson(res, 200, guardianScanResponse(await this.dependencies.scan()));
      }
      if (route.kind === "inspect") {
        if (!this.dependencies.inspectThread) throw new Error("Guardian inspect is unavailable");
        const inspected = await this.dependencies.inspectThread(route.threadId);
        if (inspected.threadId !== route.threadId) throw new Error("Guardian inspect mismatch");
        return writeJson(res, 200, guardianInspectResponse(inspected));
      }
      if (route.kind === "repair-thread") {
        if (!this.dependencies.repairThread) throw new Error("Guardian repair is unavailable");
        const repaired = await this.dependencies.repairThread(route.threadId);
        if (repaired.threadId !== route.threadId) throw new Error("Guardian repair mismatch");
        return writeJson(res, 200, guardianRepairResponse(repaired));
      }
      const result = route.kind === "check"
        ? await this.dependencies.checkAlert(route.alertId)
        : await this.dependencies.repairAlert(route.alertId);
      writeJson(res, 200, guardianRepairResponse(result));
    } catch (error) {
      if (error instanceof HttpFailure) {
        if (error.closeTransport) prepareTransportClose(req, res);
        writeJson(res, error.statusCode, failure(error.message));
      } else {
        writeJson(res, 503, failure("Guardian operation failed"));
      }
    }
  }
}

function lifecycleAggregate(errors: unknown[]): AggregateError {
  const ownershipLost = errors.some(
    (error) => error instanceof Error
      && error.message === "Guardian IPC startup ownership was lost",
  );
  const drainFailed = errors.some(
    (error) => error instanceof Error && error.message === "Guardian IPC handlers did not drain",
  );
  return new AggregateError(
    errors,
    ownershipLost
      ? "Guardian IPC startup ownership was lost"
      : drainFailed
        ? "Guardian IPC handlers did not drain"
        : "Guardian IPC lifecycle cleanup failed",
  );
}

async function validateBody(
  req: IncomingMessage,
  bodyForbidden: boolean,
  timeoutMs: number,
): Promise<void> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    req.pause();
    throw new HttpFailure(413, "Guardian IPC request body is too large", true);
  }
  const body = await readBody(req, timeoutMs);
  if (body.length === 0) return;
  if (bodyForbidden) throw new HttpFailure(400, "Guardian IPC request body is not allowed");
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpFailure(415, "Guardian IPC request content type must be application/json");
  }
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("not an object");
  } catch {
    throw new HttpFailure(400, "Guardian IPC request body must be a JSON object");
  }
}

function readBody(req: IncomingMessage, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: Buffer | string) => {
      total += Buffer.byteLength(chunk);
      if (total > MAX_REQUEST_BYTES) {
        req.pause();
        finish(() => reject(new HttpFailure(
          413,
          "Guardian IPC request body is too large",
          true,
        )));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks)));
    const onAborted = () => finish(() => reject(new Error("Guardian IPC request aborted")));
    const onError = () => finish(() => reject(new Error("Guardian IPC request failed")));
    const deadline = setTimeout(() => {
      req.pause();
      finish(() => reject(new HttpFailure(408, "Guardian IPC request body timed out", true)));
    }, timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}

function prepareTransportClose(req: IncomingMessage, res: ServerResponse): void {
  res.shouldKeepAlive = false;
  res.setHeader("connection", "close");
  res.once("finish", () => req.socket.destroy());
}

function failure(message: string): GuardianIpcResponse {
  return { outcome: "failed", message };
}

function writeJson(res: ServerResponse, statusCode: number, body: GuardianIpcResponse): void {
  if (res.headersSent || res.destroyed) return;
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
