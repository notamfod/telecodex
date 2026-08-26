import type { Recipe } from "./recipe-config.js";

export interface RecipeTelegramDependencies {
  token?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_RETRIES = 3;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterSeconds(body: string): number | undefined {
  try {
    const seconds = (JSON.parse(body) as { parameters?: { retry_after?: unknown } })
      .parameters?.retry_after;
    return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export async function sendRecipeMessage(
  recipe: Recipe,
  text: string,
  replyMarkup?: Record<string, unknown>,
  dependencies: RecipeTelegramDependencies = {},
): Promise<number | undefined> {
  const token = dependencies.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !recipe.deliver) {
    throw new Error("delivery requested without a bot token or target topic");
  }

  const fetcher = dependencies.fetch ?? fetch;
  const wait = dependencies.sleep ?? sleep;
  const body = JSON.stringify({
    chat_id: recipe.deliver.chatId,
    message_thread_id: recipe.deliver.messageThreadId,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  const request = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, request);
    if (response.ok) {
      const payload = await response.json().catch(() => ({})) as {
        result?: { message_id?: unknown };
      };
      return typeof payload.result?.message_id === "number"
        ? payload.result.message_id
        : undefined;
    }
    const responseBody = await response.text();
    const retryAfter = response.status === 429 ? retryAfterSeconds(responseBody) : undefined;
    if (
      attempt < MAX_RETRIES
      && retryAfter !== undefined
      && retryAfter > 0
      && retryAfter <= MAX_RETRY_AFTER_SECONDS
    ) {
      await wait(retryAfter * 1000);
      continue;
    }
    throw new Error(`sendMessage failed: ${response.status} ${responseBody}`);
  }
}
