import { escapeHTML } from "./format.js";
import { topicUrl } from "./projects.js";
import type { RunningTask, StatusSnapshot, WaitingOn } from "./status-board-snapshot.js";
import type {
  TelegramStatusAction,
  TelegramStatusActionKind,
} from "./telegram-status-projection.js";
import { telegramStatusActionCallbackData } from "./telegram-grammy-transport.js";
import { containsSecret, workspaceLabel } from "./topic-sync.js";

const MAX_LABEL_LENGTH = 40;
const TELEGRAM_MESSAGE_UTF16_LIMIT = 4096;
export const STATUS_BOARD_BUTTON_LIMIT = 8;
const HIDDEN_LABEL = "(скрыто)";

type ProjectedJobRow = NonNullable<StatusSnapshot["jobs"]>[number];

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
  chatId: number,
  miniAppLaunchUrl?: string,
): RenderedBoard {
  const launcherButtons: BoardButton[] = miniAppLaunchUrl
    ? [{ text: "Открыть Dashboard", url: miniAppLaunchUrl }]
    : [];
  const statusButtonLimit = STATUS_BOARD_BUTTON_LIMIT - launcherButtons.length;
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

  const sections: string[] = [];

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

  const systemSection = [
    "<b>Система</b>",
    snapshot.codexAvailable ? "🟢 Codex app-server" : "🔴 Codex app-server недоступен",
    snapshot.failedJobs24h > 0
      ? `⚠️ Задачи · ошибок ${snapshot.failedJobs24h} за 24ч`
      : "🟢 Задачи · без ошибок за 24ч",
  ].join("\n");

  const { body, visibleJobs } = boundedBoardBody(
    heading,
    snapshot.jobs ?? [],
    sections,
    systemSection,
    snapshot,
    statusButtonLimit,
  );
  const jobButtons = projectedJobButtons(visibleJobs, statusButtonLimit);
  const actionable = [...snapshot.running, ...snapshot.recentThreads];
  const remainingButtons = statusButtonLimit - jobButtons.length;

  return {
    body,
    buttons: [
      ...launcherButtons,
      ...jobButtons,
      ...actionable
      .filter((task): task is typeof task & { threadId: string } => Boolean(task.threadId))
      .slice(0, remainingButtons)
      .map((task) => actionButton(task, chatId)),
    ],
  };
}

function boundedBoardBody(
  heading: string,
  jobs: readonly ProjectedJobRow[],
  detailSections: readonly string[],
  systemSection: string,
  snapshot: StatusSnapshot,
  buttonLimit: number,
): { readonly body: string; readonly visibleJobs: readonly ProjectedJobRow[] } {
  const maximumVisible = Math.min(jobs.length, buttonLimit);
  const full = composeBoardBody(
    heading, jobs, maximumVisible, detailSections, systemSection, snapshot.now,
  );
  if (full.length <= TELEGRAM_MESSAGE_UTF16_LIMIT) {
    return { body: full, visibleJobs: jobs.slice(0, maximumVisible) };
  }

  const hiddenDetails = snapshot.running.length
    + snapshot.running.reduce((count, task) => count + task.children.length, 0)
    + snapshot.queued.length + snapshot.recent.length + snapshot.recentThreads.length;
  const compactSections = hiddenDetails === 0
    ? []
    : [`<b>Остальное</b>\n… скрыто элементов: ${hiddenDetails}`];
  for (let visible = maximumVisible; visible >= 0; visible -= 1) {
    const body = composeBoardBody(
      heading, jobs, visible, compactSections, systemSection, snapshot.now,
    );
    if (body.length <= TELEGRAM_MESSAGE_UTF16_LIMIT) {
      return { body, visibleJobs: jobs.slice(0, visible) };
    }
  }
  throw new Error("Status board minimum rendering exceeds Telegram limit");
}

function composeBoardBody(
  heading: string,
  jobs: readonly ProjectedJobRow[],
  visibleCount: number,
  detailSections: readonly string[],
  systemSection: string,
  now: number,
): string {
  const visible = jobs.slice(0, visibleCount);
  const omitted = jobs.length - visible.length;
  const jobSection = jobs.length === 0 ? [] : [[
    "<b>Задачи TeleCodex</b>",
    ...visible.map((job) => projectedJobText(job, now)),
    ...(omitted > 0 ? [`… ещё задач: ${omitted}`] : []),
  ].join("\n")];
  return [heading, ...jobSection, ...detailSections, systemSection].join("\n\n");
}

function projectedJobButtons(
  jobs: readonly ProjectedJobRow[],
  buttonLimit: number,
): BoardButton[] {
  const allocations = jobs.map((job) => {
    const details = job.projection.actions.find((action) => action.kind === "details") ?? {
      kind: "details" as const,
      jobId: job.projection.jobId,
      expectedVersion: job.projection.expectedVersion,
    };
    return { job, details, selected: new Set<TelegramStatusAction>([details]) };
  });
  let remaining = buttonLimit - allocations.length;
  for (const allocation of allocations) {
    for (const action of allocation.job.projection.actions) {
      if (remaining === 0) break;
      if (action.kind === "details") continue;
      allocation.selected.add(action);
      remaining -= 1;
    }
  }
  return allocations.flatMap(({ job, details, selected }) => {
    const actions = job.projection.actions.includes(details)
      ? job.projection.actions
      : [...job.projection.actions, details];
    return actions.filter((action) => selected.has(action))
      .map((action) => projectionActionButton(job, action))
      .filter((button): button is BoardButton => button !== null);
  });
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

function projectedJobText(
  row: NonNullable<StatusSnapshot["jobs"]>[number],
  now: number,
): string {
  const value = row.projection;
  const facts = [
    value.state,
    `health ${value.health}`,
    value.queue ? `очередь ${value.queue.position} · ${shortElapsed(value.queue.ageMs)}` : undefined,
    value.activity
      ? `activity ${value.activity.kind} · ${shortElapsed(value.activity.ageMs)}`
      : undefined,
    value.guardian.availability === "unavailable"
      ? "guardian unavailable"
      : value.guardian.health ? `guardian ${value.guardian.health}` : undefined,
    value.guardian.staleForMs === null
      ? undefined
      : `guardian stale ${shortElapsed(value.guardian.staleForMs)}`,
    `delivery ${value.delivery.delivered}/${value.delivery.total}`,
    value.attention.kind === "required" ? `attention ${value.attention.code}` : undefined,
    value.reasonCodes.length > 0 ? `reasons ${value.reasonCodes.join(", ")}` : undefined,
    `updated ${clock(value.timestamps.updatedAt)}`,
    value.timestamps.lastEventAt === null
      ? undefined
      : `event ${shortElapsed(now - value.timestamps.lastEventAt)}`,
  ].filter((fact): fact is string => fact !== undefined);
  return `• ${rowText(row)}\n  <code>${escapeHTML(facts.join(" · "))}</code>`;
}

function projectionActionButton(
  row: NonNullable<StatusSnapshot["jobs"]>[number],
  action: TelegramStatusAction,
): BoardButton | null {
  const projection = row.projection;
  if (action.jobId !== projection.jobId || action.expectedVersion !== projection.expectedVersion) {
    throw new Error("Status action does not match its projection");
  }
  const callbackData = telegramStatusActionCallbackData(action);
  if (!callbackData) return null;
  return { text: actionLabel(action.kind), callbackData };
}

function actionLabel(kind: TelegramStatusActionKind): string {
  const labels: Record<TelegramStatusActionKind, string> = {
    abort: "Abort", refresh: "Refresh", details: "Details", inspect: "Inspect",
    retry_new_turn: "Retry as new turn", guardian_restore: "Guardian Restore",
    retry_delivery: "Retry delivery", recover_missing_topic: "Recover topic",
    resume_existing_topic: "Resume topic",
    send_again_warning: "Send again with warning",
  };
  return labels[kind];
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

function shortElapsed(durationMs: number): string {
  const safe = Math.max(0, durationMs);
  if (safe < 60_000) return `${Math.floor(safe / 1_000)}с`;
  return elapsed(safe);
}
