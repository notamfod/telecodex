import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import type { DeliveryPart } from "./telegram-job-store.js";
import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
} from "./telegram-response-plan.js";

export class DeliveryMediaUnavailableError extends Error {}

export function validatedPayload(part: DeliveryPart): TelegramDeliveryPayload {
  const payload = normalizeTelegramDeliveryPayload(part.payload);
  if (hashTelegramDeliveryPayload(payload) !== part.contentHash) throw new Error("Invalid delivery payload hash");
  return payload;
}

export function safePayload(part: DeliveryPart, attachmentRoot: string | undefined): TelegramDeliveryPayload {
  const payload = validatedPayload(part);
  assertPayloadMediaAvailable(payload, attachmentRoot);
  return payload;
}

export function assertPayloadMediaAvailable(
  payload: TelegramDeliveryPayload,
  attachmentRoot: string | undefined,
): void {
  try {
    if (payload.operation === "send_media") assertContainedAttachment(attachmentRoot, payload.path);
    if (isRich(payload)) for (const media of payload.media) assertContainedAttachment(attachmentRoot, media.path);
  } catch { throw new DeliveryMediaUnavailableError("Delivery media unavailable"); }
}

export function isKnownEdit(payload: TelegramDeliveryPayload): payload is Extract<TelegramDeliveryPayload,
  { operation: "edit_text" | "edit_rich" }> {
  return payload.operation === "edit_text" || payload.operation === "edit_rich";
}

export function isRich(payload: TelegramDeliveryPayload): payload is Extract<TelegramDeliveryPayload,
  { operation: "send_rich" | "edit_rich" }> {
  return payload.operation === "send_rich" || payload.operation === "edit_rich";
}

function assertContainedAttachment(root: string | undefined, relative: string): void {
  if (!root) throw new Error("Attachment storage unavailable");
  const resolvedRoot = path.resolve(root);
  if (realpathSync(resolvedRoot) !== resolvedRoot || !lstatSync(resolvedRoot).isDirectory()) {
    throw new Error("Unsafe attachment root");
  }
  const candidate = path.resolve(resolvedRoot, ...relative.split("/"));
  const realCandidate = realpathSync(candidate);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`) || !realCandidate.startsWith(`${resolvedRoot}${path.sep}`)
    || lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isFile()) {
    throw new Error("Unsafe attachment path");
  }
}
