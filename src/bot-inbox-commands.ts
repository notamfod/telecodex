import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RegisterInboxHandlersDeps } from "./bot-inbox.js";
import { contextKeyFromCtx, parseContextKey } from "./context-key.js";
import { inboxFailureText } from "./inbox-failures.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import { DEFAULT_TICKET_TEMPLATE, groupTicketsByWorkspace, parseInboxTemplateCommand, ticketHeading, validateTicketTemplate } from "./inbox.js";
import { isSafeProjectContext, loadDofboxRealmContext } from "./project-context.js";
import { topicUrl } from "./projects.js";
import { formatTelegramErrorLog, isTelegramTopicNotModified } from "./telegram-error-log.js";
import { extractTopicRename, renamedTicketTopic } from "./topic-naming.js";

export function registerInboxCommands(deps: RegisterInboxHandlersDeps): void {
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
        else if (contextFile) console.warn("Skipped secret-bearing project context");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(formatTelegramErrorLog("inbox", error)); }
      inbox.enable(contextKey, { workspace, launchProfileId: config.defaultLaunchProfileId, template: settings?.template ?? DEFAULT_TICKET_TEMPLATE, iconCustomEmojiId: settings?.iconCustomEmojiId, projectContext, realm: settings?.realm });
      const html = ["<b>Инбокс включён.</b>", `Проект: <code>${escapeHTML(workspace)}</code>`, `Профиль запуска тикетов: <code>${escapeHTML(config.defaultLaunchProfileId)}</code>`, "", "Пересылай сюда обращения — на каждое заведу отдельный топик."].join("\n");
      await deps.safeReply(ctx, html, { fallbackText: "Инбокс включён." }); return;
    }
    if (action === "status" || action === "") {
      if (!settings) { const text = `Этот топик не инбокс.\n\n${usage}`; await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text }); return; }
      const failures = inbox.listFailures(contextKey).slice(0, 3).map(inboxFailureText).join("\n\n");
      const operations = ((typeof deps.provisioning === "function" ? deps.provisioning() : deps.provisioning) ?? inbox.getProvisioningService?.())?.store.list(contextKey).slice(-5).map(record => `Сообщения ${record.sourceMessageIds.join(", ")}: ${record.state}${record.messageThreadId ? ` · ${topicUrl(parseContextKey(contextKey).chatId, record.messageThreadId)}` : ""}`).join("\n") ?? "";
      const html = ["<b>Инбокс включён.</b>", `Проект: <code>${escapeHTML(settings.workspace)}</code>`, `Профиль: <code>${escapeHTML(settings.launchProfileId ?? "по умолчанию")}</code>`, operations, failures ? `\nПоследние ошибки (требуют проверки):\n${escapeHTML(failures)}` : ""].filter(Boolean).join("\n");
      await deps.safeReply(ctx, html, { fallbackText: ["Инбокс включён.", failures].filter(Boolean).join("\n") }); return;
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
    try {
      if (deps.renameTopicManually) await deps.renameTopicManually(chatId, threadId, topicName);
      else await bot.api.editForumTopic(chatId, threadId, { name: topicName });
    }
    catch (error) { if (!isTelegramTopicNotModified(error)) throw error; }
    inbox.setTopicTitle(ticket.id, extracted.title);
    await deps.onManualTopicTitle?.(chatId, threadId, topicName);
    const text = `Топик переименован: ${topicName}`;
    await deps.safeReply(ctx, escapeHTML(text), { fallbackText: text });
  });
}
