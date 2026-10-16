import { readFile } from "node:fs/promises";
import type { Bot, Context } from "grammy";

import { activateGitlabReview, type GitlabReviewLaunchOutcome, type GitlabReviewLaunchRequest }
  from "./gitlab-review-launch-client.js";
import { parseRecipes, RECIPE_CONFIG_PATH } from "./recipe-config.js";

export const GITLAB_REVIEW_CALLBACK = /^greview:([a-f0-9]{32})$/;

interface GitlabReviewCallbackDependencies {
  readonly loadTarget?: () => Promise<{ chatId: number; messageThreadId: number }>;
  readonly activate?: (request: GitlabReviewLaunchRequest) => Promise<GitlabReviewLaunchOutcome>;
}

async function loadReviewTarget(): Promise<{ chatId: number; messageThreadId: number }> {
  const configPath = process.env.RECIPES_CONFIG?.trim() || RECIPE_CONFIG_PATH;
  const recipe = parseRecipes(await readFile(configPath, "utf8"))
    .find((candidate) => candidate.id === "daily-diff-review" && candidate.kind === "mircli-review");
  if (!recipe?.deliver) throw new Error("GitLab review delivery target unavailable");
  return recipe.deliver;
}

export async function handleGitlabReviewCallback(
  ctx: Context,
  allowedUserIds: ReadonlySet<number>,
  dependencies: GitlabReviewCallbackDependencies = {},
): Promise<void> {
  if (!ctx.from || !allowedUserIds.has(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }
  const match = GITLAB_REVIEW_CALLBACK.exec(ctx.callbackQuery?.data ?? "");
  const message = ctx.callbackQuery?.message;
  const messageThreadId = message && "message_thread_id" in message ? message.message_thread_id : undefined;
  if (!match || !ctx.chat || !message || messageThreadId === undefined) {
    await ctx.answerCallbackQuery({ text: "Кнопка ревью недоступна", show_alert: true });
    return;
  }
  let outcome: GitlabReviewLaunchOutcome;
  try {
    const target = await (dependencies.loadTarget ?? loadReviewTarget)();
    if (ctx.chat.id !== target.chatId || messageThreadId !== target.messageThreadId) {
      await ctx.answerCallbackQuery({ text: "Кнопка работает только в топике ревью", show_alert: true });
      return;
    }
    outcome = await (dependencies.activate ?? activateGitlabReview)({
      requestId: match[1], chatId: ctx.chat.id, messageThreadId, messageId: message.message_id,
    });
  } catch {
    await ctx.answerCallbackQuery({ text: "Не удалось запустить ревью. Попробуй ещё раз.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: outcome === "accepted" ? "Ревью поставлено в очередь" : "Ревью уже запускали" })
    .catch(() => undefined);
  const rows = ("reply_markup" in message ? message.reply_markup?.inline_keyboard : []) ?? [];
  const navigation = rows.map((row) => row.filter((button) =>
    !("callback_data" in button && button.callback_data === `greview:${match[1]}`),
  )).filter((row) => row.length > 0);
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: navigation } }).catch(() => undefined);
}

export function registerGitlabReviewHandlers(
  bot: Pick<Bot<Context>, "callbackQuery">,
  allowedUserIds: ReadonlySet<number>,
): void {
  bot.callbackQuery(GITLAB_REVIEW_CALLBACK, (ctx) => handleGitlabReviewCallback(ctx, allowedUserIds));
}
