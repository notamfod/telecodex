import { ForumTopicAvailabilityUnknownError } from "./telegram-topic-liveness.js";
import { registerInboxCommands } from "./bot-inbox-commands.js";
import { TaskProvisioningService, TaskProvisioningStore } from "./task-provisioning.js";

import { Bot, InlineKeyboard, type Context } from "grammy";

import type { CodexSessionService } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import {
  contextKeyFromCtx,
  contextKeyFromMessage,
  parseContextKey,
  type TelegramContextKey,
} from "./context-key.js";
import { inboxFailureText, makeInboxFailure, type InboxProgress } from "./inbox-failures.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import {
  BurstBuffer,
  InboxStore,
  buildTicketPrompt,
  describeSource,
  duplicateTicketButtons,
  extractTicketKey,
  groupBurst,
  hasAttachment,
  prepareTicketLaunchPrompt,
  ticketActionButtons,
  ticketHeading,
  ticketTopicName,
  type InboxSettings,
  type Ticket,
} from "./inbox.js";
import {
  JiraCommentClient,
  buildJiraComment,
  canPostTicketToJira,
  readTicketAnswer,
} from "./jira-comment.js";
import { isSafeProjectContext, loadDofboxRealmContext } from "./project-context.js";
import { topicUrl } from "./projects.js";
import type { SessionRegistry } from "./session-registry.js";
import { formatTelegramErrorLog, type TelegramLogCategory } from "./telegram-error-log.js";

const INBOX_QUIET_MS = 2_000;
const INBOX_TOPIC_PAUSE_MS = 3_000;

type InboxAttemptProgress = InboxProgress & { category?: TelegramLogCategory };

type InboxItem = {
  contextKey: TelegramContextKey;
  chatId: number;
  messageId: number;
  mediaGroupId?: string;
  hasAttachment: boolean;
  text: string;
  message: Parameters<typeof describeSource>[0];
};

type TextOptions = {
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

export interface RegisterInboxHandlersDeps {
  provisioning?: TaskProvisioningService | (() => TaskProvisioningService);
  renameTopicManually?(chatId: number, messageThreadId: number, title: string): Promise<void>;
  onManualTopicTitle?(chatId: number, messageThreadId: number, title: string): Promise<void>;
  bot: Bot<Context>;
  config: TeleCodexConfig;
  registry: SessionRegistry;
  inbox: InboxStore;
  jiraComment?: JiraCommentClient;
  topicActivity: {
    rememberIdleIcon(chatId: number, messageThreadId: number, iconCustomEmojiId: string | null): void;
  };
  getContextSession(
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionService } | null>;
  isBusy(contextKey: TelegramContextKey): boolean;
  handleTicketPrompt(
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: number,
    session: CodexSessionService,
    ticket: Ticket,
  ): Promise<void>;
  handleCanonicalTicketPrompt?(ctx: Context, ticket: Ticket): Promise<void>;
  topicIsAlive(chatId: number, messageThreadId: number): Promise<boolean>;
  sendText(chatId: number, text: string, options?: TextOptions): Promise<unknown>;
  safeReply(ctx: Context, text: string, options?: TextOptions): Promise<void>;
}

export function registerInboxHandlers(deps: RegisterInboxHandlersDeps): { dispose(): Promise<void> } {
  const { bot, config, registry, inbox, jiraComment, topicActivity } = deps;
  const provisioning = (typeof deps.provisioning === "function" ? deps.provisioning() : deps.provisioning) ?? inbox.getProvisioningService?.() ?? new TaskProvisioningService(new TaskProvisioningStore(":memory:"));
  let stopping = false;
  const background = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>): void => {
    background.add(promise);
    void promise.catch(error => console.error(formatTelegramErrorLog("inbox", error))).finally(() => background.delete(promise));
  };
  const pendingBatches = new Map<string, InboxItem[][]>();
  const pendingDuplicateDecisions = new Map<number, { group: InboxItem[]; previousTicketId: number }>();
  const pendingJiraPosts = new Set<number>();
  let nextBatchId = Date.now();
  let nextDuplicateDecisionId = Date.now();
  for (const [key, value] of provisioning.store.listPending<any>()) {
    if (key.startsWith("batch:")) { nextBatchId = Math.max(nextBatchId, Number(key.slice(6)) + 1); if (!value.choice) pendingBatches.set(key.slice(6), value.groups); }
    if (key.startsWith("duplicate:")) { nextDuplicateDecisionId = Math.max(nextDuplicateDecisionId, Number(key.slice(10)) + 1); if (!value.choice) pendingDuplicateDecisions.set(Number(key.slice(10)), value); }
  }

  const ticketKeyboard = (ticket: Pick<Ticket, "id" | "startedAt" | "resolvedAt">): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    for (const button of ticketActionButtons(ticket)) keyboard.text(button.label, button.callbackData);
    return keyboard;
  };
  const duplicateKeyboard = (decisionId: number): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    for (const button of duplicateTicketButtons(decisionId)) keyboard.text(button.label, button.callbackData).row();
    return keyboard;
  };
  const projectContextForTicket = (settings: InboxSettings): string | undefined => {
    const parts: string[] = [];
    if (settings.projectContext && isSafeProjectContext(settings.projectContext)) parts.push(settings.projectContext);
    if (settings.realm) {
      try {
        const realmContext = loadDofboxRealmContext(settings.realm);
        if (realmContext) parts.push(realmContext);
      } catch (error) {
        console.warn(formatTelegramErrorLog("inbox", error));
      }
    }
    return parts.length ? parts.join("\n\n") : undefined;
  };
  const ticketTextOf = (group: InboxItem[]): string => group.map((item) => item.text).filter(Boolean).join("\n\n").trim();
  const forwardAttachments = async (group: InboxItem[], threadId: number): Promise<void> => {
    const first = group[0]!;
    for (const item of group.filter((entry) => entry.hasAttachment)) {
      await bot.api.forwardMessage(first.chatId, first.chatId, item.messageId, { message_thread_id: threadId });
    }
  };
  const appendToTicket = async (ticket: Ticket, group: InboxItem[], text: string, source: string): Promise<void> => {
    const first = group[0]!;
    const card = [`➕ <b>Дополнение к ${escapeHTML(ticketHeading(ticket))}</b>`, `Источник: ${escapeHTML(source)}`, "", escapeHTML(text || "(без текста, см. пересланные сообщения ниже)")].join("\n");
    await deps.sendText(first.chatId, card, { messageThreadId: ticket.workTopicId, fallbackText: `Дополнение к ${ticketHeading(ticket)}. Источник: ${source}` });
    await forwardAttachments(group, ticket.workTopicId);
    const url = topicUrl(first.chatId, ticket.workTopicId);
    await deps.sendText(first.chatId, `Уже заведён <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a> — добавил туда.`, {
      messageThreadId: parseContextKey(first.contextKey).messageThreadId,
      fallbackText: `${ticketHeading(ticket)}: ${url}`,
    });
  };
  const createTicketAttempt = async (group: InboxItem[], options: {
    skipDuplicateCheck?: boolean;
    supersedesId?: number;
    continueTicketId?: number;
  } = {}, progress: InboxAttemptProgress): Promise<void> => {
    const first = group[0];
    if (!first) return;
    const settings = inbox.get(first.contextKey);
    if (!settings) return;
    const text = ticketTextOf(group);
    const source = describeSource(first.message);
    const externalKey = extractTicketKey(text);
    const operationId = `inbox:${first.contextKey}:${group.map(item => item.messageId).sort((a,b) => a-b).join(",")}`;
    const previousOperation = provisioning.store.get(operationId);
    if (previousOperation?.state === "ready") return;
    if (externalKey && !options.skipDuplicateCheck && !previousOperation) {
      const candidates = inbox.listTicketsByKey(first.contextKey, externalKey);
      for (const candidate of candidates) {
        if (candidate.resolvedAt !== undefined || !candidate.workTopicId) continue;
        let reusable: boolean;
        try { reusable = await deps.topicIsAlive(first.chatId, candidate.workTopicId); }
        catch (error) {
          if (!(error instanceof ForumTopicAvailabilityUnknownError)) throw error;
          // The binding chooses the destination; the requested append establishes delivery.
          // Its durable bound intent below prevents replay after an ambiguous response.
          reusable = true;
        }
        if (reusable) {
          progress.outcome = "topic_exists";
          progress.workTopicId = candidate.workTopicId;
          provisioning.store.accept({ operationId, sourceContextKey: first.contextKey, sourceMessageIds: group.map(item => item.messageId), title: ticketTopicName(candidate.id, text, candidate.externalKey), workspace: settings.workspace, launchProfileId: settings.launchProfileId, kind: "inbox", metadata: { ticketId: candidate.id } });
          provisioning.store.patch(operationId, { state: "bound", messageThreadId: candidate.workTopicId });
          try { await appendToTicket(candidate, group, text, source); }
          catch (error) {
            // Several sends may already have succeeded, even if a later one was rejected.
            provisioning.store.patch(operationId, { state: "unknown", failureStage: "ready" });
            progress.outcome = "processing_failed";
            throw error;
          }
          provisioning.store.patch(operationId, { state: "ready" });
          return;
        }
      }
      const previous = candidates[0];
      if (previous) {
        const decisionId = nextDuplicateDecisionId++;
        pendingDuplicateDecisions.set(decisionId, { group, previousTicketId: previous.id });
        provisioning.store.setPending(`duplicate:${decisionId}`, { group, previousTicketId: previous.id });
        const message = `Нашёл ${ticketHeading(previous)}, но активного рабочего топика у него нет.\nПродолжить старый тикет или завести новый?`;
        await deps.sendText(first.chatId, escapeHTML(message), {
          messageThreadId: parseContextKey(first.contextKey).messageThreadId,
          fallbackText: message,
          replyMarkup: duplicateKeyboard(decisionId),
        });
        return;
      }
    }
    const prompt = buildTicketPrompt(settings.template, { source, message: text, projectContext: projectContextForTicket(settings) });
    const continued = options.continueTicketId ? inbox.getTicket(options.continueTicketId) : undefined;
    if (options.continueTicketId && !continued) throw new Error(`Ticket ${options.continueTicketId} no longer exists`);
    const existingTicket = previousOperation?.metadata?.ticketId ? inbox.getTicket(Number(previousOperation.metadata.ticketId)) : undefined;
    const pending = existingTicket ?? continued ?? inbox.createTicket({
      inboxContextKey: first.contextKey,
      externalKey,
      workTopicId: 0,
      workspace: settings.workspace,
      launchProfileId: settings.launchProfileId,
      prompt,
      source,
      supersedesId: options.supersedesId,
    });
    const topicName = ticketTopicName(pending.id, text, pending.externalKey);
    let ticket = pending;
    const result = await provisioning.provision({
      operationId, sourceContextKey: first.contextKey, sourceMessageIds: group.map(item => item.messageId),
      title: topicName, workspace: settings.workspace, launchProfileId: settings.launchProfileId,
      kind: "inbox", metadata: { ticketId: pending.id },
    }, {
      createTopic: async () => {
        progress.outcome = "creation_unknown";
        const topic = await bot.api.createForumTopic(first.chatId, topicName, settings.iconCustomEmojiId ? { icon_custom_emoji_id: settings.iconCustomEmojiId } : undefined);
        return topic.message_thread_id;
      },
      bind: (record) => {
        const threadId = record.messageThreadId!;
        progress.outcome = "topic_exists";
        progress.workTopicId = threadId;
        topicActivity.rememberIdleIcon(first.chatId, threadId, settings.iconCustomEmojiId ?? null);
        ticket = continued ? inbox.continueTicket(continued.id, { workTopicId: threadId, prompt, source })! : pending;
        if (!continued) inbox.attachTopic(ticket.id, threadId);
        (registry.setContextDefaultsDurably ?? registry.setContextDefaults).call(registry, contextKeyFromMessage(first.chatId, threadId), {
          workspace: settings.workspace, launchProfileId: settings.launchProfileId, topicName,
        });
      },
      ready: async (record) => {
        const topic = { message_thread_id: record.messageThreadId! };
        const card = [
          `🎫 <b>${escapeHTML(ticketHeading(ticket))}</b>`,
          `Источник: ${escapeHTML(source)}`,
          `Проект: <code>${escapeHTML(settings.workspace)}</code>`,
          ticket.supersedesId ? `Предыдущий: ${escapeHTML(ticketHeading(inbox.getTicket(ticket.supersedesId) ?? { id: ticket.supersedesId }))}` : undefined,
          "",
          escapeHTML(text || "(без текста, см. пересланные сообщения ниже)"),
        ].filter((line): line is string => line !== undefined).join("\n");
        await deps.sendText(first.chatId, card, { messageThreadId: topic.message_thread_id, fallbackText: `${ticketHeading(ticket)}. Источник: ${source}`, replyMarkup: ticketKeyboard(ticket) });
        await forwardAttachments(group, topic.message_thread_id);
        const url = topicUrl(first.chatId, topic.message_thread_id);
        await deps.sendText(first.chatId, `${continued ? "Тикет продолжен" : "Заведён тикет"} <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a>.`, {
          messageThreadId: parseContextKey(first.contextKey).messageThreadId,
          fallbackText: `${ticketHeading(ticket)}: ${url}`,
        });
      },
    });
    if (result.state !== "ready") {
      progress.outcome = result.messageThreadId ? "topic_exists" : result.state === "unknown" ? "creation_unknown" : "processing_failed";
      progress.workTopicId = result.messageThreadId;
      progress.category = result.failureCategory;
      throw new Error(`Provisioning ${result.state} at ${result.failureStage ?? "create"}`);
    }

  };
  const reportFailure = async (group: InboxItem[], error: unknown, progress: InboxAttemptProgress = { outcome: "processing_failed" }): Promise<void> => {
    console.error(formatTelegramErrorLog("inbox", error));
    const first = group[0];
    if (!first) return;
    const failure = makeInboxFailure(first.contextKey, group.map(item => item.messageId), progress, error);
    if (progress.category) failure.category = progress.category;
    const persisted = inbox.recordFailure(failure);
    const text = inboxFailureText(failure) + (persisted === false ? "\nНе удалось сохранить запись ошибки. Сохрани номера сообщений для проверки после перезапуска." : "");
    try {
      await deps.sendText(first.chatId, escapeHTML(text), {
        messageThreadId: parseContextKey(first.contextKey).messageThreadId, fallbackText: text,
      });
    } catch (noticeError) { console.error(formatTelegramErrorLog("inbox", noticeError)); }
  };
  const createTicket = async (group: InboxItem[], options: Parameters<typeof createTicketAttempt>[1] = {}): Promise<void> => {
    const progress: InboxAttemptProgress = { outcome: "processing_failed" };
    try { await createTicketAttempt(group, options, progress); }
    catch (error) { await reportFailure(group, error, progress); }
    finally { for (const item of group) provisioning.store.setPending(`message:${item.contextKey}:${item.messageId}`, { item, buffered: false }); }
  };
  const createTicketsSequentially = async (groups: InboxItem[][]): Promise<void> => {
    for (const [index, group] of groups.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, INBOX_TOPIC_PAUSE_MS));
      await createTicket(group);
    }
  };
  const askHowToSplit = async (groups: InboxItem[][]): Promise<void> => {
    const first = groups[0]?.[0];
    if (!first) return;
    const batchId = String(nextBatchId++);
    pendingBatches.set(batchId, groups);
    provisioning.store.setPending(`batch:${batchId}`, { groups });
    for (const item of groups.flat()) provisioning.store.setPending(`message:${item.contextKey}:${item.messageId}`, { item, buffered: false });
    const keyboard = new InlineKeyboard().text("Одним тикетом", `inbox_batch:${batchId}:one`).row().text(`По отдельности (${groups.length})`, `inbox_batch:${batchId}:each`).row().text("Отмена", `inbox_batch:${batchId}:cancel`);
    const text = `Переслано сообщений: ${groups.length}. Как их разобрать?`;
    await deps.sendText(first.chatId, escapeHTML(text), { messageThreadId: parseContextKey(first.contextKey).messageThreadId, fallbackText: text, replyMarkup: keyboard });
  };
  const inboxBuffer = new BurstBuffer<InboxItem>(INBOX_QUIET_MS, (items) => {
    const groups = groupBurst(items);
    track((groups.length === 1 ? createTicket(groups[0]) : askHowToSplit(groups)).catch((error) => reportFailure(items, error)));
  });

  const decisionMessages = new Set<string>();
  for (const [key, value] of provisioning.store.listPending<any>()) {
    if (key.startsWith("batch:") || key.startsWith("duplicate:")) {
      for (const item of (value.groups?.flat() ?? value.group ?? []) as InboxItem[]) decisionMessages.add(`message:${item.contextKey}:${item.messageId}`);
    }
  }
  for (const [key, value] of provisioning.store.listPending<{ item?: InboxItem; buffered?: boolean }>()) {
    if (key.startsWith("message:") && value.buffered && value.item && !decisionMessages.has(key)) inboxBuffer.add(value.item.contextKey, value.item);
  }
  for (const [key, value] of provisioning.store.listPending<any>()) {
    if (key.startsWith("batch:") && !value.completed && ["one", "each"].includes(value.choice)) {
      track(createTicketsSequentially(value.choice === "one" ? [value.groups.flat()] : value.groups).then(() => provisioning.store.setPending(key, { ...value, completed: true })));
    }
    if (key.startsWith("duplicate:") && !value.completed && ["reuse", "new"].includes(value.choice)) {
      track(createTicket(value.group, { skipDuplicateCheck: true, ...(value.choice === "reuse" ? { continueTicketId: value.previousTicketId } : { supersedesId: value.previousTicketId }) }).then(() => provisioning.store.setPending(key, { ...value, completed: true })));
    }
  }
  registerInboxCommands(deps);
  bot.callbackQuery(/^inbox_batch:(\d+):(one|each|cancel)$/, async (ctx) => {
    const batchId = ctx.match?.[1];
    const choice = ctx.match?.[2];
    const groups = batchId ? pendingBatches.get(batchId) : undefined;
    if (!groups) { await ctx.answerCallbackQuery({ text: "Выбор устарел. Проверь /inbox status и список топиков." }); return; }
    const first = groups[0]?.[0];
    if (!first || ctx.chat?.id !== first.chatId || ctx.callbackQuery.message?.message_thread_id !== parseContextKey(first.contextKey).messageThreadId) { await ctx.answerCallbackQuery({ text: "Выбор относится к другому Inbox." }); return; }
    provisioning.store.setPending(`batch:${batchId}`, { groups, choice });
    pendingBatches.delete(batchId!);
    const batches = choice === "one" ? [groups.flat()] : groups;
    if (choice === "cancel") {
      await ctx.answerCallbackQuery({ text: "Отменено" }).catch(() => {});
      await ctx.editMessageText("Отменено, тикеты не заводились.").catch(() => {});
      return;
    }
    try {
      await ctx.answerCallbackQuery({ text: "Завожу тикеты..." });
      await ctx.editMessageText(choice === "one" ? "Завожу один тикет..." : `Завожу тикетов: ${batches.length}...`);
    } catch (error) { await reportFailure(groups.flat(), error); }
    await createTicketsSequentially(batches);
    provisioning.store.setPending(`batch:${batchId}`, { groups, choice, completed: true });
  });
  bot.callbackQuery(/^ticket_dup:(\d+):(reuse|new)$/, async (ctx) => {
    const decisionId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const choice = ctx.match?.[2];
    const pending = Number.isNaN(decisionId) ? undefined : pendingDuplicateDecisions.get(decisionId);
    if (!pending || (choice !== "reuse" && choice !== "new")) { await ctx.answerCallbackQuery({ text: "Выбор устарел. Проверь /inbox status и список топиков." }); return; }
    const first = pending.group[0];
    if (!first || ctx.chat?.id !== first.chatId || ctx.callbackQuery.message?.message_thread_id !== parseContextKey(first.contextKey).messageThreadId) { await ctx.answerCallbackQuery({ text: "Выбор относится к другому Inbox." }); return; }
    provisioning.store.setPending(`duplicate:${decisionId}`, { ...pending, choice });
    pendingDuplicateDecisions.delete(decisionId);
    try {
      await ctx.answerCallbackQuery({ text: choice === "reuse" ? "Продолжаю тикет..." : "Создаю новый тикет..." });
    } catch (error) { await reportFailure(pending.group, error); }
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await createTicket(pending.group, { skipDuplicateCheck: true, ...(choice === "reuse" ? { continueTicketId: pending.previousTicketId } : { supersedesId: pending.previousTicketId }) });
    provisioning.store.setPending(`duplicate:${decisionId}`, { ...pending, choice, completed: true });
  });
  bot.callbackQuery(/^ticket_start:(\d+)$/, async (ctx) => {
    const ticketId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const ticket = Number.isNaN(ticketId) ? undefined : inbox.getTicket(ticketId);
    if (!ticket) { await ctx.answerCallbackQuery({ text: "Тикет не найден" }); return; }
    if (ticket.startedAt) { await ctx.answerCallbackQuery({ text: "Разбор уже запускали" }); return; }
    const inboxContext = parseContextKey(ticket.inboxContextKey);
    if (!inboxContext
      || ctx.chat?.id !== inboxContext.chatId
      || ctx.callbackQuery.message?.message_thread_id !== ticket.workTopicId) {
      await ctx.answerCallbackQuery({ text: "Тикет не найден" });
      return;
    }
    const workContextKey = contextKeyFromMessage(inboxContext.chatId, ticket.workTopicId);
    const boundThread = registry.listContexts().find((entry) => entry.contextKey === workContextKey)?.threadId;
    if (boundThread) {
      inbox.markStarted(ticket.id);
      await ctx.answerCallbackQuery({ text: "Разбор уже запускали" });
      await ctx.editMessageReplyMarkup({ reply_markup: ticketKeyboard(inbox.getTicket(ticket.id)!) }).catch(() => {});
      return;
    }
    const currentInbox = inbox.get(ticket.inboxContextKey);
    const launchTicket = {
      ...ticket,
      launchProfileId: currentInbox?.launchProfileId ?? ticket.launchProfileId,
      prompt: prepareTicketLaunchPrompt(ticket.prompt, currentInbox?.realm),
    };
    registry.setContextDefaults(workContextKey, {
      workspace: launchTicket.workspace,
      launchProfileId: launchTicket.launchProfileId,
    });
    if (deps.handleCanonicalTicketPrompt) {
      await deps.handleCanonicalTicketPrompt(ctx, launchTicket);
      await ctx.answerCallbackQuery({ text: "Запускаю разбор..." });
      inbox.markStarted(ticket.id);
      await ctx.editMessageReplyMarkup({ reply_markup: ticketKeyboard(inbox.getTicket(ticket.id)!) }).catch(() => {});
      return;
    }
    const contextSession = await deps.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    if (deps.isBusy(contextSession.contextKey)) { await ctx.answerCallbackQuery({ text: "Дождись окончания текущего прогона" }); return; }
    await ctx.answerCallbackQuery({ text: "Запускаю разбор..." });
    inbox.markStarted(ticket.id);
    await ctx.editMessageReplyMarkup({ reply_markup: ticketKeyboard(inbox.getTicket(ticket.id)!) }).catch(() => {});
    await deps.handleTicketPrompt(ctx, contextSession.contextKey, ctx.chat!.id, contextSession.session, launchTicket);
  });
  bot.callbackQuery(/^jira_post:(\d+)$/, async (ctx) => {
    const ticketId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const ticket = Number.isNaN(ticketId) ? undefined : inbox.getTicket(ticketId);
    const inboxContext = ticket ? parseContextKey(ticket.inboxContextKey) : undefined;
    if (!ticket || !inboxContext || ctx.chat?.id !== inboxContext.chatId || ctx.callbackQuery.message?.message_thread_id !== ticket.workTopicId) {
      await ctx.answerCallbackQuery({ text: "Тикет не найден" }); return;
    }
    if (!jiraComment || !canPostTicketToJira(ticket)) {
      await ctx.answerCallbackQuery({ text: ticket.jiraCommentPostedAt ? "Уже отправлено" : "Jira не настроена" });
      if (ticket.jiraCommentPostedAt) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }
    if (pendingJiraPosts.has(ticket.id)) { await ctx.answerCallbackQuery({ text: "Отправка уже идёт" }); return; }
    pendingJiraPosts.add(ticket.id);
    await ctx.answerCallbackQuery({ text: "Отправляю в Jira..." });
    try {
      const answer = await readTicketAnswer(config.workspace, ticket.id);
      await jiraComment.postComment(ticket.externalKey!, buildJiraComment(answer, topicUrl(inboxContext.chatId, ticket.workTopicId)));
      inbox.markJiraCommentPosted(ticket.id);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      const text = `✅ Комментарий отправлен в ${ticket.externalKey}.`;
      await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text });
    } catch (error) {
      const text = `Не удалось отправить комментарий в Jira: ${friendlyErrorText(error)}`;
      await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text });
    } finally { pendingJiraPosts.delete(ticket.id); }
  });
  bot.callbackQuery(/^ticket_done:(\d+)$/, async (ctx) => {
    const ticketId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const ticket = Number.isNaN(ticketId) ? undefined : inbox.getTicket(ticketId);
    if (!ticket) { await ctx.answerCallbackQuery({ text: "Тикет не найден" }); return; }
    const source = ctx.callbackQuery.message;
    const binding = parseContextKey(ticket.inboxContextKey);
    if (!source || source.chat.id !== binding.chatId || !("message_thread_id" in source)
      || source.message_thread_id !== ticket.workTopicId) {
      await ctx.answerCallbackQuery({ text: "Кнопка относится к другому топику." }); return;
    }
    await ctx.answerCallbackQuery({ text: "Эта кнопка устарела. Открой /task в рабочем топике и заверши задачу из свежей карточки." });
  });
  bot.on("message", async (ctx, next) => {
    const contextKey = contextKeyFromCtx(ctx);
    const message = ctx.message;
    if (stopping || !contextKey || !message || !inbox.get(contextKey) || (message.text ?? "").startsWith("/")) return next();
    const ingressId = `message:${contextKey}:${message.message_id}`;
    if (provisioning.store.pending(ingressId)) return;
    const item: InboxItem = {
      contextKey,
      chatId: ctx.chat.id,
      messageId: message.message_id,
      mediaGroupId: message.media_group_id,
      hasAttachment: hasAttachment(message as unknown as Record<string, unknown>),
      text: (message.text ?? message.caption ?? "").trim(),
      message,
    };
    provisioning.store.setPending(ingressId, { item, buffered: true });
    inboxBuffer.add(contextKey, item);
  });
  return { dispose: async () => { stopping = true; inboxBuffer.dispose(); await Promise.allSettled([...background]); } };
}
