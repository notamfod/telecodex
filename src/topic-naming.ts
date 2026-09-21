import { taskTopicName } from "./task-title.js";
import { ticketTopicName, type Ticket } from "./inbox.js";
import { containsSecret } from "./topic-sync.js";

const MAX_ANALYSIS_TITLE_LENGTH = 40;
const MAX_CANONICAL_TOPIC_NAME_LENGTH = 128;

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
  ticket: Pick<Ticket, "id" | "externalKey"> & Partial<Pick<Ticket, "workspace">>,
  title: string,
): string {
  const key = ticket.externalKey
    ? (/^\d+$/.test(ticket.externalKey) ? `#${ticket.externalKey}` : ticket.externalKey)
    : `#${ticket.id}`;
  return taskTopicName(title, ticket.workspace ?? "Codex", key);
}

/** Recover pre-canonical inbox names without using system instructions as the title. */
export function restoredTicketTopic(ticket: Pick<Ticket, "id" | "externalKey" | "workspace" | "prompt" | "topicTitle">): string {
  if (ticket.topicTitle && !isPlaceholderTopic(ticket.topicTitle)) return renamedTicketTopic(ticket, ticket.topicTitle);
  const message = /--- начало обращения ---\s*([\s\S]*?)\s*--- конец обращения ---/u.exec(ticket.prompt)?.[1];
  const jira = /^Разбери Jira-задачу [A-Z0-9-]+:\s*([^\n]+)/u.exec(ticket.prompt)?.[1];
  const finding = /^Что нашли:\s*(.+)$/mu.exec(ticket.prompt)?.[1];
  return ticketTopicName(ticket.id, message ?? jira ?? finding ?? "Без описания", ticket.externalKey, ticket.workspace);
}

function isPlaceholderTopic(title: string): boolean {
  const body = title.replace(/^\p{Extended_Pictographic}\uFE0F?\s+\[[^\]]+\]\s*(?:\S+\s+)?·\s*/u, "").trim();
  return /^(?:Задача|Без описания|Тикет\s*#?\d+|#\d+|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)$/iu.test(body);
}

/** Keep meaningful saved intent; recover automatic placeholders from the ticket's content. */
export function resolvedTicketTopic(
  ticket: Pick<Ticket, "id" | "externalKey" | "workspace" | "prompt" | "topicTitle">,
  saved?: string,
  manual?: string,
): string {
  const title = manual
    ? renamedTicketTopic(ticket, manual)
    : saved && !isPlaceholderTopic(saved)
      ? renamedTicketTopic(ticket, saved)
      : restoredTicketTopic(ticket);
  return truncateCanonicalTopicName(title);
}

function truncateCanonicalTopicName(title: string): string {
  if (title.length <= MAX_CANONICAL_TOPIC_NAME_LENGTH) return title;
  let result = "";
  for (const character of title) {
    if (result.length + character.length + 1 > MAX_CANONICAL_TOPIC_NAME_LENGTH) break;
    result += character;
  }
  return `${result}…`;
}
