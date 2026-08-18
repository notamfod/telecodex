import { escapeHTML } from "./format.js";
import {
  groupTicketsByWorkspace,
  ticketHeading,
  type Ticket,
} from "./inbox.js";
import { parseContextKey } from "./context-key.js";
import { topicUrl } from "./projects.js";
import {
  tokenBudgetStatus,
  type UsageAggregate,
} from "./usage-store.js";

export interface DigestRenderOptions {
  now?: number;
  weeklyLimit?: number;
}

export interface DigestMessage {
  html: string;
  plain: string;
}

export function renderInboxDigest(
  tickets: Ticket[],
  weeklyUsage: UsageAggregate[],
  options: DigestRenderOptions = {},
): DigestMessage {
  const now = options.now ?? Date.now();
  const unresolved = tickets.filter((ticket) => ticket.resolvedAt === undefined);
  const html = ["<b>Утренний дайджест TeleCodex</b>"];
  const plain = ["Утренний дайджест TeleCodex"];

  if (unresolved.length === 0) {
    html.push("", "Открытых тикетов нет.");
    plain.push("", "Открытых тикетов нет.");
  } else {
    html.push("", "<b>Открытые тикеты</b>");
    plain.push("", "Открытые тикеты");
    for (const group of groupTicketsByWorkspace(unresolved)) {
      html.push("", `📁 <code>${escapeHTML(group.workspace)}</code>`);
      plain.push("", `📁 ${group.workspace}`);
      for (const item of group.tickets) {
        const chatId = parseContextKey(item.inboxContextKey).chatId;
        const label = ticketHeading(item);
        const age = formatTicketAge(item.createdAt, now);
        const state = item.startedAt === undefined ? "⏸ ожидает запуска" : "▶️ разбор запущен";
        const linkedLabel = item.workTopicId
          ? `<a href="${topicUrl(chatId, item.workTopicId)}">${escapeHTML(label)}</a>`
          : escapeHTML(label);
        html.push(`• ${linkedLabel} · ${age} · ${state}`);
        plain.push(`• ${label} · ${age} · ${state}`);
      }
    }
  }

  html.push("", "<b>Токены за 7 дней</b>");
  plain.push("", "Токены за 7 дней");
  if (weeklyUsage.length === 0) {
    html.push("Нет данных.");
    plain.push("Нет данных.");
  } else {
    for (const usage of weeklyUsage) {
      const summary = usageSummary(usage);
      html.push(`• <code>${escapeHTML(usage.workspace)}</code> · ${summary}`);
      plain.push(`• ${usage.workspace} · ${summary}`);
    }
  }

  const weeklyTotal = weeklyUsage.reduce((sum, usage) => sum + usage.totalTokens, 0);
  if (options.weeklyLimit !== undefined) {
    const status = tokenBudgetStatus(weeklyTotal, options.weeklyLimit);
    if (status === "warning") {
      const percentage = Math.floor((weeklyTotal / options.weeklyLimit) * 100);
      const warning = `⚠️ Использовано ${percentage}% недельного лимита (${formatNumber(weeklyTotal)} / ${formatNumber(options.weeklyLimit)}).`;
      html.push("", warning);
      plain.push("", warning);
    } else if (status === "exceeded") {
      const warning = `🚨 Недельный лимит исчерпан (${formatNumber(weeklyTotal)} / ${formatNumber(options.weeklyLimit)}).`;
      html.push("", warning);
      plain.push("", warning);
    }
  }

  return { html: html.join("\n"), plain: plain.join("\n") };
}

export async function sendInboxDigest(options: {
  token: string;
  chatId: number;
  topicId?: number;
  html: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const chunk of splitDigest(options.html)) {
    const response = await fetchImpl(`https://api.telegram.org/bot${options.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: options.chatId,
        ...(options.topicId === undefined ? {} : { message_thread_id: options.topicId }),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        text: chunk,
      }),
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
    }
  }
}

function splitDigest(html: string, limit = 3_900): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of html.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= limit) {
      current = line;
      continue;
    }
    for (let offset = 0; offset < line.length; offset += limit) {
      const piece = line.slice(offset, offset + limit);
      if (piece.length === limit) chunks.push(piece);
      else current = piece;
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function formatTicketAge(createdAt: number, now: number): string {
  const ageMs = Math.max(0, now - createdAt);
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return "меньше часа";
  if (hours < 24) return `${hours} ч.`;
  return `${Math.floor(hours / 24)} дн.`;
}

function usageSummary(usage: UsageAggregate): string {
  return [
    `вход: ${formatNumber(usage.inputTokens)}`,
    `кэш: ${formatNumber(usage.cachedInputTokens)}`,
    `выход: ${formatNumber(usage.outputTokens)}`,
    `Всего: ${formatNumber(usage.totalTokens)}`,
    `ходов: ${usage.turns}`,
  ].join(" · ");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
