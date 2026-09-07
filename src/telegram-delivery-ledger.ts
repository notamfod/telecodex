import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type { TransitionEvent } from "./telegram-job-ledger.js";
import { TelegramDeliveryReplan } from "./telegram-delivery-replan.js";
import type {
  ReplanRichDeliveryInput,
  ReplanRichDeliveryResult,
} from "./telegram-delivery-replan.js";
import {
  buildTelegramResponsePlan,
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
} from "./telegram-response-plan.js";
import {
  prepareStatusAnchorPayload,
  reconcilePlannedStatusAnchor,
  replaceMissingStatusAnchorEditValues,
  statusAnchorFinishValues,
} from "./telegram-status-anchor-ledger.js";
import type {
  FinishStatusAnchorRevisionInput,
  PrepareStatusAnchorRevisionInput,
  PrepareStatusAnchorRevisionResult,
  ReplaceMissingStatusAnchorEditInput,
} from "./telegram-status-anchor-ledger.js";
import type {
  DeliveryState, JobAttention, TelegramJob, TelegramDeliveryPart, TelegramResponsePlanPart,
} from "./telegram-job-types.js";

const JOB_ID_MAX_LENGTH = 128;
const EVENT_ID_MAX_LENGTH = 128;
const PART_KEY_MAX_LENGTH = 256;
const DELIVERY_TEXT_MAX_LENGTH = 128;

export interface DeliveryPart {
  readonly jobId: string; readonly partKey: string; readonly ordinal: number; readonly kind: string; readonly state: DeliveryState;
  readonly payload: unknown; readonly contentHash: string; readonly telegramMessageId: number | null; readonly attemptCount: number;
  readonly nextAttemptAt: number | null; readonly lastErrorCode: string | null; readonly updatedAt: number;
}
export interface NewDeliveryPart extends Omit<DeliveryPart, "telegramMessageId" | "attemptCount" | "nextAttemptAt" | "lastErrorCode"> {
  readonly telegramMessageId?: number | null; readonly attemptCount?: number; readonly nextAttemptAt?: number | null; readonly lastErrorCode?: string | null;
}
export interface DeliveryTransitionInput {
  readonly jobId: string; readonly partKey: string; readonly state: DeliveryState; readonly attemptCount: number;
  readonly telegramMessageId?: number | null; readonly nextAttemptAt?: number | null; readonly lastErrorCode?: string | null; readonly updatedAt: number;
}
export interface InstallDeliveryPlanInput {
  readonly jobId: string; readonly eventId: string; readonly expectedVersion: number; readonly eventAt: number;
  readonly responsePlan: readonly TelegramResponsePlanPart[]; readonly parts: readonly NewDeliveryPart[];
}
export interface InstallLiveCommentaryInput {
  readonly jobId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly expectedVersion: number;
  readonly eventAt: number;
  readonly parts: readonly NewDeliveryPart[];
}
export interface FinalizeDeliveredPlanInput {
  readonly jobId: string; readonly eventId: string; readonly expectedVersion: number; readonly eventAt: number;
}
export interface DeliveryCompletionScanCursor { readonly acceptedAt: number; readonly jobId: string; }
export interface DeliveryCompletionScanInput {
  readonly limit: number; readonly cursor?: DeliveryCompletionScanCursor;
}
export interface DeliveryCompletionCandidate {
  readonly jobId: string; readonly expectedVersion: number; readonly updatedAt: number;
}
export interface DeliveryCompletionScanResult {
  readonly candidates: readonly DeliveryCompletionCandidate[];
  readonly nextCursor: DeliveryCompletionScanCursor | null;
}
export interface ProjectedDeliveryTransitionInput extends DeliveryTransitionInput {
  readonly eventId: string; readonly expectedJobVersion: number;
  readonly expectedState: DeliveryState; readonly expectedAttemptCount: number;
  readonly expectedContentHash?: string;
  readonly attention?: JobAttention;
  readonly allowUncertainRetry?: boolean;
  readonly allowFailedRetry?: boolean;
  readonly allowPendingFailure?: boolean;
}
export interface ProjectedDeliveryTransitionResult { readonly delivery: DeliveryPart; readonly job: TelegramJob; }
export type { FinishStatusAnchorRevisionInput, PrepareStatusAnchorRevisionInput,
  PrepareStatusAnchorRevisionResult, ReplaceMissingStatusAnchorEditInput } from "./telegram-status-anchor-ledger.js";
export interface TelegramDeliverySummary {
  readonly total: number; readonly pending: number; readonly sending: number;
  readonly delivered: number; readonly uncertain: number; readonly failed: number;
}

interface StatusAnchorPlan {
  readonly jobId: string;
  readonly payload: TelegramDeliveryPayload;
  readonly contentHash: string;
  readonly installedAt: number;
}

interface DeliveryLedgerHost {
  readonly database: Database.Database;
  readonly statement: (sql: string) => Database.Statement;
  readonly getJob: (jobId: string) => TelegramJob | null;
  readonly readSourcePayload: (jobId: string) => unknown | null;
  readonly applyTransition: (input: {
    readonly jobId: string; readonly eventId: string; readonly expectedVersion: number; readonly event: TransitionEvent;
  }) => TelegramJob;
}

export class TelegramDeliveryLedger {
  private readonly replan: TelegramDeliveryReplan;

  constructor(private readonly host: DeliveryLedgerHost) {
    this.replan = new TelegramDeliveryReplan({
      database: host.database,
      statement: host.statement,
      getJob: host.getJob,
      applyReplanTransition: host.applyTransition,
    });
  }

  replaceRejectedRichDelivery(input: ReplanRichDeliveryInput): ReplanRichDeliveryResult {
    return this.replan.replace(input);
  }

  insert(input: NewDeliveryPart): DeliveryPart {
    validateDelivery(input);
    this.host.statement(`INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json,
      content_hash, telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.jobId, input.partKey, input.ordinal, input.kind, input.state, stringify(input.payload, "delivery payload"),
      input.contentHash, input.telegramMessageId ?? null, input.attemptCount ?? 0, input.nextAttemptAt ?? null,
      input.lastErrorCode ?? null, input.updatedAt,
    );
    return this.require(input.jobId, input.partKey);
  }

  transition(input: DeliveryTransitionInput): DeliveryPart {
    validateDeliveryTransition(input);
    return this.host.database.transaction(() => {
      const current = this.require(input.jobId, input.partKey);
      if (input.attemptCount < current.attemptCount || input.updatedAt < current.updatedAt) {
        throw new Error("Telegram delivery cannot move backwards");
      }
      return this.update(input, current);
    }).immediate();
  }
  prepareStatusAnchorRevision(input: PrepareStatusAnchorRevisionInput): PrepareStatusAnchorRevisionResult {
    return this.host.database.transaction(() => {
      const job = this.host.getJob(input.jobId);
      if (!job || job.version !== input.expectedJobVersion) throw new Error("Telegram job version conflict");
      const current = this.requireStatusAnchor(input.jobId);
      const revision = prepareStatusAnchorPayload(input, current);
      if (current.state !== input.expectedState || current.attemptCount !== input.expectedAttemptCount) {
        throw new Error("Telegram delivery conflict");
      }
      if (input.updatedAt < current.updatedAt) throw new Error("Telegram delivery cannot move backwards");
      if (revision.unchanged) return { kind: "unchanged" as const, delivery: current };
      if (current.state === "sending" && (current.telegramMessageId === null
        || current.nextAttemptAt === null || current.nextAttemptAt > input.updatedAt)) {
        if (current.telegramMessageId !== null) throw new Error("Telegram status anchor lease is active");
        throw new Error("Telegram delivery conflict");
      }
      if (current.state === "sending" && current.nextAttemptAt !== null
        && input.nextAttemptAt <= current.nextAttemptAt) {
        throw new Error("Telegram delivery conflict");
      }
      const update = this.host.statement(`UPDATE deliveries SET state = 'sending', payload_json = ?, content_hash = ?,
        next_attempt_at_ms = ?, last_error_code = NULL, updated_at_ms = ?
        WHERE job_id = ? AND part_key = 'status-anchor' AND state = ? AND attempt_count = ? AND content_hash = ?`).run(
        stringify(revision.payload, "delivery payload"), revision.contentHash, input.nextAttemptAt, input.updatedAt,
        input.jobId, current.state, current.attemptCount, current.contentHash,
      );
      if (update.changes !== 1) throw new Error("Telegram delivery conflict");
      return { kind: "prepared" as const, delivery: this.requireStatusAnchor(input.jobId) };
    }).immediate();
  }
  finishStatusAnchorRevision(input: FinishStatusAnchorRevisionInput): DeliveryPart {
    return this.host.database.transaction(() => {
      const current = this.requireStatusAnchor(input.jobId);
      if (current.state !== "sending" || current.attemptCount !== input.expectedAttemptCount
        || current.contentHash !== input.expectedContentHash
        || current.nextAttemptAt !== input.expectedLeaseUntil) throw new Error("Telegram delivery conflict");
      if (input.updatedAt < current.updatedAt) throw new Error("Telegram delivery cannot move backwards");
      const finish = statusAnchorFinishValues(input, current);
      const update = this.host.statement(`UPDATE deliveries SET state = ?, telegram_message_id = ?, attempt_count = ?,
        next_attempt_at_ms = ?, last_error_code = ?, updated_at_ms = ?
        WHERE job_id = ? AND part_key = 'status-anchor' AND state = 'sending'
          AND attempt_count = ? AND content_hash = ? AND next_attempt_at_ms = ?`).run(
        input.state, finish.telegramMessageId, input.attemptCount, finish.nextAttemptAt, finish.lastErrorCode,
        input.updatedAt, input.jobId, input.expectedAttemptCount, input.expectedContentHash,
        input.expectedLeaseUntil,
      );
      if (update.changes !== 1) throw new Error("Telegram delivery conflict");
      return this.requireStatusAnchor(input.jobId);
    }).immediate();
  }
  replaceMissingStatusAnchorEdit(input: ReplaceMissingStatusAnchorEditInput): DeliveryPart {
    return this.host.database.transaction(() => {
      const job = this.host.getJob(input.jobId);
      if (!job) throw new Error("Unknown Telegram job");
      const current = this.requireStatusAnchor(input.jobId);
      const replacement = replaceMissingStatusAnchorEditValues(input, current);
      const currentPayloadJson = stringify(replacement.currentPayload, "delivery payload");
      const replacementPayloadJson = stringify(replacement.payload, "delivery payload");
      const storedPlanRow = this.host.statement(`SELECT 1 FROM status_anchor_plans WHERE job_id = ?`)
        .get(input.jobId);
      if (job.responsePlan === undefined) {
        if (storedPlanRow) throw new Error("Telegram response plan conflict");
      } else {
        const storedPlan = this.statusAnchorPlan(input.jobId);
        if (!storedPlan || storedPlan.contentHash !== current.contentHash
          || !same(storedPlan.payload, replacement.currentPayload)) {
          throw new Error("Telegram response plan conflict");
        }
        const planUpdate = this.host.statement(`UPDATE status_anchor_plans
          SET payload_json = ?, content_hash = ?
          WHERE job_id = ? AND payload_json = ? AND content_hash = ?`).run(
          replacementPayloadJson, replacement.contentHash, input.jobId,
          currentPayloadJson, current.contentHash,
        );
        if (planUpdate.changes !== 1) throw new Error("Telegram response plan conflict");
      }
      const deliveryUpdate = this.host.statement(`UPDATE deliveries
        SET state = 'pending', payload_json = ?, content_hash = ?, telegram_message_id = NULL,
          attempt_count = ?, next_attempt_at_ms = ?,
          last_error_code = 'telegram_status_message_missing', updated_at_ms = ?
        WHERE job_id = ? AND part_key = 'status-anchor' AND kind = 'status-anchor' AND ordinal = 0
          AND state = 'sending' AND attempt_count = ? AND content_hash = ?
          AND next_attempt_at_ms = ? AND telegram_message_id = ? AND payload_json = ?`).run(
        replacementPayloadJson, replacement.contentHash, replacement.attemptCount,
        input.updatedAt, input.updatedAt, input.jobId, input.expectedAttemptCount,
        input.expectedContentHash, input.expectedLeaseUntil, input.expectedMessageId,
        currentPayloadJson,
      );
      if (deliveryUpdate.changes !== 1) throw new Error("Telegram delivery conflict");
      return this.requireStatusAnchor(input.jobId);
    }).immediate();
  }
  installPlan(input: InstallDeliveryPlanInput): TelegramJob {
    validatePlanInput(input);
    return this.host.database.transaction(() => {
      const current = this.host.getJob(input.jobId);
      if (!current) throw new Error("Unknown Telegram job");
      const parts = this.reconcileStatusAnchor(input.parts);
      if (current.responsePlan !== undefined) {
        if (!same(current.responsePlan, input.responsePlan) || !samePlanRows(this.list(input.jobId), parts)) {
          throw new Error("Telegram response plan conflict");
        }
        return current;
      }
      if (current.version !== input.expectedVersion || current.phase !== "delivering" || !current.turnResult) {
        throw new Error("Telegram job version conflict");
      }
      this.installStatusAnchorPlan(parts.find((part) => part.partKey === "status-anchor")!, input.eventAt);
      for (const part of parts) this.upsertPlanned(part);
      const rows = this.list(input.jobId);
      const projected = input.responsePlan.map((planned) => {
        const row = rows.find((candidate) => candidate.partKey === planned.partId);
        if (!row) throw new Error("Telegram response plan conflict");
        return projectDelivery(row);
      });
      return this.host.applyTransition({
        jobId: input.jobId, eventId: input.eventId, expectedVersion: current.version,
        event: { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: input.eventAt,
          responsePlan: input.responsePlan, deliveries: projected },
      });
    }).immediate();
  }
  installLiveCommentary(input: InstallLiveCommentaryInput): TelegramJob {
    validateLiveCommentaryInput(input);
    return this.host.database.transaction(() => {
      const current = this.host.getJob(input.jobId);
      if (!current || current.version !== input.expectedVersion || current.phase !== "running"
        || current.turnId !== input.turnId || current.responsePlan !== undefined) {
        throw new Error("Telegram job version conflict");
      }
      let changed = false;
      for (const part of input.parts) {
        const existing = this.host.statement("SELECT * FROM deliveries WHERE job_id = ? AND part_key = ?")
          .get(input.jobId, part.partKey);
        if (existing) {
          const row = decodeDelivery(existing);
          if (!sameImmutableDelivery(row, part)) throw new Error("Telegram live commentary conflict");
          continue;
        }
        this.insert(part);
        changed = true;
      }
      if (!changed) return current;
      const deliveries = this.list(input.jobId)
        .filter((part) => part.kind === "summary")
        .map(projectDelivery);
      return this.host.applyTransition({
        jobId: input.jobId,
        eventId: input.eventId,
        expectedVersion: current.version,
        event: {
          schemaVersion: 1,
          type: "delivery.changed",
          phase: "running",
          eventAt: input.eventAt,
          deliveries,
        },
      });
    }).immediate();
  }
  finalizeDeliveredPlan(input: FinalizeDeliveredPlanInput): TelegramJob | null {
    validateFinalizationInput(input);
    return this.host.database.transaction(() => {
      const current = this.host.getJob(input.jobId);
      if (!current || current.version !== input.expectedVersion || current.phase !== "delivering"
        || current.responsePlan === undefined || input.eventAt < current.updatedAt) return null;
      const rows = this.list(input.jobId);
      const anchor = rows.find((part) => part.partKey === "status-anchor");
      const ordinary = rows.filter((part) => part.partKey !== "status-anchor");
      if (!anchor || anchor.kind !== "status-anchor" || anchor.ordinal !== 0
        || anchor.state !== "delivered" || anchor.telegramMessageId === null) {
        return this.recoveryUnsafe(current, input);
      }
      let plannedAnchor: StatusAnchorPlan | null;
      try { plannedAnchor = this.statusAnchorPlan(input.jobId); }
      catch { return this.recoveryUnsafe(current, input); }
      plannedAnchor ??= this.bootstrapStatusAnchorPlan(current, anchor, ordinary, input.eventAt);
      if (!plannedAnchor) return this.recoveryUnsafe(current, input);
      if (anchor.contentHash !== plannedAnchor.contentHash || !same(anchor.payload, plannedAnchor.payload)) {
        if ((plannedAnchor.payload.operation !== "edit_text" && plannedAnchor.payload.operation !== "edit_rich")
          || plannedAnchor.payload.messageId !== anchor.telegramMessageId) {
          return this.recoveryUnsafe(current, input);
        }
        const update = this.host.statement(`UPDATE deliveries SET state = 'pending', payload_json = ?, content_hash = ?,
          attempt_count = 0, next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
          WHERE job_id = ? AND part_key = 'status-anchor' AND state = 'delivered'
            AND content_hash = ? AND attempt_count = ? AND telegram_message_id = ?`).run(
          stringify(plannedAnchor.payload, "planned anchor payload"), plannedAnchor.contentHash, input.eventAt,
          input.jobId, anchor.contentHash, anchor.attemptCount, anchor.telegramMessageId,
        );
        if (update.changes !== 1) return null;
        return null;
      }
      if (ordinary.length !== current.responsePlan.length
        || current.deliveries.length !== current.responsePlan.length) {
        return this.recoveryUnsafe(current, input);
      }
      const deliveries: TelegramDeliveryPart[] = [];
      for (const [ordinal, planned] of current.responsePlan.entries()) {
        const row = ordinary.find((candidate) => candidate.partKey === planned.partId);
        const projected = current.deliveries.find((candidate) => candidate.partId === planned.partId);
        if (!row || !validDeliveredPlanRow(row, planned, ordinal) || !projected) {
          return this.recoveryUnsafe(current, input);
        }
        deliveries.push(projectDelivery(row));
      }
      return this.host.applyTransition({
        jobId: input.jobId, eventId: input.eventId, expectedVersion: current.version,
        event: { schemaVersion: 1, type: "job.terminal", eventAt: input.eventAt, outcome: "completed",
          responsePlan: current.responsePlan, deliveries, attention: { kind: "none" } },
      });
    }).immediate();
  }
  scanCompletionCandidates(input: DeliveryCompletionScanInput): DeliveryCompletionScanResult {
    validateCompletionScan(input);
    const cursor = input.cursor;
    const rows = this.host.statement(`SELECT jobs.id, jobs.version, jobs.updated_at_ms,
      inbox_updates.accepted_at_ms FROM jobs JOIN inbox_updates ON inbox_updates.job_id = jobs.id
      WHERE json_valid(jobs.projection_json)
        AND json_extract(jobs.projection_json, '$.phase') = 'delivering'
        AND json_type(jobs.projection_json, '$.responsePlan') = 'array'
        AND EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id
          AND deliveries.part_key = 'status-anchor' AND deliveries.state = 'delivered')
        AND NOT EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id
          AND deliveries.state != 'delivered')
        AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)
        AND (? IS NULL OR inbox_updates.accepted_at_ms > ?
          OR (inbox_updates.accepted_at_ms = ? AND jobs.id > ?))
      ORDER BY inbox_updates.accepted_at_ms, jobs.id LIMIT ?`).all(
      cursor?.acceptedAt ?? null, cursor?.acceptedAt ?? 0, cursor?.acceptedAt ?? 0,
      cursor?.jobId ?? "", input.limit,
    ) as Record<string, unknown>[];
    const candidates = rows.map((row) => ({
      jobId: bounded(row.id, "jobId", JOB_ID_MAX_LENGTH),
      expectedVersion: integer(row.version, "job version"),
      updatedAt: integer(row.updated_at_ms, "job updatedAt"),
    }));
    const last = rows.at(-1);
    const nextCursor = rows.length < input.limit || !last ? null : {
      acceptedAt: integer(last.accepted_at_ms, "acceptedAt"),
      jobId: bounded(last.id, "jobId", JOB_ID_MAX_LENGTH),
    };
    return { candidates: structuredClone(candidates), nextCursor };
  }
  transitionAndProject(input: ProjectedDeliveryTransitionInput): ProjectedDeliveryTransitionResult {
    validateProjectedTransition(input);
    return this.host.database.transaction(() => {
      const currentPart = this.require(input.jobId, input.partKey);
      if (currentPart.state !== input.expectedState || currentPart.attemptCount !== input.expectedAttemptCount
        || (input.expectedContentHash !== undefined && currentPart.contentHash !== input.expectedContentHash)) {
        throw new Error("Telegram delivery conflict");
      }
      assertDeliveryMove(
        currentPart.state,
        input.state,
        input.allowUncertainRetry === true,
        input.allowFailedRetry === true,
        input.allowPendingFailure === true,
      );
      const currentJob = this.host.getJob(input.jobId);
      if (!currentJob || currentJob.version !== input.expectedJobVersion) {
        throw new Error("Telegram job version conflict");
      }
      if (currentJob.phase === "running" && currentJob.responsePlan === undefined
        && currentPart.kind === "summary") {
        const delivery = this.update(input, currentPart);
        const deliveries = this.list(input.jobId)
          .filter((part) => part.kind === "summary")
          .map(projectDelivery);
        const event: TransitionEvent = {
          schemaVersion: 1,
          type: "delivery.changed",
          phase: "running",
          eventAt: input.updatedAt,
          deliveries,
          ...(input.attention === undefined ? {} : { attention: input.attention }),
        };
        const job = this.host.applyTransition({
          jobId: input.jobId,
          eventId: input.eventId,
          expectedVersion: currentJob.version,
          event,
        });
        return { delivery, job };
      }
      if (currentJob.phase !== "delivering" || currentJob.responsePlan === undefined) {
        throw new Error("Telegram job version conflict");
      }
      const delivery = this.update(input, currentPart);
      const rows = this.list(input.jobId);
      const deliveries = currentJob.responsePlan.map((part) => {
        const row = rows.find((candidate) => candidate.partKey === part.partId);
        if (!row) throw new Error("Telegram response plan conflict");
        return projectDelivery(row);
      });
      const anchor = rows.find((part) => part.partKey === "status-anchor");
      if (!anchor) throw new Error("Telegram response plan conflict");
      let plannedAnchor: StatusAnchorPlan | null;
      let anchorPlanMalformed = false;
      try { plannedAnchor = this.statusAnchorPlan(input.jobId); }
      catch {
        plannedAnchor = null;
        anchorPlanMalformed = true;
      }
      const ordinary = rows.filter((part) => part.partKey !== "status-anchor");
      const ordinaryValid = ordinary.length === currentJob.responsePlan.length
        && currentJob.responsePlan.every((part, ordinal) => {
          const row = ordinary.find((candidate) => candidate.partKey === part.partId);
          return row !== undefined && validDeliveredPlanRow(row, part, ordinal);
        });
      const completed = anchor.state === "delivered" && anchor.telegramMessageId !== null
        && plannedAnchor !== null && anchor.contentHash === plannedAnchor.contentHash
        && same(anchor.payload, plannedAnchor.payload) && ordinaryValid;
      const attention = input.attention ?? (anchorPlanMalformed
        ? { kind: "required" as const, code: "delivery_plan_recovery_unsafe", actions: ["inspect"] }
        : undefined);
      const event: TransitionEvent = completed
        ? { schemaVersion: 1, type: "job.terminal", eventAt: input.updatedAt, outcome: "completed",
            responsePlan: currentJob.responsePlan, deliveries, attention: { kind: "none" } }
        : { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: input.updatedAt,
            deliveries, ...(attention === undefined ? {} : { attention }) };
      const job = this.host.applyTransition({ jobId: input.jobId, eventId: input.eventId,
        expectedVersion: currentJob.version, event });
      return { delivery, job };
    }).immediate();
  }

  listDue(now: number, limit: number): readonly DeliveryPart[] {
    assertNonNegativeInteger(now, "now"); assertPositiveLimit(limit);
    return this.host.statement(`SELECT deliveries.* FROM deliveries JOIN jobs ON jobs.id = deliveries.job_id
      WHERE deliveries.state = 'pending' AND (deliveries.next_attempt_at_ms IS NULL OR deliveries.next_attempt_at_ms <= ?)
      AND CASE WHEN json_valid(jobs.projection_json) THEN (
        (json_extract(jobs.projection_json, '$.phase') = 'delivering'
          AND json_type(jobs.projection_json, '$.responsePlan') = 'array')
        OR (json_extract(jobs.projection_json, '$.phase') = 'running'
          AND json_type(jobs.projection_json, '$.responsePlan') IS NULL
          AND deliveries.kind = 'summary')) ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)
      AND NOT EXISTS (SELECT 1 FROM deliveries AS earlier
        WHERE earlier.job_id = deliveries.job_id AND earlier.state != 'delivered' AND (
          (earlier.part_key = 'status-anchor' AND deliveries.part_key != 'status-anchor') OR
          (earlier.part_key != 'status-anchor' AND deliveries.part_key != 'status-anchor' AND
            (earlier.ordinal < deliveries.ordinal OR
              (earlier.ordinal = deliveries.ordinal AND earlier.part_key < deliveries.part_key)))))
      ORDER BY deliveries.updated_at_ms, deliveries.job_id,
        CASE WHEN deliveries.part_key = 'status-anchor' THEN 0 ELSE 1 END, deliveries.ordinal, deliveries.part_key
      LIMIT ?`).all(now, limit).map((row) => decodeDelivery(row));
  }

  listSending(now: number, limit: number): readonly DeliveryPart[] {
    assertNonNegativeInteger(now, "now"); assertPositiveLimit(limit);
    return this.host.statement(`SELECT deliveries.* FROM deliveries JOIN jobs ON jobs.id = deliveries.job_id
      WHERE deliveries.state = 'sending' AND CASE WHEN json_valid(jobs.projection_json) THEN (
        json_extract(jobs.projection_json, '$.phase') = 'delivering'
        OR (json_extract(jobs.projection_json, '$.phase') = 'running'
          AND json_type(jobs.projection_json, '$.responsePlan') IS NULL
          AND deliveries.kind = 'summary')) ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)
      AND (deliveries.next_attempt_at_ms IS NULL OR deliveries.next_attempt_at_ms <= ?)
      AND NOT EXISTS (SELECT 1 FROM deliveries AS earlier
        WHERE earlier.job_id = deliveries.job_id AND earlier.state != 'delivered' AND (
          (earlier.part_key = 'status-anchor' AND deliveries.part_key != 'status-anchor') OR
          (earlier.part_key != 'status-anchor' AND deliveries.part_key != 'status-anchor' AND
            (earlier.ordinal < deliveries.ordinal OR
              (earlier.ordinal = deliveries.ordinal AND earlier.part_key < deliveries.part_key)))))
      ORDER BY deliveries.updated_at_ms, deliveries.job_id, deliveries.ordinal LIMIT ?`).all(now, limit).map((row) => decodeDelivery(row));
  }

  nextWakeupAt(): number | null {
    const row = this.host.statement(`SELECT min(deliveries.next_attempt_at_ms) AS next_at
      FROM deliveries JOIN jobs ON jobs.id = deliveries.job_id
      WHERE deliveries.state IN ('pending', 'sending') AND deliveries.next_attempt_at_ms IS NOT NULL
      AND CASE WHEN json_valid(jobs.projection_json) THEN (
        json_extract(jobs.projection_json, '$.phase') = 'delivering'
        OR (json_extract(jobs.projection_json, '$.phase') = 'running'
          AND json_type(jobs.projection_json, '$.responsePlan') IS NULL
          AND deliveries.kind = 'summary')) ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)`).get() as { next_at?: unknown };
    return row.next_at === null ? null : integer(row.next_at, "next delivery wakeup");
  }

  assertCompletion(
    job: TelegramJob,
    responsePlan: readonly TelegramResponsePlanPart[] | undefined,
    deliveries: readonly TelegramDeliveryPart[] | undefined,
  ): void {
    const jobId = job.id;
    const rows = this.list(jobId);
    const anchor = rows.find((part) => part.partKey === "status-anchor");
    const anchorPlan = this.statusAnchorPlan(jobId);
    const planned = job.responsePlan;
    const ordinary = rows.filter((part) => part.partKey !== "status-anchor");
    if (!anchor || anchor.state !== "delivered" || anchor.telegramMessageId === null || !anchorPlan
      || anchor.contentHash !== anchorPlan.contentHash || !same(anchor.payload, anchorPlan.payload) || planned === undefined
      || !same(responsePlan, planned) || !same(deliveries, job.deliveries)
      || ordinary.length !== planned.length || job.deliveries.length !== planned.length
      || planned.some((part, ordinal) => {
        const row = ordinary.find((candidate) => candidate.partKey === part.partId);
        const projected = job.deliveries.find((candidate) => candidate.partId === part.partId);
        return !row || !validDeliveredPlanRow(row, part, ordinal)
          || !projected || !same(projectDelivery(row), projected);
      })) {
      throw new Error("Telegram delivery incomplete");
    }
  }

  list(jobId: string): readonly DeliveryPart[] {
    if (!nonEmpty(jobId)) return [];
    return this.host.statement("SELECT * FROM deliveries WHERE job_id = ? ORDER BY ordinal, part_key").all(jobId)
      .map((row) => decodeDelivery(row));
  }

  summary(jobId: string): TelegramDeliverySummary {
    const rows = this.list(jobId);
    const summary: Record<DeliveryState, number> = { pending: 0, sending: 0, delivered: 0, uncertain: 0, failed: 0 };
    for (const row of rows) summary[row.state] += 1;
    return { total: rows.length, ...summary };
  }

  private require(jobId: string, partKey: string): DeliveryPart {
    const row = this.host.statement("SELECT * FROM deliveries WHERE job_id = ? AND part_key = ?").get(jobId, partKey);
    if (!row) throw new Error("Unknown Telegram delivery part");
    return decodeDelivery(row);
  }

  private requireStatusAnchor(jobId: string): DeliveryPart {
    const anchor = this.require(jobId, "status-anchor");
    if (anchor.kind !== "status-anchor" || anchor.ordinal !== 0) throw new Error("Telegram delivery conflict");
    return anchor;
  }

  private reconcileStatusAnchor(parts: readonly NewDeliveryPart[]): readonly NewDeliveryPart[] {
    const plannedAnchor = parts.find((part) => part.partKey === "status-anchor")!;
    const existing = this.host.statement("SELECT * FROM deliveries WHERE job_id = ? AND part_key = 'status-anchor'")
      .get(plannedAnchor.jobId);
    return reconcilePlannedStatusAnchor(parts, existing ? decodeDelivery(existing) : null);
  }

  private installStatusAnchorPlan(anchor: NewDeliveryPart, installedAt: number): void {
    const payload = normalizeTelegramDeliveryPayload(anchor.payload);
    if (hashTelegramDeliveryPayload(payload) !== anchor.contentHash) throw new Error("Invalid Telegram response plan");
    this.host.statement(`INSERT INTO status_anchor_plans (job_id, payload_json, content_hash, installed_at_ms)
      VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`).run(
      anchor.jobId, stringify(payload, "planned anchor payload"), anchor.contentHash, installedAt,
    );
    const stored = this.statusAnchorPlan(anchor.jobId);
    if (!stored || stored.contentHash !== anchor.contentHash || !same(stored.payload, payload)) {
      throw new Error("Telegram response plan conflict");
    }
    this.host.statement("DELETE FROM status_anchor_plan_bootstrap_eligibility WHERE job_id = ?")
      .run(anchor.jobId);
  }

  private statusAnchorPlan(jobId: string): StatusAnchorPlan | null {
    const row = this.host.statement(`SELECT job_id, payload_json, content_hash, installed_at_ms
      FROM status_anchor_plans WHERE job_id = ?`).get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      const payload = normalizeTelegramDeliveryPayload(JSON.parse(string(row.payload_json, "planned payload")));
      const contentHash = string(row.content_hash, "planned contentHash");
      if (!/^[0-9a-f]{64}$/.test(contentHash) || hashTelegramDeliveryPayload(payload) !== contentHash) throw new Error();
      return {
        jobId: bounded(row.job_id, "jobId", JOB_ID_MAX_LENGTH), payload, contentHash,
        installedAt: integer(row.installed_at_ms, "installedAt"),
      };
    } catch { throw new Error("Malformed Telegram status anchor plan"); }
  }

  private bootstrapStatusAnchorPlan(
    job: TelegramJob,
    anchor: DeliveryPart,
    ordinary: readonly DeliveryPart[],
    installedAt: number,
  ): StatusAnchorPlan | null {
    try {
      const eligible = this.host.statement(`SELECT 1 FROM status_anchor_plan_bootstrap_eligibility
        WHERE job_id = ?`).get(job.id);
      if (!eligible) return null;
      const source = record(this.host.readSourcePayload(job.id));
      if (!source || source.botId !== job.source.botId || source.updateId !== job.source.updateId
        || source.completion !== undefined || !job.turnResult || anchor.telegramMessageId === null) return null;
      const target = source.targetContext === undefined ? source : record(source.targetContext);
      if (!target) return null;
      const chatId = nonzeroInteger(target.chatId);
      const messageThreadId = nullablePositiveInteger(target.messageThreadId);
      const rebuilt = buildTelegramResponsePlan({
        result: job.turnResult,
        destination: { chatId, messageThreadId, anchorMessageId: anchor.telegramMessageId },
      });
      if (!same(rebuilt.responsePlan, job.responsePlan) || ordinary.length !== rebuilt.parts.length
        || job.deliveries.length !== rebuilt.responsePlan.length
        || rebuilt.parts.some((part) => {
          const row = ordinary.find((candidate) => candidate.partKey === part.partKey);
          return !row || row.ordinal !== part.ordinal || row.kind !== part.kind
            || row.contentHash !== part.contentHash || !same(row.payload, part.payload);
        })) return null;
      this.installStatusAnchorPlan({
        ...rebuilt.anchor, jobId: job.id, state: "pending", telegramMessageId: anchor.telegramMessageId,
        updatedAt: installedAt,
      }, installedAt);
      return this.statusAnchorPlan(job.id);
    } catch { return null; }
  }

  private recoveryUnsafe(job: TelegramJob, input: FinalizeDeliveredPlanInput): TelegramJob | null {
    if (job.attention.kind === "required" && job.attention.code === "delivery_plan_recovery_unsafe") return null;
    return this.host.applyTransition({
      jobId: job.id, eventId: input.eventId, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: input.eventAt,
        attention: { kind: "required", code: "delivery_plan_recovery_unsafe", actions: ["inspect"] } },
    });
  }

  private update(input: DeliveryTransitionInput, current: DeliveryPart): DeliveryPart {
    this.host.statement(`UPDATE deliveries SET state = ?, telegram_message_id = ?, attempt_count = ?,
      next_attempt_at_ms = ?, last_error_code = ?, updated_at_ms = ? WHERE job_id = ? AND part_key = ?`).run(
      input.state, optional(input, "telegramMessageId", current.telegramMessageId), input.attemptCount,
      optional(input, "nextAttemptAt", current.nextAttemptAt), optional(input, "lastErrorCode", current.lastErrorCode),
      input.updatedAt, input.jobId, input.partKey,
    );
    return this.require(input.jobId, input.partKey);
  }

  private upsertPlanned(input: NewDeliveryPart): void {
    const existing = this.host.statement("SELECT * FROM deliveries WHERE job_id = ? AND part_key = ?")
      .get(input.jobId, input.partKey);
    const values = [input.ordinal, input.kind, input.state, stringify(input.payload, "delivery payload"), input.contentHash,
      input.telegramMessageId ?? null, input.attemptCount ?? 0, input.nextAttemptAt ?? null,
      input.lastErrorCode ?? null, input.updatedAt, input.jobId, input.partKey];
    if (existing) {
      if (input.partKey !== "status-anchor") {
        if (!sameImmutableDelivery(decodeDelivery(existing), input)) {
          throw new Error("Telegram response plan conflict");
        }
        return;
      }
      this.host.statement(`UPDATE deliveries SET ordinal = ?, kind = ?, state = ?, payload_json = ?, content_hash = ?,
        telegram_message_id = ?, attempt_count = ?, next_attempt_at_ms = ?, last_error_code = ?, updated_at_ms = ?
        WHERE job_id = ? AND part_key = ?`).run(...values);
      return;
    }
    this.host.statement(`INSERT INTO deliveries (ordinal, kind, state, payload_json, content_hash, telegram_message_id,
      attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms, job_id, part_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
  }
}

export function validateDelivery(value: Pick<DeliveryPart, "jobId" | "partKey" | "ordinal" | "kind" | "state" | "updatedAt"> & Partial<DeliveryPart>): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH); bounded(value.partKey, "partKey", PART_KEY_MAX_LENGTH);
  bounded(value.kind, "kind", DELIVERY_TEXT_MAX_LENGTH);
  if (value.contentHash !== undefined && !/^[0-9a-f]{64}$/.test(value.contentHash)) throw new Error("Invalid contentHash");
  assertNonNegativeInteger(value.ordinal, "ordinal"); assertNonNegativeInteger(value.updatedAt, "updatedAt"); deliveryState(value.state);
  if (value.attemptCount !== undefined) assertNonNegativeInteger(value.attemptCount, "attemptCount");
  if (value.telegramMessageId !== undefined && value.telegramMessageId !== null) assertPositiveInteger(value.telegramMessageId, "telegramMessageId");
  if (value.nextAttemptAt !== undefined && value.nextAttemptAt !== null) assertNonNegativeInteger(value.nextAttemptAt, "nextAttemptAt");
  if (value.lastErrorCode !== undefined && value.lastErrorCode !== null) bounded(value.lastErrorCode, "lastErrorCode", DELIVERY_TEXT_MAX_LENGTH);
}

function decodeDelivery(value: unknown): DeliveryPart {
  const row = value as Record<string, unknown>;
  try {
    const delivery: DeliveryPart = {
      jobId: string(row.job_id, "job_id"), partKey: string(row.part_key, "part_key"), ordinal: integer(row.ordinal, "ordinal"),
      kind: string(row.kind, "kind"), state: deliveryState(row.state), payload: JSON.parse(string(row.payload_json, "payload_json")),
      contentHash: string(row.content_hash, "content_hash"), telegramMessageId: nullableInteger(row.telegram_message_id, "telegram_message_id"),
      attemptCount: integer(row.attempt_count, "attempt_count"), nextAttemptAt: nullableInteger(row.next_attempt_at_ms, "next_attempt_at_ms"),
      lastErrorCode: nullableText(row.last_error_code, "last_error_code"), updatedAt: integer(row.updated_at_ms, "updated_at_ms"),
    };
    validateDelivery(delivery);
    return structuredClone(delivery);
  } catch { throw new Error("Malformed Telegram delivery part"); }
}

function validateDeliveryTransition(value: DeliveryTransitionInput): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH); bounded(value.partKey, "partKey", PART_KEY_MAX_LENGTH); deliveryState(value.state);
  assertNonNegativeInteger(value.attemptCount, "attemptCount"); assertNonNegativeInteger(value.updatedAt, "updatedAt");
  if (value.telegramMessageId !== undefined && value.telegramMessageId !== null) assertPositiveInteger(value.telegramMessageId, "telegramMessageId");
  if (value.nextAttemptAt !== undefined && value.nextAttemptAt !== null) assertNonNegativeInteger(value.nextAttemptAt, "nextAttemptAt");
  if (value.lastErrorCode !== undefined && value.lastErrorCode !== null) bounded(value.lastErrorCode, "lastErrorCode", DELIVERY_TEXT_MAX_LENGTH);
}
function validatePlanInput(value: InstallDeliveryPlanInput): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH); bounded(value.eventId, "eventId", EVENT_ID_MAX_LENGTH);
  assertNonNegativeInteger(value.expectedVersion, "expectedVersion"); assertNonNegativeInteger(value.eventAt, "eventAt");
  if (value.parts.length !== value.responsePlan.length + 1
    || value.parts.filter((part) => part.partKey === "status-anchor").length !== 1) throw new Error("Invalid Telegram response plan");
  const ids = new Set<string>(); let ordinaryIndex = 0;
  value.parts.forEach((part) => {
    validateDelivery(part);
    if (part.jobId !== value.jobId || part.state !== "pending" || ids.has(part.partKey)) throw new Error("Invalid Telegram response plan");
    ids.add(part.partKey);
    if (part.partKey === "status-anchor") {
      if (part.kind !== "status-anchor" || part.ordinal !== 0) throw new Error("Invalid Telegram response plan");
      return;
    }
    const planned = value.responsePlan[ordinaryIndex];
    if (part.ordinal !== ordinaryIndex || !planned || planned.partId !== part.partKey || planned.kind !== part.kind) {
      throw new Error("Invalid Telegram response plan");
    }
    ordinaryIndex += 1;
  });
}
function validateLiveCommentaryInput(value: InstallLiveCommentaryInput): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH);
  bounded(value.turnId, "turnId", JOB_ID_MAX_LENGTH);
  bounded(value.eventId, "eventId", EVENT_ID_MAX_LENGTH);
  assertNonNegativeInteger(value.expectedVersion, "expectedVersion");
  assertNonNegativeInteger(value.eventAt, "eventAt");
  if (value.parts.length === 0 || value.parts.length > 256) throw new Error("Invalid live commentary plan");
  const ids = new Set<string>();
  for (const part of value.parts) {
    validateDelivery(part);
    if (part.jobId !== value.jobId || part.kind !== "summary" || part.state !== "pending"
      || !/^summary:\d{4}:\d{4}$/.test(part.partKey) || ids.has(part.partKey)) {
      throw new Error("Invalid live commentary plan");
    }
    ids.add(part.partKey);
  }
}
function validateProjectedTransition(value: ProjectedDeliveryTransitionInput): void {
  validateDeliveryTransition(value); bounded(value.eventId, "eventId", EVENT_ID_MAX_LENGTH);
  assertNonNegativeInteger(value.expectedJobVersion, "expectedJobVersion");
  assertNonNegativeInteger(value.expectedAttemptCount, "expectedAttemptCount"); deliveryState(value.expectedState);
  if (value.expectedContentHash !== undefined && !/^[0-9a-f]{64}$/.test(value.expectedContentHash)) {
    throw new Error("Invalid contentHash");
  }
}
function validateFinalizationInput(value: FinalizeDeliveredPlanInput): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH); bounded(value.eventId, "eventId", EVENT_ID_MAX_LENGTH);
  assertNonNegativeInteger(value.expectedVersion, "expectedVersion"); assertNonNegativeInteger(value.eventAt, "eventAt");
}
function validateCompletionScan(value: DeliveryCompletionScanInput): void {
  assertPositiveLimit(value.limit);
  if (value.cursor) {
    assertNonNegativeInteger(value.cursor.acceptedAt, "cursor acceptedAt");
    bounded(value.cursor.jobId, "cursor jobId", JOB_ID_MAX_LENGTH);
  }
}
function assertDeliveryMove(
  current: DeliveryState,
  next: DeliveryState,
  uncertainRetry: boolean,
  failedRetry = false,
  pendingFailure = false,
): void {
  const valid = current === "pending" ? next === "sending" || (pendingFailure && next === "failed")
    : current === "sending" ? next === "pending" || next === "delivered" || next === "uncertain" || next === "failed"
      : current === "uncertain" ? uncertainRetry && next === "sending"
        : current === "failed" ? failedRetry && (next === "pending" || next === "sending") : false;
  if (!valid) throw new Error("Invalid Telegram delivery transition");
}
function projectDelivery(value: NewDeliveryPart | DeliveryPart): TelegramDeliveryPart {
  return { partId: value.partKey, state: value.state, attempts: value.attemptCount ?? 0,
    messageId: value.telegramMessageId ?? null, deliveredAt: value.state === "delivered" ? value.updatedAt : null };
}
function validDeliveredPlanRow(
  row: DeliveryPart,
  planned: TelegramResponsePlanPart,
  ordinal: number,
): boolean {
  if (row.ordinal !== ordinal || row.kind !== planned.kind || row.state !== "delivered"
    || row.telegramMessageId === null) return false;
  try {
    const payload = normalizeTelegramDeliveryPayload(row.payload);
    return same(payload, row.payload) && hashTelegramDeliveryPayload(payload) === row.contentHash;
  } catch { return false; }
}
function samePlanRows(actual: readonly DeliveryPart[], expected: readonly NewDeliveryPart[]): boolean {
  return actual.length === expected.length && expected.every((part) => {
    const row = actual.find((candidate) => candidate.partKey === part.partKey);
    return row !== undefined && row.ordinal === part.ordinal && row.kind === part.kind
      && same(row.payload, part.payload) && row.contentHash === part.contentHash;
  });
}
function sameImmutableDelivery(actual: DeliveryPart, expected: NewDeliveryPart): boolean {
  return actual.jobId === expected.jobId
    && actual.partKey === expected.partKey
    && actual.ordinal === expected.ordinal
    && actual.kind === expected.kind
    && same(actual.payload, expected.payload)
    && actual.contentHash === expected.contentHash;
}
function deliveryState(value: unknown): DeliveryState {
  if (value === "pending" || value === "sending" || value === "delivered" || value === "uncertain" || value === "failed") return value;
  throw new Error("Invalid delivery state");
}
function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}
function assertPositiveInteger(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
}
function assertPositiveLimit(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid list limit"); }
function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function integer(value: unknown, name: string): number { assertNonNegativeInteger(value, name); return value; }
function nullableInteger(value: unknown, name: string): number | null { return value === null ? null : integer(value, name); }
function nullableText(value: unknown, name: string): string | null { return value === null ? null : string(value, name); }
function nonzeroInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) throw new Error("Invalid chatId");
  return value;
}
function nullablePositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  assertPositiveInteger(value, "messageThreadId");
  return value as number;
}
function string(value: unknown, name: string): string { if (typeof value !== "string") throw new Error(`Invalid ${name}`); return value; }
function stringify(value: unknown, name: string): string {
  try { const result = JSON.stringify(value); if (result === undefined) throw new Error(); return result; }
  catch { throw new Error(`Invalid ${name}`); }
}
function optional<T extends object, K extends keyof T>(value: T, key: K, fallback: T[K] | null): T[K] | null {
  return Object.hasOwn(value, key) ? value[key] ?? null : fallback;
}
function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
