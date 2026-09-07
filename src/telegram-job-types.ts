export type UtcMilliseconds = number;

import type { TelegramTurnResult } from "./telegram-turn-result.js";

export const TELEGRAM_STATUS_ANCHOR_PART_KEY = "status-anchor";
export const TELEGRAM_RESPONSE_PLAN_MAX_PARTS = 512;

export type JobPhase =
  | "accepted"
  | "queued"
  | "dispatching"
  | "running"
  | "delivering"
  | "terminal";

export type JobHealth = "healthy" | "quiet" | "checking" | "stalled" | "unavailable";

export type JobOutcome = "completed" | "failed" | "aborted" | "recovery_interrupted" | null;

export type DeliveryState = "pending" | "sending" | "delivered" | "uncertain" | "failed";

export type JobActivity = "model" | "tool" | "subagent" | "waiting" | "unknown";

export type JobAttention =
  | { readonly kind: "none" }
  | { readonly kind: "required"; readonly code: string; readonly actions: readonly string[] };

export interface TelegramSourceKey {
  readonly botId: string;
  readonly updateId: number;
}

export interface TelegramAttachmentRef {
  readonly id: string;
  readonly kind: "photo" | "document" | "audio" | "voice" | "video" | "unknown";
  readonly telegramFileId: string;
  readonly telegramFileUniqueId?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export interface MaterializedAttachment {
  readonly id: string;
  readonly kind: TelegramAttachmentRef["kind"];
  readonly relativePath: string;
  readonly name?: string;
  readonly mimeType?: string;
}

export interface MaterializedPrompt {
  readonly text: string;
  readonly attachments: readonly MaterializedAttachment[];
}

export interface TelegramResponsePlanPart {
  readonly partId: string;
  readonly kind: "final" | "summary" | "attachment" | "notice";
}

export interface TelegramDeliveryPart {
  readonly partId: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly messageId: number | null;
  readonly deliveredAt: UtcMilliseconds | null;
}

export interface TelegramJobIdentifiers {
  readonly dispatchId: string | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
}

export type TelegramTransportWriteState = "prepared" | "in_flight" | "written";

export interface TelegramDispatchRecord {
  readonly id: string;
  readonly threadId: string;
  readonly previousTurnId: string | null;
  readonly attempt: number;
  readonly startedAt: UtcMilliseconds;
  readonly transportWriteState: TelegramTransportWriteState;
  readonly nextAttemptAt: UtcMilliseconds | null;
}

export type TelegramReconciliationDecisionKind =
  | "restore_accepted"
  | "enqueue"
  | "requeue_not_sent"
  | "hold_dispatch_unknown"
  | "recover_exact_turn"
  | "inspect_guardian"
  | "await_guardian"
  | "resume_delivery"
  | "refresh_terminal"
  | "terminate_recovery_interrupted"
  | "require_attention";

export interface TelegramReconciliationDecision {
  readonly id: string;
  readonly kind: TelegramReconciliationDecisionKind;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly reasonCode: string | null;
}

export interface TelegramReconciliationIntent {
  readonly decision: TelegramReconciliationDecision;
  readonly state: "pending" | "applied";
  readonly decidedAt: UtcMilliseconds;
  readonly appliedAt: UtcMilliseconds | null;
}

export interface TelegramJob extends TelegramJobIdentifiers {
  /** Persisted schema version. Bump only with an explicit data migration. */
  readonly schemaVersion: 1;
  /** Optimistic concurrency version. */
  readonly version: number;
  readonly id: string;
  readonly source: TelegramSourceKey;
  readonly attachments: readonly TelegramAttachmentRef[];
  /** Present only after a durable materialization success event. */
  readonly materializedPrompt?: MaterializedPrompt;
  readonly phase: JobPhase;
  readonly health: JobHealth;
  readonly activity: JobActivity;
  readonly attention: JobAttention;
  readonly outcome: JobOutcome;
  /** Current or most recent durable dispatch attempt. Absent in pre-runtime schema v1 rows. */
  readonly dispatch?: TelegramDispatchRecord;
  /** Last durable restart decision; absent on jobs written before reconciliation support. */
  readonly reconciliation?: TelegramReconciliationIntent;
  readonly lastCodexEventAt?: UtcMilliseconds | null;
  readonly abortRequestedAt?: UtcMilliseconds | null;
  readonly nextAttemptAt?: UtcMilliseconds | null;
  readonly turnResult?: TelegramTurnResult;
  /** An explicitly empty array is a valid response plan. Undefined means no plan was written. */
  readonly responsePlan: readonly TelegramResponsePlanPart[] | undefined;
  readonly deliveries: readonly TelegramDeliveryPart[];
  /** Absolute UTC timestamps in milliseconds. */
  readonly acceptedAt: UtcMilliseconds;
  readonly updatedAt: UtcMilliseconds;
  readonly terminalAt: UtcMilliseconds | null;
  readonly dismissedAt: UtcMilliseconds | null;
  readonly retainUntil: UtcMilliseconds | null;
}

interface TelegramJobEventBase {
  /** Persisted event schema version. */
  readonly schemaVersion: 1;
  readonly eventAt: UtcMilliseconds;
  readonly expectedVersion?: number;
  readonly health?: JobHealth;
  readonly activity?: JobActivity;
  readonly attention?: JobAttention;
  readonly identifiers?: Partial<TelegramJobIdentifiers>;
  readonly dismissedAt?: UtcMilliseconds | null;
  readonly retainUntil?: UtcMilliseconds | null;
}

export interface UpdateAcceptedEvent extends TelegramJobEventBase {
  readonly type: "update.accepted";
  readonly phase?: "accepted";
}

export interface JobQueuedEvent extends TelegramJobEventBase {
  readonly type: "job.queued";
  readonly phase?: "queued";
}

export interface DispatchStartedEvent extends TelegramJobEventBase {
  readonly type: "dispatch.started";
  readonly phase?: "dispatching";
  readonly dispatch: TelegramDispatchRecord;
}

export interface DispatchInFlightEvent extends TelegramJobEventBase {
  readonly type: "dispatch.in_flight";
  readonly phase?: "dispatching";
}

export interface DispatchWrittenEvent extends TelegramJobEventBase {
  readonly type: "dispatch.written";
  readonly phase?: "dispatching";
}

export interface JobDeferredEvent extends TelegramJobEventBase {
  readonly type: "job.deferred";
  readonly phase?: "queued";
  readonly nextAttemptAt: UtcMilliseconds;
}

export interface TurnStartedEvent extends TelegramJobEventBase {
  readonly type: "turn.started";
  readonly phase?: "running";
  readonly codexEventAt?: UtcMilliseconds;
}

export interface ActivityObservedEvent extends TelegramJobEventBase {
  readonly type: "activity.observed";
  readonly codexEventAt?: UtcMilliseconds;
}

export interface AbortRequestedEvent extends TelegramJobEventBase {
  readonly type: "abort.requested";
  readonly abortRequestedAt: UtcMilliseconds;
}

export interface TurnCompletedEvent extends TelegramJobEventBase {
  readonly type: "turn.completed";
  readonly phase?: "delivering";
  readonly turnResult: TelegramTurnResult;
  readonly codexEventAt?: UtcMilliseconds;
}

export interface GuardianObservedEvent extends TelegramJobEventBase {
  readonly type: "guardian.observed";
}

export interface ReconciliationDecidedEvent extends TelegramJobEventBase {
  readonly type: "reconciliation.decided";
  readonly decision: TelegramReconciliationDecision;
}

export interface ReconciliationAppliedEvent extends TelegramJobEventBase {
  readonly type: "reconciliation.applied";
  readonly decisionId: string;
}

export type MaterializationFailureCode =
  | "download_failed"
  | "transcription_failed"
  | "staging_failed";

export interface MaterializationSucceededEvent extends TelegramJobEventBase {
  readonly type: "materialization.succeeded";
  readonly phase?: "accepted";
  readonly materializedPrompt: MaterializedPrompt;
}

export interface MaterializationFailedEvent extends TelegramJobEventBase {
  readonly type: "materialization.failed";
  readonly phase?: "accepted";
  readonly failureCode: MaterializationFailureCode;
}

export interface DeliveryChangedEvent extends TelegramJobEventBase {
  readonly type: "delivery.changed";
  readonly phase?: "running" | "delivering" | "terminal";
  readonly responsePlan?: readonly TelegramResponsePlanPart[];
  readonly deliveries?: readonly TelegramDeliveryPart[];
}

export type DeliveryReplanReasonCode =
  | "rich_format_rejected"
  | "rich_method_unavailable"
  | "rich_local_fallback";

export interface DeliveryReplannedEvent extends TelegramJobEventBase {
  readonly type: "delivery.replanned";
  readonly phase?: "delivering";
  readonly reasonCode: DeliveryReplanReasonCode;
  readonly responsePlan: readonly TelegramResponsePlanPart[];
  readonly deliveries: readonly TelegramDeliveryPart[];
}

export interface JobTerminalEvent extends TelegramJobEventBase {
  readonly type: "job.terminal";
  readonly phase?: "terminal";
  readonly outcome: Exclude<JobOutcome, null>;
  readonly responsePlan?: readonly TelegramResponsePlanPart[];
  readonly deliveries?: readonly TelegramDeliveryPart[];
}

export type TelegramJobEvent =
  | UpdateAcceptedEvent
  | JobQueuedEvent
  | DispatchStartedEvent
  | DispatchInFlightEvent
  | DispatchWrittenEvent
  | JobDeferredEvent
  | TurnStartedEvent
  | ActivityObservedEvent
  | AbortRequestedEvent
  | TurnCompletedEvent
  | GuardianObservedEvent
  | ReconciliationDecidedEvent
  | ReconciliationAppliedEvent
  | MaterializationSucceededEvent
  | MaterializationFailedEvent
  | DeliveryChangedEvent
  | DeliveryReplannedEvent
  | JobTerminalEvent;
