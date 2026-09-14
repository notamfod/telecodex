import { isDeepStrictEqual } from "node:util";

import type { DeliveryPart } from "./telegram-job-store.js";
import type { TelegramJob } from "./telegram-job-types.js";
import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
} from "./telegram-response-plan.js";

type RichPayload = Extract<TelegramDeliveryPayload, { operation: "send_rich" | "edit_rich" }>;

export function exactRichFallbackInstalled(
  before: TelegramJob,
  primary: DeliveryPart,
  payload: RichPayload,
  current: TelegramJob,
  rows: readonly DeliveryPart[],
): boolean {
  if ((current.phase !== "delivering" && current.phase !== "terminal") || current.responsePlan === undefined
    || rows.length !== current.responsePlan.length + 1 || !validProjection(current, rows)) return false;
  const anchor = rows.find((row) => row.partKey === "status-anchor");
  if (!anchor || anchor.kind !== "status-anchor" || anchor.ordinal !== 0 || !validRow(anchor)) return false;
  if (payload.operation === "edit_rich" || primary.partKey === "status-anchor") {
    const fallback = payload.fallbackParts[0];
    const row = rows.find((candidate) => candidate.partKey === primary.partKey);
    return payload.fallbackParts.length === 1 && fallback !== undefined && row !== undefined
      && row.partKey === "status-anchor"
      && (payload.operation !== "edit_rich" || row.telegramMessageId === payload.messageId)
      && row.attemptCount >= 0 && row.payload !== undefined
      && isDeepStrictEqual(row.payload, fallback.payload)
      && row.contentHash === hashTelegramDeliveryPayload(fallback.payload)
      && isDeepStrictEqual(current.responsePlan, before.responsePlan)
      && !rows.some((candidate) => candidate.partKey === fallback.partKey);
  }
  const originalIndex = before.responsePlan?.findIndex((part) => part.partId === primary.partKey) ?? -1;
  if (rows.some((row) => row.partKey === primary.partKey)) return false;
  const fallbackPlan = payload.fallbackParts.map((part) => ({ partId: part.partKey, kind: part.kind }));
  if (originalIndex >= 0) {
    const expectedPlan = [
      ...before.responsePlan!.slice(0, originalIndex), ...fallbackPlan,
      ...before.responsePlan!.slice(originalIndex + 1),
    ];
    if (!isDeepStrictEqual(current.responsePlan, expectedPlan)) return false;
  } else if (!isDeepStrictEqual(current.responsePlan.slice(primary.ordinal,
    primary.ordinal + fallbackPlan.length), fallbackPlan)) return false;
  return payload.fallbackParts.every((fallback, index) => {
    const row = rows.find((candidate) => candidate.partKey === fallback.partKey);
    return row !== undefined && row.ordinal === primary.ordinal + index && row.kind === fallback.kind
      && isDeepStrictEqual(row.payload, fallback.payload)
      && row.contentHash === hashTelegramDeliveryPayload(fallback.payload);
  });
}

function validProjection(job: TelegramJob, rows: readonly DeliveryPart[]): boolean {
  const ordinary = rows.filter((row) => row.partKey !== "status-anchor");
  if (ordinary.length !== job.responsePlan!.length || job.deliveries.length !== ordinary.length) return false;
  return job.responsePlan!.every((planned, ordinal) => {
    const row = ordinary.find((candidate) => candidate.partKey === planned.partId);
    return row !== undefined && row.ordinal === ordinal && row.kind === planned.kind && validRow(row)
      && isDeepStrictEqual(job.deliveries[ordinal], {
        partId: row.partKey, state: row.state, attempts: row.attemptCount,
        messageId: row.telegramMessageId, deliveredAt: row.state === "delivered" ? row.updatedAt : null,
      });
  });
}

function validRow(row: DeliveryPart): boolean {
  try {
    const payload = normalizeTelegramDeliveryPayload(row.payload);
    if (!isDeepStrictEqual(payload, row.payload) || hashTelegramDeliveryPayload(payload) !== row.contentHash) return false;
    return payload.operation !== "edit_text" || row.telegramMessageId === payload.messageId;
  } catch { return false; }
}
