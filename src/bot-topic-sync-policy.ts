import { randomBytes } from "node:crypto";
import type { Bot, Context } from "grammy";
import { previewTopicSync, validateTopicSyncPolicy, type TopicSyncPolicy, type TopicSyncPolicyStore } from "./topic-sync-policy.js";

export interface TopicSyncPolicyCommandOptions {
  store: TopicSyncPolicyStore;
  chatId: number;
  listUserThreads(): { id: string; cwd: string }[];
  registry: { isThreadBoundInChat(id: string, chatId: number): boolean };
  isAllowed(ctx: Context): boolean;
}
const labels = { all: "Все подходящие сессии", selectedprojects: "Выбранные проекты", onrequest: "По запросу" };
export function registerTopicSyncPolicyCommands(bot: Pick<Bot<Context>, "command" | "callbackQuery">, options: TopicSyncPolicyCommandOptions): void {
  const previews = new Map<string, { userId: number; expires: number; policy: TopicSyncPolicy; baseline: string }>();
  const allowed = (ctx: Context) => ctx.chat?.id === options.chatId && !!ctx.from && options.isAllowed(ctx);
  bot.command("topicsync", async ctx => {
    if (!allowed(ctx)) return;
    const argument = String(ctx.match ?? "").trim();
    const count = (policy: TopicSyncPolicy) => previewTopicSync(policy, options.listUserThreads(), options.registry, options.chatId);
    if (!argument) {
      const policy = options.store.get();
      await ctx.reply(`Создание топиков: ${labels[policy.mode]}. Кандидатов сейчас: ${count(policy)}.\nСмена режима с предварительным просмотром:\n/topicsync all\n/topicsync onrequest\n/topicsync selectedprojects /absolute/project; /another/project\nПоиск сессий и существующие топики доступны в любом режиме.`);
      return;
    }
    const [mode, ...rest] = argument.split(/\s+/u);
    let policy: TopicSyncPolicy;
    try {
      if (mode !== "selectedprojects" && rest.length) throw new Error("Unexpected paths");
      policy = validateTopicSyncPolicy({ mode: mode as TopicSyncPolicy["mode"], projects: rest.join(" ").split(";").map(value => value.trim()).filter(Boolean) });
    } catch {
      await ctx.reply("Укажите all, onrequest или selectedprojects и абсолютные пути проектов через точку с запятой.");
      return;
    }
    for (const [key, value] of previews) if (value.expires < Date.now() || value.userId === ctx.from!.id) previews.delete(key);
    if (previews.size >= 100) previews.delete(previews.keys().next().value!);
    const token = randomBytes(12).toString("hex");
    previews.set(token, { userId: ctx.from!.id, expires: Date.now() + 300_000, policy, baseline: JSON.stringify(options.store.get()) });
    await ctx.reply(`${labels[policy.mode]}. Кандидатов для новых топиков сейчас: ${count(policy)}.${policy.projects.length ? `\nПроекты: ${policy.projects.join("; ")}` : ""}\nКоличество может измениться. Существующие топики сохранятся. Применить режим?`, {
      reply_markup: { inline_keyboard: [[{ text: "Применить режим", callback_data: `topicsync_apply:${token}` }]] },
    });
  });
  bot.callbackQuery(/^topicsync_apply:([a-f0-9]{24})$/u, async ctx => {
    if (!allowed(ctx)) { await ctx.answerCallbackQuery({ text: "Нет доступа" }); return; }
    const token = ctx.match[1];
    const preview = previews.get(token);
    if (!preview || preview.userId !== ctx.from!.id || preview.expires < Date.now() || preview.baseline !== JSON.stringify(options.store.get())) {
      await ctx.answerCallbackQuery({ text: "Предпросмотр устарел. Повторите /topicsync." }); return;
    }
    options.store.set(preview.policy);
    previews.delete(token);
    await ctx.answerCallbackQuery({ text: "Режим сохранён" });
    await ctx.editMessageText(`Создание топиков: ${labels[preview.policy.mode]}. Режим сохранён. Поиск сессий доступен как прежде.`);
  });
}
