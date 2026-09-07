import {
  clock,
  renderStatusBoard,
  type RenderedMessage,
} from "./status-board-render.js";
import type { StatusBoardLocation, StatusBoardStore } from "./status-board-store.js";
import type { StatusSnapshot } from "./status-board-snapshot.js";
import type { TelegramBackgroundWriteGate } from "./telegram-background-write-gate.js";
import { telegramRetryAfterMs } from "./telegram-rate-limit.js";
export {
  renderMiniAppLauncher,
  renderStatusBoard,
  STATUS_BOARD_BUTTON_LIMIT,
} from "./status-board-render.js";
export type { BoardButton, RenderedBoard, RenderedMessage } from "./status-board-render.js";
export { buildStatusSnapshot, groupRunningThreads } from "./status-board-snapshot.js";
export { telegramRetryAfterMs } from "./telegram-rate-limit.js";
export type {
  HostThreadView, ProjectedStatusJobView, RecentRow, RecentThreadView, RunningChild,
  RunningTask, StatusJobState, StatusJobView, StatusRow, StatusSnapshot, WaitingOn,
} from "./status-board-snapshot.js";

const HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;
const MAX_VISIBLE_REFRESH_INTERVAL_MS = 5_000;
type StatusBoardBackgroundWrite = <T>(operation: () => Promise<T>) => Promise<T>;

export interface StatusBoardOptions {
  chatId: number;
  intervalMs: number;
  miniAppLaunchUrl?: string;
  collect(): Promise<StatusSnapshot>;
  createTopic(): Promise<number>;
  send(messageThreadId: number, message: RenderedMessage): Promise<number>;
  edit(messageThreadId: number, messageId: number, message: RenderedMessage): Promise<void>;
  pin(messageId: number): Promise<void>;
  closeTopic(messageThreadId: number): Promise<void>;
  reopenTopic(messageThreadId: number): Promise<void>;
  remove(messageId: number, backgroundWrite: StatusBoardBackgroundWrite): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  store: StatusBoardStore;
  backgroundWriteGate?: Pick<TelegramBackgroundWriteGate, "run">;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

export type RefreshResult = "sent" | "edited" | "unchanged";

export class StatusBoard {
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;
  private lastContent: string | undefined;
  private lastHealthCheckAt: number | undefined;
  private rateLimitedUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private refreshRequested = false;

  constructor(private readonly options: StatusBoardOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  async refreshOnce(): Promise<RefreshResult> {
    const now = this.now();
    if (now < this.rateLimitedUntil) return "unchanged";

    try {
      return await this.refreshBoard(now);
    } catch (error) {
      const retryAfterMs = telegramRetryAfterMs(error);
      if (retryAfterMs !== undefined) {
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.now() + retryAfterMs);
      }
      throw error;
    }
  }

  private async refreshBoard(now: number): Promise<RefreshResult> {
    let location = this.options.store.read();
    const hasSavedBoard = location.messageThreadId !== undefined
      && location.messageId !== undefined;
    const healthCheckDue = this.lastHealthCheckAt === undefined
      || now - this.lastHealthCheckAt >= HEALTH_CHECK_INTERVAL_MS;
    const { body, buttons } = renderStatusBoard(
      await this.options.collect(),
      this.options.chatId,
      this.options.miniAppLaunchUrl,
    );
    const message: RenderedMessage = {
      html: `${body}\n\n<i>обновлено ${clock(now)}</i>`,
      buttons,
    };
    const content = JSON.stringify({ body, buttons });
    if (
      hasSavedBoard
      && !healthCheckDue
      && location.legacyMessageId === undefined
      && content === this.lastContent
    ) {
      return "unchanged";
    }

    if (location.messageThreadId !== undefined && (!hasSavedBoard || healthCheckDue)) {
      try {
        await this.ensureClosed(location.messageThreadId);
      } catch (error) {
        if (!isMissingTopic(error)) throw error;
        location = pickLegacy(location);
        this.options.store.write(location);
      }
    }
    if (
      location.messageThreadId !== undefined
      && location.messageId !== undefined
      && healthCheckDue
    ) {
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
      this.lastHealthCheckAt = now;
      location = await this.cleanupLegacy(location);
    } else if (location.legacyMessageId !== undefined) {
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
      await this.backgroundWrite(
        () => this.options.edit(location.messageThreadId!, location.messageId!, message),
      );
      this.lastContent = content;
      return "edited";
    } catch (error) {
      if (isMessageNotModified(error)) {
        this.lastContent = content;
        return "unchanged";
      }
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

  isDashboardTopic(chatId: number | undefined, messageThreadId: number | undefined): boolean {
    return chatId === this.options.chatId && messageThreadId !== undefined
      && this.options.store.read().messageThreadId === messageThreadId;
  }

  isDashboardMessage(
    chatId: number | undefined,
    messageThreadId: number | undefined,
    messageId: number | undefined,
  ): boolean {
    if (!this.isDashboardTopic(chatId, messageThreadId) || messageId === undefined) return false;
    const location = this.options.store.read();
    return location.messageId === messageId;
  }

  async protectTopicMessage(
    chatId: number | undefined,
    messageThreadId: number | undefined,
    messageId?: number,
  ): Promise<boolean> {
    if (!this.isDashboardTopic(chatId, messageThreadId)) return false;
    const dashboardThreadId = this.options.store.read().messageThreadId;
    if (dashboardThreadId === undefined) return false;
    if (messageId !== undefined) {
      try {
        await this.backgroundWrite(() => this.options.deleteMessage(messageId));
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
    this.timer = setInterval(
      () => void this.refreshSafely(),
      Math.min(this.options.intervalMs, MAX_VISIBLE_REFRESH_INTERVAL_MS),
    );
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
    const messageThreadId = await this.backgroundWrite(() => this.options.createTopic());
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
      await this.backgroundWrite(() => this.options.reopenTopic(messageThreadId));
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
    const newId = await this.backgroundWrite(() => this.options.send(messageThreadId, message));
    this.options.store.write({
      messageThreadId,
      messageId: newId,
      ...(legacyMessageId ? { legacyMessageId } : {}),
    });
    this.lastContent = content;
    await this.ensurePinned(newId);
    await this.ensureClosed(messageThreadId);
    this.lastHealthCheckAt = this.now();
    return "sent";
  }

  private async ensurePinned(messageId: number): Promise<boolean> {
    try {
      await this.backgroundWrite(() => this.options.pin(messageId));
      return true;
    } catch (error) {
      if (isMissingMessage(error)) return false;
      if (telegramRetryAfterMs(error) !== undefined) throw error;
      this.logger.warn(`Failed to pin the status board: ${describe(error)}`);
      return true;
    }
  }

  private async cleanupLegacy(location: StatusBoardLocation): Promise<StatusBoardLocation> {
    if (location.legacyMessageId === undefined) return location;
    try {
      await this.options.remove(
        location.legacyMessageId,
        (operation) => this.backgroundWrite(operation),
      );
    } catch (error) {
      if (telegramRetryAfterMs(error) !== undefined) throw error;
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
      await this.backgroundWrite(() => this.options.closeTopic(messageThreadId));
    } catch (error) {
      if (!isAlreadyClosed(error)) throw error;
    }
  }

  private backgroundWrite<T>(operation: () => Promise<T>): Promise<T> {
    const gate = this.options.backgroundWriteGate;
    return gate
      ? gate.run(this.options.chatId, "ordinary", operation)
      : operation();
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

function isMessageNotModified(error: unknown): boolean {
  return /message is not modified/i.test(describe(error));
}
