import { randomUUID } from "node:crypto";

import {
  buildTelegramCommentaryParts,
  buildTelegramResponsePlan,
  type TelegramDeliveryPayload,
  type TelegramResponseDestination,
  type TelegramResponseFailure,
  type TelegramSupplementalResponsePart,
} from "./telegram-response-plan.js";
import type {
  DeliveryPart,
  ProjectedDeliveryTransitionInput,
  SqliteTelegramJobStore,
} from "./telegram-job-store.js";
import type { JobAttention, TelegramJob } from "./telegram-job-types.js";
import { exactRichFallbackInstalled } from "./telegram-delivery-outbox-rich.js";
import { TelegramDeliveryApiError, TelegramDeliveryLocalError } from "./telegram-delivery-error.js";
import {
  assertPayloadMediaAvailable,
  DeliveryMediaUnavailableError,
  isKnownEdit,
  isRich,
  safePayload,
  validatedPayload,
} from "./telegram-delivery-outbox-payload.js";

export type { TelegramDeliveryPayload } from "./telegram-response-plan.js";
export { TelegramDeliveryApiError, TelegramDeliveryLocalError } from "./telegram-delivery-error.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_RETRY_DELAY_MS = 1_000;
const DEFAULT_ATTEMPT_LIMIT = 5;

type OutboxStore = Pick<SqliteTelegramJobStore,
  "get" | "installDeliveryPlan" | "installLiveCommentary" | "listDeliveries"
  | "listDueDeliveries" | "listSendingDeliveries"
  | "nextDeliveryWakeupAt" | "transitionDeliveryAndProject" | "scanDeliveryCompletionCandidates"
  | "finalizeDeliveredPlan" | "replaceMissingStatusAnchorEdit" | "replaceRejectedRichDelivery">;

export interface TelegramDeliveryAdapter {
  deliver(payload: TelegramDeliveryPayload, signal: AbortSignal): Promise<{ readonly messageId: number }>;
}

export interface TelegramDeliveryOutboxOptions {
  readonly store: OutboxStore;
  readonly telegram: TelegramDeliveryAdapter;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly scheduleWakeup?: (at: number, wake: () => Promise<void>) => void;
  readonly timeoutMs?: number;
  readonly attemptLimit?: number;
  readonly attachmentRoot?: string;
  readonly statusDestination?: (jobId: string) => {
    readonly chatId: number;
    readonly messageThreadId: number | null;
  };
}

export interface TelegramFailedDeliveryRetryOptions {
  readonly expectedJobVersion?: number;
}

export class TelegramDeliveryOutbox {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly timeoutMs: number;
  private readonly attemptLimit: number;
  private pumpPromise: Promise<void> | null = null;
  private pumpAgain = false;
  private richUnavailable = false;
  private completionReconciliationAt: number | null = null;

  constructor(private readonly options: TelegramDeliveryOutboxOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.timeoutMs = boundedPositive(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.attemptLimit = boundedPositive(options.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT, 100, "attemptLimit");
  }

  installPlan(
    jobId: string,
    destination: TelegramResponseDestination,
    failure?: TelegramResponseFailure,
    prepared?: {
      readonly result?: TelegramJob["turnResult"];
      readonly supplementalParts?: readonly TelegramSupplementalResponsePart[];
    },
  ): TelegramJob {
    const job = this.requireJob(jobId);
    if ((job.phase !== "delivering" && job.phase !== "terminal") || !job.turnResult) {
      throw new Error("Telegram job has no deliverable result");
    }
    const plan = buildTelegramResponsePlan({
      result: prepared?.result ?? job.turnResult,
      destination,
      ...(failure ? { failure } : {}),
      ...(prepared?.supplementalParts ? { supplementalParts: prepared.supplementalParts } : {}),
    });
    return this.options.store.installDeliveryPlan({
      jobId: job.id, eventId: boundedId(this.createId()), expectedVersion: job.version,
      eventAt: monotonicNow(this.now, job.updatedAt), responsePlan: plan.responsePlan,
      parts: [plan.anchor, ...plan.parts].map((part) => ({
        ...part, jobId: job.id, state: "pending" as const,
        telegramMessageId: isKnownEdit(part.payload) ? part.payload.messageId : null,
        updatedAt: monotonicNow(this.now, job.updatedAt),
      })),
    });
  }

  installLiveCommentary(
    jobId: string,
    destination: TelegramResponseDestination,
    commentary: {
      readonly turnId: string;
      readonly itemId: string;
      readonly commentaryIndex: number;
      readonly text: string;
    },
  ): TelegramJob {
    const job = this.requireJob(jobId);
    if (job.phase !== "running" || job.turnId !== boundedId(commentary.turnId)
      || job.responsePlan !== undefined) {
      throw new Error("Telegram job cannot publish live commentary");
    }
    boundedId(commentary.itemId);
    const planned = buildTelegramCommentaryParts({
      text: commentary.text,
      commentaryIndex: commentary.commentaryIndex,
      destination,
    });
    const rows = this.options.store.listDeliveries(job.id);
    const prefix = `summary:${String(commentary.commentaryIndex).padStart(4, "0")}:`;
    const existing = rows.filter((part) => part.kind === "summary" && part.partKey.startsWith(prefix));
    const laterExists = rows.some((part) => part.kind === "summary"
      && commentaryOrdinal(part.partKey) > commentary.commentaryIndex);
    if (existing.length === 0 && laterExists) throw new Error("Telegram live commentary order conflict");
    const baseOrdinal = existing.length > 0
      ? Math.min(...existing.map((part) => part.ordinal))
      : rows.filter((part) => part.kind === "summary"
          && commentaryOrdinal(part.partKey) < commentary.commentaryIndex).length;
    const at = monotonicNow(this.now, job.updatedAt);
    return this.options.store.installLiveCommentary({
      jobId: job.id,
      turnId: commentary.turnId,
      eventId: boundedId(this.createId()),
      expectedVersion: job.version,
      eventAt: at,
      parts: planned.map((part, segmentIndex) => ({
        ...part,
        jobId: job.id,
        ordinal: baseOrdinal + segmentIndex,
        state: "pending" as const,
        telegramMessageId: null,
        updatedAt: at,
      })),
    });
  }

  pump(): Promise<void> {
    if (this.pumpPromise) { this.pumpAgain = true; return this.pumpPromise; }
    const work = this.drainPumps().finally(() => { if (this.pumpPromise === work) this.pumpPromise = null; });
    this.pumpPromise = work;
    return work;
  }

  async sendAgainWithWarning(jobId: string, partKey: string): Promise<void> {
    const row = this.options.store.listDeliveries(boundedId(jobId)).find((part) => part.partKey === boundedId(partKey));
    if (!row || row.state !== "uncertain") throw new Error("Delivery is not uncertain");
    const job = this.requireJob(row.jobId);
    if (isRichFallbackFailure(job)) throw new Error("Rich fallback failure requires inspection");
    const payload = safePayload(row, this.options.attachmentRoot);
    if (isKnownEdit(payload)) throw new Error("Known edits do not need duplicate-send approval");
    const sending = this.change(row, "sending", row.attemptCount, {
      allowUncertainRetry: true, nextAttemptAt: boundedAdd(timestamp(this.now()), this.timeoutMs),
    }, job.version);
    try { await this.deliver(sending.delivery, payload); }
    finally { this.scheduleNextWakeup(); }
  }

  async retryFailed(
    jobId: string,
    partKey: string,
    retryOptions: TelegramFailedDeliveryRetryOptions = {},
  ): Promise<void> {
    const job = this.requireJob(boundedId(jobId));
    const expectedJobVersion = retryOptions.expectedJobVersion;
    if (expectedJobVersion !== undefined
      && (!positiveInteger(expectedJobVersion) || job.version !== expectedJobVersion)) {
      throw new Error("Telegram job version conflict");
    }
    const rows = this.options.store.listDeliveries(job.id);
    const row = rows.find((part) => part.partKey === boundedId(partKey));
    if (!row || row.state !== "failed") throw new Error("Delivery is not failed");
    const attention = retryAttention(job, row, rows);
    const payload = validatedPayload(row);
    if (this.richUnavailable && isRich(payload)) {
      const pending = this.change(row, "pending", row.attemptCount, {
        allowFailedRetry: true, nextAttemptAt: null, lastErrorCode: null,
        ...(attention === undefined ? {} : { attention }),
      }, expectedJobVersion ?? job.version, job);
      try {
        if (this.replanRich(pending.delivery, payload, "rich_method_unavailable", false)) await this.pump();
      } finally { this.scheduleNextWakeup(); }
      return;
    }
    assertPayloadMediaAvailable(payload, this.options.attachmentRoot);
    const sending = this.change(row, "sending", row.attemptCount, {
      allowFailedRetry: true,
      nextAttemptAt: boundedAdd(timestamp(this.now()), this.timeoutMs),
      ...(attention === undefined ? {} : { attention }),
    }, expectedJobVersion ?? job.version, job);
    try {
      const delivered = await this.deliver(sending.delivery, payload);
      if (delivered && row.partKey === "status-anchor" && row.kind === "status-anchor") {
        await this.pump();
      }
    }
    finally { this.scheduleNextWakeup(); }
  }

  private async performPump(): Promise<void> {
    this.recoverSending();
    try {
      while (true) {
        this.reconcileCompletedPlans();
        const due = this.options.store.listDueDeliveries(timestamp(this.now()), 1_000);
        if (due.length === 0) return;
        let progressed = false;
        for (const part of due) {
          try {
            const job = this.options.store.get(part.jobId);
            if (job && isRichFallbackFailure(job)) continue;
            if (!job) continue;
            let payload: TelegramDeliveryPayload;
            try { payload = validatedPayload(part); }
            catch {
              const code = "delivery_payload_corrupt";
              this.change(part, "failed", part.attemptCount, {
                nextAttemptAt: null, lastErrorCode: code,
                attention: required(code, ["inspect"]), allowPendingFailure: true,
              }, job.version);
              progressed = true;
              continue;
            }
            if (this.richUnavailable && isRich(payload)) {
              if (this.replanRich(part, payload, "rich_method_unavailable", false)) progressed = true;
              continue;
            }
            try { assertPayloadMediaAvailable(payload, this.options.attachmentRoot); }
            catch (error) {
              if (!(error instanceof DeliveryMediaUnavailableError)) throw error;
              const code = "delivery_media_unavailable";
              this.change(part, "failed", part.attemptCount, {
                nextAttemptAt: null, lastErrorCode: code,
                attention: required(code, ["inspect"]), allowPendingFailure: true,
              }, job.version);
              progressed = true;
              continue;
            }
            const sending = this.change(part, "sending", part.attemptCount, {
              nextAttemptAt: boundedAdd(timestamp(this.now()), this.timeoutMs),
            }, job.version);
            if (await this.deliver(sending.delivery, payload)) progressed = true;
          } catch (error) {
            if (!isConflict(error)) throw error;
          }
        }
        if (!progressed) return;
      }
    } finally {
      this.scheduleNextWakeup();
    }
  }

  private async drainPumps(): Promise<void> {
    do {
      this.pumpAgain = false;
      await this.performPump();
    } while (this.pumpAgain);
  }

  private scheduleNextWakeup(): void {
    const at = this.options.store.nextDeliveryWakeupAt();
    if (at !== null) this.options.scheduleWakeup?.(at, () => this.pump());
  }

  private recoverSending(): void {
    for (const row of this.options.store.listSendingDeliveries(timestamp(this.now()), 1_000)) {
      try {
        const job = this.requireJob(row.jobId);
        if (isRichFallbackFailure(job)) {
          this.change(row, "failed", row.attemptCount, {
            nextAttemptAt: null, lastErrorCode: "telegram_rich_fallback_failed",
            attention: required("telegram_rich_fallback_failed", ["inspect", "retry"]),
          }, job.version);
          continue;
        }
        let payload: TelegramDeliveryPayload;
        try { payload = validatedPayload(row); }
        catch {
          const code = "delivery_payload_corrupt";
          this.change(row, "failed", row.attemptCount, {
            lastErrorCode: code, attention: required(code, ["inspect"]),
          }, job.version);
          continue;
        }
        if (isKnownEdit(payload)) {
          this.change(row, "pending", row.attemptCount, { nextAttemptAt: null }, job.version);
        } else {
          this.change(row, "uncertain", row.attemptCount + 1, {
            nextAttemptAt: null, lastErrorCode: "telegram_send_uncertain",
            attention: required("telegram_delivery_uncertain", ["send_again", "inspect"]),
          }, job.version);
        }
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
  }

  private reconcileCompletedPlans(): void {
    let cursor: { readonly acceptedAt: number; readonly jobId: string } | null = null;
    do {
      const page = this.options.store.scanDeliveryCompletionCandidates({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const candidate of page.candidates) {
        try {
          const finalized = this.options.store.finalizeDeliveredPlan({
            jobId: candidate.jobId, eventId: boundedId(this.createId()),
            expectedVersion: candidate.expectedVersion,
            eventAt: monotonicNow(this.now, candidate.updatedAt),
          });
          if (finalized === null && this.shouldRetryCompletion(candidate.jobId)) {
            this.scheduleCompletionReconciliation();
          }
        } catch (error) {
          if (this.shouldRetryCompletion(candidate.jobId)) this.scheduleCompletionReconciliation();
          if (!isConflict(error)) throw error;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  private shouldRetryCompletion(jobId: string): boolean {
    const job = this.options.store.get(jobId);
    if (!job || job.phase !== "delivering" || job.responsePlan === undefined
      || (job.attention.kind === "required" && job.attention.code === "delivery_plan_recovery_unsafe")) {
      return false;
    }
    const rows = this.options.store.listDeliveries(jobId);
    return rows.length > 0 && rows.every((part) => part.state === "delivered");
  }

  private scheduleCompletionReconciliation(): void {
    if (!this.options.scheduleWakeup || this.completionReconciliationAt !== null) return;
    const at = boundedAdd(timestamp(this.now()), SAFE_RETRY_DELAY_MS);
    this.completionReconciliationAt = at;
    this.options.scheduleWakeup(at, async () => {
      if (this.completionReconciliationAt === at) this.completionReconciliationAt = null;
      await this.pump();
    });
  }

  private async deliver(part: DeliveryPart, payload: TelegramDeliveryPayload): Promise<boolean> {
    try {
      const response = await withDeadline((signal) => this.options.telegram.deliver(payload, signal), this.timeoutMs);
      const messageId = isKnownEdit(payload) ? payload.messageId : positiveMessageId(response.messageId);
      this.change(part, "delivered", part.attemptCount + 1, {
        telegramMessageId: messageId, nextAttemptAt: null, lastErrorCode: null,
      });
      return true;
    } catch (error) {
      if (error instanceof TelegramDeliveryApiError && error.code === "message_missing") {
        if (part.partKey !== "status-anchor" || part.kind !== "status-anchor"
          || payload.operation !== "edit_text" || part.telegramMessageId !== payload.messageId
          || part.nextAttemptAt === null) {
          return this.failPermanent(part);
        }
        let destination: ReturnType<NonNullable<TelegramDeliveryOutboxOptions["statusDestination"]>>;
        try {
          if (!this.options.statusDestination) return this.failPermanent(part);
          destination = this.options.statusDestination(part.jobId);
        } catch {
          return this.failPermanent(part);
        }
        if (destination.chatId !== payload.chatId) return this.failPermanent(part);
        const replacementPayload: TelegramDeliveryPayload = {
          operation: "send_text",
          chatId: payload.chatId,
          messageThreadId: destination.messageThreadId,
          text: payload.text,
        };
        const replacement = this.options.store.replaceMissingStatusAnchorEdit({
          jobId: part.jobId,
          expectedAttemptCount: part.attemptCount,
          expectedContentHash: part.contentHash,
          expectedLeaseUntil: part.nextAttemptAt,
          expectedMessageId: payload.messageId,
          replacementPayload,
          updatedAt: monotonicNow(this.now, part.updatedAt),
        });
        const sending = this.change(replacement, "sending", replacement.attemptCount, {
          nextAttemptAt: boundedAdd(timestamp(this.now()), this.timeoutMs),
        });
        return this.deliver(sending.delivery, replacementPayload);
      }
      if (error instanceof TelegramDeliveryApiError && error.code === "message_not_modified" && isKnownEdit(payload)) {
        this.change(part, "delivered", part.attemptCount + 1, {
          telegramMessageId: payload.messageId, nextAttemptAt: null, lastErrorCode: null,
        });
        return true;
      }
      if (error instanceof TelegramDeliveryApiError && error.code === "rich_rejected" && isRich(payload)) {
        const reason = error.richReason === "method_unavailable"
          ? "rich_method_unavailable" : "rich_format_rejected";
        if (error.richReason === "method_unavailable") this.richUnavailable = true;
        return this.replanRich(part, payload, reason, true);
      }
      if (error instanceof TelegramDeliveryLocalError) {
        this.change(part, "failed", part.attemptCount, {
          nextAttemptAt: null, lastErrorCode: "delivery_media_unavailable",
          attention: required("delivery_media_unavailable", ["inspect"]),
        });
        return false;
      }
      if (error instanceof TelegramDeliveryApiError && error.code === "retry_after") {
        const nextAttemptAt = boundedAdd(timestamp(this.now()), error.retryAfterMs!);
        this.change(part, "pending", part.attemptCount, { nextAttemptAt, lastErrorCode: "telegram_retry_after" });
        return false;
      }
      if (error instanceof TelegramDeliveryApiError && error.code === "permanent") {
        this.change(part, "failed", part.attemptCount + 1, {
          nextAttemptAt: null, lastErrorCode: "telegram_permanent", attention: required("telegram_delivery_failed", ["inspect", "retry"]),
        });
        return false;
      }
      if (error instanceof TelegramDeliveryApiError && error.code === "not_sent") {
        this.change(part, "pending", part.attemptCount, {
          nextAttemptAt: boundedAdd(timestamp(this.now()), SAFE_RETRY_DELAY_MS), lastErrorCode: "telegram_not_sent",
        });
        return false;
      }
      return this.afterAmbiguousFailure(part, payload);
    }
  }

  private failPermanent(part: DeliveryPart): false {
    this.change(part, "failed", part.attemptCount + 1, {
      nextAttemptAt: null,
      lastErrorCode: "telegram_permanent",
      attention: required("telegram_delivery_failed", ["inspect", "retry"]),
    });
    return false;
  }

  private afterAmbiguousFailure(part: DeliveryPart, payload: TelegramDeliveryPayload): false {
    const attempts = part.attemptCount + 1;
    if (isKnownEdit(payload) && attempts < this.attemptLimit) {
      this.change(part, "pending", attempts, {
        nextAttemptAt: boundedAdd(timestamp(this.now()), SAFE_RETRY_DELAY_MS), lastErrorCode: "telegram_edit_timeout",
      });
    } else if (isKnownEdit(payload)) {
      this.change(part, "failed", attempts, {
        nextAttemptAt: null, lastErrorCode: "telegram_edit_failed", attention: required("telegram_delivery_failed", ["inspect", "retry"]),
      });
    } else {
      this.change(part, "uncertain", attempts, {
        nextAttemptAt: null, lastErrorCode: "telegram_send_uncertain",
        attention: required("telegram_delivery_uncertain", ["send_again", "inspect"]),
      });
    }
    return false;
  }

  private replanRich(
    part: DeliveryPart,
    payload: Extract<TelegramDeliveryPayload, { operation: "send_rich" | "edit_rich" }>,
    reasonCode: "rich_format_rejected" | "rich_method_unavailable",
    apiAttempted: boolean,
  ): boolean {
    const job = this.requireJob(part.jobId);
    if (part.state !== "pending" && part.state !== "sending") {
      this.failRichFallback(part, payload, job, apiAttempted);
      return false;
    }
    try {
      this.options.store.replaceRejectedRichDelivery({
        jobId: part.jobId, partKey: part.partKey, expectedJobVersion: job.version,
        expectedState: part.state, expectedAttemptCount: part.attemptCount,
        expectedContentHash: part.contentHash, eventId: boundedId(this.createId()),
        eventAt: monotonicNow(this.now, Math.max(job.updatedAt, part.updatedAt)), reasonCode,
      });
      return true;
    } catch {
      return this.failRichFallback(part, payload, job, apiAttempted);
    }
  }

  private failRichFallback(
    original: DeliveryPart,
    payload: Extract<TelegramDeliveryPayload, { operation: "send_rich" | "edit_rich" }>,
    before: TelegramJob,
    apiAttempted: boolean,
  ): boolean {
    const attention = required("telegram_rich_fallback_failed", ["inspect", "retry"]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentJob = this.options.store.get(original.jobId);
      const rows = this.options.store.listDeliveries(original.jobId);
      if (currentJob && exactRichFallbackInstalled(before, original, payload, currentJob, rows)) return true;
      if (!currentJob || currentJob.phase !== "delivering" || currentJob.responsePlan === undefined) return false;
      const current = rows.find((row) => row.partKey === original.partKey);
      if (!sameDeliveryEvidence(current, original)) return false;
      try {
        this.change(current, "failed", current.attemptCount + (apiAttempted ? 1 : 0), {
          nextAttemptAt: null, lastErrorCode: "telegram_rich_fallback_failed",
          ...(currentJob.attention.kind === "required" && !isRichFallbackFailure(currentJob)
            ? {} : { attention }),
          ...(current.state === "pending" ? { allowPendingFailure: true } : {}),
        }, currentJob.version);
        return false;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    const finalJob = this.options.store.get(original.jobId);
    const finalRows = this.options.store.listDeliveries(original.jobId);
    if (finalJob && exactRichFallbackInstalled(before, original, payload, finalJob, finalRows)) return true;
    const finalRow = finalRows.find((row) => row.partKey === original.partKey);
    if (finalJob && finalJob.phase === "delivering" && sameDeliveryEvidence(finalRow, original)) {
      this.options.scheduleWakeup?.(
        boundedAdd(timestamp(this.now()), SAFE_RETRY_DELAY_MS),
        () => this.pump(),
      );
    }
    return false;
  }

  private change(
    part: DeliveryPart,
    state: ProjectedDeliveryTransitionInput["state"],
    attemptCount: number,
    changes: Partial<Pick<ProjectedDeliveryTransitionInput,
      "telegramMessageId" | "nextAttemptAt" | "lastErrorCode" | "attention"
      | "allowUncertainRetry" | "allowFailedRetry" | "allowPendingFailure">> = {},
    expectedJobVersion?: number,
    expectedJobSnapshot?: TelegramJob,
  ) {
    const job = expectedJobSnapshot ?? this.requireJob(part.jobId);
    const jobVersion = expectedJobVersion ?? job.version;
    return this.options.store.transitionDeliveryAndProject({
      jobId: part.jobId, partKey: part.partKey, state, attemptCount,
      expectedState: part.state, expectedAttemptCount: part.attemptCount,
      expectedContentHash: part.contentHash,
      expectedJobVersion: jobVersion, eventId: boundedId(this.createId()),
      updatedAt: monotonicNow(this.now, job.updatedAt),
      ...changes,
    });
  }

  private requireJob(jobId: string): TelegramJob {
    const job = this.options.store.get(boundedId(jobId));
    if (!job) throw new Error("Unknown Telegram job");
    return job;
  }
}

class TelegramDeliveryTimeoutError extends Error {}
function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => { if (!settled) { settled = true; clearTimeout(timer); callback(); } };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new TelegramDeliveryTimeoutError("Telegram delivery timed out")));
    }, timeoutMs);
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function required(code: string, actions: readonly string[]): JobAttention { return { kind: "required", code, actions }; }
function commentaryOrdinal(partKey: string): number {
  const match = /^summary:(\d{4}):\d{4}$/.exec(partKey);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
function retryAttention(job: TelegramJob, target: DeliveryPart, rows: readonly DeliveryPart[]): JobAttention | undefined {
  if (job.attention.kind !== "required" || rows.some((row) => row.partKey !== target.partKey
    && (row.state === "failed" || row.state === "uncertain"))) return undefined;
  const owned = (job.attention.code === "telegram_delivery_failed"
      && (target.lastErrorCode === "telegram_permanent" || target.lastErrorCode === "telegram_edit_failed"))
    || (job.attention.code === "delivery_media_unavailable" && target.lastErrorCode === "delivery_media_unavailable")
    || (job.attention.code === "delivery_payload_corrupt" && target.lastErrorCode === "delivery_payload_corrupt")
    || (job.attention.code === "telegram_rich_fallback_failed"
      && target.lastErrorCode === "telegram_rich_fallback_failed");
  return owned ? { kind: "none" } : undefined;
}
function isRichFallbackFailure(job: TelegramJob): boolean {
  return job.attention.kind === "required" && job.attention.code === "telegram_rich_fallback_failed";
}
function sameDeliveryEvidence(current: DeliveryPart | undefined, expected: DeliveryPart): current is DeliveryPart {
  return current !== undefined && current.state === expected.state
    && current.attemptCount === expected.attemptCount && current.contentHash === expected.contentHash;
}
function boundedId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.includes("\0")) throw new Error("Invalid id");
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid timestamp");
  return value;
}
function positiveMessageId(value: unknown): number {
  if (!positiveInteger(value)) throw new Error("Invalid Telegram message id");
  return value;
}
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function boundedPositive(value: unknown, maximum: number, name: string): number {
  if (!positiveInteger(value) || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function monotonicNow(now: () => number, previous: number): number { return Math.max(timestamp(now()), previous); }
function boundedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid timestamp");
  return value;
}
function isConflict(error: unknown): boolean {
  return error instanceof Error && (error.message === "Telegram delivery conflict" || error.message === "Telegram job version conflict");
}
