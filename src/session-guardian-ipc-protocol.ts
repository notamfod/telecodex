import type {
  GuardianDaemonStatus,
  GuardianIpcResponse,
  GuardianObservationInspection,
  GuardianScanSummary,
  GuardianThreadInspection,
} from "./session-guardian-ipc-client.js";
import type { GuardianRepairOutcome, GuardianRepairResult } from "./session-guardian-types.js";

const ALERT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const GUARDIAN_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GuardianIpcRoute =
  | { readonly kind: "status" }
  | { readonly kind: "scan" }
  | { readonly kind: "check"; readonly alertId: string }
  | { readonly kind: "repair-alert"; readonly alertId: string }
  | { readonly kind: "inspect"; readonly threadId: string }
  | { readonly kind: "repair-thread"; readonly threadId: string };

export function parseGuardianIpcRoute(rawUrl: string | undefined): GuardianIpcRoute | undefined {
  if (!rawUrl || rawUrl.includes("?") || rawUrl.includes("#") || rawUrl.includes("%")) return undefined;
  if (rawUrl === "/v1/status") return { kind: "status" };
  if (rawUrl === "/v1/scan") return { kind: "scan" };
  const alert = /^\/v1\/alerts\/([A-Za-z0-9_-]{22})\/(check|repair)$/.exec(rawUrl);
  if (alert && ALERT_ID_PATTERN.test(alert[1]!)) {
    return { kind: alert[2] === "check" ? "check" : "repair-alert", alertId: alert[1]! };
  }
  const inspect = /^\/v1\/threads\/([0-9a-f-]+)$/.exec(rawUrl);
  if (inspect && GUARDIAN_THREAD_ID_PATTERN.test(inspect[1]!)) {
    return { kind: "inspect", threadId: inspect[1]! };
  }
  const repair = /^\/v1\/threads\/([0-9a-f-]+)\/repair$/.exec(rawUrl);
  if (repair && GUARDIAN_THREAD_ID_PATTERN.test(repair[1]!)) {
    return { kind: "repair-thread", threadId: repair[1]! };
  }
  return undefined;
}

export function guardianRouteMethod(route: GuardianIpcRoute): "GET" | "POST" {
  return route.kind === "status" || route.kind === "inspect" ? "GET" : "POST";
}

export function guardianRepairResponse(result: GuardianRepairResult): GuardianIpcResponse {
  const messages: Record<GuardianRepairOutcome, string> = {
    restored: "Session restored",
    "self-recovered": "Session recovered without repair",
    "observation-only": "Observation-only check completed",
    "repair-disabled": "Repair is disabled",
    expired: "Alert is no longer available",
    failed: "Session repair failed",
  };
  if (typeof result.outcome !== "string" || !Object.hasOwn(messages, result.outcome)) {
    throw new Error("Invalid guardian repair outcome");
  }
  if (result.threadId !== undefined && !GUARDIAN_THREAD_ID_PATTERN.test(result.threadId)) {
    throw new Error("Invalid guardian thread ID");
  }
  return { outcome: result.outcome, message: messages[result.outcome],
    ...(result.threadId ? { threadId: result.threadId } : {}) };
}

export function guardianStatusResponse(result: GuardianIpcResponse): GuardianIpcResponse {
  const message = result.outcome === "ok" ? "Guardian is ready"
    : result.outcome === "degraded" ? "Guardian is degraded"
      : result.outcome === "failed" ? "Guardian status is unavailable" : undefined;
  if (!message) throw new Error("Invalid guardian status outcome");
  return { outcome: result.outcome, message,
    ...(result.status === undefined ? {} : { status: validateStatus(result.status) }) };
}

export function guardianScanResponse(result: GuardianScanSummary): GuardianIpcResponse {
  return { outcome: "ok", message: "Guardian scan completed", scan: validateScan(result) };
}

export function guardianInspectResponse(result: GuardianThreadInspection): GuardianIpcResponse {
  const thread = validateInspection(result);
  return { outcome: "ok", message: "Guardian thread inspected",
    threadId: thread.threadId, thread };
}

export function validateStatus(value: GuardianDaemonStatus): GuardianDaemonStatus {
  if (typeof value !== "object" || value === null
    || typeof value.running !== "boolean" || typeof value.observationOnly !== "boolean"
    || typeof value.repairEnabled !== "boolean" || typeof value.appServerConnected !== "boolean"
    || typeof value.scanStale !== "boolean"
    || !isNonNegativeInteger(value.scans)
    || (value.lastScanAt !== undefined && !isNonNegativeNumber(value.lastScanAt))
    || !isNonNegativeInteger(value.queueDepth)
    || !["idle", "scan", "check", "repair"].includes(value.activeOperation)
    || !["idle", "reconciliation", "inspection-drain", "app-read", "detector", "delivery"]
      .includes(value.scanPhase)
    || !isNonNegativeInteger(value.inspectionCount)
    || !validOperationState(value)) {
    throw new Error("Invalid guardian daemon status");
  }
  return Object.freeze({ running: value.running, observationOnly: value.observationOnly,
    repairEnabled: value.repairEnabled, appServerConnected: value.appServerConnected,
    scanStale: value.scanStale, scans: value.scans,
    queueDepth: value.queueDepth, activeOperation: value.activeOperation,
    scanPhase: value.scanPhase, inspectionCount: value.inspectionCount,
    ...(value.lastScanAt === undefined ? {} : { lastScanAt: value.lastScanAt }),
    ...(value.activeSince === undefined ? {} : { activeSince: value.activeSince }) });
}

function validOperationState(value: GuardianDaemonStatus): boolean {
  const idle = value.activeOperation === "idle";
  if (value.activeSince !== undefined
    && (idle || !isNonNegativeNumber(value.activeSince))) return false;
  return value.activeOperation === "scan"
    ? value.scanPhase !== "idle"
    : value.scanPhase === "idle";
}

export function validateScan(value: GuardianScanSummary): GuardianScanSummary {
  if (typeof value !== "object" || value === null
    || !isNonNegativeInteger(value.scanned) || !isNonNegativeInteger(value.detectedAlerts)
    || !isNonNegativeInteger(value.deliveredAlerts) || !isNonNegativeInteger(value.failedDeliveries)) {
    throw new Error("Invalid guardian scan result");
  }
  return Object.freeze({ scanned: value.scanned, detectedAlerts: value.detectedAlerts,
    deliveredAlerts: value.deliveredAlerts, failedDeliveries: value.failedDeliveries });
}

export function validateInspection(value: GuardianThreadInspection): GuardianThreadInspection {
  if (typeof value !== "object" || value === null
    || !GUARDIAN_THREAD_ID_PATTERN.test(value.threadId)
    || (value.turnId !== null && !GUARDIAN_THREAD_ID_PATTERN.test(value.turnId))
    || !["active", "idle", "notLoaded", "systemError"].includes(value.threadStatus)
    || (value.turnStatus !== null && typeof value.turnStatus !== "string")
    || !isNonNegativeNumber(value.updatedAt) || !isNonNegativeInteger(value.itemCount)
    || (value.lastItemType !== null && typeof value.lastItemType !== "string")
    || !["cli", "telecodex", "app-server", "remote", "subagent", "unknown"].includes(value.source)
    || typeof value.canAcceptDirectInput !== "boolean" || typeof value.root !== "boolean") {
    throw new Error("Invalid guardian thread inspection");
  }
  const observation = value.observation === undefined
    ? undefined
    : validateObservation(value.observation);
  return Object.freeze({
    threadId: value.threadId,
    turnId: value.turnId,
    threadStatus: value.threadStatus,
    turnStatus: value.turnStatus,
    updatedAt: value.updatedAt,
    itemCount: value.itemCount,
    lastItemType: value.lastItemType,
    source: value.source,
    canAcceptDirectInput: value.canAcceptDirectInput,
    root: value.root,
    ...(observation === undefined ? {} : { observation }),
  });
}

function validateObservation(value: GuardianObservationInspection): GuardianObservationInspection {
  if (typeof value !== "object" || value === null
    || !hasExactKeys(value, ["guardianHealth", "lastObservedAt", "unchangedSince", "staleForMs",
      "alertId", "repairState", "repairOutcome"])
    || !["healthy", "checking", "stalled"].includes(value.guardianHealth)
    || !isNonNegativeNumber(value.lastObservedAt)
    || !isNonNegativeNumber(value.unchangedSince)
    || !isNonNegativeNumber(value.staleForMs)
    || (value.alertId !== null
      && (typeof value.alertId !== "string" || !ALERT_ID_PATTERN.test(value.alertId)))
    || !["none", "eligible", "in_progress", "terminal"].includes(value.repairState)
    || value.unchangedSince > value.lastObservedAt
    || (value.repairOutcome !== null
      && !["restored", "self-recovered", "observation-only", "repair-disabled", "expired", "failed"]
        .includes(value.repairOutcome))
    || !isCoherentRepair(value.alertId, value.repairState, value.repairOutcome)
    || !isCoherentHealth(value.guardianHealth, value.repairState)) {
    throw new Error("Invalid guardian observation inspection");
  }
  return Object.freeze({
    guardianHealth: value.guardianHealth,
    lastObservedAt: value.lastObservedAt,
    unchangedSince: value.unchangedSince,
    staleForMs: value.staleForMs,
    alertId: value.alertId,
    repairState: value.repairState,
    repairOutcome: value.repairOutcome,
  });
}

function isCoherentHealth(
  health: GuardianObservationInspection["guardianHealth"],
  state: GuardianObservationInspection["repairState"],
): boolean {
  if (state === "none") return health === "healthy";
  if (state === "in_progress") return health === "checking";
  return health === "stalled";
}

function isCoherentRepair(
  alertId: string | null,
  state: GuardianObservationInspection["repairState"],
  outcome: GuardianRepairOutcome | null,
): boolean {
  if (state === "none") return alertId === null && outcome === null;
  if (state === "eligible" || state === "in_progress") {
    return alertId !== null && outcome === null;
  }
  return alertId !== null && outcome !== null;
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
