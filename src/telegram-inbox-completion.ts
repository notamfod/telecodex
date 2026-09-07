import { parseContextKey } from "./context-key.js";
import { escapeHTML } from "./format.js";
import { canPostTicketToJira } from "./jira-comment.js";
import type { Ticket } from "./inbox.js";
import type { TelegramWorkSource } from "./telegram-job-ingress.js";
import type { TelegramSupplementalResponsePart } from "./telegram-response-plan.js";
import { normalizeTelegramTurnResult, type TelegramTurnResult } from "./telegram-turn-result.js";
import { extractTopicRename, renamedTicketTopic } from "./topic-naming.js";

export interface TelegramCompletionPreparationInput {
  readonly jobId: string;
  readonly source: TelegramWorkSource;
  readonly result: TelegramTurnResult;
}

export interface TelegramCompletionPreparation {
  readonly result: TelegramTurnResult;
  readonly supplementalParts: readonly TelegramSupplementalResponsePart[];
}

export type TelegramCompletionProcessor = (
  input: TelegramCompletionPreparationInput,
) => Promise<TelegramCompletionPreparation>;

export interface TelegramInboxCompletionDependencies {
  readonly getTicket: (ticketId: number) => Ticket | undefined;
  readonly jiraConfigured: boolean;
  readonly answerWorkspace: string;
  readonly renameTopic: (chatId: number, messageThreadId: number, name: string) => Promise<boolean>;
  readonly setTopicTitle: (ticketId: number, title: string) => boolean;
  readonly saveAnswer: (workspace: string, ticketId: number, answer: string) => Promise<void>;
}

export function createTelegramInboxCompletionProcessor(
  dependencies: TelegramInboxCompletionDependencies,
): TelegramCompletionProcessor {
  return async ({ source, result }) => {
    const completion = source.completion;
    if (!completion || completion.kind !== "inbox_ticket") {
      return { result: normalizeTelegramTurnResult(result), supplementalParts: [] };
    }
    const ticket = dependencies.getTicket(completion.ticketId);
    if (!ticket) throw new Error("Inbox completion ticket not found");
    const inboxContext = parseContextKey(ticket.inboxContextKey);
    if (source.chatId !== inboxContext.chatId || source.messageThreadId !== ticket.workTopicId) {
      throw new Error("Inbox completion context mismatch");
    }

    const prepared = prepareResult(result);
    const current = dependencies.getTicket(ticket.id);
    if (prepared.title && current && current.topicTitle === undefined) {
      const renamed = await dependencies.renameTopic(
        inboxContext.chatId,
        current.workTopicId,
        renamedTicketTopic(current, prepared.title),
      );
      if (renamed && !dependencies.setTopicTitle(current.id, prepared.title)) {
        throw new Error("Inbox completion ticket disappeared");
      }
    }
    await dependencies.saveAnswer(
      dependencies.answerWorkspace,
      ticket.id,
      answerText(prepared.result),
    );

    const latest = dependencies.getTicket(ticket.id);
    const supplementalParts = dependencies.jiraConfigured && latest && canPostTicketToJira(latest)
      ? [jiraConfirmation(latest, inboxContext.chatId)]
      : [];
    return { result: prepared.result, supplementalParts };
  };
}

function prepareResult(result: TelegramTurnResult): {
  readonly result: TelegramTurnResult;
  readonly title: string | undefined;
} {
  const normalized = normalizeTelegramTurnResult(result);
  let title: string | undefined;
  let transformed = false;
  const content = normalized.content.map((part) => {
    if (transformed || part.kind !== "text") return part;
    transformed = true;
    const extracted = extractTopicRename(part.text);
    if (!extracted) return part;
    title = extracted.title;
    return { kind: "text" as const, text: extracted.text };
  }).filter((part) => part.kind !== "text" || part.text.length > 0);
  return { result: { schemaVersion: 1, content }, title };
}

function answerText(result: TelegramTurnResult): string {
  return result.content
    .filter((part): part is Extract<TelegramTurnResult["content"][number], { kind: "text" }> => part.kind === "text")
    .map(({ text }) => text)
    .join("\n\n");
}

function jiraConfirmation(ticket: Ticket, chatId: number): TelegramSupplementalResponsePart {
  const externalKey = ticket.externalKey!;
  return {
    partKey: "jira-confirm",
    kind: "notice",
    payload: {
      operation: "send_text",
      chatId,
      messageThreadId: ticket.workTopicId,
      text: `<b>Результат анализа сохранён.</b> Отправить в ${escapeHTML(externalKey)}?`,
      replyMarkup: {
        inlineKeyboard: [[{ text: "📤 В Jira", callbackData: `jira_post:${ticket.id}` }]],
      },
    },
  };
}
