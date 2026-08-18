import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const WORKING_TOPIC_EMOJI = "🤖";

export interface TopicIconSticker {
  emoji?: string;
  customEmojiId?: string;
}

export interface TopicReference {
  chatId: number;
  messageThreadId: number;
}

interface TopicIconState {
  idleIconCustomEmojiId: string | null;
  working: boolean;
}

interface TopicIconFile {
  topics: Record<string, TopicIconState>;
}

interface TopicActivityLogger {
  warn(message: string, error?: unknown): void;
}

export interface TopicActivityIndicatorOptions {
  filePath: string;
  listIconStickers(): Promise<TopicIconSticker[]>;
  editTopicIcon(chatId: number, messageThreadId: number, iconCustomEmojiId: string): Promise<void>;
  logger?: TopicActivityLogger;
}

export class TopicActivityIndicator {
  private readonly topics = new Map<string, TopicIconState>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly logger: TopicActivityLogger;
  private workingIconPromise?: Promise<string>;

  constructor(private readonly options: TopicActivityIndicatorOptions) {
    this.logger = options.logger ?? console;
    this.load();
  }

  rememberIdleIcon(
    chatId: number,
    messageThreadId: number,
    iconCustomEmojiId: string | null,
  ): void {
    const key = topicKey(chatId, messageThreadId);
    if (this.topics.get(key)?.working) return;
    this.topics.set(key, { idleIconCustomEmojiId: iconCustomEmojiId, working: false });
    this.persist();
  }

  start(chatId: number, messageThreadId: number): Promise<void> {
    return this.enqueue(chatId, messageThreadId, async () => {
      const key = topicKey(chatId, messageThreadId);
      let markedWorking = false;

      try {
        const workingIcon = await this.workingIcon();
        const state = this.topics.get(key) ?? { idleIconCustomEmojiId: null, working: false };
        const wasWorking = state.working;
        if (!wasWorking) {
          state.working = true;
          this.topics.set(key, state);
          if (!this.persist()) {
            state.working = false;
            this.topics.set(key, state);
            return;
          }
          markedWorking = true;
        }
        await this.options.editTopicIcon(chatId, messageThreadId, workingIcon);
      } catch (error) {
        if (markedWorking) {
          const state = this.topics.get(key);
          this.topics.set(key, {
            idleIconCustomEmojiId: state?.idleIconCustomEmojiId ?? null,
            working: false,
          });
          this.persist();
        }
        this.logger.warn(`Failed to mark Telegram topic ${key} as working`, error);
      }
    });
  }

  async restoreStaleTopics(
    options: { exclude?: readonly TopicReference[] } = {},
  ): Promise<void> {
    const excluded = new Set(
      (options.exclude ?? []).map((topic) => topicKey(topic.chatId, topic.messageThreadId)),
    );
    const staleTopics = [...this.topics.entries()]
      .filter(([key, state]) => state.working && !excluded.has(key))
      .map(([key]) => parseTopicKey(key))
      .filter((topic): topic is { chatId: number; messageThreadId: number } => topic !== undefined);
    await Promise.all(
      staleTopics.map((topic) => this.finish(topic.chatId, topic.messageThreadId)),
    );
  }

  finish(chatId: number, messageThreadId: number): Promise<void> {
    return this.enqueue(chatId, messageThreadId, async () => {
      const key = topicKey(chatId, messageThreadId);
      const state = this.topics.get(key);
      if (!state?.working) return;

      try {
        await this.options.editTopicIcon(
          chatId,
          messageThreadId,
          state.idleIconCustomEmojiId ?? "",
        );
        state.working = false;
        this.topics.set(key, state);
        this.persist();
      } catch (error) {
        if (isTopicNotModifiedError(error)) {
          state.working = false;
          this.topics.set(key, state);
          this.persist();
          return;
        }
        this.logger.warn(`Failed to restore Telegram topic ${key} icon`, error);
      }
    });
  }

  private enqueue(
    chatId: number,
    messageThreadId: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = topicKey(chatId, messageThreadId);
    const previous = this.operations.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        this.logger.warn(`Telegram topic ${key} activity update failed`, error);
      });
    this.operations.set(key, current);
    void current.finally(() => {
      if (this.operations.get(key) === current) {
        this.operations.delete(key);
      }
    });
    return current;
  }

  private workingIcon(): Promise<string> {
    if (this.workingIconPromise) return this.workingIconPromise;
    const request = this.options.listIconStickers().then((stickers) => {
      const sticker = stickers.find(
        (candidate) => normalizeEmoji(candidate.emoji) === normalizeEmoji(WORKING_TOPIC_EMOJI),
      );
      if (!sticker?.customEmojiId) {
        throw new Error(`${WORKING_TOPIC_EMOJI} is not available as a Telegram forum topic icon`);
      }
      return sticker.customEmojiId;
    });
    this.workingIconPromise = request;
    void request.catch(() => {
      if (this.workingIconPromise === request) {
        this.workingIconPromise = undefined;
      }
    });
    return request;
  }

  private load(): void {
    if (!existsSync(this.options.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.filePath, "utf8")) as TopicIconFile;
      if (!parsed || typeof parsed.topics !== "object" || parsed.topics === null) return;
      for (const [key, state] of Object.entries(parsed.topics)) {
        if (
          state
          && (typeof state.idleIconCustomEmojiId === "string" || state.idleIconCustomEmojiId === null)
          && typeof state.working === "boolean"
        ) {
          this.topics.set(key, state);
        }
      }
    } catch (error) {
      this.logger.warn("Failed to load Telegram topic icon state", error);
    }
  }

  private persist(): boolean {
    try {
      const directory = path.dirname(this.options.filePath);
      mkdirSync(directory, { recursive: true });
      const temporaryPath = `${this.options.filePath}.tmp-${process.pid}-${randomUUID()}`;
      const file: TopicIconFile = { topics: Object.fromEntries(this.topics) };
      writeFileSync(temporaryPath, JSON.stringify(file, null, 2), "utf8");
      renameSync(temporaryPath, this.options.filePath);
      return true;
    } catch (error) {
      this.logger.warn("Failed to persist Telegram topic icon state", error);
      return false;
    }
  }
}

export function isTopicActivityEligible(
  messageThreadId: number | undefined,
): messageThreadId is number {
  return messageThreadId !== undefined
    && Number.isSafeInteger(messageThreadId)
    && messageThreadId > 1;
}

export function topicIconChangeFromMessage(
  message: unknown,
): { iconCustomEmojiId: string | null } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  const created = record.forum_topic_created;
  if (typeof created === "object" && created !== null) {
    const icon = (created as Record<string, unknown>).icon_custom_emoji_id;
    return { iconCustomEmojiId: typeof icon === "string" && icon ? icon : null };
  }

  const edited = record.forum_topic_edited;
  if (
    typeof edited !== "object"
    || edited === null
    || !Object.prototype.hasOwnProperty.call(edited, "icon_custom_emoji_id")
  ) {
    return undefined;
  }
  const icon = (edited as Record<string, unknown>).icon_custom_emoji_id;
  return { iconCustomEmojiId: typeof icon === "string" && icon ? icon : null };
}

function topicKey(chatId: number, messageThreadId: number): string {
  return `${chatId}:${messageThreadId}`;
}

function parseTopicKey(key: string): { chatId: number; messageThreadId: number } | undefined {
  const separator = key.lastIndexOf(":");
  const chatId = Number(key.slice(0, separator));
  const messageThreadId = Number(key.slice(separator + 1));
  return Number.isSafeInteger(chatId) && isTopicActivityEligible(messageThreadId)
    ? { chatId, messageThreadId }
    : undefined;
}

function normalizeEmoji(emoji: string | undefined): string | undefined {
  return emoji?.replaceAll("\uFE0F", "");
}

function isTopicNotModifiedError(error: unknown): boolean {
  return /TOPIC_NOT_MODIFIED/i.test(error instanceof Error ? error.message : String(error));
}
