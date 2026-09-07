import type {
  MaterializedPrompt,
  TelegramAttachmentRef,
} from "./telegram-job-types.js";

const attachmentKinds = ["photo", "document", "audio", "voice", "video", "unknown"] as const;

export function parseTelegramAttachmentRefs(value: unknown): readonly TelegramAttachmentRef[] {
  return array(value).map((item) => {
    const raw = record(item);
    onlyKeys(raw, ["id", "kind", "telegramFileId", "telegramFileUniqueId", "name", "mimeType", "size"]);
    return {
      id: text(raw.id),
      kind: enumeration(raw.kind, attachmentKinds),
      telegramFileId: text(raw.telegramFileId),
      telegramFileUniqueId: raw.telegramFileUniqueId === undefined ? undefined : text(raw.telegramFileUniqueId),
      name: raw.name === undefined ? undefined : text(raw.name),
      mimeType: raw.mimeType === undefined ? undefined : text(raw.mimeType),
      size: raw.size === undefined ? undefined : integer(raw.size),
    };
  });
}

export function parseMaterializedPrompt(value: unknown): MaterializedPrompt {
  const raw = record(value);
  onlyKeys(raw, ["text", "attachments"]);
  if (typeof raw.text !== "string" || raw.text.length > 1_000_000) throw new Error();
  return {
    text: raw.text,
    attachments: array(raw.attachments).map((item) => {
      const attachment = record(item);
      onlyKeys(attachment, ["id", "kind", "relativePath", "name", "mimeType"]);
      return {
        id: text(attachment.id),
        kind: enumeration(attachment.kind, attachmentKinds),
        relativePath: relativePath(attachment.relativePath),
        name: attachment.name === undefined ? undefined : text(attachment.name),
        mimeType: attachment.mimeType === undefined ? undefined : text(attachment.mimeType),
      };
    }),
  };
}

export function cloneMaterializedPrompt(prompt: MaterializedPrompt): MaterializedPrompt {
  return { text: prompt.text, attachments: prompt.attachments.map((attachment) => ({ ...attachment })) };
}

function relativePath(value: unknown): string {
  const candidate = text(value);
  const segments = candidate.split("/");
  if (candidate.startsWith("/") || candidate.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new Error();
  return candidate;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw new Error();
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error();
  return value as T;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error();
}
