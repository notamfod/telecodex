import { isDeepStrictEqual } from "node:util";

import type { CodexThreadRecord } from "./codex-state.js";
import type { TelegramWorkSource } from "./telegram-job-ingress.js";
import type { DeliveryPart, TelegramJob } from "./telegram-job-store.js";
import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
  type TelegramLegacyDeliveryPayload,
} from "./telegram-response-plan.js";
import { buildTopicName } from "./topic-sync.js";

export interface TelegramTopicDestination {
  readonly chatId: number;
  readonly messageThreadId: number;
}

export interface ReboundTelegramDelivery {
  readonly partKey: string;
  readonly payload: TelegramDeliveryPayload;
  readonly contentHash: string;
}

export interface TelegramTopicRecoveryCandidate {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly threadId: string;
  readonly topicName: string;
  readonly oldDestination: TelegramTopicDestination;
  readonly parts: readonly ReboundTelegramDelivery[];
  readonly anchorPlan: ReboundTelegramDelivery;
}

export interface TelegramTopicRecoveryEligibilityInput {
  readonly job: TelegramJob;
  readonly source: TelegramWorkSource;
  readonly deliveries: readonly DeliveryPart[];
  readonly anchorPlan: { readonly payload: unknown; readonly contentHash: string } | null;
  readonly thread: CodexThreadRecord | null;
}

export function planTelegramTopicRecovery(
  input: TelegramTopicRecoveryEligibilityInput,
): TelegramTopicRecoveryCandidate | null {
  try {
    const { job, source, deliveries, anchorPlan, thread } = input;
    if (job.phase !== "delivering" || !validThread(job.threadId, thread) || job.responsePlan === undefined
      || Object.hasOwn(source, "targetProvision")) return null;
    const oldDestination = destination(source.targetContext ?? source);
    if (!oldDestination || !validResponsePlan(job) || !validJobProjection(job)) return null;
    if (!anchorPlan || !canonicalPayload(anchorPlan.payload, anchorPlan.contentHash)) return null;

    const anchor = deliveries.filter((part) => part.partKey === "status-anchor");
    const ordinary = deliveries.filter((part) => part.partKey !== "status-anchor");
    if (anchor.length !== 1 || anchor[0].jobId !== job.id || ordinary.length !== job.responsePlan.length
      || !validAnchor(anchor[0], anchorPlan, oldDestination)) {
      return null;
    }

    const parts: ReboundTelegramDelivery[] = [];
    for (let index = 0; index < job.responsePlan.length; index += 1) {
      const planned = job.responsePlan[index];
      const matches = ordinary.filter((part) => part.partKey === planned.partId);
      if (matches.length !== 1 || !validPendingPart(matches[0], job.id, planned.partId, planned.kind, index)) return null;
      const rebound = rebindTelegramTopicPayload(matches[0].payload, oldDestination, oldDestination);
      parts.push({ partKey: matches[0].partKey, ...rebound });
    }
    if (new Set(parts.map((part) => part.partKey)).size !== parts.length) return null;

    const reboundAnchor = rebindTelegramTopicPayload(anchorPlan.payload, oldDestination, oldDestination);
    return {
      jobId: job.id,
      expectedVersion: job.version,
      threadId: thread.id,
      topicName: buildTopicName(thread),
      oldDestination,
      parts,
      anchorPlan: { partKey: anchor[0].partKey, ...reboundAnchor },
    };
  } catch {
    return null;
  }
}

export function rebindTelegramTopicPayload(
  payload: unknown,
  oldDestination: TelegramTopicDestination,
  newDestination: TelegramTopicDestination,
): { readonly payload: TelegramDeliveryPayload; readonly contentHash: string } {
  try {
    if (!validDestination(oldDestination) || !validDestination(newDestination)) invalid();
    const normalized = normalizeTelegramDeliveryPayload(payload);
    if (!isSendPayload(normalized) || !matchesDestination(normalized, oldDestination)) invalid();
    const rebound = rewriteSendPayload(normalized, newDestination);
    const canonical = normalizeTelegramDeliveryPayload(rebound);
    return { payload: canonical, contentHash: hashTelegramDeliveryPayload(canonical) };
  } catch {
    throw new Error("Invalid Telegram topic recovery payload");
  }
}

function validAnchor(
  row: DeliveryPart | undefined,
  plan: NonNullable<TelegramTopicRecoveryEligibilityInput["anchorPlan"]>,
  destination: TelegramTopicDestination,
): row is DeliveryPart {
  return row !== undefined
    && row.jobId.length > 0
    && row.kind === "status-anchor"
    && row.ordinal === 0
    && row.state === "failed"
    && row.telegramMessageId === null
    && Number.isSafeInteger(row.attemptCount) && row.attemptCount >= 0
    && (row.nextAttemptAt === null || (Number.isSafeInteger(row.nextAttemptAt) && row.nextAttemptAt >= 0))
    && (row.lastErrorCode === null || typeof row.lastErrorCode === "string")
    && canonicalPayload(row.payload, row.contentHash)
    && isDeepStrictEqual(row.payload, plan.payload)
    && row.contentHash === plan.contentHash
    && isTopicBoundSend(row.payload, destination);
}

function validPendingPart(
  row: DeliveryPart,
  jobId: string,
  partKey: string,
  kind: string,
  ordinal: number,
): boolean {
  return row.jobId === jobId
    && row.partKey === partKey
    && row.kind === kind
    && row.ordinal === ordinal
    && row.state === "pending"
    && row.telegramMessageId === null
    && row.attemptCount === 0
    && row.nextAttemptAt === null
    && row.lastErrorCode === null
    && canonicalPayload(row.payload, row.contentHash);
}

function validJobProjection(job: TelegramJob): boolean {
  if (!job.responsePlan || job.deliveries.length !== job.responsePlan.length) return false;
  return job.responsePlan.every((part) => {
    const matches = job.deliveries.filter((delivery) => delivery.partId === part.partId);
    return matches.length === 1
      && matches[0].state === "pending"
      && matches[0].attempts === 0
      && matches[0].messageId === null
      && matches[0].deliveredAt === null;
  });
}

function validResponsePlan(job: TelegramJob): boolean {
  if (!job.responsePlan || !Number.isSafeInteger(job.version) || job.version < 0 || typeof job.id !== "string" || !job.id) {
    return false;
  }
  const ids = new Set<string>();
  return job.responsePlan.every((part) => {
    const validKind = part.kind === "final" || part.kind === "summary" || part.kind === "attachment" || part.kind === "notice";
    if (typeof part.partId !== "string" || !part.partId || ids.has(part.partId) || !validKind) return false;
    ids.add(part.partId);
    return true;
  });
}

function validThread(threadId: unknown, thread: CodexThreadRecord | null): thread is CodexThreadRecord {
  return thread !== null && typeof threadId === "string" && threadId.length > 0 && thread.id === threadId;
}

function destination(value: unknown): TelegramTopicDestination | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TelegramTopicDestination>;
  return validDestination(candidate) ? { chatId: candidate.chatId, messageThreadId: candidate.messageThreadId } : null;
}

function validDestination(value: Partial<TelegramTopicDestination>): value is TelegramTopicDestination {
  return value.chatId !== undefined && Number.isSafeInteger(value.chatId) && value.chatId !== 0
    && value.messageThreadId !== undefined && Number.isSafeInteger(value.messageThreadId) && value.messageThreadId > 0;
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

function isTopicBoundSend(payload: unknown, expected: TelegramTopicDestination): boolean {
  try {
    const normalized = normalizeTelegramDeliveryPayload(payload);
    return isSendPayload(normalized) && matchesDestination(normalized, expected);
  } catch {
    return false;
  }
}

function isSendPayload(payload: TelegramDeliveryPayload): payload is Exclude<TelegramDeliveryPayload, { readonly operation: "edit_text" | "edit_rich" }> {
  return payload.operation === "send_text" || payload.operation === "send_media" || payload.operation === "send_rich";
}

function matchesDestination(
  payload: Exclude<TelegramDeliveryPayload, { readonly operation: "edit_text" | "edit_rich" }>,
  expected: TelegramTopicDestination,
): boolean {
  return payload.chatId === expected.chatId
    && payload.messageThreadId === expected.messageThreadId
    && (payload.operation !== "send_rich" || payload.fallbackParts.every((part) => matchesLegacyDestination(part.payload, expected)));
}

function matchesLegacyDestination(payload: TelegramLegacyDeliveryPayload, expected: TelegramTopicDestination): boolean {
  return payload.operation !== "edit_text"
    && payload.chatId === expected.chatId
    && payload.messageThreadId === expected.messageThreadId;
}

function rewriteSendPayload(
  payload: Exclude<TelegramDeliveryPayload, { readonly operation: "edit_text" | "edit_rich" }>,
  destination: TelegramTopicDestination,
): TelegramDeliveryPayload {
  if (payload.operation === "send_rich") {
    return {
      ...payload,
      ...destination,
      fallbackParts: payload.fallbackParts.map((part) => ({
        ...part,
        payload: rewriteLegacyPayload(part.payload, destination),
      })),
    };
  }
  return { ...payload, ...destination };
}

function rewriteLegacyPayload(payload: TelegramLegacyDeliveryPayload, destination: TelegramTopicDestination): TelegramLegacyDeliveryPayload {
  if (payload.operation === "edit_text") invalid();
  return { ...payload, ...destination };
}

function invalid(): never {
  throw new Error("Invalid Telegram topic recovery payload");
}
