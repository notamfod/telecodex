import type { Api } from "grammy";

import { getThread as readThread, type CodexThreadRecord } from "./codex-state.js";
import { escapeHTML } from "./format.js";
import { probeForumTopic } from "./projects.js";
import type { SessionRegistry } from "./session-registry.js";
import type {
  TelegramTopicRecoveryRuntimeOptions,
  TelegramTopicRecoveryRuntimeReasonCode,
} from "./telegram-topic-recovery-runtime.js";

type RecoveryApi = Pick<
  Api,
  "reopenForumTopic" | "closeForumTopic" | "createForumTopic" | "sendMessage"
>;

type RecoveryRegistry = Pick<SessionRegistry, "listContexts" | "rebindThreadTopic">;

export interface TelegramTopicRecoveryAdapterOptions {
  readonly enabled: boolean;
  readonly forumChatId: number | null | undefined;
  readonly creationTimeoutMs: number;
  readonly api: RecoveryApi;
  readonly registry: RecoveryRegistry;
  readonly getThread?: (threadId: string) => CodexThreadRecord | null;
  readonly reportReason: (input: {
    readonly jobId: string;
    readonly reasonCode: TelegramTopicRecoveryRuntimeReasonCode;
  }) => void;
}

export type TelegramTopicRecoveryAdapter = Omit<
  TelegramTopicRecoveryRuntimeOptions,
  "store" | "outboxPump" | "trackEffect"
>;

export function createTelegramTopicRecoveryAdapter(
  options: TelegramTopicRecoveryAdapterOptions,
): TelegramTopicRecoveryAdapter | undefined {
  if (!options.enabled) return undefined;
  const getThread = options.getThread ?? readThread;
  return {
    forumChatId: options.forumChatId ?? 0,
    hasThreadTopicBinding: (threadId, destination) => options.registry.listContexts().some(
      (context) => context.contextKey === `${destination.chatId}:${destination.messageThreadId}`
        && context.threadId === threadId,
    ),
    probeForumTopic: ({ chatId, messageThreadId }, signal) => probeForumTopic(messageThreadId, {
      reopen: (threadId) => options.api.reopenForumTopic(chatId, threadId, signal as never),
      close: (threadId) => options.api.closeForumTopic(chatId, threadId, signal as never),
    }),
    createForumTopic: async ({ chatId, topicName, signal }) => {
      const topic = await options.api.createForumTopic(chatId, topicName, {}, signal as never);
      return { chatId, messageThreadId: topic.message_thread_id };
    },
    getThread,
    rebindThreadTopic: (oldContextKey, newContextKey, thread) => {
      options.registry.rebindThreadTopic(oldContextKey, newContextKey, thread);
    },
    sendWelcome: async ({ chatId, messageThreadId }, topicName, signal) => {
      await options.api.sendMessage(
        chatId,
        `<b>${escapeHTML(topicName)}</b>\n\nSend a message to continue this session.`,
        { message_thread_id: messageThreadId, parse_mode: "HTML" },
        signal as never,
      );
    },
    creationTimeoutMs: options.creationTimeoutMs,
    reportReason: options.reportReason,
  };
}
