import {
  fenceLanguage,
  findMarkdownFenceClose,
  mapOutsideMarkdownFences,
  markdownFenceTransition,
  parseMarkdownFenceBlock,
  replaceMarkdownFenceBlocks,
} from "./markdown-fence.js";
const CODE_BLOCK_PREFIX = "\uE000CODE_";
const CODE_BLOCK_SUFFIX = "_\uE000";
const INLINE_CODE_PREFIX = "\uE001INLINE_";
const INLINE_CODE_SUFFIX = "_\uE001";
const CHUNK_BUDGET_ERROR = "Telegram markdown split exceeds chunk budget";

type TelegramPresentationLineKind = "heading" | "list" | "fence" | "text";

export function escapeHTML(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function normalizeTelegramPresentation(markdown: string): string {
  if (!markdown || markdown.trim() === "") return markdown;

  const output: string[] = [];
  let inFence = false;
  let pendingBlank = false;
  let previousKind: TelegramPresentationLineKind | undefined;

  const appendBlank = (): void => {
    if (output.length > 0 && output.at(-1) !== "") output.push("");
  };

  const sourceLines = markdown.split("\n");
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const sourceLine = sourceLines[lineIndex] ?? "";
    const fence = markdownFenceTransition(sourceLine, inFence);
    if (inFence) {
      if (fence?.kind === "close") {
        output.push(sourceLine.trimEnd());
        inFence = false;
        previousKind = "fence";
      } else {
        output.push(sourceLine);
      }
      continue;
    }
    if (fence?.kind === "open") {
      if (findMarkdownFenceClose(sourceLines, lineIndex) !== undefined || pendingBlank) appendBlank();
      output.push(sourceLine.trimEnd());
      inFence = true;
      pendingBlank = false;
      previousKind = "fence";
      continue;
    }
    if (sourceLine.trim() === "") {
      pendingBlank = true;
      continue;
    }

    const kind = presentationLineKind(sourceLine);
    const adjacentList = kind === "list" && previousKind === "list";
    if (
      kind === "heading"
      || previousKind === "heading"
      || previousKind === "fence"
      || (pendingBlank && !adjacentList)
    ) {
      appendBlank();
    }
    output.push(sourceLine.trimEnd());
    pendingBlank = false;
    previousKind = kind;
  }

  return output.join("\n");
}

function presentationLineKind(line: string): TelegramPresentationLineKind {
  if (/^#{1,6}[ \t]+\S/.test(line)) return "heading";
  if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\S/.test(line)) return "list";
  return "text";
}

export function formatTelegramHTML(markdown: string): string {
  if (!markdown) {
    return "";
  }

  return formatNormalizedTelegramHTML(normalizeTelegramPresentation(markdown));
}

function formatNormalizedTelegramHTML(markdown: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  let text = escapeHTML(markdown);
  text = extractCodeBlocks(text, codeBlocks);
  text = extractInlineCode(text, inlineCode);
  text = formatBlockStructure(text);
  text = formatBold(text);
  text = formatItalic(text);
  text = formatLinks(text);
  text = formatBlockquotes(text);
  text = restorePlaceholders(text, INLINE_CODE_PREFIX, INLINE_CODE_SUFFIX, inlineCode);
  text = restorePlaceholders(text, CODE_BLOCK_PREFIX, CODE_BLOCK_SUFFIX, codeBlocks);

  return text;
}

export interface TelegramMarkdownChunk {
  sourceText: string;
  html: string;
  plain: string;
}

export function splitTelegramMarkdown(
  markdown: string,
  targetLength = 3000,
  maxHtmlLength = 4000,
  maximumChunks = Number.POSITIVE_INFINITY,
): TelegramMarkdownChunk[] {
  if (!markdown) return [];

  const normalizedMarkdown = normalizeTelegramPresentation(markdown);

  const chunks: TelegramMarkdownChunk[] = [];
  let current = "";

  const flush = (): void => {
    if (!current) return;
    if (chunks.length >= maximumChunks) throw new Error(CHUNK_BUDGET_ERROR);
    chunks.push({
      sourceText: current,
      html: formatNormalizedTelegramHTML(current),
      plain: current,
    });
    current = "";
  };

  for (const block of splitMarkdownBlocks(normalizedMarkdown)) {
    const maximumPieces = Number.isFinite(maximumChunks)
      ? Math.max(1, maximumChunks - chunks.length + 1)
      : Number.POSITIVE_INFINITY;
    for (const piece of splitOversizedBlock(block, targetLength, maxHtmlLength, maximumPieces)) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (
        current &&
        (codePointLength(candidate) > targetLength
          || codePointLength(formatNormalizedTelegramHTML(candidate)) > maxHtmlLength)
      ) {
        flush();
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  flush();
  return chunks;
}

function formatBlockStructure(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>")
    .replace(/^([ \t]*)[-+*][ \t]+\[x\][ \t]+(.+)$/gim,
      (_match, indentation: string, content: string) => listLine(indentation, "☑", content))
    .replace(/^([ \t]*)[-+*][ \t]+\[[ ]\][ \t]+(.+)$/gm,
      (_match, indentation: string, content: string) => listLine(indentation, "☐", content))
    .replace(/^([ \t]*)[-+*][ \t]+(.+)$/gm,
      (_match, indentation: string, content: string) => listLine(indentation, "•", content))
    .replace(/^([ \t]*)(\d+[.)])[ \t]+(.+)$/gm,
      (_match, indentation: string, marker: string, content: string) =>
        listLine(indentation, marker, content));
}

function listLine(indentation: string, marker: string, content: string): string {
  const level = listLevel(indentation);
  const visibleLevel = Math.min(level, 2);
  const hiddenLevels = Math.max(0, level - visibleLevel);
  const overflow = hiddenLevels <= 3 ? "• ".repeat(hiddenLevels) : `• • • …×${hiddenLevels} `;
  return `${"  ".repeat(visibleLevel)}${overflow}${marker} ${content}`;
}

function listLevel(indentation: string): number {
  return Math.floor([...indentation]
    .reduce((total, character) => total + (character === "\t" ? 2 : 1), 0) / 2);
}

function splitMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (lines.length > 0) blocks.push(lines.join("\n"));
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    const fence = markdownFenceTransition(line, inFence);
    if (fence) {
      if (fence.kind === "open") flush();
      lines.push(line);
      inFence = fence.kind === "open";
      if (fence.kind === "close") flush();
      continue;
    }
    if (inFence) {
      lines.push(line);
    } else if (line.trim()) {
      lines.push(line);
    } else {
      flush();
    }
  }
  flush();
  return blocks;
}

function splitOversizedBlock(
  block: string,
  targetLength: number,
  maxHtmlLength: number,
  maximumPieces: number,
): string[] {
  const compactList = compactOversizedListBlock(block, targetLength, maxHtmlLength);
  if (compactList !== block) return splitOversizedBlock(compactList, targetLength, maxHtmlLength, maximumPieces);
  if (codePointLength(block) <= targetLength && codePointLength(formatNormalizedTelegramHTML(block)) <= maxHtmlLength) return [block];

  const fenced = parseMarkdownFenceBlock(block);
  if (fenced) {
    return splitFencedCode(fenced.language, fenced.body, targetLength, maxHtmlLength, maximumPieces);
  }

  return splitBoundedSource(
    block,
    targetLength,
    maxHtmlLength,
    formatNormalizedTelegramHTML,
    true,
    maximumPieces,
  );
}

function compactOversizedListBlock(block: string, targetLength: number, maxHtmlLength: number): string {
  return mapOutsideMarkdownFences(block, (line) => {
    if (presentationLineKind(line) !== "list") return line;
    const indentation = /^([ \t]*)/.exec(line)?.[1] ?? "";
    const hiddenLevels = Math.max(0, listLevel(indentation) - 2);
    const compactOverflowLength = hiddenLevels <= 3 ? hiddenLevels * 2 : codePointLength(`• • • …×${hiddenLevels} `);
    const unboundedHtmlLength = codePointLength(formatNormalizedTelegramHTML(line)) + hiddenLevels * 2
      - compactOverflowLength;
    return codePointLength(line) > targetLength || unboundedHtmlLength > maxHtmlLength ? formatBlockStructure(line) : line;
  });
}

function splitFencedCode(
  rawLanguage: string,
  code: string,
  targetLength: number,
  maxHtmlLength: number,
  maximumPieces: number,
): string[] {
  const language = fenceLanguage(rawLanguage);
  const wrap = (value: string): string => fencedSource(language, value);
  const sourceOverhead = codePointLength(wrap(""));
  const htmlOverhead = codePointLength(formatNormalizedTelegramHTML(wrap("")));
  if (code.length === 0 && sourceOverhead <= targetLength && htmlOverhead <= maxHtmlLength) return [wrap("")];
  if (sourceOverhead >= targetLength || htmlOverhead >= maxHtmlLength) {
    throw new Error("Telegram markdown limits cannot fit fenced block");
  }
  const bodyTargetLength = targetLength - sourceOverhead;
  return splitBoundedSource(
    code,
    bodyTargetLength,
    maxHtmlLength,
    (value) => formatNormalizedTelegramHTML(wrap(value)),
    false,
    maximumPieces,
  ).map(wrap);
}

function fencedSource(language: string, value: string): string {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

function splitBoundedSource(
  source: string,
  targetLength: number,
  maxHtmlLength: number,
  render: (value: string) => string,
  trimAllLeadingWhitespace: boolean,
  maximumPieces: number,
): string[] {
  const result: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const window = source.slice(offset, indexAfterCodePoints(source, offset, targetLength));
    const maxSource = largestFittingPrefix(window, maxHtmlLength, (value) => codePointLength(render(value)));
    if (maxSource < 1) throw new Error("Telegram markdown limits cannot fit source character");
    const cut = preferredSplit(window, maxSource);
    const sourceChunk = window.slice(0, cut);
    const chunk = trimAllLeadingWhitespace ? sourceChunk.trimEnd() : sourceChunk;
    if (chunk.length > 0) {
      if (result.length >= maximumPieces) throw new Error(CHUNK_BUDGET_ERROR);
      result.push(chunk);
    }
    offset += cut;
    if (trimAllLeadingWhitespace) {
      while (offset < source.length && source[offset]!.trim() === "") offset += 1;
    }
  }
  return result;
}

function largestFittingPrefix(
  text: string,
  maxLength: number,
  measure: (value: string) => number,
): number {
  let low = 1;
  let high = codePointLength(text);
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = indexAfterCodePoints(text, 0, middle);
    if (measure(text.slice(0, boundary)) <= maxLength) {
      best = boundary;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function preferredSplit(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const boundary = codePointBoundaryAtOrBefore(text, limit);
  const newline = text.lastIndexOf("\n", boundary - 1);
  if (newline > 0) return newline + 1;
  const space = text.lastIndexOf(" ", boundary - 1);
  if (space > 0) return space + 1;
  return boundary;
}

function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; count += 1) {
    const first = value.charCodeAt(index++);
    if (isHighSurrogate(first) && index < value.length && isLowSurrogate(value.charCodeAt(index))) index += 1;
  }
  return count;
}

function indexAfterCodePoints(value: string, start: number, maximum: number): number {
  let index = codePointBoundaryAtOrBefore(value, start);
  for (let count = 0; index < value.length && count < maximum; count += 1) {
    const first = value.charCodeAt(index++);
    if (isHighSurrogate(first) && index < value.length && isLowSurrogate(value.charCodeAt(index))) index += 1;
  }
  return index;
}

function codePointBoundaryAtOrBefore(value: string, index: number): number {
  const bounded = Math.max(0, Math.min(value.length, index));
  return bounded > 0 && bounded < value.length
    && isHighSurrogate(value.charCodeAt(bounded - 1)) && isLowSurrogate(value.charCodeAt(bounded))
    ? bounded - 1 : bounded;
}

function isHighSurrogate(value: number): boolean { return value >= 0xD800 && value <= 0xDBFF; }
function isLowSurrogate(value: number): boolean { return value >= 0xDC00 && value <= 0xDFFF; }

function extractCodeBlocks(text: string, codeBlocks: string[]): string {
  return replaceMarkdownFenceBlocks(text, ({ language, body }) => {
    const code = `<pre><code class="language-${language}">${body}\n</code></pre>`;
    const index = codeBlocks.push(code) - 1;
    return `${CODE_BLOCK_PREFIX}${index}${CODE_BLOCK_SUFFIX}`;
  });
}

function extractInlineCode(text: string, inlineCode: string[]): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      result += text[index];
      index += 1;
      continue;
    }

    let tickCount = 1;
    while (text[index + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const start = index + tickCount;
    const end = text.indexOf(fence, start);

    if (end === -1) {
      result += fence;
      index += tickCount;
      continue;
    }

    const content = text.slice(start, end);
    if (content.includes("\n")) {
      result += fence;
      index += tickCount;
      continue;
    }

    const placeholder = `${INLINE_CODE_PREFIX}${inlineCode.push(`<code>${content}</code>`) - 1}${INLINE_CODE_SUFFIX}`;
    result += placeholder;
    index = end + tickCount;
  }

  return result;
}

function formatBold(text: string): string {
  return text.replace(/(?<!\*)\*\*(?!\s)([^\n]*?\S)\*\*(?!\*)/g, "<b>$1</b>");
}

function formatItalic(text: string): string {
  const withUnderscores = text.replace(
    /(?<![\w_])_(?!\s)([^_\n]*?\S)_(?![\w_])/g,
    "<i>$1</i>",
  );

  return withUnderscores.replace(
    /(?<![\w*])\*(?!\s)([^*\n]*?\S)\*(?![\w*])/g,
    "<i>$1</i>",
  );
}

function formatLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}">${label}</a>`;
  });
}

function formatBlockquotes(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let quoteLines: string[] = [];

  const flush = (): void => {
    if (quoteLines.length === 0) {
      return;
    }

    output.push(`<blockquote>${quoteLines.join("\n")}</blockquote>`);
    quoteLines = [];
  };

  for (const line of lines) {
    const match = line.match(/^&gt; (.*)$/);
    if (match) {
      quoteLines.push(match[1]);
      continue;
    }

    flush();
    output.push(line);
  }

  flush();
  return output.join("\n");
}

function restorePlaceholders(
  text: string,
  prefix: string,
  suffix: string,
  values: string[],
): string {
  const pattern = new RegExp(`${escapeRegExp(prefix)}(\\d+)${escapeRegExp(suffix)}`, "g");
  return text.replace(pattern, (_match, rawIndex: string) => values[Number.parseInt(rawIndex, 10)] ?? "");
}

const SAFE_URL_PROTOCOL = /^(https?|tg|mailto):/i;

function sanitizeUrl(url: string): string {
  const trimmed = url.trim().replace(/"/g, "%22");
  if (!SAFE_URL_PROTOCOL.test(trimmed)) {
    return "#";
  }
  return trimmed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
