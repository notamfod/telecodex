export type TelegramTurnTextPhase = "commentary" | "final_answer";

export interface TelegramTurnTextContent {
  readonly kind: "text";
  readonly phase?: TelegramTurnTextPhase;
  readonly text: string;
}

export type TelegramTurnAttachmentReference =
  | { readonly kind: "image"; readonly path: string; readonly name?: string }
  | { readonly kind: "file"; readonly path: string; readonly name?: string };

export interface TelegramTurnAttachmentContent {
  readonly kind: "attachment";
  readonly attachment: TelegramTurnAttachmentReference;
}

export type TelegramTurnResultContent =
  | TelegramTurnTextContent
  | TelegramTurnAttachmentContent;

export interface TelegramTurnResult {
  readonly schemaVersion: 1;
  readonly content: readonly TelegramTurnResultContent[];
}

export const TELEGRAM_TURN_RESULT_MAX_CONTENT_PARTS = 256;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_REFERENCE_LENGTH = 1024;
const DURABLE_CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeTelegramTurnResult(input: unknown): TelegramTurnResult {
  try {
    const result = plainRecord(input);
    exactKeys(result, ["schemaVersion", "content"]);
    if (result.schemaVersion !== 1) invalid();
    const values = denseArray(result.content, TELEGRAM_TURN_RESULT_MAX_CONTENT_PARTS);
    const content: TelegramTurnResultContent[] = [];
    for (let index = 0; index < values.length; index += 1) {
      content[index] = normalizeContent(values[index]);
    }
    return { schemaVersion: 1, content };
  } catch {
    throw new Error("Invalid Telegram turn result");
  }
}

function normalizeContent(value: unknown): TelegramTurnResultContent {
  const content = plainRecord(value);
  if (content.kind === "text") {
    const hasPhase = Object.hasOwn(content, "phase");
    exactKeys(content, hasPhase ? ["kind", "phase", "text"] : ["kind", "text"]);
    const phase = hasPhase ? textPhase(content.phase) : undefined;
    return {
      kind: "text",
      ...(phase === undefined ? {} : { phase }),
      text: boundedString(content.text, MAX_TEXT_LENGTH),
    };
  }
  if (content.kind === "attachment") {
    exactKeys(content, ["kind", "attachment"]);
    return { kind: "attachment", attachment: normalizeAttachment(content.attachment) };
  }
  return invalid();
}

function textPhase(value: unknown): TelegramTurnTextPhase {
  if (value !== "commentary" && value !== "final_answer") invalid();
  return value;
}

function normalizeAttachment(value: unknown): TelegramTurnAttachmentReference {
  const attachment = plainRecord(value);
  exactKeys(
    attachment,
    attachment.name === undefined ? ["kind", "path"] : ["kind", "path", "name"],
  );
  if (attachment.kind !== "image" && attachment.kind !== "file") invalid();
  return {
    kind: attachment.kind,
    path: durableRelativePath(attachment.path),
    ...(attachment.name === undefined
      ? {}
      : { name: durableReference(attachment.name) }),
  };
}

function durableRelativePath(value: unknown): string {
  const candidate = durableReference(value);
  const segments = candidate.split("/");
  if (candidate.startsWith("/") || candidate.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    invalid();
  }
  return candidate;
}

function durableReference(value: unknown): string {
  const candidate = boundedString(value, MAX_REFERENCE_LENGTH);
  if (DURABLE_CONTROL.test(candidate)) invalid();
  return candidate;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid();
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function denseArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    invalid();
  }
  const normalized: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    normalized[index] = descriptor.value;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) =>
    typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
      || (key !== "length" && Number(key) >= value.length))) invalid();
  return normalized;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== allowed.length || actual.some((key) =>
    typeof key !== "string" || !allowed.includes(key))) invalid();
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    invalid();
  }
  return value;
}

function invalid(): never {
  throw new Error("Invalid Telegram turn result");
}
