import {
  codePointLength,
  scanTelegramRichMarkdown,
  telegramRichDependencyLabels,
  type TelegramRichMarkdownUnit,
} from "./telegram-rich-markdown.js";
import type {
  TelegramTurnAttachmentReference as TelegramTurnAttachment,
  TelegramTurnResult,
} from "./telegram-turn-result.js";

type TelegramTurnFileAttachment = Extract<TelegramTurnAttachment, { kind: "file" }>;

export const TELEGRAM_RICH_CHARACTER_LIMIT = 32_768;
export const TELEGRAM_RICH_BLOCK_LIMIT = 500;
export const TELEGRAM_RICH_NESTING_LIMIT = 16;
export const TELEGRAM_RICH_MEDIA_LIMIT = 50;
export const TELEGRAM_RICH_MEDIA_ID_LIMIT = 64;
export const TELEGRAM_RICH_TABLE_COLUMN_LIMIT = 20;
const MAX_ADJACENT_TEXT_BATCH_CHARACTERS = 1_000_000;
const MAX_DEPENDENCY_LABELS = 1_024;

export interface TelegramRichImage {
  readonly id: string;
  readonly path: string;
  readonly name?: string;
}

export type TelegramFormattedRichPart =
  | { readonly kind: "rich"; readonly markdown: string; readonly media: readonly TelegramRichImage[]; readonly source: string }
  | { readonly kind: "file"; readonly attachment: TelegramTurnFileAttachment }
  | { readonly kind: "legacy"; readonly source: string };

interface RichUnit extends TelegramRichMarkdownUnit {
  readonly images: TelegramRichImage[];
}

interface PendingRichPart {
  markdown: string;
  source: string;
  blocks: number;
  mediaCount: number;
  images: TelegramRichImage[];
}

interface TextDependencySpan {
  readonly start: number;
  readonly end: number;
}

export function isTelegramRichMediaId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= TELEGRAM_RICH_MEDIA_ID_LIMIT
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

export function formatTelegramRichResult(result: TelegramTurnResult): TelegramFormattedRichPart[] {
  const output: TelegramFormattedRichPart[] = [];
  let pending: PendingRichPart | undefined;
  let imageOrdinal = 0;
  const reservedImageIds = userAuthoredImageIds(result);
  let hasRunContent = false;
  const flush = (): void => {
    if (!pending) return;
    output.push({ kind: "rich", markdown: pending.markdown, media: pending.images, source: pending.source });
    pending = undefined;
  };
  const add = (unit: RichUnit): void => {
    if (!unit.valid || unit.blocks > TELEGRAM_RICH_BLOCK_LIMIT ||
      unit.depth > TELEGRAM_RICH_NESTING_LIMIT ||
      unit.columns > TELEGRAM_RICH_TABLE_COLUMN_LIMIT ||
      unit.mediaCount > TELEGRAM_RICH_MEDIA_LIMIT) {
      flush();
      output.push({ kind: "legacy", source: unit.source });
      return;
    }
    if (codePointLength(unit.markdown) > TELEGRAM_RICH_CHARACTER_LIMIT) {
      flush();
      if (!unit.fence) {
        output.push({ kind: "legacy", source: unit.source });
        return;
      }
      for (const chunk of splitFence(unit)) add(chunk);
      return;
    }
    const exceeds = pending && (
      codePointLength(`${pending.markdown}${unit.before}${unit.markdown}`) > TELEGRAM_RICH_CHARACTER_LIMIT ||
      pending.blocks + unit.blocks > TELEGRAM_RICH_BLOCK_LIMIT ||
      pending.mediaCount + unit.mediaCount > TELEGRAM_RICH_MEDIA_LIMIT
    );
    if (exceeds) flush();
    if (!pending) {
      pending = {
        markdown: unit.markdown,
        source: unit.source,
        blocks: unit.blocks,
        mediaCount: unit.mediaCount,
        images: [...unit.images],
      };
      return;
    }
    pending.markdown += `${unit.before}${unit.markdown}`;
    pending.source += `${unit.before}${unit.source}`;
    pending.blocks += unit.blocks;
    pending.mediaCount += unit.mediaCount;
    pending.images.push(...unit.images);
  };
  const addTextSource = (source: string): void => {
    const units = scanTelegramRichMarkdown(source, {
      blocks: TELEGRAM_RICH_BLOCK_LIMIT,
      nesting: TELEGRAM_RICH_NESTING_LIMIT,
      media: TELEGRAM_RICH_MEDIA_LIMIT,
      tableColumns: TELEGRAM_RICH_TABLE_COLUMN_LIMIT,
    });
    units.forEach((unit, index) => add({
      ...unit,
      before: index === 0 && hasRunContent ? "\n\n" : unit.before,
      images: [],
    }));
    hasRunContent ||= units.length > 0;
  };
  const addLegacyText = (source: string): void => {
    flush();
    output.push({ kind: "legacy", source });
    hasRunContent = true;
  };
  const addIndependentText = (items: readonly string[], start: number, end: number): void => {
    let batchStart = start;
    let batchLength = 0;
    for (let index = start; index <= end; index += 1) {
      const nextLength = batchLength + (index === batchStart ? 0 : 2) + items[index]!.length;
      if (batchLength && nextLength > MAX_ADJACENT_TEXT_BATCH_CHARACTERS) {
        addTextSource(joinTextItems(items, batchStart, index - 1));
        batchStart = index;
        batchLength = items[index]!.length;
      } else {
        batchLength = nextLength;
      }
    }
    if (batchStart <= end) addTextSource(joinTextItems(items, batchStart, end));
  };
  const addTextRun = (items: readonly string[]): void => {
    if (items.length === 1) {
      addTextSource(items[0]!);
      return;
    }
    const spans = textDependencySpans(items);
    if (!spans) {
      items.forEach(addLegacyText);
      return;
    }
    let cursor = 0;
    for (const span of spans) {
      if (cursor < span.start) addIndependentText(items, cursor, span.start - 1);
      if (joinedTextLength(items, span.start, span.end) > MAX_ADJACENT_TEXT_BATCH_CHARACTERS) {
        for (let index = span.start; index <= span.end; index += 1) addLegacyText(items[index]!);
      } else {
        addTextSource(joinTextItems(items, span.start, span.end));
      }
      cursor = span.end + 1;
    }
    if (cursor < items.length) addIndependentText(items, cursor, items.length - 1);
  };
  for (let contentIndex = 0; contentIndex < result.content.length; contentIndex += 1) {
    const content = result.content[contentIndex]!;
    if (content.kind === "text") {
      const adjacentText = [content.text];
      while (true) {
        const next = result.content[contentIndex + 1];
        if (next?.kind !== "text") break;
        adjacentText.push(next.text);
        contentIndex += 1;
      }
      addTextRun(adjacentText);
      continue;
    }
    if (content.attachment.kind === "file") {
      flush();
      output.push({ kind: "file", attachment: content.attachment });
      hasRunContent = false;
      continue;
    }
    let id: string;
    do {
      imageOrdinal += 1;
      id = `generated_${String(imageOrdinal).padStart(4, "0")}`;
    } while (reservedImageIds.has(id));
    const reference = `![](tg://photo?id=${id})`;
    add({
      source: reference,
      markdown: reference,
      before: hasRunContent ? "\n\n" : "",
      blocks: 1,
      depth: 1,
      columns: 0,
      mediaCount: 1,
      images: [{
        id,
        path: content.attachment.path,
        ...(Object.hasOwn(content.attachment, "name") ? { name: content.attachment.name } : {}),
      }],
      fence: false,
      valid: true,
    });
    hasRunContent = true;
  }
  flush();
  return output;
}

function userAuthoredImageIds(result: TelegramTurnResult): Set<string> {
  const ids = new Set<string>();
  const marker = /!\[\]\(tg:\/\/photo\?id=(generated_[0-9]+)\)/g;
  for (const content of result.content) {
    if (content.kind !== "text") continue;
    for (const match of content.text.matchAll(marker)) {
      if (isTelegramRichMediaId(match[1])) ids.add(match[1]);
    }
  }
  return ids;
}

function textDependencySpans(items: readonly string[]): TextDependencySpan[] | undefined {
  const definitions = new Map<string, number>();
  const usages: Array<readonly [label: string, index: number]> = [];
  let labels = 0;
  for (let index = 0; index < items.length; index += 1) {
    const dependencies = telegramRichDependencyLabels(items[index]!, MAX_DEPENDENCY_LABELS - labels);
    labels += dependencies.definitions.size + dependencies.usages.size;
    if (dependencies.overflow || labels > MAX_DEPENDENCY_LABELS) return undefined;
    for (const label of dependencies.definitions) {
      if (!definitions.has(label)) definitions.set(label, index);
    }
    for (const label of dependencies.usages) usages.push([label, index]);
  }

  const spans = usages.flatMap(([label, usage]) => {
    const definition = definitions.get(label);
    return definition === undefined || definition === usage
      ? []
      : [{ start: Math.min(usage, definition), end: Math.max(usage, definition) }];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextDependencySpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function joinedTextLength(items: readonly string[], start: number, end: number): number {
  let length = Math.max(0, end - start) * 2;
  for (let index = start; index <= end; index += 1) length += items[index]!.length;
  return length;
}

function joinTextItems(items: readonly string[], start: number, end: number): string {
  return start === end ? items[start]! : items.slice(start, end + 1).join("\n\n");
}

function splitFence(unit: RichUnit): RichUnit[] {
  const lines = unit.markdown.split("\n");
  const opening = lines[0]?.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  const closing = lines.at(-1)?.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
  if (!opening || !closing || opening[2]![0] !== closing[2]![0] ||
    closing[2]!.length < opening[2]!.length || !/^[A-Za-z0-9_+.-]*$/.test(opening[3]!.trim())) {
    return [{ ...unit, fence: false, valid: false }];
  }
  const opener = lines[0]!;
  const closer = `${opening[1]}${opening[2]}`;
  const width = TELEGRAM_RICH_CHARACTER_LIMIT - codePointLength(`${opener}\n\n${closer}`);
  if (width < 1) return [{ ...unit, fence: false, valid: false }];
  const points = [...lines.slice(1, -1).join("\n")];
  const chunks: RichUnit[] = [];
  for (let index = 0; index < points.length; index += width) {
    const markdown = `${opener}\n${points.slice(index, index + width).join("")}\n${closer}`;
    chunks.push({ ...unit, source: markdown, markdown, before: chunks.length ? "\n\n" : "" });
  }
  return chunks;
}
