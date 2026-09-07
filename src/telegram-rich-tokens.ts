export interface TelegramRichParsedTag {
  readonly tag: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: ReadonlyMap<string, string | undefined>;
}

export interface TelegramRichTextToken {
  readonly kind: "text";
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export interface TelegramRichMarkupToken {
  readonly kind: "markup";
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly complete: boolean;
  readonly parsed?: TelegramRichParsedTag;
}

export type TelegramRichHtmlToken = TelegramRichTextToken | TelegramRichMarkupToken;

export interface TelegramRichDelimiterMaps {
  readonly brackets: Int32Array;
  readonly parentheses: Int32Array;
}

export interface TelegramRichDependencyLabels {
  readonly definitions: ReadonlySet<string>;
  readonly usages: ReadonlySet<string>;
  readonly overflow: boolean;
}

export function tokenizeTelegramRichHtml(source: string): TelegramRichHtmlToken[] {
  const tokens: TelegramRichHtmlToken[] = [];
  let index = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end <= textStart) return;
    tokens.push({ kind: "text", start: textStart, end, value: source.slice(textStart, end) });
  };

  while (index < source.length) {
    if (source[index] !== "<") {
      index += 1;
      continue;
    }

    flushText(index);
    const end = markupEnd(source, index);
    if (end < 0) {
      const lineEnd = source.indexOf("\n", index);
      const invalidEnd = lineEnd < 0 ? source.length : lineEnd;
      tokens.push({
        kind: "markup",
        start: index,
        end: invalidEnd,
        raw: source.slice(index, invalidEnd),
        complete: false,
      });
      index = invalidEnd;
      textStart = index;
      continue;
    }

    const raw = source.slice(index, end + 1);
    const parsed = parseTelegramRichTag(raw);
    tokens.push({
      kind: "markup",
      start: index,
      end: end + 1,
      raw,
      complete: true,
      ...(parsed ? { parsed } : {}),
    });
    index = end + 1;
    textStart = index;
  }

  flushText(source.length);
  return tokens;
}

export function buildEscapeMap(source: string): Uint8Array {
  const escaped = new Uint8Array(source.length);
  let backslashes = 0;
  for (let index = 0; index < source.length; index += 1) {
    escaped[index] = backslashes % 2;
    backslashes = source[index] === "\\" ? backslashes + 1 : 0;
  }
  return escaped;
}

export function buildDelimiterMaps(
  source: string,
  escaped = buildEscapeMap(source),
): TelegramRichDelimiterMaps {
  const brackets = new Int32Array(source.length).fill(-1);
  const parentheses = new Int32Array(source.length).fill(-1);
  const matchedBracketEnds = new Uint8Array(source.length);
  const bracketStack: number[] = [];
  const parenthesisStack: number[] = [];
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped[index]) continue;
    if (char === "\n") {
      bracketStack.length = 0;
      parenthesisStack.length = 0;
      quote = "";
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (parenthesisStack.length && (char === "\"" || char === "'")) {
      quote = char;
    } else if (char === "[") {
      bracketStack.push(index);
    } else if (char === "]" && bracketStack.length) {
      brackets[bracketStack.pop()!] = index;
      matchedBracketEnds[index] = 1;
    } else if (char === "(" && (parenthesisStack.length || matchedBracketEnds[index - 1])) {
      parenthesisStack.push(index);
    } else if (char === ")" && parenthesisStack.length) {
      parentheses[parenthesisStack.pop()!] = index;
    }
  }
  return { brackets, parentheses };
}

export function telegramRichLineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

export function telegramRichLineNumber(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function telegramRichReferenceLabel(value: string): string {
  return value.replace(/\\(.)/g, "$1").trim().replace(/\s+/g, " ").toLowerCase();
}

export function collectTelegramRichDependencyLabels(
  source: string,
  limit: number,
): TelegramRichDependencyLabels {
  const definitions = new Set<string>();
  const usages = new Set<string>();
  let overflow = false;
  const add = (target: Set<string>, namespace: string, value: string): void => {
    if (value.length > 999) {
      overflow = true;
      return;
    }
    const label = `${namespace}:${telegramRichReferenceLabel(value)}`;
    if (!target.has(label) && definitions.size + usages.size >= limit) overflow = true;
    else target.add(label);
  };

  for (const match of source.matchAll(
    /^(?: {0,3}>[ \t]?)* {0,3}\[((?!\^)(?:\\.|[^\]])+)\]:/gmi,
  )) add(definitions, "reference", match[1]!);
  for (const match of source.matchAll(/^ {0,3}\[\^([^\]]+)\]:/gm)) {
    add(definitions, "footnote", match[1]!);
  }
  const delimiters = buildDelimiterMaps(source);
  for (let index = 0; index < source.length; index += 1) {
    const image = source[index] === "!" && source[index + 1] === "[";
    const opening = image ? index + 1 : index;
    if (source[opening] !== "[" || (!image && source[index - 1] === "!")) continue;
    const labelEnd = delimiters.brackets[opening] ?? -1;
    if (labelEnd < 0) continue;
    const label = source.slice(opening + 1, labelEnd);
    if (label.startsWith("^") && source[labelEnd + 1] !== ":") {
      add(usages, "footnote", label.slice(1));
    }
    if (source[labelEnd + 1] === "[") {
      const referenceEnd = delimiters.brackets[labelEnd + 1] ?? -1;
      if (referenceEnd >= 0) {
        add(usages, "reference", source.slice(labelEnd + 2, referenceEnd) || label);
        index = referenceEnd;
      }
    } else if (![":", "(", "["].includes(source[labelEnd + 1] ?? "")) {
      add(usages, "reference", label);
      index = labelEnd;
    }
  }
  return { definitions, usages, overflow };
}

function markupEnd(source: string, opening: number): number {
  let quote = "";
  let escaped = false;
  for (let index = opening + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    } else if (char === "\n") {
      return -1;
    }
  }
  return -1;
}

function parseTelegramRichTag(raw: string): TelegramRichParsedTag | undefined {
  const match = raw.match(/^<\s*(\/?)\s*([A-Za-z][\w-]*)([\s\S]*?)>$/);
  if (!match) return undefined;

  const closing = match[1] === "/";
  let rest = match[3]!.trim();
  const selfClosing = !closing && rest.endsWith("/");
  if (selfClosing) rest = rest.slice(0, -1).trim();
  if (closing && rest) return undefined;

  const attributes = new Map<string, string | undefined>();
  while (rest) {
    const attribute = rest.match(
      /^([A-Za-z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?(?:\s+|$)/,
    );
    if (!attribute) return undefined;
    const name = attribute[1]!.toLowerCase();
    if (attributes.has(name)) return undefined;
    attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4]);
    rest = rest.slice(attribute[0].length);
  }

  return {
    tag: match[2]!.toLowerCase(),
    closing,
    selfClosing,
    attributes,
  };
}
