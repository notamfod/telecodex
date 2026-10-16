import type { Bot, Context } from "grammy";
import { switchMircliDeployView, type MircliDeployViewRequest } from "./mircli-deploy-view-client.js";

export const MIRCLI_DEPLOY_CALLBACK = /^mdeploy:(main|production)$/;
type MircliDeployBotConfig = {
  readonly telegramAllowedUserIdSet: ReadonlySet<number>;
  readonly telegramForumChatId?: number;
};

export async function handleMircliDeployCallback(
  ctx: Context,
  config: MircliDeployBotConfig,
  dependencies: { readonly switchView?: (request: MircliDeployViewRequest) => Promise<void> } = {},
): Promise<void> {
  const answer = (options: { text?: string; show_alert?: boolean }) => ctx.answerCallbackQuery(options).catch(() => undefined);
  if (!ctx.from || !config.telegramAllowedUserIdSet.has(ctx.from.id)) {
    await answer({ text: "Unauthorized" });
    return;
  }
  const match = MIRCLI_DEPLOY_CALLBACK.exec(ctx.callbackQuery?.data ?? "");
  const message = ctx.callbackQuery?.message;
  const topic = message && "message_thread_id" in message ? message.message_thread_id : undefined;
  if (!match || !ctx.chat || ctx.chat.id !== config.telegramForumChatId
    || !Number.isSafeInteger(ctx.chat.id) || ctx.chat.id === 0
    || !message || message.chat.id !== ctx.chat.id
    || !Number.isSafeInteger(message.message_id) || message.message_id <= 0
    || !Number.isSafeInteger(topic) || !topic || topic <= 0) {
    await answer({ text: "Кнопка сводки недоступна", show_alert: true });
    return;
  }
  try {
    await (dependencies.switchView ?? switchMircliDeployView)({
      chatId: ctx.chat.id, messageThreadId: topic, messageId: message.message_id,
      ref: match[1] as MircliDeployViewRequest["ref"],
    });
  } catch {
    await answer({ text: "Не удалось переключить сводку. Попробуй ещё раз.", show_alert: true });
    return;
  }
  await answer({});
}

export function registerMircliDeployHandlers(bot: Pick<Bot<Context>, "callbackQuery">, config: MircliDeployBotConfig): void {
  bot.callbackQuery(MIRCLI_DEPLOY_CALLBACK, (ctx) => handleMircliDeployCallback(ctx, config));
}
