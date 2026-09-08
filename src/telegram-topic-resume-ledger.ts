import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type { CodexThreadRecord } from "./codex-state.js";
import type { DeliveryPart } from "./telegram-delivery-ledger.js";
import type { TelegramWorkSource } from "./telegram-job-ingress.js";
import type { TransitionEvent } from "./telegram-job-ledger.js";
import type { TelegramJob } from "./telegram-job-types.js";
import { hashTelegramDeliveryPayload, normalizeTelegramDeliveryPayload } from "./telegram-response-plan.js";
import type { TelegramTopicRecoveryRecord } from "./telegram-topic-recovery-ledger.js";
import { decodeCanonicalTopicRecoverySourceJson } from "./telegram-topic-recovery-source-codec.js";
import type { TelegramTopicDestination } from "./telegram-topic-recovery.js";
import { planTelegramTopicResume, type TelegramTopicResumeCandidate } from "./telegram-topic-resume.js";

const JOB_ID_MAX_LENGTH = 128;
const EVENT_ID_MAX_LENGTH = 128;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

export type TelegramTopicResumeState =
  | "probe_in_flight" | "probe_retry_wait"
  | "reopen_in_flight" | "reopen_retry_wait" | "reopen_unknown"
  | "delivery_handoff" | "complete" | "failed";

export type TelegramTopicResumeReasonCode =
  | "TOPIC_RESUME_PROBE_RATE_LIMITED"
  | "TOPIC_RESUME_PROBE_UNKNOWN"
  | "TOPIC_RESUME_REOPEN_RATE_LIMITED"
  | "TOPIC_RESUME_REOPEN_UNKNOWN"
  | "TOPIC_RESUME_SOURCE_MISSING"
  | "TOPIC_RESUME_REOPEN_FAILED"
  | "TOPIC_RESUME_DELIVERY_FAILED"
  | "TOPIC_RESUME_DELIVERY_UNCERTAIN";

export interface TelegramTopicResumeRecord {
  readonly jobId: string;
  readonly actionToken: string;
  readonly state: TelegramTopicResumeState;
  readonly destination: TelegramTopicDestination;
  readonly reservedJobVersion: number;
  readonly currentJobVersion: number;
  readonly nextAttemptAt: number | null;
  readonly reasonCode: TelegramTopicResumeReasonCode | null;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface TelegramTopicResumeResult {
  readonly job: TelegramJob;
  readonly resume: TelegramTopicResumeRecord;
}

export interface TelegramTopicResumeExternalEligibilitySnapshot {
  readonly thread: CodexThreadRecord | null; readonly forumChatId: number; readonly hasThreadTopicBinding: boolean;
}

export interface ReserveTopicResumeInput {
  readonly candidate: TelegramTopicResumeCandidate;
  readonly externalEligibilitySnapshot: TelegramTopicResumeExternalEligibilitySnapshot;
  readonly eventId: string;
  readonly actionToken: string;
  readonly eventAt: number;
}

export interface TransitionTopicResumeInput {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly actionToken: string;
  readonly expectedState: TelegramTopicResumeState;
  readonly state: TelegramTopicResumeState;
  readonly nextAttemptAt?: number | null;
  readonly reasonCode?: TelegramTopicResumeReasonCode | null;
  readonly updatedAt: number;
}

export interface SettleTopicResumeDeliveryInput {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly actionToken: string;
  readonly updatedAt: number;
}

interface TelegramTopicResumeLedgerHost {
  readonly database: Database.Database;
  readonly statement: (sql: string) => Database.Statement;
  readonly getJob: (jobId: string) => TelegramJob | null;
  readonly listDeliveries: (jobId: string) => readonly DeliveryPart[];
  readonly getTopicRecovery: (jobId: string) => TelegramTopicRecoveryRecord | null;
  readonly applyTransition: (input: {
    readonly jobId: string;
    readonly eventId: string;
    readonly expectedVersion: number;
    readonly event: TransitionEvent;
  }) => TelegramJob;
}

const LEGAL_TRANSITIONS: Readonly<Record<TelegramTopicResumeState, readonly TelegramTopicResumeState[]>> = {
  probe_in_flight: ["probe_retry_wait", "reopen_in_flight", "delivery_handoff", "failed"],
  probe_retry_wait: ["probe_in_flight"],
  reopen_in_flight: ["reopen_retry_wait", "reopen_unknown", "delivery_handoff", "failed"],
  reopen_retry_wait: ["reopen_in_flight"],
  reopen_unknown: ["reopen_unknown", "delivery_handoff"],
  delivery_handoff: [],
  complete: [],
  failed: [],
};

export class TelegramTopicResumeLedger {
  constructor(private readonly host: TelegramTopicResumeLedgerHost) {}

  reserve(input: ReserveTopicResumeInput): TelegramTopicResumeResult {
    validateReserveInput(input);
    return this.host.database.transaction(() => {
      if (this.raw(input.candidate.jobId)) conflict();
      const job = this.host.getJob(input.candidate.jobId);
      if (!job || job.version !== input.candidate.expectedVersion) conflict();
      const candidate = this.eligibleCandidate(job, input.externalEligibilitySnapshot);
      if (!candidate || !same(candidate, input.candidate)) conflict();
      const advanced = this.host.applyTransition({
        jobId: job.id,
        eventId: input.eventId,
        expectedVersion: job.version,
        event: resumeEvent(input.eventAt, "TOPIC_RESUME_PROBE_IN_FLIGHT"),
      });
      const inserted = this.host.statement(`INSERT INTO topic_resume_attempts
        (job_id, action_token, state, chat_id, message_thread_id,
          reserved_job_version, current_job_version, next_attempt_at_ms,
          reason_code, started_at_ms, updated_at_ms)
        VALUES (?, ?, 'probe_in_flight', ?, ?, ?, ?, NULL, NULL, ?, ?)`).run(
        job.id, input.actionToken, candidate.destination.chatId, candidate.destination.messageThreadId,
        job.version, advanced.version, input.eventAt, input.eventAt,
      );
      if (inserted.changes !== 1) conflict();
      return { job: advanced, resume: this.require(job.id) };
    }).immediate();
  }

  transition(input: TransitionTopicResumeInput): TelegramTopicResumeResult {
    validateTransitionInput(input);
    const nextAttemptAt = input.nextAttemptAt ?? null;
    const reasonCode = input.reasonCode ?? null;
    return this.host.database.transaction(() => {
      const resume = this.require(input.jobId);
      const job = this.host.getJob(input.jobId);
      if (!job || job.version !== input.expectedVersion || resume.currentJobVersion !== input.expectedVersion
        || resume.actionToken !== input.actionToken || resume.state !== input.expectedState
        || !LEGAL_TRANSITIONS[resume.state].includes(input.state)
        || input.updatedAt < job.updatedAt || input.updatedAt < resume.updatedAt) conflict();
      if ((resume.state === "probe_retry_wait" || resume.state === "reopen_retry_wait")
        && (resume.nextAttemptAt === null || input.updatedAt < resume.nextAttemptAt)) conflict();
      if (resume.state === "reopen_unknown" && resume.nextAttemptAt !== null
        && input.updatedAt < resume.nextAttemptAt) conflict();
      validateTransitionShape(resume.state, input.state, reasonCode, nextAttemptAt, input.updatedAt);
      const advanced = this.host.applyTransition({
        jobId: input.jobId,
        eventId: transitionEventId(input.state, input.actionToken, input.expectedVersion),
        expectedVersion: job.version,
        event: resumeEvent(input.updatedAt, attentionCode(input.state, reasonCode)),
      });
      const updated = this.host.statement(`UPDATE topic_resume_attempts SET
        state = ?, current_job_version = ?, next_attempt_at_ms = ?, reason_code = ?, updated_at_ms = ?
        WHERE job_id = ? AND action_token = ? AND state = ? AND current_job_version = ?
          AND next_attempt_at_ms IS ? AND reason_code IS ?`).run(
        input.state, advanced.version, nextAttemptAt, reasonCode, input.updatedAt,
        input.jobId, input.actionToken, input.expectedState, input.expectedVersion,
        resume.nextAttemptAt, resume.reasonCode,
      );
      if (updated.changes !== 1) conflict();
      return { job: advanced, resume: this.require(input.jobId) };
    }).immediate();
  }

  settleDelivery(input: SettleTopicResumeDeliveryInput): TelegramTopicResumeRecord {
    validateSettleInput(input);
    return this.host.database.transaction(() => {
      const resume = this.require(input.jobId);
      const job = this.host.getJob(input.jobId);
      if (!job || job.version !== input.expectedVersion || resume.state !== "delivery_handoff"
        || resume.actionToken !== input.actionToken || job.version < resume.currentJobVersion
        || input.updatedAt < job.updatedAt || input.updatedAt < resume.updatedAt) conflict();
      const rows = this.host.listDeliveries(input.jobId);
      const anchors = rows.filter((part) => part.partKey === "status-anchor");
      if (anchors.length !== 1) conflict();
      const anchor = anchors[0]!;
      let state: "complete" | "failed" | null = null;
      let reasonCode: TelegramTopicResumeReasonCode | null = null;
      if (anchor.state === "failed" && anchor.updatedAt > resume.updatedAt) {
        state = "failed";
        reasonCode = "TOPIC_RESUME_DELIVERY_FAILED";
      } else if (anchor.state === "uncertain" && anchor.updatedAt > resume.updatedAt) {
        state = "failed";
        reasonCode = "TOPIC_RESUME_DELIVERY_UNCERTAIN";
      } else if (job.phase === "terminal" && job.outcome === "completed" && rows.length === 3
        && rows.every((part) => part.state === "delivered") && anchor.telegramMessageId !== null) {
        state = "complete";
      }
      if (state === null) return resume;
      const updated = this.host.statement(`UPDATE topic_resume_attempts SET state = ?,
        current_job_version = ?, next_attempt_at_ms = NULL, reason_code = ?, updated_at_ms = ?
        WHERE job_id = ? AND action_token = ? AND state = 'delivery_handoff'
          AND current_job_version = ? AND next_attempt_at_ms IS NULL AND reason_code IS NULL`).run(
        state, job.version, reasonCode, input.updatedAt, input.jobId, input.actionToken,
        resume.currentJobVersion,
      );
      if (updated.changes !== 1) conflict();
      return this.require(input.jobId);
    }).immediate();
  }

  get(jobId: string): TelegramTopicResumeRecord | null {
    if (!nonEmpty(jobId)) return null;
    const row = this.raw(jobId);
    return row ? decodeResume(row) : null;
  }

  list(states: readonly TelegramTopicResumeState[], limit = DEFAULT_LIST_LIMIT): readonly TelegramTopicResumeRecord[] {
    if (states.length === 0 || states.length > Object.keys(LEGAL_TRANSITIONS).length
      || new Set(states).size !== states.length || states.some((state) => !isState(state))) {
      throw new Error("Invalid topic resume states");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error("Invalid topic resume list limit");
    }
    const placeholders = states.map(() => "?").join(", ");
    return (this.host.statement(`SELECT * FROM topic_resume_attempts WHERE state IN (${placeholders})
      ORDER BY updated_at_ms, job_id LIMIT ?`).all(...states, limit) as Record<string, unknown>[])
      .map(decodeResume);
  }

  getStatusAnchorPlan(jobId: string): { readonly payload: unknown; readonly contentHash: string } | null {
    bounded(jobId, "jobId", JOB_ID_MAX_LENGTH);
    const row = this.host.statement(`SELECT payload_json, content_hash FROM status_anchor_plans
      WHERE job_id = ?`).get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      const payloadJson = text(row.payload_json);
      const payload = normalizeTelegramDeliveryPayload(JSON.parse(payloadJson));
      const contentHash = text(row.content_hash);
      if (payloadJson !== JSON.stringify(payload) || hashTelegramDeliveryPayload(payload) !== contentHash) throw new Error();
      return structuredClone({ payload, contentHash });
    } catch {
      throw new Error("Malformed Telegram status anchor plan");
    }
  }

  hasJobQuarantine(jobId: string): boolean {
    bounded(jobId, "jobId", JOB_ID_MAX_LENGTH);
    return this.host.statement("SELECT 1 FROM job_quarantine WHERE job_id = ?").get(jobId) !== undefined;
  }

  private eligibleCandidate(
    job: TelegramJob,
    external: TelegramTopicResumeExternalEligibilitySnapshot,
  ): TelegramTopicResumeCandidate | null {
    const sourceRow = this.host.statement("SELECT source_json FROM inbox_updates WHERE job_id = ?")
      .get(job.id) as Record<string, unknown> | undefined;
    if (!sourceRow) return null;
    let source: TelegramWorkSource;
    try {
      source = decodeCanonicalTopicRecoverySourceJson(sourceRow.source_json) as unknown as TelegramWorkSource;
    } catch {
      return null;
    }
    let deliveries: readonly DeliveryPart[];
    try {
      deliveries = this.host.listDeliveries(job.id);
    } catch (error) {
      if (hasMessage(error, "Malformed Telegram delivery part")) return null;
      throw error;
    }
    const rawRows = this.host.statement("SELECT part_key, payload_json FROM deliveries WHERE job_id = ?")
      .all(job.id) as Record<string, unknown>[];
    try {
      const rawPayloads = new Map(rawRows.map((row) => [text(row.part_key), text(row.payload_json)]));
      if (rawPayloads.size !== rawRows.length || deliveries.some((part) => {
        const normalized = normalizeTelegramDeliveryPayload(part.payload);
        return rawPayloads.get(part.partKey) !== JSON.stringify(normalized);
      })) return null;
    } catch {
      return null;
    }
    let recovery: TelegramTopicRecoveryRecord | null;
    try {
      recovery = this.host.getTopicRecovery(job.id);
    } catch (error) {
      if (hasMessage(error, "Malformed Telegram topic recovery")) return null;
      throw error;
    }
    let anchorPlan: { readonly payload: unknown; readonly contentHash: string } | null;
    try {
      anchorPlan = this.getStatusAnchorPlan(job.id);
    } catch (error) {
      if (hasMessage(error, "Malformed Telegram status anchor plan")) return null;
      throw error;
    }
    return planTelegramTopicResume({
      job, source, deliveries, anchorPlan, recovery,
      thread: external.thread,
      hasExistingAttempt: false,
      forumChatId: external.forumChatId,
      hasThreadTopicBinding: external.hasThreadTopicBinding,
      quarantined: this.hasJobQuarantine(job.id),
    });
  }

  private raw(jobId: string): Record<string, unknown> | undefined {
    return this.host.statement("SELECT * FROM topic_resume_attempts WHERE job_id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
  }

  private require(jobId: string): TelegramTopicResumeRecord {
    const row = this.raw(jobId);
    if (!row) throw new Error("Unknown Telegram topic resume");
    return decodeResume(row);
  }
}

function decodeResume(row: Record<string, unknown>): TelegramTopicResumeRecord {
  try {
    const resume: TelegramTopicResumeRecord = {
      jobId: bounded(row.job_id, "jobId", JOB_ID_MAX_LENGTH),
      actionToken: actionToken(row.action_token),
      state: state(row.state),
      destination: {
        chatId: nonzeroInteger(row.chat_id, "chatId"),
        messageThreadId: positiveInteger(row.message_thread_id, "messageThreadId"),
      },
      reservedJobVersion: positiveInteger(row.reserved_job_version, "reservedJobVersion"),
      currentJobVersion: positiveInteger(row.current_job_version, "currentJobVersion"),
      nextAttemptAt: nullableTimestamp(row.next_attempt_at_ms, "nextAttemptAt"),
      reasonCode: nullableReason(row.reason_code),
      startedAt: timestamp(row.started_at_ms, "startedAt"),
      updatedAt: timestamp(row.updated_at_ms, "updatedAt"),
    };
    if (resume.currentJobVersion <= resume.reservedJobVersion || resume.updatedAt < resume.startedAt) invalidRow();
    validateRecordShape(resume);
    return structuredClone(resume);
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed Telegram topic resume") throw error;
    return invalidRow();
  }
}

function validateRecordShape(resume: TelegramTopicResumeRecord): void {
  const noOutcome = resume.nextAttemptAt === null && resume.reasonCode === null;
  if (resume.state === "probe_retry_wait") {
    if (resume.reasonCode !== "TOPIC_RESUME_PROBE_RATE_LIMITED" || resume.nextAttemptAt === null
      || resume.nextAttemptAt <= resume.updatedAt) invalidRow();
  } else if (resume.state === "reopen_retry_wait") {
    if (resume.reasonCode !== "TOPIC_RESUME_REOPEN_RATE_LIMITED" || resume.nextAttemptAt === null
      || resume.nextAttemptAt <= resume.updatedAt) invalidRow();
  } else if (resume.state === "reopen_unknown") {
    const ambiguous = resume.reasonCode === "TOPIC_RESUME_REOPEN_UNKNOWN" && resume.nextAttemptAt === null;
    const rateLimited = resume.reasonCode === "TOPIC_RESUME_PROBE_RATE_LIMITED"
      && resume.nextAttemptAt !== null && resume.nextAttemptAt > resume.updatedAt;
    if (!ambiguous && !rateLimited) invalidRow();
  } else if (resume.state === "failed") {
    if (resume.nextAttemptAt !== null || !FAILED_REASONS.has(resume.reasonCode as TelegramTopicResumeReasonCode)) invalidRow();
  } else if (!noOutcome) invalidRow();
}

const FAILED_REASONS = new Set<TelegramTopicResumeReasonCode>([
  "TOPIC_RESUME_PROBE_UNKNOWN", "TOPIC_RESUME_SOURCE_MISSING", "TOPIC_RESUME_REOPEN_FAILED",
  "TOPIC_RESUME_DELIVERY_FAILED", "TOPIC_RESUME_DELIVERY_UNCERTAIN",
]);

function validateReserveInput(input: ReserveTopicResumeInput): void {
  bounded(input.candidate.jobId, "jobId", JOB_ID_MAX_LENGTH);
  positiveInteger(input.candidate.expectedVersion, "expectedVersion");
  bounded(input.candidate.threadId, "threadId", JOB_ID_MAX_LENGTH);
  if (input.candidate.anchorPartKey !== "status-anchor"
    || !Number.isSafeInteger(input.candidate.anchorAttemptCount) || input.candidate.anchorAttemptCount < 1) {
    throw new Error("Invalid Telegram topic resume candidate");
  }
  destination(input.candidate.destination);
  if (!input.externalEligibilitySnapshot || typeof input.externalEligibilitySnapshot !== "object"
    || (input.externalEligibilitySnapshot.thread !== null
      && typeof input.externalEligibilitySnapshot.thread !== "object")
    || typeof input.externalEligibilitySnapshot.hasThreadTopicBinding !== "boolean") {
    throw new Error("Invalid Telegram topic resume external eligibility snapshot");
  }
  nonzeroInteger(input.externalEligibilitySnapshot.forumChatId, "forumChatId");
  bounded(input.eventId, "eventId", EVENT_ID_MAX_LENGTH);
  actionToken(input.actionToken);
  timestamp(input.eventAt, "eventAt");
}

function validateTransitionInput(input: TransitionTopicResumeInput): void {
  bounded(input.jobId, "jobId", JOB_ID_MAX_LENGTH);
  positiveInteger(input.expectedVersion, "expectedVersion");
  actionToken(input.actionToken);
  if (!isState(input.expectedState) || !isState(input.state)) throw new Error("Invalid topic resume state");
  if (input.reasonCode !== undefined && input.reasonCode !== null && !isReason(input.reasonCode)) {
    throw new Error("Invalid topic resume reason code");
  }
  if (input.nextAttemptAt !== undefined && input.nextAttemptAt !== null) timestamp(input.nextAttemptAt, "nextAttemptAt");
  timestamp(input.updatedAt, "updatedAt");
}

function validateTransitionShape(
  from: TelegramTopicResumeState,
  to: TelegramTopicResumeState,
  reason: TelegramTopicResumeReasonCode | null,
  deadline: number | null,
  updatedAt: number,
): void {
  if (to === "probe_retry_wait") {
    if (reason !== "TOPIC_RESUME_PROBE_RATE_LIMITED" || deadline === null || deadline <= updatedAt) conflict();
  } else if (to === "reopen_retry_wait") {
    if (reason !== "TOPIC_RESUME_REOPEN_RATE_LIMITED" || deadline === null || deadline <= updatedAt) conflict();
  } else if (to === "reopen_unknown") {
    const initial = from === "reopen_in_flight" && reason === "TOPIC_RESUME_REOPEN_UNKNOWN" && deadline === null;
    const safeProbe429 = from === "reopen_unknown" && reason === "TOPIC_RESUME_PROBE_RATE_LIMITED"
      && deadline !== null && deadline > updatedAt;
    if (!initial && !safeProbe429) conflict();
  } else if (to === "failed") {
    const probeFailure = from === "probe_in_flight"
      && (reason === "TOPIC_RESUME_PROBE_UNKNOWN" || reason === "TOPIC_RESUME_SOURCE_MISSING");
    const reopenFailure = from === "reopen_in_flight" && reason === "TOPIC_RESUME_REOPEN_FAILED";
    if ((!probeFailure && !reopenFailure) || deadline !== null) conflict();
  } else if (reason !== null || deadline !== null) conflict();
}

function validateSettleInput(input: SettleTopicResumeDeliveryInput): void {
  bounded(input.jobId, "jobId", JOB_ID_MAX_LENGTH);
  positiveInteger(input.expectedVersion, "expectedVersion");
  actionToken(input.actionToken);
  timestamp(input.updatedAt, "updatedAt");
}

function resumeEvent(eventAt: number, code: string | null): Extract<TransitionEvent, { readonly type: "delivery.changed" }> {
  return {
    schemaVersion: 1,
    type: "delivery.changed",
    phase: "delivering",
    eventAt,
    attention: code === null ? { kind: "none" } : { kind: "required", code, actions: ["inspect"] },
  };
}

function attentionCode(state: TelegramTopicResumeState, reason: TelegramTopicResumeReasonCode | null): string | null {
  if (state === "probe_in_flight") return "TOPIC_RESUME_PROBE_IN_FLIGHT";
  if (state === "reopen_in_flight") return "TOPIC_RESUME_REOPEN_IN_FLIGHT";
  if (state === "delivery_handoff") return null;
  return reason;
}

function transitionEventId(state: string, token: string, version: number): string {
  const digest = createHash("sha256").update(token).digest("hex");
  return `topic-resume:${state}:${version}:${digest}`;
}

function destination(value: TelegramTopicDestination): void {
  nonzeroInteger(value.chatId, "chatId");
  positiveInteger(value.messageThreadId, "messageThreadId");
}
function isState(value: unknown): value is TelegramTopicResumeState { return Object.hasOwn(LEGAL_TRANSITIONS, String(value)); }
function state(value: unknown): TelegramTopicResumeState { if (isState(value)) return value; return invalidRow(); }
function isReason(value: unknown): value is TelegramTopicResumeReasonCode {
  return value === "TOPIC_RESUME_PROBE_RATE_LIMITED" || value === "TOPIC_RESUME_PROBE_UNKNOWN"
    || value === "TOPIC_RESUME_REOPEN_RATE_LIMITED" || value === "TOPIC_RESUME_REOPEN_UNKNOWN"
    || value === "TOPIC_RESUME_SOURCE_MISSING" || value === "TOPIC_RESUME_REOPEN_FAILED"
    || value === "TOPIC_RESUME_DELIVERY_FAILED" || value === "TOPIC_RESUME_DELIVERY_UNCERTAIN";
}
function nullableReason(value: unknown): TelegramTopicResumeReasonCode | null {
  if (value === null || isReason(value)) return value;
  return invalidRow();
}
function actionToken(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid actionToken");
  return value;
}
function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
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
function nullableTimestamp(value: unknown, name: string): number | null {
  return value === null ? null : timestamp(value, name);
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid text"); return value; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function hasMessage(error: unknown, message: string): boolean { return error instanceof Error && error.message === message; }
function conflict(): never { throw new Error("Telegram topic resume conflict"); }
function invalidRow(): never { throw new Error("Malformed Telegram topic resume"); }
