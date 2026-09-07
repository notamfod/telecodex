import { normalizeTelegramTurnResult, type TelegramTurnResult } from "./telegram-turn-result.js";
import {
  TELEGRAM_RESPONSE_PLAN_MAX_PARTS,
  type TelegramDeliveryPart,
  type TelegramResponsePlanPart,
} from "./telegram-job-types.js";
import type {
  JobPhase,
  TelegramDispatchRecord,
  TelegramJobEvent,
  TelegramReconciliationDecision,
  TelegramReconciliationIntent,
  TelegramTransportWriteState,
  UtcMilliseconds,
} from "./telegram-job-types.js";

const WRITE_STATES = ["prepared", "in_flight", "written"] as const;
const RECONCILIATION_KINDS = [
  "restore_accepted", "enqueue", "requeue_not_sent", "hold_dispatch_unknown",
  "recover_exact_turn", "inspect_guardian", "await_guardian", "resume_delivery",
  "refresh_terminal", "terminate_recovery_interrupted", "require_attention",
] as const;
type EventType = TelegramJobEvent["type"];

export interface TelegramRuntimeEventFields {
  readonly dispatch?: TelegramDispatchRecord;
  readonly nextAttemptAt?: UtcMilliseconds;
  readonly abortRequestedAt?: UtcMilliseconds;
  readonly codexEventAt?: UtcMilliseconds;
  readonly turnResult?: TelegramTurnResult;
  readonly reconciliationDecision?: TelegramReconciliationDecision;
  readonly reconciliationDecisionId?: string;
}

export function parseTelegramDispatchRecord(value: unknown): TelegramDispatchRecord {
  const raw = record(value);
  onlyKeys(raw, [
    "id", "threadId", "previousTurnId", "attempt", "startedAt",
    "transportWriteState", "nextAttemptAt",
  ]);
  return {
    id: boundedString(raw.id),
    threadId: boundedString(raw.threadId),
    previousTurnId: raw.previousTurnId === null ? null : boundedString(raw.previousTurnId),
    attempt: positiveInteger(raw.attempt),
    startedAt: timestamp(raw.startedAt),
    transportWriteState: enumeration(raw.transportWriteState, WRITE_STATES),
    nextAttemptAt: raw.nextAttemptAt === null ? null : timestamp(raw.nextAttemptAt),
  };
}

export function cloneTelegramDispatchRecord(value: TelegramDispatchRecord): TelegramDispatchRecord {
  return { ...parseTelegramDispatchRecord(value) };
}

export function parseOptionalTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

export function parseTelegramTurnResult(value: unknown): TelegramTurnResult {
  return normalizeTelegramTurnResult(value);
}

export function cloneTelegramTurnResult(value: TelegramTurnResult): TelegramTurnResult {
  return normalizeTelegramTurnResult(value);
}

export function parseTelegramRuntimeEvent(
  raw: Record<string, unknown>,
  type: EventType,
): TelegramRuntimeEventFields {
  if (type === "dispatch.started") return { dispatch: parseTelegramDispatchRecord(required(raw, "dispatch")) };
  if (type === "job.deferred") return { nextAttemptAt: timestamp(required(raw, "nextAttemptAt")) };
  if (type === "abort.requested") return { abortRequestedAt: timestamp(required(raw, "abortRequestedAt")) };
  if (type === "turn.completed") {
    return {
      turnResult: parseTelegramTurnResult(required(raw, "turnResult")),
      ...(raw.codexEventAt === undefined ? {} : { codexEventAt: timestamp(raw.codexEventAt) }),
    };
  }
  if (type === "reconciliation.decided") {
    return { reconciliationDecision: parseTelegramReconciliationDecision(required(raw, "decision")) };
  }
  if (type === "reconciliation.applied") {
    return { reconciliationDecisionId: bounded(required(raw, "decisionId"), 128) };
  }
  if ((type === "activity.observed" || type === "turn.started") && raw.codexEventAt !== undefined) {
    return { codexEventAt: timestamp(raw.codexEventAt) };
  }
  return {};
}

export function applyTelegramDispatchEvent(
  current: TelegramDispatchRecord | undefined,
  event: TelegramRuntimeEventFields & { readonly type: EventType },
): TelegramDispatchRecord | undefined {
  if (event.type === "dispatch.started") return event.dispatch!;
  if (event.type === "dispatch.in_flight" || event.type === "dispatch.written") {
    if (!current) {
      if (event.type === "dispatch.written") return undefined;
      throw new Error("Invalid dispatch lifecycle");
    }
    return {
      ...current,
      transportWriteState: nextWriteState(
        current.transportWriteState,
        event.type === "dispatch.in_flight" ? "in_flight" : "written",
      ),
    };
  }
  if (event.type === "job.deferred" && current) return { ...current, nextAttemptAt: event.nextAttemptAt! };
  return current;
}

export function parseTelegramReconciliationIntent(value: unknown): TelegramReconciliationIntent {
  const raw = record(value);
  onlyKeys(raw, ["decision", "state", "decidedAt", "appliedAt"]);
  const state = enumeration(raw.state, ["pending", "applied"] as const);
  const decidedAt = timestamp(raw.decidedAt);
  const appliedAt = raw.appliedAt === null ? null : timestamp(raw.appliedAt);
  if ((state === "pending") !== (appliedAt === null) || (appliedAt !== null && appliedAt < decidedAt)) throw new Error();
  return { decision: parseTelegramReconciliationDecision(raw.decision), state, decidedAt, appliedAt };
}

export function applyTelegramReconciliationEvent(
  current: TelegramReconciliationIntent | undefined,
  event: TelegramRuntimeEventFields & { readonly type: EventType; readonly eventAt: number },
  identifiers: { readonly threadId: string | null; readonly turnId: string | null },
): TelegramReconciliationIntent | undefined {
  if (event.type === "reconciliation.decided") {
    if (current?.state === "pending") throw new Error("Pending reconciliation cannot be replaced");
    const decision = event.reconciliationDecision!;
    assertDecisionIdentity(decision, identifiers);
    return { decision, state: "pending", decidedAt: event.eventAt, appliedAt: null };
  }
  if (event.type !== "reconciliation.applied") return current;
  if (!current || current.state !== "pending" || current.decision.id !== event.reconciliationDecisionId) {
    throw new Error("Reconciliation decision does not match");
  }
  return { ...current, state: "applied", appliedAt: event.eventAt };
}

export function assertTelegramReconciliationIntentForJob(
  intent: TelegramReconciliationIntent | undefined,
  identifiers: { readonly threadId: string | null; readonly turnId: string | null },
  updatedAt: number,
): void {
  if (!intent) return;
  assertDecisionIdentity(intent.decision, identifiers);
  if (intent.decidedAt > updatedAt || (intent.appliedAt !== null && intent.appliedAt > updatedAt)) throw new Error();
}

function assertDecisionIdentity(
  decision: TelegramReconciliationDecision,
  identifiers: { readonly threadId: string | null; readonly turnId: string | null },
): void {
  if (decision.turnId !== null && decision.threadId === null) throw new Error("Turn reconciliation requires a thread");
  if ((decision.threadId !== null && decision.threadId !== identifiers.threadId)
    || (decision.turnId !== null && decision.turnId !== identifiers.turnId)) throw new Error("Reconciliation identity changed");
  if (decision.kind === "recover_exact_turn" && (decision.threadId === null || decision.turnId === null)) {
    throw new Error("Exact turn recovery requires identities");
  }
}

function parseTelegramReconciliationDecision(value: unknown): TelegramReconciliationDecision {
  const raw = record(value);
  onlyKeys(raw, ["id", "kind", "threadId", "turnId", "reasonCode"]);
  return {
    id: bounded(raw.id, 128),
    kind: enumeration(raw.kind, RECONCILIATION_KINDS),
    threadId: raw.threadId === null ? null : bounded(raw.threadId, 512),
    turnId: raw.turnId === null ? null : bounded(raw.turnId, 512),
    reasonCode: raw.reasonCode === null ? null : reasonCode(raw.reasonCode),
  };
}

export function parseTelegramEventPhase(value: unknown, type: EventType): JobPhase | undefined {
  if (value === undefined) return undefined;
  const allowed = type === "delivery.replanned" ? ["delivering"]
    : type === "delivery.changed" ? ["running", "delivering", "terminal"]
    : type === "activity.observed" || type === "guardian.observed" || type === "abort.requested"
      || type.startsWith("reconciliation.") ? []
      : type === "materialization.succeeded" || type === "materialization.failed" ? ["accepted"]
        : [type === "update.accepted" ? "accepted" : type === "job.queued" || type === "job.deferred" ? "queued"
          : type.startsWith("dispatch.") ? "dispatching" : type === "turn.started" ? "running"
            : type === "turn.completed" ? "delivering" : "terminal"];
  if (!allowed.includes(value as never)) throw new Error("Invalid event phase");
  return value as JobPhase;
}

export function resolveTelegramEventPhase(
  previous: JobPhase,
  type: EventType,
  explicit: JobPhase | undefined,
): JobPhase {
  if (type === "update.accepted" || type === "materialization.succeeded" || type === "materialization.failed") return "accepted";
  if (type === "job.queued" || type === "job.deferred") return "queued";
  if (type.startsWith("dispatch.")) return "dispatching";
  if (type === "turn.started") return "running";
  if (type === "turn.completed") return "delivering";
  if (type === "job.terminal") return "terminal";
  if (type === "delivery.replanned") {
    if (previous !== "delivering") throw new Error("Invalid event phase");
    return "delivering";
  }
  if (type === "delivery.changed") {
    if (explicit === "terminal" && previous !== "terminal") throw new Error("Invalid event phase");
    if (explicit === "running" && previous !== "running") throw new Error("Invalid event phase");
    return explicit ?? (previous === "terminal" ? "terminal" : "delivering");
  }
  return previous;
}

export function isTelegramDeliveryProjectionValid(
  plan: readonly TelegramResponsePlanPart[],
  deliveries: readonly TelegramDeliveryPart[],
): boolean {
  const planIds = plan.map((part) => part.partId);
  const deliveryIds = deliveries.map((part) => part.partId);
  return plan.length <= TELEGRAM_RESPONSE_PLAN_MAX_PARTS && deliveries.length === plan.length
    && planIds.every((partId, index) => partId.length > 0 && deliveryIds[index] === partId)
    && new Set(planIds).size === planIds.length && new Set(deliveryIds).size === deliveryIds.length;
}

export function validateTelegramEventKeys(raw: Record<string, unknown>, type: EventType): void {
  if (type === "delivery.replanned") {
    onlyKeys(raw, [
      "schemaVersion", "type", "eventAt", "expectedVersion", "phase",
      "reasonCode", "responsePlan", "deliveries",
    ]);
    return;
  }
  if (type === "reconciliation.decided" || type === "reconciliation.applied") {
    onlyKeys(raw, ["schemaVersion", "type", "eventAt", "expectedVersion",
      type === "reconciliation.decided" ? "decision" : "decisionId"]);
    return;
  }
  const common = ["schemaVersion", "type", "eventAt", "expectedVersion", "phase", "health", "activity", "attention", "identifiers", "dismissedAt", "retainUntil"];
  const specific = type === "job.terminal" ? ["outcome", "responsePlan", "deliveries"]
    : type === "delivery.changed" ? ["responsePlan", "deliveries"]
      : type === "materialization.succeeded" ? ["materializedPrompt"]
        : type === "materialization.failed" ? ["failureCode"]
          : type === "dispatch.started" ? ["dispatch"]
            : type === "job.deferred" ? ["nextAttemptAt"]
              : type === "abort.requested" ? ["abortRequestedAt"]
                : type === "turn.completed" ? ["turnResult", "codexEventAt"]
                  : type === "activity.observed" || type === "turn.started" ? ["codexEventAt"] : [];
  onlyKeys(raw, [...common, ...specific]);
}

export function nextWriteState(
  current: TelegramTransportWriteState,
  next: TelegramTransportWriteState,
): TelegramTransportWriteState {
  const order: readonly TelegramTransportWriteState[] = WRITE_STATES;
  if (order.indexOf(next) < order.indexOf(current)) throw new Error("Invalid transport write state");
  return next;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) throw new Error();
  return value;
}

function bounded(value: unknown, maximum: number): string {
  const result = boundedString(value);
  if (result.length > maximum) throw new Error();
  return result;
}

function reasonCode(value: unknown): string {
  const result = bounded(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new Error();
  return result;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error();
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error();
  return value as T;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error();
}

function required(value: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error();
  return value[key];
}
