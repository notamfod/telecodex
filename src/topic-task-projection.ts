import path from "node:path";
import { escapeHTML } from "./format.js";
import { containsSecret } from "./topic-sync.js";
import type { TelegramJobStatusProjection } from "./telegram-status-projection.js";
import type { TopicTaskAgentState, TopicTaskRecord } from "./topic-task-store.js";

export function taskAgentState(projection: TelegramJobStatusProjection, waitingOn?: "input" | "approval"): TopicTaskAgentState {
  if (projection.phase !== "terminal") {
    if (waitingOn === "approval") return "needs_approval";
    if (waitingOn === "input") return "needs_input";
    if (projection.activity?.kind === "waiting") return "unknown";
  }
  switch (projection.state) {
    case "accepted": return "accepted";
    case "queued": case "dispatching_not_sent": return "queued";
    case "running": return "running";
    case "stalled": return "stalled";
    case "delivering": return "delivering";
    case "terminal_delivered": return projection.isDone ? "result_ready" : "unknown";
    case "terminal_aborted": return "idle";
    case "terminal_failed": case "delivery_failed": return "failed";
    default: return "unknown";
  }
}

export function safeTaskText(value: string, limit = 128): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized) || containsSecret(normalized)) {
    throw new Error("Название должно быть непустым и не содержать секретов");
  }
  return [...normalized].slice(0, limit).join("");
}

export function taskTopicName(title: string, workspace: string, ticketKey?: string): string {
  const prefix = safeTaskText(ticketKey || path.basename(workspace) || "Задача", 40);
  const text = safeTaskText(title);
  const body = text.startsWith(`${prefix} `) ? text.slice(prefix.length).replace(/^[ ·]+/u, "") : text;
  return safeTaskText(`${prefix} · ${body || "Задача"}`);
}

const labels: Record<TopicTaskAgentState, string> = {
  idle: "Готова к продолжению", accepted: "Запрос принят", queued: "В очереди", running: "В работе",
  needs_input: "Нужен твой ответ", needs_approval: "Нужно твоё разрешение", stalled: "Нужно проверить прогон",
  delivering: "Доставляю результат", result_ready: "Результат готов", failed: "Не удалось завершить прогон",
  unknown: "Состояние требует проверки",
};

export function renderTopicTask(task: TopicTaskRecord): { html: string; plain: string } {
  const lines = [task.title, `Проект: ${path.basename(task.workspace) || task.workspace}`,
    task.lifecycle === "completed" ? "Задача завершена" : labels[task.agentState]];
  if (task.presence !== "open") lines.push(task.presence === "closed" ? "Топик закрыт для переписки"
    : task.presence === "missing" ? "Топик недоступен" : "Доступность топика не подтверждена");
  if (task.lastEventAt !== null) lines.push(`Подтверждено: ${new Date(task.lastEventAt).toISOString().replace("T", " ").slice(0, 19)} UTC`);
  else lines.push("Подтверждённых событий прогона пока нет");
  if (task.agentState === "needs_input" || task.agentState === "needs_approval") {
    lines.push("Открой запрос агента в переписке или в клиенте, где начат прогон.");
  }
  if (task.pinState === "forbidden") lines.push("Не удалось закрепить карточку: её можно закрепить вручную.");
  if (task.pinState === "unknown") lines.push("Закрепление не подтверждено. Проверь закрепы топика.");
  const resultUrl = task.lastResultMessageId && String(task.chatId).startsWith("-100")
    ? `https://t.me/c/${String(task.chatId).slice(4)}/${task.lastResultMessageId}` : null;
  const html = [`<b>${escapeHTML(lines[0])}</b>`, ...lines.slice(1).map(escapeHTML)];
  if (resultUrl) html.push(`<a href="${resultUrl}">Последний подтверждённый результат</a>`);
  else html.push("Ссылки на подтверждённый результат пока нет");
  return { html: html.join("\n"), plain: [...lines, resultUrl ? `Последний подтверждённый результат: ${resultUrl}` : "Ссылки на подтверждённый результат пока нет"].join("\n") };
}
