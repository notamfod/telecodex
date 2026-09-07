import { createHash } from "node:crypto";

import {
  TELEGRAM_RICH_CHARACTER_LIMIT,
  TELEGRAM_RICH_MEDIA_ID_LIMIT,
  TELEGRAM_RICH_MEDIA_LIMIT,
  isTelegramRichMediaId,
  type TelegramRichImage,
} from "./telegram-rich-message.js";

const TELEGRAM_TEXT_LIMIT = 4_096;
const TELEGRAM_CAPTION_LIMIT = 1_024;
const REFERENCE_LIMIT = 1_024;
const FALLBACK_PART_LIMIT = 256;
const FALLBACK_PART_KEY = /^(final|summary):(\d{4}):fallback:(\d{4})$/;
const DURABLE_CONTROL = /[\u0000-\u001f\u007f]/;

export interface TelegramInlineKeyboard {
  readonly inlineKeyboard: readonly (readonly TelegramInlineButton[])[];
}

export interface TelegramInlineButton {
  readonly text: string;
  readonly callbackData: string;
}

export type TelegramLegacyDeliveryPayload =
  | { readonly operation: "edit_text"; readonly chatId: number; readonly messageId: number; readonly text: string }
  | {
      readonly operation: "send_text";
      readonly chatId: number;
      readonly messageThreadId: number | null;
      readonly text: string;
      readonly replyMarkup?: TelegramInlineKeyboard;
    }
  | {
      readonly operation: "send_media";
      readonly chatId: number;
      readonly messageThreadId: number | null;
      readonly mediaKind: "image" | "file";
      readonly path: string;
      readonly name?: string;
      readonly caption?: string;
    };

export interface TelegramFallbackPart {
  readonly partKey: string;
  readonly kind: "final" | "summary" | "attachment" | "notice";
  readonly payload: TelegramLegacyDeliveryPayload;
}

export type TelegramDeliveryPayload = TelegramLegacyDeliveryPayload
  | {
      readonly operation: "edit_rich";
      readonly chatId: number;
      readonly messageId: number;
      readonly markdown: string;
      readonly media: readonly TelegramRichImage[];
      readonly fallbackParts: readonly TelegramFallbackPart[];
    }
  | {
      readonly operation: "send_rich";
      readonly chatId: number;
      readonly messageThreadId: number | null;
      readonly markdown: string;
      readonly media: readonly TelegramRichImage[];
      readonly replyMarkup?: TelegramInlineKeyboard;
      readonly fallbackParts: readonly TelegramFallbackPart[];
    };

type TelegramFallbackContext =
  | { readonly operation: "edit_rich"; readonly chatId: number; readonly messageId: number }
  | { readonly operation: "send_rich"; readonly chatId: number; readonly messageThreadId: number | null };

export function normalizeTelegramDeliveryPayload(value: unknown): TelegramDeliveryPayload {
  try {
    const raw = plainRecord(value);
    if (raw.operation === "edit_rich") {
      exactKeys(raw, ["operation", "chatId", "messageId", "markdown", "media", "fallbackParts"]);
      const chatId = nonzeroInteger(raw.chatId, "chatId");
      const messageId = positiveInteger(raw.messageId, "messageId");
      return {
        operation: "edit_rich",
        chatId,
        messageId,
        markdown: richMarkdown(raw.markdown),
        media: normalizeRichMedia(raw.media),
        fallbackParts: normalizeFallbackParts(raw.fallbackParts, { operation: "edit_rich", chatId, messageId }),
      };
    }
    if (raw.operation === "send_rich") {
      exactKeys(raw, raw.replyMarkup === undefined
        ? ["operation", "chatId", "messageThreadId", "markdown", "media", "fallbackParts"]
        : ["operation", "chatId", "messageThreadId", "markdown", "media", "replyMarkup", "fallbackParts"]);
      const chatId = nonzeroInteger(raw.chatId, "chatId");
      const messageThreadId = nullablePositiveInteger(raw.messageThreadId, "messageThreadId");
      return {
        operation: "send_rich",
        chatId,
        messageThreadId,
        markdown: richMarkdown(raw.markdown),
        media: normalizeRichMedia(raw.media),
        ...(raw.replyMarkup === undefined ? {} : { replyMarkup: normalizeInlineKeyboard(raw.replyMarkup) }),
        fallbackParts: normalizeFallbackParts(raw.fallbackParts, { operation: "send_rich", chatId, messageThreadId }),
      };
    }
    return normalizeLegacyDeliveryPayload(raw);
  } catch {
    throw new Error("Invalid Telegram delivery payload");
  }
}

export function hashTelegramDeliveryPayload(value: unknown): string {
  return normalizeAndHashTelegramDeliveryPayload(value).contentHash;
}

export function normalizeAndHashTelegramDeliveryPayload(value: unknown): {
  readonly payload: TelegramDeliveryPayload;
  readonly contentHash: string;
} {
  const payload = normalizeTelegramDeliveryPayload(value);
  return { payload, contentHash: hashNormalizedTelegramDeliveryPayload(payload) };
}

function hashNormalizedTelegramDeliveryPayload(value: TelegramDeliveryPayload): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeLegacyDeliveryPayload(value: unknown): TelegramLegacyDeliveryPayload {
  const raw = plainRecord(value);
  if (raw.operation === "edit_text") {
    exactKeys(raw, ["operation", "chatId", "messageId", "text"]);
    return {
      operation: "edit_text",
      chatId: nonzeroInteger(raw.chatId, "chatId"),
      messageId: positiveInteger(raw.messageId, "messageId"),
      text: bounded(raw.text, TELEGRAM_TEXT_LIMIT, "text"),
    };
  }
  if (raw.operation === "send_text") {
    exactKeys(raw, raw.replyMarkup === undefined
      ? ["operation", "chatId", "messageThreadId", "text"]
      : ["operation", "chatId", "messageThreadId", "text", "replyMarkup"]);
    return {
      operation: "send_text",
      chatId: nonzeroInteger(raw.chatId, "chatId"),
      messageThreadId: nullablePositiveInteger(raw.messageThreadId, "messageThreadId"),
      text: bounded(raw.text, TELEGRAM_TEXT_LIMIT, "text"),
      ...(raw.replyMarkup === undefined ? {} : { replyMarkup: normalizeInlineKeyboard(raw.replyMarkup) }),
    };
  }
  if (raw.operation === "send_media") {
    const optional = [raw.name === undefined ? undefined : "name", raw.caption === undefined ? undefined : "caption"]
      .filter((key): key is string => key !== undefined);
    exactKeys(raw, ["operation", "chatId", "messageThreadId", "mediaKind", "path", ...optional]);
    if (raw.mediaKind !== "image" && raw.mediaKind !== "file") invalidPayload();
    return {
      operation: "send_media",
      chatId: nonzeroInteger(raw.chatId, "chatId"),
      messageThreadId: nullablePositiveInteger(raw.messageThreadId, "messageThreadId"),
      mediaKind: raw.mediaKind,
      path: durableRelativePath(raw.path),
      ...(raw.name === undefined ? {} : { name: durableReference(raw.name, "name") }),
      ...(raw.caption === undefined ? {} : { caption: bounded(raw.caption, TELEGRAM_CAPTION_LIMIT, "caption") }),
    };
  }
  return invalidPayload();
}

function normalizeRichMedia(value: unknown): TelegramRichImage[] {
  const seen = new Set<string>();
  const items = denseArray(value, TELEGRAM_RICH_MEDIA_LIMIT);
  const media: TelegramRichImage[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const raw = plainRecord(item);
    exactKeys(raw, raw.name === undefined ? ["id", "path"] : ["id", "path", "name"]);
    const id = bounded(raw.id, TELEGRAM_RICH_MEDIA_ID_LIMIT, "rich media id");
    if (!isTelegramRichMediaId(id) || seen.has(id)) invalidPayload();
    seen.add(id);
    media[index] = {
      id,
      path: richRelativePath(raw.path),
      ...(raw.name === undefined ? {} : { name: durableReference(raw.name, "name") }),
    };
  }
  return media;
}

function normalizeFallbackParts(value: unknown, context: TelegramFallbackContext): TelegramFallbackPart[] {
  const seen = new Set<string>();
  let primaryOrdinal: string | undefined;
  const items = denseArray(value, FALLBACK_PART_LIMIT, true);
  const parts: TelegramFallbackPart[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const raw = plainRecord(item);
    exactKeys(raw, ["partKey", "kind", "payload"]);
    const kind = raw.kind;
    if (kind !== "final" && kind !== "summary" && kind !== "attachment" && kind !== "notice") invalidPayload();
    const partKey = bounded(raw.partKey, 128, "fallback part key");
    const match = FALLBACK_PART_KEY.exec(partKey);
    if (!match || Number(match[3]) !== index || seen.has(partKey)) invalidPayload();
    if (match[1] === "summary" && kind !== "summary") invalidPayload();
    if (primaryOrdinal === undefined) primaryOrdinal = match[2];
    if (match[2] !== primaryOrdinal) invalidPayload();
    seen.add(partKey);
    const payload = normalizeLegacyDeliveryPayload(raw.payload);
    validateFallbackSemantics(kind, payload, context);
    parts[index] = { partKey, kind, payload };
  }
  if (context.operation === "edit_rich" && (primaryOrdinal !== "0000" || parts.length !== 1)) invalidPayload();
  return parts;
}

function validateFallbackSemantics(
  kind: TelegramFallbackPart["kind"],
  payload: TelegramLegacyDeliveryPayload,
  context: TelegramFallbackContext,
): void {
  if (context.operation === "edit_rich") {
    if (kind !== "final" || payload.operation !== "edit_text"
      || payload.chatId !== context.chatId || payload.messageId !== context.messageId) invalidPayload();
    return;
  }
  if (payload.operation === "edit_text" || payload.chatId !== context.chatId) invalidPayload();
  if (payload.messageThreadId !== context.messageThreadId) invalidPayload();
  if (payload.operation === "send_media") {
    if (kind !== "attachment") invalidPayload();
    return;
  }
  if (kind !== "final" && kind !== "summary" && kind !== "notice") invalidPayload();
}

function normalizeInlineKeyboard(value: unknown): TelegramInlineKeyboard {
  const raw = plainRecord(value);
  exactKeys(raw, ["inlineKeyboard"]);
  const rows = denseArray(raw.inlineKeyboard, 8, true);
  const inlineKeyboard: TelegramInlineButton[][] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const buttons = denseArray(rows[rowIndex], 8, true);
    const normalizedButtons: TelegramInlineButton[] = [];
    for (let buttonIndex = 0; buttonIndex < buttons.length; buttonIndex += 1) {
      const rawButton = plainRecord(buttons[buttonIndex]);
      exactKeys(rawButton, ["text", "callbackData"]);
      const text = bounded(rawButton.text, 64, "button text");
      const callbackData = bounded(rawButton.callbackData, 64, "callback data");
      if (Buffer.byteLength(callbackData, "utf8") > 64) invalidPayload();
      normalizedButtons[buttonIndex] = { text, callbackData };
    }
    inlineKeyboard[rowIndex] = normalizedButtons;
  }
  return { inlineKeyboard };
}

function richMarkdown(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || [...value].length > TELEGRAM_RICH_CHARACTER_LIMIT) invalidPayload();
  return value;
}

function durableRelativePath(value: unknown): string {
  const candidate = durableReference(value, "path");
  const segments = candidate.split("/");
  if (candidate.startsWith("/") || candidate.includes("\\")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) invalidPayload();
  return candidate;
}

function durableReference(value: unknown, name: string): string {
  const candidate = bounded(value, REFERENCE_LIMIT, name);
  if (DURABLE_CONTROL.test(candidate)) invalidPayload();
  return candidate;
}

function richRelativePath(value: unknown): string {
  const candidate = durableRelativePath(value);
  if (/^[A-Za-z]:/.test(candidate)) invalidPayload();
  return candidate;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidPayload();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidPayload();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidPayload();
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || !descriptor.enumerable) invalidPayload();
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function denseArray(value: unknown, maximum: number, requireNonempty = false): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || (requireNonempty && value.length === 0)) invalidPayload();
  const normalized: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidPayload();
    normalized[index] = descriptor.value;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) =>
    typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
      || (key !== "length" && Number(key) >= value.length))) invalidPayload();
  return normalized;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== allowed.length || actual.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    invalidPayload();
  }
}

function bounded(value: unknown, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function nonzeroInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) throw new Error(`Invalid ${name}`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function nullablePositiveInteger(value: unknown, name: string): number | null {
  return value === null ? null : positiveInteger(value, name);
}

function invalidPayload(): never {
  throw new Error("Invalid Telegram delivery payload");
}
