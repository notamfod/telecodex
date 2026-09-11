export interface MarkdownFenceTransition {
  kind: "open" | "close";
  info: string;
  indentation: string;
}

const MARKDOWN_FENCE_LINE = /^( {0,3})```([^`]*)$/;
const MAX_FENCE_LANGUAGE_LENGTH = 64;

export function markdownFenceTransition(
  line: string,
  inFence: boolean,
): MarkdownFenceTransition | undefined {
  const match = MARKDOWN_FENCE_LINE.exec(line);
  if (!match) return undefined;
  const indentation = match[1] ?? "";
  const info = match[2] ?? "";
  if (inFence) return /^[ \t]*\r?$/.test(info) ? { kind: "close", info, indentation } : undefined;
  return { kind: "open", info, indentation };
}

export function findMarkdownFenceClose(lines: string[], openingIndex: number): number | undefined {
  for (let index = openingIndex + 1; index < lines.length; index += 1) {
    if (markdownFenceTransition(lines[index] ?? "", true)?.kind === "close") return index;
  }
  return undefined;
}

export function fenceLanguage(rawLanguage: string): string {
  const language = rawLanguage.replace(/\r$/, "").trim();
  return language.length > 0 && language.length <= MAX_FENCE_LANGUAGE_LENGTH
    && /^[a-zA-Z0-9_+-]+$/.test(language) ? language : "text";
}

export function replaceMarkdownFenceBlocks(
  text: string,
  replace: (block: {
    language: string;
    body: string;
  }) => string,
): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const opening = markdownFenceTransition(lines[index] ?? "", false);
    const closingIndex = opening?.kind === "open" ? findMarkdownFenceClose(lines, index) : undefined;
    if (!opening) {
      output.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    if (closingIndex === undefined) {
      output.push(...lines.slice(index));
      break;
    }
    output.push(`${opening.indentation}${replace({
      language: fenceLanguage(opening.info),
      body: lines.slice(index + 1, closingIndex).join("\n"),
    })}`);
    index = closingIndex + 1;
  }
  return output.join("\n");
}

export function mapOutsideMarkdownFences(block: string, map: (line: string) => string): string {
  let inFence = false;
  return block.split("\n").map((line) => {
    const fence = markdownFenceTransition(line, inFence);
    if (fence) inFence = fence.kind === "open";
    return fence || inFence ? line : map(line);
  }).join("\n");
}

export function parseMarkdownFenceBlock(block: string): { language: string; body: string } | undefined {
  const lines = block.split("\n");
  const opening = markdownFenceTransition(lines[0] ?? "", false);
  if (opening?.kind !== "open" || lines.length < 2) return undefined;
  const closing = markdownFenceTransition(lines.at(-1) ?? "", true);
  if (closing?.kind !== "close") return undefined;
  return { language: opening.info, body: lines.slice(1, -1).join("\n") };
}
