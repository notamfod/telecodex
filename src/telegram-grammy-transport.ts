import type { ReadStream } from "node:fs";
import path from "node:path";

import { InputFile, type Api } from "grammy";
import type { InputRichMessage } from "grammy/types";

import {
  type TelegramDeliveryAdapter,
  type TelegramDeliveryPayload,
} from "./telegram-delivery-outbox.js";
import {
  attachmentReadStream,
  closeAttachmentFiles,
  openContainedAttachments,
} from "./telegram-attachment-file.js";
import { TelegramDeliveryApiError, TelegramDeliveryLocalError } from "./telegram-delivery-error.js";
import { normalizeTelegramDeliveryPayload } from "./telegram-response-plan.js";
import type { TelegramAttachmentRef } from "./telegram-job-types.js";
import {
  type TelegramBackgroundWriteGate,
  TelegramBackgroundWriteGateAdmissionCancelledError,
  TelegramBackgroundWriteGateDisposedError,
} from "./telegram-background-write-gate.js";
import type {
  TelegramDurableStatusMessage,
  TelegramDurableStatusOptions,
} from "./telegram-durable-status.js";
import type { TelegramStatusAction } from "./telegram-status-projection.js";
import { telegramRetryAfterMs } from "./telegram-rate-limit.js";
import type { TurnProgressTransportClassification } from "./turn-progress.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 30_000;
const TELEGRAM_CALLBACK_LIMIT_BYTES = 64;
const TELEGRAM_ERROR_DESCRIPTION_LIMIT = 512;

export { TelegramDeliveryLocalError } from "./telegram-delivery-error.js";

export interface TelegramAttachmentDownloaderOptions {
  readonly api: Pick<Api, "getFile">;
  readonly botToken: string;
  readonly maxBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createTelegramAttachmentDownloader(
  options: TelegramAttachmentDownloaderOptions,
): (attachment: TelegramAttachmentRef) => Promise<Uint8Array> {
  const maximum = positiveInteger(options.maxBytes, "maxBytes");
  const timeoutMs = positiveInteger(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, "timeoutMs");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Telegram file download is unavailable");
  if (!options.botToken || /[\u0000-\u001f\u007f]/.test(options.botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  return async (attachment) => {
    if (attachment.size !== undefined && attachment.size > maximum) throw fileTooLarge();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const file = await abortable(
        options.api.getFile(attachment.telegramFileId, controller.signal as never),
        controller.signal,
      );
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      if (file.file_size !== undefined && file.file_size > maximum) throw fileTooLarge();
      const encodedPath = file.file_path.split("/").map(encodeURIComponent).join("/");
      const response = await fetchImpl(
        `https://api.telegram.org/file/bot${options.botToken}/${encodedPath}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > maximum) throw fileTooLarge();
      return await readBoundedBody(response, maximum);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createTelegramStatusTransport(
  api: Pick<Api, "sendMessage" | "editMessageText">,
  timeoutMs = STATUS_TIMEOUT_MS,
  gate?: Pick<TelegramBackgroundWriteGate, "run">,
): TelegramDurableStatusOptions["transport"] {
  const deadlineMs = positiveInteger(timeoutMs, "timeoutMs");
  return {
    async send(message) {
      const sent = await runStatusWrite(
        gate,
        message,
        () => withinSignal(
          (signal) => api.sendMessage(message.chatId, message.html, statusOptions(message), signal as never),
          deadlineMs,
        ),
      );
      return sent.message_id;
    },
    async edit(message) {
      if (message.messageId === undefined) throw new Error("Telegram status message id is missing");
      const messageId = message.messageId;
      try {
        await runStatusWrite(
          gate,
          message,
          () => withinSignal(
            (signal) => api.editMessageText(
              message.chatId,
              messageId,
              message.html,
              statusOptions(message),
              signal as never,
            ),
            deadlineMs,
          ),
        );
      } catch (error) {
        if (isMessageNotModified(error)) return;
        throw error;
      }
    },
  };
}

function runStatusWrite<T>(
  gate: Pick<TelegramBackgroundWriteGate, "run"> | undefined,
  message: TelegramDurableStatusMessage,
  operation: () => Promise<T>,
): Promise<T> {
  return gate
    ? gate.run(message.chatId, message.priority, operation, message.admissionSignal)
    : operation();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Telegram request timed out"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Telegram request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
  });
}

function withinSignal<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return abortable(operation(controller.signal), controller.signal)
    .finally(() => clearTimeout(timer));
}

export function createTelegramDeliveryTransport(
  api: TelegramDeliveryApi,
  attachmentRoot: string,
): TelegramDeliveryAdapter {
  const root = path.resolve(attachmentRoot);
  return {
    async deliver(payload, signal) {
      if (signal.aborted) throw new Error("Telegram delivery aborted");
      const normalized = normalizeTelegramDeliveryPayload(payload);
      try {
        if (normalized.operation === "edit_rich" || normalized.operation === "send_rich") {
          return await deliverRich(api, root, normalized, signal);
        }
        if (normalized.operation === "edit_text") {
          await api.editMessageText(
            normalized.chatId,
            normalized.messageId,
            normalized.text,
            { parse_mode: "HTML" },
            signal as never,
          );
          return { messageId: normalized.messageId };
        }
        if (normalized.operation === "send_text") {
          const sent = await api.sendMessage(
            normalized.chatId,
            normalized.text,
            {
              parse_mode: "HTML",
              ...(normalized.messageThreadId === null
                ? {}
                : { message_thread_id: normalized.messageThreadId }),
              ...(normalized.replyMarkup === undefined ? {} : telegramReplyMarkup(normalized.replyMarkup)),
            },
            signal as never,
          );
          return { messageId: sent.message_id };
        }
        const files = openContainedAttachments(root, [normalized]);
        const streams: ReadStream[] = [];
        const options = {
          ...(normalized.messageThreadId === null ? {} : { message_thread_id: normalized.messageThreadId }),
          ...(normalized.caption === undefined ? {} : { caption: normalized.caption }),
        };
        try {
          const stream = attachmentReadStream(files[0]!);
          streams.push(stream);
          const sent = normalized.mediaKind === "image"
            ? await api.sendPhoto(normalized.chatId, new InputFile(stream), options, signal as never)
            : await api.sendDocument(
                normalized.chatId,
                new InputFile(stream, normalized.name ?? path.basename(files[0]!.descriptorTarget)),
                options,
                signal as never,
              );
          return { messageId: sent.message_id };
        } finally { await closeAttachmentFiles(files, streams); }
      } catch (error) {
        const classified = classifyTelegramDeliveryError(error, normalized.operation);
        if (classified) throw classified;
        throw error;
      }
    },
  };
}

export function classifyTelegramStatusError(
  operation: "send" | "edit",
  error: unknown,
): TurnProgressTransportClassification {
  if (error instanceof TelegramBackgroundWriteGateDisposedError
    || error instanceof TelegramBackgroundWriteGateAdmissionCancelledError) {
    return { disposition: "retryable" };
  }
  const retryAfterMs = telegramRetryAfterMs(error);
  if (retryAfterMs !== undefined) return { disposition: "retryable", retryAfterMs };
  const code = telegramErrorCode(error);
  if (operation === "edit" && code === 400
    && isMessageToEditMissing(error)) {
    return { disposition: "message_missing" };
  }
  if (typeof code === "number" && code >= 400 && code < 500) {
    return { disposition: "permanent" };
  }
  return { disposition: operation === "edit" ? "retryable" : "acceptance_unknown" };
}

export function classifyTelegramDeliveryError(
  error: unknown,
  operation?: TelegramDeliveryPayload["operation"],
): TelegramDeliveryApiError | null {
  const retryAfterMs = telegramRetryAfterMs(error);
  if (retryAfterMs !== undefined) return new TelegramDeliveryApiError("retry_after", retryAfterMs);
  const code = telegramErrorCode(error);
  if (code === 400 && operation === "edit_text" && isMessageToEditMissing(error)) {
    return new TelegramDeliveryApiError("message_missing");
  }
  if (code === 400 && (operation === "edit_text" || operation === "edit_rich")
    && isMessageNotModified(error)) return new TelegramDeliveryApiError("message_not_modified");
  if (code === 400 && (operation === "edit_rich" || operation === "send_rich")) {
    const reason = richRejectionReason(error, operation);
    if (reason !== null) return new TelegramDeliveryApiError("rich_rejected", undefined, reason);
  }
  if (typeof code === "number" && code >= 400 && code < 500) {
    return new TelegramDeliveryApiError("permanent");
  }
  return null;
}

type TelegramDeliveryApi = Pick<Api,
  "sendMessage" | "editMessageText" | "sendPhoto" | "sendDocument" | "sendRichMessage">;
type RichDeliveryPayload = Extract<TelegramDeliveryPayload, { operation: "edit_rich" | "send_rich" }>;

async function deliverRich(
  api: TelegramDeliveryApi,
  root: string,
  payload: RichDeliveryPayload,
  signal: AbortSignal,
): Promise<{ readonly messageId: number }> {
  if (payload.operation === "send_rich" && typeof api.sendRichMessage !== "function") {
    throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
  }
  const files = payload.media.length === 0 ? [] : openContainedAttachments(root, payload.media);
  const streams: ReadStream[] = [];
  try {
    const richMessage: InputRichMessage = {
      markdown: payload.markdown,
      ...(files.length === 0 ? {} : {
        media: files.map((file) => {
          const stream = attachmentReadStream(file);
          streams.push(stream);
          return {
            id: file.source.id,
            media: {
              type: "photo" as const,
              media: new InputFile(stream, file.source.name ?? path.basename(file.descriptorTarget)),
            },
          };
        }),
      }),
    };
    if (payload.operation === "edit_rich") {
      await api.editMessageText(payload.chatId, payload.messageId, richMessage, {}, signal as never);
      return { messageId: payload.messageId };
    }
    const sent = await api.sendRichMessage(
      payload.chatId,
      richMessage,
      {
        ...(payload.messageThreadId === null ? {} : { message_thread_id: payload.messageThreadId }),
        ...(payload.replyMarkup === undefined ? {} : telegramReplyMarkup(payload.replyMarkup)),
      },
      signal as never,
    );
    return { messageId: sent.message_id };
  } finally {
    await closeAttachmentFiles(files, streams);
  }
}

function telegramReplyMarkup(replyMarkup: {
  readonly inlineKeyboard: readonly (readonly { readonly text: string; readonly callbackData: string }[])[];
}) {
  return {
    reply_markup: {
      inline_keyboard: replyMarkup.inlineKeyboard.map((row) => row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      }))),
    },
  };
}

function statusOptions(message: TelegramDurableStatusMessage) {
  const rows = message.actions.flatMap((action) => {
    const callbackData = actionCallback(action);
    return callbackData === null ? [] : [[{ text: actionLabel(action), callback_data: callbackData }]];
  });
  return {
    parse_mode: "HTML" as const,
    ...(message.messageThreadId === null || message.messageThreadId === undefined
      ? {}
      : { message_thread_id: message.messageThreadId }),
    reply_markup: { inline_keyboard: rows },
  };
}

function actionCallback(action: TelegramStatusAction): string | null {
  return telegramStatusActionCallbackData(action);
}

export function telegramStatusActionCallbackData(action: TelegramStatusAction): string | null {
  const codes: Partial<Record<TelegramStatusAction["kind"], string>> = {
    abort: "a",
    retry_new_turn: "r",
    refresh: "f",
    details: "d",
    inspect: "i",
    retry_delivery: "y",
    send_again_warning: "s",
    guardian_restore: "g",
  };
  const code = codes[action.kind] ?? null;
  if (code === null) return null;
  const suffix = action.partKey === undefined ? "" : `:${action.partKey}`;
  return boundedCallback(`tcj:${code}:${action.jobId}:${action.expectedVersion}${suffix}`);
}

function actionLabel(action: TelegramStatusAction): string {
  const labels: Record<TelegramStatusAction["kind"], string> = {
    abort: "Stop", refresh: "Refresh", details: "Details", inspect: "Inspect",
    retry_new_turn: "Retry", guardian_restore: "Restore", retry_delivery: "Retry delivery",
    send_again_warning: "Send again",
  };
  return labels[action.kind];
}

function boundedCallback(value: string): string | null {
  return Buffer.byteLength(value, "utf8") <= TELEGRAM_CALLBACK_LIMIT_BYTES ? value : null;
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximum) {
      await reader.cancel().catch(() => undefined);
      throw fileTooLarge();
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function telegramErrorCode(error: unknown): number | null {
  const raw = record(error);
  const nested = record(raw?.error);
  const value = raw?.error_code ?? nested?.error_code;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isMessageNotModified(error: unknown): boolean {
  return telegramErrorDescription(error)?.toLowerCase().includes("message is not modified") === true;
}

function isMessageToEditMissing(error: unknown): boolean {
  return telegramErrorDescription(error)?.toLowerCase() === "bad request: message to edit not found";
}

function richRejectionReason(
  error: unknown,
  operation: "edit_rich" | "send_rich",
): "format" | "method_unavailable" | null {
  const description = telegramErrorDescription(error)?.toLowerCase();
  if (description === undefined) return null;
  const formatPrefixes = [
    "bad request: can't parse rich message",
    "bad request: failed to parse rich message",
    "bad request: can't parse rich markdown",
    "bad request: failed to parse rich markdown",
  ];
  if (formatPrefixes.some((prefix) => description === prefix || description.startsWith(`${prefix}:`))) {
    return "format";
  }
  const richCapabilityUnavailable = [
    "bad request: rich message is not available",
    "bad request: rich message is unavailable",
    "bad request: rich messages are not available",
    "bad request: rich messages are unavailable",
  ];
  if (richCapabilityUnavailable.includes(description)) return "method_unavailable";
  const sendMethodUnavailable = [
    "bad request: method not found",
    "bad request: method is not available",
    "bad request: method is unavailable",
    "bad request: method sendrichmessage not found",
    "bad request: method sendrichmessage is not available",
    "bad request: method sendrichmessage is unavailable",
    "bad request: sendrichmessage method not found",
    "bad request: sendrichmessage method is not available",
    "bad request: sendrichmessage method is unavailable",
  ];
  return operation === "send_rich" && sendMethodUnavailable.includes(description)
    ? "method_unavailable"
    : null;
}

function telegramErrorDescription(error: unknown): string | undefined {
  const raw = record(error);
  const nested = record(raw?.error);
  const description = raw?.description ?? nested?.description;
  return typeof description === "string" && description.length <= TELEGRAM_ERROR_DESCRIPTION_LIMIT
    ? description
    : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function fileTooLarge(): Error { return new Error("Telegram file is too large"); }
