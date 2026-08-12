import { InlineKeyboard } from "grammy";

const THREAD_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const THREAD_LINK_PATTERN = new RegExp(
  `\\bcodex://threads/(${THREAD_ID_PATTERN})(?![0-9A-Za-z-])`,
  "g",
);
const MARKDOWN_THREAD_LINK_PATTERN = new RegExp(
  String.raw`\[((?:\\.|[^\]\\])*)\]\(codex://threads/(${THREAD_ID_PATTERN})\)`,
  "g",
);
const THREAD_CALLBACK_PATTERN = new RegExp(`^codex_thread:(${THREAD_ID_PATTERN})$`);
const GENERIC_LINK_LABELS = new Set(["open", "open task"]);
const MAX_BUTTON_CODE_POINTS = 64;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });

interface CodexThreadLink {
  threadId: string;
  title?: string;
}

function markdownUnescapeLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, "$1");
}

function extractCodexThreadLinks(markdown: string): CodexThreadLink[] {
  const titles = new Map<string, string>();
  for (const match of markdown.matchAll(MARKDOWN_THREAD_LINK_PATTERN)) {
    const title = markdownUnescapeLabel(match[1]).trim();
    if (title && !GENERIC_LINK_LABELS.has(title.toLocaleLowerCase("en-US"))) {
      titles.set(match[2], title);
    }
  }

  const links: CodexThreadLink[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(THREAD_LINK_PATTERN)) {
    const threadId = match[1];
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    links.push({ threadId, title: titles.get(threadId) });
  }
  return links;
}

function openButtonText({ threadId, title }: CodexThreadLink): string {
  const prefix = "Open ";
  const label = title ?? threadId.slice(0, 8);
  const available = MAX_BUTTON_CODE_POINTS - [...prefix].length;
  const codePoints = [...label];
  if (codePoints.length <= available) return `${prefix}${label}`;

  const budget = available - 1;
  let used = 0;
  let visible = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(label)) {
    const size = [...segment].length;
    if (used + size > budget) break;
    visible += segment;
    used += size;
  }
  visible += "…";
  return `${prefix}${visible}`;
}

export function extractCodexThreadIds(markdown: string): string[] {
  return extractCodexThreadLinks(markdown).map(({ threadId }) => threadId);
}

export function buildCodexThreadKeyboard(markdown: string): InlineKeyboard | undefined {
  const links = extractCodexThreadLinks(markdown);
  if (links.length === 0) return undefined;

  const keyboard = new InlineKeyboard();
  links.forEach((link, index) => {
    const { threadId } = link;
    keyboard
      .text(openButtonText(link), `codex_thread:${threadId}`)
      .copyText("Copy ID", threadId);
    if (index < links.length - 1) keyboard.row();
  });
  return keyboard;
}

export function finalChunkThreadKeyboard(
  markdown: string,
  chunkIndex: number,
  chunkCount: number,
): InlineKeyboard | undefined {
  if (chunkCount < 1 || chunkIndex !== chunkCount - 1) return undefined;
  return buildCodexThreadKeyboard(markdown);
}

export function parseCodexThreadCallback(data: string): string | null {
  return THREAD_CALLBACK_PATTERN.exec(data)?.[1] ?? null;
}
