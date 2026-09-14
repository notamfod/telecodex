import { existsSync } from "node:fs";
import path from "node:path";
import type { Api, Context } from "grammy";
import type { TelegramBackgroundWriteGate } from "./telegram-background-write-gate.js";
import { createForumTopicLivenessClassifier } from "./telegram-topic-liveness.js";
import { TopicTaskStore } from "./topic-task-store.js";
import { TopicTaskCardService, isTaskCardCurrent, type TaskDestination, type TopicTaskTransport } from "./topic-task-card.js";
import { safeTaskText, taskTopicName } from "./topic-task-projection.js";
import type { TelegramJob, DeliveryPart } from "./telegram-job-store.js";
import type { TelegramJobStatusProjection } from "./telegram-status-projection.js";

interface Metadata { workspace: string; topicName?: string; threadId: string | null; ticketId?: number; ticketKey?: string }
interface Options {
  api: Pick<Api, "sendMessage" | "editMessageText" | "pinChatMessage" | "sendChatAction" | "editForumTopic">;
  workspace: string;
  forumChatId?: number;
  metadata(destination: TaskDestination): Metadata | undefined;
  isExcluded(destination: TaskDestination): boolean;
  gate?: Pick<TelegramBackgroundWriteGate, "run">;
  report(error: unknown): void;
}

export function createBotTopicTasks(options: Options) {
  const file = path.join(options.workspace, ".telecodex", "topic-tasks.sqlite");
  let service: TopicTaskCardService | undefined;
  let disposed = false;
  const shutdown = new AbortController();
  const nameWrites = new Map<string, Promise<boolean>>();
  const write = async <T>(destination: TaskDestination, operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> => {
    const admission = AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000), ...(callerSignal ? [callerSignal] : [])]);
    const execute = async () => {
      const signal = AbortSignal.any([admission, AbortSignal.timeout(15_000)]);
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(new Error("Task card write interrupted"));
        if (signal.aborted) { aborted(); return; }
        signal.addEventListener("abort", aborted, { once: true });
        Promise.resolve().then(() => operation(signal)).then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", aborted));
      });
    };
    return options.gate ? options.gate.run(destination.chatId, "ordinary", execute, admission) : execute();
  };
  const probe = createForumTopicLivenessClassifier({
    sendChatAction: (chat, action, extra, signal) => write({ chatId: chat, messageThreadId: extra.message_thread_id },
      admission => options.api.sendChatAction(chat, action, extra, admission as never), signal),
    requireDefinitiveErrors: true, cacheTtlMs: 1,
  });
  const transport: TopicTaskTransport = {
    send: async (destination, html) => (await write(destination, signal => options.api.sendMessage(destination.chatId, html,
      { message_thread_id: destination.messageThreadId, parse_mode: "HTML", disable_notification: true }, signal as never))).message_id,
    edit: async (destination, messageId, html) => { await write(destination, signal => options.api.editMessageText(destination.chatId, messageId, html, { parse_mode: "HTML" }, signal as never)); },
    pin: async (destination, messageId) => { await write(destination, signal => options.api.pinChatMessage(destination.chatId, messageId, { disable_notification: true }, signal as never)); },
    probe: destination => probe(destination, shutdown.signal),
  };
  const getService = (create = false): TopicTaskCardService | undefined => {
    if (disposed) return;
    if (!service && (create || existsSync(file))) service = new TopicTaskCardService(new TopicTaskStore(file), transport);
    return service;
  };
  const eligible = (destination: TaskDestination) => destination.chatId === options.forumChatId
    && Number.isSafeInteger(destination.messageThreadId) && destination.messageThreadId > 1 && !options.isExcluded(destination);
  const key = (destination: TaskDestination) => `${destination.chatId}:${destination.messageThreadId}`;
  const rename = (destination: TaskDestination, requested: string, manual: boolean): Promise<boolean> => {
    const title = safeTaskText(requested);
    const context = key(destination);
    const next = (nameWrites.get(context) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const taskService = getService();
      if (!manual && taskService?.store.get(context)?.titleSource === "manual") return false;
      if (manual) await taskService?.update(context, { title, titleSource: "manual" }, { render: false });
      const change = async (name: string) => {
        try { await write(destination, signal => options.api.editForumTopic(destination.chatId, destination.messageThreadId, { name }, signal as never)); }
        catch (error) {
          const description = (error as { description?: string })?.description;
          if (typeof description !== "string" || !/TOPIC_NOT_MODIFIED|topic.*not modified/iu.test(description)) throw error;
        }
      };
      await change(title);
      const latest = taskService?.store.get(context);
      if (!manual && latest?.titleSource === "manual") {
        if (latest.title !== title) await change(latest.title);
        return false;
      }
      if (!manual) await taskService?.update(context, { title }, { automaticTitle: true, render: false });
      return true;
    });
    nameWrites.set(context, next);
    void next.finally(() => { if (nameWrites.get(context) === next) nameWrites.delete(context); }).catch(() => {});
    return next;
  };
  const manualTitle = async (destination: TaskDestination, title: string) => {
    if (!eligible(destination)) return;
    await getService()?.update(key(destination), { title: safeTaskText(title), titleSource: "manual" });
  };
  return {
    enabled(destination: TaskDestination): boolean { return eligible(destination) && getService()?.enabled(destination) === true; },
    shouldPreserveTitle(destination: TaskDestination): boolean {
      try { return getService()?.store.get(key(destination))?.titleSource === "manual"; }
      catch (error) { options.report(error); return true; }
    },
    getManualTitle(destination: TaskDestination): string | undefined {
      const task = getService()?.store.get(key(destination));
      return task?.titleSource === "manual" ? task.title : undefined;
    },
    manualTitle,
    renameAutomatically: (destination: TaskDestination, title: string) => rename(destination, title, false),
    renameManually: (destination: TaskDestination, title: string) => rename(destination, title, true),
    async command(ctx: Context): Promise<void> {
      const destination = { chatId: ctx.chat?.id ?? 0, messageThreadId: ctx.message?.message_thread_id ?? 0 };
      const reply = (text: string) => ctx.reply(text, destination.messageThreadId > 0 ? { message_thread_id: destination.messageThreadId } : {});
      if (!eligible(destination)) { await reply("Карточка доступна в рабочем топике настроенной группы."); return; }
      const args = (ctx.message?.text ?? "").replace(/^\/task(?:@\w+)?\s*/u, "").trim();
      try {
        if (args === "off") {
          await getService()?.update(key(destination), { enabled: false });
          await reply("Обновления карточки отключены. Карточка и привязка сохранены."); return;
        }
        if (args && !args.startsWith("title ")) { await reply("/task - карточка задачи\n/task title <название> - переименовать\n/task off - отключить обновления"); return; }
        const metadata = options.metadata(destination) ?? { workspace: options.workspace, threadId: null };
        const current = getService()?.store.get(key(destination));
        const title = args.startsWith("title ") ? safeTaskText(args.slice(6))
          : current?.title ?? taskTopicName(metadata.topicName || "Задача", metadata.workspace, metadata.ticketKey);
        const taskService = getService(true)!;
        // Persist a manual override before activation can render or receive any automatic rename.
        if (args.startsWith("title ")) {
          const task = taskService.store.ensure({ ...destination, ...metadata, title });
          await taskService.update(task.contextKey, { title, titleSource: "manual" }, { render: false });
          try { await rename(destination, title, true); }
          catch { await reply("Название карточки сохранено. Изменение имени топика не подтверждено."); return; }
        }
        await taskService.activate({ ...destination, ...metadata, title });
        const task = taskService.store.get(key(destination))!;
        await reply(task.cardState === "unknown" || task.cardState === "sending"
          ? "Отправка карточки не подтверждена. Проверь сообщения топика; повторная карточка автоматически не создаётся."
          : task.cardMessageId ? isTaskCardCurrent(task) ? "Карточка задачи обновлена. Она сохраняется между прогонами." : "Карточка сохранена, но последнее обновление не подтверждено. Проверь /task позже."
            : task.presence === "open" ? "Отправка карточки отклонена. Повтори /task позже." : "Не удалось подтвердить доступность топика. Карточка пока не отправлена. Повтори /task позже.");
      } catch (error) {
        options.report(error);
        await reply("Не удалось обновить карточку. Проверь /task позже; при неопределённой отправке повторного создания не будет.");
      }
    },
    async interact(destination: TaskDestination): Promise<void> {
      if (!eligible(destination)) return;
      const taskService = getService();
      const current = taskService?.store.get(key(destination));
      if (!taskService || !current?.enabled) return;
      const metadata = options.metadata(destination);
      if (metadata) await taskService.update(key(destination), { threadId: metadata.threadId, workspace: metadata.workspace, ticketId: metadata.ticketId ?? null,
        ...(current.titleSource === "auto" && metadata.topicName ? { title: taskTopicName(metadata.topicName, metadata.workspace, metadata.ticketKey) } : {}) }, { automaticTitle: true, recheckPresence: true });
      else await taskService.refresh(key(destination), true);
    },
    async observeTopic(destination: TaskDestination, presence?: "open" | "closed", title?: string): Promise<void> {
      if (!eligible(destination)) return;
      const namingInFlight = nameWrites.has(key(destination));
      await getService()?.update(key(destination), { ...(presence ? { presence } : {}), ...(title ? { title: safeTaskText(title), titleSource: "manual" as const } : {}) });
      if (title && namingInFlight) await rename(destination, title, true);
    },
    async observe(job: TelegramJob, projection: TelegramJobStatusProjection, deliveries: readonly DeliveryPart[], destination: TaskDestination, waitingOn?: "input" | "approval", acceptanceOrder?: number): Promise<void> {
      if (eligible(destination)) await getService()?.observe(job, projection, deliveries, destination, waitingOn, acceptanceOrder);
    },
    async dispose(): Promise<void> { disposed = true; shutdown.abort(); await Promise.allSettled([...nameWrites.values()]); await service?.dispose(); },
  };
}
export type BotTopicTasks = ReturnType<typeof createBotTopicTasks>;
