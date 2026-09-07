import {
  isTelegramRichBlockTag,
  isTelegramRichNonNestingTag,
  isTelegramRichSafeMarkdownUrl,
  isTelegramRichSafeMediaUrl,
  isTelegramRichTag,
  isTelegramRichVoidTag,
} from "./telegram-rich-html.js";
import {
  buildDelimiterMaps,
  buildEscapeMap,
  telegramRichLineNumber,
  telegramRichLineStarts,
  telegramRichReferenceLabel,
  tokenizeTelegramRichHtml,
  type TelegramRichHtmlToken,
  type TelegramRichMarkupToken,
  type TelegramRichDelimiterMaps,
} from "./telegram-rich-tokens.js";

export interface TelegramRichMetricLimits {
  readonly blocks: number;
  readonly nesting: number;
  readonly media: number;
  readonly tableColumns: number;
}

export interface TelegramRichMetrics {
  readonly blocks: number;
  readonly depth: number;
  readonly columns: number;
  readonly mediaCount: number;
}

interface ListLevel {
  readonly contentIndent: number;
  readonly marker: string;
}

interface InlineLayer {
  readonly end: number;
  readonly label: string;
  readonly labelStart: number;
}

interface InlineProfile {
  readonly maximum: number;
  readonly at: readonly number[];
}

export function measureTelegramRichMarkdown(
  source: string,
  references: ReadonlyMap<string, string>,
  limits: TelegramRichMetricLimits,
): TelegramRichMetrics {
  const tokens = tokenizeTelegramRichHtml(source);
  const blocks = countBlocks(source, tokens, limits.blocks);
  if (blocks > limits.blocks) return exceeded(blocks);

  const depth = maximumDepth(source, tokens, references, limits.nesting);
  if (depth > limits.nesting) return exceeded(blocks, depth);

  const columns = maximumTableColumns(source, tokens, limits.tableColumns);
  if (columns > limits.tableColumns) return exceeded(blocks, depth, columns);

  return {
    blocks,
    depth,
    columns,
    mediaCount: countMedia(source, tokens, references, limits.media),
  };
}

export function countTelegramReferenceMedia(
  source: string,
  references: ReadonlyMap<string, string>,
  limit = Number.POSITIVE_INFINITY,
): number {
  let count = 0;
  for (const match of source.matchAll(/!\[((?:\\.|[^\]])*)\]\[((?:\\.|[^\]])*)\]/g)) {
    const label = telegramRichReferenceLabel(match[2] || match[1]!);
    if (isTelegramRichSafeMediaUrl(references.get(label) ?? "") && ++count > limit) return count;
  }
  for (const match of source.matchAll(/!\[((?:\\.|[^\]])+)\](?![[(])/g)) {
    if (isTelegramRichSafeMediaUrl(references.get(telegramRichReferenceLabel(match[1]!)) ?? "") &&
      ++count > limit) return count;
  }
  return count;
}

function exceeded(blocks: number, depth = 1, columns = 0): TelegramRichMetrics {
  return { blocks, depth, columns, mediaCount: 0 };
}

function countBlocks(source: string, tokens: readonly TelegramRichHtmlToken[], limit: number): number {
  const lines = source.split("\n");
  const starts = telegramRichLineStarts(lines);
  const htmlBlockLines = new Set<number>();
  const markupLines = new Map<number, TelegramRichMarkupToken[]>();
  let blocks = 0;
  for (const token of tokens) {
    if (token.kind !== "markup") continue;
    const line = telegramRichLineNumber(starts, token.start);
    const lineTokens = markupLines.get(line) ?? [];
    lineTokens.push(token);
    markupLines.set(line, lineTokens);
    if (!token.parsed?.closing && isTelegramRichBlockTag(token.parsed?.tag ?? "")) {
      blocks += 1;
      if (blocks > limit) return blocks;
      htmlBlockLines.add(line);
    }
  }

  const tableLines = markdownTableLines(lines);
  blocks += tableLines.rows + tableLines.containers;
  if (blocks > limit) return blocks;

  let paragraph = false;
  let quoteDepth = 0;
  const listLevels: ListLevel[] = [];
  const flush = (): boolean => {
    if (paragraph) blocks += 1;
    paragraph = false;
    return blocks > limit;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const quoted = stripQuotePrefix(lines[index]!);
    const visible = quoted.content;
    if (quoted.quotes > quoteDepth) blocks += quoted.quotes - quoteDepth;
    quoteDepth = quoted.quotes;
    const list = updateListLevels(visible, listLevels);
    if (list) blocks += list.containers;
    else if (!visible.trim() || isSpecialLine(visible)) listLevels.length = 0;
    if (blocks > limit) return blocks;

    if (tableLines.lines.has(index) || htmlBlockLines.has(index)) {
      if (flush()) return blocks;
    } else if (/^ {0,3}#{1,6}\s+/.test(visible)) {
      if (flush()) return blocks;
      blocks += 1;
    } else if (isListLine(visible)) {
      if (flush()) return blocks;
      blocks += 1;
    } else if (/^ {0,3}(?:-{3,}|\[\^[^\]]+\]:)\s*/.test(visible)) {
      if (flush()) return blocks;
      if (/\S/.test(visible)) blocks += 1;
    } else if (maskMarkup(
      visible,
      markupLines.get(index) ?? [],
      starts[index]! + lines[index]!.length - visible.length,
    ).trim()) {
      paragraph = true;
    } else if (flush()) {
      return blocks;
    }
    if (blocks > limit) return blocks;
  }
  flush();
  return Math.max(1, blocks);
}

function maximumDepth(
  source: string,
  tokens: readonly TelegramRichHtmlToken[],
  references: ReadonlyMap<string, string>,
  limit: number,
): number {
  const lines = source.split("\n");
  const starts = telegramRichLineStarts(lines);
  const markup = tokens.filter((token): token is TelegramRichMarkupToken => token.kind === "markup");
  let tokenIndex = 0;
  let htmlDepth = 0;
  let maximum = 1;
  const listLevels: ListLevel[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineStart = starts[lineIndex]!;
    const lineEnd = lineStart + lines[lineIndex]!.length;
    const lineTokens: TelegramRichMarkupToken[] = [];
    while (tokenIndex < markup.length && markup[tokenIndex]!.start <= lineEnd) {
      if (markup[tokenIndex]!.start >= lineStart) lineTokens.push(markup[tokenIndex]!);
      tokenIndex += 1;
    }

    const quoted = stripQuotePrefix(lines[lineIndex]!);
    const quoteOffset = lines[lineIndex]!.length - quoted.content.length;
    const list = updateListLevels(quoted.content, listLevels);
    if (!list && (!quoted.content.trim() || isSpecialLine(quoted.content))) listLevels.length = 0;
    const markdownDepth = quoted.quotes + (list?.depth ?? 0);
    const visibleStart = lineStart + quoteOffset;
    const nestedTokens = lineTokens.filter((token) => nestingTag(token));
    const points = nestedTokens.filter((token) => !token.parsed!.closing)
      .map((token) => token.start - visibleStart);
    const masked = maskMarkup(quoted.content, lineTokens, visibleStart);
    const profile = inlineProfile(masked, references, points, limit - markdownDepth);
    maximum = Math.max(maximum, htmlDepth + markdownDepth + profile.maximum, markdownDepth + profile.maximum || 1);
    if (maximum > limit) return limit + 1;

    let openingIndex = 0;
    for (const token of nestedTokens) {
      if (token.parsed!.closing) {
        htmlDepth = Math.max(0, htmlDepth - 1);
      } else {
        htmlDepth += 1;
        maximum = Math.max(maximum, markdownDepth + htmlDepth + (profile.at[openingIndex++] ?? 0));
        if (maximum > limit) return limit + 1;
      }
    }
  }
  return maximum;
}

function inlineProfile(
  source: string,
  references: ReadonlyMap<string, string>,
  points: readonly number[],
  limit: number,
): InlineProfile {
  const escaped = buildEscapeMap(source);
  const delimiters = buildDelimiterMaps(source, escaped);
  const stack: string[] = [];
  const at = new Array<number>(points.length).fill(0);
  let pointIndex = 0;
  let maximum = 0;

  const capture = (index: number): void => {
    while (pointIndex < points.length && points[pointIndex]! <= index) {
      at[pointIndex++] = stack.length;
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    capture(index);
    const layer = inlineLayer(source, index, references, escaped, delimiters);
    if (layer) {
      const nestedPoints: number[] = [];
      const nestedIndexes: number[] = [];
      while (pointIndex < points.length && points[pointIndex]! <= layer.end) {
        const point = points[pointIndex]!;
        if (point >= layer.labelStart && point <= layer.labelStart + layer.label.length) {
          nestedPoints.push(point - layer.labelStart);
          nestedIndexes.push(pointIndex);
        } else {
          at[pointIndex] = stack.length;
        }
        pointIndex += 1;
      }
      const nested = inlineProfile(layer.label, references, nestedPoints, limit - stack.length - 1);
      maximum = Math.max(maximum, stack.length + 1 + nested.maximum);
      nestedIndexes.forEach((target, nestedIndex) => {
        at[target] = stack.length + 1 + (nested.at[nestedIndex] ?? 0);
      });
      if (maximum > limit) return { maximum: limit + 1, at };
      index = layer.end;
      continue;
    }

    if (!"*_~|=".includes(source[index]!) || escaped[index]) continue;
    const marker = ["**", "__", "~~", "||", "==", "*", "_"].find((value) =>
      source.startsWith(value, index));
    if (!marker) continue;
    const before = source[index - 1] ?? "";
    const after = source[index + marker.length] ?? "";
    const canOpen = Boolean(after && !/\s/.test(after));
    const canClose = Boolean(before && !/\s/.test(before));
    const intrawordUnderscore = marker.includes("_") && /[\p{L}\p{N}]/u.test(before) &&
      /[\p{L}\p{N}]/u.test(after);
    if (stack.at(-1) === marker && canClose) {
      maximum = Math.max(maximum, stack.length);
      stack.pop();
    } else if (canOpen && !intrawordUnderscore) {
      stack.push(marker);
      if (stack.length > limit) return { maximum: limit + 1, at };
    }
    index += marker.length - 1;
  }
  capture(source.length);
  return { maximum, at };
}

function inlineLayer(
  source: string,
  index: number,
  references: ReadonlyMap<string, string>,
  escaped: Uint8Array,
  delimiters: TelegramRichDelimiterMaps,
): InlineLayer | undefined {
  const image = source[index] === "!" && source[index + 1] === "[";
  const opening = image ? index + 1 : index;
  if (source[opening] !== "[" || (!image && source[index - 1] === "!") || escaped[opening] ||
    (image && escaped[index])) return undefined;
  const labelEnd = delimiters.brackets[opening] ?? -1;
  if (labelEnd < 0) return undefined;

  const label = source.slice(opening + 1, labelEnd);
  let end = labelEnd;
  let url = "";
  if (source[labelEnd + 1] === "(") {
    end = delimiters.parentheses[labelEnd + 1] ?? -1;
    if (end < 0) return undefined;
    const target = source.slice(labelEnd + 2, end).trim();
    url = target.match(/^<([^>]*)>|^([^\s]+)(?:\s|$)/)?.slice(1).find(Boolean) ?? "";
  } else if (source[labelEnd + 1] === "[") {
    end = delimiters.brackets[labelEnd + 1] ?? -1;
    if (end < 0) return undefined;
    url = references.get(telegramRichReferenceLabel(source.slice(labelEnd + 2, end) || label)) ?? "";
  } else {
    url = references.get(telegramRichReferenceLabel(label)) ?? "";
  }
  return isTelegramRichSafeMarkdownUrl(url, image) ?
    { end, label, labelStart: opening + 1 } : undefined;
}

function maximumTableColumns(
  source: string,
  tokens: readonly TelegramRichHtmlToken[],
  limit: number,
): number {
  let maximum = 0;
  let column = 0;
  let active: number[] = [];
  let inRow = false;
  for (const token of tokens) {
    const parsed = token.kind === "markup" ? token.parsed : undefined;
    if (!parsed) continue;
    if (parsed.tag === "tr") {
      if (parsed.closing) {
        maximum = Math.max(maximum, column, active.reduce((width, rows, index) => rows ? index + 1 : width, 0));
        if (maximum > limit) return limit + 1;
        active = active.map((rows) => Math.max(0, rows - 1));
        inRow = false;
      } else {
        column = 0;
        inRow = true;
      }
    } else if (inRow && !parsed.closing && (parsed.tag === "td" || parsed.tag === "th")) {
      const colspan = Math.min(attributeSpan(parsed.attributes, "colspan"), limit + 1);
      const rowspan = attributeSpan(parsed.attributes, "rowspan");
      while (active.slice(column, column + colspan).some(Boolean)) column += 1;
      for (let offset = 0; offset < colspan; offset += 1) {
        active[column + offset] = Math.max(active[column + offset] ?? 0, rowspan);
      }
      column += colspan;
      if (column > limit) return limit + 1;
    }
  }

  const lines = source.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isTableStart(lines, index)) continue;
    while (index < lines.length && hasTablePipe(lines[index]!)) {
      maximum = Math.max(maximum, tableColumns(lines[index]!));
      if (maximum > limit) return limit + 1;
      index += 1;
    }
  }
  return maximum;
}

function countMedia(
  source: string,
  tokens: readonly TelegramRichHtmlToken[],
  references: ReadonlyMap<string, string>,
  limit: number,
): number {
  let count = countTelegramReferenceMedia(source, references, limit);
  if (count > limit) return count;
  for (const _match of source.matchAll(/!\[[^\]]*\]\(\s*<?https?:[^)\s>]+>?[^)]*\)/gi)) {
    if (++count > limit) return count;
  }
  for (const token of tokens) {
    const parsed = token.kind === "markup" ? token.parsed : undefined;
    if (!parsed || parsed.closing || !["img", "video", "audio"].includes(parsed.tag)) continue;
    if (isTelegramRichSafeMediaUrl(parsed.attributes.get("src") ?? "") && ++count > limit) return count;
  }
  return count;
}

function nestingTag(token: TelegramRichMarkupToken): boolean {
  const parsed = token.parsed;
  return Boolean(parsed && isTelegramRichTag(parsed.tag) && !isTelegramRichVoidTag(parsed.tag) &&
    !parsed.selfClosing && !isTelegramRichNonNestingTag(parsed.tag));
}

function maskMarkup(
  line: string,
  tokens: readonly TelegramRichMarkupToken[],
  lineStart: number,
): string {
  if (!tokens.length) return line;
  const chars = line.split("");
  for (const token of tokens) {
    if (!token.complete) continue;
    const start = Math.max(0, token.start - lineStart);
    const end = Math.min(chars.length, token.end - lineStart);
    for (let index = start; index < end; index += 1) chars[index] = " ";
  }
  return chars.join("");
}

function updateListLevels(line: string, levels: ListLevel[]):
  { readonly depth: number; readonly containers: number } | undefined {
  const match = line.match(/^(\s*)((?:[-+*])|(?:\d+[.)]))(\s+)/);
  if (!match) return undefined;
  const width = (value: string): number => value.replace(/\t/g, "    ").length;
  const indent = width(match[1]!);
  const padding = width(match[3]!);
  const contentIndent = indent + match[2]!.length + (padding <= 4 ? padding : 1);
  let depth = 1;
  while (depth <= levels.length && indent >= levels[depth - 1]!.contentIndent) depth += 1;
  const marker = /^\d/.test(match[2]!) ? `ordered${match[2]!.at(-1)}` : match[2]!;
  const containers = levels[depth - 1]?.marker === marker ? 0 : 1;
  levels[depth - 1] = { contentIndent, marker };
  levels.length = depth;
  return { depth, containers };
}

function markdownTableLines(lines: readonly string[]): {
  readonly lines: ReadonlySet<number>;
  readonly rows: number;
  readonly containers: number;
} {
  const result = new Set<number>();
  let rows = 0;
  let containers = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isTableStart(lines, index)) continue;
    containers += 1;
    result.add(index);
    result.add(index + 1);
    rows += 1;
    index += 2;
    while (index < lines.length && lines[index]!.trim() && hasTablePipe(lines[index]!)) {
      result.add(index++);
      rows += 1;
    }
    index -= 1;
  }
  return { lines: result, rows, containers };
}

function stripQuotePrefix(line: string): { readonly content: string; readonly quotes: number } {
  let content = line;
  let quotes = 0;
  while (true) {
    const match = content.match(/^ {0,3}>[ \t]?/);
    if (!match) return { content, quotes };
    content = content.slice(match[0].length);
    quotes += 1;
  }
}

function isSpecialLine(line: string): boolean {
  return /^ {0,3}(?:#{1,6}\s+|---+\s*$|\[\^[^\]]+\]:|>|\$\$\s*$)/.test(line) || isListLine(line);
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
}

function isTableStart(lines: readonly string[], index: number): boolean {
  return index + 1 < lines.length && hasTablePipe(lines[index]!) &&
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]!);
}

function hasTablePipe(line: string): boolean {
  return /(^|[^\\])\|/.test(line);
}

function tableColumns(line: string): number {
  let pipes = 0;
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "`" && line[index - 1] !== "\\") inCode = !inCode;
    if (!inCode && line[index] === "|" && line[index - 1] !== "\\") pipes += 1;
  }
  const trimmed = line.trim();
  return Math.max(0, pipes + 1 - Number(trimmed.startsWith("|")) - Number(trimmed.endsWith("|")));
}

function attributeSpan(attributes: ReadonlyMap<string, string | undefined>, name: string): number {
  const value = attributes.get(name);
  return value && /^[1-9]\d*$/.test(value) ? Number(value) : 1;
}
