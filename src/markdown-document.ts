/** Telegram counts caption text, not the HTML tags around it. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

/** Left for the markup the caption is rendered into, and for the ellipsis. */
const CAPTION_BUDGET = 900;
const FILE_NAME_LIMIT = 40;

export interface MarkdownDocument {
  fileName: string;
  caption: string;
  content: string;
}

/**
 * An answer too long for one message, packaged the way Telegram shows best: the
 * opening as the caption, the whole thing as a `.md` file it renders in place.
 */
export function buildMarkdownDocument(text: string, budget = CAPTION_BUDGET): MarkdownDocument {
  return {
    fileName: documentFileName(text),
    caption: buildCaption(text, budget),
    content: text,
  };
}

function buildCaption(text: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) {
    return trimmed;
  }

  const head = trimmed.slice(0, budget);
  // Prefer a paragraph break, then any line break, then a sentence, then a word:
  // a lead-in cut mid-word reads like the message was damaged.
  const cut =
    lastIndexBefore(head, "\n\n") ??
    lastIndexBefore(head, "\n") ??
    lastIndexBefore(head, ". ") ??
    lastIndexBefore(head, " ") ??
    head.length;

  return `${head.slice(0, cut).trimEnd()}\n\n…`;
}

function lastIndexBefore(text: string, separator: string): number | undefined {
  const index = text.lastIndexOf(separator);
  // A break in the first fifth would throw away most of the lead-in.
  return index > text.length / 5 ? index : undefined;
}

export function documentFileName(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1];
  const firstLine = firstProseLine(text);

  const slug = slugify(heading ?? firstLine ?? "");
  return `${slug || "ответ"}.md`;
}

/** The first line a human would read: fenced code and table rows are not titles. */
function firstProseLine(text: string): string | undefined {
  let insideFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence && line && !line.startsWith("|")) {
      return line;
    }
  }
  return undefined;
}

function slugify(text: string): string {
  return text
    .replace(/[*_`~#>[\]()]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FILE_NAME_LIMIT)
    .replace(/-+$/g, "");
}
