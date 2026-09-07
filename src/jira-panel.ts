import { escapeHTML } from "./format.js";
import type {
  JiraCacheMetadata,
  JiraClientPort,
  JiraFilterResult,
  JiraFiltersResult,
  JiraIssue,
  JiraKanbanResult,
  JiraSprintResult,
} from "./jira-client.js";

const PAGE_SIZE = 6;
const SUMMARY_LIMIT = 90;

export interface JiraPanelButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface JiraPanelMessage {
  html: string;
  rows: JiraPanelButton[][];
}

export interface JiraPanelLocation {
  messageId?: number;
  cleanupMessageIds?: number[];
}

export interface JiraPanelStore {
  read(): JiraPanelLocation;
  write(location: JiraPanelLocation): void;
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

export interface JiraPanelOptions {
  chatId: number;
  topicId: number;
  client: JiraClientPort;
  send(message: JiraPanelMessage): Promise<number>;
  edit(messageId: number, message: JiraPanelMessage): Promise<void>;
  remove(messageId: number): Promise<void>;
  store: JiraPanelStore;
  miniAppLaunchUrl?: string;
  logger?: Pick<Console, "warn">;
}

export type JiraPanelPublishResult = "sent" | "edited";

export class JiraPanel {
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly options: JiraPanelOptions) {
    this.logger = options.logger ?? console;
  }

  matches(chatId: number | undefined, topicId: number | undefined): boolean {
    return chatId === this.options.chatId && topicId === this.options.topicId;
  }

  open(): Promise<JiraPanelPublishResult> {
    return moveJiraPanelMessage(renderHome(this.options.miniAppLaunchUrl), {
      send: this.options.send,
      remove: this.options.remove,
      store: this.options.store,
      logger: this.logger,
    });
  }

  async openSafely(): Promise<void> {
    try {
      await this.open();
    } catch (error) {
      this.logger.warn(`Failed to open Jira panel: ${describe(error)}`);
    }
  }

  async handleCallback(data: string): Promise<boolean> {
    if (!data.startsWith("jira:")) return false;
    if (data === "jira:noop") return true;

    const request = parseCallback(data);
    if (!request) {
      await this.updateExisting(renderError("Неизвестное действие Jira", "jira:home"));
      return true;
    }
    if (request.view === "home") {
      await this.updateExisting(renderHome(this.options.miniAppLaunchUrl));
      return true;
    }

    let message: JiraPanelMessage;
    try {
      const refresh = request.refresh;
      if (request.view === "my-sprint") {
        message = renderFilter(await this.options.client.getMySprint(refresh), request.page);
      } else if (request.view === "sprint") {
        message = renderSprint(await this.options.client.getSprint(refresh), request.page);
      } else if (request.view === "kanban") {
        message = renderKanban(await this.options.client.getKanban(refresh), request.page);
      } else if (request.view === "filters") {
        message = renderFilters(await this.options.client.getFilters(refresh), request.page);
      } else if (request.view === "filter") {
        message = renderFilter(
          await this.options.client.runFilter(request.filterId, refresh),
          request.page,
        );
      } else {
        throw new Error("Unknown Jira panel view");
      }
    } catch (error) {
      message = renderError(describe(error), retryCallback(data));
    }
    await this.updateExisting(message);
    return true;
  }

  private async updateExisting(message: JiraPanelMessage): Promise<void> {
    await this.options.store.withLock<void>(async () => {
      const saved = this.options.store.read();
      if (saved.messageId === undefined) return;
      try {
        await this.options.edit(saved.messageId, message);
      } catch (error) {
        if (!isMissingMessage(error)) throw error;
      }
    });
  }
}

interface MoveJiraPanelOptions {
  send(message: JiraPanelMessage): Promise<number>;
  remove(messageId: number): Promise<void>;
  store: JiraPanelStore;
  logger?: Pick<Console, "warn">;
}

export async function moveJiraPanelMessage(
  message: JiraPanelMessage,
  options: MoveJiraPanelOptions,
): Promise<JiraPanelPublishResult> {
  return options.store.withLock<JiraPanelPublishResult>(async () => {
    const saved = options.store.read();
    const messageId = await options.send(message);
    const cleanupMessageIds = [...new Set([
      ...(saved.cleanupMessageIds ?? []),
      saved.messageId,
    ].filter((value): value is number => value !== undefined && value !== messageId))];
    try {
      options.store.write({
        messageId,
        ...(cleanupMessageIds.length ? { cleanupMessageIds } : {}),
      });
    } catch (error) {
      try {
        await options.remove(messageId);
      } catch (cleanupError) {
        (options.logger ?? console).warn(
          `Failed to remove untracked Jira panel: ${describe(cleanupError)}`,
        );
      }
      throw error;
    }

    const remaining: number[] = [];
    for (const previousMessageId of cleanupMessageIds) {
      try {
        await options.remove(previousMessageId);
      } catch (error) {
        remaining.push(previousMessageId);
        (options.logger ?? console).warn(
          `Failed to remove previous Jira panel: ${describe(error)}`,
        );
      }
    }
    if (remaining.length !== cleanupMessageIds.length) {
      options.store.write({
        messageId,
        ...(remaining.length ? { cleanupMessageIds: remaining } : {}),
      });
    }
    return "sent";
  });
}

export async function removeJiraLauncherMessage(
  unpin: () => Promise<unknown>,
  remove: () => Promise<unknown>,
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
  let unpinError: unknown;
  try {
    await unpin();
  } catch (error) {
    unpinError = error;
  }
  try {
    await remove();
  } catch (removeError) {
    if (unpinError !== undefined) {
      throw new Error(
        `unpin failed: ${describe(unpinError)}; delete failed: ${describe(removeError)}`,
      );
    }
    logger.warn(`Previous Jira panel was unpinned but could not be deleted: ${describe(removeError)}`);
  }
}

export function jiraMiniAppLaunchUrl(launchUrl: string): string {
  const url = new URL(launchUrl);
  url.searchParams.set("startapp", "jira");
  return url.toString();
}

export function renderHome(miniAppLaunchUrl?: string): JiraPanelMessage {
  return {
    html: [
      "<b>Jira · mircli</b>",
      "Мой спринт, канбан и фильтры в Mini App.",
    ].join("\n"),
    rows: [
      ...(miniAppLaunchUrl
        ? [[{ text: "Открыть Jira", url: miniAppLaunchUrl }]]
        : []),
    ],
  };
}

export function renderSprint(result: JiraSprintResult, requestedPage: number): JiraPanelMessage {
  const title = result.sprints.find((sprint) => sprint.state === "ACTIVE")?.name ?? "Активный спринт";
  return renderIssueList({
    title: `📋 ${title}`,
    total: result.total,
    issues: result.issues,
    metadata: result,
    page: requestedPage,
    pageCallback: "jira:sprint",
    refreshCallback: "jira:refresh:sprint",
  });
}

export function renderFilter(result: JiraFilterResult, requestedPage: number): JiraPanelMessage {
  return renderIssueList({
    title: `⭐ ${result.filter.name}`,
    total: result.total,
    issues: result.issues,
    metadata: result,
    page: requestedPage,
    pageCallback: `jira:filter:${result.filter.id}`,
    refreshCallback: `jira:refresh:filter:${result.filter.id}`,
  });
}

export function renderKanban(result: JiraKanbanResult, requestedPage: number): JiraPanelMessage {
  const rows = result.columns.flatMap((column) =>
    column.issues.map((item) => ({ column: column.status, issue: item })),
  );
  const { page, totalPages, items } = paginate(rows, requestedPage);
  const lines = [`<b>🗂 ${escapeHTML(result.title)}</b>`, `Задач: ${result.total}`];
  let lastColumn: string | undefined;
  for (const row of items) {
    if (row.column !== lastColumn) {
      lines.push("", `<b>${escapeHTML(row.column)}</b>`);
      lastColumn = row.column;
    }
    lines.push(issueLine(row.issue));
  }
  if (items.length === 0) lines.push("", "Нет задач.");
  lines.push("", cacheLine(result));

  return {
    html: lines.join("\n"),
    rows: [
      ...issueButtons(items.map((item) => item.issue)),
      ...navigationRows(page, totalPages, "jira:kanban", "jira:refresh:kanban"),
    ],
  };
}

export function renderFilters(result: JiraFiltersResult, requestedPage: number): JiraPanelMessage {
  const { page, totalPages, items } = paginate(result.filters, requestedPage);
  const rows = items.map((filter) => [
    { text: truncate(filter.name, 32), callbackData: `jira:filter:${filter.id}:0` },
    { text: "↗ Jira", url: filter.url },
  ]);
  return {
    html: [
      "<b>⭐ Мои фильтры</b>",
      `Фильтров: ${result.count}`,
      "",
      cacheLine(result),
    ].join("\n"),
    rows: [
      ...rows,
      ...navigationRows(page, totalPages, "jira:filters", "jira:refresh:filters"),
    ],
  };
}

function renderIssueList(options: {
  title: string;
  total: number;
  issues: JiraIssue[];
  metadata: JiraCacheMetadata;
  page: number;
  pageCallback: string;
  refreshCallback: string;
}): JiraPanelMessage {
  const { page, totalPages, items } = paginate(options.issues, options.page);
  const lines = [
    `<b>${escapeHTML(options.title)}</b>`,
    `Задач: ${options.total}`,
    "",
    ...(items.length === 0 ? ["Нет задач."] : items.map(issueLine)),
    "",
    cacheLine(options.metadata),
  ];
  return {
    html: lines.join("\n"),
    rows: [
      ...issueButtons(items),
      ...navigationRows(page, totalPages, options.pageCallback, options.refreshCallback),
    ],
  };
}

function issueLine(issue: JiraIssue): string {
  return `<a href="${escapeHTML(issue.url)}"><b>${escapeHTML(issue.key)}</b></a> · ${escapeHTML(truncate(issue.summary, SUMMARY_LIMIT))}\n<i>${escapeHTML(issue.status)}${issue.priority ? ` · ${escapeHTML(issue.priority)}` : ""}</i>`;
}

function issueButtons(issues: JiraIssue[]): JiraPanelButton[][] {
  return issues.map((item) => [{
    text: `${item.key} · ${truncate(item.summary, 28)}`,
    url: item.url,
  }]);
}

function navigationRows(
  page: number,
  totalPages: number,
  pageCallback: string,
  refreshCallback: string,
): JiraPanelButton[][] {
  const pager: JiraPanelButton[] = [];
  if (page > 0) pager.push({ text: "◀️", callbackData: `${pageCallback}:${page - 1}` });
  if (totalPages > 1) pager.push({ text: `${page + 1}/${totalPages}`, callbackData: "jira:noop" });
  if (page + 1 < totalPages) pager.push({ text: "▶️", callbackData: `${pageCallback}:${page + 1}` });
  return [
    ...(pager.length > 0 ? [pager] : []),
    [
      { text: "🏠 Меню", callbackData: "jira:home" },
      { text: "🔄 Обновить", callbackData: `${refreshCallback}:${page}` },
    ],
  ];
}

function cacheLine(metadata: JiraCacheMetadata): string {
  const age = formatAge(metadata.cache_age_seconds);
  if (metadata.stale) return `⚠️ Показан устаревший кэш: ${age}`;
  if (metadata.cached) return `Кэш: ${age}`;
  return "Получено из Jira";
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} сек`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  return `${Math.round(seconds / 3600)} ч`;
}

function paginate<T>(items: T[], requestedPage: number): {
  page: number;
  totalPages: number;
  items: T[];
} {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  return {
    page,
    totalPages,
    items: items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
  };
}

type CallbackRequest =
  | { view: "home" }
  | { view: "my-sprint" | "sprint" | "kanban" | "filters"; refresh: boolean; page: number }
  | { view: "filter"; filterId: string; refresh: boolean; page: number };

function parseCallback(data: string): CallbackRequest | undefined {
  if (data === "jira:home") return { view: "home" };
  const basic = /^jira:(refresh:)?(my-sprint|sprint|kanban|filters):(\d+)$/.exec(data);
  if (basic) {
    return {
      view: basic[2] as "my-sprint" | "sprint" | "kanban" | "filters",
      refresh: Boolean(basic[1]),
      page: Number(basic[3]),
    };
  }
  const filter = /^jira:(refresh:)?filter:(\d+):(\d+)$/.exec(data);
  if (filter) {
    return {
      view: "filter",
      filterId: filter[2],
      refresh: Boolean(filter[1]),
      page: Number(filter[3]),
    };
  }
  return undefined;
}

function retryCallback(data: string): string {
  return data.replace(/^jira:/, "jira:refresh:").replace("jira:refresh:refresh:", "jira:refresh:");
}

function renderError(message: string, retry: string): JiraPanelMessage {
  return {
    html: `<b>Jira недоступна</b>\n\n${escapeHTML(truncate(message, 500))}`,
    rows: [[
      { text: "🏠 Меню", callbackData: "jira:home" },
      { text: "🔄 Повторить", callbackData: retry },
    ]],
  };
}

function truncate(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

function isMissingMessage(error: unknown): boolean {
  return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(describe(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
