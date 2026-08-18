import { clock, renderStatusBoard, type RenderedMessage } from "./status-board-render.js";
import type { StatusBoardLocation, StatusBoardStore } from "./status-board-store.js";
export { renderStatusBoard, STATUS_BOARD_BUTTON_LIMIT } from "./status-board-render.js";
export type { BoardButton, RenderedBoard, RenderedMessage } from "./status-board-render.js";

/** How long a finished turn stays worth mentioning. */
const RECENT_WINDOW_MS = 30 * 60_000;
const MAX_RECENT = 3;
const THREAD_HISTORY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_RECENT_THREADS = 6;

export type WaitingOn = "approval" | "input";

/** One Codex thread as the app-server currently sees it, wherever it is driven from. */
export interface HostThreadView {
  id: string;
  label: string;
  workspace: string;
  /** Where the thread is driven from: vscode, cli, телеграм … */
  source: string;
  active: boolean;
  waitingOn?: WaitingOn;
  parentThreadId?: string;
  agentNickname?: string;
  since: number;
  messageThreadId?: number;
}

export interface RunningChild {
  label: string;
  since: number;
  waitingOn?: WaitingOn;
}

export interface RunningTask {
  threadId?: string;
  label: string;
  workspace: string;
  source: string;
  since: number;
  waitingOn?: WaitingOn;
  messageThreadId?: number;
  children: RunningChild[];
}

export interface StatusRow {
  label: string;
  workspace: string;
  messageThreadId?: number;
  since: number;
}

export interface RecentRow {
  label: string;
  workspace: string;
  messageThreadId?: number;
  finishedAt: number;
  ok: boolean;
}

export interface RecentThreadView {
  threadId: string;
  label: string;
  workspace: string;
  source: string;
  updatedAt: number;
  messageThreadId?: number;
}

export interface StatusSnapshot {
  limit: number;
  /** Turns occupying a Telegram slot, which is a smaller set than everything running. */
  telegramActive: number;
  running: RunningTask[];
  queued: StatusRow[];
  recent: RecentRow[];
  recentThreads: RecentThreadView[];
  recentThreadCount: number;
  codexAvailable: boolean;
  failedJobs24h: number;
  now: number;
}

/**
 * Folds loaded threads into the tasks a person would recognise.
 *
 * A subagent is a thread of its own, so a fan-out of five would otherwise read
 * as five separate jobs. It also means a parent can sit idle while its children
 * work: that parent is still busy and has to stay on the board, or its
 * subagents would be listed with nothing to hang them from.
 */
export function groupRunningThreads(threads: HostThreadView[]): RunningTask[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rootOf = (thread: HostThreadView): HostThreadView | undefined => {
    const visited = new Set<string>();
    let current = thread;
    while (current.parentThreadId !== undefined) {
      if (visited.has(current.id)) return undefined;
      visited.add(current.id);
      const parent = byId.get(current.parentThreadId);
      if (!parent) return undefined;
      current = parent;
    }
    return current;
  };

  const descendantsOf = new Map<string, HostThreadView[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === undefined || !thread.active) continue;
    const root = rootOf(thread);
    if (!root) continue;
    const descendants = descendantsOf.get(root.id) ?? [];
    descendants.push(thread);
    descendantsOf.set(root.id, descendants);
  }

  return threads
    .filter((thread) => thread.parentThreadId === undefined)
    .map((root) => ({
      root,
      children: descendantsOf.get(root.id) ?? [],
    }))
    .filter(({ root, children }) => root.active || children.length > 0)
    .sort((left, right) => left.root.since - right.root.since)
    .map(({ root, children }) => ({
      threadId: root.id,
      label: root.label,
      workspace: root.workspace,
      source: root.source,
      since: root.since,
      waitingOn: root.waitingOn,
      messageThreadId: root.messageThreadId,
      children: children
        .sort((left, right) => left.since - right.since)
        .map((child) => ({
          label: child.agentNickname ? `${child.agentNickname} · ${child.label}` : child.label,
          since: child.since,
          waitingOn: child.waitingOn,
        })),
    }));
}

export type StatusJobState =
  | "awaiting-model"
  | "waiting"
  | "active"
  | "delivering"
  | "completed"
  | "failed"
  | "aborted";

/** One Telegram job, with its names already resolved by the caller. */
export interface StatusJobView {
  state: StatusJobState;
  label: string;
  workspace: string;
  messageThreadId?: number;
  createdAt: number;
  updatedAt: number;
}

export function buildStatusSnapshot(
  jobs: StatusJobView[],
  hostThreads: HostThreadView[],
  options: {
    limit: number;
    now: number;
    recentWindowMs?: number;
    maxRecent?: number;
    recentThreads?: RecentThreadView[];
    maxRecentThreads?: number;
    codexAvailable?: boolean;
  },
): StatusSnapshot {
  const recentWindowMs = options.recentWindowMs ?? RECENT_WINDOW_MS;
  const maxRecent = options.maxRecent ?? MAX_RECENT;
  const running = groupRunningThreads(hostThreads);
  const runningThreadIds = new Set(running.map((thread) => thread.threadId).filter(Boolean));
  const recentThreads = (options.recentThreads ?? [])
    .filter((thread) => options.now - thread.updatedAt <= THREAD_HISTORY_WINDOW_MS)
    .filter((thread) => !runningThreadIds.has(thread.threadId))
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return {
    limit: options.limit,
    telegramActive: jobs.filter((job) => job.state === "active" || job.state === "delivering").length,
    running,
    queued: jobs
      .filter((job) => job.state === "waiting" || job.state === "awaiting-model")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((job) => ({
        label: job.label,
        workspace: job.workspace,
        messageThreadId: job.messageThreadId,
        since: job.createdAt,
      })),
    recent: jobs
      .filter((job) => isFinished(job.state) && options.now - job.updatedAt <= recentWindowMs)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, maxRecent)
      .map((job) => ({
        label: job.label,
        workspace: job.workspace,
        messageThreadId: job.messageThreadId,
        finishedAt: job.updatedAt,
        ok: job.state === "completed",
      })),
    recentThreads: recentThreads.slice(0, options.maxRecentThreads ?? MAX_RECENT_THREADS),
    recentThreadCount: recentThreads.length,
    codexAvailable: options.codexAvailable ?? true,
    failedJobs24h: jobs.filter(
      (job) => job.state === "failed" && options.now - job.updatedAt <= THREAD_HISTORY_WINDOW_MS,
    ).length,
    now: options.now,
  };
}

function isFinished(state: StatusJobState): boolean {
  return state === "completed" || state === "failed" || state === "aborted";
}

export interface StatusBoardOptions {
  chatId: number;
  intervalMs: number;
  collect(): Promise<StatusSnapshot>;
  createTopic(): Promise<number>;
  send(messageThreadId: number, message: RenderedMessage): Promise<number>;
  edit(messageThreadId: number, messageId: number, message: RenderedMessage): Promise<void>;
  pin(messageId: number): Promise<void>;
  closeTopic(messageThreadId: number): Promise<void>;
  reopenTopic(messageThreadId: number): Promise<void>;
  remove(messageId: number): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  store: StatusBoardStore;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

export type RefreshResult = "sent" | "edited" | "unchanged";

export class StatusBoard {
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;
  private lastContent: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private refreshRequested = false;

  constructor(private readonly options: StatusBoardOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  async refreshOnce(): Promise<RefreshResult> {
    const { body, buttons } = renderStatusBoard(await this.options.collect(), this.options.chatId);
    const message: RenderedMessage = {
      html: `${body}\n\n<i>обновлено ${clock(this.now())}</i>`,
      buttons,
    };
    const content = JSON.stringify({ body, buttons });
    let location = this.options.store.read();
    if (location.messageThreadId !== undefined) {
      try {
        await this.ensureClosed(location.messageThreadId);
      } catch (error) {
        if (!isMissingTopic(error)) throw error;
        location = pickLegacy(location);
        this.options.store.write(location);
      }
    }
    if (location.messageThreadId !== undefined && location.messageId !== undefined) {
      const exists = await this.ensurePinned(location.messageId);
      if (!exists) {
        this.lastContent = undefined;
        this.options.store.write({
          messageThreadId: location.messageThreadId,
          ...pickLegacy(location),
        });
        return this.recoverMessage(
          location.messageThreadId,
          message,
          content,
          location.legacyMessageId,
        );
      }
      location = await this.cleanupLegacy(location);
    }
    if (
      location.messageThreadId !== undefined
      && location.messageId !== undefined
      && content === this.lastContent
    ) {
      return "unchanged";
    }

    if (location.messageThreadId === undefined) {
      return this.createDashboard(
        message,
        content,
        location.legacyMessageId ?? location.messageId,
      );
    }

    if (location.messageId === undefined) {
      return this.recoverMessage(
        location.messageThreadId,
        message,
        content,
        location.legacyMessageId,
      );
    }

    try {
      await this.options.edit(location.messageThreadId, location.messageId, message);
      this.lastContent = content;
      return "edited";
    } catch (error) {
      if (!isMissingMessage(error)) throw error;
      // Someone deleted the board by hand; replace it in the same topic.
      this.options.store.write({
        messageThreadId: location.messageThreadId,
        ...pickLegacy(location),
      });
      this.lastContent = undefined;
      return this.recoverMessage(
        location.messageThreadId,
        message,
        content,
        location.legacyMessageId,
      );
    }
  }

  isDashboardTopic(messageThreadId: number | undefined): boolean {
    return messageThreadId !== undefined
      && this.options.store.read().messageThreadId === messageThreadId;
  }

  async protectTopicMessage(
    messageThreadId: number | undefined,
    messageId?: number,
  ): Promise<boolean> {
    if (!this.isDashboardTopic(messageThreadId)) return false;
    const dashboardThreadId = this.options.store.read().messageThreadId;
    if (dashboardThreadId === undefined) return false;
    if (messageId !== undefined) {
      try {
        await this.options.deleteMessage(messageId);
      } catch (error) {
        this.logger.warn(`Failed to delete a message from Dashboard: ${describe(error)}`);
      }
    }
    await this.ensureClosed(dashboardThreadId);
    return true;
  }

  /**
   * One refresh that never throws.
   *
   * A failure here means the snapshot could not be read, and a board claiming
   * nothing is running would be worse than a board that is a tick stale.
   */
  async refreshSafely(): Promise<void> {
    if (this.running) {
      this.refreshRequested = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.refreshRequested = false;
        try {
          await this.refreshOnce();
        } catch (error) {
          this.logger.warn(`Status board refresh failed: ${describe(error)}`);
        }
      } while (this.refreshRequested);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.refreshSafely();
    this.timer = setInterval(() => void this.refreshSafely(), this.options.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async createDashboard(
    message: RenderedMessage,
    content: string,
    legacyMessageId?: number,
  ): Promise<RefreshResult> {
    const messageThreadId = await this.options.createTopic();
    this.options.store.write({ messageThreadId, ...(legacyMessageId ? { legacyMessageId } : {}) });
    const result = await this.post(messageThreadId, message, content, legacyMessageId);
    await this.cleanupLegacy(this.options.store.read());
    return result;
  }

  private async recoverMessage(
    messageThreadId: number,
    message: RenderedMessage,
    content: string,
    legacyMessageId?: number,
  ): Promise<RefreshResult> {
    try {
      await this.options.reopenTopic(messageThreadId);
      return await this.post(messageThreadId, message, content, legacyMessageId);
    } catch (error) {
      if (!isMissingTopic(error)) throw error;
      this.options.store.write(legacyMessageId ? { legacyMessageId } : {});
      return this.createDashboard(message, content, legacyMessageId);
    }
  }

  private async post(
    messageThreadId: number,
    message: RenderedMessage,
    content: string,
    legacyMessageId?: number,
  ): Promise<RefreshResult> {
    const newId = await this.options.send(messageThreadId, message);
    this.options.store.write({
      messageThreadId,
      messageId: newId,
      ...(legacyMessageId ? { legacyMessageId } : {}),
    });
    this.lastContent = content;
    await this.ensurePinned(newId);
    await this.ensureClosed(messageThreadId);
    return "sent";
  }

  private async ensurePinned(messageId: number): Promise<boolean> {
    try {
      await this.options.pin(messageId);
      return true;
    } catch (error) {
      if (isMissingMessage(error)) return false;
      this.logger.warn(`Failed to pin the status board: ${describe(error)}`);
      return true;
    }
  }

  private async cleanupLegacy(location: StatusBoardLocation): Promise<StatusBoardLocation> {
    if (location.legacyMessageId === undefined) return location;
    try {
      await this.options.remove(location.legacyMessageId);
    } catch (error) {
      if (!isMissingMessage(error)) {
        this.logger.warn(`Failed to remove the old General status board: ${describe(error)}`);
        return location;
      }
    }
    const cleaned = {
      ...(location.messageThreadId ? { messageThreadId: location.messageThreadId } : {}),
      ...(location.messageId ? { messageId: location.messageId } : {}),
    };
    this.options.store.write(cleaned);
    return cleaned;
  }

  private async ensureClosed(messageThreadId: number): Promise<void> {
    try {
      await this.options.closeTopic(messageThreadId);
    } catch (error) {
      if (!isAlreadyClosed(error)) throw error;
    }
  }
}

/** Telegram's way of saying the message we were editing is gone. */
function isMissingMessage(error: unknown): boolean {
  return /message to (?:edit|pin|delete) not found|message can't be edited|MESSAGE_ID_INVALID/i.test(describe(error));
}

function isMissingTopic(error: unknown): boolean {
  return /message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(describe(error));
}

function isAlreadyClosed(error: unknown): boolean {
  return /TOPIC_CLOSED|TOPIC_NOT_MODIFIED|topic is already closed/i.test(describe(error));
}

function pickLegacy(location: StatusBoardLocation): StatusBoardLocation {
  return location.legacyMessageId === undefined
    ? {}
    : { legacyMessageId: location.legacyMessageId };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
