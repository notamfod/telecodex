import { escapeHTML } from "./format.js";
import { topicUrl } from "./projects.js";
import type { RunningTask, StatusSnapshot, WaitingOn } from "./status-board.js";
import { containsSecret, workspaceLabel } from "./topic-sync.js";

const MAX_LABEL_LENGTH = 40;
export const STATUS_BOARD_BUTTON_LIMIT = 8;
const HIDDEN_LABEL = "(скрыто)";

export type BoardButton =
  | { text: string; url: string; callbackData?: never }
  | { text: string; callbackData: string; url?: never };

export interface RenderedMessage {
  html: string;
  buttons: BoardButton[];
}

export interface RenderedBoard {
  /** The board without its timestamp, so an unchanged board compares equal. */
  body: string;
  buttons: BoardButton[];
}

export function renderStatusBoard(snapshot: StatusSnapshot, chatId: number): RenderedBoard {
  const waiting = snapshot.running.reduce(
    (count, task) => count + Number(Boolean(task.waitingOn))
      + task.children.filter((child) => child.waitingOn).length,
    0,
  );
  const heading = [
    `📌 <b>TeleCodex</b> · активны ${snapshot.running.length}`,
    waiting > 0 ? `ждут ${waiting}` : undefined,
    `за 24ч ${snapshot.recentThreadCount}`,
    `телеграм ${snapshot.telegramActive}/${snapshot.limit}`,
    snapshot.queued.length > 0 ? `${snapshot.queued.length} в очереди` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const sections: string[] = [heading];

  if (snapshot.running.length > 0) {
    sections.push([
      "<b>Сейчас</b>",
      ...snapshot.running.flatMap((task) => [
        `${marker(task.waitingOn)} ${rowText(task)} · ${elapsed(snapshot.now - task.since)}`
        + ` · ${escapeHTML(task.source)}${waitingNote(task.waitingOn)}`,
        ...task.children.map(
          (child) =>
            `   ↳ ${escapeHTML(label(child.label))} · ${elapsed(snapshot.now - child.since)}`
            + waitingNote(child.waitingOn),
        ),
      ]),
    ].join("\n"));
  }

  if (snapshot.running.length === 0) {
    sections.push("Сейчас ничего не выполняется.");
  }

  if (snapshot.queued.length > 0) {
    sections.push([
      "<b>Очередь</b>",
      ...snapshot.queued.map((row) => `🕓 ${rowText(row)}`),
    ].join("\n"));
  }

  if (snapshot.recent.length > 0) {
    sections.push([
      "<b>Недавно</b>",
      ...snapshot.recent.map((row) => `${row.ok ? "✅" : "❌"} ${rowText(row)} · ${clock(row.finishedAt)}`),
    ].join("\n"));
  }

  if (snapshot.recentThreads.length > 0) {
    const hidden = snapshot.recentThreadCount - snapshot.recentThreads.length;
    sections.push([
      "<b>Последние 24 часа</b>",
      ...snapshot.recentThreads.map(
        (row, index) => `${index + 1}. ${rowText(row)} · ${elapsed(snapshot.now - row.updatedAt)}`
          + ` · ${escapeHTML(row.source)}`,
      ),
      ...(hidden > 0 ? [`… ещё ${hidden}`] : []),
    ].join("\n"));
  }

  sections.push([
    "<b>Система</b>",
    snapshot.codexAvailable ? "🟢 Codex app-server" : "🔴 Codex app-server недоступен",
    snapshot.failedJobs24h > 0
      ? `⚠️ Задачи · ошибок ${snapshot.failedJobs24h} за 24ч`
      : "🟢 Задачи · без ошибок за 24ч",
  ].join("\n"));

  const actionable = [...snapshot.running, ...snapshot.recentThreads];

  return {
    body: sections.join("\n\n"),
    buttons: actionable
      .filter((task): task is typeof task & { threadId: string } => Boolean(task.threadId))
      .slice(0, STATUS_BOARD_BUTTON_LIMIT)
      .map((task) => actionButton(task, chatId)),
  };
}

export function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function marker(waitingOn: WaitingOn | undefined): string {
  return waitingOn ? "🟡" : "🟢";
}

function waitingNote(waitingOn: WaitingOn | undefined): string {
  if (!waitingOn) return "";
  return waitingOn === "approval" ? " · ждёт подтверждения" : " · ждёт ответа";
}

function rowText(row: { label: string; workspace: string }): string {
  return `${escapeHTML(workspaceLabel(row.workspace))} · ${escapeHTML(label(row.label))}`;
}

function label(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "(без названия)";
  if (containsSecret(text)) return HIDDEN_LABEL;
  const characters = [...text];
  return characters.length <= MAX_LABEL_LENGTH
    ? text
    : `${characters.slice(0, MAX_LABEL_LENGTH - 1).join("")}…`;
}

function actionButton(
  row: { threadId: string; label: string; workspace: string; messageThreadId?: number },
  chatId: number,
): BoardButton {
  const text = buttonLabel(
    `${row.messageThreadId === undefined ? "＋" : "↗"} ${workspaceLabel(row.workspace)} · ${label(row.label)}`,
  );
  return row.messageThreadId === undefined
    ? { text, callbackData: `projopen:${row.threadId}` }
    : { text, url: topicUrl(chatId, row.messageThreadId) };
}

function buttonLabel(raw: string): string {
  const characters = [...raw];
  return characters.length <= 60 ? raw : `${characters.slice(0, 59).join("")}…`;
}

function elapsed(durationMs: number): string {
  const totalMinutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (totalMinutes < 1) return "меньше минуты";
  if (totalMinutes < 60) return `${totalMinutes}м`;
  return `${Math.floor(totalMinutes / 60)}ч ${totalMinutes % 60}м`;
}
