const SOURCE_KEYS = [
  "botId", "updateId", "chatId", "messageThreadId", "messageId", "kind", "text",
  "attachment", "retryOfJobId", "targetContext", "targetProvision", "sessionDefaults",
  "implementationHandoffProfileId", "completion",
] as const;
const WORK_KINDS = new Set(["text", "voice", "audio", "photo", "document", "command", "confirmation", "retry"]);
const ATTACHMENT_KINDS = new Set(["photo", "document", "audio", "voice", "video", "unknown"]);

export function decodeCanonicalTopicRecoverySourceJson(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== "string") invalid();
    const parsed = record(JSON.parse(value));
    if (value !== encodeCanonicalTopicRecoverySource(parsed)) invalid();
    return structuredClone(normalizeSource(parsed));
  } catch { return invalid(); }
}

export function encodeCanonicalTopicRecoverySource(value: unknown): string {
  return JSON.stringify(normalizeSource(record(value)));
}

function normalizeSource(raw: Record<string, unknown>): Record<string, unknown> {
  exactAllowed(raw, SOURCE_KEYS);
  const kind = enumeration(raw.kind, WORK_KINDS);
  const attachment = raw.attachment === null ? null : normalizeAttachment(record(raw.attachment));
  const source: Record<string, unknown> = {
    botId: bounded(raw.botId, 128),
    updateId: integer(raw.updateId, 0),
    chatId: nonzeroInteger(raw.chatId),
    messageThreadId: raw.messageThreadId === null ? null : integer(raw.messageThreadId, 1),
    messageId: integer(raw.messageId, 1),
    kind,
    text: raw.text === null ? null : sourceText(raw.text, 65_536),
    attachment,
    retryOfJobId: raw.retryOfJobId === null ? null : bounded(raw.retryOfJobId, 128),
  };
  if (raw.targetContext !== undefined) source.targetContext = normalizeObject(
    record(raw.targetContext), ["chatId", "messageThreadId"], {
      chatId: (input) => nonzeroInteger(input), messageThreadId: (input) => integer(input, 1),
    },
  );
  if (raw.targetProvision !== undefined) source.targetProvision = normalizeObject(
    record(raw.targetProvision), ["kind", "topicName", "state"], {
      kind: (input) => exact(input, "forum_topic"), topicName: (input) => bounded(input, 128),
      state: (input) => enumeration(input, new Set(["planned", "in_flight", "complete"])),
    },
  );
  if (raw.sessionDefaults !== undefined) {
    const defaults = record(raw.sessionDefaults);
    exactAllowed(defaults, ["workspace", "launchProfileId", "topicName"]);
    source.sessionDefaults = {
      workspace: bounded(defaults.workspace, 4_096), launchProfileId: bounded(defaults.launchProfileId, 128),
      ...(defaults.topicName === undefined ? {} : { topicName: bounded(defaults.topicName, 128) }),
    };
  }
  if (raw.implementationHandoffProfileId !== undefined) {
    source.implementationHandoffProfileId = bounded(raw.implementationHandoffProfileId, 128);
  }
  if (raw.completion !== undefined) source.completion = normalizeObject(
    record(raw.completion), ["kind", "ticketId"], {
      kind: (input) => exact(input, "inbox_ticket"), ticketId: (input) => integer(input, 1),
    },
  );
  const target = source.targetContext as Record<string, unknown> | undefined;
  const provision = source.targetProvision as Record<string, unknown> | undefined;
  if (target && target.chatId !== source.chatId) invalid();
  if (provision && ((provision.state === "complete") !== (target !== undefined))) invalid();
  if (!WORK_KINDS.has(kind) || ((kind === "text" || kind === "command" || kind === "confirmation") && !source.text)) invalid();
  const attachmentKind = kind === "voice" || kind === "audio" || kind === "photo" || kind === "document";
  if (attachmentKind ? !attachment || attachment.kind !== kind : kind !== "retry" && attachment !== null) invalid();
  if (kind === "retry" ? source.retryOfJobId === null || (!source.text && !attachment) : source.retryOfJobId !== null) invalid();
  if (source.completion !== undefined && kind !== "confirmation" && kind !== "retry") invalid();
  return source;
}

function normalizeAttachment(raw: Record<string, unknown>): Record<string, unknown> {
  const keys = ["id", "kind", "telegramFileId", "telegramFileUniqueId", "name", "mimeType", "size"] as const;
  exactAllowed(raw, keys);
  return {
    id: bounded(raw.id, 1_024), kind: enumeration(raw.kind, ATTACHMENT_KINDS),
    telegramFileId: bounded(raw.telegramFileId, 1_024),
    ...(raw.telegramFileUniqueId === undefined ? {} : { telegramFileUniqueId: bounded(raw.telegramFileUniqueId, 1_024) }),
    ...(raw.name === undefined ? {} : { name: bounded(raw.name, 1_024) }),
    ...(raw.mimeType === undefined ? {} : { mimeType: bounded(raw.mimeType, 1_024) }),
    ...(raw.size === undefined ? {} : { size: integer(raw.size, 0) }),
  };
}

function normalizeObject(
  raw: Record<string, unknown>, keys: readonly string[],
  decoders: Readonly<Record<string, (value: unknown) => unknown>>,
): Record<string, unknown> {
  exactAllowed(raw, keys);
  return Object.fromEntries(keys.map((key) => [key, decoders[key]!(raw[key])]));
}

function exactAllowed(raw: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(raw).some((key) => !keys.includes(key))) invalid();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) invalid();
  return value;
}
function sourceText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) invalid();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
function nonzeroInteger(value: unknown): number {
  const result = integer(value, Number.MIN_SAFE_INTEGER);
  if (result === 0) invalid();
  return result;
}
function enumeration(value: unknown, values: ReadonlySet<string>): string {
  if (typeof value !== "string" || !values.has(value)) invalid();
  return value;
}
function exact(value: unknown, expected: string): string { if (value !== expected) invalid(); return expected; }
function invalid(): never { throw new Error("Malformed Telegram topic recovery source"); }
