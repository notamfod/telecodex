import { readFile } from "node:fs/promises";
import path from "node:path";

import { Bot, InlineKeyboard, type Context } from "grammy";

import type { CodexSessionService } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import {
  contextKeyFromCtx,
  contextKeyFromMessage,
  parseContextKey,
  type TelegramContextKey,
} from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import {
  DEFAULT_TICKET_TEMPLATE,
  BurstBuffer,
  InboxStore,
  buildTicketPrompt,
  describeSource,
  duplicateTicketButtons,
  extractTicketKey,
  groupBurst,
  groupTicketsByWorkspace,
  hasAttachment,
  parseInboxTemplateCommand,
  ticketActionButtons,
  ticketHeading,
  ticketTopicName,
  validateTicketTemplate,
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
import {
  SentryBridge,
  renderSentryTicketText,
  type SentryBridgeTarget,
  type SentryIssue,
} from "./sentry-bridge.js";
import { extractTopicRename, renamedTicketTopic } from "./topic-naming.js";

const INBOX_QUIET_MS = 2_000;
const INBOX_TOPIC_PAUSE_MS = 3_000;

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
  topicIsAlive(chatId: number, messageThreadId: number): Promise<boolean>;
  sendText(chatId: number, text: string, options?: TextOptions): Promise<unknown>;
  safeReply(ctx: Context, text: string, options?: TextOptions): Promise<void>;
}

export interface InboxHandlerRuntime {
  sentryBridge?: SentryBridge;
}

export function registerInboxHandlers(deps: RegisterInboxHandlersDeps): InboxHandlerRuntime {
  const { bot, config, registry, inbox, jiraComment, topicActivity } = deps;
  const pendingBatches = new Map<string, InboxItem[][]>();
  const pendingDuplicateDecisions = new Map<number, { group: InboxItem[]; previousTicketId: number }>();
  const pendingJiraPosts = new Set<number>();
  let nextBatchId = 1;
  let nextDuplicateDecisionId = 1;
  let lastSentryTicketAt = 0;

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
        console.warn(`Failed to load dofbox realm ${settings.realm}:`, friendlyErrorText(error));
      }
    }
    return parts.length ? parts.join("\n\n") : undefined;
  };
  const ticketTextOf = (group: InboxItem[]): string => group.map((item) => item.text).filter(Boolean).join("\n\n").trim();
  const forwardAttachments = async (group: InboxItem[], threadId: number, ticketId: number): Promise<void> => {
    const first = group[0]!;
    for (const item of group.filter((entry) => entry.hasAttachment)) {
      try {
        await bot.api.forwardMessage(first.chatId, first.chatId, item.messageId, { message_thread_id: threadId });
      } catch (error) {
        console.warn(`Failed to forward message ${item.messageId} into ticket #${ticketId}:`, friendlyErrorText(error));
      }
    }
  };
  const appendToTicket = async (ticket: Ticket, group: InboxItem[], text: string, source: string): Promise<void> => {
    const first = group[0]!;
    const card = [`➕ <b>Дополнение к ${escapeHTML(ticketHeading(ticket))}</b>`, `Источник: ${escapeHTML(source)}`, "", escapeHTML(text || "(без текста, см. пересланные сообщения ниже)")].join("\n");
    await deps.sendText(first.chatId, card, { messageThreadId: ticket.workTopicId, fallbackText: `Дополнение к ${ticketHeading(ticket)}. Источник: ${source}` });
    await forwardAttachments(group, ticket.workTopicId, ticket.id);
    const url = topicUrl(first.chatId, ticket.workTopicId);
    await deps.sendText(first.chatId, `Уже заведён <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a> — добавил туда.`, {
      messageThreadId: parseContextKey(first.contextKey).messageThreadId,
      fallbackText: `${ticketHeading(ticket)}: ${url}`,
    });
  };
  const createTicket = async (group: InboxItem[], options: {
    skipDuplicateCheck?: boolean;
    supersedesId?: number;
    continueTicketId?: number;
    externalKeyOverride?: string;
    sourceOverride?: string;
  } = {}): Promise<void> => {
    const first = group[0];
    if (!first) return;
    const settings = inbox.get(first.contextKey);
    if (!settings) return;
    const text = ticketTextOf(group);
    const source = options.sourceOverride ?? describeSource(first.message);
    const externalKey = options.externalKeyOverride ?? extractTicketKey(text);
    if (externalKey && !options.skipDuplicateCheck) {
      const candidates = inbox.listTicketsByKey(first.contextKey, externalKey);
      for (const candidate of candidates) {
        if (candidate.resolvedAt !== undefined || !candidate.workTopicId) continue;
        if (await deps.topicIsAlive(first.chatId, candidate.workTopicId).catch(() => false)) {
          await appendToTicket(candidate, group, text, source);
          return;
        }
      }
      const previous = candidates[0];
      if (previous) {
        const decisionId = nextDuplicateDecisionId++;
        pendingDuplicateDecisions.set(decisionId, { group, previousTicketId: previous.id });
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
    const pending = continued ?? inbox.createTicket({
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
    let topic;
    try {
      topic = await bot.api.createForumTopic(first.chatId, topicName, settings.iconCustomEmojiId ? { icon_custom_emoji_id: settings.iconCustomEmojiId } : undefined);
    } catch (error) {
      if (!continued) inbox.removeUnattachedTicket(pending.id);
      throw error;
    }
    topicActivity.rememberIdleIcon(first.chatId, topic.message_thread_id, settings.iconCustomEmojiId ?? null);
    const ticket = continued
      ? inbox.continueTicket(continued.id, { workTopicId: topic.message_thread_id, prompt, source })!
      : pending;
    if (!continued) inbox.attachTopic(ticket.id, topic.message_thread_id);
    registry.setContextDefaults(contextKeyFromMessage(first.chatId, topic.message_thread_id), {
      workspace: settings.workspace,
      launchProfileId: settings.launchProfileId,
      topicName,
    });
    const card = [
      `🎫 <b>${escapeHTML(ticketHeading(ticket))}</b>`,
      `Источник: ${escapeHTML(source)}`,
      `Проект: <code>${escapeHTML(settings.workspace)}</code>`,
      ticket.supersedesId ? `Предыдущий: ${escapeHTML(ticketHeading(inbox.getTicket(ticket.supersedesId) ?? { id: ticket.supersedesId }))}` : undefined,
      "",
      escapeHTML(text || "(без текста, см. пересланные сообщения ниже)"),
    ].filter((line): line is string => line !== undefined).join("\n");
    await deps.sendText(first.chatId, card, { messageThreadId: topic.message_thread_id, fallbackText: `${ticketHeading(ticket)}. Источник: ${source}`, replyMarkup: ticketKeyboard(ticket) });
    await forwardAttachments(group, topic.message_thread_id, ticket.id);
    const url = topicUrl(first.chatId, topic.message_thread_id);
    await deps.sendText(first.chatId, `${continued ? "Тикет продолжен" : "Заведён тикет"} <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a>.`, {
      messageThreadId: parseContextKey(first.contextKey).messageThreadId,
      fallbackText: `${ticketHeading(ticket)}: ${url}`,
    });
  };
  const createTicketsSequentially = async (groups: InboxItem[][]): Promise<void> => {
    for (const [index, group] of groups.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, INBOX_TOPIC_PAUSE_MS));
      try { await createTicket(group); } catch (error) { console.error("Failed to create ticket:", friendlyErrorText(error)); }
    }
  };
  const askHowToSplit = async (groups: InboxItem[][]): Promise<void> => {
    const first = groups[0]?.[0];
    if (!first) return;
    const batchId = String(nextBatchId++);
    pendingBatches.set(batchId, groups);
    const keyboard = new InlineKeyboard().text("Одним тикетом", `inbox_batch:${batchId}:one`).row().text(`По отдельности (${groups.length})`, `inbox_batch:${batchId}:each`).row().text("Отмена", `inbox_batch:${batchId}:cancel`);
    const text = `Переслано сообщений: ${groups.length}. Как их разобрать?`;
    await deps.sendText(first.chatId, escapeHTML(text), { messageThreadId: parseContextKey(first.contextKey).messageThreadId, fallbackText: text, replyMarkup: keyboard });
  };
  const inboxBuffer = new BurstBuffer<InboxItem>(INBOX_QUIET_MS, (items) => {
    const groups = groupBurst(items);
    void (groups.length === 1 ? createTicket(groups[0]) : askHowToSplit(groups)).catch((error) => console.error("Inbox burst failed:", friendlyErrorText(error)));
  });

  const createSentryTicket = async (issue: SentryIssue, target: SentryBridgeTarget, project: string): Promise<void> => {
    const settings = inbox.get(target.inboxContextKey);
    if (!settings) throw new Error(`Inbox ${target.inboxContextKey} is not configured`);
    if (settings.workspace !== target.workspace) throw new Error(`Inbox ${target.inboxContextKey} workspace mismatch: ${settings.workspace}`);
    const parsed = parseContextKey(target.inboxContextKey);
    if (!parsed.messageThreadId || !Number.isFinite(parsed.chatId)) throw new Error(`Inbox ${target.inboxContextKey} is not a forum topic`);
    for (const existing of inbox.listTicketsByKey(target.inboxContextKey, issue.shortId)) {
      if (existing.workTopicId && await deps.topicIsAlive(parsed.chatId, existing.workTopicId).catch(() => false)) {
        return;
      }
    }
    const waitMs = INBOX_TOPIC_PAUSE_MS - (Date.now() - lastSentryTicketAt);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastSentryTicketAt = Date.now();
    await createTicket([{ contextKey: target.inboxContextKey, chatId: parsed.chatId, messageId: 0, hasAttachment: false, text: renderSentryTicketText(issue), message: {} }], {
      skipDuplicateCheck: true,
      externalKeyOverride: issue.shortId,
      sourceOverride: `Sentry project ${project}`,
    });
  };
  const sentryBridge = config.sentryBridge ? new SentryBridge({
    ...config.sentryBridge,
    statePath: path.join(config.workspace, ".telecodex", "sentry-bridge.json"),
    createTicket: createSentryTicket,
  }) : undefined;

  registerInboxCommands(deps, sentryBridge);
  bot.callbackQuery(/^inbox_batch:(\d+):(one|each|cancel)$/, async (ctx) => {
    const batchId = ctx.match?.[1];
    const choice = ctx.match?.[2];
    const groups = batchId ? pendingBatches.get(batchId) : undefined;
    if (!groups) { await ctx.answerCallbackQuery({ text: "Устарело, перешли сообщения заново" }); return; }
    pendingBatches.delete(batchId!);
    if (choice === "cancel") { await ctx.answerCallbackQuery({ text: "Отменено" }); await ctx.editMessageText("Отменено, тикеты не заводились."); return; }
    await ctx.answerCallbackQuery({ text: "Завожу тикеты..." });
    const batches = choice === "one" ? [groups.flat()] : groups;
    await ctx.editMessageText(choice === "one" ? "Завожу один тикет..." : `Завожу тикетов: ${batches.length}...`);
    await createTicketsSequentially(batches);
  });
  bot.callbackQuery(/^ticket_dup:(\d+):(reuse|new)$/, async (ctx) => {
    const decisionId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const choice = ctx.match?.[2];
    const pending = Number.isNaN(decisionId) ? undefined : pendingDuplicateDecisions.get(decisionId);
    if (!pending || (choice !== "reuse" && choice !== "new")) { await ctx.answerCallbackQuery({ text: "Выбор устарел, перешли сообщение заново" }); return; }
    pendingDuplicateDecisions.delete(decisionId);
    await ctx.answerCallbackQuery({ text: choice === "reuse" ? "Продолжаю тикет..." : "Создаю новый тикет..." });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await createTicket(pending.group, { skipDuplicateCheck: true, ...(choice === "reuse" ? { continueTicketId: pending.previousTicketId } : { supersedesId: pending.previousTicketId }) });
  });
  bot.callbackQuery(/^ticket_start:(\d+)$/, async (ctx) => {
    const ticketId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const ticket = Number.isNaN(ticketId) ? undefined : inbox.getTicket(ticketId);
    if (!ticket) { await ctx.answerCallbackQuery({ text: "Тикет не найден" }); return; }
    if (ticket.startedAt) { await ctx.answerCallbackQuery({ text: "Разбор уже запускали" }); return; }
    const contextSession = await deps.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    if (deps.isBusy(contextSession.contextKey)) { await ctx.answerCallbackQuery({ text: "Дождись окончания текущего прогона" }); return; }
    await ctx.answerCallbackQuery({ text: "Запускаю разбор..." });
    inbox.markStarted(ticket.id);
    await ctx.editMessageReplyMarkup({ reply_markup: ticketKeyboard(inbox.getTicket(ticket.id)!) }).catch(() => {});
    await deps.handleTicketPrompt(ctx, contextSession.contextKey, ctx.chat!.id, contextSession.session, ticket);
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
    if (!inbox.markResolved(ticket.id)) { await ctx.answerCallbackQuery({ text: "Тикет уже отмечен решённым" }); return; }
    await ctx.answerCallbackQuery({ text: "Тикет решён" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const inboxContext = parseContextKey(ticket.inboxContextKey);
    const url = topicUrl(inboxContext.chatId, ticket.workTopicId);
    await deps.sendText(inboxContext.chatId, `✅ <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a> решён.`, {
      messageThreadId: inboxContext.messageThreadId,
      fallbackText: `${ticketHeading(ticket)} решён: ${url}`,
    });
    await bot.api.closeForumTopic(inboxContext.chatId, ticket.workTopicId);
  });
  bot.on("message", async (ctx, next) => {
    const contextKey = contextKeyFromCtx(ctx);
    const message = ctx.message;
    if (!contextKey || !message || !inbox.get(contextKey) || (message.text ?? "").startsWith("/")) return next();
    inboxBuffer.add(contextKey, {
      contextKey,
      chatId: ctx.chat.id,
      messageId: message.message_id,
      mediaGroupId: message.media_group_id,
      hasAttachment: hasAttachment(message as unknown as Record<string, unknown>),
      text: (message.text ?? message.caption ?? "").trim(),
      message,
    });
  });
  return { sentryBridge };
}

function registerInboxCommands(deps: RegisterInboxHandlersDeps, sentryBridge?: SentryBridge): void {
  const { bot, config, registry, inbox } = deps;
  const usage = [
    "Использование:", "/inbox on [путь] — сделать этот топик инбоксом", "/inbox off — выключить",
    "/inbox status — показать настройки", "/inbox template — показать шаблон", "/inbox template set <текст> — изменить шаблон",
    "/inbox template reset — вернуть шаблон по умолчанию", "/inbox context — показать контекст проекта",
    "/inbox context set <текст> — изменить контекст", "/inbox context reset — очистить контекст",
    "/inbox realm <имя|off> — подключить безопасный контекст dofbox",
  ].join("\n");
  bot.command("inbox", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) return;
    const args = (ctx.message?.text ?? "").replace(/^\/inbox(?:@\w+)?\s*/, "").trim();
    const [action, ...rest] = args.split(/\s+/);
    const settings = inbox.get(contextKey);
    const templateCommand = parseInboxTemplateCommand(args);
    if (templateCommand) {
      if (!settings) { await deps.safeReply(ctx, escapeHTML("Сначала включи этот инбокс: /inbox on [путь]")); return; }
      if (templateCommand.action === "show") { await deps.safeReply(ctx, `<b>Шаблон тикета:</b>\n<pre>${escapeHTML(settings.template)}</pre>`, { fallbackText: `Шаблон тикета:\n${settings.template}` }); return; }
      const template = templateCommand.action === "reset" ? DEFAULT_TICKET_TEMPLATE : templateCommand.template;
      const validationError = validateTicketTemplate(template);
      if (validationError) { await deps.safeReply(ctx, escapeHTML(validationError), { fallbackText: validationError }); return; }
      inbox.setTemplate(contextKey, template);
      const text = templateCommand.action === "reset" ? "Шаблон тикета сброшен." : "Шаблон тикета обновлён.";
      await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text }); return;
    }
    if (action === "context") {
      if (!settings) { await deps.safeReply(ctx, escapeHTML("Сначала включи этот инбокс: /inbox on [путь]")); return; }
      const contextSet = /^context\s+set(?:\s+([\s\S]*))?$/.exec(args);
      if (contextSet) {
        const projectContext = (contextSet[1] ?? "").replaceAll("\\n", "\n").trim();
        if (!isSafeProjectContext(projectContext)) { await deps.safeReply(ctx, escapeHTML("Контекст пуст или содержит секретные данные.")); return; }
        inbox.setProjectContext(contextKey, projectContext);
        await deps.safeReply(ctx, escapeHTML("Контекст проекта обновлён.")); return;
      }
      if (rest[0] === "reset") { inbox.setProjectContext(contextKey, undefined); await deps.safeReply(ctx, escapeHTML("Контекст проекта очищен.")); return; }
      if (rest.length === 0) { const projectContext = settings.projectContext ?? "(не задан)"; await deps.safeReply(ctx, `<b>Контекст проекта:</b>\n<pre>${escapeHTML(projectContext)}</pre>`, { fallbackText: `Контекст проекта:\n${projectContext}` }); return; }
      await deps.safeReply(ctx, escapeHTML(usage), { fallbackText: usage }); return;
    }
    if (action === "realm") {
      if (!settings) { await deps.safeReply(ctx, escapeHTML("Сначала включи этот инбокс: /inbox on [путь]")); return; }
      const realmName = rest[0];
      if (realmName === "off") { inbox.setRealm(contextKey, undefined); await deps.safeReply(ctx, escapeHTML("Dofbox realm отключён.")); return; }
      if (!realmName || rest.length !== 1) { await deps.safeReply(ctx, escapeHTML(usage), { fallbackText: usage }); return; }
      try {
        const preview = loadDofboxRealmContext(realmName);
        inbox.setRealm(contextKey, realmName);
        await deps.safeReply(ctx, `<b>Dofbox realm:</b> <code>${escapeHTML(realmName)}</code>\n<pre>${escapeHTML(preview)}</pre>`, { fallbackText: `Dofbox realm: ${realmName}\n${preview}` });
      } catch (error) { const text = `Не удалось загрузить realm ${realmName}: ${friendlyErrorText(error)}`; await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text }); }
      return;
    }
    if (action === "off") { const text = inbox.disable(contextKey) ? "Инбокс выключен, сообщения снова идут в сессию этого топика." : "Этот топик и так не инбокс."; await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text }); return; }
    if (action === "on") {
      const workspace = rest.join(" ").trim() || registry.listContexts().find((entry) => entry.contextKey === contextKey)?.workspace || config.workspace;
      let projectContext = settings?.projectContext;
      try {
        const contextFile = (await readFile(path.join(workspace, ".telecodex", "context.md"), "utf8")).trim();
        if (contextFile && isSafeProjectContext(contextFile)) projectContext = contextFile;
        else if (contextFile) console.warn(`Skipped secret-bearing project context for ${workspace}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Failed to load project context for ${workspace}:`, friendlyErrorText(error)); }
      inbox.enable(contextKey, { workspace, launchProfileId: config.defaultLaunchProfileId, template: settings?.template ?? DEFAULT_TICKET_TEMPLATE, iconCustomEmojiId: settings?.iconCustomEmojiId, projectContext, realm: settings?.realm });
      const html = ["<b>Инбокс включён.</b>", `Проект: <code>${escapeHTML(workspace)}</code>`, `Профиль запуска тикетов: <code>${escapeHTML(config.defaultLaunchProfileId)}</code>`, "", "Пересылай сюда обращения — на каждое заведу отдельный топик."].join("\n");
      await deps.safeReply(ctx, html, { fallbackText: "Инбокс включён." }); return;
    }
    if (action === "status" || action === "") {
      if (!settings) { const text = `Этот топик не инбокс.\n\n${usage}`; await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text }); return; }
      const html = ["<b>Инбокс включён.</b>", `Проект: <code>${escapeHTML(settings.workspace)}</code>`, `Профиль: <code>${escapeHTML(settings.launchProfileId ?? "по умолчанию")}</code>`].join("\n");
      await deps.safeReply(ctx, html, { fallbackText: "Инбокс включён." }); return;
    }
    await deps.safeReply(ctx, escapeHTML(usage), { fallbackText: usage });
  });
  bot.command("tickets", async (ctx) => {
    const unresolved = inbox.listUnresolved();
    if (!unresolved.length) { await deps.safeReply(ctx, escapeHTML("Открытых тикетов нет."), { fallbackText: "Открытых тикетов нет." }); return; }
    const lines = ["<b>Открытые тикеты</b>"];
    for (const group of groupTicketsByWorkspace(unresolved)) {
      lines.push("", `📁 <code>${escapeHTML(group.workspace)}</code>`);
      for (const ticket of group.tickets) {
        const chatId = parseContextKey(ticket.inboxContextKey).chatId;
        const label = escapeHTML(ticketHeading(ticket));
        const started = ticket.startedAt === undefined ? "" : " · разбор запущен";
        lines.push(ticket.workTopicId ? `• <a href="${topicUrl(chatId, ticket.workTopicId)}">${label}</a>${started}` : `• ${label}${started}`);
      }
    }
    await deps.safeReply(ctx, lines.join("\n"), { fallbackText: unresolved.map((ticket) => ticketHeading(ticket)).join("\n") });
  });
  bot.command("title", async (ctx) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id;
    const ticket = threadId ? inbox.findTicketByTopic(threadId) : undefined;
    if (!chatId || !threadId || !ticket) { await deps.safeReply(ctx, escapeHTML("Команда /title работает только внутри топика тикета.")); return; }
    const requested = (ctx.message?.text ?? "").replace(/^\/title(?:@\w+)?\s*/, "").trim();
    const extracted = extractTopicRename(`TOPIC: ${requested}\n\n`);
    if (!extracted) { await deps.safeReply(ctx, escapeHTML("Укажи безопасное непустое название: /title <текст>")); return; }
    const topicName = renamedTicketTopic(ticket, extracted.title);
    try { await bot.api.editForumTopic(chatId, threadId, { name: topicName }); }
    catch (error) { if (!/TOPIC_NOT_MODIFIED/i.test(friendlyErrorText(error))) throw error; }
    inbox.setTopicTitle(ticket.id, extracted.title);
    const text = `Топик переименован: ${topicName}`;
    await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text });
  });
  bot.command("sentry", async (ctx) => {
    if (!sentryBridge) { await deps.safeReply(ctx, escapeHTML("Sentry bridge не настроен.")); return; }
    const rawHours = String(ctx.match ?? "").trim();
    const hours = rawHours ? Number(rawHours) : 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) { await deps.safeReply(ctx, "Использование: <code>/sentry [hours]</code>, от 1 до 720", { fallbackText: "Использование: /sentry [hours], от 1 до 720" }); return; }
    const result = await sentryBridge.run(hours);
    const lines = [`<b>Sentry за ${hours} ч.</b>`, `Получено: ${result.fetched}`, `Создано тикетов: ${result.created}`, `Уже обработано: ${result.skipped}`, result.failures.length ? `Ошибки: ${escapeHTML(result.failures.join("; "))}` : "Ошибок нет."];
    await deps.safeReply(ctx, lines.join("\n"), { fallbackText: lines.map((line) => line.replace(/<[^>]+>/g, "")).join("\n") });
  });
}
