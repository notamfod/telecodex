import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import type { CodexThreadRecord } from "./codex-state.js";
import type { TelegramWorkSource } from "./telegram-job-ingress.js";
import { validateDelivery } from "./telegram-delivery-ledger.js";
import type { DeliveryPart, TelegramJob } from "./telegram-job-store.js";
import { isTelegramDeliveryProjectionValid } from "./telegram-job-runtime.js";
import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
  type TelegramLegacyDeliveryPayload,
} from "./telegram-response-plan.js";
import type { TelegramTopicRecoveryRecord } from "./telegram-topic-recovery-ledger.js";
import { encodeCanonicalTopicRecoverySource } from "./telegram-topic-recovery-source-codec.js";
import type { TelegramTopicDestination } from "./telegram-topic-recovery.js";

export interface TelegramTopicResumeCandidate {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly threadId: string;
  readonly destination: TelegramTopicDestination;
  readonly anchorPartKey: "status-anchor";
  readonly anchorAttemptCount: number;
}

export interface TelegramTopicResumeEligibilityInput {
  readonly job: TelegramJob;
  readonly source: TelegramWorkSource;
  readonly deliveries: readonly DeliveryPart[];
  readonly anchorPlan: { readonly payload: unknown; readonly contentHash: string } | null;
  readonly thread: CodexThreadRecord | null;
  readonly recovery: TelegramTopicRecoveryRecord | null;
  readonly hasExistingAttempt: boolean;
  readonly forumChatId: number;
  readonly hasThreadTopicBinding: boolean;
  readonly quarantined: boolean;
}

export function planTelegramTopicResume(
  input: TelegramTopicResumeEligibilityInput,
): TelegramTopicResumeCandidate | null {
  try {
    const { job, deliveries, anchorPlan, recovery } = input;
    if (input.hasExistingAttempt || input.quarantined || !input.hasThreadTopicBinding
      || job.phase !== "delivering" || !validJob(job) || !validSource(input.source, job)
      || !validThread(job.threadId, input.thread)) return null;
    const destination = sourceDestination(input.source);
    if (!destination || destination.chatId !== input.forumChatId
      || !validRecovery(recovery, job, destination) || !anchorPlan
      || !canonicalPayload(anchorPlan.payload, anchorPlan.contentHash)) return null;

    const anchors = deliveries.filter((part) => part.partKey === "status-anchor");
    const followers = deliveries.filter((part) => part.partKey !== "status-anchor");
    const anchor = anchors[0];
    if (job.responsePlan!.length !== 2 || followers.length !== 2 || anchors.length !== 1
      || followers.length !== job.responsePlan!.length
      || deliveries.length !== job.responsePlan!.length + 1
      || !validAnchor(anchor, job.id, destination, anchorPlan)) return null;

    for (let ordinal = 0; ordinal < job.responsePlan!.length; ordinal += 1) {
      const planned = job.responsePlan![ordinal]!;
      const matches = followers.filter((part) => part.partKey === planned.partId);
      if (matches.length !== 1 || !validFollower(matches[0]!, job.id, planned.kind, ordinal, destination)) {
        return null;
      }
    }
    if (!isTelegramDeliveryProjectionValid(job.responsePlan!, job.deliveries)) return null;
    const projection = job.responsePlan!.map((planned) => {
      const row = followers.find((part) => part.partKey === planned.partId)!;
      return {
        partId: row.partKey,
        state: row.state,
        attempts: row.attemptCount,
        messageId: row.telegramMessageId,
        deliveredAt: null,
      };
    });
    if (!isDeepStrictEqual(job.deliveries, projection)) return null;

    return {
      jobId: job.id,
      expectedVersion: job.version,
      threadId: input.thread!.id,
      destination,
      anchorPartKey: "status-anchor",
      anchorAttemptCount: anchor!.attemptCount,
    };
  } catch {
    return null;
  }
}

function validJob(job: TelegramJob): boolean {
  if (!job.responsePlan || typeof job.id !== "string" || job.id.length === 0
    || !Number.isSafeInteger(job.version) || job.version < 1) return false;
  const partIds = new Set<string>();
  return job.responsePlan.every((part) => {
    if (typeof part.partId !== "string" || part.partId.length === 0 || partIds.has(part.partId)
      || (part.kind !== "final" && part.kind !== "summary"
        && part.kind !== "attachment" && part.kind !== "notice")) return false;
    partIds.add(part.partId);
    return true;
  });
}

function validSource(source: TelegramWorkSource, job: TelegramJob): boolean {
  try {
    const canonical = JSON.parse(encodeCanonicalTopicRecoverySource(source));
    return isDeepStrictEqual(source, canonical)
      && source.botId === job.source.botId && source.updateId === job.source.updateId
      && !Object.hasOwn(source, "targetProvision");
  } catch {
    return false;
  }
}

function sourceDestination(source: TelegramWorkSource): TelegramTopicDestination | null {
  const target = source.targetContext ?? source;
  if (!Number.isSafeInteger(target.chatId) || target.chatId === 0
    || !Number.isSafeInteger(target.messageThreadId) || target.messageThreadId === null
    || target.messageThreadId < 1) return null;
  return { chatId: target.chatId, messageThreadId: target.messageThreadId };
}

function validThread(threadId: unknown, thread: CodexThreadRecord | null): thread is CodexThreadRecord {
  return thread !== null && typeof threadId === "string" && threadId.length > 0 && thread.id === threadId
    && typeof thread.title === "string" && thread.title.trim().length > 0
    && typeof thread.cwd === "string" && path.isAbsolute(thread.cwd)
    && path.resolve(thread.cwd) !== path.parse(path.resolve(thread.cwd)).root;
}

function validRecovery(
  recovery: TelegramTopicRecoveryRecord | null,
  job: TelegramJob,
  destination: TelegramTopicDestination,
): recovery is TelegramTopicRecoveryRecord {
  return recovery !== null
    && recovery.jobId === job.id
    && recovery.state === "failed"
    && recovery.reasonCode === "TOPIC_RECOVERY_FAILED"
    && recovery.newMessageThreadId === null
    && recovery.nextAttemptAt === null
    && recovery.currentJobVersion === job.version
    && recovery.reservedJobVersion > 0
    && recovery.reservedJobVersion < recovery.currentJobVersion
    && recovery.updatedAt >= recovery.startedAt
    && isDeepStrictEqual(recovery.oldDestination, destination);
}

function validAnchor(
  row: DeliveryPart | undefined,
  jobId: string,
  destination: TelegramTopicDestination,
  plan: NonNullable<TelegramTopicResumeEligibilityInput["anchorPlan"]>,
): row is DeliveryPart {
  return row !== undefined && validDeliveryRow(row)
    && row.jobId === jobId && row.kind === "status-anchor" && row.ordinal === 0
    && row.state === "failed" && row.telegramMessageId === null
    && Number.isSafeInteger(row.attemptCount) && row.attemptCount > 0
    && row.nextAttemptAt === null
    && canonicalPayload(row.payload, row.contentHash)
    && isDeepStrictEqual(row.payload, plan.payload) && row.contentHash === plan.contentHash
    && payloadMatchesDestination(row.payload, destination);
}

function validFollower(
  row: DeliveryPart,
  jobId: string,
  kind: string,
  ordinal: number,
  destination: TelegramTopicDestination,
): boolean {
  return validDeliveryRow(row) && row.jobId === jobId && row.kind === kind && row.ordinal === ordinal
    && row.state === "pending" && row.telegramMessageId === null && row.attemptCount === 0
    && row.nextAttemptAt === null && row.lastErrorCode === null
    && canonicalPayload(row.payload, row.contentHash)
    && payloadMatchesDestination(row.payload, destination);
}

function validDeliveryRow(row: DeliveryPart): boolean {
  try {
    validateDelivery(row);
    return true;
  } catch {
    return false;
  }
}

function canonicalPayload(payload: unknown, contentHash: unknown): boolean {
  if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash)) return false;
  try {
    const normalized = normalizeTelegramDeliveryPayload(payload);
    return isDeepStrictEqual(payload, normalized) && hashTelegramDeliveryPayload(normalized) === contentHash;
  } catch {
    return false;
  }
}

function payloadMatchesDestination(payload: unknown, destination: TelegramTopicDestination): boolean {
  try {
    const normalized = normalizeTelegramDeliveryPayload(payload);
    if (!isSendPayload(normalized) || normalized.chatId !== destination.chatId
      || normalized.messageThreadId !== destination.messageThreadId) return false;
    return normalized.operation !== "send_rich" || normalized.fallbackParts.every((fallback) =>
      legacyPayloadMatchesDestination(fallback.payload, destination));
  } catch {
    return false;
  }
}

function isSendPayload(
  payload: TelegramDeliveryPayload,
): payload is Exclude<TelegramDeliveryPayload, { readonly operation: "edit_text" | "edit_rich" }> {
  return payload.operation === "send_text" || payload.operation === "send_media" || payload.operation === "send_rich";
}

function legacyPayloadMatchesDestination(
  payload: TelegramLegacyDeliveryPayload,
  destination: TelegramTopicDestination,
): boolean {
  return payload.operation !== "edit_text"
    && payload.chatId === destination.chatId && payload.messageThreadId === destination.messageThreadId;
}
