import { TelegramBackgroundWriteGateAdmissionCancelledError } from "./telegram-background-write-gate.js";
import { definitiveTelegramRetryAfterMs } from "./telegram-rate-limit.js";
import type { TaskProvisioningRecord } from "./task-provisioning.js";
import type { TaskProvisioningService } from "./task-provisioning.js";
import type { CodexThreadRecord } from "./codex-state.js";
import { contextKeyFromMessage, type TelegramContextKey } from "./context-key.js";
import { buildTopicName } from "./topic-sync.js";

export function isSyncedTopicAttemptBlocked(record: TaskProvisioningRecord | undefined): boolean {
  return !!record && record.state !== "accepted";
}

/** Stable identity survives renames, policy changes and uncertain Telegram outcomes. */
export async function provisionSyncedTopic(
  service: TaskProvisioningService, chatId: number, thread: CodexThreadRecord,
  create: (chatId: number, name: string) => Promise<{ message_thread_id: number }>,
  bind: (contextKey: TelegramContextKey, thread: CodexThreadRecord) => void,
): Promise<"created" | "skipped"> {
  const operationId = `sync:${chatId}:${thread.id}`;
  const existing = service.store.get(operationId);
  if (isSyncedTopicAttemptBlocked(existing)) return "skipped";
  if (typeof existing?.metadata?.retryAfterUntil === "number" && Date.now() < existing.metadata.retryAfterUntil) return "skipped";
  let transportError: unknown;
  const record = await service.provision({ operationId, sourceContextKey: String(chatId), sourceMessageIds: [],
    title: buildTopicName(thread), workspace: thread.cwd, kind: "sync", metadata: { threadId: thread.id } }, {
    createTopic: async item => {
      try { return (await create(chatId, item.title)).message_thread_id; }
      catch (error) { transportError = error; throw error; }
    },
    bind: item => {
      try { bind(contextKeyFromMessage(chatId, item.messageThreadId!), thread); }
      catch (error) { transportError = error; throw error; }
    },
    ready: async () => {},
  });
  if (transportError !== undefined) {
    const rateDelay = definitiveTelegramRetryAfterMs(transportError);
    const admissionCancelled = transportError instanceof TelegramBackgroundWriteGateAdmissionCancelledError;
    if (record.failureStage === "create" && !record.messageThreadId && (rateDelay !== undefined || admissionCancelled)) {
      service.store.patch(operationId, { state: "accepted", failureStage: undefined,
        metadata: { ...record.metadata, retryAfterUntil: Date.now() + (rateDelay ?? 1000) } });
    }
    throw transportError;
  }
  if (record.state !== "ready") throw new Error("Topic provisioning requires inspection");
  return "created";
}
