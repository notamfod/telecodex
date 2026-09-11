import {
  TELEGRAM_RESPONSE_PLAN_MAX_PARTS,
  TELEGRAM_STATUS_ANCHOR_PART_KEY,
  type TelegramResponsePlanPart,
} from "./telegram-job-types.js";
import { formatTelegramHTML, splitTelegramMarkdown } from "./format.js";
import {
  normalizeAndHashTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
  type TelegramFallbackPart,
  type TelegramLegacyDeliveryPayload,
} from "./telegram-delivery-payload.js";
import {
  formatTelegramRichResult,
  isTelegramRichMediaId,
  type TelegramFormattedRichPart,
} from "./telegram-rich-message.js";
import { selectTelegramTurnRepresentation } from "./telegram-representation-selector.js";
import { normalizeTelegramTurnResult, type TelegramTurnResult } from "./telegram-turn-result.js";

export {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
} from "./telegram-delivery-payload.js";
export type {
  TelegramDeliveryPayload,
  TelegramFallbackPart,
  TelegramInlineButton,
  TelegramInlineKeyboard,
  TelegramLegacyDeliveryPayload,
} from "./telegram-delivery-payload.js";

const TELEGRAM_TEXT_LIMIT = 4_096;
const TELEGRAM_CAPTION_LIMIT = 1_024;
const SAFE_FAILURE_CODE_LIMIT = 128;
const SAFE_FAILURE_DETAIL_LIMIT = 1_024;
// 512 legacy-sized deliveries at the 3,000 UTF-16 source target bound both fan-out and rendering work.
const MAX_RESPONSE_PLAN_SOURCE_LENGTH = TELEGRAM_RESPONSE_PLAN_MAX_PARTS * 3_000;
const DELIVERY_BUDGET_ERROR = "Telegram response plan exceeds delivery budget";

export interface TelegramResponseDestination {
  readonly chatId: number;
  readonly messageThreadId: number | null;
  readonly anchorMessageId: number | null;
}

/** Only operator-approved, user-safe detail belongs in publicDetail. Never pass a raw error. */
export interface TelegramResponseFailure {
  readonly code: string;
  readonly publicDetail?: string;
}

type TelegramPlannedDeliveryKind = "status-anchor" | TelegramResponsePlanPart["kind"];

export interface TelegramPlannedDeliveryPart<
  Kind extends TelegramPlannedDeliveryKind = TelegramPlannedDeliveryKind,
> {
  readonly partKey: string;
  readonly ordinal: number;
  readonly kind: Kind;
  readonly payload: TelegramDeliveryPayload;
  readonly contentHash: string;
}

export type TelegramPlannedResponsePart = TelegramPlannedDeliveryPart<TelegramResponsePlanPart["kind"]>;
export type TelegramPlannedAnchorPart = TelegramPlannedDeliveryPart<"status-anchor">;

export interface TelegramBuiltResponsePlan {
  /** Reserved physical outbox row. It is deliberately absent from the job projection. */
  readonly anchor: TelegramPlannedAnchorPart;
  readonly responsePlan: readonly TelegramResponsePlanPart[];
  readonly parts: readonly TelegramPlannedResponsePart[];
}

export interface TelegramSupplementalResponsePart {
  readonly partKey: string;
  readonly kind: TelegramResponsePlanPart["kind"];
  readonly payload: TelegramLegacyDeliveryPayload;
}

type TelegramEditableFinal =
  | { readonly kind: "compact"; readonly html: string }
  | { readonly kind: "rich"; readonly formatted: Extract<TelegramFormattedRichPart, { kind: "rich" }> };

interface TelegramContentPlan {
  readonly parts: readonly TelegramPlannedResponsePart[];
  readonly singleText?: TelegramEditableFinal;
}

export function buildTelegramResponsePlan(input: {
  readonly result: TelegramTurnResult;
  readonly destination: TelegramResponseDestination;
  readonly failure?: TelegramResponseFailure;
  readonly supplementalParts?: readonly TelegramSupplementalResponsePart[];
}): TelegramBuiltResponsePlan {
  const result = normalizeTelegramTurnResult(input.result);
  assertSourceBudget(result);
  const destination = normalizeDestination(input.destination);
  const failure = input.failure === undefined ? undefined : normalizeFailure(input.failure);
  const commentary = result.content.filter(
    (content): content is Extract<TelegramTurnResult["content"][number], { kind: "text" }> =>
      content.kind === "text" && content.phase === "commentary",
  );
  const finalResult: TelegramTurnResult = {
    schemaVersion: 1,
    content: result.content.filter((content) => content.kind !== "text" || content.phase !== "commentary"),
  };
  const summaries = buildCommentaryParts(commentary, destination);
  const generated = buildSelectedContentParts(finalResult, destination);
  const editable = failure === undefined
    && summaries.length === 0
    && Array.isArray(input.supplementalParts ?? []) && (input.supplementalParts ?? []).length === 0
    && destination.anchorMessageId !== null
    ? generated.singleText
    : undefined;
  const anchor = editable?.kind === "compact"
    ? part(TELEGRAM_STATUS_ANCHOR_PART_KEY, 0, "status-anchor", {
        operation: "edit_text",
        chatId: destination.chatId,
        messageId: destination.anchorMessageId!,
        text: editable.html,
      })
    : editable?.kind === "rich"
      ? richAnchorPart(destination, editable.formatted)
      : part(
          TELEGRAM_STATUS_ANCHOR_PART_KEY,
          0,
          "status-anchor",
          anchorPayload(destination, generated.parts.length === 0
            ? failure === undefined ? "Completed." : failureText(failure)
            : "Response follows."),
        );
  const content = [...summaries, ...(editable === undefined ? generated.parts : [])];
  const notice: TelegramPlannedResponsePart[] = failure === undefined || generated.parts.length === 0
    ? []
    : [part("notice:failure", 0, "notice", sendText(destination, formatTelegramHTML(failureText(failure))))];
  const supplemental = normalizeSupplementalParts(
    input.supplementalParts ?? [],
    reservedDeliveryKeys([anchor, ...content, ...notice]),
  );
  const parts = [...content, ...notice, ...supplemental].map((value, ordinal) => ({ ...value, ordinal }));
  assertPartBudget(parts.length);
  return {
    anchor,
    responsePlan: parts.map(({ partKey, kind }) => ({ partId: partKey, kind })),
    parts,
  };
}

function buildCommentaryParts(
  commentary: readonly Extract<TelegramTurnResult["content"][number], { kind: "text" }>[],
  destination: TelegramResponseDestination,
): TelegramPlannedResponsePart[] {
  const parts: TelegramPlannedResponsePart[] = [];
  for (let commentaryIndex = 0; commentaryIndex < commentary.length; commentaryIndex += 1) {
    for (const planned of buildTelegramCommentaryParts({
      text: commentary[commentaryIndex]!.text,
      commentaryIndex,
      destination,
    })) {
      parts.push(planned);
      assertPartBudget(parts.length);
    }
  }
  return parts;
}

export function buildTelegramCommentaryParts(input: {
  readonly text: string;
  readonly commentaryIndex: number;
  readonly destination: TelegramResponseDestination;
}): TelegramPlannedResponsePart[] {
  if (!Number.isSafeInteger(input.commentaryIndex) || input.commentaryIndex < 0 || input.commentaryIndex > 9_999) {
    throw new Error("Invalid commentary index");
  }
  return buildLegacyContentParts(textResult(input.text), normalizeDestination(input.destination)).map(
    (planned, segmentIndex) => ({
      ...planned,
      partKey: `summary:${pad(input.commentaryIndex)}:${pad(segmentIndex)}`,
      kind: "summary" as const,
    }),
  );
}

function normalizeSupplementalParts(
  values: readonly TelegramSupplementalResponsePart[],
  reservedKeys: readonly string[],
): TelegramPlannedResponsePart[] {
  try {
    const supplemental = denseSupplementalParts(values);
    const seen = new Set(reservedKeys);
    const plannedParts: TelegramPlannedResponsePart[] = [];
    for (let index = 0; index < supplemental.length; index += 1) {
      const value = supplemental[index];
      const raw = plainRecord(value);
      exactKeys(raw, ["partKey", "kind", "payload"]);
      const partKey = bounded(raw.partKey, 128, "part key");
      if (seen.has(partKey)) throw new Error("invalid");
      seen.add(partKey);
      if (raw.kind !== "final" && raw.kind !== "summary"
        && raw.kind !== "attachment" && raw.kind !== "notice") throw new Error("invalid");
      const planned = part(partKey, 0, raw.kind, raw.payload);
      if (planned.payload.operation === "edit_rich" || planned.payload.operation === "send_rich") throw new Error("invalid");
      for (const fallbackKey of fallbackPartKeys(planned.payload)) {
        if (seen.has(fallbackKey)) throw new Error("invalid");
        seen.add(fallbackKey);
      }
      plannedParts[index] = planned;
    }
    return plannedParts;
  } catch {
    throw new Error("Invalid supplemental Telegram response part");
  }
}
function denseSupplementalParts(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32) {
    throw new Error("invalid");
  }
  const normalized: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("invalid");
    normalized[index] = descriptor.value;
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error("invalid");
  return normalized;
}

function buildLegacyContentParts(
  result: TelegramTurnResult,
  destination: TelegramResponseDestination,
): TelegramPlannedResponsePart[] {
  const parts: TelegramPlannedResponsePart[] = [];
  let finalIndex = 0;
  let attachmentIndex = 0;
  for (let index = 0; index < result.content.length; index += 1) {
    const content = result.content[index]!;
    if (content.kind === "attachment") {
      parts.push(mediaPart(content.attachment, undefined, attachmentIndex++, destination));
      assertPartBudget(parts.length);
      continue;
    }
    const next = result.content[index + 1];
    const caption = formatTelegramHTML(content.text);
    if (next?.kind === "attachment" && caption.length <= TELEGRAM_CAPTION_LIMIT) {
      parts.push(mediaPart(next.attachment, caption, attachmentIndex++, destination));
      assertPartBudget(parts.length);
      index += 1;
      continue;
    }
    let chunks;
    try {
      chunks = splitTelegramMarkdown(
        content.text, 3_000, TELEGRAM_TEXT_LIMIT, TELEGRAM_RESPONSE_PLAN_MAX_PARTS - parts.length,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Telegram markdown split exceeds chunk budget") {
        deliveryBudgetExceeded();
      }
      throw error;
    }
    for (const chunk of chunks) {
      parts.push(part(`final:${pad(finalIndex++)}`, 0, "final", sendText(destination, chunk.html)));
      assertPartBudget(parts.length);
    }
  }
  return parts;
}

function buildCompactTextContentParts(
  result: TelegramTurnResult,
  destination: TelegramResponseDestination,
): TelegramContentPlan {
  const parts = buildLegacyContentParts(result, destination);
  const only = parts.length === 1 && parts[0]?.payload.operation === "send_text"
    ? { kind: "compact" as const, html: parts[0].payload.text }
    : undefined;
  return { parts, ...(only === undefined ? {} : { singleText: only }) };
}

function buildSelectedContentParts(
  result: TelegramTurnResult,
  destination: TelegramResponseDestination,
): TelegramContentPlan {
  const textOnly = result.content.every((content) => content.kind === "text");
  return textOnly && selectTelegramTurnRepresentation(result) === "compact_html"
    ? buildCompactTextContentParts(result, destination)
    : buildRichContentParts(result, destination);
}

function buildRichContentParts(
  result: TelegramTurnResult,
  destination: TelegramResponseDestination,
): TelegramContentPlan {
  const formatted = formatTelegramRichResult(result);
  const parts: TelegramPlannedResponsePart[] = [];
  let finalIndex = 0;
  let attachmentIndex = 0;
  for (const formattedPart of formatted) {
    if (formattedPart.kind === "file") {
      parts.push(mediaPart(formattedPart.attachment, undefined, attachmentIndex++, destination));
      assertPartBudget(parts.length);
      continue;
    }
    if (formattedPart.kind === "legacy") {
      const legacy = buildLegacyContentParts(textResult(formattedPart.source), destination);
      for (const legacyPart of legacy) {
        parts.push({ ...legacyPart, partKey: `final:${pad(finalIndex++)}` });
        assertPartBudget(parts.length);
      }
      continue;
    }
    const primaryIndex = finalIndex++;
    parts.push(part(`final:${pad(primaryIndex)}`, 0, "final", {
      operation: "send_rich",
      chatId: destination.chatId,
      messageThreadId: destination.messageThreadId,
      markdown: formattedPart.markdown,
      media: formattedPart.media,
      fallbackParts: fallbackParts(formattedPart, destination, primaryIndex),
    }));
    assertPartBudget(parts.length);
  }
  const singleText = formatted.length === 1 && formatted[0]?.kind === "rich"
    && formatted[0].media.length === 0 && result.content.every((content) => content.kind === "text")
    && hasSingleEditFallback(formatted[0], destination)
    ? { kind: "rich" as const, formatted: formatted[0] }
    : undefined;
  return { parts, ...(singleText === undefined ? {} : { singleText }) };
}

function richAnchorPart(
  destination: TelegramResponseDestination,
  formatted: Extract<TelegramFormattedRichPart, { kind: "rich" }>,
): TelegramPlannedAnchorPart {
  if (destination.anchorMessageId === null) throw new Error("Invalid rich anchor destination");
  const primaryIndex = 0;
  return part(TELEGRAM_STATUS_ANCHOR_PART_KEY, 0, "status-anchor", {
    operation: "edit_rich",
    chatId: destination.chatId,
    messageId: destination.anchorMessageId,
    markdown: formatted.markdown,
    media: formatted.media,
    fallbackParts: fallbackParts(formatted, destination, primaryIndex, destination.anchorMessageId),
  });
}

function fallbackParts(
  formatted: Extract<TelegramFormattedRichPart, { kind: "rich" }>,
  destination: TelegramResponseDestination,
  primaryIndex: number,
  editMessageId?: number,
  partPrefix = "final",
  partKind?: TelegramFallbackPart["kind"],
): TelegramFallbackPart[] {
  return buildLegacyContentParts(legacyFallbackResult(formatted), destination).map((legacyPart, fallbackIndex) => ({
    partKey: `${partPrefix}:${pad(primaryIndex)}:fallback:${pad(fallbackIndex)}`,
    kind: partKind ?? legacyPart.kind,
    payload: editMessageId === undefined || fallbackIndex !== 0
      ? legacyPayload(legacyPart.payload)
      : editFallbackPayload(legacyPart.payload, destination.chatId, editMessageId),
  }));
}

function hasSingleEditFallback(
  formatted: Extract<TelegramFormattedRichPart, { kind: "rich" }>,
  destination: TelegramResponseDestination,
): boolean {
  const fallback = buildLegacyContentParts(legacyFallbackResult(formatted), destination);
  return fallback.length === 1 && fallback[0]?.payload.operation === "send_text";
}

function legacyFallbackResult(
  formatted: Extract<TelegramFormattedRichPart, { kind: "rich" }>,
): TelegramTurnResult {
  const media = new Map(formatted.media.map((image) => [image.id, image]));
  const used = new Set<string>();
  const content: TelegramTurnResult["content"][number][] = [];
  let pendingLines: string[] = [];
  const flushText = (): void => {
    while (pendingLines[0] === "") pendingLines.shift();
    while (pendingLines.at(-1) === "") pendingLines.pop();
    const text = pendingLines.join("\n");
    if (text.length > 0) content.push({ kind: "text", text });
    pendingLines = [];
  };
  for (const line of formatted.source.split("\n")) {
    const marker = line.match(/^!\[\]\(tg:\/\/photo\?id=([^\s)]+)\)$/);
    const image = marker === null || !isTelegramRichMediaId(marker[1])
      ? undefined
      : media.get(marker[1]);
    if (image === undefined || used.has(image.id)) {
      pendingLines.push(line);
      continue;
    }
    flushText();
    content.push({
      kind: "attachment",
      attachment: {
        kind: "image",
        path: image.path,
        ...(Object.hasOwn(image, "name") ? { name: image.name } : {}),
      },
    });
    used.add(image.id);
  }
  flushText();
  if (used.size !== media.size) throw new Error("Invalid rich fallback media");
  return { schemaVersion: 1, content };
}

function legacyPayload(payload: TelegramDeliveryPayload): TelegramLegacyDeliveryPayload {
  if (payload.operation === "edit_rich" || payload.operation === "send_rich") {
    throw new Error("Invalid rich fallback payload");
  }
  return payload;
}

function editFallbackPayload(
  payload: TelegramDeliveryPayload,
  chatId: number,
  messageId: number,
): TelegramLegacyDeliveryPayload {
  if (payload.operation !== "send_text") throw new Error("Invalid rich anchor fallback");
  return { operation: "edit_text", chatId, messageId, text: payload.text };
}

function textResult(text: string): TelegramTurnResult {
  return { schemaVersion: 1, content: [{ kind: "text", text }] };
}

function mediaPart(
  attachment: Extract<TelegramTurnResult["content"][number], { kind: "attachment" }>["attachment"],
  caption: string | undefined,
  index: number,
  destination: TelegramResponseDestination,
): TelegramPlannedResponsePart {
  return part(`attachment:${pad(index)}`, 0, "attachment", {
    operation: "send_media",
    chatId: destination.chatId,
    messageThreadId: destination.messageThreadId,
    mediaKind: attachment.kind,
    path: attachment.path,
    ...(Object.hasOwn(attachment, "name") ? { name: attachment.name } : {}),
    ...(caption === undefined ? {} : { caption }),
  });
}

function part<Kind extends TelegramPlannedDeliveryKind>(
  partKey: string,
  ordinal: number,
  kind: Kind,
  value: unknown,
): TelegramPlannedDeliveryPart<Kind> {
  const { payload, contentHash } = normalizeAndHashTelegramDeliveryPayload(value);
  return { partKey, ordinal, kind, payload, contentHash };
}

function reservedDeliveryKeys(parts: readonly TelegramPlannedDeliveryPart[]): string[] {
  const keys: string[] = [];
  for (const planned of parts) {
    keys.push(planned.partKey, ...fallbackPartKeys(planned.payload));
  }
  return keys;
}

function fallbackPartKeys(payload: TelegramDeliveryPayload): string[] {
  return payload.operation === "edit_rich" || payload.operation === "send_rich"
    ? payload.fallbackParts.map(({ partKey }) => partKey)
    : [];
}

function assertSourceBudget(result: TelegramTurnResult): void {
  let sourceLength = 0;
  for (const content of result.content) {
    if (content.kind !== "text") continue;
    sourceLength += content.text.length;
    if (sourceLength > MAX_RESPONSE_PLAN_SOURCE_LENGTH) deliveryBudgetExceeded();
  }
}

function assertPartBudget(partCount: number): void {
  if (partCount > TELEGRAM_RESPONSE_PLAN_MAX_PARTS) deliveryBudgetExceeded();
}

function deliveryBudgetExceeded(): never {
  throw new Error(DELIVERY_BUDGET_ERROR);
}

function anchorPayload(destination: TelegramResponseDestination, text: string): TelegramDeliveryPayload {
  return destination.anchorMessageId === null
    ? sendText(destination, text)
    : { operation: "edit_text", chatId: destination.chatId, messageId: destination.anchorMessageId, text };
}

function sendText(destination: TelegramResponseDestination, text: string): TelegramDeliveryPayload {
  return { operation: "send_text", chatId: destination.chatId, messageThreadId: destination.messageThreadId, text };
}

function normalizeDestination(value: TelegramResponseDestination): TelegramResponseDestination {
  try {
    const raw = plainRecord(value);
    exactKeys(raw, ["chatId", "messageThreadId", "anchorMessageId"]);
    return {
      chatId: nonzeroInteger(raw.chatId, "chatId"),
      messageThreadId: nullablePositiveInteger(raw.messageThreadId, "messageThreadId"),
      anchorMessageId: nullablePositiveInteger(raw.anchorMessageId, "anchorMessageId"),
    };
  } catch {
    throw new Error("Invalid Telegram response destination");
  }
}

function normalizeFailure(value: TelegramResponseFailure): TelegramResponseFailure {
  try {
    const raw = plainRecord(value);
    exactKeys(raw, raw.publicDetail === undefined ? ["code"] : ["code", "publicDetail"]);
    const code = bounded(raw.code, SAFE_FAILURE_CODE_LIMIT, "failure code");
    if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new Error("Invalid failure code");
    return raw.publicDetail === undefined
      ? { code }
      : { code, publicDetail: publicFailureDetail(raw.publicDetail) };
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid public failure detail") throw error;
    throw new Error("Invalid Telegram response failure");
  }
}

function failureText(value: TelegramResponseFailure): string {
  return value.publicDetail === undefined ? value.code : `${value.code}: ${value.publicDetail}`;
}

function publicFailureDetail(value: unknown): string {
  const detail = bounded(value, SAFE_FAILURE_DETAIL_LIMIT, "public failure detail");
  if (/[\u0000-\u001f\u007f]/.test(detail)) throw new Error("Invalid public failure detail");
  return detail;
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

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== allowed.length || actual.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    invalidPayload();
  }
}

function pad(value: number): string { return String(value).padStart(4, "0"); }
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
function invalidPayload(): never { throw new Error("Invalid Telegram delivery payload"); }
