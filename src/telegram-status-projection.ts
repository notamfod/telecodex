import type { GuardianThreadInspection } from "./session-guardian-ipc-client.js";
import type { DeliveryPart } from "./telegram-job-store.js";
import type { TelegramTopicRecoveryCandidate } from "./telegram-topic-recovery.js";
import {
  TELEGRAM_STATUS_ANCHOR_PART_KEY,
  type DeliveryState,
  type JobActivity,
  type JobAttention,
  type JobHealth,
  type JobOutcome,
  type JobPhase,
  type TelegramJob,
  type TelegramJobEvent,
} from "./telegram-job-types.js";

export type TelegramStatusActionKind =
  | "abort"
  | "refresh"
  | "details"
  | "inspect"
  | "retry_new_turn"
  | "guardian_restore"
  | "retry_delivery"
  | "recover_missing_topic"
  | "send_again_warning";

export type TelegramTopicRecoveryActionState = "in_flight" | "retry_wait" | "unknown";

export type TelegramJobStatusState =
  | "accepted"
  | "queued"
  | "dispatching_not_sent"
  | "dispatching_unknown"
  | "running"
  | "stalled"
  | "delivering"
  | "delivery_failed"
  | "delivery_uncertain"
  | "terminal_incomplete"
  | "terminal_delivered"
  | "terminal_failed"
  | "terminal_aborted"
  | "terminal_recovery_interrupted";

export type TelegramStatusGuardianEvidence =
  | { readonly availability: "available"; readonly inspection: GuardianThreadInspection | null }
  | { readonly availability: "unavailable"; readonly reasonCode: string };

export interface TelegramJobStatusProjectionInput {
  readonly job: TelegramJob;
  readonly latestEvent: { readonly eventAt: number } | null;
  readonly deliveries: readonly DeliveryPart[];
  readonly guardian: TelegramStatusGuardianEvidence;
  readonly queue: { readonly position: number } | null;
  readonly now: number;
}

export interface TelegramStatusAction {
  readonly kind: TelegramStatusActionKind;
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly alertId?: string;
  readonly partKey?: string;
}

export interface TelegramGuardianStatusProjection {
  readonly availability: "available" | "unavailable";
  readonly health: JobHealth | null;
  readonly reasonCode: string | null;
  readonly threadStatus: GuardianThreadInspection["threadStatus"] | null;
  readonly lastObservedAt: number | null;
  readonly ageMs: number | null;
  readonly unchangedSince: number | null;
  readonly staleForMs: number | null;
  readonly alertId: string | null;
  readonly repairState: NonNullable<GuardianThreadInspection["observation"]>["repairState"] | null;
  readonly repairOutcome: NonNullable<GuardianThreadInspection["observation"]>["repairOutcome"];
}

export interface TelegramDeliveryStatusProjection {
  readonly total: number;
  readonly delivered: number;
  readonly pending: number;
  readonly sending: number;
  readonly uncertain: number;
  readonly failed: number;
  readonly anchorState: DeliveryState | "missing";
  readonly anchorMessageId: number | null;
  readonly complete: boolean;
}

export interface TelegramJobStatusProjection {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly shortJobId: string;
  readonly expectedVersion: number;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly phase: JobPhase;
  readonly outcome: JobOutcome;
  readonly state: TelegramJobStatusState;
  readonly isDone: boolean;
  readonly anchorKnownDelivered: boolean;
  readonly health: JobHealth;
  readonly activity: { readonly kind: JobActivity; readonly eventAt: number; readonly ageMs: number } | null;
  readonly queue: { readonly position: number; readonly ageMs: number } | null;
  readonly dispatch: {
    readonly state: "not_sent" | "written_unknown" | "turn_identified";
    readonly previousTurnId: string | null;
    readonly attempt: number | null;
    readonly startedAt: number | null;
    readonly ageMs: number | null;
  } | null;
  readonly guardian: TelegramGuardianStatusProjection;
  readonly delivery: TelegramDeliveryStatusProjection;
  readonly timestamps: {
    readonly acceptedAt: number;
    readonly updatedAt: number;
    readonly terminalAt: number | null;
    readonly lastEventAt: number | null;
    readonly lastCodexEventAt: number | null;
    readonly guardianLastObservedAt: number | null;
    readonly dispatchStartedAt: number | null;
    readonly nextAttemptAt: number | null;
    readonly abortRequestedAt: number | null;
    readonly latestDeliveryAt: number | null;
  };
  readonly attention: JobAttention;
  readonly reasonCodes: readonly string[];
  readonly actions: readonly TelegramStatusAction[];
}

export function enrichTopicRecoveryAction(
  projection: TelegramJobStatusProjection,
  candidate: TelegramTopicRecoveryCandidate | null,
  recoveryState?: TelegramTopicRecoveryActionState,
): TelegramJobStatusProjection {
  const actions = recoveryState === undefined
    ? projection.actions
    : projection.actions.filter((action) => !(
        action.kind === "retry_delivery" && action.partKey === TELEGRAM_STATUS_ANCHOR_PART_KEY
      ));
  if (candidate === null || recoveryState !== undefined) {
    return actions === projection.actions ? projection : { ...projection, actions };
  }
  if (candidate.jobId !== projection.jobId
    || candidate.expectedVersion !== projection.expectedVersion) {
    throw new Error("Topic recovery candidate does not match status projection");
  }
  return {
    ...projection,
    actions: [{
      kind: "recover_missing_topic",
      jobId: projection.jobId,
      expectedVersion: projection.expectedVersion,
    }, ...actions],
  };
}

export function projectTelegramJobStatus(input: TelegramJobStatusProjectionInput): TelegramJobStatusProjection {
  const now = timestamp(input.now, "now");
  assertJobIdentity(input.job);
  const latestEventAt = input.latestEvent === null ? null : timestamp(input.latestEvent.eventAt, "latest event time");
  const rows = input.deliveries.map((row) => {
    if (row.jobId !== input.job.id) throw new Error("Status delivery job mismatch");
    return row;
  });
  const guardian = projectGuardian(input.job, input.guardian, now);
  const delivery = projectDelivery(input.job, rows);
  const anchorKnownDelivered = delivery.anchorState === "delivered" && delivery.anchorMessageId !== null;
  const isDone = input.job.phase === "terminal" && input.job.outcome === "completed" && delivery.complete;
  const dispatch = projectDispatch(input.job, now);
  const state = statusState(input.job, delivery, guardian, dispatch, isDone);
  const lastCodexEventAt = nullableTimestamp(input.job.lastCodexEventAt, "last Codex event time");
  const activity = lastCodexEventAt === null ? null : {
    kind: input.job.activity,
    eventAt: lastCodexEventAt,
    ageMs: age(now, lastCodexEventAt),
  };
  const queue = input.job.phase === "queued" && input.queue !== null
    ? { position: positiveInteger(input.queue.position, "queue position"), ageMs: age(now, input.job.acceptedAt) }
    : null;
  const health = guardian.availability === "unavailable" ? "unavailable"
    : guardian.health === "stalled" || guardian.health === "checking" ? guardian.health
      : guardian.health === "healthy" ? input.job.health === "quiet" ? "quiet" : "healthy" : input.job.health;
  const reasonCodes = reasons(input.job, input.guardian, rows);
  const latestDeliveryAt = rows.length === 0 ? null : Math.max(...rows.map((row) => timestamp(row.updatedAt, "delivery time")));
  return {
    schemaVersion: 1,
    jobId: input.job.id,
    shortJobId: input.job.id.slice(0, 8),
    expectedVersion: input.job.version,
    threadId: input.job.threadId,
    turnId: input.job.turnId,
    phase: input.job.phase,
    outcome: input.job.outcome,
    state,
    isDone,
    anchorKnownDelivered,
    health,
    activity,
    queue,
    dispatch,
    guardian,
    delivery,
    timestamps: {
      acceptedAt: input.job.acceptedAt,
      updatedAt: input.job.updatedAt,
      terminalAt: input.job.terminalAt,
      lastEventAt: latestEventAt,
      lastCodexEventAt,
      guardianLastObservedAt: guardian.lastObservedAt,
      dispatchStartedAt: dispatch?.startedAt ?? null,
      nextAttemptAt: nullableTimestamp(input.job.nextAttemptAt ?? input.job.dispatch?.nextAttemptAt, "next attempt time"),
      abortRequestedAt: nullableTimestamp(input.job.abortRequestedAt, "abort requested time"),
      latestDeliveryAt,
    },
    attention: structuredClone(input.job.attention),
    reasonCodes,
    actions: actionsFor(state, input.job, guardian, rows),
  };
}

function projectGuardian(
  job: TelegramJob,
  evidence: TelegramStatusGuardianEvidence,
  now: number,
): TelegramGuardianStatusProjection {
  if (evidence.availability === "unavailable") return {
    availability: "unavailable", health: "unavailable", reasonCode: reasonCode(evidence.reasonCode),
    threadStatus: null, lastObservedAt: null, ageMs: null, unchangedSince: null, staleForMs: null,
    alertId: null, repairState: null, repairOutcome: null,
  };
  const inspection = evidence.inspection;
  if (inspection !== null && inspection.threadId !== job.threadId) throw new Error("Status Guardian thread mismatch");
  const observation = inspection?.observation;
  const lastObservedAt = observation ? timestamp(observation.lastObservedAt, "Guardian observation time") : null;
  return {
    availability: "available",
    health: observation?.guardianHealth ?? null,
    reasonCode: observation?.guardianHealth === "stalled" ? "GUARDIAN_STALLED" : null,
    threadStatus: inspection?.threadStatus ?? null,
    lastObservedAt,
    ageMs: lastObservedAt === null ? null : age(now, lastObservedAt),
    unchangedSince: observation ? timestamp(observation.unchangedSince, "Guardian unchanged time") : null,
    staleForMs: observation ? timestamp(observation.staleForMs, "Guardian stale duration") : null,
    alertId: observation?.alertId ?? null,
    repairState: observation?.repairState ?? null,
    repairOutcome: observation?.repairOutcome ?? null,
  };
}

function projectDelivery(job: TelegramJob, rows: readonly DeliveryPart[]): TelegramDeliveryStatusProjection {
  const count = (state: DeliveryState) => rows.filter((row) => row.state === state).length;
  const anchor = rows.find((row) => row.partKey === TELEGRAM_STATUS_ANCHOR_PART_KEY);
  const ordinary = rows.filter((row) => row.partKey !== TELEGRAM_STATUS_ANCHOR_PART_KEY);
  const anchorKnown = anchor?.state === "delivered" && anchor.telegramMessageId !== null;
  const plan = job.responsePlan;
  const complete = anchorKnown && (plan === undefined
    ? ordinary.every((row) => row.state === "delivered")
    : ordinary.length === plan.length
      && plan.every((part) => ordinary.some((row) => row.partKey === part.partId && row.state === "delivered")));
  return {
    total: rows.length,
    delivered: count("delivered"),
    pending: count("pending"),
    sending: count("sending"),
    uncertain: count("uncertain"),
    failed: count("failed"),
    anchorState: anchor?.state ?? "missing",
    anchorMessageId: anchor?.telegramMessageId ?? null,
    complete,
  };
}

function projectDispatch(job: TelegramJob, now: number): TelegramJobStatusProjection["dispatch"] {
  if (job.phase !== "dispatching" && job.dispatch === undefined) return null;
  const startedAt = job.dispatch ? timestamp(job.dispatch.startedAt, "dispatch start time") : null;
  const state = job.turnId !== null ? "turn_identified"
    : job.dispatch?.transportWriteState === "prepared" ? "not_sent" : "written_unknown";
  return {
    state,
    previousTurnId: job.dispatch?.previousTurnId ?? null,
    attempt: job.dispatch?.attempt ?? null,
    startedAt,
    ageMs: startedAt === null ? null : age(now, startedAt),
  };
}

function statusState(
  job: TelegramJob,
  delivery: TelegramDeliveryStatusProjection,
  guardian: TelegramGuardianStatusProjection,
  dispatch: TelegramJobStatusProjection["dispatch"],
  isDone: boolean,
): TelegramJobStatusState {
  if (delivery.failed > 0) return "delivery_failed";
  if (delivery.uncertain > 0) return "delivery_uncertain";
  if (job.phase === "terminal") {
    if (job.outcome === "completed") return isDone ? "terminal_delivered" : "terminal_incomplete";
    if (job.outcome === "failed") return "terminal_failed";
    if (job.outcome === "aborted") return "terminal_aborted";
    return "terminal_recovery_interrupted";
  }
  if (job.health === "stalled" || guardian.health === "stalled") return "stalled";
  if (job.phase === "dispatching") {
    if (dispatch?.state === "turn_identified") return "running";
    return dispatch?.state === "not_sent" ? "dispatching_not_sent" : "dispatching_unknown";
  }
  return job.phase;
}

function actionsFor(
  state: TelegramJobStatusState,
  job: TelegramJob,
  guardian: TelegramGuardianStatusProjection,
  rows: readonly DeliveryPart[],
): readonly TelegramStatusAction[] {
  const kinds: readonly TelegramStatusActionKind[] = state === "delivery_failed" ? ["retry_delivery", "details"]
    : state === "delivery_uncertain" ? ["send_again_warning", "details"]
      : state === "stalled" && job.attention.kind === "required"
          && job.attention.code === "target_topic_provision_unknown"
        ? ["inspect", "retry_new_turn", "details"]
        : state === "stalled" ? ["guardian_restore", "details"]
          : state.startsWith("terminal_") ? terminalAttentionActions(job)
          : state === "dispatching_not_sent" || state === "dispatching_unknown"
            ? ["inspect", "retry_new_turn", "details"]
            : state === "queued" || state === "running" ? ["abort", "refresh", "details"]
              : ["refresh", "details"];
  const actions: TelegramStatusAction[] = [];
  for (const kind of kinds) {
    const targets = kind === "retry_delivery"
      ? rows.filter((row) => row.state === "failed")
      : kind === "send_again_warning"
        ? rows.filter((row) => row.state === "uncertain")
        : null;
    if (targets !== null) {
      for (const row of targets) actions.push({
        kind, jobId: job.id, expectedVersion: job.version, partKey: row.partKey,
      });
      continue;
    }
    actions.push({
      kind, jobId: job.id, expectedVersion: job.version,
      ...(kind === "guardian_restore" && guardian.alertId !== null ? { alertId: guardian.alertId } : {}),
    });
  }
  return actions;
}

function terminalAttentionActions(job: TelegramJob): readonly TelegramStatusActionKind[] {
  const kinds: TelegramStatusActionKind[] = [];
  if (job.attention.kind === "required") {
    for (const action of job.attention.actions) {
      const mapped = action === "inspect" ? "inspect"
        : action === "retry" ? "retry_new_turn"
          : undefined;
      if (mapped !== undefined && !kinds.includes(mapped)) kinds.push(mapped);
    }
  }
  kinds.push("details");
  return kinds;
}

function reasons(job: TelegramJob, guardian: TelegramStatusGuardianEvidence, rows: readonly DeliveryPart[]): readonly string[] {
  const values = new Set<string>();
  if (job.attention.kind === "required") values.add(reasonCode(job.attention.code));
  if (guardian.availability === "unavailable") values.add(reasonCode(guardian.reasonCode));
  if (guardian.availability === "available" && guardian.inspection?.observation?.guardianHealth === "stalled") {
    values.add("GUARDIAN_STALLED");
  }
  for (const row of rows) if (row.lastErrorCode !== null) values.add(reasonCode(row.lastErrorCode));
  return [...values].sort();
}

function assertJobIdentity(job: TelegramJob): void {
  if (typeof job.id !== "string" || job.id.length === 0 || job.id.length > 128 || job.id.includes("\0")) {
    throw new Error("Invalid status job id");
  }
  if (!Number.isSafeInteger(job.version) || job.version < 1) throw new Error("Invalid status job version");
  timestamp(job.acceptedAt, "accepted time");
  timestamp(job.updatedAt, "updated time");
  nullableTimestamp(job.terminalAt, "terminal time");
}

function reasonCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Invalid status reason code");
  }
  return value;
}

function age(now: number, eventAt: number): number { return Math.max(0, now - eventAt); }
function timestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
function nullableTimestamp(value: unknown, name: string): number | null {
  return value === undefined || value === null ? null : timestamp(value, name);
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
