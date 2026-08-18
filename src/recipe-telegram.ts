import type { Recipe } from "./recipe-config.js";

export async function sendRecipeMessage(
  recipe: Recipe,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !recipe.deliver) {
    throw new Error("delivery requested without a bot token or target topic");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: recipe.deliver.chatId,
      message_thread_id: recipe.deliver.messageThreadId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`sendMessage failed: ${response.status} ${await response.text()}`);
  }
}
