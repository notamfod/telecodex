import { randomBytes } from "node:crypto";
import path from "node:path";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { TeleCodexConfig } from "./config.js";
import type { SessionRegistry } from "./session-registry.js";
import { contextKeyFromCtx, contextKeyFromMessage } from "./context-key.js";
import { topicUrl } from "./projects.js";
import type { TaskProvisioningService, TaskProvisioningRecord } from "./task-provisioning.js";

export interface TaskCreationDependencies {
  config: TeleCodexConfig;
  registry: Pick<SessionRegistry, "listContexts" | "setContextDefaultsDurably">;
  provisioning(): TaskProvisioningService;
  listWorkspaces(): string[];
  registerTask?(destination: { chatId: number; messageThreadId: number }, title: string): void | Promise<void>;
}
interface Choice { workspace: string; profileId: string; behavior: string }
interface Draft {
  token: string;
  operationId: string;
  kind: "manual" | "extract";
  sourceContextKey: string;
  chatId: number;
  userId: number;
  sourceMessageId?: number;
  commandMessageId: number;
  previewMessageId?: number;
  title: string;
  excerpt?: string;
  attachment?: string;
  choices: Choice[];
  selected: number;
  state: "pending" | "cancelled" | "creating" | "finished";
}
const bounded = (value: string, max: number) => {
  let result = "";
  for (const character of value) { if (result.length + character.length > max) break; result += character; }
  return result;
};
const draftKey = (token: string) => `manual-draft:${token}`;

export function registerTaskCreationCommands(bot: Bot, deps: TaskCreationDependencies): void {
  const allowed = (ctx: Context) => !!ctx.from && deps.config.telegramAllowedUserIdSet.has(ctx.from.id)
    && ctx.chat?.type === "supergroup" && ctx.chat.is_forum === true
    && (deps.config.telegramForumChatId === undefined || ctx.chat.id === deps.config.telegramForumChatId);
  const choices = (sourceContextKey: string): Choice[] => {
    const contexts = deps.registry.listContexts();
    const current = contexts.find(c => c.contextKey === sourceContextKey);
    const workspaces = [...new Set([current?.workspace ?? deps.config.workspace, deps.config.workspace, ...deps.listWorkspaces(), ...contexts.map(c => c.workspace)])].filter(w => path.isAbsolute(w));
    return workspaces.flatMap(workspace => {
      const context = workspace === current?.workspace ? current : contexts.find(c => c.workspace === workspace);
      const profileId = context?.launchProfileId ?? deps.config.defaultLaunchProfileId;
      const profile = deps.config.launchProfiles.find(p => p.id === profileId);
      return profile ? [{ workspace, profileId, behavior: `${profile.label} (${profile.id}) · sandbox: ${profile.sandboxMode} · approval: ${profile.approvalPolicy}` }] : [];
    });
  };
  const valid = (draft: Draft) => {
    const selected = draft.choices[draft.selected];
    return selected && choices(draft.sourceContextKey).some(c => c.workspace === selected.workspace && c.profileId === selected.profileId && c.behavior === selected.behavior);
  };
  const save = (draft: Draft) => deps.provisioning().store.setPending(draftKey(draft.token), draft);
  const preview = (draft: Draft) => {
    const choice = draft.choices[draft.selected];
    const text = [draft.kind === "extract" ? "В отдельную задачу" : "Новая задача", draft.title,
      `Проект: ${choice.workspace}`, `Режим: ${choice.behavior}`,
      ...(draft.excerpt ? [`Выбранное сообщение:\n${draft.excerpt}`] : []),
      ...(draft.attachment ? [`Вложение: ${draft.attachment}`] : []),
      draft.kind === "extract" ? "Переносится только выбранное сообщение и ссылка на источник." : "Будет создан новый топик.",
      "Запуск Codex: только по вашему следующему сообщению."].join("\n\n");
    const keyboard = new InlineKeyboard().text("Создать задачу", `taskdraft:${draft.token}:create`).text("Отмена", `taskdraft:${draft.token}:cancel`);
    draft.choices.forEach((c, index) => keyboard.row().text(`${index === draft.selected ? "✓ " : ""}${bounded(path.basename(c.workspace) || c.workspace, 45)}`, `taskdraft:${draft.token}:p${index}`));
    return { text, keyboard };
  };
  const begin = async (ctx: Context, kind: Draft["kind"]) => {
    if (!allowed(ctx) || !ctx.message) return;
    const sourceContextKey = contextKeyFromCtx(ctx)!;
    const source = ctx.message.reply_to_message;
    if (kind === "extract" && (!source || (source.message_thread_id !== undefined && source.message_thread_id !== ctx.message.message_thread_id))) {
      await ctx.reply("Ответьте командой /extract на сообщение, которое нужно выделить в отдельную задачу."); return;
    }
    const operationId = `${kind}:${sourceContextKey}:${ctx.message.message_id}`;
    const store = deps.provisioning().store;
    const existingToken = store.pending<string>(`manual-operation:${operationId}`);
    if (existingToken) {
      const draft = store.pending<Draft>(draftKey(existingToken));
      if (draft?.previewMessageId) await ctx.reply(`Заявка уже сохранена: ${topicUrl(draft.chatId, draft.previewMessageId)}`);
      else await ctx.reply("Заявка сохранена, но отправка предпросмотра не подтверждена. Топик по этой заявке не создавался. Проверьте сообщения или начните новую заявку командой /newtask либо /extract.");
      return;
    }
    const text = source?.text ?? source?.caption ?? "";
    const title = bounded(kind === "manual" ? String(ctx.match ?? "").trim() : text.trim().split("\n")[0] || "Отдельный вопрос", 128);
    if (!title) { await ctx.reply("Название новой задачи: /newtask <название>"); return; }
    const options = choices(sourceContextKey);
    if (!options.length) { await ctx.reply("Нет проверенного проекта и стартового режима для новой задачи."); return; }
    const draft: Draft = { token: randomBytes(12).toString("hex"), operationId, sourceContextKey, chatId: ctx.chat!.id, userId: ctx.from!.id,
      kind, commandMessageId: ctx.message.message_id, sourceMessageId: kind === "extract" ? source!.message_id : undefined, title,
      excerpt: kind === "extract" ? bounded(text, 1400) : undefined,
      attachment: kind === "extract" && source ? bounded(source.document?.file_name ?? (source.photo ? "Фото" : source.video ? "Видео" : source.audio ? "Аудио" : source.voice ? "Голосовое сообщение" : source.sticker ? "Стикер" : ""), 160) : undefined,
      choices: options.slice(0, 40), selected: 0, state: "pending" };
    save(draft); store.setPending(`manual-operation:${operationId}`, draft.token);
    const rendered = preview(draft);
    const message = await ctx.reply(rendered.text, { reply_markup: rendered.keyboard });
    draft.previewMessageId = message.message_id; save(draft);
  };
  bot.command("newtask", ctx => begin(ctx, "manual"));
  bot.command("extract", ctx => begin(ctx, "extract"));
  bot.callbackQuery(/^taskdraft:([a-f0-9]{24}):(create|cancel|p\d+)$/, async ctx => {
    const match = /^taskdraft:([a-f0-9]{24}):(create|cancel|p\d+)$/.exec(ctx.callbackQuery.data);
    if (!match || !allowed(ctx)) { await ctx.answerCallbackQuery({ text: "Недоступно" }); return; }
    await ctx.answerCallbackQuery();
    const draft = deps.provisioning().store.pending<Draft>(draftKey(match[1]));
    if (!draft || draft.userId !== ctx.from!.id || draft.sourceContextKey !== contextKeyFromCtx(ctx)
      || (draft.previewMessageId !== undefined && draft.previewMessageId !== ctx.callbackQuery.message?.message_id)) {
      await ctx.answerCallbackQuery({ text: "Заявка недоступна в этом контексте" }); return;
    }
    const action = match[2];
    if (draft.state === "cancelled") { await ctx.editMessageText("Создание задачи отменено."); return; }
    if (action === "cancel" && draft.state === "pending") { draft.state = "cancelled"; save(draft); await ctx.editMessageText("Создание задачи отменено."); return; }
    if (action.startsWith("p") && draft.state === "pending") {
      const index = Number(action.slice(1));
      if (!Number.isInteger(index) || !draft.choices[index]) return;
      draft.selected = index; save(draft); const rendered = preview(draft);
      await ctx.editMessageText(rendered.text, { reply_markup: rendered.keyboard }); return;
    }
    if (action !== "create") return;
    const existing = deps.provisioning().store.get(draft.operationId);
    const selectionValid = valid(draft);
    if (existing && (!selectionValid || ["ready", "failed", "unknown"].includes(existing.state))) {
      await ctx.editMessageText(outcome(existing, draft.chatId), { reply_markup: new InlineKeyboard() });
      return;
    }
    if (!selectionValid) { await ctx.editMessageText("Проект или стартовый режим изменился. Создайте новую заявку командой /newtask или /extract."); return; }
    const selected = draft.choices[draft.selected];
    draft.state = "creating"; save(draft);
    const result = await deps.provisioning().provision({ operationId: draft.operationId, sourceContextKey: draft.sourceContextKey,
      sourceMessageIds: [draft.sourceMessageId ?? draft.commandMessageId], title: draft.title, workspace: selected.workspace, launchProfileId: selected.profileId, userId: draft.userId, kind: draft.kind,
      metadata: { previewMessageId: draft.previewMessageId, sourceMessageId: draft.sourceMessageId, sourceContextKey: draft.sourceContextKey } }, {
      createTopic: async () => (await ctx.api.createForumTopic(draft.chatId, draft.title)).message_thread_id,
      bind: async record => {
        const messageThreadId = record.messageThreadId!;
        deps.registry.setContextDefaultsDurably(contextKeyFromMessage(draft.chatId, messageThreadId), { workspace: record.workspace, launchProfileId: record.launchProfileId, topicName: record.title });
        await deps.registerTask?.({ chatId: draft.chatId, messageThreadId }, record.title);
      },
      ready: async record => {
        await ctx.api.sendMessage(draft.chatId, `Задача: ${record.title}\nИсточник: ${topicUrl(draft.chatId, draft.sourceMessageId ?? draft.commandMessageId)}\nПроект: ${record.workspace}\nРежим: ${selected.behavior}\nCodex ещё не запущен.`, { message_thread_id: record.messageThreadId });
        if (draft.kind === "extract") await ctx.api.copyMessage(draft.chatId, draft.chatId, draft.sourceMessageId!, { message_thread_id: record.messageThreadId });
      },
    });
    draft.state = "finished"; save(draft);
    await ctx.editMessageText(outcome(result, draft.chatId), { reply_markup: new InlineKeyboard() });
  });
}
function outcome(record: TaskProvisioningRecord, chatId: number): string {
  const link = record.messageThreadId ? `\n${topicUrl(chatId, record.messageThreadId)}` : "";
  if (record.state === "ready") return `Задача создана. Codex ещё не запущен.${link}`;
  if (record.messageThreadId) return `Топик создан; настройка или перенос источника не подтверждены. Откройте его и проверьте сообщения. Повторное создание не выполняется.${link}`;
  return record.state === "unknown" || record.state === "provisioning" ? "Исход создания пока неизвестен. Проверьте список топиков; автоматического повтора не будет." : "Не удалось создать задачу. Сведения о заявке сохранены; новый топик не подтверждён.";
}
