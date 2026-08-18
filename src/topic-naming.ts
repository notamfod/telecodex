import type { Ticket } from "./inbox.js";
import { containsSecret } from "./topic-sync.js";

const MAX_ANALYSIS_TITLE_LENGTH = 40;
const MAX_TELEGRAM_TOPIC_LENGTH = 128;

export interface TopicRenameExtraction {
  title: string;
  text: string;
}

export function extractTopicRename(text: string): TopicRenameExtraction | undefined {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const marker = /^TOPIC:\s*(.*)$/.exec(lines[0] ?? "");
  if (!marker) {
    return undefined;
  }

  const normalized = marker[1].replace(/\s+/g, " ").trim();
  if (!normalized || containsSecret(normalized)) {
    return undefined;
  }

  const title = [...normalized].slice(0, MAX_ANALYSIS_TITLE_LENGTH).join("").trim();
  const answerLines = lines.slice(1);
  if (answerLines[0]?.trim() === "") {
    answerLines.shift();
  }
  return { title, text: answerLines.join("\n") };
}

export function renamedTicketTopic(
  ticket: Pick<Ticket, "id" | "externalKey">,
  title: string,
): string {
  const key = ticket.externalKey
    ? (/^\d+$/.test(ticket.externalKey) ? `#${ticket.externalKey}` : ticket.externalKey)
    : `#${ticket.id}`;
  return [...`${key} ${title.replace(/\s+/g, " ").trim()}`]
    .slice(0, MAX_TELEGRAM_TOPIC_LENGTH)
    .join("")
    .trim();
}
