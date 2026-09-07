import { request, type ClientRequest, type IncomingMessage } from "node:http";
import path from "node:path";

import type { GuardianRepairOutcome } from "./session-guardian-types.js";

const ALERT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const GUARDIAN_SOCKET_PATH_MAX_BYTES = 107;

export type GuardianIpcOutcome = "ok" | "degraded" | "no-longer-eligible" | GuardianRepairOutcome;

export interface GuardianIpcResponse {
  readonly outcome: GuardianIpcOutcome;
  readonly message: string;
  readonly threadId?: string;
  readonly status?: GuardianDaemonStatus;
  readonly scan?: GuardianScanSummary;
  readonly thread?: GuardianThreadInspection;
}

export interface GuardianDaemonStatus {
  readonly running: boolean;
  readonly observationOnly: boolean;
  readonly repairEnabled: boolean;
  readonly appServerConnected: boolean;
  readonly scanStale: boolean;
  readonly scans: number;
  readonly lastScanAt?: number;
  readonly queueDepth: number;
  readonly activeOperation: "idle" | "scan" | "check" | "repair";
  readonly scanPhase: "idle" | "reconciliation" | "inspection-drain" | "app-read"
    | "detector" | "delivery";
  readonly inspectionCount: number;
  readonly activeSince?: number;
}

export interface GuardianScanSummary {
  readonly scanned: number;
  readonly detectedAlerts: number;
  readonly deliveredAlerts: number;
  readonly failedDeliveries: number;
}

export type GuardianSourceCategory = "cli" | "telecodex" | "app-server" | "remote" | "subagent" | "unknown";

export interface GuardianObservationInspection {
  readonly guardianHealth: "healthy" | "checking" | "stalled";
  readonly lastObservedAt: number;
  readonly unchangedSince: number;
  readonly staleForMs: number;
  readonly alertId: string | null;
  readonly repairState: "none" | "eligible" | "in_progress" | "terminal";
  readonly repairOutcome: GuardianRepairOutcome | null;
}

export interface GuardianThreadInspection {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly threadStatus: "active" | "idle" | "notLoaded" | "systemError";
  readonly turnStatus: string | null;
  readonly updatedAt: number;
  readonly itemCount: number;
  readonly lastItemType: string | null;
  readonly source: GuardianSourceCategory;
  readonly canAcceptDirectInput: boolean;
  readonly root: boolean;
  readonly observation?: GuardianObservationInspection;
}

export interface GuardianIpcClientOptions {
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class GuardianIpcTimeoutError extends Error {
  constructor() {
    super("Guardian IPC request timed out");
    this.name = "GuardianIpcTimeoutError";
  }
}

export class SessionGuardianIpcClient {
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(readonly socketPath: string, options: GuardianIpcClientOptions = {}) {
    assertGuardianSocketPath(socketPath);
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
  }

  status(): Promise<GuardianIpcResponse> {
    return this.send("GET", "/v1/status");
  }

  checkAlert(alertId: string): Promise<GuardianIpcResponse> {
    assertGuardianAlertId(alertId);
    return this.send("POST", `/v1/alerts/${alertId}/check`);
  }

  repairAlert(alertId: string): Promise<GuardianIpcResponse> {
    assertGuardianAlertId(alertId);
    return this.send("POST", `/v1/alerts/${alertId}/repair`);
  }

  async scan(): Promise<GuardianIpcResponse> {
    const response = await this.send("POST", "/v1/scan");
    if (response.outcome !== "ok" || response.scan === undefined) throw invalidResponse();
    return response;
  }

  async inspectThread(threadId: string): Promise<GuardianIpcResponse> {
    assertGuardianThreadId(threadId);
    const response = await this.send("GET", `/v1/threads/${threadId}`);
    if (response.outcome !== "ok" || response.thread === undefined
      || response.thread.threadId !== threadId || response.threadId !== threadId) {
      throw invalidResponse();
    }
    return response;
  }

  async repairThread(threadId: string): Promise<GuardianIpcResponse> {
    assertGuardianThreadId(threadId);
    const response = await this.send("POST", `/v1/threads/${threadId}/repair`);
    if (["ok", "degraded", "no-longer-eligible"].includes(response.outcome)) {
      throw invalidResponse();
    }
    if (response.threadId !== threadId) throw invalidResponse();
    return response;
  }

  private send(method: "GET" | "POST", requestPath: string): Promise<GuardianIpcResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      let response: IncomingMessage | undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        action();
      };
      let req: ClientRequest;
      req = request({
        socketPath: this.socketPath,
        method,
        path: requestPath,
        headers: method === "POST" ? { "content-length": "0" } : undefined,
      }, (res) => {
        response = res;
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer | string) => {
          total += Buffer.byteLength(chunk);
          if (total > this.maxResponseBytes) {
            finish(() => reject(new Error("Guardian IPC response is too large")));
            res.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          if (settled) return;
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            finish(() => reject(new Error(
              `Guardian IPC request failed with status ${res.statusCode ?? 0}`,
            )));
            return;
          }
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const validated = assertIpcResponse(parsed);
            finish(() => resolve(validated));
          } catch {
            finish(() => reject(new Error("Guardian IPC returned an invalid response")));
          }
        });
        res.on("error", () => {
          finish(() => reject(new Error("Guardian IPC response failed")));
        });
      });
      deadline = setTimeout(() => {
        finish(() => reject(new GuardianIpcTimeoutError()));
        response?.destroy();
        req.destroy();
      }, this.requestTimeoutMs);
      req.on("error", () => {
        finish(() => reject(new Error("Guardian IPC unavailable")));
      });
      req.end();
    });
  }
}

export function assertGuardianSocketPath(value: string): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || !path.isAbsolute(value)
    || value === path.parse(value).root
    || Buffer.byteLength(value) > GUARDIAN_SOCKET_PATH_MAX_BYTES
  ) throw new Error("Guardian IPC socket path must be absolute");
}

export function assertGuardianAlertId(value: string): void {
  if (!ALERT_ID_PATTERN.test(value)) throw new Error("alertId must be a guardian alert ID");
}

export function assertGuardianThreadId(value: string): void {
  if (!THREAD_ID_PATTERN.test(value)) throw new Error("threadId must be a UUID");
}

function assertIpcResponse(value: unknown): GuardianIpcResponse {
  if (!isRecord(value) || !isIpcOutcome(value.outcome)) throw new Error("Invalid guardian IPC outcome");
  if (typeof value.message !== "string" || value.message.length < 1 || value.message.length > 512) {
    throw new Error("Invalid guardian IPC message");
  }
  if (/[\u0000-\u001f\u007f]/.test(value.message)) throw new Error("Invalid guardian IPC message");
  if (value.threadId !== undefined && (
    typeof value.threadId !== "string" || !THREAD_ID_PATTERN.test(value.threadId)
  )) throw new Error("Invalid guardian IPC thread ID");
  const status = value.status === undefined ? undefined : assertStatus(value.status);
  const scan = value.scan === undefined ? undefined : assertScan(value.scan);
  const thread = value.thread === undefined ? undefined : assertThread(value.thread);
  return {
    outcome: value.outcome,
    message: value.message,
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
    ...(status === undefined ? {} : { status }),
    ...(scan === undefined ? {} : { scan }),
    ...(thread === undefined ? {} : { thread }),
  };
}

function assertStatus(value: unknown): GuardianDaemonStatus {
  if (!isRecord(value) || typeof value.running !== "boolean"
    || typeof value.observationOnly !== "boolean" || typeof value.repairEnabled !== "boolean"
    || typeof value.appServerConnected !== "boolean" || typeof value.scanStale !== "boolean"
    || !isNonNegativeInteger(value.scans)
    || (value.lastScanAt !== undefined && !isNonNegativeNumber(value.lastScanAt))
    || !isNonNegativeInteger(value.queueDepth)
    || !["idle", "scan", "check", "repair"].includes(value.activeOperation as string)
    || !["idle", "reconciliation", "inspection-drain", "app-read", "detector", "delivery"]
      .includes(value.scanPhase as string)
    || !isNonNegativeInteger(value.inspectionCount)
    || !validOperationState(value)) {
    throw new Error("Invalid guardian IPC status");
  }
  return { running: value.running, observationOnly: value.observationOnly,
    repairEnabled: value.repairEnabled, appServerConnected: value.appServerConnected,
    scanStale: value.scanStale, scans: value.scans,
    queueDepth: value.queueDepth,
    activeOperation: value.activeOperation as GuardianDaemonStatus["activeOperation"],
    scanPhase: value.scanPhase as GuardianDaemonStatus["scanPhase"],
    inspectionCount: value.inspectionCount,
    ...(value.lastScanAt === undefined ? {} : { lastScanAt: value.lastScanAt }),
    ...(value.activeSince === undefined ? {} : { activeSince: value.activeSince as number }) };
}

function validOperationState(value: Record<string, unknown>): boolean {
  const idle = value.activeOperation === "idle";
  if (value.activeSince !== undefined
    && (idle || !isNonNegativeNumber(value.activeSince))) return false;
  return value.activeOperation === "scan"
    ? value.scanPhase !== "idle"
    : value.scanPhase === "idle";
}

function assertScan(value: unknown): GuardianScanSummary {
  if (!isRecord(value) || !isNonNegativeInteger(value.scanned)
    || !isNonNegativeInteger(value.detectedAlerts) || !isNonNegativeInteger(value.deliveredAlerts)
    || !isNonNegativeInteger(value.failedDeliveries)) throw new Error("Invalid guardian IPC scan");
  return { scanned: value.scanned, detectedAlerts: value.detectedAlerts,
    deliveredAlerts: value.deliveredAlerts, failedDeliveries: value.failedDeliveries };
}

function assertThread(value: unknown): GuardianThreadInspection {
  if (!isRecord(value) || typeof value.threadId !== "string" || !THREAD_ID_PATTERN.test(value.threadId)
    || (value.turnId !== null && (typeof value.turnId !== "string" || !THREAD_ID_PATTERN.test(value.turnId)))
    || !["active", "idle", "notLoaded", "systemError"].includes(String(value.threadStatus))
    || (value.turnStatus !== null && typeof value.turnStatus !== "string")
    || !isNonNegativeNumber(value.updatedAt) || !isNonNegativeInteger(value.itemCount)
    || (value.lastItemType !== null && typeof value.lastItemType !== "string")
    || !["cli", "telecodex", "app-server", "remote", "subagent", "unknown"].includes(String(value.source))
    || typeof value.canAcceptDirectInput !== "boolean" || typeof value.root !== "boolean") {
    throw new Error("Invalid guardian IPC thread");
  }
  const observation = value.observation === undefined
    ? undefined
    : assertObservation(value.observation);
  return {
    threadId: value.threadId,
    turnId: value.turnId as string | null,
    threadStatus: value.threadStatus as GuardianThreadInspection["threadStatus"],
    turnStatus: value.turnStatus as string | null,
    updatedAt: value.updatedAt,
    itemCount: value.itemCount,
    lastItemType: value.lastItemType as string | null,
    source: value.source as GuardianSourceCategory,
    canAcceptDirectInput: value.canAcceptDirectInput,
    root: value.root,
    ...(observation === undefined ? {} : { observation }),
  };
}

function assertObservation(value: unknown): GuardianObservationInspection {
  if (!isRecord(value)
    || !hasExactKeys(value, ["guardianHealth", "lastObservedAt", "unchangedSince", "staleForMs",
      "alertId", "repairState", "repairOutcome"])
    || !["healthy", "checking", "stalled"].includes(String(value.guardianHealth))
    || !isNonNegativeNumber(value.lastObservedAt)
    || !isNonNegativeNumber(value.unchangedSince)
    || !isNonNegativeNumber(value.staleForMs)
    || (value.alertId !== null
      && (typeof value.alertId !== "string" || !ALERT_ID_PATTERN.test(value.alertId)))
    || !["none", "eligible", "in_progress", "terminal"].includes(String(value.repairState))
    || (value.unchangedSince as number) > (value.lastObservedAt as number)
    || (value.repairOutcome !== null
      && !["restored", "self-recovered", "observation-only", "repair-disabled", "expired", "failed"]
        .includes(String(value.repairOutcome)))
    || !isCoherentRepair(value.alertId, value.repairState, value.repairOutcome)
    || !isCoherentHealth(value.guardianHealth, value.repairState)) {
    throw new Error("Invalid guardian IPC observation");
  }
  return {
    guardianHealth: value.guardianHealth as GuardianObservationInspection["guardianHealth"],
    lastObservedAt: value.lastObservedAt,
    unchangedSince: value.unchangedSince,
    staleForMs: value.staleForMs,
    alertId: value.alertId as string | null,
    repairState: value.repairState as GuardianObservationInspection["repairState"],
    repairOutcome: value.repairOutcome as GuardianRepairOutcome | null,
  };
}

function isCoherentHealth(health: unknown, state: unknown): boolean {
  if (state === "none") return health === "healthy";
  if (state === "in_progress") return health === "checking";
  return (state === "eligible" || state === "terminal") && health === "stalled";
}

function isCoherentRepair(alertId: unknown, state: unknown, outcome: unknown): boolean {
  if (state === "none") return alertId === null && outcome === null;
  if (state === "eligible" || state === "in_progress") {
    return typeof alertId === "string" && outcome === null;
  }
  return state === "terminal" && typeof alertId === "string" && outcome !== null;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIpcOutcome(value: unknown): value is GuardianIpcOutcome {
  return typeof value === "string" && [
    "ok", "degraded", "restored", "self-recovered", "observation-only",
    "repair-disabled", "expired", "no-longer-eligible", "failed",
  ].includes(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): Error {
  return new Error("Guardian IPC returned an invalid response");
}
