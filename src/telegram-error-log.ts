import { telegramRetryAfterMs } from "./telegram-rate-limit.js";

export type TelegramLogOperation =
  | "startup" | "cleanup" | "polling" | "reliability" | "bot_handler" | "keyboard_edit"
  | "topic" | "status_send" | "status_edit" | "delivery_send" | "delivery_edit"
  | "rich_send" | "rich_edit" | "attachment_download" | "artifact_send" | "inbox" | "dashboard_store";

export type TelegramLogCategory =
  | "rate_limited" | "topic_closed" | "topic_missing" | "message_missing"
  | "forbidden" | "rich_rejected" | "bad_request_other" | "network_retryable"
  | "acceptance_unknown" | "internal_local";

export interface TelegramErrorDiagnostic {
  readonly category: TelegramLogCategory;
  readonly telegramCode?: number;
  readonly retryAfterMs?: number;
}

const DEFAULT_TEXT_LIMIT = 512;
const MAX_TEXT_SCAN_CODE_POINTS = 4_096;
const MAX_TRAVERSAL_DEPTH = 4;
const TELEGRAM_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g;
const TELEGRAM_API_CREDENTIAL = /(https:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/\s]+/gi;
const URI_USER_INFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const QUERY_CREDENTIAL = /([?&](?:access_token|api_key|apikey|auth|authorization|password|secret|token)=)[^&#\s]*/gi;
const TRUNCATED_TELEGRAM_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]*$/g;
const TRUNCATED_URI_USER_INFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*$/gi;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

interface ErrorCandidate {
  readonly name?: string;
  readonly message?: string;
  readonly description?: string;
  readonly telegramCode?: number;
  readonly retryAfterSeconds?: unknown;
}

export function sanitizeTelegramLogText(value: string, limit = DEFAULT_TEXT_LIMIT): string {
  const safeLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= DEFAULT_TEXT_LIMIT
    ? limit
    : DEFAULT_TEXT_LIMIT;
  const boundedInput = takeCodePoints(value, MAX_TEXT_SCAN_CODE_POINTS);
  const wasTruncated = boundedInput.length < value.length;
  let sanitized = boundedInput
    .replace(TELEGRAM_API_CREDENTIAL, "$1[REDACTED]")
    .replace(URI_USER_INFO, "$1[REDACTED]@")
    .replace(QUERY_CREDENTIAL, "$1[REDACTED]")
    .replace(TELEGRAM_TOKEN, "[REDACTED]");
  if (wasTruncated) {
    sanitized = sanitized
      .replace(TRUNCATED_TELEGRAM_TOKEN, "[REDACTED]")
      .replace(TRUNCATED_URI_USER_INFO, "$1[REDACTED]");
  }
  sanitized = sanitized
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return takeCodePoints(sanitized || "Unknown error", safeLimit);
}

export function inspectTelegramErrorForLog(
  error: unknown,
  operation: TelegramLogOperation,
): TelegramErrorDiagnostic {
  const candidates = collectCandidates(error);
  const telegramCandidate = firstTelegramCandidate(candidates)
    ?? firstTextOnlyRateLimitCandidate(candidates);
  const telegramCode = telegramCandidate?.telegramCode;
  const retryAfterMs = safeTelegramRetryAfterMs(telegramCandidate);
  const texts = telegramCandidate === undefined
    ? candidateTexts(error, candidates)
    : messageAndDescriptionTexts([telegramCandidate]);
  const category = classify(operation, telegramCode, retryAfterMs, texts);

  if (telegramCode !== undefined && retryAfterMs !== undefined) {
    return { category, telegramCode, retryAfterMs };
  }
  if (telegramCode !== undefined) return { category, telegramCode };
  if (retryAfterMs !== undefined) return { category, retryAfterMs };
  return { category };
}

export function formatTelegramErrorLog(operation: TelegramLogOperation, error: unknown): string {
  const diagnostic = inspectTelegramErrorForLog(error, operation);
  const fields = [
    "telegram",
    `event=${operation}`,
    `category=${diagnostic.category}`,
  ];
  if (diagnostic.telegramCode !== undefined) fields.push(`code=${diagnostic.telegramCode}`);
  if (diagnostic.retryAfterMs !== undefined) fields.push(`retryAfterMs=${diagnostic.retryAfterMs}`);
  return fields.join(" ");
}

export function isTelegramPollingConflict(error: unknown): boolean {
  const candidates = collectCandidates(error);
  if (candidates.some((candidate) => candidate.telegramCode === 409)) return true;
  return messageAndDescriptionTexts(candidates).some((text) => /\bConflict\b/i.test(text));
}

export function isTelegramTopicNotModified(error: unknown): boolean {
  const candidates = collectCandidates(error);
  return messageAndDescriptionTexts(candidates).some((text) => /\bTOPIC_NOT_MODIFIED\b/i.test(text));
}

function collectCandidates(error: unknown): ErrorCandidate[] {
  const root = record(error);
  if (root === null) return [];

  const candidates: ErrorCandidate[] = [];
  const seen = new Set<object>();
  const queue: Array<{ value: Record<string, unknown>; depth: number }> = [{ value: root, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.depth >= MAX_TRAVERSAL_DEPTH || seen.has(current.value)) continue;
    seen.add(current.value);

    const name = stringValue(safeRead(current.value, "name"));
    const message = stringValue(safeRead(current.value, "message"));
    const description = stringValue(safeRead(current.value, "description"));
    const codeValue = safeRead(current.value, "error_code");
    const telegramCode = typeof codeValue === "number" && Number.isSafeInteger(codeValue)
      && codeValue >= 100 && codeValue <= 599
      ? codeValue
      : undefined;
    const parameters = record(safeRead(current.value, "parameters"));
    const retryAfterSeconds = parameters === null ? undefined : safeRead(parameters, "retry_after");
    candidates.push({
      name,
      message,
      description,
      telegramCode,
      retryAfterSeconds,
    });

    const nextDepth = current.depth + 1;
    const cause = record(safeRead(current.value, "cause"));
    const nestedError = record(safeRead(current.value, "error"));
    if (cause !== null) queue.push({ value: cause, depth: nextDepth });
    if (nestedError !== null) queue.push({ value: nestedError, depth: nextDepth });
  }
  return candidates;
}

function safeTelegramRetryAfterMs(candidate: ErrorCandidate | undefined): number | undefined {
  if (candidate === undefined) return undefined;
  return retryAfter({
    error_code: candidate.telegramCode,
    description: candidate.description,
    message: candidate.message,
    parameters: { retry_after: candidate.retryAfterSeconds },
  });
}

function retryAfter(error: unknown): number | undefined {
  try {
    return telegramRetryAfterMs(error);
  } catch {
    return undefined;
  }
}

function classify(
  operation: TelegramLogOperation,
  telegramCode: number | undefined,
  retryAfterMs: number | undefined,
  texts: readonly string[],
): TelegramLogCategory {
  if (telegramCode === 429 || retryAfterMs !== undefined) return "rate_limited";
  if (telegramCode === 403) return "forbidden";
  if (telegramCode === 400) {
    if (texts.some(isTopicClosedText)) return "topic_closed";
    if (texts.some(isTopicMissingText)) return "topic_missing";
    if (isEditOperation(operation) && texts.some(isMessageToEditMissingText)) return "message_missing";
    if (isRichOperation(operation) && texts.some((text) => isRichRejectionText(text, operation))) {
      return "rich_rejected";
    }
    return "bad_request_other";
  }
  if (telegramCode === undefined && texts.some(isNetworkErrorText)) {
    return isSendLikeOperation(operation) ? "acceptance_unknown" : "network_retryable";
  }
  return "internal_local";
}

function candidateTexts(error: unknown, candidates: readonly ErrorCandidate[]): string[] {
  const texts: string[] = [];
  if (typeof error === "string") texts.push(sanitizeTelegramLogText(error));
  for (const candidate of candidates) {
    if (candidate.description !== undefined) texts.push(sanitizeTelegramLogText(candidate.description));
    if (candidate.message !== undefined) texts.push(sanitizeTelegramLogText(candidate.message));
    if (candidate.name !== undefined) texts.push(sanitizeTelegramLogText(candidate.name));
  }
  return texts;
}

function messageAndDescriptionTexts(candidates: readonly ErrorCandidate[]): string[] {
  const texts: string[] = [];
  for (const candidate of candidates) {
    if (candidate.description !== undefined) texts.push(sanitizeTelegramLogText(candidate.description));
    if (candidate.message !== undefined) texts.push(sanitizeTelegramLogText(candidate.message));
  }
  return texts;
}

function isRichOperation(
  operation: TelegramLogOperation,
): operation is "rich_send" | "rich_edit" {
  return operation === "rich_send" || operation === "rich_edit";
}

function isEditOperation(operation: TelegramLogOperation): boolean {
  return operation === "keyboard_edit" || operation === "status_edit"
    || operation === "delivery_edit" || operation === "rich_edit";
}

function isSendLikeOperation(operation: TelegramLogOperation): boolean {
  return operation === "delivery_send" || operation === "rich_send"
    || operation === "artifact_send" || operation === "inbox";
}

function isTopicClosedText(text: string): boolean {
  return /\bTOPIC_CLOSED\b|\btopic is (?:already )?closed\b/i.test(text);
}

function isTopicMissingText(text: string): boolean {
  return /\bmessage thread not found\b|\bTOPIC_ID_INVALID\b|\bTOPIC_DELETED\b|\bTOPIC_NOT_FOUND\b|\btopic not found\b/i
    .test(text);
}

function isMessageToEditMissingText(text: string): boolean {
  return text.toLowerCase() === "bad request: message to edit not found";
}

function isRichRejectionText(
  text: string,
  operation: "rich_send" | "rich_edit",
): boolean {
  const description = text.toLowerCase();
  const formatPrefixes = [
    "bad request: can't parse rich message",
    "bad request: failed to parse rich message",
    "bad request: can't parse rich markdown",
    "bad request: failed to parse rich markdown",
  ];
  if (formatPrefixes.some((prefix) =>
    description === prefix || description.startsWith(`${prefix}:`))) return true;

  const richCapabilityUnavailable = [
    "bad request: rich message is not available",
    "bad request: rich message is unavailable",
    "bad request: rich messages are not available",
    "bad request: rich messages are unavailable",
  ];
  if (richCapabilityUnavailable.includes(description)) return true;

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
  return operation === "rich_send" && sendMethodUnavailable.includes(description);
}

function isNetworkErrorText(text: string): boolean {
  return /^(?:HTTP|Fetch|Network)Error$/i.test(text)
    || /\b(?:fetch failed|network(?: request)? (?:failed|error|timeout)|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|connection (?:reset|refused|closed)|request timed out)\b/i.test(text);
}

function firstTelegramCandidate(candidates: readonly ErrorCandidate[]): ErrorCandidate | undefined {
  for (const candidate of candidates) {
    if (candidate.telegramCode !== undefined) return candidate;
  }
  return undefined;
}

function firstTextOnlyRateLimitCandidate(
  candidates: readonly ErrorCandidate[],
): ErrorCandidate | undefined {
  const rateLimited = candidates.filter((candidate) =>
    messageAndDescriptionTexts([candidate]).some((text) =>
      /\b429\b|too many requests/i.test(text)));
  return rateLimited.find(hasValidRetryAfter) ?? rateLimited[0];
}

function hasValidRetryAfter(candidate: ErrorCandidate): boolean {
  return typeof candidate.retryAfterSeconds === "number"
    && Number.isSafeInteger(candidate.retryAfterSeconds)
    && candidate.retryAfterSeconds >= 1
    && candidate.retryAfterSeconds <= 3_600;
}

function safeRead(value: Record<string, unknown>, property: string): unknown {
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function takeCodePoints(value: string, limit: number): string {
  let output = "";
  let count = 0;
  for (const codePoint of value) {
    if (count >= limit) break;
    output += codePoint;
    count += 1;
  }
  return output;
}
