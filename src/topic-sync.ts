import path from "node:path";

import { listUserThreads as readUserThreads, type CodexThreadRecord } from "./codex-state.js";
import { contextKeyFromMessage, type TelegramContextKey } from "./context-key.js";

const MAX_TOPIC_NAME_LENGTH = 128;
const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/;
const API_KEY_PATTERN = /\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{16,}\b/i;

type TopicSyncRegistry = {
  isThreadBoundInChat(threadId: string, chatId: number): boolean;
  bindThread(contextKey: TelegramContextKey, thread: CodexThreadRecord): void;
};

type TopicSyncLogger = Pick<Console, "info" | "warn">;

export type TopicSyncResult = {
  created: number;
  skipped: number;
  failed: number;
};

export type TopicSynchronizerOptions = {
  chatId: number;
  intervalMs: number;
  registry: TopicSyncRegistry;
  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number }>;
  listUserThreads?: () => CodexThreadRecord[];
  logger?: TopicSyncLogger;
};

export function threadLabel(thread: CodexThreadRecord): string {
  const rawTitle = (thread.title || thread.firstUserMessage).replace(/\s+/g, " ").trim();
  return !rawTitle || containsSecret(rawTitle) ? `Session ${thread.id.slice(0, 8)}` : rawTitle;
}

export function workspaceLabel(cwd: string): string {
  const raw = path.basename(cwd);
  return !raw || raw.length > 40 || containsSecret(raw) ? "Codex" : raw;
}

export function buildTopicName(thread: CodexThreadRecord): string {
  return truncateUnicode(`${workspaceLabel(thread.cwd)} · ${threadLabel(thread)}`, MAX_TOPIC_NAME_LENGTH);
}

export function containsSecret(value: string): boolean {
  return TELEGRAM_BOT_TOKEN_PATTERN.test(value) || API_KEY_PATTERN.test(value);
}

export class TopicSynchronizer {
  private readonly listUserThreads: () => CodexThreadRecord[];
  private readonly logger: TopicSyncLogger;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: TopicSynchronizerOptions) {
    this.listUserThreads = options.listUserThreads ?? (() => readUserThreads(1000));
    this.logger = options.logger ?? console;
  }

  async syncOnce(): Promise<TopicSyncResult> {
    const result: TopicSyncResult = { created: 0, skipped: 0, failed: 0 };

    for (const thread of this.listUserThreads()) {
      if (this.options.registry.isThreadBoundInChat(thread.id, this.options.chatId)) {
        result.skipped += 1;
        continue;
      }

      try {
        const topic = await this.options.createForumTopic(
          this.options.chatId,
          buildTopicName(thread),
        );
        const contextKey = contextKeyFromMessage(this.options.chatId, topic.message_thread_id);
        this.options.registry.bindThread(contextKey, thread);
        result.created += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to create Telegram topic for Codex thread ${thread.id}: ${message}`);
      }
    }

    return result;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runSafely(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const result = await this.syncOnce();
      if (result.created > 0 || result.failed > 0) {
        this.logger.info(
          `Topic sync: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Topic sync failed: ${message}`);
    } finally {
      this.running = false;
    }
  }
}

function truncateUnicode(value: string, maxLength: number): string {
  const characters = [...value];
  return characters.length <= maxLength ? value : characters.slice(0, maxLength).join("");
}
