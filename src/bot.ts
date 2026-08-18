import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  buildFileInstructions,
  buildOutboxInstructions,
  cleanupInbox,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderModelSummaryPlain,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import type { CodexModelChoice } from "./codex-model.js";
import {
  type CodexPromptInput,
  type CodexReasoningEffort,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CodexSessionService,
} from "./codex-session.js";
import { checkAuthStatus, startLogin, startLogout } from "./codex-auth.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
} from "./codex-launch.js";
import { getThread, listRecentRootThreads, listUserThreads } from "./codex-state.js";
import { threadLabel } from "./topic-sync.js";
import {
  GitLabClient,
  buildDoneComment,
  buildReviewPrompt,
  linkedMergeRequests,
  mergeRequestButtons,
  mergeRequestTopicName,
  renderDraftHTML,
  renderMergeRequestCardHTML,
  type MergeRequestSummary,
} from "./gitlab.js";
import {
  BurstBuffer,
  DEFAULT_TICKET_TEMPLATE,
  InboxStore,
  buildTicketPrompt,
  describeSource,
  duplicateTicketButtons,
  extractTicketKey,
  hasAttachment,
  groupTicketsByWorkspace,
  groupBurst,
  ticketActionButtons,
  ticketHeading,
  ticketTopicName,
  type Ticket,
} from "./inbox.js";
import {
  ensureThreadTopic,
  findLiveBoundTopic,
  groupThreadsByProject,
  partitionJobsByTopicLiveness,
  projectButtons,
  renderProjectHTML,
  renderProjectsHTML,
  sessionButtons,
  probeForumTopic,
  topicUrl,
  type ProjectGroup,
} from "./projects.js";
import type { TeleCodexConfig, ToolVerbosity } from "./config.js";
import {
  contextKeyFromCtx,
  contextKeyFromMessage,
  isTopicContextKey,
  parseContextKey,
  type TelegramContextKey,
} from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, splitTelegramMarkdown } from "./format.js";
import {
  canUseChoiceForInput,
  parsePromptModelCallback,
  promptModelCallback,
} from "./model-picker.js";
import { JiraClient } from "./jira-client.js";
import {
  openJiraTaskThread,
  parseJiraTaskCallback,
  renderJiraTaskCardHTML,
  jiraTaskTopicName,
} from "./jira-task-thread.js";
import {
  JiraPanel,
  type JiraPanelButton,
  type JiraPanelMessage,
} from "./jira-panel.js";
import { createJiraPanelStore } from "./jira-panel-store.js";
import {
  RECIPE_MUTES_PATH,
  RECIPE_STATE_PATH,
  RecipeMutes,
  readPendingRun,
} from "./recipe-store.js";
import { buildFixPrompt, fingerprintFinding, fixTopicName } from "./recipes.js";
import { parseRecipes, RECIPE_CONFIG_PATH } from "./recipe-config.js";
import { SessionRegistry } from "./session-registry.js";
import { listHostThreads } from "./host-threads.js";
import {
  buildStatusSnapshot,
  STATUS_BOARD_BUTTON_LIMIT,
  StatusBoard,
  type BoardButton,
  type HostThreadView,
  type StatusJobView,
  type StatusSnapshot,
} from "./status-board.js";
import { createStatusBoardStore } from "./status-board-store.js";
import {
  TelegramJobStore,
  type PersistentTelegramJob,
} from "./telegram-job-store.js";
import type { AppServerHookBlock } from "./app-server-turn-manager.js";
import { buildMarkdownDocument } from "./markdown-document.js";
import { parseReopenCommand, runReopenCommand } from "./thread-reopen.js";
import { TurnProgressPresenter } from "./turn-progress.js";
import {
  isTopicActivityEligible,
  TopicActivityIndicator,
  topicIconChangeFromMessage,
} from "./topic-activity.js";
import {
  finalChunkThreadKeyboard,
  parseCodexThreadCallback,
} from "./thread-links.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const FORMATTED_CHUNK_TARGET = 3000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";
const STATUS_HISTORY_WINDOW_MS = 24 * 60 * 60_000;

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

interface PromptDispatchOptions {
  cleanupInbox?: { workspace: string; turnId: string };
  requireModelSelection?: boolean;
}

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

/** Inbox tickets always run in this sandbox, whatever the host default is. */

interface InboxItem {
  contextKey: TelegramContextKey;
  chatId: number;
  messageId: number;
  mediaGroupId?: string;
  hasAttachment: boolean;
  text: string;
  message: Parameters<typeof describeSource>[0];
}

export interface TeleCodexBot extends Bot<Context> {
  recoverPendingJobs(): Promise<void>;
  statusBoard?: StatusBoard;
  jiraPanel?: JiraPanel;
}

function boardKeyboard(buttons: BoardButton[]): InlineKeyboard | undefined {
  if (buttons.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  buttons.forEach((button) => {
    if (button.url !== undefined) {
      keyboard.url(button.text, button.url);
    } else {
      keyboard.text(button.text, button.callbackData);
    }
    keyboard.row();
  });
  return keyboard;
}

function jiraPanelKeyboard(rows: JiraPanelButton[][]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    for (const button of row) {
      if (button.url !== undefined) {
        keyboard.url(button.text, button.url);
      } else if (button.callbackData !== undefined) {
        keyboard.text(button.text, button.callbackData);
      }
    }
    keyboard.row();
  }
  return keyboard;
}

function ticketKeyboard(ticket: Pick<Ticket, "id" | "startedAt" | "resolvedAt">): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of ticketActionButtons(ticket)) {
    keyboard.text(button.label, button.callbackData);
  }
  return keyboard;
}

function duplicateTicketKeyboard(decisionId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of duplicateTicketButtons(decisionId)) {
    keyboard.text(button.label, button.callbackData).row();
  }
  return keyboard;
}

function promptText(input: CodexPromptInput): string {
  return typeof input === "string" ? input : input.text ?? "";
}

function modelChoiceKeyboard(
  choices: CodexModelChoice[],
  callbackData: (choice: CodexModelChoice) => string,
  selectedChoiceId?: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  choices.forEach((choice, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      `${choice.id === selectedChoiceId ? "✓ " : ""}${choice.label}`,
      callbackData(choice),
    );
  });
  return keyboard;
}

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

export function createBot(config: TeleCodexConfig, registry: SessionRegistry): TeleCodexBot {
  const bot = new Bot<Context>(config.telegramBotToken) as TeleCodexBot;
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const jobStore = new TelegramJobStore(path.join(config.workspace, ".telecodex", "jobs.json"));
  const topicActivity = new TopicActivityIndicator({
    filePath: path.join(config.workspace, ".telecodex", "topic-icons.json"),
    listIconStickers: async () => (await bot.api.getForumTopicIconStickers()).map((sticker) => ({
      emoji: sticker.emoji,
      customEmojiId: sticker.custom_emoji_id,
    })),
    editTopicIcon: async (chatId, messageThreadId, iconCustomEmojiId) => {
      await bot.api.editForumTopic(chatId, messageThreadId, {
        icon_custom_emoji_id: iconCustomEmojiId,
      });
    },
  });

  if (config.jiraPanel) {
    const panelConfig = config.jiraPanel;
    const messageOptions = (message: JiraPanelMessage) => ({
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      reply_markup: jiraPanelKeyboard(message.rows),
    });
    bot.jiraPanel = new JiraPanel({
      chatId: panelConfig.chatId,
      topicId: panelConfig.topicId,
      client: new JiraClient(panelConfig.clientPath),
      send: async (message) => {
        const sent = await bot.api.sendMessage(panelConfig.chatId, message.html, {
          ...messageOptions(message),
          message_thread_id: panelConfig.topicId,
        });
        return sent.message_id;
      },
      edit: async (messageId, message) => {
        try {
          await bot.api.editMessageText(
            panelConfig.chatId,
            messageId,
            message.html,
            messageOptions(message),
          );
        } catch (error) {
          if (!isMessageNotModifiedError(error)) throw error;
        }
      },
      pin: async (messageId) => {
        await bot.api.pinChatMessage(panelConfig.chatId, messageId, {
          disable_notification: true,
        });
      },
      store: createJiraPanelStore(path.join(config.workspace, ".telecodex", "jira-panel.json")),
    });
  }

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean }
  >();
  const inbox = new InboxStore(path.join(config.workspace, ".telecodex", "inbox.json"));
  const gitlab =
    config.gitlabUrl && config.gitlabToken
      ? new GitLabClient(config.gitlabUrl, config.gitlabToken)
      : undefined;
  const pendingMergeRequests = new Map<string, MergeRequestSummary>();
  const pendingMergeRequestButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  /** Drafted GitLab comments awaiting a tap; a restart just expires them. */
  const pendingDoneDrafts = new Map<number, { key: string; body: string }>();
  let nextDoneDraftId = 1;
  const pendingBatches = new Map<string, InboxItem[][]>();
  let nextBatchId = 1;
  /** Duplicate choices intentionally expire on restart instead of guessing a branch. */
  const pendingDuplicateDecisions = new Map<
    number,
    { group: InboxItem[]; previousTicketId: number }
  >();
  let nextDuplicateDecisionId = 1;
  const pendingProjectPicks = new Map<TelegramContextKey, string[]>();
  const pendingProjectButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingProjectSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingNewThreads = new Map<TelegramContextKey, { workspace: string }>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const promptTails = new Map<TelegramContextKey, Promise<void>>();
  const activeJobIds = new Map<TelegramContextKey, string>();

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    pendingNewThreads.delete(key);
    pendingWorkspacePicks.delete(key);
    pendingWorkspaceButtons.delete(key);
    pendingModelButtons.delete(key);
    lastPromptInput.delete(key);
    promptTails.delete(key);
    activeJobIds.delete(key);
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transcribing: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(state?.processing || state?.switching || state?.transcribing || session?.isProcessing());
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionService): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const selectedChoiceId = (session: CodexSessionService): string | undefined => {
    const info = session.getInfo();
    return info.nextModelChoiceId ?? info.modelChoiceId ?? config.defaultModelChoiceId;
  };

  const sendPromptModelPicker = async (
    job: PersistentTelegramJob,
    session: CodexSessionService,
  ): Promise<void> => {
    if (!job.selectionToken) throw new Error(`Telegram job ${job.id} has no selection token`);
    const choices = session.listModelChoices();
    if (!choices.length) throw new Error("No models available");
    await bot.api.sendMessage(job.chatId, "Choose a model for this new thread:", {
      ...(job.messageThreadId ? { message_thread_id: job.messageThreadId } : {}),
      reply_markup: modelChoiceKeyboard(
        choices,
        (choice) => promptModelCallback(job.selectionToken!, choice.id),
        selectedChoiceId(session),
      ),
    });
  };

  const sendStartModelPicker = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
    workspace: string,
  ): Promise<void> => {
    const choices = session.listModelChoices();
    if (!choices.length) {
      await safeReply(ctx, escapeHTML("No models available."), { fallbackText: "No models available." });
      return;
    }
    pendingNewThreads.set(contextKey, { workspace });
    await safeReply(ctx, "<b>Select model for new thread:</b>", {
      fallbackText: "Select model for new thread:",
      replyMarkup: modelChoiceKeyboard(
        choices,
        (choice) => `startmodel:${choice.id}`,
        selectedChoiceId(session),
      ),
    });
  };

  const cleanupJobInbox = async (job: PersistentTelegramJob | undefined): Promise<void> => {
    if (!job?.cleanupInbox) return;
    await cleanupInbox(job.cleanupInbox.workspace, job.cleanupInbox.turnId);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create thread: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create thread: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const executeUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    persistentJob: PersistentTelegramJob,
  ): Promise<void> => {
    if (jobStore.get(persistentJob.id)?.state === "aborted") return;
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;

    const busyState = getBusyState(contextKey);
    busyState.processing = true;

    const abortKeyboard = new InlineKeyboard().text("⏹ Abort", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    let accumulatedText = "";
    let fallbackAccumulatedText = "";
    let currentAgentPhase: string | undefined;
    let finalized = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let hookBlock: AppServerHookBlock | undefined;
    const generatedImages: Array<{ path?: string; base64?: string }> = [];
    let codexCompleted = false;

    const progress = new TurnProgressPresenter({
      heartbeatMs: config.telegramProgressHeartbeatMs,
      send: async (message) => {
        const sent = await sendTextMessage(bot.api, chatId, message.html, {
          parseMode: "HTML",
          fallbackText: message.plain,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        return sent.message_id;
      },
      edit: async (messageId, message, heartbeat) => {
        await safeEditMessage(bot, chatId, messageId, message.html, {
          parseMode: "HTML",
          fallbackText: message.plain,
          replyMarkup: heartbeat ? abortKeyboard : new InlineKeyboard(),
        });
      },
    });

    let typingInterval: NodeJS.Timeout | undefined;

    const sendTyping = (): void => {
      void bot.api.sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      }).catch(() => {});
    };

    const startTyping = (): void => {
      if (typingInterval) return;
      sendTyping();
      typingInterval = setInterval(sendTyping, TYPING_INTERVAL_MS);
    };

    const stopTyping = (): void => {
      if (!typingInterval) return;
      clearInterval(typingInterval);
      typingInterval = undefined;
    };

    startTyping();

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const deliverRenderedChunks = async (
      chunks: RenderedChunk[],
      threadActionMarkdown = "",
    ): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      for (const [index, chunk] of chunks.entries()) {
        const partKey = `final:${index}`;
        if (jobStore.hasPart(persistentJob.id, partKey)) continue;
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          replyMarkup: finalChunkThreadKeyboard(
            threadActionMarkdown,
            index,
            chunks.length,
          ),
          messageThreadId,
        });
        jobStore.markPartSent(persistentJob.id, partKey);
      }
    };

    /**
     * Telegram renders an attached `.md` far better than an answer chopped into
     * four messages, so a long one travels as a file with its opening as the
     * caption. Returns false when it could not be sent, so the caller can still
     * deliver the answer the plain way.
     */
    const deliverMarkdownDocument = async (markdown: string): Promise<boolean> => {
      const partKey = "final:document";
      if (jobStore.hasPart(persistentJob.id, partKey)) {
        return true;
      }

      const document = buildMarkdownDocument(markdown);
      const [caption] = splitMarkdownForTelegram(document.caption);
      try {
        await bot.api.sendDocument(
          chatId,
          new InputFile(Buffer.from(document.content, "utf8"), document.fileName),
          {
            caption: caption.text,
            parse_mode: "HTML",
            ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
            reply_markup: finalChunkThreadKeyboard(markdown, 0, 1),
          },
        );
        jobStore.markPartSent(persistentJob.id, partKey);
        return true;
      } catch (error) {
        console.error("Failed to send the answer as a document:", formatError(error));
        return false;
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;

      stopTyping();

      const finalText = buildFinalResponseText(accumulatedText);
      if (!finalText) {
        // A hook that blocked the prompt ends the turn as a success with nothing
        // in it, so an empty turn is the only chance to report the block.
        const emptyTurnText = hookBlock
          ? `**⛔ Ход остановлен хуком \`${hookBlock.eventName}\`**\n\n${hookBlock.reason}`
          : "**✅ Done**";
        await deliverRenderedChunks(splitMarkdownForTelegram(emptyTurnText));
        return;
      }

      const chunks = splitMarkdownForTelegram(finalText);
      if (chunks.length > 1 && (await deliverMarkdownDocument(finalText))) {
        return;
      }

      await deliverRenderedChunks(chunks, finalText);
    };

    const deliverGeneratedImages = async (): Promise<void> => {
      for (const [index, image] of generatedImages.entries()) {
        const partKey = `image:${index}`;
        if (jobStore.hasPart(persistentJob.id, partKey)) continue;
        let imagePath = image.path;
        let temporary = false;
        if (!imagePath && image.base64) {
          imagePath = path.join(tmpdir(), `telecodex-generated-${randomUUID()}.png`);
          await writeFile(imagePath, Buffer.from(image.base64, "base64"));
          temporary = true;
        }
        if (!imagePath) continue;

        try {
          await bot.api.sendPhoto(chatId, new InputFile(imagePath), {
            ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
          });
          jobStore.markPartSent(persistentJob.id, partKey);
        } catch (photoError) {
          try {
            await bot.api.sendDocument(chatId, new InputFile(imagePath, path.basename(imagePath)), {
              ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
            });
            jobStore.markPartSent(persistentJob.id, partKey);
          } catch (documentError) {
            console.error("Failed to send generated image", { photoError, documentError });
          }
        } finally {
          if (temporary) await unlink(imagePath).catch(() => {});
        }
      }
    };

    const callbacks: CodexSessionCallbacks = {
      onQueued: (status) => {
        stopTyping();
        const text = status.reason === "global-limit"
          ? `🕓 Очередь №${status.position} · активно ${status.active}/${status.limit}`
          : `⏳ Сессия занята в Codex · очередь №${status.position}`;
        void sendTextMessage(bot.api, chatId, escapeHTML(text), {
          fallbackText: text,
          messageThreadId,
        }).catch((error) => {
          console.error("Failed to send queue status", error);
        });
      },
      onStarted: (turnId) => {
        jobStore.update(persistentJob.id, { state: "active", turnId });
        if (isTopicActivityEligible(messageThreadId)) {
          void topicActivity.start(parsed.chatId, messageThreadId);
        }
        startTyping();
      },
      onAgentMessageStart: ({ phase }) => {
        currentAgentPhase = phase;
        if (fallbackAccumulatedText) fallbackAccumulatedText += "\n\n";
        if (phase === "final_answer" && accumulatedText) accumulatedText += "\n\n";
      },
      onAgentMessageEnd: () => {
        currentAgentPhase = undefined;
      },
      onTextDelta: (delta: string) => {
        fallbackAccumulatedText += delta;
        if (currentAgentPhase === "final_answer") accumulatedText += delta;
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        progress.toolStarted();
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        void progress.updatePlan(items).catch((error) => {
          console.error("Failed to update progress checkpoint", error);
        });
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onGeneratedImage: (image) => {
        generatedImages.push(image);
      },
      onHookBlocked: (block) => {
        hookBlock = block;
      },
      onAgentEnd: () => {},
    };

    try {
      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        jobStore.update(persistentJob.id, { state: "failed" });
        return;
      }

      jobStore.update(persistentJob.id, { threadId: session.getInfo().threadId });
      if ((session.getInfo().modelProvider ?? "openai") === "openai") {
        const authStatus = await checkAuthStatus(config.codexApiKey);
        if (!authStatus.authenticated) {
          jobStore.update(persistentJob.id, { state: "failed" });
          await safeReply(
            ctx,
            [
              "<b>⚠️ Codex is not authenticated.</b>",
              "",
              `<code>${escapeHTML(authStatus.detail)}</code>`,
              "",
              "Use /login to start authentication, or set CODEX_API_KEY on the host.",
            ].join("\n"),
            {
              fallbackText: [
                "⚠️ Codex is not authenticated.",
                "",
                authStatus.detail,
                "",
                "Use /login to start authentication, or set CODEX_API_KEY on the host.",
              ].join("\n"),
            },
          );
          return;
        }
      }

      await progress.start();
      const latestJob = jobStore.get(persistentJob.id)!;
      if (
        latestJob.turnId &&
        (latestJob.state === "active" || latestJob.state === "delivering")
      ) {
        await session.recoverPrompt(latestJob.turnId, callbacks);
      } else {
        await session.prompt(userInput, callbacks);
      }
      if (hookBlock?.eventName === "userPromptSubmit" && (await reopenThread(session, config.threadReopenCommand))) {
        // The daemon can be holding a thread whose rollout changed underneath it,
        // and the hook is the only signal we get. Now that it has been re-read,
        // the prompt is worth exactly one more try.
        hookBlock = undefined;
        await session.prompt(userInput, callbacks);
      }
      codexCompleted = true;
      jobStore.update(persistentJob.id, { state: "delivering" });
      updateSessionMetadata(contextKey, session);
      if (!accumulatedText.trim()) accumulatedText = fallbackAccumulatedText;
      await progress.complete();
      await finalizeResponse();
      await deliverGeneratedImages();
      jobStore.update(persistentJob.id, { state: "completed" });
    } catch (error) {
      stopTyping();
      if (!accumulatedText.trim()) accumulatedText = fallbackAccumulatedText;
      await progress.fail(friendlyErrorText(error)).catch((progressError) => {
        console.error("Failed to mark progress checkpoint as failed", progressError);
      });
      if (jobStore.get(persistentJob.id)?.state !== "aborted") {
        jobStore.update(persistentJob.id, { state: codexCompleted ? "delivering" : "failed" });
      }
      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        const chunks = splitMarkdownForTelegram(combinedText);
        try {
          await deliverRenderedChunks(chunks, combinedText);
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      stopTyping();
      busyState.processing = false;
      if (isTopicActivityEligible(messageThreadId)) {
        await topicActivity.finish(parsed.chatId, messageThreadId);
      }
    }
  };

  const handleUserPrompt = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    recoveredJob?: PersistentTelegramJob,
    options: PromptDispatchOptions = {},
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const persistentJob = recoveredJob ?? jobStore.create({
      contextKey,
      chatId: parsed.chatId,
      messageThreadId: parsed.messageThreadId,
      threadId: session.getInfo().threadId,
      input: userInput,
      cleanupInbox: options.cleanupInbox,
    });
    if (
      !session.hasActiveThread() &&
      !persistentJob.modelChoiceId &&
      options.requireModelSelection !== false
    ) {
      const awaiting = persistentJob.state === "awaiting-model"
        ? persistentJob
        : jobStore.awaitModelSelection(persistentJob.id);
      return sendPromptModelPicker(awaiting, session);
    }
    const previous = promptTails.get(contextKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        activeJobIds.set(contextKey, persistentJob.id);
        // Every turn gets an outbox, not just the ones that arrived with a file:
        // otherwise an agent that produces a file has nowhere to put it. A
        // read-only context is the exception, since it cannot write one.
        const outDir = outboxPath(session.getCurrentWorkspace(), persistentJob.id);
        const canWriteFiles = session.getInfo().sandboxMode !== "read-only";
        // The input is either bare text or the object form; normalise before adding to it.
        const base = typeof userInput === "string" ? { text: userInput } : userInput;
        const input: CodexPromptInput = canWriteFiles
          ? {
              ...base,
              stagedFileInstructions: [
                base.stagedFileInstructions,
                buildOutboxInstructions(outDir),
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : base;
        try {
          if (canWriteFiles) {
            await ensureOutDir(outDir);
          }
          await executeUserPrompt(ctx, contextKey, chatId, session, input, persistentJob);
        } finally {
          if (activeJobIds.get(contextKey) === persistentJob.id) activeJobIds.delete(contextKey);
          try {
            if (canWriteFiles) {
              await deliverArtifacts(ctx, chatId, outDir, parsed.messageThreadId);
            }
          } catch (artifactError) {
            console.error("Failed to deliver artifacts:", artifactError);
          }
          const finishedJob = jobStore.get(persistentJob.id);
          if (
            finishedJob &&
            (finishedJob.state === "completed" ||
              finishedJob.state === "failed" ||
              finishedJob.state === "aborted")
          ) {
            await cleanupJobInbox(finishedJob);
          }
        }
      });
    const tail = current
      .catch(() => undefined)
      .finally(() => {
        if (promptTails.get(contextKey) === tail) promptTails.delete(contextKey);
      });
    promptTails.set(contextKey, tail);
    return current;
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to send artifact ${artifact.name}:`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    const messageThreadId = ctx.message?.message_thread_id;
    const iconChange = topicIconChangeFromMessage(ctx.message);
    if (iconChange && ctx.chat && isTopicActivityEligible(messageThreadId)) {
      topicActivity.rememberIdleIcon(
        ctx.chat.id,
        messageThreadId,
        iconChange.iconCustomEmojiId,
      );
    }
    if (bot.statusBoard?.isDashboardTopic(messageThreadId)) {
      await bot.statusBoard.protectTopicMessage(
        messageThreadId,
        isTopicLifecycleMessage(ctx.message) ? undefined : ctx.message?.message_id,
      );
      return;
    }

    if (isTopicLifecycleMessage(ctx.message)) {
      return;
    }

    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "Not authenticated. Use /login or set CODEX_API_KEY.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("jira", async (ctx) => {
    const panel = bot.jiraPanel;
    const chatId = ctx.chat?.id;
    const topicId = ctx.message?.message_thread_id;
    if (!panel || !config.jiraPanel) {
      await safeReply(ctx, "<b>Jira panel is not configured.</b>", {
        fallbackText: "Jira panel is not configured.",
      });
      return;
    }
    if (!panel.matches(chatId, topicId)) {
      const url = topicUrl(config.jiraPanel.chatId, config.jiraPanel.topicId);
      await safeReply(ctx, `Jira panel: <a href="${url}">open topic</a>`, {
        fallbackText: `Jira panel: ${url}`,
      });
      return;
    }

    try {
      await panel.open();
    } catch (error) {
      await safeReply(ctx, `<b>Jira panel failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Jira panel failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.callbackQuery(/^jira:/, async (ctx) => {
    const panel = bot.jiraPanel;
    const chatId = ctx.chat?.id;
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    if (!panel?.matches(chatId, topicId)) {
      await ctx.answerCallbackQuery({ text: "Jira panel is available in its configured topic" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Обновляю..." });
    await panel.handleCallback(ctx.callbackQuery.data);
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
      `Detail: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          "Run <code>codex login</code> on the host, or set CODEX_API_KEY in .env.",
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            "Run 'codex login' on the host, or set CODEX_API_KEY in .env.",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Login failed.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          "<b>Cannot logout via Telegram when using CODEX_API_KEY.</b>",
          "",
          "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            "Cannot logout via Telegram when using CODEX_API_KEY.",
            "",
            "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        "Run <code>codex logout</code> on the host.",
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          "Run 'codex logout' on the host.",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Logged out.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Install <code>parakeet-coreml</code> + ffmpeg, or set <code>OPENAI_API_KEY</code>.",
          "<i>Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Install parakeet-coreml + ffmpeg, or set OPENAI_API_KEY.",
            "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    await safeReply(ctx, `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`, {
      fallbackText: `Voice backends: ${joined}`,
    });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return;
    }

    const workspaces = session.listWorkspaces();
    if (workspaces.length <= 1) {
      await sendStartModelPicker(
        ctx,
        contextKey,
        session,
        workspaces[0] ?? session.getCurrentWorkspace(),
      );
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${getWorkspaceShortName(workspace)}`,
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");

    await safeReply(ctx, "<b>Select workspace for new thread:</b>", {
      fallbackText: "Select workspace for new thread:",
      replyMarkup: keyboard,
    });
  });

  bot.command("abort", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    try {
      const queuedJob = [...jobStore.listRecoverable(), ...jobStore.listAwaitingModel()]
        .filter((job) => job.contextKey === contextKey)
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1);
      if (queuedJob && activeJobIds.get(contextKey) !== queuedJob.id) {
        jobStore.update(queuedJob.id, { state: "aborted" });
        await cleanupJobInbox(queuedJob);
        await safeReply(ctx, escapeHTML("Aborted queued operation"), {
          fallbackText: "Aborted queued operation",
        });
        return;
      }
      const activeJobId = activeJobIds.get(contextKey);
      if (activeJobId) jobStore.update(activeJobId, { state: "aborted" });
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
        fallbackText: "Nothing to retry. Send a message first.",
      });
      return;
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, cached);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(info)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(info)];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>Selected launch profile:</b> <code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedLaunchProfile))}</code>`,
      "",
      "Select a profile for new or reattached threads:",
    ];
    const plainLines = [
      `Selected launch profile: ${selectedLaunchProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedLaunchProfile)}`,
      "",
      "Select a profile for new or reattached threads:",
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>Selected profile uses danger-full-access.</i>");
      plainLines.splice(2, 0, "⚠️ Selected profile uses danger-full-access.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Active thread still uses:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Active thread still uses: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to hand back."), {
        fallbackText: "No active thread to hand back.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Thread handed back to Codex CLI.",
        "",
        "Run this in your terminal:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Thread handed back to Codex CLI.</b>",
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot attach while a prompt is running."), {
        fallbackText: "Cannot attach while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <thread-id>"), {
        fallbackText: "Usage: /attach <thread-id>",
      });
      return;
    }

    if (!getThread(threadId)) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown Codex thread: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown Codex thread: ${threadId}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Attached to thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Attached to thread.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();

    if (threadId) {
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        const html = `<b>Switched thread.</b>\n\n${renderSessionInfoHTML(info)}`;
        const plain = `Switched thread.\n\n${renderSessionInfoPlain(info)}`;
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const sessions = session.listAllSessions(50);
    if (sessions.length === 0) {
      await safeReply(ctx, escapeHTML("No recent threads found."), {
        fallbackText: "No recent threads found.",
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model
            ? `${listedSession.modelProvider ?? "openai"}/${listedSession.model}`
            : undefined,
          isActive: listedSession.id === activeThreadId,
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");

    await safeReply(ctx, `<b>Recent threads</b> (${orderedSessions.length}):\nTap to switch.`, {
      fallbackText: `Recent threads (${orderedSessions.length}):\nTap to switch.`,
      replyMarkup: keyboard,
    });
  });

  // Threads come from the Codex database, so a session stays reachable even
  // after someone deletes the forum topic that used to be bound to it.
  const PROJECT_THREAD_LIMIT = 100;

  const projectSessionsKeyboard = (
    contextKey: TelegramContextKey,
    group: ProjectGroup,
  ): InlineKeyboard => {
    const buttons = sessionButtons(group);
    pendingProjectSessionButtons.set(contextKey, buttons);
    return paginateKeyboard(buttons, 0, "projsess").row().text("← Projects", "proj_back");
  };

  const projectsKeyboard = (
    contextKey: TelegramContextKey,
    groups: ProjectGroup[],
  ): InlineKeyboard | undefined => {
    if (groups.length === 0) {
      return undefined;
    }
    const buttons = projectButtons(groups);
    pendingProjectPicks.set(contextKey, groups.map((group) => group.workspace));
    pendingProjectButtons.set(contextKey, buttons);
    return paginateKeyboard(buttons, 0, "proj");
  };

  bot.command("projects", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const groups = groupThreadsByProject(listUserThreads(PROJECT_THREAD_LIMIT));
    const filter = (ctx.message?.text ?? "")
      .replace(/^\/projects(?:@\w+)?\s*/, "")
      .trim()
      .toLocaleLowerCase("en-US");

    if (filter) {
      const group = groups.find(
        (candidate) => candidate.name.toLocaleLowerCase("en-US") === filter,
      );
      if (!group) {
        const known = groups.map((candidate) => candidate.name).join(", ") || "none";
        const text = `No project "${filter}". Known projects: ${known}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        return;
      }

      await safeReply(ctx, renderProjectHTML(group), {
        replyMarkup: projectSessionsKeyboard(contextKey, group),
      });
      return;
    }

    await safeReply(ctx, renderProjectsHTML(groups), {
      replyMarkup: projectsKeyboard(contextKey, groups),
    });
  });

  bot.callbackQuery(/^proj_(\d+)$/, async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!contextKey || !chatId || !messageId || Number.isNaN(index)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const workspace = pendingProjectPicks.get(contextKey)?.[index];
    if (workspace === undefined) {
      await ctx.answerCallbackQuery({ text: "Expired, run /projects again" });
      return;
    }

    const group = groupThreadsByProject(listUserThreads(PROJECT_THREAD_LIMIT)).find(
      (candidate) => candidate.workspace === workspace,
    );
    if (!group) {
      await ctx.answerCallbackQuery({ text: "This project has no sessions any more" });
      return;
    }

    await ctx.answerCallbackQuery();
    await safeEditMessage(bot, chatId, messageId, renderProjectHTML(group), {
      replyMarkup: projectSessionsKeyboard(contextKey, group),
    });
  });

  bot.callbackQuery("proj_back", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;

    if (!contextKey || !chatId || !messageId) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
    const groups = groupThreadsByProject(listUserThreads(PROJECT_THREAD_LIMIT));
    await safeEditMessage(bot, chatId, messageId, renderProjectsHTML(groups), {
      replyMarkup: projectsKeyboard(contextKey, groups),
    });
  });

  const INBOX_QUIET_MS = 2_000;
  const INBOX_TOPIC_PAUSE_MS = 3_000;

  const inboxUsage = [
    "Использование:",
    "/inbox on [путь] — сделать этот топик инбоксом",
    "/inbox off — выключить",
    "/inbox status — показать настройки",
  ].join("\n");

  bot.command("inbox", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const args = (ctx.message?.text ?? "").replace(/^\/inbox(?:@\w+)?\s*/, "").trim();
    const [action, ...rest] = args.split(/\s+/);
    const settings = inbox.get(contextKey);

    if (action === "off") {
      const text = inbox.disable(contextKey)
        ? "Инбокс выключен, сообщения снова идут в сессию этого топика."
        : "Этот топик и так не инбокс.";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    if (action === "on") {
      const workspace = rest.join(" ").trim() || registry.listContexts().find(
        (entry) => entry.contextKey === contextKey,
      )?.workspace || config.workspace;
      inbox.enable(contextKey, {
        workspace,
        // A ticket topic is a working topic: same profile as one opened by hand,
        // or it cannot touch the repository it was opened for.
        launchProfileId: config.defaultLaunchProfileId,
        template: settings?.template ?? DEFAULT_TICKET_TEMPLATE,
        iconCustomEmojiId: settings?.iconCustomEmojiId,
      });
      const html = [
        "<b>Инбокс включён.</b>",
        `Проект: <code>${escapeHTML(workspace)}</code>`,
        `Профиль запуска тикетов: <code>${escapeHTML(config.defaultLaunchProfileId)}</code>`,
        "",
        "Пересылай сюда обращения — на каждое заведу отдельный топик.",
      ].join("\n");
      await safeReply(ctx, html, { fallbackText: "Инбокс включён." });
      return;
    }

    if (action === "status" || action === "") {
      if (!settings) {
        const text = `Этот топик не инбокс.\n\n${inboxUsage}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        return;
      }
      const html = [
        "<b>Инбокс включён.</b>",
        `Проект: <code>${escapeHTML(settings.workspace)}</code>`,
        `Профиль: <code>${escapeHTML(settings.launchProfileId ?? "по умолчанию")}</code>`,
      ].join("\n");
      await safeReply(ctx, html, { fallbackText: "Инбокс включён." });
      return;
    }

    await safeReply(ctx, escapeHTML(inboxUsage), { fallbackText: inboxUsage });
  });

  bot.command("tickets", async (ctx) => {
    const unresolved = inbox.listUnresolved();
    if (unresolved.length === 0) {
      const text = "Открытых тикетов нет.";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const lines = ["<b>Открытые тикеты</b>"];
    for (const group of groupTicketsByWorkspace(unresolved)) {
      lines.push("", `📁 <code>${escapeHTML(group.workspace)}</code>`);
      for (const ticket of group.tickets) {
        const chatId = parseContextKey(ticket.inboxContextKey).chatId;
        const label = escapeHTML(ticketHeading(ticket));
        const started = ticket.startedAt === undefined ? "" : " · разбор запущен";
        lines.push(
          ticket.workTopicId
            ? `• <a href="${topicUrl(chatId, ticket.workTopicId)}">${label}</a>${started}`
            : `• ${label}${started}`,
        );
      }
    }

    const html = lines.join("\n");
    await safeReply(ctx, html, {
      fallbackText: unresolved.map((ticket) => ticketHeading(ticket)).join("\n"),
    });
  });

  const ticketTextOf = (group: InboxItem[]): string =>
    group
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n\n")
      .trim();

  /** Only attachments are worth forwarding; the card already quotes the text. */
  const forwardAttachments = async (
    group: InboxItem[],
    messageThreadId: number,
    ticketId: number,
  ): Promise<void> => {
    const [first] = group;
    for (const item of group.filter((entry) => entry.hasAttachment)) {
      try {
        await bot.api.forwardMessage(first.chatId, first.chatId, item.messageId, {
          message_thread_id: messageThreadId,
        });
      } catch (error) {
        console.warn(
          `Failed to forward message ${item.messageId} into ticket #${ticketId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };

  const appendToTicket = async (
    ticket: Ticket,
    group: InboxItem[],
    text: string,
    source: string,
  ): Promise<void> => {
    const [first] = group;
    const card = [
      `\u2795 <b>Дополнение к ${escapeHTML(ticketHeading(ticket))}</b>`,
      `Источник: ${escapeHTML(source)}`,
      "",
      escapeHTML(text || "(без текста, см. пересланные сообщения ниже)"),
    ].join("\n");

    await sendTextMessage(bot.api, first.chatId, card, {
      messageThreadId: ticket.workTopicId,
      fallbackText: `Дополнение к ${ticketHeading(ticket)}. Источник: ${source}`,
    });

    await forwardAttachments(group, ticket.workTopicId, ticket.id);

    const url = topicUrl(first.chatId, ticket.workTopicId);
    await sendTextMessage(
      bot.api,
      first.chatId,
      `Уже заведён <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a> — добавил туда.`,
      {
        messageThreadId: parseContextKey(first.contextKey).messageThreadId,
        fallbackText: `${ticketHeading(ticket)}: ${url}`,
      },
    );
  };

  const createTicket = async (
    group: InboxItem[],
    options: {
      skipDuplicateCheck?: boolean;
      supersedesId?: number;
      continueTicketId?: number;
    } = {},
  ): Promise<void> => {
    const [first] = group;
    if (!first) {
      return;
    }
    const settings = inbox.get(first.contextKey);
    if (!settings) {
      return;
    }

    const text = ticketTextOf(group);
    const source = describeSource(first.message);
    const externalKey = extractTicketKey(text);

    if (externalKey && !options.skipDuplicateCheck) {
      const candidates = inbox.listTicketsByKey(first.contextKey, externalKey);
      for (const candidate of candidates) {
        if (candidate.resolvedAt !== undefined || !candidate.workTopicId) {
          continue;
        }
        const live = await topicIsAlive(first.chatId, candidate.workTopicId).catch(() => false);
        if (live) {
          await appendToTicket(candidate, group, text, source);
          return;
        }
      }

      const previous = candidates[0];
      if (previous) {
        const decisionId = nextDuplicateDecisionId++;
        pendingDuplicateDecisions.set(decisionId, { group, previousTicketId: previous.id });
        const message = [
          `Нашёл ${ticketHeading(previous)}, но активного рабочего топика у него нет.`,
          "Продолжить старый тикет или завести новый?",
        ].join("\n");
        await sendTextMessage(bot.api, first.chatId, escapeHTML(message), {
          messageThreadId: parseContextKey(first.contextKey).messageThreadId,
          fallbackText: message,
          replyMarkup: duplicateTicketKeyboard(decisionId),
        });
        return;
      }
    }

    const prompt = buildTicketPrompt(settings.template, { source, message: text });
    const continuedTicket = options.continueTicketId
      ? inbox.getTicket(options.continueTicketId)
      : undefined;
    if (options.continueTicketId && !continuedTicket) {
      throw new Error(`Ticket ${options.continueTicketId} no longer exists`);
    }
    const pendingTicket = continuedTicket ?? inbox.createTicket({
      inboxContextKey: first.contextKey,
      externalKey,
      workTopicId: 0,
      workspace: settings.workspace,
      launchProfileId: settings.launchProfileId,
      prompt,
      source,
      supersedesId: options.supersedesId,
    });

    const topicName = ticketTopicName(pendingTicket.id, text);
    const topic = await bot.api.createForumTopic(
      first.chatId,
      topicName,
      settings.iconCustomEmojiId
        ? { icon_custom_emoji_id: settings.iconCustomEmojiId }
        : undefined,
    );
    topicActivity.rememberIdleIcon(
      first.chatId,
      topic.message_thread_id,
      settings.iconCustomEmojiId ?? null,
    );
    const ticket = continuedTicket
      ? inbox.continueTicket(continuedTicket.id, {
          workTopicId: topic.message_thread_id,
          prompt,
          source,
        })!
      : pendingTicket;
    if (!continuedTicket) {
      inbox.attachTopic(ticket.id, topic.message_thread_id);
    }
    registry.setContextDefaults(
      contextKeyFromMessage(first.chatId, topic.message_thread_id),
      { workspace: settings.workspace, launchProfileId: settings.launchProfileId, topicName },
    );

    const card = [
      `🎫 <b>${escapeHTML(ticketHeading(ticket))}</b>`,
      `Источник: ${escapeHTML(source)}`,
      `Проект: <code>${escapeHTML(settings.workspace)}</code>`,
      ticket.supersedesId
        ? `Предыдущий: ${escapeHTML(ticketHeading(inbox.getTicket(ticket.supersedesId) ?? { id: ticket.supersedesId }))}`
        : undefined,
      "",
      escapeHTML(text || "(без текста, см. пересланные сообщения ниже)"),
    ].filter((line): line is string => line !== undefined).join("\n");

    await sendTextMessage(bot.api, first.chatId, card, {
      messageThreadId: topic.message_thread_id,
      fallbackText: `${ticketHeading(ticket)}. Источник: ${source}`,
      replyMarkup: ticketKeyboard(ticket),
    });

    await forwardAttachments(group, topic.message_thread_id, ticket.id);

    const url = topicUrl(first.chatId, topic.message_thread_id);
    await sendTextMessage(
      bot.api,
      first.chatId,
      `${continuedTicket ? "Тикет продолжен" : "Заведён тикет"} <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a>.`,
      {
        messageThreadId: parseContextKey(first.contextKey).messageThreadId,
        fallbackText: `${ticketHeading(ticket)}: ${url}`,
      },
    );
  };

  const createTicketsSequentially = async (groups: InboxItem[][]): Promise<void> => {
    for (const [index, group] of groups.entries()) {
      if (index > 0) {
        // Telegram rate-limits topic creation hard; pace them.
        await new Promise((resolve) => setTimeout(resolve, INBOX_TOPIC_PAUSE_MS));
      }
      try {
        await createTicket(group);
      } catch (error) {
        console.error(
          "Failed to create ticket:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };

  const askHowToSplit = async (groups: InboxItem[][]): Promise<void> => {
    const first = groups[0]?.[0];
    if (!first) {
      return;
    }
    const batchId = String(nextBatchId++);
    pendingBatches.set(batchId, groups);

    const keyboard = new InlineKeyboard()
      .text("Одним тикетом", `inbox_batch:${batchId}:one`)
      .row()
      .text(`По отдельности (${groups.length})`, `inbox_batch:${batchId}:each`)
      .row()
      .text("Отмена", `inbox_batch:${batchId}:cancel`);

    const text = `Переслано сообщений: ${groups.length}. Как их разобрать?`;
    await sendTextMessage(bot.api, first.chatId, escapeHTML(text), {
      messageThreadId: parseContextKey(first.contextKey).messageThreadId,
      fallbackText: text,
      replyMarkup: keyboard,
    });
  };

  const inboxBuffer = new BurstBuffer<InboxItem>(INBOX_QUIET_MS, (items) => {
    const groups = groupBurst(items);
    const run = groups.length === 1 ? createTicket(groups[0]) : askHowToSplit(groups);
    void run.catch((error) => {
      console.error(
        "Inbox burst failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  });

  bot.callbackQuery(/^inbox_batch:(\d+):(one|each|cancel)$/, async (ctx) => {
    const batchId = ctx.match?.[1];
    const choice = ctx.match?.[2];
    const groups = batchId ? pendingBatches.get(batchId) : undefined;
    if (!groups) {
      await ctx.answerCallbackQuery({ text: "Устарело, перешли сообщения заново" });
      return;
    }
    pendingBatches.delete(batchId!);

    if (choice === "cancel") {
      await ctx.answerCallbackQuery({ text: "Отменено" });
      await ctx.editMessageText("Отменено, тикеты не заводились.");
      return;
    }

    await ctx.answerCallbackQuery({ text: "Завожу тикеты..." });
    const batches = choice === "one" ? [groups.flat()] : groups;
    await ctx.editMessageText(
      choice === "one" ? "Завожу один тикет..." : `Завожу тикетов: ${batches.length}...`,
    );
    await createTicketsSequentially(batches);
  });

  bot.callbackQuery(/^ticket_dup:(\d+):(reuse|new)$/, async (ctx) => {
    const decisionId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const choice = ctx.match?.[2];
    const pending = Number.isNaN(decisionId)
      ? undefined
      : pendingDuplicateDecisions.get(decisionId);
    if (!pending || (choice !== "reuse" && choice !== "new")) {
      await ctx.answerCallbackQuery({ text: "Выбор устарел, перешли сообщение заново" });
      return;
    }
    pendingDuplicateDecisions.delete(decisionId);

    await ctx.answerCallbackQuery({
      text: choice === "reuse" ? "Продолжаю тикет..." : "Создаю новый тикет...",
    });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // The decision message may already have lost its keyboard.
    }
    await createTicket(pending.group, {
      skipDuplicateCheck: true,
      ...(choice === "reuse"
        ? { continueTicketId: pending.previousTicketId }
        : { supersedesId: pending.previousTicketId }),
    });
  });

  bot.callbackQuery(/^ticket_start:(\d+)$/, async (ctx) => {
    const ticketId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const ticket = Number.isNaN(ticketId) ? undefined : inbox.getTicket(ticketId);
    if (!ticket) {
      await ctx.answerCallbackQuery({ text: "Тикет не найден" });
      return;
    }
    if (ticket.startedAt) {
      await ctx.answerCallbackQuery({ text: "Разбор уже запускали" });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Дождись окончания текущего прогона" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Запускаю разбор..." });
    inbox.markStarted(ticket.id);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: ticketKeyboard(inbox.getTicket(ticket.id)!) });
    } catch {
      // The card may already have lost its keyboard; nothing to undo.
    }
    await handleUserPrompt(ctx, contextKey, ctx.chat!.id, session, ticket.prompt);
  });

  bot.callbackQuery(/^ticket_done:(\d+)$/, async (ctx) => {
    const ticketId = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const ticket = Number.isNaN(ticketId) ? undefined : inbox.getTicket(ticketId);
    if (!ticket) {
      await ctx.answerCallbackQuery({ text: "Тикет не найден" });
      return;
    }
    if (!inbox.markResolved(ticket.id)) {
      await ctx.answerCallbackQuery({ text: "Тикет уже отмечен решённым" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Тикет решён" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // The card may already have lost its keyboard; nothing to undo.
    }

    const inboxContext = parseContextKey(ticket.inboxContextKey);
    const url = topicUrl(inboxContext.chatId, ticket.workTopicId);
    const text = `✅ <a href="${url}">${escapeHTML(ticketHeading(ticket))}</a> решён.`;
    await sendTextMessage(bot.api, inboxContext.chatId, text, {
      messageThreadId: inboxContext.messageThreadId,
      fallbackText: `${ticketHeading(ticket)} решён: ${url}`,
    });
    await bot.api.closeForumTopic(inboxContext.chatId, ticket.workTopicId);
  });

  const recipeMutes = new RecipeMutes(RECIPE_MUTES_PATH);

  /** Findings the scheduled recipes delivered; index is the position in that batch. */
  const findingFromCallback = (match: string | RegExpMatchArray | undefined) => {
    const groups = typeof match === "string" ? undefined : match;
    const run = readPendingRun(RECIPE_STATE_PATH, Number.parseInt(groups?.[1] ?? "", 10));
    const finding = run?.findings[Number.parseInt(groups?.[2] ?? "", 10)];
    return run && finding ? { run, finding } : undefined;
  };

  bot.callbackQuery(/^rmute:(\d+):(\d+)$/, async (ctx) => {
    const found = findingFromCallback(ctx.match ?? undefined);
    if (!found) {
      await ctx.answerCallbackQuery({ text: "Находка больше не доступна" });
      return;
    }

    recipeMutes.add(fingerprintFinding(found.finding));
    await ctx.answerCallbackQuery({ text: "Заглушено, больше не покажу" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // The message may already have lost its keyboard; nothing to undo.
    }
  });

  bot.callbackQuery(/^rfix:(\d+):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const contextKey = contextKeyFromCtx(ctx);
    const found = findingFromCallback(ctx.match ?? undefined);
    if (!chatId || !contextKey || !found) {
      await ctx.answerCallbackQuery({ text: "Находка больше не доступна" });
      return;
    }
    const { run, finding } = found;

    await ctx.answerCallbackQuery({ text: "Создаю тред..." });

    // A fix thread is just a ticket, so the start button and session defaults
    // are the ones the inbox already uses.
    const ticket = inbox.createTicket({
      inboxContextKey: contextKey,
      workTopicId: 0,
      workspace: run.cwd,
      // Same profile as any other topic. The prompt asks for a diff rather than
      // an edit, but a thread that cannot even fetch the repository is useless,
      // and "review" would mean on-request approvals nobody can grant from a topic.
      launchProfileId: config.defaultLaunchProfileId,
      prompt: buildFixPrompt(run.recipe, finding),
      source: `рецепт ${run.recipe}`,
    });

    const topicName = fixTopicName(finding);
    const topic = await bot.api.createForumTopic(chatId, topicName);
    inbox.attachTopic(ticket.id, topic.message_thread_id);
    registry.setContextDefaults(contextKeyFromMessage(chatId, topic.message_thread_id), {
      workspace: run.cwd,
      launchProfileId: config.defaultLaunchProfileId,
      topicName,
    });

    const card = [
      `\u{1F527} <b>Тред-фикс</b> \u00B7 ${escapeHTML(run.recipe)}`,
      `Проект: <code>${escapeHTML(run.cwd)}</code>`,
      "",
      escapeHTML(finding.description),
    ].join("\n");

    await sendTextMessage(bot.api, chatId, card, {
      messageThreadId: topic.message_thread_id,
      fallbackText: finding.description,
      replyMarkup: ticketKeyboard(ticket),
    });

    const url = topicUrl(chatId, topic.message_thread_id);
    await safeReply(ctx, `Тред заведён: <a href="${url}">${escapeHTML(fixTopicName(finding))}</a>`, {
      fallbackText: url,
    });
  });

  /** Big enough for a real review, small enough not to blow up the turn. */
  const MR_DIFF_LIMIT = 60_000;

  const repoWorkspace = (project: string): string => {
    const root = config.gitlabWorkspaceRoot;
    if (!root) {
      return config.workspace;
    }
    const candidate = path.join(root, project);
    return existsSync(candidate) ? candidate : root;
  };

  const gitlabMissingNotice = "GitLab не настроен: нужны GITLAB_URL, GITLAB_TOKEN и GITLAB_GROUP_ID в .env";

  bot.command("done", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    if (!gitlab || !config.gitlabGroupId) {
      await safeReply(ctx, escapeHTML(gitlabMissingNotice), { fallbackText: gitlabMissingNotice });
      return;
    }

    const topicId = ctx.message?.message_thread_id;
    const args = String(ctx.match ?? "").trim();
    const argKey = extractTicketKey(args);
    const key = (topicId ? inbox.findTicketByTopic(topicId)?.externalKey : undefined) ?? argKey;

    if (!key) {
      const text =
        "Не понял, о каком тикете речь. Запусти в топике тикета или укажи ключ: /done MIR-1234 что сделано";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    // When the key came from the arguments, it is not part of the comment text.
    const comment =
      argKey && args.toUpperCase().startsWith(argKey) ? args.slice(argKey.length).trim() : args;

    try {
      const open = await gitlab.listOpenMergeRequests(config.gitlabGroupId);
      const linked = linkedMergeRequests(open, key);

      if (linked.length === 0) {
        const text = `Открытых merge request с ${key} не нашёл.`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        return;
      }

      const body = buildDoneComment(key, comment);
      for (const mr of linked.slice(0, 5)) {
        const draftId = nextDoneDraftId;
        nextDoneDraftId += 1;
        pendingDoneDrafts.set(draftId, { key, body });

        await sendTextMessage(bot.api, chatId, renderDraftHTML(mr, body), {
          messageThreadId: topicId,
          fallbackText: body,
          replyMarkup: new InlineKeyboard()
            .text("\u{1F4E4} Отправить", `donesend:${draftId}:${mr.projectId}:${mr.iid}`)
            .text("\u2716\uFE0F Отмена", `donecancel:${draftId}`),
        });
      }
    } catch (error) {
      const text = `GitLab не ответил: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    }
  });

  bot.callbackQuery(/^donecancel:(\d+)$/, async (ctx) => {
    const groups = typeof ctx.match === "string" ? undefined : ctx.match;
    pendingDoneDrafts.delete(Number.parseInt(groups?.[1] ?? "", 10));
    await ctx.answerCallbackQuery({ text: "Отменено" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // The draft may already have lost its keyboard.
    }
  });

  bot.callbackQuery(/^donesend:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const groups = typeof ctx.match === "string" ? undefined : ctx.match;
    const draftId = Number.parseInt(groups?.[1] ?? "", 10);
    const draft = pendingDoneDrafts.get(draftId);
    if (!draft || !gitlab) {
      await ctx.answerCallbackQuery({ text: "Черновик устарел, набери /done заново" });
      return;
    }

    const projectId = Number.parseInt(groups?.[2] ?? "", 10);
    const iid = Number.parseInt(groups?.[3] ?? "", 10);
    await ctx.answerCallbackQuery({ text: "Отправляю..." });

    try {
      await gitlab.createMergeRequestNote(projectId, iid, draft.body);
      pendingDoneDrafts.delete(draftId);
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Nothing to undo if the keyboard is already gone.
      }
      const text = `Комментарий отправлен в !${iid}.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    } catch (error) {
      const text = `Не отправилось: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    }
  });

  bot.command("mr", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }
    if (!gitlab || !config.gitlabGroupId) {
      const text = "GitLab не настроен: нужны GITLAB_URL, GITLAB_TOKEN и GITLAB_GROUP_ID в .env";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    try {
      const mrs = await gitlab.listOpenMergeRequests(config.gitlabGroupId);
      if (mrs.length === 0) {
        await safeReply(ctx, escapeHTML("Открытых merge request нет."), {
          fallbackText: "Открытых merge request нет.",
        });
        return;
      }

      for (const mr of mrs) {
        pendingMergeRequests.set(`${mr.projectId}:${mr.iid}`, mr);
      }
      const buttons = mergeRequestButtons(mrs);
      pendingMergeRequestButtons.set(contextKey, buttons);

      await safeReply(
        ctx,
        `<b>Открытые merge request</b> (${mrs.length})\nТап — заведу топик и запущу ревью по диффу.`,
        {
          fallbackText: `Открытые merge request (${mrs.length})`,
          replyMarkup: paginateKeyboard(buttons, 0, "mrpage"),
        },
      );
    } catch (error) {
      const text = `Не смог получить список: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    }
  });

  bot.callbackQuery(/^mr:(\d+):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const key = `${ctx.match?.[1]}:${ctx.match?.[2]}`;
    const mr = pendingMergeRequests.get(key);

    if (!chatId || !gitlab) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!mr) {
      await ctx.answerCallbackQuery({ text: "Устарело, вызови /mr заново" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Тяну дифф..." });
    try {
      const changes = await gitlab.fetchChanges(mr.projectId, mr.iid);
      const topicName = mergeRequestTopicName(mr);
      const topic = await bot.api.createForumTopic(chatId, topicName);
      const workContextKey = contextKeyFromMessage(chatId, topic.message_thread_id);
      const workspace = repoWorkspace(mr.project);
      registry.setContextDefaults(workContextKey, {
        workspace,
        launchProfileId: config.defaultLaunchProfileId,
        topicName,
      });

      await sendTextMessage(bot.api, chatId, renderMergeRequestCardHTML(mr, changes), {
        messageThreadId: topic.message_thread_id,
        fallbackText: `!${mr.iid} ${mr.project}: ${mr.title}`,
      });

      const url = topicUrl(chatId, topic.message_thread_id);
      await safeReply(ctx, `Ревью <a href="${url}">!${mr.iid} ${escapeHTML(mr.project)}</a> запущено.`, {
        fallbackText: `Ревью !${mr.iid}: ${url}`,
      });

      // The prompt goes to the new topic's context, so all output lands there.
      const session = await registry.getOrCreate(workContextKey, { deferThreadStart: true });
      await handleUserPrompt(
        ctx,
        workContextKey,
        chatId,
        session,
        buildReviewPrompt(mr, changes, MR_DIFF_LIMIT),
      );
    } catch (error) {
      await safeReply(ctx, `<b>Не вышло:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Не вышло: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const models = session.listModelChoices();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const info = session.getInfo();
    const currentModel = info.model
      ? `${info.modelProvider ?? "openai"}/${info.model}`
      : "(default)";
    const selectedId = selectedChoiceId(session);
    const modelButtons = models.map((model) => ({
      label: `${model.label}${model.id === selectedId ? " ✓" : ""}`,
      callbackData: `model_${model.id}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Select a model for new threads:"].join("\n"),
      {
        fallbackText: [`Current model: ${currentModel}`, "", "Select a model for new threads:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.command("effort", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const efforts: CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
    const current = session.getInfo().reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const text = current
      ? `<b>Reasoning effort:</b> <code>${escapeHTML(current)}</code>\n\nSelect for new threads:`
      : "<b>Reasoning effort:</b> not set (model default)\n\nSelect for new threads:";
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^proj_page_(\d+)$/, "proj", pendingProjectButtons, "Expired, run /projects again");
  handlePageCallback(/^mrpage_page_(\d+)$/, "mrpage", pendingMergeRequestButtons, "Устарело, вызови /mr заново");
  handlePageCallback(/^projsess_page_(\d+)$/, "projsess", pendingProjectSessionButtons, "Expired, run /projects again");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Expired, run ${LAUNCH_PROFILES_COMMAND} again`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /effort again");

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await session.abort();
  });

  /** Continues a thread in whatever context the tap came from. */
  const attachThreadHere = async (ctx: Context, threadId: string): Promise<void> => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Opening task..." });
    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plain = `Attached to task.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Attached to task.</b>\n\n${renderSessionInfoHTML(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      const plain = `Failed: ${friendlyErrorText(error)}`;
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: plain,
      });
    } finally {
      busyState.switching = false;
    }
  };

  /** Telegram sends no update when a forum topic is deleted. */
  const topicIsAlive = (chatId: number, messageThreadId: number): Promise<boolean> =>
    probeForumTopic(messageThreadId, {
      reopen: (threadId) => bot.api.reopenForumTopic(chatId, threadId),
      close: (threadId) => bot.api.closeForumTopic(chatId, threadId),
    });

  bot.callbackQuery(/^jtask:/, async (ctx) => {
    const callback = parseJiraTaskCallback(ctx.callbackQuery.data);
    const chatId = ctx.chat?.id;
    const sourceContextKey = contextKeyFromCtx(ctx);
    const sourceTopicId = ctx.callbackQuery.message?.message_thread_id;
    if (!callback || !chatId || !sourceContextKey) {
      await ctx.answerCallbackQuery({ text: "Некорректная кнопка Jira", show_alert: true });
      return;
    }

    try {
      const configPath = process.env.RECIPES_CONFIG?.trim() || RECIPE_CONFIG_PATH;
      const recipes = parseRecipes(await readFile(configPath, "utf8"));
      const recipe = recipes.find((candidate) => candidate.id === callback.recipeId);
      if (!recipe || recipe.kind !== "jira-filter") {
        throw new Error("Jira-рецепт больше не настроен");
      }
      if (recipe.deliver.chatId !== chatId || recipe.deliver.messageThreadId !== sourceTopicId) {
        throw new Error("Эта кнопка работает только в топике Jira-рецепта");
      }

      const issue = await new JiraClient(recipe.jiraClient).getIssue(callback.issueKey, true);
      const result = await openJiraTaskThread({
        chatId,
        sourceContextKey,
        workspace: recipe.cwd,
        launchProfileId: config.defaultLaunchProfileId,
        jiraClient: recipe.jiraClient,
        issue,
      }, {
        inbox,
        topicIsAlive: (topicId) => topicIsAlive(chatId, topicId),
        createTopic: async (topicName) => {
          const topic = await bot.api.createForumTopic(chatId, topicName);
          return topic.message_thread_id;
        },
        initializeTopic: async (topicId, ticket, task) => {
          registry.setContextDefaults(contextKeyFromMessage(chatId, topicId), {
            workspace: recipe.cwd,
            launchProfileId: config.defaultLaunchProfileId,
            topicName: jiraTaskTopicName(task),
          });
          await sendTextMessage(bot.api, chatId, renderJiraTaskCardHTML(task), {
            messageThreadId: topicId,
            fallbackText: `${task.key}: ${task.summary}`,
            replyMarkup: ticketKeyboard(ticket).url("Открыть в Jira", task.url),
          });
        },
      });

      await ctx.answerCallbackQuery({
        text: result.created ? "Тред создан" : "Тред уже существует",
      }).catch(() => undefined);
      const label = result.created ? "Тред заведён" : "Тред уже был заведён";
      await safeReply(ctx, `${label}: <a href="${result.url}">${escapeHTML(result.topicName)}</a>`, {
        fallbackText: `${label}: ${result.url}`,
      });
    } catch (error) {
      const text = `Не вышло: ${friendlyErrorText(error)}`;
      try {
        await ctx.answerCallbackQuery({ text: text.slice(0, 200), show_alert: true });
      } catch {
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      }
    }
  });

  bot.callbackQuery(/^codex_thread:/, async (ctx) => {
    const threadId = parseCodexThreadCallback(ctx.callbackQuery.data);
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Invalid task link" });
      return;
    }
    if (!getThread(threadId)) {
      await ctx.answerCallbackQuery({ text: "Task is not available on this device" });
      return;
    }

    await attachThreadHere(ctx, threadId);
  });

  // A session picked from /projects gets its own topic instead of taking over
  // the context the pick was made from, which would otherwise be General.
  bot.callbackQuery(/^projopen:(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.match?.[1];
    if (!chatId || !threadId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const thread = getThread(threadId);
    if (!thread) {
      await ctx.answerCallbackQuery({ text: "Session is not available on this device" });
      return;
    }

    const isForum = ctx.chat !== undefined && "is_forum" in ctx.chat && ctx.chat.is_forum === true;
    if (!isForum) {
      await attachThreadHere(ctx, threadId);
      return;
    }

    const fromDashboard = bot.statusBoard?.isDashboardTopic(
      ctx.callbackQuery.message?.message_thread_id,
    ) === true;
    try {
      const result = await ensureThreadTopic(thread, {
        chatId,
        contexts: registry.listContexts(),
        topicIsAlive: (messageThreadId) => topicIsAlive(chatId, messageThreadId),
        createForumTopic: (name) => bot.api.createForumTopic(chatId, name),
        bindThread: (contextKey, record) => registry.bindThread(contextKey, record),
        sendWelcome: async (messageThreadId, name) => {
          await sendTextMessage(
            bot.api,
            chatId,
            `<b>${escapeHTML(name)}</b>\n\nSend a message to continue this session.`,
            { messageThreadId, fallbackText: name },
          );
        },
      });

      if (fromDashboard) {
        await ctx.answerCallbackQuery({
          text: result.created ? "Топик создан" : "Топик уже существует",
        });
        await bot.statusBoard?.refreshSafely();
        return;
      }

      await ctx.answerCallbackQuery({
        text: result.created ? "Topic created" : "This session already has a topic",
      });
      const prefix = result.created ? "Topic created" : "Already open";
      await safeReply(ctx, `${prefix}: <a href="${result.url}">${escapeHTML(result.name)}</a>`, {
        fallbackText: `${prefix}: ${result.url}`,
      });
    } catch (error) {
      if (fromDashboard) {
        await ctx.answerCallbackQuery({
          text: `Ошибка: ${friendlyErrorText(error)}`.slice(0, 180),
        });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Failed to create topic" });
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plainText = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const choices = session.listModelChoices();
    if (!choices.length) {
      await ctx.answerCallbackQuery({ text: "No models available" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Workspace selected" });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);
    pendingNewThreads.set(contextKey, { workspace });
    const keyboard = modelChoiceKeyboard(
      choices,
      (choice) => `startmodel:${choice.id}`,
      selectedChoiceId(session),
    );
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, "<b>Select model for new thread:</b>", {
        fallbackText: "Select model for new thread:",
        replyMarkup: keyboard,
      });
    } else {
      await safeReply(ctx, "<b>Select model for new thread:</b>", {
        fallbackText: "Select model for new thread:",
        replyMarkup: keyboard,
      });
    }
  });

  bot.callbackQuery(/^startmodel:([a-z0-9][a-z0-9_-]{0,31})$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const choiceId = ctx.match?.[1];
    if (!chatId || !choiceId) return;

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    const { contextKey, session } = contextSession;
    const intent = pendingNewThreads.get(contextKey);
    const choice = session.getModelChoice(choiceId);
    if (!intent || !choice) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating thread..." });
    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(intent.workspace, choice.id);
      pendingNewThreads.delete(contextKey);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey)
        ? "New thread created for this topic."
        : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^jobmodel:/, async (ctx) => {
    const callback = parsePromptModelCallback(ctx.callbackQuery.data);
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!callback || !contextSession) {
      await ctx.answerCallbackQuery({ text: "Invalid model selection" });
      return;
    }

    const { contextKey, session } = contextSession;
    const job = jobStore.findAwaitingModel(callback.token, contextKey);
    const choice = session.getModelChoice(callback.choiceId);
    if (!job || !choice) {
      await ctx.answerCallbackQuery({ text: "Expired, send the prompt again" });
      return;
    }
    if (!canUseChoiceForInput(choice, job.input)) {
      await ctx.answerCallbackQuery({ text: "This model cannot accept images. Choose OpenAI." });
      return;
    }
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Starting ${choice.label}...` });
    try {
      session.setModelChoice(choice.id);
      if (!session.hasActiveThread()) {
        await session.newThread(undefined, choice.id);
      } else {
        const active = session.getInfo();
        if (active.model !== choice.model || active.modelProvider !== choice.provider) {
          throw new Error("A different thread became active; send the prompt again");
        }
      }
      updateSessionMetadata(contextKey, session);
      const threadId = session.getInfo().threadId;
      if (!threadId) throw new Error("Codex did not return a thread id");
      const released = jobStore.selectModel(
        callback.token,
        contextKey,
        choice.id,
        threadId,
      );
      const messageId = ctx.callbackQuery.message?.message_id;
      if (messageId && ctx.chat?.id) {
        await safeEditMessage(
          bot,
          ctx.chat.id,
          messageId,
          `<b>Model selected:</b> <code>${escapeHTML(`${choice.provider}/${choice.model}`)}</code>`,
          { fallbackText: `Model selected: ${choice.provider}/${choice.model}` },
        );
      }
      await handleUserPrompt(
        ctx,
        contextKey,
        released.chatId,
        session,
        released.input,
        released,
        { requireModelSelection: false },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "Confirm danger-full-access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("Enable danger-full-access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(profile))}</code>`,
        "",
        "⚠️ <b>This profile uses danger-full-access.</b>",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Behavior: ${formatLaunchProfileBehavior(profile)}`,
        "",
        "WARNING: This profile uses danger-full-access.",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `Launch set to ${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch change cancelled.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        {
          fallbackText: `Launch change cancelled.\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch profile expired.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        {
          fallbackText: `Launch profile expired.\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: `Launch set to ${selectedProfile.label}` });

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "⚠️ <i>danger-full-access confirmed for new or reattached threads.</i>",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "danger-full-access confirmed for new or reattached threads.",
    ].join("\n");

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_([a-z0-9][a-z0-9_-]{0,31})$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const choiceId = ctx.match?.[1];

    if (!chatId || !choiceId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${choiceId}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const choice = session.setModelChoice(choiceId);
      updateSessionMetadata(contextKey, session);
      const pair = `${choice.provider}/${choice.model}`;
      const html = [
        `<b>Next model set to ${escapeHTML(choice.label)}</b> <code>(${escapeHTML(pair)})</code>.`,
        "The active thread was not changed.",
      ].join("\n");
      const plainText = [
        `Next model set to ${choice.label} (${pair}).`,
        "The active thread was not changed.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(minimal|low|medium|high|xhigh)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1] as CodexReasoningEffort | undefined;

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /effort again" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Effort set to ${effort}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ Reasoning effort set to <code>${escapeHTML(effort)}</code> — applies to new threads.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ Reasoning effort set to ${effort} — applies to new threads.`,
    });
  });

  // Runs before the session handlers: in an inbox topic a message is a ticket,
  // not a prompt for the topic's own session.
  bot.on("message", async (ctx, next) => {
    const contextKey = contextKeyFromCtx(ctx);
    const message = ctx.message;
    if (!contextKey || !message || !inbox.get(contextKey)) {
      return next();
    }
    if ((message.text ?? "").startsWith("/")) {
      return next();
    }

    inboxBuffer.add(contextKey, {
      contextKey,
      chatId: ctx.chat.id,
      messageId: message.message_id,
      mediaGroupId: message.media_group_id,
      hasAttachment: hasAttachment(message as unknown as Record<string, unknown>),
      text: (message.text ?? message.caption ?? "").trim(),
      message,
    });
  });

  bot.on("message:text", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    const { contextKey, session } = contextSession;
    lastPromptInput.set(contextKey, userText);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        });
        return;
      }

      const preview = trimLine(transcript.replace(/\s+/g, " "), 100);
      await safeReply(
        ctx,
        `🎙️ <b>Transcribed:</b> ${escapeHTML(preview)} <i>(via ${escapeHTML(result.backend)})</i>`,
        { fallbackText: `🎙️ Transcribed: ${preview} (via ${result.backend})` },
      );
    } catch (error) {
      const note = "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.";
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    lastPromptInput.set(contextKey, transcript);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, transcript);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    if (!tempFilePath) return;
    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    let stagedPhoto: StagedFile;
    try {
      const imageBuffer = await readFile(tempFilePath);
      stagedPhoto = await stageFile(imageBuffer, "telegram-photo.jpg", "image/jpeg", {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      await unlink(tempFilePath).catch(() => {});
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = {
      imagePaths: [stagedPhoto.localPath],
    };
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput, undefined, {
        cleanupInbox: { workspace, turnId },
      });
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile]),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput, undefined, {
        cleanupInbox: { workspace, turnId },
      });
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.recoverPendingJobs = async (): Promise<void> => {
    const awaitingModelPartition = await partitionJobsByTopicLiveness(
      jobStore.listAwaitingModel(),
      topicIsAlive,
    );
    const awaitingModel = awaitingModelPartition.retained;
    const loggedDeadContexts = new Set<TelegramContextKey>();
    for (const job of awaitingModelPartition.dead) {
      jobStore.update(job.id, { state: "failed" });
      if (!loggedDeadContexts.has(job.contextKey)) {
        loggedDeadContexts.add(job.contextKey);
        console.warn(`Dropping Telegram model picker for missing topic: ${job.contextKey}`);
      }
    }
    const recoverable = jobStore.listRecoverable();
    await topicActivity.restoreStaleTopics({
      exclude: recoverable
        .filter((job) => job.state === "active" && isTopicActivityEligible(job.messageThreadId))
        .map((job) => ({ chatId: job.chatId, messageThreadId: job.messageThreadId! })),
    });
    if (awaitingModel.length === 0 && recoverable.length === 0) return;

    if (awaitingModel.length) {
      console.log(`Restoring ${awaitingModel.length} Telegram model picker(s)`);
      const pickerResults = await Promise.allSettled(
        awaitingModel.map(async (job) => {
          const session = await registry.getOrCreate(job.contextKey, { deferThreadStart: true });
          await sendPromptModelPicker(job, session);
        }),
      );
      for (const result of pickerResults) {
        if (result.status === "rejected") {
          console.error("Failed to restore Telegram model picker:", formatError(result.reason));
        }
      }
    }

    if (recoverable.length === 0) return;

    console.log(`Recovering ${recoverable.length} Telegram job(s)`);
    const recoveries = recoverable.map(async (job) => {
      try {
        const session = await registry.getOrCreate(job.contextKey, { deferThreadStart: true });
        const recoveryContext = {
          api: bot.api,
          chat: { id: job.chatId },
          message: {
            message_id: 0,
            ...(job.messageThreadId ? { message_thread_id: job.messageThreadId } : {}),
          },
        } as unknown as Context;
        await handleUserPrompt(
          recoveryContext,
          job.contextKey,
          job.chatId,
          session,
          job.input,
          job,
          { requireModelSelection: false },
        );
      } catch (error) {
        if (job.state === "active" && isTopicActivityEligible(job.messageThreadId)) {
          await topicActivity.finish(job.chatId, job.messageThreadId);
        }
        throw error;
      }
    });
    const results = await Promise.allSettled(recoveries);
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Failed to recover Telegram job:", formatError(result.reason));
      }
    }
  };

  if (config.telegramForumChatId !== undefined) {
    const boardChatId = config.telegramForumChatId;
    bot.statusBoard = new StatusBoard({
      chatId: boardChatId,
      intervalMs: config.statusBoardIntervalMs,
      collect: collectStatusSnapshot,
      createTopic: async () => {
        const topic = await bot.api.createForumTopic(boardChatId, "Dashboard");
        return topic.message_thread_id;
      },
      send: async (messageThreadId, message) => {
        const sent = await bot.api.sendMessage(boardChatId, message.html, {
          parse_mode: "HTML",
          message_thread_id: messageThreadId,
          link_preview_options: { is_disabled: true },
          reply_markup: boardKeyboard(message.buttons),
        });
        return sent.message_id;
      },
      edit: async (_messageThreadId, messageId, message) => {
        await bot.api.editMessageText(boardChatId, messageId, message.html, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: boardKeyboard(message.buttons),
        });
      },
      pin: async (messageId) => {
        await bot.api.pinChatMessage(boardChatId, messageId, { disable_notification: true });
      },
      closeTopic: async (messageThreadId) => {
        await bot.api.closeForumTopic(boardChatId, messageThreadId);
      },
      reopenTopic: async (messageThreadId) => {
        try {
          await bot.api.reopenForumTopic(boardChatId, messageThreadId);
        } catch (error) {
          if (!/TOPIC_NOT_MODIFIED/i.test(formatError(error))) throw error;
        }
      },
      remove: async (messageId) => {
        await bot.api.unpinChatMessage(boardChatId, messageId).catch(() => {});
        await bot.api.deleteMessage(boardChatId, messageId);
      },
      deleteMessage: async (messageId) => {
        await bot.api.deleteMessage(boardChatId, messageId);
      },
      store: createStatusBoardStore(path.join(config.workspace, ".telecodex", "status.json")),
    });
  }

  // Elapsed times are measured from when a thread was first seen working, so
  // this has to survive between refreshes.
  let activeSince = new Map<string, number>();
  let lastHostThreads: HostThreadView[] = [];

  /**
   * What is running, from the app-server rather than from our own job store.
   *
   * A turn started in VS Code, in the CLI or by a subagent never touches the
   * job store, so a board built only from Telegram jobs sat empty while the
   * host was busy. The queue and the outcomes still come from the job store:
   * the app-server knows nothing about either.
   */
  async function collectStatusSnapshot(): Promise<StatusSnapshot> {
    const contexts = registry.listContexts();
    const byContextKey = new Map(contexts.map((meta) => [meta.contextKey, meta]));
    const boardChatId = config.telegramForumChatId;
    const topicNameByThreadId = new Map<string, string>();
    if (boardChatId !== undefined) {
      for (const meta of contexts) {
        const context = parseContextKey(meta.contextKey);
        if (
          meta.threadId
          && meta.topicName
          && context.chatId === boardChatId
          && context.messageThreadId !== undefined
          && !topicNameByThreadId.has(meta.threadId)
        ) {
          topicNameByThreadId.set(meta.threadId, meta.topicName);
        }
      }
    }

    const jobs: StatusJobView[] = jobStore.list().map((job) => {
      const meta = byContextKey.get(job.contextKey);
      const thread = job.threadId ? getThread(job.threadId) : undefined;
      return {
        state: job.state,
        label: meta?.topicName ?? (thread && threadLabel(thread)) ?? promptText(job.input),
        workspace: meta?.workspace ?? thread?.cwd ?? config.workspace,
        messageThreadId: job.messageThreadId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    });

    const now = Date.now();
    let codexAvailable = true;
    try {
      const host = await listHostThreads(registry.getAppServerClient(), { now, activeSince });
      activeSince = host.activeSince;
      lastHostThreads = host.threads;
    } catch {
      codexAvailable = false;
    }

    // A thread we opened has a topic to jump to, and a name the user chose.
    const hostThreads: HostThreadView[] = lastHostThreads.map((thread) => {
      const topicName = topicNameByThreadId.get(thread.id);
      return { ...thread, messageThreadId: undefined, label: topicName ?? thread.label };
    });
    const recentThreads = listRecentRootThreads(
      new Date(now - STATUS_HISTORY_WINDOW_MS),
      1000,
    ).map((thread) => ({
      threadId: thread.id,
      label: topicNameByThreadId.get(thread.id) ?? threadLabel(thread),
      workspace: thread.cwd,
      source: thread.source,
      updatedAt: thread.updatedAt.getTime(),
    }));

    const snapshot = buildStatusSnapshot(jobs, hostThreads, {
      limit: config.telegramMaxActiveTopics,
      now,
      recentThreads,
      codexAvailable,
    });
    if (boardChatId !== undefined) {
      const actionable = [...snapshot.running, ...snapshot.recentThreads]
        .filter((row): row is typeof row & { threadId: string } => Boolean(row.threadId))
        .slice(0, STATUS_BOARD_BUTTON_LIMIT);
      for (const row of actionable) {
        row.messageThreadId = await findLiveBoundTopic(
          contexts,
          boardChatId,
          row.threadId,
          (messageThreadId) => topicIsAlive(boardChatId, messageThreadId),
        );
      }
    }
    return snapshot;
  }

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & status" },
    { command: "help", description: "Command reference" },
    { command: "new", description: "Start a new thread" },
    { command: "session", description: "Current thread details" },
    { command: "sessions", description: "Browse & switch threads" },
    { command: "projects", description: "Topics grouped by project" },
    { command: "jira", description: "Open Jira sprint and filters" },
    { command: "inbox", description: "Turn this topic into a ticket inbox" },
    { command: "tickets", description: "List unresolved inbox tickets" },
    { command: "mr", description: "Open merge requests, tap to review" },
    { command: "retry", description: "Resend the last prompt" },
    { command: "abort", description: "Cancel current operation" },
    { command: "launch_profiles", description: "Select launch profile" },
    { command: "model", description: "View & change model" },
    { command: "effort", description: "Set reasoning effort" },
    { command: "auth", description: "Check auth status" },
    { command: "login", description: "Start authentication" },
    { command: "logout", description: "Sign out" },
    { command: "voice", description: "Voice transcription status" },
    { command: "handback", description: "Hand thread to Codex CLI" },
    { command: "attach", description: "Bind a Codex thread to this topic" },
    { command: "switch", description: "Switch to a thread by ID" },
  ]);
}

function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    info.nextLaunchProfileId
      ? `Next launch profile: ${info.nextLaunchProfileLabel} (${info.nextLaunchProfileBehavior})${info.nextUnsafeLaunch ? " [unsafe]" : ""}`
      : undefined,
    ...renderModelSummaryPlain(info),
    info.reasoningEffort ? `Reasoning effort: ${info.reasoningEffort}` : undefined,
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: CodexSessionInfo): string {
  const modelLines = renderModelSummaryPlain(info).map((line) => {
    const separator = line.indexOf(":");
    return `<b>${escapeHTML(line.slice(0, separator + 1))}</b> <code>${escapeHTML(line.slice(separator + 1).trim())}</code>`;
  });
  return [
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Launch behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Next launch profile:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(info.nextLaunchProfileBehavior ?? "")})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    ...modelLines,
    info.reasoningEffort ? `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    info.sessionTokens ? `<b>Session tokens:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Launch: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Launch:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function isTopicLifecycleMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return [
    "forum_topic_created",
    "forum_topic_closed",
    "forum_topic_reopened",
    "forum_topic_edited",
  ].some((key) => key in record);
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return `in: ${tokens.input} · cached: ${tokens.cached} · out: ${tokens.output}`;
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `Session tokens: ${formatSessionTokensValue(tokens)}`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  return splitTelegramMarkdown(markdown, FORMATTED_CHUNK_TARGET, TELEGRAM_MESSAGE_LIMIT).map(
    (chunk) => ({
      sourceText: chunk.sourceText,
      text: chunk.html,
      fallbackText: chunk.plain,
      parseMode: "HTML",
    }),
  );
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

async function reopenThread(
  session: CodexSessionService,
  configuredCommand: string | undefined,
): Promise<boolean> {
  const reopen = parseReopenCommand(configuredCommand);
  const threadId = session.getInfo().threadId;
  if (!reopen || !threadId) {
    return false;
  }

  try {
    await session.reloadThread();
    // Only after the reload is the claim this makes ("it has been reopened") true.
    await runReopenCommand(reopen, threadId);
    return true;
  } catch (error) {
    console.error("Failed to reopen thread after a blocking hook:", formatError(error));
    return false;
  }
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
