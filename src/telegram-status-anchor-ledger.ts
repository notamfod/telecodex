import { isDeepStrictEqual } from "node:util";

import type { DeliveryPart, NewDeliveryPart } from "./telegram-delivery-ledger.js";
import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
} from "./telegram-response-plan.js";

const JOB_ID_MAX_LENGTH = 128;
const DELIVERY_TEXT_MAX_LENGTH = 128;

export const STATUS_CANDIDATE_WHERE = `json_extract(projection_json, '$.phase') != 'terminal' OR NOT (
  EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id AND deliveries.part_key = 'status-anchor'
    AND deliveries.state = 'delivered' AND deliveries.telegram_message_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id AND deliveries.state != 'delivered')
  AND (SELECT count(*) FROM deliveries WHERE deliveries.job_id = jobs.id AND deliveries.part_key != 'status-anchor')
    = COALESCE(json_array_length(json_extract(jobs.projection_json, '$.responsePlan')), 0)
)`;

export interface PrepareStatusAnchorRevisionInput {
  readonly jobId: string;
  readonly expectedJobVersion: number;
  readonly expectedAttemptCount: number;
  readonly expectedState: "pending" | "delivered" | "sending";
  readonly payload: unknown;
  readonly nextAttemptAt: number;
  readonly updatedAt: number;
}

export type PrepareStatusAnchorRevisionResult =
  | { readonly kind: "prepared"; readonly delivery: DeliveryPart }
  | { readonly kind: "unchanged"; readonly delivery: DeliveryPart };

export interface FinishStatusAnchorRevisionInput {
  readonly jobId: string;
  readonly expectedAttemptCount: number;
  readonly expectedContentHash: string;
  /** Monotonic prepared-lease token; prevents stale same-content lease completion. */
  readonly expectedLeaseUntil: number;
  readonly state: "pending" | "delivered" | "uncertain" | "failed";
  readonly attemptCount: number;
  readonly telegramMessageId?: number | null;
  readonly nextAttemptAt?: number | null;
  readonly lastErrorCode?: string | null;
  readonly updatedAt: number;
}

export interface ReplaceMissingStatusAnchorEditInput {
  readonly jobId: string;
  readonly expectedAttemptCount: number;
  readonly expectedContentHash: string;
  readonly expectedLeaseUntil: number;
  readonly expectedMessageId: number;
  readonly replacementPayload: unknown;
  readonly updatedAt: number;
}

export interface MissingStatusAnchorReplacementValues {
  readonly currentPayload: Extract<TelegramDeliveryPayload, { operation: "edit_text" | "edit_rich" }>;
  readonly payload: Extract<TelegramDeliveryPayload, { operation: "send_text" | "send_rich" }>;
  readonly contentHash: string;
  readonly attemptCount: number;
}

export interface StatusAnchorFinishValues {
  readonly telegramMessageId: number | null;
  readonly nextAttemptAt: number | null;
  readonly lastErrorCode: string | null;
}

export function prepareStatusAnchorPayload(
  input: PrepareStatusAnchorRevisionInput,
  current: DeliveryPart,
): { readonly payload: TelegramDeliveryPayload; readonly contentHash: string; readonly unchanged: boolean } {
  validatePreparation(input);
  const requested = normalizeTelegramDeliveryPayload(input.payload);
  if (requested.operation === "send_media" || requested.operation === "send_rich") invalidRevision();
  const payload = statusAnchorPayload(requested, current.telegramMessageId);
  const contentHash = hashTelegramDeliveryPayload(payload);
  const unchanged = current.state === "delivered" && (
    samePayload(current, requested, hashTelegramDeliveryPayload(requested))
    || samePayload(current, payload, contentHash)
  );
  return { payload, contentHash, unchanged };
}

export function statusAnchorFinishValues(
  input: FinishStatusAnchorRevisionInput,
  current: DeliveryPart,
): StatusAnchorFinishValues {
  validateFinish(input);
  const suppliedMessageId = input.telegramMessageId ?? null;
  if (current.telegramMessageId !== null && suppliedMessageId !== null
    && suppliedMessageId !== current.telegramMessageId) conflict();
  const telegramMessageId = current.telegramMessageId ?? suppliedMessageId;
  if (input.state === "delivered") {
    if (input.attemptCount !== input.expectedAttemptCount + 1 || telegramMessageId === null) invalidRevision();
    return { telegramMessageId, nextAttemptAt: null, lastErrorCode: null };
  }
  if (suppliedMessageId !== null || input.lastErrorCode === undefined || input.lastErrorCode === null) invalidRevision();
  if (input.state === "uncertain") {
    if (current.telegramMessageId !== null || input.attemptCount !== input.expectedAttemptCount + 1) invalidRevision();
    return { telegramMessageId: null, nextAttemptAt: null, lastErrorCode: input.lastErrorCode };
  }
  if (input.state === "pending") {
    if (input.nextAttemptAt === undefined || input.nextAttemptAt === null || input.nextAttemptAt < input.updatedAt) invalidRevision();
    return { telegramMessageId, nextAttemptAt: input.nextAttemptAt, lastErrorCode: input.lastErrorCode };
  }
  return { telegramMessageId, nextAttemptAt: null, lastErrorCode: input.lastErrorCode };
}

export function replaceMissingStatusAnchorEditValues(
  input: ReplaceMissingStatusAnchorEditInput,
  current: DeliveryPart,
): MissingStatusAnchorReplacementValues {
  validateReplacement(input);
  if (current.jobId !== input.jobId || current.partKey !== "status-anchor"
    || current.kind !== "status-anchor" || current.ordinal !== 0 || current.state !== "sending"
    || current.attemptCount !== input.expectedAttemptCount
    || current.contentHash !== input.expectedContentHash
    || current.nextAttemptAt !== input.expectedLeaseUntil
    || current.telegramMessageId !== input.expectedMessageId) conflict();
  if (input.updatedAt < current.updatedAt) throw new Error("Telegram delivery cannot move backwards");
  const currentPayload = normalizeTelegramDeliveryPayload(current.payload);
  if ((currentPayload.operation !== "edit_text" && currentPayload.operation !== "edit_rich")
    || currentPayload.messageId !== input.expectedMessageId
    || !samePayload(current, currentPayload, hashTelegramDeliveryPayload(currentPayload))) conflict();
  const payload = normalizeTelegramDeliveryPayload(input.replacementPayload);
  if ((payload.operation !== "send_text" && payload.operation !== "send_rich")
    || !isDeepStrictEqual(payload, missingStatusAnchorSendPayload(currentPayload, payload.messageThreadId))) conflict();
  return {
    currentPayload,
    payload,
    contentHash: hashTelegramDeliveryPayload(payload),
    attemptCount: input.expectedAttemptCount + 1,
  };
}

export function missingStatusAnchorSendPayload(
  payload: MissingStatusAnchorReplacementValues["currentPayload"],
  messageThreadId: number | null,
): MissingStatusAnchorReplacementValues["payload"] {
  if (payload.operation === "edit_text") {
    return { operation: "send_text", chatId: payload.chatId, messageThreadId, text: payload.text };
  }
  return {
    operation: "send_rich", chatId: payload.chatId, messageThreadId,
    markdown: payload.markdown, media: payload.media,
    fallbackParts: payload.fallbackParts.map(part => {
      if (part.payload.operation !== "edit_text") conflict();
      return { ...part, payload: {
        operation: "send_text", chatId: payload.chatId, messageThreadId, text: part.payload.text,
      } };
    }),
  };
}

export function reconcilePlannedStatusAnchor(
  parts: readonly NewDeliveryPart[],
  current: DeliveryPart | null,
): readonly NewDeliveryPart[] {
  if (current === null) return parts;
  if (current.state === "sending") throw new Error("Telegram status anchor is busy");
  return parts.map((part) => {
    if (part.partKey !== "status-anchor") return part;
    const requested = normalizeTelegramDeliveryPayload(part.payload);
    const plannedMessageId = part.telegramMessageId
      ?? (requested.operation === "edit_text" || requested.operation === "edit_rich" ? requested.messageId : null);
    if (current.telegramMessageId !== null && plannedMessageId !== null
      && current.telegramMessageId !== plannedMessageId) throw new Error("Telegram response plan conflict");
    const messageId = current.telegramMessageId ?? plannedMessageId;
    const payload = statusAnchorPayload(requested, messageId);
    const unknownDelivered = current.state === "delivered" && current.telegramMessageId === null;
    const preserveFailure = current.state === "uncertain" || current.state === "failed" || unknownDelivered;
    return {
      ...part,
      state: preserveFailure ? (unknownDelivered ? "uncertain" : current.state) : part.state,
      payload,
      contentHash: hashTelegramDeliveryPayload(payload),
      telegramMessageId: messageId,
      attemptCount: Math.max(part.attemptCount ?? 0, current.attemptCount),
      nextAttemptAt: preserveFailure ? current.nextAttemptAt : part.nextAttemptAt,
      lastErrorCode: unknownDelivered
        ? "telegram_anchor_message_unknown"
        : preserveFailure ? current.lastErrorCode : part.lastErrorCode,
    };
  });
}

function validatePreparation(value: PrepareStatusAnchorRevisionInput): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH);
  nonNegative(value.expectedJobVersion, "expectedJobVersion");
  nonNegative(value.expectedAttemptCount, "expectedAttemptCount");
  nonNegative(value.nextAttemptAt, "nextAttemptAt");
  nonNegative(value.updatedAt, "updatedAt");
  if (value.nextAttemptAt < value.updatedAt
    || !["pending", "delivered", "sending"].includes(value.expectedState)) invalidRevision();
}

function validateFinish(value: FinishStatusAnchorRevisionInput): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH);
  if (!/^[0-9a-f]{64}$/.test(value.expectedContentHash)) throw new Error("Invalid contentHash");
  nonNegative(value.expectedAttemptCount, "expectedAttemptCount");
  nonNegative(value.expectedLeaseUntil, "expectedLeaseUntil");
  nonNegative(value.attemptCount, "attemptCount");
  nonNegative(value.updatedAt, "updatedAt");
  if (!["pending", "delivered", "uncertain", "failed"].includes(value.state)
    || value.attemptCount < value.expectedAttemptCount
    || value.attemptCount > value.expectedAttemptCount + 1) invalidRevision();
  if (value.telegramMessageId !== undefined && value.telegramMessageId !== null) positive(value.telegramMessageId, "telegramMessageId");
  if (value.nextAttemptAt !== undefined && value.nextAttemptAt !== null) nonNegative(value.nextAttemptAt, "nextAttemptAt");
  if (value.lastErrorCode !== undefined && value.lastErrorCode !== null) bounded(value.lastErrorCode, "lastErrorCode", DELIVERY_TEXT_MAX_LENGTH);
}

function validateReplacement(value: ReplaceMissingStatusAnchorEditInput): void {
  bounded(value.jobId, "jobId", JOB_ID_MAX_LENGTH);
  if (!/^[0-9a-f]{64}$/.test(value.expectedContentHash)) throw new Error("Invalid contentHash");
  nonNegative(value.expectedAttemptCount, "expectedAttemptCount");
  if (value.expectedAttemptCount === Number.MAX_SAFE_INTEGER) invalidRevision();
  nonNegative(value.expectedLeaseUntil, "expectedLeaseUntil");
  positive(value.expectedMessageId, "expectedMessageId");
  nonNegative(value.updatedAt, "updatedAt");
}

function statusAnchorPayload(payload: TelegramDeliveryPayload, messageId: number | null): TelegramDeliveryPayload {
  if (payload.operation === "send_media" || payload.operation === "send_rich") invalidRevision();
  if (messageId === null) {
    if (payload.operation !== "send_text") conflict();
    return payload;
  }
  if (payload.operation === "edit_text" || payload.operation === "edit_rich") {
    if (payload.messageId !== messageId) conflict();
    return payload;
  }
  return { operation: "edit_text", chatId: payload.chatId, messageId, text: payload.text };
}

function samePayload(current: DeliveryPart, payload: TelegramDeliveryPayload, contentHash: string): boolean {
  return current.contentHash === contentHash && isDeepStrictEqual(current.payload, payload);
}

function conflict(): never { throw new Error("Telegram delivery conflict"); }
function invalidRevision(): never { throw new Error("Invalid Telegram status anchor revision"); }
function nonNegative(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}
function positive(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
}
function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
