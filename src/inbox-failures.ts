import { inspectTelegramErrorForLog, type TelegramLogCategory } from "./telegram-error-log.js";

export interface InboxFailure {
  contextKey: string;
  messageIds: number[];
  outcome: "processing_failed" | "creation_unknown" | "topic_exists";
  workTopicId?: number;
  category: TelegramLogCategory;
  failedAt: number;
}

export type InboxProgress = Pick<InboxFailure, "outcome" | "workTopicId">;

export function makeInboxFailure(
  contextKey: string, messageIds: number[], progress: InboxProgress, error: unknown,
): InboxFailure {
  return {
    contextKey, messageIds, outcome: progress.outcome, workTopicId: progress.workTopicId,
    category: inspectTelegramErrorForLog(error, "inbox").category, failedAt: Date.now(),
  };
}

/** Allowlist persisted fields, including on reload; never keep an error message or source text. */
export function readInboxFailures(value: unknown): InboxFailure[] {
  if (!Array.isArray(value)) return [];
  const categories = new Set(["rate_limited", "topic_closed", "topic_missing", "message_missing", "forbidden", "rich_rejected", "bad_request_other", "network_retryable", "acceptance_unknown", "internal_local"]);
  return value.slice(-100).flatMap((entry): InboxFailure[] => {
    if (!entry || typeof entry !== "object" || !/^-?\d+(?::\d+)?$/.test(entry.contextKey)
      || typeof entry.contextKey !== "string" || !Array.isArray(entry.messageIds)
      || !entry.messageIds.length || !entry.messageIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)
      || !["processing_failed", "creation_unknown", "topic_exists"].includes(entry.outcome)
      || !categories.has(entry.category) || !Number.isFinite(entry.failedAt)) return [];
    const workTopicId = Number.isSafeInteger(entry.workTopicId) && entry.workTopicId > 0 ? entry.workTopicId : undefined;
    if (entry.outcome === "topic_exists" && workTopicId === undefined) return [];
    return [{ contextKey: entry.contextKey, messageIds: entry.messageIds.slice(), outcome: entry.outcome,
      workTopicId, category: entry.category, failedAt: entry.failedAt }];
  });
}

export function inboxFailureText(failure: InboxFailure): string {
  const ids = failure.messageIds.slice(0, 10).join(", ") + (failure.messageIds.length > 10 ? "…" : "");
  const result = failure.outcome === "topic_exists"
    ? `Топик существует (ID ${failure.workTopicId}), но обработка обращения завершилась с ошибкой. Проверь карточку и вложения в этом топике.`
    : failure.outcome === "creation_unknown"
      ? "Создание топика не подтверждено: он мог появиться в Telegram. Сначала проверь список топиков, чтобы не создать дубликат."
      : "Не удалось завершить обработку обращения. Проверь состояние через /inbox status и список топиков.";
  return `⚠️ Inbox: сообщения ${ids}. ${result}\nДля проверки укажи эти номера сообщений и результат /inbox status. Автоматического повтора нет.`;
}
