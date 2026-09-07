import { isDeepStrictEqual } from "node:util";
import { cloneMaterializedPrompt, parseMaterializedPrompt, parseTelegramAttachmentRefs } from "./telegram-job-materialization.js";
import {
  applyTelegramDispatchEvent, applyTelegramReconciliationEvent, assertTelegramReconciliationIntentForJob,
  cloneTelegramDispatchRecord, cloneTelegramTurnResult, isTelegramDeliveryProjectionValid,
  parseOptionalTimestamp, parseTelegramDispatchRecord, parseTelegramEventPhase, parseTelegramReconciliationIntent,
  parseTelegramRuntimeEvent, parseTelegramTurnResult, resolveTelegramEventPhase,
  validateTelegramEventKeys,
} from "./telegram-job-runtime.js";
import type {
  DeliveryState, JobAttention, JobHealth, JobPhase, JobActivity, JobOutcome,
  MaterializedPrompt, MaterializationFailureCode, TelegramAttachmentRef, TelegramReconciliationDecision,
  TelegramDeliveryPart, TelegramDispatchRecord, TelegramJob, TelegramJobEvent, TelegramJobIdentifiers,
  TelegramResponsePlanPart, TelegramSourceKey, UtcMilliseconds,
} from "./telegram-job-types.js";
import type { TelegramTurnResult } from "./telegram-turn-result.js";
export type {
  DeliveryState, JobActivity, JobAttention, JobHealth, JobOutcome, JobPhase,
  MaterializedPrompt, MaterializationFailureCode, TelegramAttachmentRef,
  TelegramDeliveryPart, TelegramJob, TelegramJobEvent, TelegramResponsePlanPart,
  TelegramSourceKey, UtcMilliseconds,
} from "./telegram-job-types.js";

export const JobTransitionErrorCode = {
  INVALID_JOB_SHAPE: "INVALID_JOB_SHAPE",
  INVALID_JOB_LIFECYCLE: "INVALID_JOB_LIFECYCLE",
  INVALID_EVENT_SHAPE: "INVALID_EVENT_SHAPE",
  UNSUPPORTED_JOB_SCHEMA_VERSION: "UNSUPPORTED_JOB_SCHEMA_VERSION",
  UNSUPPORTED_EVENT_SCHEMA_VERSION: "UNSUPPORTED_EVENT_SCHEMA_VERSION",
  INVALID_EVENT_TYPE: "INVALID_EVENT_TYPE",
  INVALID_EVENT_PHASE: "INVALID_EVENT_PHASE",
  INVALID_VERSION: "INVALID_VERSION",
  VERSION_OVERFLOW: "VERSION_OVERFLOW",
  VERSION_SEQUENCE_INVALID: "VERSION_SEQUENCE_INVALID",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
  TIMESTAMP_REGRESSION: "TIMESTAMP_REGRESSION",
  INVALID_PHASE_TRANSITION: "INVALID_PHASE_TRANSITION",
  TERMINAL_IMMUTABLE: "TERMINAL_IMMUTABLE",
  TERMINAL_REQUIRES_OUTCOME: "TERMINAL_REQUIRES_OUTCOME",
  OUTCOME_REQUIRES_TERMINAL: "OUTCOME_REQUIRES_TERMINAL",
  COMPLETED_REQUIRES_RESPONSE_PLAN: "COMPLETED_REQUIRES_RESPONSE_PLAN",
  INVALID_DELIVERY_METADATA: "INVALID_DELIVERY_METADATA",
} as const;

export type JobTransitionErrorCode =
  (typeof JobTransitionErrorCode)[keyof typeof JobTransitionErrorCode];

export class JobTransitionError extends Error {
  constructor(readonly code: JobTransitionErrorCode) {
    super(code);
    this.name = "JobTransitionError";
  }
}

export interface JobVersionConflict {
  readonly kind: "conflict";
  readonly code: "VERSION_MISMATCH";
  readonly expectedVersion: number;
  readonly actualVersion: number;
}

export interface AppliedJobTransition {
  readonly kind: "applied";
  readonly job: TelegramJob;
}

export type JobTransitionResult = AppliedJobTransition | JobVersionConflict;

type EventType = TelegramJobEvent["type"];
type ValidatedEvent = {
  readonly schemaVersion: 1;
  readonly type: EventType;
  readonly eventAt: UtcMilliseconds;
  readonly expectedVersion?: number;
  readonly phase?: JobPhase;
  readonly health?: JobHealth;
  readonly activity?: JobActivity;
  readonly attention?: JobAttention;
  readonly identifiers?: Partial<TelegramJobIdentifiers>;
  readonly dismissedAt?: UtcMilliseconds | null;
  readonly retainUntil?: UtcMilliseconds | null;
  readonly outcome?: Exclude<JobOutcome, null>;
  readonly responsePlan?: readonly TelegramResponsePlanPart[];
  readonly deliveries?: readonly TelegramDeliveryPart[];
  readonly materializedPrompt?: MaterializedPrompt;
  readonly failureCode?: MaterializationFailureCode;
  readonly dispatch?: TelegramDispatchRecord;
  readonly nextAttemptAt?: UtcMilliseconds;
  readonly abortRequestedAt?: UtcMilliseconds;
  readonly codexEventAt?: UtcMilliseconds;
  readonly turnResult?: TelegramTurnResult;
  readonly reconciliationDecision?: TelegramReconciliationDecision;
  readonly reconciliationDecisionId?: string;
};

const phases = ["accepted", "queued", "dispatching", "running", "delivering", "terminal"] as const;
const healths = ["healthy", "quiet", "checking", "stalled", "unavailable"] as const;
const activities = ["model", "tool", "subagent", "waiting", "unknown"] as const;
const outcomes = ["completed", "failed", "aborted", "recovery_interrupted"] as const;
const deliveryStates = ["pending", "sending", "delivered", "uncertain", "failed"] as const;
const responsePartKinds = ["final", "summary", "attachment", "notice"] as const;
const eventTypes = [
  "update.accepted", "job.queued", "dispatch.started", "dispatch.in_flight",
  "dispatch.written", "job.deferred", "turn.started", "turn.completed", "abort.requested",
  "activity.observed", "guardian.observed", "materialization.succeeded",
  "materialization.failed", "delivery.changed", "delivery.replanned", "job.terminal",
  "reconciliation.decided", "reconciliation.applied",
] as const;
const materializationFailureCodes = ["download_failed", "transcription_failed", "staging_failed"] as const;
const deliveryReplanReasonCodes = ["rich_format_rejected", "rich_method_unavailable", "rich_local_fallback"] as const;
const allowedPhaseTransitions: Readonly<Record<JobPhase, readonly JobPhase[]>> = {
  accepted: ["accepted", "queued", "terminal"],
  queued: ["queued", "dispatching", "terminal"],
  dispatching: ["dispatching", "queued", "running", "terminal"],
  running: ["running", "delivering", "terminal"],
  delivering: ["delivering", "terminal"],
  terminal: ["terminal"],
};

export function transitionJob(previous: TelegramJob, event: TelegramJobEvent): JobTransitionResult {
  const job = parseJob(previous);
  const input = parseEvent(event);
  if (input.expectedVersion !== undefined && input.expectedVersion !== job.version) {
    return { kind: "conflict", code: "VERSION_MISMATCH", expectedVersion: input.expectedVersion, actualVersion: job.version };
  }
  if (job.version === Number.MAX_SAFE_INTEGER) throw error("VERSION_OVERFLOW");

  const phase = runtime(
    () => resolveTelegramEventPhase(job.phase, input.type, input.phase),
    "INVALID_EVENT_PHASE",
  );
  const dispatch = runtime(() => applyTelegramDispatchEvent(job.dispatch, input), "INVALID_JOB_LIFECYCLE");
  const reconciliation = runtime(() => applyTelegramReconciliationEvent(
    job.reconciliation, input, { threadId: job.threadId, turnId: job.turnId },
  ), "INVALID_JOB_LIFECYCLE");
  const next: TelegramJob = {
    ...job,
    ...input.identifiers,
    ...(input.dispatch === undefined ? {} : { dispatchId: input.dispatch.id, threadId: input.dispatch.threadId }),
    phase,
    health: input.health ?? job.health,
    activity: input.activity ?? job.activity,
    attention: input.attention ?? job.attention,
    outcome: input.type === "job.terminal" ? input.outcome! : job.outcome,
    ...(dispatch === undefined ? {} : { dispatch }),
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(input.codexEventAt === undefined ? {} : { lastCodexEventAt: input.codexEventAt }),
    ...(input.abortRequestedAt === undefined ? {} : { abortRequestedAt: input.abortRequestedAt }),
    ...(input.nextAttemptAt === undefined
      ? (input.type === "dispatch.started" ? { nextAttemptAt: null } : {})
      : { nextAttemptAt: input.nextAttemptAt }),
    ...(input.turnResult === undefined ? {} : { turnResult: input.turnResult }),
    responsePlan: input.responsePlan ?? job.responsePlan,
    deliveries: input.deliveries ?? job.deliveries,
    ...(input.materializedPrompt === undefined
      ? (job.materializedPrompt === undefined ? {} : { materializedPrompt: job.materializedPrompt })
      : { materializedPrompt: input.materializedPrompt }),
    updatedAt: input.eventAt,
    terminalAt: phase === "terminal" && job.phase !== "terminal" ? input.eventAt : job.terminalAt,
    dismissedAt: input.dismissedAt === undefined ? job.dismissedAt : input.dismissedAt,
    retainUntil: input.retainUntil === undefined ? job.retainUntil : input.retainUntil,
    version: job.version + 1,
  };
  assertTransitionValidated(job, next);
  return { kind: "applied", job: cloneJob(next) };
}

export function assertTransition(previous: TelegramJob, next: TelegramJob): void {
  assertTransitionValidated(parseJob(previous), parseJob(next));
}

export function isDoneEligible(job: TelegramJob): boolean {
  try {
    const snapshot = parseJob(job);
    if (snapshot.phase !== "terminal" || snapshot.outcome !== "completed" || snapshot.responsePlan === undefined) return false;
    if (snapshot.deliveries.length !== snapshot.responsePlan.length) return false;
    const planned = new Set(snapshot.responsePlan.map((part) => part.partId));
    return snapshot.deliveries.every((delivery) => planned.has(delivery.partId) && delivery.state === "delivered");
  } catch {
    return false;
  }
}

function assertTransitionValidated(previous: TelegramJob, next: TelegramJob): void {
  assertTimestampProgression(previous.updatedAt, next.updatedAt);
  assertOptionalTimestampProgression(previous.dismissedAt, next.dismissedAt);
  assertOptionalTimestampProgression(previous.retainUntil, next.retainUntil);
  assertDeliveryTimestampProgression(previous.deliveries, next.deliveries);
  if (next.acceptedAt !== previous.acceptedAt) throw error("INVALID_TIMESTAMP");
  if (next.version !== previous.version + 1) throw error("VERSION_SEQUENCE_INVALID");
  if (!allowedPhaseTransitions[previous.phase].includes(next.phase)) throw error("INVALID_PHASE_TRANSITION");
  assertJobState(next);
  if (previous.phase === "terminal" && terminalFieldsChanged(previous, next)) throw error("TERMINAL_IMMUTABLE");
}

function parseJob(value: unknown): TelegramJob {
  const raw = record(value, "INVALID_JOB_SHAPE");
  if (raw.schemaVersion !== 1) throw error("UNSUPPORTED_JOB_SCHEMA_VERSION");
  onlyKeys(raw, ["schemaVersion", "id", "version", "source", "attachments", "materializedPrompt", "phase", "health", "activity", "attention", "outcome", "dispatchId", "threadId", "turnId", "dispatch", "reconciliation", "lastCodexEventAt", "abortRequestedAt", "nextAttemptAt", "turnResult", "responsePlan", "deliveries", "acceptedAt", "updatedAt", "terminalAt", "dismissedAt", "retainUntil"], "INVALID_JOB_SHAPE");
  const job: TelegramJob = {
    schemaVersion: 1,
    id: string(raw.id, "INVALID_JOB_SHAPE"),
    version: version(raw.version),
    source: source(raw.source, "INVALID_JOB_SHAPE"),
    attachments: attachments(raw.attachments, "INVALID_JOB_SHAPE"),
    ...(raw.materializedPrompt === undefined
      ? {}
      : { materializedPrompt: materializedPrompt(raw.materializedPrompt, "INVALID_JOB_SHAPE") }),
    phase: enumeration(raw.phase, phases, "INVALID_JOB_SHAPE"),
    health: enumeration(raw.health, healths, "INVALID_JOB_SHAPE"),
    activity: enumeration(raw.activity, activities, "INVALID_JOB_SHAPE"),
    attention: attention(raw.attention, "INVALID_JOB_SHAPE"),
    outcome: nullableEnum(raw.outcome, outcomes, "INVALID_JOB_SHAPE"),
    dispatchId: nullableString(raw.dispatchId, "INVALID_JOB_SHAPE"),
    threadId: nullableString(raw.threadId, "INVALID_JOB_SHAPE"),
    turnId: nullableString(raw.turnId, "INVALID_JOB_SHAPE"),
    ...(raw.dispatch === undefined ? {} : { dispatch: runtime(() => parseTelegramDispatchRecord(raw.dispatch), "INVALID_JOB_SHAPE") }),
    ...(raw.reconciliation === undefined ? {} : { reconciliation: runtime(() => parseTelegramReconciliationIntent(raw.reconciliation), "INVALID_JOB_SHAPE") }),
    ...(raw.lastCodexEventAt === undefined ? {} : { lastCodexEventAt: runtime(() => parseOptionalTimestamp(raw.lastCodexEventAt), "INVALID_JOB_SHAPE") }),
    ...(raw.abortRequestedAt === undefined ? {} : { abortRequestedAt: runtime(() => parseOptionalTimestamp(raw.abortRequestedAt), "INVALID_JOB_SHAPE") }),
    ...(raw.nextAttemptAt === undefined ? {} : { nextAttemptAt: runtime(() => parseOptionalTimestamp(raw.nextAttemptAt), "INVALID_JOB_SHAPE") }),
    ...(raw.turnResult === undefined ? {} : { turnResult: runtime(() => parseTelegramTurnResult(raw.turnResult), "INVALID_JOB_SHAPE") }),
    responsePlan: raw.responsePlan === undefined ? undefined : responsePlan(raw.responsePlan, "INVALID_JOB_SHAPE"),
    deliveries: deliveries(raw.deliveries, "INVALID_JOB_SHAPE"),
    acceptedAt: timestamp(raw.acceptedAt),
    updatedAt: timestamp(raw.updatedAt),
    terminalAt: nullableTimestamp(raw.terminalAt),
    dismissedAt: nullableTimestamp(raw.dismissedAt),
    retainUntil: nullableTimestamp(raw.retainUntil),
  };
  assertJobState(job);
  return job;
}

function parseEvent(value: unknown): ValidatedEvent {
  const raw = record(value, "INVALID_EVENT_SHAPE");
  if (raw.schemaVersion !== 1) throw error("UNSUPPORTED_EVENT_SCHEMA_VERSION");
  const type = enumeration(raw.type, eventTypes, "INVALID_EVENT_TYPE");
  runtime(() => validateTelegramEventKeys(raw, type), "INVALID_EVENT_SHAPE");
  const runtimeFields = runtime(() => parseTelegramRuntimeEvent(raw, type), "INVALID_EVENT_SHAPE");
  const base = {
    schemaVersion: 1 as const,
    type,
    eventAt: timestamp(raw.eventAt),
    expectedVersion: raw.expectedVersion === undefined ? undefined : version(raw.expectedVersion),
    phase: runtime(() => parseTelegramEventPhase(raw.phase, type), "INVALID_EVENT_PHASE"),
    health: raw.health === undefined ? undefined : enumeration(raw.health, healths, "INVALID_EVENT_SHAPE"),
    activity: raw.activity === undefined ? undefined : enumeration(raw.activity, activities, "INVALID_EVENT_SHAPE"),
    attention: raw.attention === undefined ? undefined : attention(raw.attention, "INVALID_EVENT_SHAPE"),
    identifiers: raw.identifiers === undefined ? undefined : identifiers(raw.identifiers, "INVALID_EVENT_SHAPE"),
    dismissedAt: raw.dismissedAt === undefined ? undefined : nullableTimestamp(raw.dismissedAt),
    retainUntil: raw.retainUntil === undefined ? undefined : nullableTimestamp(raw.retainUntil),
  };
  if (type === "job.terminal") {
    if (!has(raw, "outcome")) throw error("INVALID_EVENT_SHAPE");
    return {
      ...base,
      outcome: enumeration(raw.outcome, outcomes, "INVALID_EVENT_SHAPE"),
      responsePlan: raw.responsePlan === undefined ? undefined : responsePlan(raw.responsePlan, "INVALID_EVENT_SHAPE"),
      deliveries: raw.deliveries === undefined ? undefined : deliveries(raw.deliveries, "INVALID_EVENT_SHAPE"),
    };
  }
  if (type === "delivery.replanned") {
    if (!has(raw, "reasonCode") || !has(raw, "responsePlan") || !has(raw, "deliveries")) throw error("INVALID_EVENT_SHAPE");
    enumeration(raw.reasonCode, deliveryReplanReasonCodes, "INVALID_EVENT_SHAPE");
    const plan = responsePlan(raw.responsePlan, "INVALID_EVENT_SHAPE"), projected = deliveries(raw.deliveries, "INVALID_EVENT_SHAPE");
    if (!isTelegramDeliveryProjectionValid(plan, projected)) throw error("INVALID_EVENT_SHAPE");
    return { ...base, responsePlan: plan, deliveries: projected };
  }
  if (type === "delivery.changed") {
    return {
      ...base,
      responsePlan: raw.responsePlan === undefined ? undefined : responsePlan(raw.responsePlan, "INVALID_EVENT_SHAPE"),
      deliveries: raw.deliveries === undefined ? undefined : deliveries(raw.deliveries, "INVALID_EVENT_SHAPE"),
    };
  }
  if (type === "materialization.succeeded") {
    if (!has(raw, "materializedPrompt")) throw error("INVALID_EVENT_SHAPE");
    return {
      ...base,
      materializedPrompt: materializedPrompt(raw.materializedPrompt, "INVALID_EVENT_SHAPE"),
    };
  }
  if (type === "materialization.failed") {
    if (!has(raw, "failureCode")) throw error("INVALID_EVENT_SHAPE");
    return {
      ...base,
      failureCode: enumeration(
        raw.failureCode,
        materializationFailureCodes,
        "INVALID_EVENT_SHAPE",
      ),
    };
  }
  if (has(raw, "outcome") || has(raw, "responsePlan") || has(raw, "deliveries")) throw error("INVALID_EVENT_SHAPE");
  return { ...base, ...runtimeFields };
}

function assertJobState(job: TelegramJob): void {
  assertDeliveryMetadata(job.responsePlan, job.deliveries);
  runtime(() => assertTelegramReconciliationIntentForJob(
    job.reconciliation, { threadId: job.threadId, turnId: job.turnId }, job.updatedAt,
  ), "INVALID_JOB_LIFECYCLE");
  if ((job.phase === "terminal") !== (job.terminalAt !== null)) throw error("INVALID_JOB_LIFECYCLE");
  if (job.acceptedAt > job.updatedAt || (job.terminalAt !== null && (job.terminalAt < job.acceptedAt || job.terminalAt > job.updatedAt))) throw error("INVALID_JOB_LIFECYCLE");
  if (job.phase === "terminal" && job.outcome === null) throw error("TERMINAL_REQUIRES_OUTCOME");
  if (job.phase !== "terminal" && job.outcome !== null) throw error("OUTCOME_REQUIRES_TERMINAL");
  if (job.outcome === "completed" && job.responsePlan === undefined) throw error("COMPLETED_REQUIRES_RESPONSE_PLAN");
  if (job.dispatch && (job.dispatch.id !== job.dispatchId || job.dispatch.threadId !== job.threadId)) throw error("INVALID_JOB_LIFECYCLE");
}

function assertDeliveryMetadata(plan: readonly TelegramResponsePlanPart[] | undefined, values: readonly TelegramDeliveryPart[]): void {
  if (plan === undefined ? duplicate(values.map((delivery) => delivery.partId))
    : !isTelegramDeliveryProjectionValid(plan, values)) throw error("INVALID_DELIVERY_METADATA");
}
function assertTimestampProgression(previous: number, next: number): void {
  if (next < previous) throw error("TIMESTAMP_REGRESSION");
}

function assertOptionalTimestampProgression(previous: number | null, next: number | null): void {
  if (previous !== null && (next === null || next < previous)) throw error("TIMESTAMP_REGRESSION");
}

function assertDeliveryTimestampProgression(previous: readonly TelegramDeliveryPart[], next: readonly TelegramDeliveryPart[]): void {
  const byPart = new Map(next.map((delivery) => [delivery.partId, delivery]));
  for (const delivery of previous) {
    const updated = byPart.get(delivery.partId);
    if (updated) assertOptionalTimestampProgression(delivery.deliveredAt, updated.deliveredAt);
    else if (delivery.deliveredAt !== null) throw error("TIMESTAMP_REGRESSION");
  }
}

function terminalFieldsChanged(previous: TelegramJob, next: TelegramJob): boolean {
  return previous.schemaVersion !== next.schemaVersion
    || previous.id !== next.id
    || !isDeepStrictEqual(previous.source, next.source)
    || !isDeepStrictEqual(previous.attachments, next.attachments)
    || !isDeepStrictEqual(previous.materializedPrompt, next.materializedPrompt)
    || previous.phase !== next.phase
    || previous.health !== next.health
    || previous.activity !== next.activity
    || !isDeepStrictEqual(previous.attention, next.attention)
    || previous.outcome !== next.outcome
    || previous.dispatchId !== next.dispatchId
    || previous.threadId !== next.threadId
    || previous.turnId !== next.turnId
    || !isDeepStrictEqual(previous.dispatch, next.dispatch)
    || previous.lastCodexEventAt !== next.lastCodexEventAt
    || previous.abortRequestedAt !== next.abortRequestedAt
    || previous.nextAttemptAt !== next.nextAttemptAt
    || !isDeepStrictEqual(previous.turnResult, next.turnResult)
    || !isDeepStrictEqual(previous.responsePlan, next.responsePlan)
    || previous.acceptedAt !== next.acceptedAt
    || previous.terminalAt !== next.terminalAt;
}

function cloneJob(job: TelegramJob): TelegramJob {
  return {
    ...job,
    source: { ...job.source },
    attachments: job.attachments.map((attachment) => ({ ...attachment })),
    ...(job.materializedPrompt === undefined
      ? {}
      : { materializedPrompt: cloneMaterializedPrompt(job.materializedPrompt) }),
    ...(job.dispatch === undefined ? {} : { dispatch: cloneTelegramDispatchRecord(job.dispatch) }),
    ...(job.reconciliation === undefined ? {} : { reconciliation: parseTelegramReconciliationIntent(job.reconciliation) }),
    ...(job.turnResult === undefined ? {} : { turnResult: cloneTelegramTurnResult(job.turnResult) }),
    attention: job.attention.kind === "none" ? { kind: "none" } : { ...job.attention, actions: [...job.attention.actions] },
    responsePlan: job.responsePlan?.map((part) => ({ ...part })),
    deliveries: job.deliveries.map((delivery) => ({ ...delivery })),
  };
}

function source(value: unknown, code: JobTransitionErrorCode): TelegramSourceKey {
  const raw = record(value, code);
  onlyKeys(raw, ["botId", "updateId"], code);
  if (!has(raw, "botId") || !has(raw, "updateId")) throw error(code);
  const updateId = integer(raw.updateId, code, 0);
  return { botId: string(raw.botId, code), updateId };
}

function attachments(value: unknown, code: JobTransitionErrorCode): readonly TelegramAttachmentRef[] {
  try { return parseTelegramAttachmentRefs(value); }
  catch { throw error(code); }
}
function materializedPrompt(value: unknown, code: JobTransitionErrorCode): MaterializedPrompt {
  try { return parseMaterializedPrompt(value); }
  catch { throw error(code); }
}

function attention(value: unknown, code: JobTransitionErrorCode): JobAttention {
  const raw = record(value, code);
  if (raw.kind === "none") {
    onlyKeys(raw, ["kind"], code);
    return { kind: "none" };
  }
  if (raw.kind !== "required") throw error(code);
  onlyKeys(raw, ["kind", "code", "actions"], code);
  return { kind: "required", code: string(raw.code, code), actions: array(raw.actions, code).map((action) => string(action, code)) };
}

function identifiers(value: unknown, code: JobTransitionErrorCode): Partial<TelegramJobIdentifiers> {
  const raw = record(value, code);
  onlyKeys(raw, ["dispatchId", "threadId", "turnId"], code);
  const parsed: { -readonly [Key in keyof TelegramJobIdentifiers]?: TelegramJobIdentifiers[Key] } = {};
  for (const key of ["dispatchId", "threadId", "turnId"] as const) {
    if (raw[key] !== undefined) parsed[key] = nullableString(raw[key], code);
  }
  return parsed;
}

function responsePlan(value: unknown, code: JobTransitionErrorCode): readonly TelegramResponsePlanPart[] {
  return array(value, code).map((item) => {
    const raw = record(item, code);
    onlyKeys(raw, ["partId", "kind"], code);
    return { partId: string(raw.partId, code), kind: enumeration(raw.kind, responsePartKinds, code) };
  });
}

function deliveries(value: unknown, code: JobTransitionErrorCode): readonly TelegramDeliveryPart[] {
  return array(value, code).map((item) => {
    const raw = record(item, code);
    onlyKeys(raw, ["partId", "state", "attempts", "messageId", "deliveredAt"], code);
    return {
      partId: string(raw.partId, code),
      state: enumeration(raw.state, deliveryStates, code),
      attempts: integer(raw.attempts, code, 0),
      messageId: raw.messageId === null ? null : integer(raw.messageId, code, 1),
      deliveredAt: nullableTimestamp(raw.deliveredAt),
    };
  });
}

function record(value: unknown, code: JobTransitionErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw error(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: JobTransitionErrorCode): unknown[] {
  if (!Array.isArray(value)) throw error(code);
  return value;
}

function string(value: unknown, code: JobTransitionErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw error(code);
  return value;
}

function integer(value: unknown, code: JobTransitionErrorCode, minimum = Number.MIN_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw error(code);
  return value as number;
}

function version(value: unknown): number {
  return integer(value, "INVALID_VERSION", 0);
}

function timestamp(value: unknown): UtcMilliseconds {
  return integer(value, "INVALID_TIMESTAMP", 0);
}

function nullableTimestamp(value: unknown): UtcMilliseconds | null {
  return value === null ? null : timestamp(value);
}

function nullableString(value: unknown, code: JobTransitionErrorCode): string | null {
  return value === null ? null : string(value, code);
}

function enumeration<T extends string>(value: unknown, values: readonly T[], code: JobTransitionErrorCode): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw error(code);
  return value as T;
}

function nullableEnum<T extends string>(value: unknown, values: readonly T[], code: JobTransitionErrorCode): T | null {
  return value === null ? null : enumeration(value, values, code);
}

function duplicate(values: readonly string[]): boolean {
  return values.some((value) => value.length === 0) || new Set(values).size !== values.length;
}

function has(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[], code: JobTransitionErrorCode): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw error(code);
}

function error(code: JobTransitionErrorCode): JobTransitionError {
  return new JobTransitionError(code);
}

function runtime<T>(read: () => T, code: JobTransitionErrorCode): T {
  try { return read(); } catch { throw error(code); }
}
