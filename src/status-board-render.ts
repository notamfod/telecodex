import { escapeHTML } from "./format.js";
import type { StatusSnapshot, WaitingOn } from "./status-board-snapshot.js";
import { containsSecret, workspaceLabel } from "./topic-sync.js";

const MAX_LABEL_LENGTH = 40;
const TELEGRAM_MESSAGE_UTF16_LIMIT = 4096;
const MAX_ACTIVE_ROWS = 5;
const MAX_QUEUE_ROWS = 3;
const MAX_ATTENTION_ROWS = 7;
const MAX_ROW_COMPONENT_HTML_UNITS = 72;
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

export function renderMiniAppLauncher(launchUrl: string): RenderedBoard {
  return {
    body: "📊 <b>TeleCodex Dashboard</b>\n\nСтатусы и действия теперь доступны в Mini App.",
    buttons: [{ text: "Открыть Dashboard", url: launchUrl }],
  };
}

export function renderStatusBoard(
  snapshot: StatusSnapshot,
  _chatId: number,
  miniAppLaunchUrl?: string,
): RenderedBoard {
  const waiting = snapshot.running.reduce(
    (count, task) => count + Number(Boolean(task.waitingOn))
      + task.children.filter((child) => child.waitingOn).length,
    0,
  );
  const heading = [
    `📌 <b>TeleCodex</b> · активны ${snapshot.running.length}`,
    `ждёт ${waiting}`,
    `в очереди ${snapshot.queued.length}`,
    `ошибок ${snapshot.failedJobs24h}`,
  ].join(" · ");

  const sections: string[] = [];
  const waitingRoots = snapshot.running.filter((task) => task.waitingOn);

  if (waitingRoots.length > 0) {
    sections.push(section(
      "Требуют внимания",
      waitingRoots,
      MAX_ATTENTION_ROWS,
      (task, index) => `${index + 1}. ${rowText(task)} · ${waitingText(task.waitingOn)}`
        + ` · ${elapsed(snapshot.now - task.since)}`,
    ));
  }

  if (snapshot.running.length > 0) {
    sections.push(section(
      "Сейчас",
      snapshot.running,
      MAX_ACTIVE_ROWS,
      (task, index) => `${index + 1}. ${rowText(task)}`
        + ` · ${elapsed(snapshot.now - task.since)}`,
    ));
  } else {
    sections.push("<b>Сейчас</b>\nНичего не выполняется.");
  }

  if (snapshot.queued.length > 0) {
    sections.push(section(
      "Очередь",
      snapshot.queued,
      MAX_QUEUE_ROWS,
      (row, index) => `${index + 1}. ${rowText(row)}`
        + ` · ${elapsed(snapshot.now - row.since)}`,
    ));
  }

  const systemSection = [
    "<b>Система</b>",
    snapshot.codexAvailable ? "🟢 Codex app-server" : "🔴 Codex app-server недоступен",
    snapshot.failedJobs24h > 0
      ? `⚠️ Доставка · ошибок ${snapshot.failedJobs24h} за 24ч`
      : "🟢 Доставка без ошибок за 24ч",
  ].join("\n");

  const body = [heading, ...sections, systemSection].join("\n\n");
  if (body.length > TELEGRAM_MESSAGE_UTF16_LIMIT) {
    throw new Error("Status board minimum rendering exceeds Telegram limit");
  }

  return {
    body,
    buttons: miniAppLaunchUrl
      ? [{ text: "Открыть Dashboard", url: miniAppLaunchUrl }]
      : [],
  };
}

function section<T>(
  title: string,
  rows: readonly T[],
  maximum: number,
  renderRow: (row: T, index: number) => string,
): string {
  const visible = rows.slice(0, maximum);
  const hidden = rows.length - visible.length;
  return [
    `<b>${title}</b>`,
    ...visible.map(renderRow),
    ...(hidden > 0 ? [`… ещё ${hidden}`] : []),
  ].join("\n");
}

export function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function waitingText(waitingOn: WaitingOn | undefined): string {
  return waitingOn === "approval" ? "ждёт подтверждения" : "ждёт ответа";
}

function rowText(row: { label: string; workspace: string }): string {
  return `${boundedEscapedHTML(workspaceLabel(row.workspace))}`
    + ` · ${boundedEscapedHTML(label(row.label))}`;
}

function boundedEscapedHTML(text: string): string {
  const escaped = escapeHTML(text);
  if (escaped.length <= MAX_ROW_COMPONENT_HTML_UNITS) return escaped;

  let output = "";
  for (const character of text) {
    const unit = escapeHTML(character);
    if (output.length + unit.length + 1 > MAX_ROW_COMPONENT_HTML_UNITS) break;
    output += unit;
  }
  return `${output}…`;
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

function elapsed(durationMs: number): string {
  const totalMinutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (totalMinutes < 1) return "меньше минуты";
  if (totalMinutes < 60) return `${totalMinutes}м`;
  return `${Math.floor(totalMinutes / 60)}ч ${totalMinutes % 60}м`;
}
