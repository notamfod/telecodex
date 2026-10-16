import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Bot, Context } from "grammy";

import { activateGitlabReview, type GitlabReviewLaunchOutcome, type GitlabReviewLaunchRequest }
  from "./gitlab-review-launch-client.js";
import { parseRecipes, RECIPE_CONFIG_PATH } from "./recipe-config.js";
import { GitlabReviewSelection } from "./gitlab-review-selection.js";

export const GITLAB_REVIEW_CALLBACK = /^greview:([a-f0-9]{32})$/;
export const GITLAB_PIPELINE_CALLBACK = /^(gpselect|gpipeline):([a-f0-9]{32})$/;

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
  bot.callbackQuery(GITLAB_PIPELINE_CALLBACK, async (ctx) => {
    const selection = new GitlabReviewSelection(path.resolve(process.env.REVIEW_PIPELINE_DB
      ? `${process.env.REVIEW_PIPELINE_DB}.selection` : ".telecodex/review-selection.sqlite"));
    try { await handleGitlabPipelineCallback(ctx, allowedUserIds, { selection }); }
    finally { selection.close(); }
  });
}

export async function handleGitlabPipelineCallback(
  ctx: Context,
  allowedUserIds: ReadonlySet<number>,
  dependencies: GitlabReviewCallbackDependencies & { selection: GitlabReviewSelection },
): Promise<void> {
  const match = GITLAB_PIPELINE_CALLBACK.exec(ctx.callbackQuery?.data ?? "");
  const message = ctx.callbackQuery?.message;
  const topic = message && "message_thread_id" in message ? message.message_thread_id : undefined;
  if (!ctx.from || !allowedUserIds.has(ctx.from.id) || !ctx.chat || !match || !message || !topic) {
    await ctx.answerCallbackQuery({ text: "Кнопка недоступна", show_alert: true });
    return;
  }
  const target = await (dependencies.loadTarget ?? loadReviewTarget)().catch(() => undefined);
  if (!target || target.chatId !== ctx.chat.id || target.messageThreadId !== topic) {
    await ctx.answerCallbackQuery({ text: "Кнопка работает только в топике ревью", show_alert: true });
    return;
  }
  const activation = { requestId: match[2], chatId: ctx.chat.id, messageThreadId: topic, messageId: message.message_id };
  const { selection } = dependencies;
  if (match[1] === "gpselect") {
    let selected: boolean;
    try { selected = selection.toggle(ctx.from.id, activation); }
    catch {
      await ctx.answerCallbackQuery({ text: "В подборке может быть до 30 сообщений", show_alert: true });
      return;
    }
    const count = selection.list(ctx.from.id, ctx.chat.id, topic).length;
    await ctx.answerCallbackQuery({ text: `В вашей подборке: ${count}` });
    const rows = ("reply_markup" in message ? message.reply_markup?.inline_keyboard : []) ?? [];
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows.map((row) => row.map((button) =>
      "callback_data" in button && button.callback_data === `gpselect:${match[2]}`
        ? { text: selected ? "☑ В подборке" : "☐ В подборку", callback_data: button.callback_data } : button)) } })
      .catch(() => undefined);
    return;
  }
  const selected = selection.list(ctx.from.id, ctx.chat.id, topic);
  const batch = selected.length ? selected : [activation];
  await ctx.answerCallbackQuery({ text: `Запускаю пайплайн: ${batch.length}` });
  let accepted = 0;
  for (const item of batch) {
    try {
      await (dependencies.activate ?? ((request) => activateGitlabReview(request, {}, true)))(item);
      selection.remove(ctx.from.id, item);
      accepted++;
    } catch { /* Keep failed messages selected so a retry only handles the remainder. */ }
  }
  const text = `Пайплайн поставлен в очередь: ${accepted} из ${batch.length}.`
    + (accepted < batch.length ? " Остальные сообщения остаются в подборке для повтора." : "");
  await ctx.reply(text, { message_thread_id: topic });
}
