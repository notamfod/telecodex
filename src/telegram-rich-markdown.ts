import {
  countTelegramReferenceMedia,
  measureTelegramRichMarkdown,
} from "./telegram-rich-markdown-metrics.js";
import {
  isTelegramRichContainerTag,
  isTelegramRichSafeMarkdownUrl,
  isTelegramRichSafeMediaUrl,
  isTelegramRichSafeUrl,
  sanitizeTelegramRichHtml,
} from "./telegram-rich-html.js";
import {
  buildDelimiterMaps,
  buildEscapeMap,
  collectTelegramRichDependencyLabels,
  telegramRichReferenceLabel,
  tokenizeTelegramRichHtml,
  type TelegramRichDependencyLabels,
} from "./telegram-rich-tokens.js";

export interface TelegramRichMarkdownUnit {
  readonly source: string;
  readonly markdown: string;
  readonly before: string;
  readonly blocks: number;
  readonly depth: number;
  readonly columns: number;
  readonly mediaCount: number;
  readonly fence: boolean;
  readonly valid: boolean;
}

interface ScanLimits {
  readonly blocks: number;
  readonly nesting: number;
  readonly media: number;
  readonly tableColumns: number;
}

interface FenceMarker {
  readonly marker: string;
  readonly quotes: number;
}

export function scanTelegramRichMarkdown(
  source: string,
  limits: ScanLimits,
): TelegramRichMarkdownUnit[] {
  const lines = source.split("\n");
  const references = referenceTargets(source);
  let units: TelegramRichMarkdownUnit[] = [];
  let index = 0;
  let before = "";

  while (index < lines.length) {
    if (!lines[index]!.trim()) {
      before += `${index === 0 ? "" : "\n"}${lines[index]}`;
      index += 1;
      continue;
    }

    const start = index;
    let valid = true;
    let fence = false;
    let formula = false;
    const openingFence = fenceOpening(lines[index]!, false);
    const container = htmlContainer(lines[index]!);

    if (openingFence) {
      fence = true;
      index += 1;
      while (index < lines.length && !fenceClosing(lines[index]!, openingFence)) index += 1;
      if (index === lines.length) valid = false;
      else index += 1;
    } else if (container) {
      let balance = containerDelta(protectCode(lines[index]!, [], true), container);
      let nestedFence: FenceMarker | undefined;
      index += 1;
      while (balance > 0 && index < lines.length) {
        if (nestedFence) {
          if (fenceClosing(lines[index]!, nestedFence)) nestedFence = undefined;
        } else {
          nestedFence = fenceOpening(lines[index]!, true);
          if (!nestedFence) balance += containerDelta(protectCode(lines[index]!, [], true), container);
        }
        index += 1;
      }
      valid = balance === 0 && !nestedFence;
    } else if (isFormulaBoundary(lines[index]!)) {
      formula = true;
      index += 1;
      while (index < lines.length && !isFormulaBoundary(lines[index]!)) index += 1;
      if (index === lines.length) valid = false;
      else index += 1;
    } else if (isTableStart(lines, index)) {
      index += 2;
      while (index < lines.length && lines[index]!.trim() && hasTablePipe(lines[index]!)) index += 1;
    } else if (isListLine(lines[index]!)) {
      index = continuationEnd(lines, index + 1, true);
    } else if (/^ {0,3}>/.test(lines[index]!)) {
      index = quoteContinuationEnd(lines, index);
    } else if (/^ {0,3}\[\^[^\]]+\]:/.test(lines[index]!)) {
      index = continuationEnd(lines, index + 1, false);
    } else if (/^ {0,3}#{1,6}\s+/.test(lines[index]!)) {
      index += 1;
    } else {
      index += 1;
      while (index < lines.length && lines[index]!.trim() && !isSpecialStart(lines, index)) index += 1;
    }

    const raw = lines.slice(start, index).join("\n");
    const structural = fence || formula ? "" : protectCode(raw, [], true);
    const [markdown, safe] = sanitizeMarkdown(raw, references);
    const metrics = fence || formula ? {
      blocks: 1,
      depth: 1,
      columns: 0,
      mediaCount: 0,
    } : measureTelegramRichMarkdown(structural, references, limits);
    units.push({
      source: raw,
      markdown,
      before: units.length === 0 ? before : `\n${before}`,
      ...metrics,
      fence,
      valid: valid && safe,
    });
    before = "";
  }

  if (units.length > 1 && hasCrossBlockDependency(source)) {
    units = [combineDependentUnits(source, units)];
  }
  if (countTelegramReferenceMedia(protectCode(source, []), references, limits.media) > limits.media && units[0]) {
    return [{ ...units[0], source, valid: false }];
  }
  return units;
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export function telegramRichDependencyLabels(
  source: string,
  limit: number,
): TelegramRichDependencyLabels {
  return collectTelegramRichDependencyLabels(protectCode(source, []), limit);
}

function combineDependentUnits(
  source: string,
  units: readonly TelegramRichMarkdownUnit[],
): TelegramRichMarkdownUnit {
  return {
    source,
    markdown: units.map((unit, index) => `${index ? unit.before : ""}${unit.markdown}`).join(""),
    before: "",
    blocks: units.reduce((total, unit) => total + unit.blocks, 0),
    depth: Math.max(...units.map((unit) => unit.depth)),
    columns: Math.max(...units.map((unit) => unit.columns)),
    mediaCount: units.reduce((total, unit) => total + unit.mediaCount, 0),
    fence: false,
    valid: units.every((unit) => unit.valid),
  };
}

function hasCrossBlockDependency(
  source: string,
): boolean {
  const dependencies = telegramRichDependencyLabels(source, Number.POSITIVE_INFINITY);
  return [...dependencies.usages].some((label) => dependencies.definitions.has(label));
}

function sanitizeMarkdown(
  source: string,
  references: ReadonlyMap<string, string>,
): [markdown: string, valid: boolean] {
  const protectedCode: string[] = [];
  let value = protectCode(source, protectedCode);
  value = sanitizeMarkdownLinks(value, references, protectedCode);
  value = value.replace(
    /^((?: {0,3}>[ \t]?)* {0,3})\[((?!\^)(?:\\.|[^\]])+)\]:\s*(\S+).*$/gm,
    (whole, prefix: string, label: string, target: string) => {
      const url = target.match(/^<([^<>]+)>$/)?.[1] ?? target;
      if (!isTelegramRichSafeUrl(url)) return `${prefix}${codeText(`${label} (${url})`)}`;
      return url === target ? whole : whole.replace(target, protectedToken(protectedCode, target));
    },
  );
  const [markdown, valid] = sanitizeTelegramRichHtml(value, codeText);
  return [restoreCode(markdown, protectedCode), valid];
}

function sanitizeMarkdownLinks(
  source: string,
  references: ReadonlyMap<string, string>,
  protectedCode: string[],
): string {
  const escaped = buildEscapeMap(source);
  const delimiters = buildDelimiterMaps(source, escaped);
  let output = "";
  let index = 0;
  while (index < source.length) {
    const image = source[index] === "!" && source[index + 1] === "[";
    const start = image ? index + 1 : index;
    if (source[start] !== "[") {
      output += source[index++];
      continue;
    }
    const labelEnd = delimiters.brackets[start] ?? -1;
    if (labelEnd < 0 || source[labelEnd + 1] !== "(") {
      output += source[index++];
      continue;
    }
    const targetEnd = delimiters.parentheses[labelEnd + 1] ?? -1;
    if (targetEnd < 0) {
      output += source[index++];
      continue;
    }
    const target = source.slice(labelEnd + 2, targetEnd).trim();
    const url = target.match(/^<([^>]*)>|^([^\s]+)(?:\s|$)/)?.slice(1).find(Boolean) ?? "";
    const whole = source.slice(index, targetEnd + 1);
    if (isTelegramRichSafeMarkdownUrl(url, image)) {
      output += target.startsWith("<") ? whole.replace(target, protectedToken(protectedCode, target)) : whole;
    } else {
      output += codeText(`${source.slice(start + 1, labelEnd)} (${url})`);
    }
    index = targetEnd + 1;
  }
  output = output.replace(
    /!\[((?:\\.|[^\]])*)\]\[((?:\\.|[^\]])*)\]/g,
    (whole, label: string, reference: string) => {
      const url = references.get(telegramRichReferenceLabel(reference || label)) ?? "";
      return isTelegramRichSafeMediaUrl(url) ? whole : codeText(`${label} (${url})`);
    },
  );
  return output.replace(/!\[((?:\\.|[^\]])+)\](?![[(])/g, (whole, label: string) => {
    const url = references.get(telegramRichReferenceLabel(label)) ?? "";
    return isTelegramRichSafeMediaUrl(url) ? whole : codeText(`${label} (${url})`);
  });
}

function protectCode(source: string, values: string[], preserveQuotePrefix = false): string {
  const escaped = buildEscapeMap(source);
  let output = "";
  let index = 0;
  let lineStart = true;
  while (index < source.length) {
    if (lineStart) {
      const formulaEnd = protectedFormulaEnd(source, index);
      if (formulaEnd !== undefined) {
        output += protectedToken(values, source.slice(index, formulaEnd));
        index = formulaEnd;
        lineStart = source[index - 1] === "\n";
        continue;
      }
      const fenceEnd = protectedFenceEnd(source, index);
      if (fenceEnd !== undefined) {
        const openingLineEnd = source.indexOf("\n", index);
        const openingLine = source.slice(index, openingLineEnd < 0 ? source.length : openingLineEnd);
        const quotes = fenceOpening(openingLine, true)?.quotes ?? 0;
        const token = protectedToken(values, source.slice(index, fenceEnd));
        output += preserveQuotePrefix ? `${"> ".repeat(quotes)}${token}` : token;
        index = fenceEnd;
        lineStart = source[index - 1] === "\n";
        continue;
      }
    }
    if (source[index] === "`" && !escaped[index]) {
      let width = 1;
      while (source[index + width] === "`") width += 1;
      const delimiter = "`".repeat(width);
      let end = source.indexOf(delimiter, index + width);
      while (end >= 0 && escaped[end]) end = source.indexOf(delimiter, end + width);
      if (end >= 0 && !source.slice(index + width, end).includes("\n")) {
        const after = end + width;
        output += protectedToken(values, source.slice(index, after));
        index = after;
        lineStart = false;
        continue;
      }
      output += "\\`".repeat(width);
      index += width;
      lineStart = false;
      continue;
    }
    if (source[index] === "$" && !escaped[index]) {
      const end = inlineFormulaEnd(source, index, escaped);
      if (end !== undefined) {
        output += protectedToken(values, source.slice(index, end));
        index = end;
        lineStart = false;
        continue;
      }
    }
    output += source[index];
    lineStart = source[index] === "\n";
    index += 1;
  }
  return output;
}

function inlineFormulaEnd(source: string, start: number, escaped: Uint8Array): number | undefined {
  const width = source[start + 1] === "$" ? 2 : 1;
  const delimiter = "$".repeat(width);
  for (let end = start + width; end < source.length; end += 1) {
    if (source[end] === "\n") return undefined;
    const adjacent = width === 1 && (source[end - 1] === "$" || source[end + 1] === "$");
    if (!escaped[end] && !adjacent && source.startsWith(delimiter, end)) return end + width;
  }
  return undefined;
}

function protectedFormulaEnd(source: string, start: number): number | undefined {
  const firstEnd = source.indexOf("\n", start);
  if (firstEnd < 0 || !isFormulaBoundary(source.slice(start, firstEnd))) return undefined;
  let cursor = firstEnd + 1;
  while (cursor <= source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd < 0 ? source.length : lineEnd;
    if (isFormulaBoundary(source.slice(cursor, end))) return end;
    if (lineEnd < 0) break;
    cursor = lineEnd + 1;
  }
  return undefined;
}

function protectedFenceEnd(source: string, start: number): number | undefined {
  const firstEnd = source.indexOf("\n", start);
  const opening = fenceOpening(source.slice(start, firstEnd < 0 ? source.length : firstEnd), true);
  if (!opening || firstEnd < 0) return undefined;
  let cursor = firstEnd + 1;
  while (cursor <= source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd < 0 ? source.length : lineEnd;
    if (fenceClosing(source.slice(cursor, end), opening)) return end;
    if (lineEnd < 0) break;
    cursor = lineEnd + 1;
  }
  return undefined;
}

function referenceTargets(source: string): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  const visible = protectCode(source, []);
  for (const match of visible.matchAll(
    /^(?: {0,3}>[ \t]?)* {0,3}\[((?!\^)(?:\\.|[^\]])+)\]:\s*(?:<([^<>]+)>|(\S+))/gmi,
  )) {
    const label = telegramRichReferenceLabel(match[1]!);
    if (!references.has(label)) references.set(label, match[2] ?? match[3]!);
  }
  return references;
}

function fenceOpening(line: string, allowQuoted: boolean): FenceMarker | undefined {
  const quoted = stripQuotePrefix(line);
  if (!allowQuoted && quoted.quotes > 0) return undefined;
  const match = quoted.content.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
  if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) return undefined;
  return { marker: match[1]!, quotes: quoted.quotes };
}

function fenceClosing(line: string, opening: FenceMarker): boolean {
  const quoted = stripQuotePrefix(line);
  return quoted.quotes === opening.quotes &&
    new RegExp(`^ {0,3}${escapeRegExp(opening.marker[0]!)}{${opening.marker.length},}\\s*$`)
      .test(quoted.content);
}

function htmlContainer(line: string): string | undefined {
  for (const token of tokenizeTelegramRichHtml(line)) {
    const parsed = token.kind === "markup" ? token.parsed : undefined;
    if (parsed && !parsed.closing && isTelegramRichContainerTag(parsed.tag) &&
      containerDelta(line, parsed.tag) > 0) return parsed.tag;
  }
  return undefined;
}

function containerDelta(line: string, tag: string): number {
  let balance = 0;
  for (const token of tokenizeTelegramRichHtml(line)) {
    const parsed = token.kind === "markup" ? token.parsed : undefined;
    if (parsed?.tag === tag) balance += parsed.closing ? -1 : 1;
  }
  return balance;
}

function isSpecialStart(lines: string[], index: number): boolean {
  const line = lines[index]!;
  return Boolean(fenceOpening(line, false)) || Boolean(htmlContainer(line)) ||
    isTableStart(lines, index) || isListLine(line) || /^ {0,3}>/.test(line) ||
    /^ {0,3}\[\^[^\]]+\]:/.test(line) || isFormulaBoundary(line) ||
    /^ {0,3}(?:#{1,6}\s+|---+\s*$)/.test(line);
}

function continuationEnd(lines: string[], start: number, list: boolean): number {
  let index = start;
  while (index < lines.length) {
    if (lines[index]!.trim() && ((list && isListLine(lines[index]!)) ||
      /^(?: {2,}|\t)\S/.test(lines[index]!))) {
      index += 1;
      continue;
    }
    if (list && lines[index]!.trim() && !isSpecialStart(lines, index)) {
      index += 1;
      continue;
    }
    let next = index;
    while (next < lines.length && !lines[next]!.trim()) next += 1;
    if (next === index || next === lines.length || !/^(?: {2,}|\t)\S/.test(lines[next]!)) break;
    index = next;
  }
  return index;
}

function quoteContinuationEnd(lines: string[], start: number): number {
  let index = start;
  let lazy = false;
  while (index < lines.length) {
    if (/^ {0,3}>/.test(lines[index]!)) {
      const visible = stripQuotePrefix(lines[index]!).content;
      lazy = Boolean(visible.trim() && !isSpecialStart([visible], 0));
      index += 1;
      continue;
    }
    if (lazy && lines[index]!.trim() && !isSpecialStart(lines, index)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
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

function isListLine(line: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
}

function isFormulaBoundary(line: string): boolean {
  return /^ {0,3}\$\$\s*$/.test(line);
}

function isTableStart(lines: readonly string[], index: number): boolean {
  return index + 1 < lines.length && hasTablePipe(lines[index]!) &&
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]!);
}

function hasTablePipe(line: string): boolean {
  return /(^|[^\\])\|/.test(line);
}

function codeText(value: string): string {
  const runs = value.match(/`+/g)?.map((run) => run.length) ?? [0];
  const delimiter = "`".repeat(Math.max(...runs) + 1);
  return `${delimiter}${value}${delimiter}`;
}

function restoreCode(source: string, values: string[]): string {
  return source.replace(/\uE100TC(\d+)\uE101/g, (_match, index: string) => values[Number(index)] ?? "");
}

function protectedToken(values: string[], value: string): string {
  return `\uE100TC${values.push(value) - 1}\uE101`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
