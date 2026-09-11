export interface MarkdownFenceTransition {
  kind: "open" | "close";
  info: string;
}

const MARKDOWN_FENCE_LINE = /^( {0,3})```([^`]*)$/;

export function markdownFenceTransition(
  line: string,
  inFence: boolean,
): MarkdownFenceTransition | undefined {
  const match = MARKDOWN_FENCE_LINE.exec(line);
  if (!match) return undefined;
  const info = match[2] ?? "";
  if (inFence) return /^[ \t]*\r?$/.test(info) ? { kind: "close", info } : undefined;
  return { kind: "open", info };
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
