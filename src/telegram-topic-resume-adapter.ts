import type { ApiClientOptions } from "grammy";

import { getThread as readThread, type CodexThreadRecord } from "./codex-state.js";
import type { SessionRegistry } from "./session-registry.js";
import { createForumTopicLivenessClassifier } from "./telegram-topic-liveness.js";
import { createTelegramTopicResumeApi } from "./telegram-topic-resume-api.js";
import type { TelegramTopicResumeRuntimeOptions } from "./telegram-topic-resume-runtime.js";

type ResumeRegistry = Pick<SessionRegistry, "listContexts">;

export interface TelegramTopicResumeAdapterOptions {
  readonly token: string;
  readonly clientOptions?: ApiClientOptions;
  readonly forumChatId: number;
  readonly registry: ResumeRegistry;
  readonly getThread?: (threadId: string) => CodexThreadRecord | null;
}

export type TelegramTopicResumeAdapter = Pick<
  TelegramTopicResumeRuntimeOptions,
  | "forumChatId"
  | "classifyForumTopic"
  | "reopenForumTopic"
  | "invalidateForumTopicLiveness"
  | "getThread"
  | "hasThreadTopicBinding"
>;

export function createTelegramTopicResumeAdapter(
  options: TelegramTopicResumeAdapterOptions,
): TelegramTopicResumeAdapter {
  const api = createTelegramTopicResumeApi(options.token, options.clientOptions);
  const createClassifier = () => createForumTopicLivenessClassifier({
    sendChatAction: api.sendChatAction,
  });
  let classifyForumTopic = createClassifier();
  return {
    forumChatId: options.forumChatId,
    classifyForumTopic: (destination, signal) => classifyForumTopic(destination, signal),
    invalidateForumTopicLiveness: () => { classifyForumTopic = createClassifier(); },
    reopenForumTopic: (destination, signal) => api.reopenForumTopic(
      destination.chatId,
      destination.messageThreadId,
      signal,
    ),
    getThread: options.getThread ?? readThread,
    hasThreadTopicBinding: (threadId, destination) => options.registry.listContexts().some(
      (context) => context.contextKey === `${destination.chatId}:${destination.messageThreadId}`
        && context.threadId === threadId,
    ),
  };
}
