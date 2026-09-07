import { Api, type ApiClientOptions } from "grammy";

import type { ForumTopicLivenessOptions } from "./telegram-topic-liveness.js";

export type TelegramTopicLivenessApi = Pick<ForumTopicLivenessOptions, "sendChatAction">;

/** Isolated from bot.api transformers: an ambiguous probe must never be retried. */
export function createTelegramTopicLivenessApi(
  token: string,
  options?: ApiClientOptions,
): TelegramTopicLivenessApi {
  const api = new Api(token, options);
  return {
    sendChatAction: (chatId, action, requestOptions, signal) =>
      api.sendChatAction(chatId, action, requestOptions, signal as never),
  };
}
