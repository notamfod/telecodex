const CODE_BLOCK_PREFIX = "\uE000CODE_";
const CODE_BLOCK_SUFFIX = "_\uE000";
const INLINE_CODE_PREFIX = "\uE001INLINE_";
const INLINE_CODE_SUFFIX = "_\uE001";

export function escapeHTML(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTelegramHTML(markdown: string): string {
  if (!markdown) {
    return "";
  }

  const escaped = escapeHTML(markdown);
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  let text = extractCodeBlocks(escaped, codeBlocks);
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
): TelegramMarkdownChunk[] {
  if (!markdown) return [];

  const pieces = splitMarkdownBlocks(markdown).flatMap((block) =>
    splitOversizedBlock(block, targetLength, maxHtmlLength));
  const chunks: TelegramMarkdownChunk[] = [];
  let current = "";

  const flush = (): void => {
    if (!current) return;
    chunks.push({
      sourceText: current,
      html: formatTelegramHTML(current),
      plain: current,
    });
    current = "";
  };

  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (
      current &&
      (candidate.length > targetLength || formatTelegramHTML(candidate).length > maxHtmlLength)
    ) {
      flush();
      current = piece;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

function formatBlockStructure(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>")
    .replace(/^(\s*)[-+*][ \t]+\[x\][ \t]+(.+)$/gim, "$1☑ $2")
    .replace(/^(\s*)[-+*][ \t]+\[[ ]\][ \t]+(.+)$/gm, "$1☐ $2")
    .replace(/^(\s*)[-+*][ \t]+(.+)$/gm, "$1• $2");
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
    if (/^```/.test(line)) {
      if (!inFence) flush();
      lines.push(line);
      inFence = !inFence;
      if (!inFence) flush();
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
): string[] {
  if (formatTelegramHTML(block).length <= maxHtmlLength && block.length <= targetLength) {
    return [block];
  }

  const fenced = block.match(/^```([^\n`]*)\n([\s\S]*?)\n?```$/);
  if (fenced) {
    return splitFencedCode(fenced[1], fenced[2], targetLength, maxHtmlLength);
  }

  const result: string[] = [];
  let remaining = block;
  while (remaining) {
    if (formatTelegramHTML(remaining).length <= maxHtmlLength && remaining.length <= targetLength) {
      result.push(remaining);
      break;
    }
    const maxSource = largestFittingPrefix(remaining, maxHtmlLength, (value) => formatTelegramHTML(value).length);
    const preferredLimit = Math.max(1, Math.min(maxSource, targetLength));
    const cut = preferredSplit(remaining, preferredLimit);
    result.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return result.filter(Boolean);
}

function splitFencedCode(
  rawLanguage: string,
  code: string,
  targetLength: number,
  maxHtmlLength: number,
): string[] {
  const language = sanitizeLanguage(rawLanguage);
  const wrap = (value: string): string => `\`\`\`${language}\n${value}\n\`\`\``;
  const result: string[] = [];
  let remaining = code;

  while (remaining) {
    const maxSource = largestFittingPrefix(
      remaining,
      maxHtmlLength,
      (value) => formatTelegramHTML(wrap(value)).length,
    );
    const preferredLimit = Math.max(1, Math.min(maxSource, targetLength));
    const cut = preferredSplit(remaining, preferredLimit);
    result.push(wrap(remaining.slice(0, cut).trimEnd()));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  return result;
}

function largestFittingPrefix(
  text: string,
  maxLength: number,
  measure: (value: string) => number,
): number {
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (measure(text.slice(0, middle)) <= maxLength) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function preferredSplit(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const newline = text.lastIndexOf("\n", limit);
  if (newline > 0) return newline + 1;
  const space = text.lastIndexOf(" ", limit);
  if (space > 0) return space + 1;
  return limit;
}

function extractCodeBlocks(text: string, codeBlocks: string[]): string {
  return text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, rawLanguage: string, rawCode: string) => {
    const language = sanitizeLanguage(rawLanguage);
    const code = language
      ? `<pre><code class="language-${language}">${rawCode}</code></pre>`
      : `<pre><code>${rawCode}</code></pre>`;
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

function sanitizeLanguage(language: string): string {
  return language.trim().replace(/[^a-zA-Z0-9_+-]/g, "");
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
