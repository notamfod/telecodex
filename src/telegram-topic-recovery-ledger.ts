import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { validateDelivery, type DeliveryPart } from "./telegram-delivery-ledger.js";
import type { TransitionEvent } from "./telegram-job-ledger.js";
import type { TelegramJob } from "./telegram-job-types.js";
import {
  rebindTelegramTopicPayload,
  type TelegramTopicDestination,
  type TelegramTopicRecoveryCandidate,
} from "./telegram-topic-recovery.js";
import { hashTelegramDeliveryPayload, normalizeTelegramDeliveryPayload } from "./telegram-response-plan.js";
import { decodeCanonicalTopicRecoverySourceJson, encodeCanonicalTopicRecoverySource } from "./telegram-topic-recovery-source-codec.js";
const JOB_ID_MAX_LENGTH = 128, EVENT_ID_MAX_LENGTH = 128;
const TOPIC_NAME_MAX_LENGTH = 128;
const DEFAULT_LIST_LIMIT = 100, MAX_LIST_LIMIT = 1_000;
export type TelegramTopicRecoveryState = "in_flight" | "retry_wait" | "unknown" | "complete" | "failed";
export type TelegramTopicRecoveryOutcomeReasonCode = "TOPIC_RECOVERY_UNKNOWN" | "TOPIC_RECOVERY_FAILED";
export type TelegramTopicRecoveryReasonCode = TelegramTopicRecoveryOutcomeReasonCode | "TOPIC_RECOVERY_RATE_LIMITED";
export interface TelegramTopicRecoveryRecord {
  readonly jobId: string; readonly actionToken: string;
  readonly state: TelegramTopicRecoveryState;
  readonly oldDestination: TelegramTopicDestination;
  readonly newMessageThreadId: number | null; readonly reservedJobVersion: number;
  readonly currentJobVersion: number; readonly nextAttemptAt: number | null;
  readonly reasonCode: TelegramTopicRecoveryReasonCode | null; readonly startedAt: number; readonly updatedAt: number;
}
export interface TelegramTopicRecoveryResult {
  readonly job: TelegramJob; readonly recovery: TelegramTopicRecoveryRecord;
}
export interface TelegramTopicRecoveryCompletion extends TelegramTopicRecoveryResult {
  readonly anchor: DeliveryPart;
}
export interface ReserveTopicRecoveryInput {
  readonly candidate: TelegramTopicRecoveryCandidate; readonly eventId: string;
  readonly actionToken: string; readonly eventAt: number;
}
export interface TopicRecoveryOutcomeInput {
  readonly jobId: string; readonly expectedVersion: number; readonly actionToken: string;
  readonly reasonCode: TelegramTopicRecoveryOutcomeReasonCode; readonly updatedAt: number;
}
export interface DeferTopicRecoveryInput extends Omit<TopicRecoveryOutcomeInput, "reasonCode"> {
  readonly nextAttemptAt: number;
}
export type ResumeTopicRecoveryInput = Omit<TopicRecoveryOutcomeInput, "reasonCode">;
export interface CompleteTopicRecoveryInput {
  readonly jobId: string; readonly expectedVersion: number; readonly eventId: string;
  readonly actionToken: string; readonly target: TelegramTopicDestination; readonly eventAt: number;
}
interface TelegramTopicRecoveryLedgerHost {
  readonly database: Database.Database; readonly statement: (sql: string) => Database.Statement;
  readonly getJob: (jobId: string) => TelegramJob | null;
  readonly listDeliveries: (jobId: string) => readonly DeliveryPart[];
  readonly applyTransition: (input: {
    readonly jobId: string;
    readonly eventId: string;
    readonly expectedVersion: number;
    readonly event: TransitionEvent;
  }) => TelegramJob;
}
interface EligibleRecoveryPlan {
  readonly oldDestination: TelegramTopicDestination;
  readonly parts: TelegramTopicRecoveryCandidate["parts"]; readonly anchorPlan: TelegramTopicRecoveryCandidate["anchorPlan"];
}
export class TelegramTopicRecoveryLedger {
  constructor(private readonly host: TelegramTopicRecoveryLedgerHost) {}
  reserve(input: ReserveTopicRecoveryInput): TelegramTopicRecoveryResult {
    validateReserveInput(input);
    return this.host.database.transaction(() => {
      if (this.raw(input.candidate.jobId)) throw new Error("Telegram topic recovery already reserved");
      const current = this.host.getJob(input.candidate.jobId);
      if (!current || current.version !== input.candidate.expectedVersion) conflict();
      const actual = this.eligiblePlan(current);
      if (!actual || !sameCandidate(input.candidate, current, actual)) conflict();
      const job = this.host.applyTransition({
        jobId: current.id,
        eventId: input.eventId,
        expectedVersion: current.version,
        event: recoveryEvent(input.eventAt, "TOPIC_RECOVERY_IN_FLIGHT"),
      });
      this.host.statement(`INSERT INTO topic_recoveries
        (job_id, action_token, state, old_chat_id, old_message_thread_id,
          new_message_thread_id, reserved_job_version, current_job_version,
          next_attempt_at_ms, reason_code, started_at_ms, updated_at_ms)
        VALUES (?, ?, 'in_flight', ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)`).run(
        current.id, input.actionToken, input.candidate.oldDestination.chatId,
        input.candidate.oldDestination.messageThreadId, current.version, job.version,
        input.eventAt, input.eventAt,
      );
      return { job, recovery: this.require(current.id) };
    }).immediate();
  }
  defer(input: DeferTopicRecoveryInput): TelegramTopicRecoveryRecord {
    validateOutcomeBase(input);
    timestamp(input.nextAttemptAt, "nextAttemptAt");
    if (input.nextAttemptAt <= input.updatedAt) throw new Error("Invalid topic recovery retry deadline");
    return this.transitionOutcome(input, "retry_wait", "TOPIC_RECOVERY_RATE_LIMITED", input.nextAttemptAt);
  }
  resume(input: ResumeTopicRecoveryInput): TelegramTopicRecoveryResult {
    validateOutcomeBase(input);
    return this.host.database.transaction(() => {
      const recovery = this.require(input.jobId);
      const current = this.host.getJob(input.jobId);
      if (!current || current.version !== input.expectedVersion || recovery.state !== "retry_wait"
        || recovery.actionToken !== input.actionToken || recovery.currentJobVersion !== input.expectedVersion
        || recovery.nextAttemptAt === null || input.updatedAt < recovery.nextAttemptAt
        || input.updatedAt < current.updatedAt || input.updatedAt < recovery.updatedAt) conflict();
      const job = this.host.applyTransition({
        jobId: input.jobId,
        eventId: outcomeEventId("in_flight", input.actionToken, input.expectedVersion),
        expectedVersion: current.version,
        event: recoveryEvent(input.updatedAt, "TOPIC_RECOVERY_IN_FLIGHT"),
      });
      const update = this.host.statement(`UPDATE topic_recoveries SET state = 'in_flight',
        current_job_version = ?, next_attempt_at_ms = NULL, reason_code = NULL, updated_at_ms = ?
        WHERE job_id = ? AND action_token = ? AND state = 'retry_wait'
          AND current_job_version = ? AND next_attempt_at_ms <= ?
          AND new_message_thread_id IS NULL AND reason_code = 'TOPIC_RECOVERY_RATE_LIMITED'`).run(
        job.version, input.updatedAt, input.jobId, input.actionToken,
        input.expectedVersion, input.updatedAt,
      );
      if (update.changes !== 1) conflict();
      return { job, recovery: this.require(input.jobId) };
    }).immediate();
  }
  markUnknown(input: TopicRecoveryOutcomeInput): TelegramTopicRecoveryRecord {
    validateOutcomeInput(input, "TOPIC_RECOVERY_UNKNOWN");
    return this.transitionOutcome(input, "unknown", input.reasonCode, null);
  }
  fail(input: TopicRecoveryOutcomeInput): TelegramTopicRecoveryRecord {
    validateOutcomeInput(input, "TOPIC_RECOVERY_FAILED");
    return this.transitionOutcome(input, "failed", input.reasonCode, null);
  }
  complete(input: CompleteTopicRecoveryInput): TelegramTopicRecoveryCompletion {
    validateCompleteInput(input);
    return this.host.database.transaction(() => {
      const recovery = this.require(input.jobId);
      const current = this.host.getJob(input.jobId);
      if (!current || current.version !== input.expectedVersion
        || recovery.state !== "in_flight" || recovery.actionToken !== input.actionToken
        || recovery.currentJobVersion !== input.expectedVersion
        || input.target.chatId !== recovery.oldDestination.chatId
        || input.target.messageThreadId === recovery.oldDestination.messageThreadId
        || input.eventAt < current.updatedAt || input.eventAt < recovery.updatedAt) conflict();
      const candidate = this.eligiblePlan(current);
      if (!candidate || !same(candidate.oldDestination, recovery.oldDestination)) conflict();
      const source = this.canonicalSource(input.jobId);
      const rebound = new Map(candidate.parts.map((part) => [
        part.partKey,
        rebindTelegramTopicPayload(part.payload, recovery.oldDestination, input.target),
      ]));
      const anchorRebound = rebindTelegramTopicPayload(
        candidate.anchorPlan.payload,
        recovery.oldDestination,
        input.target,
      );
      const rows = this.host.listDeliveries(input.jobId);
      for (const row of rows) {
        const rewritten = row.partKey === "status-anchor" ? anchorRebound : rebound.get(row.partKey);
        if (!rewritten) conflict();
        const update = this.host.statement(`UPDATE deliveries SET
          state = ?, payload_json = ?, content_hash = ?, telegram_message_id = NULL,
          attempt_count = ?, next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
          WHERE job_id = ? AND part_key = ? AND ordinal = ? AND kind = ? AND state = ?
            AND payload_json = ? AND content_hash = ? AND telegram_message_id IS NULL
            AND attempt_count = ? AND next_attempt_at_ms IS ? AND last_error_code IS ?
            AND updated_at_ms = ?`).run(
          row.partKey === "status-anchor" ? "pending" : row.state,
          stringify(rewritten.payload), rewritten.contentHash, row.attemptCount, input.eventAt,
          row.jobId, row.partKey, row.ordinal, row.kind, row.state, stringify(row.payload),
          row.contentHash, row.attemptCount, row.nextAttemptAt, row.lastErrorCode, row.updatedAt,
        );
        if (update.changes !== 1) conflict();
      }
      const anchorPlan = this.statusAnchorPlan(input.jobId);
      const planUpdate = this.host.statement(`UPDATE status_anchor_plans
        SET payload_json = ?, content_hash = ?
        WHERE job_id = ? AND payload_json = ? AND content_hash = ?`).run(
        stringify(anchorRebound.payload), anchorRebound.contentHash, input.jobId,
        stringify(anchorPlan.payload), anchorPlan.contentHash,
      );
      if (planUpdate.changes !== 1) conflict();
      const sourceUpdate = this.host.statement(`UPDATE inbox_updates SET source_json = ?
        WHERE job_id = ? AND source_json = ?`).run(
        encodeCanonicalTopicRecoverySource({ ...source, targetContext: input.target }),
        input.jobId, encodeCanonicalTopicRecoverySource(source),
      );
      if (sourceUpdate.changes !== 1) conflict();
      const updatedRows = this.host.listDeliveries(input.jobId);
      const ordinary = updatedRows.filter((part) => part.partKey !== "status-anchor");
      const job = this.host.applyTransition({
        jobId: input.jobId,
        eventId: input.eventId,
        expectedVersion: current.version,
        event: {
          ...recoveryEvent(input.eventAt, null),
          deliveries: current.responsePlan?.map((planned) => {
            const row = ordinary.find((part) => part.partKey === planned.partId);
            if (!row) conflict();
            return projectDelivery(row);
          }),
        },
      });
      const recoveryUpdate = this.host.statement(`UPDATE topic_recoveries SET
        state = 'complete', new_message_thread_id = ?, current_job_version = ?,
        next_attempt_at_ms = NULL, reason_code = NULL, updated_at_ms = ?
        WHERE job_id = ? AND action_token = ? AND state = 'in_flight'
          AND current_job_version = ? AND new_message_thread_id IS NULL
          AND next_attempt_at_ms IS NULL AND reason_code IS NULL`).run(
        input.target.messageThreadId, job.version, input.eventAt, input.jobId,
        input.actionToken, input.expectedVersion,
      );
      if (recoveryUpdate.changes !== 1) conflict();
      const anchor = updatedRows.find((part) => part.partKey === "status-anchor");
      if (!anchor) conflict();
      return { job, recovery: this.require(input.jobId), anchor };
    }).immediate();
  }
  get(jobId: string): TelegramTopicRecoveryRecord | null {
    if (!nonEmpty(jobId)) return null;
    const row = this.raw(jobId);
    return row ? decodeRecovery(row) : null;
  }
  list(states: readonly TelegramTopicRecoveryState[], limit = DEFAULT_LIST_LIMIT): readonly TelegramTopicRecoveryRecord[] {
    if (states.length === 0 || states.length > 5 || new Set(states).size !== states.length
      || states.some((state) => !isState(state))) throw new Error("Invalid topic recovery states");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error("Invalid topic recovery list limit");
    }
    const placeholders = states.map(() => "?").join(", ");
    return (this.host.statement(`SELECT * FROM topic_recoveries WHERE state IN (${placeholders})
      ORDER BY updated_at_ms, job_id LIMIT ?`).all(...states, limit) as Record<string, unknown>[])
      .map(decodeRecovery);
  }
  private transitionOutcome(
    input: DeferTopicRecoveryInput | TopicRecoveryOutcomeInput,
    state: "retry_wait" | "unknown" | "failed",
    reasonCode: TelegramTopicRecoveryReasonCode,
    nextAttemptAt: number | null,
  ): TelegramTopicRecoveryRecord {
    return this.host.database.transaction(() => {
      const recovery = this.require(input.jobId);
      const current = this.host.getJob(input.jobId);
      if (!current || current.version !== input.expectedVersion || recovery.state !== "in_flight"
        || recovery.actionToken !== input.actionToken || recovery.currentJobVersion !== input.expectedVersion
        || input.updatedAt < current.updatedAt || input.updatedAt < recovery.updatedAt) conflict();
      const attentionCode = state === "retry_wait" ? "TOPIC_RECOVERY_RATE_LIMITED"
        : state === "unknown" ? "TOPIC_RECOVERY_UNKNOWN" : "TOPIC_RECOVERY_FAILED";
      const job = this.host.applyTransition({
        jobId: input.jobId,
        eventId: outcomeEventId(state, input.actionToken, input.expectedVersion),
        expectedVersion: current.version,
        event: recoveryEvent(input.updatedAt, attentionCode),
      });
      const update = this.host.statement(`UPDATE topic_recoveries SET state = ?, current_job_version = ?,
        next_attempt_at_ms = ?, reason_code = ?, updated_at_ms = ?
        WHERE job_id = ? AND action_token = ? AND state = 'in_flight'
          AND current_job_version = ? AND new_message_thread_id IS NULL
          AND next_attempt_at_ms IS NULL AND reason_code IS NULL`).run(
        state, job.version, nextAttemptAt, reasonCode, input.updatedAt,
        input.jobId, input.actionToken, input.expectedVersion,
      );
      if (update.changes !== 1) conflict();
      return this.require(input.jobId);
    }).immediate();
  }
  private eligiblePlan(job: TelegramJob): EligibleRecoveryPlan | null {
    try {
      const source = this.canonicalSource(job.id);
      const target = source.targetContext === undefined ? source : requiredRecord(
        source.targetContext, "Telegram topic recovery source conflict",
      );
      const oldDestination = {
        chatId: nonzeroInteger(target.chatId, "chatId"),
        messageThreadId: positiveInteger(target.messageThreadId, "messageThreadId"),
      };
      if (job.phase !== "delivering" || !job.threadId || job.responsePlan === undefined
        || source.botId !== job.source.botId || source.updateId !== job.source.updateId
        || Object.hasOwn(source, "targetProvision")
        || (source.targetContext !== undefined && target.chatId !== source.chatId)) return null;
      const rows = this.host.listDeliveries(job.id);
      const rawPayloads = this.rawDeliveryPayloads(job.id);
      const anchors = rows.filter((part) => part.partKey === "status-anchor");
      const ordinary = rows.filter((part) => part.partKey !== "status-anchor");
      const anchorPlan = this.statusAnchorPlanOrNull(job.id);
      if (anchors.length !== 1 || !anchorPlan || ordinary.length !== job.responsePlan.length
        || rows.length !== job.responsePlan.length + 1) return null;
      const anchor = anchors[0]!;
      const canonicalAnchor = canonicalPart(anchor, oldDestination, rawPayloads.get(anchor.partKey));
      if (anchor.jobId !== job.id || anchor.kind !== "status-anchor" || anchor.ordinal !== 0
        || anchor.state !== "failed" || anchor.telegramMessageId !== null
        || !canonicalAnchor || !same(anchor.payload, anchorPlan.payload)
        || anchor.contentHash !== anchorPlan.contentHash) return null;
      const parts = job.responsePlan.map((planned, ordinal) => {
        const matches = ordinary.filter((part) => part.partKey === planned.partId);
        const part = matches[0];
        if (matches.length !== 1 || !part || part.jobId !== job.id || part.kind !== planned.kind
          || part.ordinal !== ordinal || part.state !== "pending" || part.telegramMessageId !== null
          || part.attemptCount !== 0 || part.nextAttemptAt !== null || part.lastErrorCode !== null) conflict();
        const canonical = canonicalPart(part, oldDestination, rawPayloads.get(part.partKey));
        if (!canonical) conflict();
        return { partKey: part.partKey, ...canonical };
      });
      const projected = ordinaryFromPlan(job, ordinary);
      if (!same(job.deliveries, projected)) return null;
      return { oldDestination, parts, anchorPlan: { partKey: anchor.partKey, ...canonicalAnchor } };
    } catch { return null; }
  }
  private canonicalSource(jobId: string): Record<string, unknown> {
    const row = this.host.statement("SELECT source_json FROM inbox_updates WHERE job_id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) conflict();
    return decodeCanonicalTopicRecoverySourceJson(row.source_json);
  }
  private rawDeliveryPayloads(jobId: string): ReadonlyMap<string, string> {
    const rows = this.host.statement("SELECT part_key, payload_json FROM deliveries WHERE job_id = ?")
      .all(jobId) as Record<string, unknown>[];
    const result = new Map(rows.map((row) => [text(row.part_key), text(row.payload_json)]));
    if (result.size !== rows.length) conflict();
    return result;
  }
  private statusAnchorPlan(jobId: string): { readonly payload: unknown; readonly contentHash: string } {
    const plan = this.statusAnchorPlanOrNull(jobId);
    if (!plan) conflict();
    return plan;
  }
  private statusAnchorPlanOrNull(jobId: string): { readonly payload: unknown; readonly contentHash: string } | null {
    const row = this.host.statement(`SELECT payload_json, content_hash FROM status_anchor_plans
      WHERE job_id = ?`).get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      const payloadJson = text(row.payload_json);
      const payload = normalizeTelegramDeliveryPayload(JSON.parse(payloadJson));
      const contentHash = text(row.content_hash);
      if (payloadJson !== JSON.stringify(payload) || hashTelegramDeliveryPayload(payload) !== contentHash) throw new Error();
      return { payload, contentHash };
    } catch { throw new Error("Malformed Telegram status anchor plan"); }
  }
  private raw(jobId: string): Record<string, unknown> | undefined {
    return this.host.statement("SELECT * FROM topic_recoveries WHERE job_id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
  }
  private require(jobId: string): TelegramTopicRecoveryRecord {
    const row = this.raw(jobId);
    if (!row) throw new Error("Unknown Telegram topic recovery");
    return decodeRecovery(row);
  }
}
function decodeRecovery(row: Record<string, unknown>): TelegramTopicRecoveryRecord {
  try {
    const recovery: TelegramTopicRecoveryRecord = {
      jobId: bounded(row.job_id, "jobId", JOB_ID_MAX_LENGTH), actionToken: actionToken(row.action_token),
      state: state(row.state),
      oldDestination: {
        chatId: nonzeroInteger(row.old_chat_id, "oldChatId"),
        messageThreadId: positiveInteger(row.old_message_thread_id, "oldMessageThreadId"),
      },
      newMessageThreadId: nullablePositiveInteger(row.new_message_thread_id, "newMessageThreadId"),
      reservedJobVersion: positiveInteger(row.reserved_job_version, "reservedJobVersion"),
      currentJobVersion: positiveInteger(row.current_job_version, "currentJobVersion"),
      nextAttemptAt: nullableTimestamp(row.next_attempt_at_ms, "nextAttemptAt"),
      reasonCode: nullableRecoveryReason(row.reason_code),
      startedAt: timestamp(row.started_at_ms, "startedAt"), updatedAt: timestamp(row.updated_at_ms, "updatedAt"),
    };
    if (recovery.currentJobVersion <= recovery.reservedJobVersion || recovery.updatedAt < recovery.startedAt) invalidRow();
    if (recovery.state === "in_flight" && (recovery.newMessageThreadId !== null
      || recovery.nextAttemptAt !== null || recovery.reasonCode !== null)) invalidRow();
    if (recovery.state === "retry_wait" && (recovery.newMessageThreadId !== null
      || recovery.nextAttemptAt === null || recovery.nextAttemptAt <= recovery.updatedAt
      || recovery.reasonCode !== "TOPIC_RECOVERY_RATE_LIMITED")) invalidRow();
    if ((recovery.state === "unknown" || recovery.state === "failed") && (recovery.newMessageThreadId !== null
      || recovery.nextAttemptAt !== null || recovery.reasonCode !== (recovery.state === "unknown" ? "TOPIC_RECOVERY_UNKNOWN" : "TOPIC_RECOVERY_FAILED"))) invalidRow();
    if (recovery.state === "complete" && (recovery.newMessageThreadId === null
      || recovery.newMessageThreadId === recovery.oldDestination.messageThreadId
      || recovery.nextAttemptAt !== null || recovery.reasonCode !== null)) invalidRow();
    return structuredClone(recovery);
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed Telegram topic recovery") throw error;
    invalidRow();
  }
}
function sameCandidate(expected: TelegramTopicRecoveryCandidate, job: TelegramJob, actual: EligibleRecoveryPlan): boolean {
  return expected.jobId === job.id && expected.expectedVersion === job.version
    && expected.threadId === job.threadId && same(expected.oldDestination, actual.oldDestination)
    && same(expected.parts, actual.parts) && same(expected.anchorPlan, actual.anchorPlan);
}
function canonicalPart(
  part: DeliveryPart,
  destination: TelegramTopicDestination,
  payloadJson: string | undefined,
): { readonly payload: ReturnType<typeof rebindTelegramTopicPayload>["payload"]; readonly contentHash: string } | null {
  try {
    validateDelivery(part);
    const rebound = rebindTelegramTopicPayload(part.payload, destination, destination);
    return payloadJson === JSON.stringify(rebound.payload)
      && same(rebound.payload, part.payload) && rebound.contentHash === part.contentHash ? rebound : null;
  } catch { return null; }
}
function ordinaryFromPlan(job: TelegramJob, rows: readonly DeliveryPart[]) {
  return job.responsePlan?.map((planned) => {
    const row = rows.find((part) => part.partKey === planned.partId);
    if (!row) conflict();
    return projectDelivery(row);
  });
}
function recoveryEvent(eventAt: number, attentionCode: string | null):
Extract<TransitionEvent, { readonly type: "delivery.changed" }> {
  return {
    schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt,
    attention: attentionCode === null
      ? { kind: "none" }
      : { kind: "required", code: attentionCode, actions: ["inspect"] },
  };
}
function projectDelivery(part: DeliveryPart) {
  return {
    partId: part.partKey, state: part.state, attempts: part.attemptCount,
    messageId: part.telegramMessageId,
    deliveredAt: part.state === "delivered" ? part.updatedAt : null,
  };
}
function validateReserveInput(input: ReserveTopicRecoveryInput): void {
  const candidate = input.candidate;
  bounded(candidate.jobId, "jobId", JOB_ID_MAX_LENGTH); positiveInteger(candidate.expectedVersion, "expectedVersion");
  bounded(candidate.threadId, "threadId", JOB_ID_MAX_LENGTH); bounded(candidate.topicName, "topicName", TOPIC_NAME_MAX_LENGTH);
  destination(candidate.oldDestination); bounded(input.eventId, "eventId", EVENT_ID_MAX_LENGTH);
  actionToken(input.actionToken); timestamp(input.eventAt, "eventAt");
  if (candidate.parts.length === 0 || candidate.anchorPlan.partKey !== "status-anchor") {
    throw new Error("Invalid Telegram topic recovery candidate");
  }
}
function validateOutcomeBase(input: ResumeTopicRecoveryInput): void {
  bounded(input.jobId, "jobId", JOB_ID_MAX_LENGTH); positiveInteger(input.expectedVersion, "expectedVersion");
  actionToken(input.actionToken); timestamp(input.updatedAt, "updatedAt");
}
function validateOutcomeInput(input: TopicRecoveryOutcomeInput, expected: TelegramTopicRecoveryOutcomeReasonCode): void {
  validateOutcomeBase(input);
  if (input.reasonCode !== expected) throw new Error("Invalid topic recovery reason code");
}
function validateCompleteInput(input: CompleteTopicRecoveryInput): void {
  bounded(input.jobId, "jobId", JOB_ID_MAX_LENGTH); positiveInteger(input.expectedVersion, "expectedVersion");
  bounded(input.eventId, "eventId", EVENT_ID_MAX_LENGTH); actionToken(input.actionToken);
  destination(input.target); timestamp(input.eventAt, "eventAt");
}
function outcomeEventId(state: string, token: string, version: number): string {
  const digest = createHash("sha256").update(token).digest("hex");
  return `topic-recovery:${state}:${version}:${digest}`;
}
function destination(value: TelegramTopicDestination): void {
  nonzeroInteger(value.chatId, "chatId"); positiveInteger(value.messageThreadId, "messageThreadId");
}
function state(value: unknown): TelegramTopicRecoveryState { if (isState(value)) return value; invalidRow(); }
function isState(value: unknown): value is TelegramTopicRecoveryState {
  return value === "in_flight" || value === "retry_wait" || value === "unknown"
    || value === "complete" || value === "failed";
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
function nonzeroInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) throw new Error(`Invalid ${name}`);
  return value;
}
function timestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
function nullablePositiveInteger(value: unknown, name: string): number | null { return value === null ? null : positiveInteger(value, name); }
function nullableTimestamp(value: unknown, name: string): number | null { return value === null ? null : timestamp(value, name); }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid text"); return value; }
function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function actionToken(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid actionToken");
  return value;
}
function nullableRecoveryReason(value: unknown): TelegramTopicRecoveryReasonCode | null {
  if (value === null || value === "TOPIC_RECOVERY_RATE_LIMITED"
    || value === "TOPIC_RECOVERY_UNKNOWN" || value === "TOPIC_RECOVERY_FAILED") return value;
  invalidRow();
}
function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function stringify(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Invalid Telegram topic recovery value");
  return encoded;
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}
function conflict(): never { throw new Error("Telegram topic recovery conflict"); }
function invalidRow(): never { throw new Error("Malformed Telegram topic recovery"); }
