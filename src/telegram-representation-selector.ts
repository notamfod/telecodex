import {
  TELEGRAM_RICH_BLOCK_LIMIT,
  TELEGRAM_RICH_MEDIA_LIMIT,
  TELEGRAM_RICH_NESTING_LIMIT,
  TELEGRAM_RICH_TABLE_COLUMN_LIMIT,
} from "./telegram-rich-message.js";
import {
  scanTelegramRichMarkdown,
  telegramRichDependencyLabels,
  type TelegramRichMarkdownUnit,
} from "./telegram-rich-markdown.js";
import {
  buildDelimiterMaps,
  buildEscapeMap,
  tokenizeTelegramRichHtml,
} from "./telegram-rich-tokens.js";
import type { TelegramTurnResult } from "./telegram-turn-result.js";

export type TelegramTextRepresentation = "compact_html" | "native_rich";

export interface TelegramTextRepresentationInput {
  readonly source: string;
  readonly positionedImageCount: number;
}

interface InlineDelimiterRun {
  readonly start: number;
  readonly end: number;
  readonly width: number;
  readonly line: number;
}

const SCAN_LIMITS = {
  blocks: TELEGRAM_RICH_BLOCK_LIMIT,
  nesting: TELEGRAM_RICH_NESTING_LIMIT,
  media: TELEGRAM_RICH_MEDIA_LIMIT,
  tableColumns: TELEGRAM_RICH_TABLE_COLUMN_LIMIT,
} as const;
const MAX_ADJACENT_TEXT_BATCH_CHARACTERS = 1_000_000;

export function selectTelegramTextRepresentation(
  input: TelegramTextRepresentationInput,
): TelegramTextRepresentation {
  if (!Number.isSafeInteger(input.positionedImageCount) || input.positionedImageCount < 0) {
    throw new Error("Invalid positioned image count");
  }
  if (input.positionedImageCount > 0) return "native_rich";
  return scanTelegramRichMarkdown(maskEscapedAdvancedMarkers(input.source), SCAN_LIMITS)
    .some(requiresNativeRich)
    ? "native_rich"
    : "compact_html";
}

export function selectTelegramTurnRepresentation(
  result: TelegramTurnResult,
): TelegramTextRepresentation {
  let adjacentText: string[] = [];
  let adjacentTextLength = 0;
  const flush = (): boolean => {
    if (adjacentText.length === 0) return false;
    const source = adjacentText.join("\n\n");
    adjacentText = [];
    adjacentTextLength = 0;
    return selectTelegramTextRepresentation({ source, positionedImageCount: 0 }) === "native_rich";
  };

  for (const content of result.content) {
    if (content.kind === "text") {
      adjacentTextLength += (adjacentText.length === 0 ? 0 : 2) + content.text.length;
      if (adjacentTextLength > MAX_ADJACENT_TEXT_BATCH_CHARACTERS) return "native_rich";
      adjacentText.push(content.text);
      continue;
    }
    if (flush() || content.attachment.kind === "image") return "native_rich";
  }
  return flush() ? "native_rich" : "compact_html";
}

function requiresNativeRich(unit: TelegramRichMarkdownUnit): boolean {
  if (!unit.valid || unit.columns > 0 || unit.mediaCount > 0) return true;
  const dependencies = telegramRichDependencyLabels(unit.source, 1_024);
  if (dependencies.overflow || dependencies.definitions.size > 0 ||
    [...dependencies.usages].some((label) => label.startsWith("footnote:"))) return true;
  if (unit.fence) return false;
  const visible = withoutInlineCode(unit.source);
  if (hasFormula(withoutUrlText(withoutMarkdownLinkTargets(visible)))) return true;
  return tokenizeTelegramRichHtml(visible).some((token) => token.kind === "markup"
    && token.parsed !== undefined
    && ["details", "table", "tg-math", "tg-math-block"].includes(token.parsed.tag));
}

function withoutUrlText(source: string): string {
  const protocols = ["https://", "http://", "tg://", "mailto:"];
  const lower = source.toLowerCase();
  const characters = source.split("");
  for (let index = 0; index < source.length;) {
    const protocol = protocols.find((candidate) => lower.startsWith(candidate, index));
    if (!protocol) {
      index += 1;
      continue;
    }
    let end = index + protocol.length;
    while (end < source.length && source[end] !== ">" && source[end]!.trim() !== "") end += 1;
    characters.fill(" ", index, end);
    index = end;
  }
  return characters.join("");
}

function withoutMarkdownLinkTargets(source: string): string {
  const escaped = buildEscapeMap(source);
  const delimiters = buildDelimiterMaps(source, escaped);
  const characters = source.split("");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[" || escaped[index]) continue;
    const labelEnd = delimiters.brackets[index] ?? -1;
    if (labelEnd < 0 || source[labelEnd + 1] !== "(") continue;
    const targetEnd = delimiters.parentheses[labelEnd + 1] ?? -1;
    if (targetEnd < 0) continue;
    characters.fill(" ", labelEnd + 2, targetEnd);
    index = targetEnd;
  }
  return characters.join("");
}

function maskEscapedAdvancedMarkers(source: string): string {
  const escaped = buildEscapeMap(source);
  const characters = source.split("");
  for (let index = 0; index < characters.length; index += 1) {
    if (escaped[index] && ["!", "$", "<"].includes(characters[index]!)) characters[index] = " ";
  }
  return characters.join("");
}

function withoutInlineCode(source: string): string {
  const escaped = buildEscapeMap(source);
  const runs: InlineDelimiterRun[] = [];
  let line = 0;
  for (let index = 0; index < source.length;) {
    if (source[index] === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (source[index] !== "`" || escaped[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (source[index] === "`") index += 1;
    runs.push({ start, end: index, width: index - start, line });
  }

  const nextMatching = new Int32Array(runs.length).fill(-1);
  const nextByLineAndWidth = new Map<string, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    const key = `${run.line}:${run.width}`;
    nextMatching[index] = nextByLineAndWidth.get(key) ?? -1;
    nextByLineAndWidth.set(key, index);
  }

  let output = "";
  let cursor = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index]!;
    if (opening.start < cursor) continue;
    const closingIndex = nextMatching[index]!;
    if (closingIndex < 0) continue;
    const closing = runs[closingIndex]!;
    output += source.slice(cursor, opening.start);
    output += " ".repeat(closing.end - opening.start);
    cursor = closing.end;
    index = closingIndex;
  }
  return `${output}${source.slice(cursor)}`;
}

function hasFormula(source: string): boolean {
  const escaped = buildEscapeMap(source);
  const pendingInlineWidths = new Set<number>();
  let blockBoundarySeen = false;
  let lineStart = 0;

  for (let index = 0; index <= source.length;) {
    if (index === source.length || source[index] === "\n") {
      if (isFormulaBoundaryLine(source.slice(lineStart, index))) {
        if (blockBoundarySeen) return true;
        blockBoundarySeen = true;
      }
      pendingInlineWidths.clear();
      lineStart = index + 1;
      index += 1;
      continue;
    }
    if (source[index] !== "$" || escaped[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (source[index] === "$" && !escaped[index]) index += 1;
    const runWidth = index - start;
    const candidateWidths = runWidth === 1 ? [1] : runWidth === 2 ? [2] : [1, 2];
    for (const width of candidateWidths) {
      if (pendingInlineWidths.has(width)) return true;
      pendingInlineWidths.add(width);
    }
  }
  return false;
}

function isFormulaBoundaryLine(line: string): boolean {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  if (!line.startsWith("$$", index)) return false;
  index += 2;
  while (line[index] === " " || line[index] === "\t") index += 1;
  return index === line.length;
}
