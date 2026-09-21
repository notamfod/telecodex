import type { Api, Bot, Context } from "grammy";
import { contextKeyFromCtx, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { topicUrl } from "./projects.js";
import type { ContextMetadata, SessionRegistry } from "./session-registry.js";
import type { TaskProvisioningStore } from "./task-provisioning.js";

export type ClearTopicApi = Pick<Api, "getChatMember" | "createForumTopic" | "deleteForumTopic" | "sendMessage" | "editMessageText">;
interface Dependencies {
  api: ClearTopicApi;
  forumChatId?: number;
  registry: Pick<SessionRegistry, "listContexts" | "rebindThreadTopic">;
  store(): Pick<TaskProvisioningStore, "pending" | "setPending">;
  isAllowed(ctx: Context): boolean;
  isExcluded(chatId: number, messageThreadId: number): boolean;
  title(contextKey: TelegramContextKey): string | undefined;
  isSafe(contextKey: TelegramContextKey, threadId: string | null): Promise<boolean>;
  serialize<T>(contextKey: TelegramContextKey, operation: () => Promise<T>): Promise<T>;
  moveRelated(oldContextKey: TelegramContextKey, newContextKey: TelegramContextKey): Promise<void>;
  report(error: unknown): void;
}
interface ClearOperation {
  source: TelegramContextKey;
  metadata: ContextMetadata;
  title: string;
  phase: "prepared" | "creating" | "created" | "bound" | "done";
  topicId?: number;
  welcomeId?: number;
}
const operationKey = (key: string) => `clear-topic:${key}`;
const targetKey = (key: string) => `clear-topic-target:${key}`;
const sameSession = (a: ContextMetadata, b: ContextMetadata) => a.threadId === b.threadId && a.workspace === b.workspace
  && a.launchProfileId === b.launchProfileId && a.modelChoiceId === b.modelChoiceId
  && a.model === b.model && a.modelProvider === b.modelProvider && a.reasoningEffort === b.reasoningEffort;
const isClearCommand = (ctx: Context) => /^\/clear_all(?:@\w+)?(?:\s|$)/u.test(ctx.message?.text ?? "");

/** Durable creation intent prevents duplicate topics after an ambiguous Telegram response. */
export function registerClearTopicCommand(bot: Bot<Context>, deps: Dependencies) {
  const active = new Map<string, Promise<void>>();
  const read = (key: string) => deps.store().pending<ClearOperation>(operationKey(key));
  const save = (operation: ClearOperation) => deps.store().setPending(operationKey(operation.source), operation);
  const destination = (op: ClearOperation) => `${parseContextKey(op.source).chatId}:${op.topicId}` as TelegramContextKey;
  const resolve = (key: TelegramContextKey) => {
    const prior = deps.store().pending<TelegramContextKey>(targetKey(key));
    return prior && read(prior)?.phase !== "done" ? prior : key;
  };
  const reply = async (ctx: Context, text: string) => {
    await ctx.reply(text, { ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}) });
  };
  const run = async (ctx: Context, source: TelegramContextKey) => {
    let op = read(source);
    const { chatId, messageThreadId } = parseContextKey(source);
    try {
      if (op?.phase === "done") return;
      if (op?.phase === "creating") {
        await reply(ctx, "Telegram не подтвердил создание нового топика. Повторное создание остановлено: проверь список топиков. Старая история не удалялась."); return;
      }
      if (!op || op.phase === "prepared") {
        const metadata = deps.registry.listContexts().find(c => c.contextKey === source);
        const title = deps.title(source);
        if (!metadata || !title?.trim()) {
          await reply(ctx, "Не удалось определить сессию и название рабочего топика. Открой /session и задай название через /task title <название>."); return;
        }
        if (!await deps.isSafe(source, metadata.threadId)) {
          await reply(ctx, "Дождись завершения текущего запроса и доставки ответа, затем повтори /clear_all."); return;
        }
        const member = await deps.api.getChatMember(chatId, ctx.me.id, AbortSignal.timeout(15_000) as never);
        if (member.status !== "creator" && (member.status !== "administrator" || !member.can_manage_topics || !member.can_delete_messages)) {
          await reply(ctx, "Боту нужны права администратора: управление топиками и удаление сообщений."); return;
        }
        op = { source, metadata: { ...metadata }, title, phase: "prepared" };
        save(op);
      }
      const sourceMetadata = deps.registry.listContexts().find(c => c.contextKey === source);
      const targetMetadata = op.topicId ? deps.registry.listContexts().find(c => c.contextKey === destination(op!)) : undefined;
      if ((sourceMetadata && !sameSession(sourceMetadata, op.metadata))
        || (targetMetadata && !sameSession(targetMetadata, op.metadata))
        || (!sourceMetadata && !targetMetadata)) throw new Error("Topic binding changed during clearing");
      if (!await deps.isSafe(source, op.metadata.threadId)
        || (op.topicId && !await deps.isSafe(destination(op), op.metadata.threadId))) {
        await reply(ctx, "Перенос приостановлен: сессия занята. После завершения запроса повтори /clear_all."); return;
      }
      if (op.phase === "prepared") {
        op.phase = "creating"; save(op);
        let created;
        try {
          created = await deps.api.createForumTopic(chatId, op.title, {}, AbortSignal.timeout(15_000) as never);
        } catch (error) {
          const code = (error as { error_code?: number })?.error_code;
          if (code && code >= 400 && code < 500) { op.phase = "prepared"; save(op); }
          throw error;
        }
        if (!Number.isSafeInteger(created.message_thread_id) || created.message_thread_id <= 1 || created.message_thread_id === messageThreadId) {
          throw new Error("Invalid replacement topic");
        }
        op.topicId = created.message_thread_id; op.phase = "created"; save(op);
      }
      const target = destination(op);
      // Both keys stay blocked while the operation is incomplete, including after restart.
      deps.store().setPending(targetKey(target), source);
      deps.store().setPending(`topic-name:${target}`, op.title);
      await deps.serialize(target, async () => {
        const transferText = `${op!.title}\n\nТопик подготовлен. Переношу сессию и очищаю старую историю.`;
        if (!op!.welcomeId) {
          const message = await deps.api.sendMessage(chatId, transferText,
            { message_thread_id: op!.topicId }, AbortSignal.timeout(15_000) as never);
          if (message.chat.id !== chatId || message.message_thread_id !== op!.topicId || !Number.isSafeInteger(message.message_id) || message.message_id <= 0) {
            throw new Error("Welcome was not delivered to the replacement topic");
          }
          op!.welcomeId = message.message_id; save(op!);
        }
        const verifyDestination = async () => {
          // Typing ACKs do not prove existence. Editing the known welcome does, even on retry.
          try { await deps.api.editMessageText(chatId, op!.welcomeId!, transferText, {}, AbortSignal.timeout(15_000) as never); }
          catch (error) {
            const apiError = error as { error_code?: number; description?: string };
            if (apiError.error_code !== 400 || !/message is not modified/iu.test(apiError.description ?? "")) throw error;
          }
        };
        const verifyIdle = async () => {
          if (!await deps.isSafe(source, op!.metadata.threadId) || !await deps.isSafe(target, op!.metadata.threadId)) {
            throw new Error("Session became active during topic clearing");
          }
        };
        await verifyDestination();
        await verifyIdle();
        if (op!.phase === "created") {
          await deps.moveRelated(source, target);
          const contexts = deps.registry.listContexts();
          if (contexts.some(c => c.contextKey === source)) deps.registry.rebindThreadTopic(source, target);
          else if (!contexts.some(c => c.contextKey === target && sameSession(c, op!.metadata))) throw new Error("Replacement binding missing");
          op!.phase = "bound"; save(op!);
        }
        // Persisted bindings and a reachable destination must exist before irreversible deletion.
        if (op!.phase === "bound") {
          await verifyDestination();
          await verifyIdle();
          try { await deps.api.deleteForumTopic(chatId, messageThreadId!, AbortSignal.timeout(15_000) as never); }
          catch (error) {
            const apiError = error as { error_code?: number; description?: string };
            if (apiError.error_code !== 400 || !/TOPIC_DELETED|TOPIC_ID_INVALID|message thread not found/iu.test(apiError.description ?? "")) throw error;
          }
          op!.phase = "done"; save(op!);
        }
        await deps.api.editMessageText(chatId, op!.welcomeId!, "История очищена. Сессия Codex сохранена. Продолжай здесь.", {}, AbortSignal.timeout(15_000) as never);
      });
    } catch (error) {
      deps.report(error);
      const link = op?.topicId ? `\nНовый топик: ${topicUrl(chatId, op.topicId)}` : "";
      const text = op?.phase === "done" ? `История очищена, но сообщение о завершении не обновилось.${link}`
        : `Очистка не завершена. Повтори /clear_all для продолжения; при неподтверждённом создании повтор будет остановлен.${link}`;
      await reply(ctx, text).catch(deps.report);
      if (op?.topicId && op.welcomeId) {
        await deps.api.editMessageText(chatId, op.welcomeId, text, {}, AbortSignal.timeout(15_000) as never).catch(deps.report);
      }
    }
  };
  bot.command("clear_all", async ctx => {
    if (!deps.isAllowed(ctx)) return;
    const key = contextKeyFromCtx(ctx);
    const topicId = ctx.message?.message_thread_id;
    if (!key || ctx.chat?.type !== "supergroup" || ctx.chat.is_forum !== true || !topicId || topicId <= 1
      || (deps.forumChatId !== undefined && deps.forumChatId !== ctx.chat.id) || deps.isExcluded(ctx.chat.id, topicId)) {
      await reply(ctx, "Команда доступна только в рабочем топике. Общий топик, Inbox и служебные панели очищать нельзя."); return;
    }
    if (String(ctx.match ?? "").trim()) { await reply(ctx, "Отправь /clear_all без аргументов в топике, который нужно очистить."); return; }
    const source = resolve(key);
    const existing = active.get(source);
    if (existing) { await existing; return; }
    const operation = deps.serialize(source, () => run(ctx, source));
    active.set(source, operation);
    try { await operation; } finally { active.delete(source); }
  });
  return {
    async guard(ctx: Context): Promise<boolean> {
      if (isClearCommand(ctx)) return false;
      const key = contextKeyFromCtx(ctx);
      if (!key) return false;
      const source = resolve(key);
      const op = read(source);
      if (!active.has(source) && (!op || op.phase === "prepared" || op.phase === "creating" || (op.phase === "done" && source !== key))) return false;
      const text = op?.topicId ? `Топик переносится или уже перенесён: ${topicUrl(parseContextKey(source).chatId, op.topicId)}${op.phase !== "done" ? "\nПовтори /clear_all, чтобы завершить очистку." : ""}`
        : "Выполняется очистка топика. Дождись завершения или повтори /clear_all.";
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Топик переносится. Открой новый топик." }).catch(deps.report);
      else await reply(ctx, text).catch(deps.report);
      return true;
    },
  };
}
