import { Api, type ApiClientOptions } from "grammy";

export interface TelegramTopicResumeApi {
  sendChatAction(
    chatId: number,
    action: "typing",
    options: { readonly message_thread_id: number },
    signal: AbortSignal,
  ): Promise<unknown>;
  reopenForumTopic(
    chatId: number,
    messageThreadId: number,
    signal: AbortSignal,
  ): Promise<true>;
}

/** Dedicated client with no retry transformer: every call is one Telegram request. */
export function createTelegramTopicResumeApi(
  token: string,
  clientOptions?: ApiClientOptions,
): TelegramTopicResumeApi {
  const api = new Api(token, clientOptions);
  return {
    sendChatAction: (chatId, action, options, signal) =>
      api.sendChatAction(chatId, action, options, signal as never),
    reopenForumTopic: async (chatId, messageThreadId, signal) => {
      await api.reopenForumTopic(chatId, messageThreadId, signal as never);
      return true;
    },
  };
}
