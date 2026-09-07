import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
import {
  type CodexPromptInput,
  type CodexReasoningEffort,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CodexSessionService,
} from "./codex-session.js";
import { checkAuthStatus, startLogin, startLogout } from "./codex-auth.js";
import {
  createDashboardController,
  createDashboardSnapshotCollector,
  createSharedAsyncLoader,
  type DashboardController,
} from "./dashboard-controller.js";
import type { DashboardReliabilitySnapshot } from "./dashboard-api.js";
import type { DashboardSessionStatus } from "./dashboard-api.js";
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
  buildReviewBootstrapPrompt,
  buildReviewPrompt,
  linkedMergeRequests,
  mergeRequestButtons,
  mergeRequestTopicName,
  renderDraftHTML,
  renderMergeRequestCardHTML,
  type MergeRequestSummary,
} from "./gitlab.js";
import {
  InboxStore,
  extractTicketKey,
  ticketActionButtons,
  ticketHeading,
  type Ticket,
} from "./inbox.js";
import { registerInboxHandlers } from "./bot-inbox.js";
import {
  ensureThreadTopic,
  findBoundTopic,
  groupThreadsByProject,
  partitionJobsByTopicLiveness,
  projectButtons,
  renderProjectHTML,
  renderProjectsHTML,
  sessionButtons,
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
import { createForumTopicLivenessProbe } from "./telegram-topic-liveness.js";
import { registerGuardianCallbacks } from "./guardian-bot-adapter.js";
import { JiraClient } from "./jira-client.js";
import {
  createJiraMiniAppController,
  type JiraMiniAppController,
} from "./jira-mini-app.js";
import {
  JiraCommentClient,
  canPostTicketToJira,
  saveTicketAnswer,
} from "./jira-comment.js";
import {
  openJiraTaskThread,
  parseJiraTaskCallback,
  renderJiraTaskCardHTML,
  jiraTaskTopicName,
} from "./jira-task-thread.js";
import {
  JiraPanel,
  jiraMiniAppLaunchUrl,
  removeJiraLauncherMessage,
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
import {
  RECIPE_DIGEST_PAGE_SIZE,
  mutedRecipeFindingIndices,
  recipeDigestKeyboard,
  recipeFindingDetailKeyboard,
  renderRecipeDigestHTML,
  renderRecipeFindingDetailHTML,
} from "./recipe-review-digest.js";
import { buildFixPrompt, fingerprintFinding, fixTopicName, type Finding } from "./recipes.js";
import { parseRecipes, RECIPE_CONFIG_PATH } from "./recipe-config.js";
import {
  buildSentryAnalysisPrompt,
  openSentryTaskThread,
  parseSentryTaskCallback,
  sentryTaskTopicName,
} from "./sentry-task-thread.js";
import { SessionRegistry } from "./session-registry.js";
import { listHostThreads } from "./host-threads.js";
import {
  buildStatusSnapshot,
  StatusBoard,
  STATUS_BOARD_BUTTON_LIMIT,
  telegramRetryAfterMs,
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
import type { TelegramWorkSource, TelegramWorkTargetContext } from "./telegram-job-ingress.js";
import {
  createTelegramInboxCompletionProcessor,
  type TelegramCompletionProcessor,
} from "./telegram-inbox-completion.js";
import type { TelegramAttachmentRef } from "./telegram-job-types.js";
import type { TelegramBackgroundWriteGate } from "./telegram-background-write-gate.js";
import type { AppServerHookBlock } from "./app-server-turn-manager.js";
import { buildMarkdownDocument } from "./markdown-document.js";
import { parseReopenCommand, runReopenCommand } from "./thread-reopen.js";
import { TurnProgressPresenter } from "./turn-progress.js";
import type { TelegramStatusAction } from "./telegram-status-projection.js";
import {
  isTopicActivityEligible,
  TopicActivityIndicator,
  topicIconChangeFromMessage,
} from "./topic-activity.js";
import { extractTopicRename, renamedTicketTopic } from "./topic-naming.js";
import {
  finalChunkThreadKeyboard,
  parseCodexThreadCallback,
} from "./thread-links.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";
import {
  UsageStore,
  tokenBudgetStatus,
  type UsageAggregate,
} from "./usage-store.js";

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
  transformFinalText?: (text: string) => string | Promise<string>;
  afterFinalResponse?: (text: string, job: PersistentTelegramJob) => void | Promise<void>;
}

export const TELEGRAM_RETRY_OPTIONS = {
  maxRetryAttempts: 3,
  maxDelaySeconds: 60,
} as const;

export const DISABLED_MODEL_SELECTION_CALLBACK_PATTERN =
  /^(?:jobmodel:|startmodel:|model_)/;

export const CANONICAL_STATUS_ACTION_PATTERN =
  /^tcj:([arfdigys]):([A-Za-z0-9_-]{1,40}):([1-9]\d{0,15})(?::([A-Za-z0-9_.:-]{1,24}))?$/;

const IMPLEMENTATION_VERB = "(?:приступай|делай|сделай|начинай|реализуй|исправляй|исправь|implement)";
const IMPLEMENTATION_TICKET = "(?:NO-TICKET|[A-Z][A-Z0-9]{1,15}-\\d+)";
const IMPLEMENTATION_AUTHORIZATION_PATTERN = new RegExp(
  `^(?:${IMPLEMENTATION_TICKET}[\\s,:-]+)?${IMPLEMENTATION_VERB}(?:[\\s,:-]+${IMPLEMENTATION_TICKET})?[.!]?$`,
  "iu",
);

export function isImplementationAuthorization(text: string): boolean {
  return IMPLEMENTATION_AUTHORIZATION_PATTERN.test(text.trim());
}

export function shouldBlockTextDuringSessionTransition(state: { switching: boolean }): boolean {
  return state.switching;
}

interface ImplementationHandoffInput {
  text: string;
  session: Pick<CodexSessionService, "getInfo" | "forkThread">;
  launchProfiles: TeleCodexConfig["launchProfiles"];
  defaultLaunchProfileId: string;
}

interface PrepareImplementationHandoffInput extends ImplementationHandoffInput {
  persistSession(info: CodexSessionInfo): void;
  dispatchPrompt(info: CodexSessionInfo): Promise<void>;
  notify(info: CodexSessionInfo): Promise<void>;
  onNotificationError(error: unknown): void;
}

type PreparedImplementationHandoff = CodexSessionInfo & { prompt: Promise<void> };

export async function maybeForkImplementationThread(
  input: ImplementationHandoffInput,
): Promise<CodexSessionInfo | undefined> {
  if (
    input.session.getInfo().sandboxMode !== "read-only"
    || !isImplementationAuthorization(input.text)
  ) {
    return undefined;
  }

  const profileId = writableImplementationProfileId({
    launchProfiles: input.launchProfiles,
    defaultLaunchProfileId: input.defaultLaunchProfileId,
  });
  if (!profileId) {
    throw new Error("No writable launch profile with non-interactive approvals is configured");
  }

  return input.session.forkThread(profileId);
}

function writableImplementationProfileId(
  config: Pick<TeleCodexConfig, "launchProfiles" | "defaultLaunchProfileId">,
): string | undefined {
  const configuredDefault = config.launchProfiles.find(
    (profile) => profile.id === config.defaultLaunchProfileId,
  );
  const profile = configuredDefault?.sandboxMode !== "read-only"
    && configuredDefault?.approvalPolicy === "never"
    ? configuredDefault
    : config.launchProfiles.find(
      (candidate) => candidate.sandboxMode !== "read-only" && candidate.approvalPolicy === "never",
    );
  return profile?.id;
}

export async function prepareImplementationHandoff(
  input: PrepareImplementationHandoffInput,
): Promise<PreparedImplementationHandoff | undefined> {
  const info = await maybeForkImplementationThread(input);
  if (!info) {
    return undefined;
  }

  input.persistSession(info);
  const prompt = input.dispatchPrompt(info);
  try {
    void input.notify(info).catch(input.onNotificationError);
  } catch (error) {
    input.onNotificationError(error);
  }

  return { ...info, prompt };
}

interface PromptSuccessDelivery {
  deliverResponse(): Promise<void>;
  deliverImages(): Promise<void>;
  completeProgress(): Promise<void>;
  onProgressError(error: unknown): void;
}

export async function deliverPromptSuccess(actions: PromptSuccessDelivery): Promise<void> {
  await actions.deliverResponse();
  await actions.deliverImages();
  await actions.completeProgress().catch(actions.onProgressError);
}

interface PromptErrorDelivery {
  deliverResponse(): Promise<void>;
  failProgress(): Promise<void>;
  onDeliveryError(error: unknown): void;
  onProgressError(error: unknown): void;
}

export async function deliverPromptError(actions: PromptErrorDelivery): Promise<void> {
  await actions.deliverResponse().catch(actions.onDeliveryError);
  await actions.failProgress().catch(actions.onProgressError);
}

interface LiveStatusTopicRow {
  threadId: string;
  messageThreadId?: number;
}

export function bindSavedStatusTopics(
  rows: LiveStatusTopicRow[],
  cache: Map<string, number>,
): void {
  const visibleThreadIds = new Set(rows.map((row) => row.threadId));
  for (const threadId of cache.keys()) {
    if (!visibleThreadIds.has(threadId)) cache.delete(threadId);
  }
  for (const row of rows) {
    if (row.messageThreadId !== undefined) cache.set(row.threadId, row.messageThreadId);
  }
  for (const row of rows) row.messageThreadId = cache.get(row.threadId);
}

export async function removeStatusBoardMessage(
  unpin: () => Promise<unknown>,
  remove: () => Promise<unknown>,
): Promise<void> {
  try {
    await unpin();
  } catch (error) {
    if (telegramRetryAfterMs(error) !== undefined) throw error;
  }
  await remove();
}

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

export interface TeleCodexBot extends Bot<Context> {
  recoverPendingJobs(): Promise<void>;
  statusBoard?: StatusBoard;
  dashboard?: DashboardController;
  jiraPanel?: JiraPanel;
  jiraMiniApp?: JiraMiniAppController;
}

export interface TeleCodexBotOptions {
  readonly backgroundWriteGate?: Pick<TelegramBackgroundWriteGate, "run">;
}

export interface TelegramCanonicalJobRef {
  readonly jobId: string;
  readonly version: number;
}

export interface TelegramCanonicalContext {
  readonly botId: string;
  readonly chatId: number;
  readonly messageThreadId: number | null;
}

export interface TelegramCanonicalControlSource extends TelegramCanonicalContext {
  readonly updateId: number;
  readonly messageId: number;
}

export interface TelegramBotReliability {
  handleWork(source: TelegramWorkSource): Promise<TelegramWorkTargetContext | null>;
  registerCompletionProcessor?(processor: TelegramCompletionProcessor): void;
  latestJob(context: TelegramCanonicalContext): Promise<TelegramCanonicalJobRef | null>;
  retry(input: {
    readonly source: TelegramCanonicalControlSource;
    readonly target: TelegramCanonicalJobRef;
  }): Promise<void>;
  abort(input: {
    readonly source: TelegramCanonicalControlSource;
    readonly target: TelegramCanonicalJobRef;
  }): Promise<void>;
  loadDashboardReliability?(limit?: number): Promise<DashboardReliabilitySnapshot>;
  loadDashboardSessionStatuses?(): Promise<readonly DashboardSessionStatus[]>;
  runDashboardAction?(action: TelegramStatusAction, context?: TelegramCanonicalContext): Promise<void>;
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

function promptText(input: CodexPromptInput): string {
  return typeof input === "string" ? input : input.text ?? "";
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

function canonicalControlSource(ctx: Context): TelegramCanonicalControlSource | null {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined || messageId === undefined) return null;
  const messageThreadId = ctx.message?.message_thread_id
    ?? ctx.callbackQuery?.message?.message_thread_id
    ?? null;
  return {
    botId: String(ctx.me.id),
    updateId: ctx.update.update_id,
    chatId,
    messageThreadId,
    messageId,
  };
}

function canonicalContext(source: TelegramCanonicalControlSource): TelegramCanonicalContext {
  return {
    botId: source.botId,
    chatId: source.chatId,
    messageThreadId: source.messageThreadId,
  };
}

function checkedCanonicalJobRef(value: TelegramCanonicalJobRef | null): TelegramCanonicalJobRef | null {
  if (value === null) return null;
  if (!value.jobId || value.jobId.length > 128 || !Number.isInteger(value.version) || value.version < 1) {
    throw new Error("Invalid canonical Telegram job reference");
  }
  return value;
}

function isCanonicalVersionConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "Telegram job version conflict";
}

function isCanonicalStaleAction(error: unknown): boolean {
  return error instanceof Error && (
    isCanonicalVersionConflict(error)
    || error.message === "Telegram job source mismatch"
    || error.message === "Unknown Telegram job"
  );
}

function attachmentRef(
  kind: TelegramAttachmentRef["kind"],
  file: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  },
  defaults: { readonly name?: string; readonly mimeType?: string } = {},
): TelegramAttachmentRef {
  const stableFileId = file.file_unique_id ?? file.file_id;
  return {
    id: `${kind}:${stableFileId}`,
    kind,
    telegramFileId: file.file_id,
    ...(file.file_unique_id === undefined ? {} : { telegramFileUniqueId: file.file_unique_id }),
    ...(file.file_name === undefined && defaults.name === undefined
      ? {} : { name: file.file_name ?? defaults.name }),
    ...(file.mime_type === undefined && defaults.mimeType === undefined
      ? {} : { mimeType: file.mime_type ?? defaults.mimeType }),
    ...(file.file_size === undefined ? {} : { size: file.file_size }),
  };
}

function captionText(ctx: Context): string | null {
  const text = ctx.message?.caption?.trim();
  return text ? text : null;
}

function canonicalWorkSource(
  ctx: Context,
  kind: TelegramWorkSource["kind"],
  text: string | null,
  attachment: TelegramAttachmentRef | null,
  sessionDefaults?: TelegramWorkSource["sessionDefaults"],
  implementationHandoffProfileId?: string,
  targetContext?: TelegramWorkSource["targetContext"],
  targetProvision?: TelegramWorkSource["targetProvision"],
): TelegramWorkSource | null {
  const source = canonicalControlSource(ctx);
  return source ? {
    ...source, kind, text, attachment, retryOfJobId: null,
    ...(sessionDefaults ? { sessionDefaults } : {}),
    ...(implementationHandoffProfileId ? { implementationHandoffProfileId } : {}),
    ...(targetContext ? { targetContext } : {}),
    ...(targetProvision ? { targetProvision } : {}),
  } : null;
}

function canonicalCallbackWorkSource(source: TelegramWorkSource, intent: string): TelegramWorkSource {
  const digest = createHash("sha256").update([
    source.botId,
    String(source.chatId),
    String(source.messageThreadId ?? "main"),
    String(source.messageId),
    intent,
  ].join(":"), "utf8").digest("hex");
  const updateId = 5_000_000_000_000_000
    + (Number.parseInt(digest.slice(0, 12), 16) % 500_000_000_000_000);
  return { ...source, updateId };
}

export function createBot(
  config: TeleCodexConfig,
  registry: SessionRegistry,
  reliability?: TelegramBotReliability,
  options: TeleCodexBotOptions = {},
): TeleCodexBot {
  const bot = new Bot<Context>(config.telegramBotToken) as TeleCodexBot;
  const loadCanonicalReliability = reliability?.loadDashboardReliability
    ? createSharedAsyncLoader(
        () => reliability.loadDashboardReliability!(STATUS_BOARD_BUTTON_LIMIT),
      )
    : undefined;
  if (!reliability) bot.api.config.use(autoRetry(TELEGRAM_RETRY_OPTIONS));
  // JSON storage is a rollback-only compatibility path. Canonical mode must not
  // construct a second correctness owner beside the SQLite ledger.
  const jobStore = reliability
    ? undefined
    : new TelegramJobStore(path.join(config.workspace, ".telecodex", "jobs.json"));
  const legacyJobStore = (): TelegramJobStore => {
    if (!jobStore) throw new Error("Legacy Telegram job store is unavailable in canonical mode");
    return jobStore;
  };
  const usageStore = new UsageStore(path.join(config.workspace, ".telecodex", "token-usage.jsonl"));
  try {
    usageStore.compact();
  } catch (error) {
    console.warn("Failed to compact token usage ledger:", friendlyErrorText(error));
  }
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

  let jiraPanelClient: JiraClient | undefined;
  if (config.jiraPanel) {
    const panelConfig = config.jiraPanel;
    jiraPanelClient = new JiraClient(panelConfig.clientPath);
    const messageOptions = (message: JiraPanelMessage) => ({
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      reply_markup: jiraPanelKeyboard(message.rows),
    });
    bot.jiraPanel = new JiraPanel({
      chatId: panelConfig.chatId,
      topicId: panelConfig.topicId,
      client: jiraPanelClient,
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
      remove: async (messageId) => {
        await removeJiraLauncherMessage(
          () => bot.api.unpinChatMessage(panelConfig.chatId, messageId),
          () => bot.api.deleteMessage(panelConfig.chatId, messageId),
        );
      },
      store: createJiraPanelStore(path.join(config.workspace, ".telecodex", "jira-panel.json")),
      miniAppLaunchUrl: config.miniApp
        ? jiraMiniAppLaunchUrl(config.miniApp.launchUrl)
        : undefined,
    });
  }

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean }
  >();
  const inbox = new InboxStore(path.join(config.workspace, ".telecodex", "inbox.json"));
  const jiraComment = config.jiraComment
    ? new JiraCommentClient(config.jiraComment)
    : undefined;
  const gitlab =
    config.gitlabUrl && config.gitlabToken
      ? new GitLabClient(config.gitlabUrl, config.gitlabToken)
      : undefined;
  const pendingMergeRequests = new Map<string, MergeRequestSummary>();
  const pendingMergeRequestButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  /** Drafted GitLab comments awaiting a tap; a restart just expires them. */
  const pendingDoneDrafts = new Map<number, { key: string; body: string }>();
  let nextDoneDraftId = 1;
  const pendingProjectPicks = new Map<TelegramContextKey, string[]>();
  const pendingProjectButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingProjectSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const promptTails = reliability
    ? undefined
    : new Map<TelegramContextKey, Promise<void>>();
  const activeJobIds = new Map<TelegramContextKey, string>();

  const ticketFinalTextTransformer = (
    messageThreadId?: number,
  ): PromptDispatchOptions["transformFinalText"] => {
    const ticket = messageThreadId ? inbox.findTicketByTopic(messageThreadId) : undefined;
    if (!ticket || ticket.topicTitle !== undefined) {
      return undefined;
    }

    return async (text) => {
      const extracted = extractTopicRename(text);
      if (!extracted) {
        return text;
      }
      const current = inbox.getTicket(ticket.id);
      if (!current || current.topicTitle !== undefined) {
        return extracted.text;
      }

      const inboxContext = parseContextKey(current.inboxContextKey);
      const topicName = renamedTicketTopic(current, extracted.title);
      try {
        await bot.api.editForumTopic(inboxContext.chatId, current.workTopicId, {
          name: topicName,
        });
        inbox.setTopicTitle(current.id, extracted.title);
      } catch (error) {
        if (/TOPIC_NOT_MODIFIED/i.test(formatError(error))) {
          inbox.setTopicTitle(current.id, extracted.title);
        } else {
          console.warn(`Failed to rename ticket topic ${current.id}:`, formatError(error));
        }
      }
      return extracted.text;
    };
  };

  const ticketPromptOptions = (messageThreadId?: number): PromptDispatchOptions => {
    const ticket = messageThreadId ? inbox.findTicketByTopic(messageThreadId) : undefined;
    return {
      transformFinalText: ticketFinalTextTransformer(messageThreadId),
      afterFinalResponse: ticket
        ? async (text, job) => {
            await saveTicketAnswer(config.workspace, ticket.id, text);
            const current = inbox.getTicket(ticket.id);
            if (
              !jiraComment
              || !current
              || !canPostTicketToJira(current)
              || legacyJobStore().hasPart(job.id, "jira-confirm")
            ) {
              return;
            }
            const inboxContext = parseContextKey(current.inboxContextKey);
            const keyboard = new InlineKeyboard().text("📤 В Jira", `jira_post:${current.id}`);
            await sendTextMessage(
              bot.api,
              inboxContext.chatId,
              `<b>Результат анализа сохранён.</b> Отправить в ${escapeHTML(current.externalKey!)}?`,
              {
                messageThreadId: current.workTopicId,
                fallbackText: `Результат анализа сохранён. Отправить в ${current.externalKey}?`,
                replyMarkup: keyboard,
              },
            );
            legacyJobStore().markPartSent(job.id, "jira-confirm");
          }
        : undefined,
    };
  };

  reliability?.registerCompletionProcessor?.(createTelegramInboxCompletionProcessor({
    getTicket: (ticketId) => inbox.getTicket(ticketId),
    jiraConfigured: jiraComment !== undefined,
    answerWorkspace: config.workspace,
    renameTopic: async (chatId, messageThreadId, name) => {
      try {
        await bot.api.editForumTopic(chatId, messageThreadId, { name });
        return true;
      } catch (error) {
        if (/TOPIC_NOT_MODIFIED/i.test(formatError(error))) return true;
        console.warn("Inbox completion topic rename failed: TELEGRAM_TOPIC_RENAME_FAILED");
        return false;
      }
    },
    setTopicTitle: (ticketId, title) => inbox.setTopicTitle(ticketId, title),
    saveAnswer: saveTicketAnswer,
  }));

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    pendingWorkspacePicks.delete(key);
    pendingWorkspaceButtons.delete(key);
    lastPromptInput.delete(key);
    promptTails?.delete(key);
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

  const startNewThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
    workspace: string,
    messageId?: number,
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey)
        ? "New OpenAI thread created for this topic."
        : "New OpenAI thread created.";
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
  };

  const executeUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    persistentJob: PersistentTelegramJob,
    options: PromptDispatchOptions,
  ): Promise<void> => {
    if (legacyJobStore().get(persistentJob.id)?.state === "aborted") return;
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
        if (legacyJobStore().hasPart(persistentJob.id, partKey)) continue;
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
        legacyJobStore().markPartSent(persistentJob.id, partKey);
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
      if (legacyJobStore().hasPart(persistentJob.id, partKey)) {
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
        legacyJobStore().markPartSent(persistentJob.id, partKey);
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

      const transformedText = options.transformFinalText
        ? await options.transformFinalText(accumulatedText)
        : accumulatedText;
      const finalText = buildFinalResponseText(transformedText);
      if (!finalText) {
        // A hook that blocked the prompt ends the turn as a success with nothing
        // in it, so an empty turn is the only chance to report the block.
        const emptyTurnText = hookBlock
          ? `**⛔ Ход остановлен хуком \`${hookBlock.eventName}\`**\n\n${hookBlock.reason}`
          : "**✅ Done**";
        await deliverRenderedChunks(splitMarkdownForTelegram(emptyTurnText));
      } else {
        const chunks = splitMarkdownForTelegram(finalText);
        if (!(chunks.length > 1 && (await deliverMarkdownDocument(finalText)))) {
          await deliverRenderedChunks(chunks, finalText);
        }
      }

      if (options.afterFinalResponse) {
        try {
          await options.afterFinalResponse(transformedText, persistentJob);
        } catch (error) {
          console.warn("Ticket post-processing failed:", friendlyErrorText(error));
        }
      }
    };

    const deliverGeneratedImages = async (): Promise<void> => {
      for (const [index, image] of generatedImages.entries()) {
        const partKey = `image:${index}`;
        if (legacyJobStore().hasPart(persistentJob.id, partKey)) continue;
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
          legacyJobStore().markPartSent(persistentJob.id, partKey);
        } catch (photoError) {
          try {
            await bot.api.sendDocument(chatId, new InputFile(imagePath, path.basename(imagePath)), {
              ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
            });
            legacyJobStore().markPartSent(persistentJob.id, partKey);
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
        legacyJobStore().update(persistentJob.id, { state: "active", turnId });
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
        try {
          const info = session.getInfo();
          usageStore.record({
            ts: Date.now(),
            contextKey,
            workspace: info.workspace,
            model: info.model,
            ...usage,
          });
        } catch (error) {
          console.warn("Failed to record token usage:", friendlyErrorText(error));
        }
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
        legacyJobStore().update(persistentJob.id, { state: "failed" });
        return;
      }

      legacyJobStore().update(persistentJob.id, { threadId: session.getInfo().threadId });
      if ((session.getInfo().modelProvider ?? "openai") === "openai") {
        const authStatus = await checkAuthStatus(config.codexApiKey);
        if (!authStatus.authenticated) {
          legacyJobStore().update(persistentJob.id, { state: "failed" });
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
      const latestJob = legacyJobStore().get(persistentJob.id)!;
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
      legacyJobStore().update(persistentJob.id, { state: "delivering" });
      updateSessionMetadata(contextKey, session);
      if (!accumulatedText.trim()) accumulatedText = fallbackAccumulatedText;
      await deliverPromptSuccess({
        deliverResponse: finalizeResponse,
        deliverImages: deliverGeneratedImages,
        completeProgress: () => progress.complete(),
        onProgressError: (progressError) => {
          console.error("Failed to mark progress checkpoint as completed", progressError);
        },
      });
      legacyJobStore().update(persistentJob.id, { state: "completed" });
    } catch (error) {
      stopTyping();
      if (!accumulatedText.trim()) accumulatedText = fallbackAccumulatedText;
      if (legacyJobStore().get(persistentJob.id)?.state !== "aborted") {
        legacyJobStore().update(persistentJob.id, { state: codexCompleted ? "delivering" : "failed" });
      }
      await deliverPromptError({
        deliverResponse: async () => {
          if (finalized) {
            console.error("Codex prompt error after finalization:", formatError(error));
            return;
          }
          finalized = true;
          const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
          const chunks = splitMarkdownForTelegram(combinedText);
          await deliverRenderedChunks(chunks, combinedText);
        },
        failProgress: () => progress.fail(friendlyErrorText(error)),
        onDeliveryError: (telegramError) => {
          console.error("Failed to send error message to Telegram:", telegramError);
        },
        onProgressError: (progressError) => {
          console.error("Failed to mark progress checkpoint as failed", progressError);
        },
      });
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
    const persistentJob = recoveredJob ?? legacyJobStore().create({
      contextKey,
      chatId: parsed.chatId,
      messageThreadId: parsed.messageThreadId,
      threadId: session.getInfo().threadId,
      input: userInput,
      cleanupInbox: options.cleanupInbox,
    });
    const previous = promptTails?.get(contextKey) ?? Promise.resolve();
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
          await executeUserPrompt(ctx, contextKey, chatId, session, input, persistentJob, options);
        } finally {
          if (activeJobIds.get(contextKey) === persistentJob.id) activeJobIds.delete(contextKey);
          try {
            if (canWriteFiles) {
              await deliverArtifacts(ctx, chatId, outDir, parsed.messageThreadId);
            }
          } catch (artifactError) {
            console.error("Failed to deliver artifacts:", artifactError);
          }
          const finishedJob = legacyJobStore().get(persistentJob.id);
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
        if (promptTails?.get(contextKey) === tail) promptTails.delete(contextKey);
      });
    promptTails?.set(contextKey, tail);
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
    if (bot.statusBoard?.isDashboardTopic(ctx.chat?.id, messageThreadId)) {
      await bot.statusBoard.protectTopicMessage(
        ctx.chat?.id,
        messageThreadId,
        isTopicLifecycleMessage(ctx.message) ? undefined : ctx.message?.message_id,
      );
      return;
    }

    if (isTopicLifecycleMessage(ctx.message)) {
      return;
    }

    const fromId = ctx.from?.id;
    const guardianCallback = ctx.callbackQuery?.data?.startsWith("guardian_restore:") ?? false;
    const guardianChatRejected = guardianCallback
      && ctx.chat?.id !== config.telegramForumChatId;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId) || guardianChatRejected) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  if (config.sessionGuardianSocketPath) {
    registerGuardianCallbacks(bot, {
      socketPath: config.sessionGuardianSocketPath,
      requestTimeoutMs: 15_000,
    });
  }

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
    const miniAppUrl = config.miniApp
      ? jiraMiniAppLaunchUrl(config.miniApp.launchUrl)
      : undefined;
    if (miniAppUrl) {
      if (panel.matches(chatId, topicId)) {
        try {
          await panel.open();
        } catch (error) {
          await safeReply(ctx, `<b>Jira panel failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
            fallbackText: `Jira panel failed: ${friendlyErrorText(error)}`,
          });
        }
        return;
      }
      await safeReply(ctx, "<b>Jira · mircli</b>", {
        fallbackText: `Jira · mircli: ${miniAppUrl}`,
        replyMarkup: new InlineKeyboard().url("Открыть Jira", miniAppUrl),
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
      await startNewThread(
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

  bot.command("model", async (ctx) => {
    await safeReply(
      ctx,
      "<b>Model selection is disabled.</b> New threads use the OpenAI default.",
      { fallbackText: "Model selection is disabled. New threads use the OpenAI default." },
    );
  });

  bot.command("abort", async (ctx) => {
    if (reliability) {
      const source = canonicalControlSource(ctx);
      if (!source) return;
      const target = checkedCanonicalJobRef(await reliability.latestJob(canonicalContext(source)));
      if (!target) {
        await safeReply(ctx, escapeHTML("Nothing to abort"), { fallbackText: "Nothing to abort" });
        return;
      }
      try {
        await reliability.abort({ source, target });
      } catch (error) {
        if (!isCanonicalVersionConflict(error)) throw error;
        await safeReply(ctx, escapeHTML("Status changed, refresh and try again"), {
          fallbackText: "Status changed, refresh and try again",
        });
        return;
      }
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
      return;
    }

    // Compatibility-only path until the canonical reliability runtime is enabled.
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    try {
      const queuedJob = [...legacyJobStore().listRecoverable(), ...legacyJobStore().listAwaitingModel()]
        .filter((job) => job.contextKey === contextKey)
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1);
      if (queuedJob && activeJobIds.get(contextKey) !== queuedJob.id) {
        legacyJobStore().update(queuedJob.id, { state: "aborted" });
        await cleanupJobInbox(queuedJob);
        await safeReply(ctx, escapeHTML("Aborted queued operation"), {
          fallbackText: "Aborted queued operation",
        });
        return;
      }
      const activeJobId = activeJobIds.get(contextKey);
      if (activeJobId) legacyJobStore().update(activeJobId, { state: "aborted" });
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
    if (reliability) {
      const source = canonicalControlSource(ctx);
      if (!source) return;
      const target = checkedCanonicalJobRef(await reliability.latestJob(canonicalContext(source)));
      if (!target) {
        await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
          fallbackText: "Nothing to retry. Send a message first.",
        });
        return;
      }
      try {
        await reliability.retry({ source, target });
      } catch (error) {
        if (!isCanonicalVersionConflict(error)) throw error;
        await safeReply(ctx, escapeHTML("Status changed, refresh and try again"), {
          fallbackText: "Status changed, refresh and try again",
        });
      }
      return;
    }

    // Compatibility-only path until the canonical reliability runtime is enabled.
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

  bot.command("usage", async (ctx) => {
    const rawDays = String(ctx.match ?? "").trim();
    if (rawDays && rawDays !== "7" && rawDays !== "30") {
      await safeReply(ctx, "Использование: <code>/usage [7|30]</code>", {
        fallbackText: "Использование: /usage [7|30]",
      });
      return;
    }
    const days = rawDays === "30" ? 30 : 7;
    try {
      const aggregates = usageStore.aggregate(days);
      const weeklyTotal = config.telegramWeeklyTokenLimit
        ? usageStore.aggregate(7).reduce((sum, item) => sum + item.totalTokens, 0)
        : undefined;
      const report = renderUsageReport(
        aggregates,
        days,
        config.telegramWeeklyTokenLimit,
        weeklyTotal,
      );
      await safeReply(ctx, report.html, { fallbackText: report.plain });
    } catch (error) {
      const message = `Не удалось прочитать статистику: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    }
  });

  const recipeMutes = new RecipeMutes(RECIPE_MUTES_PATH);

  /** Findings the scheduled recipes delivered; index is the position in that batch. */
  const findingFromCallback = (match: string | RegExpMatchArray | undefined) => {
    const groups = typeof match === "string" ? undefined : match;
    const runId = Number.parseInt(groups?.[1] ?? "", 10);
    const index = Number.parseInt(groups?.[2] ?? "", 10);
    const run = readPendingRun(RECIPE_STATE_PATH, runId);
    const finding = run?.findings[index];
    return run && finding ? { run, finding, runId, index } : undefined;
  };

  const reviewProject = (run: { project?: string; cwd: string }): string =>
    run.project ?? path.basename(run.cwd);

  const mutedIndices = (run: { findings: Finding[] }): Set<number> =>
    mutedRecipeFindingIndices(run.findings, recipeMutes.list());

  bot.callbackQuery(/^rnoop:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^rpage:(\d+):(\d+)$/, async (ctx) => {
    const groups = typeof ctx.match === "string" ? undefined : ctx.match;
    const runId = Number.parseInt(groups?.[1] ?? "", 10);
    const page = Number.parseInt(groups?.[2] ?? "", 10);
    const run = readPendingRun(RECIPE_STATE_PATH, runId);
    if (!run) {
      await ctx.answerCallbackQuery({ text: "Находки больше не доступны" });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(renderRecipeDigestHTML({
      project: reviewProject(run),
      findings: run.findings,
      page,
      repeatedCount: run.repeatedCount,
      suppressedCount: run.suppressedCount,
    }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: recipeDigestKeyboard(runId, run.findings, page, mutedIndices(run)),
    });
  });

  bot.callbackQuery(/^rdetail:(\d+):(\d+)$/, async (ctx) => {
    const found = findingFromCallback(ctx.match ?? undefined);
    if (!found) {
      await ctx.answerCallbackQuery({ text: "Находка больше не доступна" });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(renderRecipeFindingDetailHTML(
      reviewProject(found.run),
      found.finding,
      found.index,
      found.run.findings.length,
    ), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: recipeFindingDetailKeyboard(
        found.runId,
        found.index,
        mutedIndices(found.run).has(found.index),
      ),
    });
  });

  bot.callbackQuery(/^rdmute:(\d+):(\d+)$/, async (ctx) => {
    const found = findingFromCallback(ctx.match ?? undefined);
    if (!found) {
      await ctx.answerCallbackQuery({ text: "Находка больше не доступна" });
      return;
    }

    if (!recipeMutes.add(fingerprintFinding(found.finding))) {
      await ctx.answerCallbackQuery({ text: "Не удалось сохранить заглушение" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Заглушено, больше не покажу" });
    await ctx.editMessageText(renderRecipeDigestHTML({
      project: reviewProject(found.run),
      findings: found.run.findings,
      page: Math.floor(found.index / RECIPE_DIGEST_PAGE_SIZE),
      repeatedCount: found.run.repeatedCount,
      suppressedCount: found.run.suppressedCount,
    }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: recipeDigestKeyboard(
        found.runId,
        found.run.findings,
        Math.floor(found.index / RECIPE_DIGEST_PAGE_SIZE),
        mutedIndices(found.run),
      ),
    });
  });

  bot.callbackQuery(/^rmute:(\d+):(\d+)$/, async (ctx) => {
    const found = findingFromCallback(ctx.match ?? undefined);
    if (!found) {
      await ctx.answerCallbackQuery({ text: "Находка больше не доступна" });
      return;
    }

    if (!recipeMutes.add(fingerprintFinding(found.finding))) {
      await ctx.answerCallbackQuery({ text: "Не удалось сохранить заглушение" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Заглушено, больше не покажу" });
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: recipeFindingDetailKeyboard(found.runId, found.index, true),
      });
    } catch {
      // The message may already have changed; the mute itself is persisted.
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

  const launchedSentryMessages = new Set<string>();

  bot.callbackQuery(/^sentry_task:/, async (ctx) => {
    const callback = parseSentryTaskCallback(ctx.callbackQuery.data);
    const chatId = ctx.chat?.id;
    const sourceTopicId = ctx.callbackQuery.message?.message_thread_id;
    const sourceMessageId = ctx.callbackQuery.message?.message_id;
    if (!callback || !chatId || !sourceTopicId || !sourceMessageId) {
      await ctx.answerCallbackQuery({ text: "Некорректная кнопка Sentry", show_alert: true });
      return;
    }

    const launchKey = `${chatId}:${sourceMessageId}`;
    if (launchedSentryMessages.has(launchKey)) {
      await ctx.answerCallbackQuery({ text: "Разбор уже запущен" });
      return;
    }
    launchedSentryMessages.add(launchKey);

    try {
      const configPath = process.env.RECIPES_CONFIG?.trim() || RECIPE_CONFIG_PATH;
      const recipes = parseRecipes(await readFile(configPath, "utf8"));
      const recipe = recipes.find((candidate) =>
        candidate.kind === "sentry-top"
        && candidate.deliver.chatId === chatId
        && candidate.deliver.messageThreadId === sourceTopicId
      );
      if (!recipe || recipe.kind !== "sentry-top") {
        throw new Error("Эта кнопка работает только в топике Sentry-рецепта");
      }

      if (reliability) {
        const topicName = sentryTaskTopicName(callback.shortId);
        const rawSource = canonicalWorkSource(
          ctx,
          "confirmation",
          buildSentryAnalysisPrompt(callback.issueId, callback.shortId, recipe.realm),
          null,
          { workspace: recipe.cwd, launchProfileId: "readonly", topicName },
          undefined,
          undefined,
          { kind: "forum_topic", topicName, state: "planned" },
        );
        if (!rawSource) throw new Error("Некорректная кнопка Sentry");
        const source = canonicalCallbackWorkSource(rawSource, ctx.callbackQuery.data);
        const target = await reliability.handleWork(source);
        if (!target) throw new Error("Не удалось закрепить топик Sentry");
        registry.setContextDefaults(contextKeyFromMessage(target.chatId, target.messageThreadId), {
          workspace: recipe.cwd, launchProfileId: "readonly", topicName,
        });
        await ctx.answerCallbackQuery({ text: "Тред создан, разбор запущен" });
        const url = topicUrl(target.chatId, target.messageThreadId);
        await safeReply(ctx, `Разбор <a href="${url}">${escapeHTML(callback.shortId)}</a> запущен.`, {
          fallbackText: `Разбор ${callback.shortId}: ${url}`,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: "Создаю тред и запускаю разбор..." });
      const result = await openSentryTaskThread(callback, {
        createTopic: async (topicName) => {
          const topic = await bot.api.createForumTopic(chatId, topicName);
          return topic.message_thread_id;
        },
        initializeTopic: async (topicId, topicName) => {
          registry.setContextDefaults(contextKeyFromMessage(chatId, topicId), {
            workspace: recipe.cwd,
            launchProfileId: "readonly",
            topicName,
          });
          const card = [
            `🔎 <b>Sentry-разбор</b> · ${escapeHTML(callback.shortId)}`,
            `Проект: <code>${escapeHTML(recipe.cwd)}</code>`,
            "Режим: только диагностика, без изменений.",
          ].join("\n");
          await sendTextMessage(bot.api, chatId, card, {
            messageThreadId: topicId,
            fallbackText: `Sentry-разбор ${callback.shortId}`,
          });
        },
        startAnalysis: async (topicId, prompt) => {
          const workContextKey = contextKeyFromMessage(chatId, topicId);
          const session = await registry.getOrCreate(workContextKey, { deferThreadStart: true });
          void handleUserPrompt(ctx, workContextKey, chatId, session, prompt);
        },
      }, recipe.realm);

      const url = topicUrl(chatId, result.topicId);
      await safeReply(
        ctx,
        `Разбор <a href="${url}">${escapeHTML(callback.shortId)}</a> запущен.`,
        { fallbackText: `Разбор ${callback.shortId}: ${url}` },
      );
    } catch (error) {
      launchedSentryMessages.delete(launchKey);
      const text = `Не вышло: ${friendlyErrorText(error)}`;
      try {
        await ctx.answerCallbackQuery({ text: text.slice(0, 200), show_alert: true });
      } catch {
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      }
    }
  });

  /** Big enough for a real review, small enough not to blow up the turn. */
  const MR_DIFF_LIMIT = 60_000;
  const launchedMergeRequestMessages = new Set<string>();

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

    const sourceMessageId = ctx.callbackQuery.message?.message_id;
    const launchKey = `${chatId}:${sourceMessageId ?? 0}:${key}`;
    if (launchedMergeRequestMessages.has(launchKey)) {
      await ctx.answerCallbackQuery({ text: "Ревью уже запущено" });
      return;
    }
    launchedMergeRequestMessages.add(launchKey);
    try {
      const topicName = mergeRequestTopicName(mr);
      const workspace = repoWorkspace(mr.project);
      if (reliability) {
        const rawSource = canonicalWorkSource(
          ctx,
          "confirmation",
          buildReviewBootstrapPrompt(mr),
          null,
          { workspace, launchProfileId: "readonly", topicName },
          undefined,
          undefined,
          { kind: "forum_topic", topicName, state: "planned" },
        );
        if (!rawSource) throw new Error("Некорректная кнопка MR");
        const source = canonicalCallbackWorkSource(rawSource, ctx.callbackQuery.data);
        const target = await reliability.handleWork(source);
        if (!target) throw new Error("Не удалось закрепить топик MR");
        registry.setContextDefaults(contextKeyFromMessage(target.chatId, target.messageThreadId), {
          workspace, launchProfileId: "readonly", topicName,
        });
        await ctx.answerCallbackQuery({ text: "Тред создан, ревью запущено" });
        const url = topicUrl(target.chatId, target.messageThreadId);
        await safeReply(ctx, `Ревью <a href="${url}">!${mr.iid} ${escapeHTML(mr.project)}</a> запущено.`, {
          fallbackText: `Ревью !${mr.iid}: ${url}`,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: "Тяну дифф..." });
      const changes = await gitlab.fetchChanges(mr.projectId, mr.iid);
      const topic = await bot.api.createForumTopic(chatId, topicName);
      const workContextKey = contextKeyFromMessage(chatId, topic.message_thread_id);
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
      launchedMergeRequestMessages.delete(launchKey);
      await safeReply(ctx, `<b>Не вышло:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Не вышло: ${friendlyErrorText(error)}`,
      });
    }
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
  bot.callbackQuery(DISABLED_MODEL_SELECTION_CALLBACK_PATTERN, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Model selection is disabled. Use /new for OpenAI.",
    });
  });
  if (reliability) {
    bot.callbackQuery(CANONICAL_STATUS_ACTION_PATTERN, async (ctx) => {
      const source = canonicalControlSource(ctx);
      if (!source) {
        await ctx.answerCallbackQuery();
        return;
      }
      const target = checkedCanonicalJobRef({
        jobId: ctx.match?.[2] ?? "",
        version: Number.parseInt(ctx.match?.[3] ?? "", 10),
      });
      if (!target) return;
      const code = ctx.match?.[1];
      const fromPinnedDashboard = bot.statusBoard?.isDashboardMessage(
        source.chatId,
        source.messageThreadId ?? undefined,
        source.messageId,
      ) === true;
      const kinds = {
        f: "refresh", d: "details", i: "inspect", g: "guardian_restore",
        y: "retry_delivery", s: "send_again_warning",
      } as const;
      try {
        if (code === "a") {
          if (fromPinnedDashboard) {
            if (!reliability.runDashboardAction) {
              await ctx.answerCallbackQuery({ text: "Action unavailable" });
              return;
            }
            await reliability.runDashboardAction({
              kind: "abort", jobId: target.jobId, expectedVersion: target.version,
            });
          } else {
            await reliability.abort({ source, target });
          }
          await ctx.answerCallbackQuery({ text: "Aborting..." });
          return;
        }
        if (code === "r") {
          if (fromPinnedDashboard) {
            if (!reliability.runDashboardAction) {
              await ctx.answerCallbackQuery({ text: "Action unavailable" });
              return;
            }
            await reliability.runDashboardAction({
              kind: "retry_new_turn", jobId: target.jobId, expectedVersion: target.version,
            });
          } else {
            await reliability.retry({ source, target });
          }
          await ctx.answerCallbackQuery({ text: "Retry queued" });
          return;
        }
        const kind = code && Object.hasOwn(kinds, code) ? kinds[code as keyof typeof kinds] : undefined;
        if (!kind || !reliability.runDashboardAction) {
          await ctx.answerCallbackQuery({ text: "Action unavailable" });
          return;
        }
        const partKey = ctx.match?.[4];
        const action: TelegramStatusAction = {
          kind, jobId: target.jobId, expectedVersion: target.version,
          ...(partKey ? { partKey } : {}),
        };
        const actionContext = fromPinnedDashboard ? undefined : canonicalContext(source);
        await reliability.runDashboardAction(action, actionContext);
        await ctx.answerCallbackQuery({
          text: kind === "refresh" ? "Status refreshed"
            : kind === "retry_delivery" ? "Delivery retry queued"
              : kind === "send_again_warning" ? "Send again queued"
                : "Open Dashboard for full details",
        });
      } catch (error) {
        if (!isCanonicalStaleAction(error)) throw error;
        await ctx.answerCallbackQuery({ text: "Status changed, refresh" });
      }
    });
  }
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
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /effort again");

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    if (reliability) {
      await ctx.answerCallbackQuery({ text: "Status button expired" });
      return;
    }

    // Compatibility-only path until the canonical reliability runtime is enabled.
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
  const probeTopicLiveness = createForumTopicLivenessProbe({
    sendChatAction: (chatId, action, requestOptions, signal) =>
      bot.api.sendChatAction(chatId, action, requestOptions, signal as never),
  });
  const topicIsAlive = (chatId: number, messageThreadId: number): Promise<boolean> =>
    probeTopicLiveness({ chatId, messageThreadId });

  if (config.miniApp && config.jiraPanel && jiraPanelClient) {
    const panelConfig = config.jiraPanel;
    const sourceContextKey = contextKeyFromMessage(panelConfig.chatId, panelConfig.topicId);
    const workspace = panelConfig.workspace ?? config.workspace;
    bot.jiraMiniApp = createJiraMiniAppController({
      client: jiraPanelClient,
      findThreadUrl: (issueKey) => {
        const ticket = inbox.findTicketByKey(sourceContextKey, issueKey);
        return ticket?.workTopicId ? topicUrl(panelConfig.chatId, ticket.workTopicId) : undefined;
      },
      openThread: (issue) => openJiraTaskThread({
        chatId: panelConfig.chatId,
        sourceContextKey,
        workspace,
        launchProfileId: config.defaultLaunchProfileId,
        jiraClient: panelConfig.clientPath,
        issue,
      }, {
        inbox,
        topicIsAlive: (topicId) => topicIsAlive(panelConfig.chatId, topicId),
        createTopic: async (topicName) => {
          const topic = await bot.api.createForumTopic(panelConfig.chatId, topicName);
          return topic.message_thread_id;
        },
        initializeTopic: async (topicId, ticket, task) => {
          registry.setContextDefaults(contextKeyFromMessage(panelConfig.chatId, topicId), {
            workspace,
            launchProfileId: config.defaultLaunchProfileId,
            topicName: jiraTaskTopicName(task),
          });
          await sendTextMessage(bot.api, panelConfig.chatId, renderJiraTaskCardHTML(task), {
            messageThreadId: topicId,
            fallbackText: `${task.key}: ${task.summary}`,
            replyMarkup: ticketKeyboard(ticket).url("Открыть в Jira", task.url),
          });
        },
      }),
    });
  }

  const ensureHostThreadTopic = (
    thread: NonNullable<ReturnType<typeof getThread>>,
    chatId: number,
  ) => ensureThreadTopic(thread, {
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
      chatId,
      ctx.callbackQuery.message?.message_thread_id,
    ) === true;
    try {
      const result = await ensureHostThreadTopic(thread, chatId);

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

    await ctx.answerCallbackQuery({ text: "Creating OpenAI thread..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);
    await startNewThread(ctx, contextKey, session, workspace, messageId);
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

  registerInboxHandlers({
    bot,
    config,
    registry,
    inbox,
    jiraComment,
    topicActivity,
    getContextSession,
    isBusy,
    handleTicketPrompt: (ctx, contextKey, chatId, session, ticket) =>
      handleUserPrompt(
        ctx,
        contextKey,
        chatId,
        session,
        ticket.prompt,
        undefined,
        ticketPromptOptions(ticket.workTopicId),
      ),
    handleCanonicalTicketPrompt: reliability
      ? async (ctx, ticket) => {
          const source = canonicalWorkSource(ctx, "confirmation", ticket.prompt, null, {
            workspace: ticket.workspace,
            launchProfileId: ticket.launchProfileId ?? config.defaultLaunchProfileId,
            topicName: ticketHeading(ticket),
          });
          if (!source) throw new Error("Invalid canonical Telegram ticket source");
          await reliability.handleWork({
            ...source,
            completion: { kind: "inbox_ticket", ticketId: ticket.id },
          });
        }
      : undefined,
    topicIsAlive,
    sendText: (chatId, text, options) => sendTextMessage(bot.api, chatId, text, options),
    safeReply,
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }
    if (reliability) {
      const source = canonicalWorkSource(
        ctx,
        "text",
        userText,
        null,
        undefined,
        isImplementationAuthorization(userText)
          ? writableImplementationProfileId(config) ?? "missing-writable-profile"
          : undefined,
      );
      if (source) await reliability.handleWork(source);
      return;
    }

    // Compatibility-only path until the canonical reliability runtime is enabled.
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const busyState = getBusyState(contextKey);
    if (shouldBlockTextDuringSessionTransition(busyState)) {
      await safeReply(ctx, escapeHTML("Дождитесь завершения смены сессии."), {
        fallbackText: "Дождитесь завершения смены сессии.",
      });
      return;
    }

    const handoffRequested = session.getInfo().sandboxMode === "read-only"
      && isImplementationAuthorization(userText);
    if (handoffRequested) {
      if (isBusy(contextKey)) {
        await safeReply(ctx, escapeHTML("Дождитесь завершения текущей операции."), {
          fallbackText: "Дождитесь завершения текущей операции.",
        });
        return;
      }

      busyState.switching = true;
      await setReaction(ctx, "👀");
      try {
        const prepared = await prepareImplementationHandoff({
          text: userText,
          session,
          launchProfiles: config.launchProfiles,
          defaultLaunchProfileId: config.defaultLaunchProfileId,
          persistSession: () => updateSessionMetadata(contextKey, session),
          dispatchPrompt: () => {
            lastPromptInput.set(contextKey, userText);
            return handleUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
          },
          notify: async (forked) => {
            const warning = forked.unsafeLaunch ? " · ⚠️ full access" : "";
            const text = `🔓 Создан implementation-thread с сохранённой историей · ${forked.launchProfileBehavior}${warning}`;
            await safeReply(ctx, escapeHTML(text), { fallbackText: text });
          },
          onNotificationError: (error) => {
            console.warn("Failed to send implementation handoff notification:", friendlyErrorText(error));
          },
        });
        if (!prepared) {
          throw new Error("Implementation handoff was not prepared");
        }
        await prepared.prompt;
        await setReaction(ctx, "👍");
      } catch (error) {
        await clearReaction(ctx);
        const text = `Не удалось перейти к реализации: ${friendlyErrorText(error)}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      } finally {
        busyState.switching = false;
      }
      return;
    }

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
    if (reliability) {
      const voice = ctx.message.voice;
      const audio = ctx.message.audio;
      const kind = voice ? "voice" : "audio";
      const file = voice ?? audio;
      if (!file) return;
      const source = canonicalWorkSource(
        ctx,
        kind,
        captionText(ctx),
        attachmentRef(kind, file),
      );
      if (source) await reliability.handleWork(source);
      return;
    }

    // Compatibility-only path until the canonical reliability runtime is enabled.
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
    if (reliability) {
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;
      const source = canonicalWorkSource(
        ctx,
        "photo",
        captionText(ctx),
        attachmentRef("photo", photo, { name: "telegram-photo.jpg", mimeType: "image/jpeg" }),
      );
      if (source) await reliability.handleWork(source);
      return;
    }

    // Compatibility-only path until the canonical reliability runtime is enabled.
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
    if (reliability) {
      const document = ctx.message.document;
      const source = canonicalWorkSource(
        ctx,
        "document",
        captionText(ctx),
        attachmentRef("document", document),
      );
      if (source) await reliability.handleWork(source);
      return;
    }

    // Compatibility-only path until the canonical reliability runtime is enabled.
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
      legacyJobStore().listAwaitingModel(),
      topicIsAlive,
    );
    const awaitingModel = awaitingModelPartition.retained;
    const loggedDeadContexts = new Set<TelegramContextKey>();
    for (const job of awaitingModelPartition.dead) {
      legacyJobStore().update(job.id, { state: "failed" });
      if (!loggedDeadContexts.has(job.contextKey)) {
        loggedDeadContexts.add(job.contextKey);
        console.warn(`Dropping Telegram model picker for missing topic: ${job.contextKey}`);
      }
    }
    for (const job of awaitingModel) {
      legacyJobStore().useDefaultModel(job.id);
    }
    const recoverable = legacyJobStore().listRecoverable();
    await topicActivity.restoreStaleTopics({
      exclude: recoverable
        .filter((job) => job.state === "active" && isTopicActivityEligible(job.messageThreadId))
        .map((job) => ({ chatId: job.chatId, messageThreadId: job.messageThreadId! })),
    });
    if (awaitingModel.length) {
      console.log(`Queued ${awaitingModel.length} pending prompt(s) with the OpenAI default`);
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
          ticketPromptOptions(job.messageThreadId),
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
      miniAppLaunchUrl: config.miniApp?.launchUrl,
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
      remove: async (messageId, backgroundWrite) => {
        await removeStatusBoardMessage(
          () => backgroundWrite(() => bot.api.unpinChatMessage(boardChatId, messageId)),
          () => backgroundWrite(() => bot.api.deleteMessage(boardChatId, messageId)),
        );
      },
      deleteMessage: async (messageId) => {
        await bot.api.deleteMessage(boardChatId, messageId);
      },
      store: createStatusBoardStore(path.join(config.workspace, ".telecodex", "status.json")),
      backgroundWriteGate: options.backgroundWriteGate,
    });
    if (config.miniApp) {
      bot.dashboard = createDashboardController({
        chatId: boardChatId,
        collect: createDashboardSnapshotCollector(collectStatusSnapshot),
        ...(reliability?.loadDashboardSessionStatuses
          ? { loadSessionStatuses: () => reliability.loadDashboardSessionStatuses!() }
          : {}),
        ...(loadCanonicalReliability
          ? {
            loadReliability: loadCanonicalReliability,
            loadReliabilityForAction: () => reliability!.loadDashboardReliability!(),
          }
          : {}),
        ...(reliability?.runDashboardAction
          ? { runJobAction: (action: TelegramStatusAction) => reliability.runDashboardAction!(action) }
          : {}),
        getThread,
        ensureThreadTopic: (thread) => ensureHostThreadTopic(thread, boardChatId),
      });
    }
  }

  // Elapsed times are measured from when a thread was first seen working, so
  // this has to survive between refreshes.
  let activeSince = new Map<string, number>();
  let lastHostThreads: HostThreadView[] = [];
  let lastCodexAvailable = true;
  const liveStatusTopicByThreadId = new Map<string, number>();

  /**
   * What is running, from the app-server rather than from our own job store.
   *
   * A turn started in VS Code, in the CLI or by a subagent never touches the
   * job store, so a board built only from Telegram jobs sat empty while the
   * host was busy. The queue and the outcomes still come from the job store:
   * the app-server knows nothing about either.
   */
  async function collectStatusSnapshot(
    options: {
      maxRecentThreads?: number;
      includeCanonicalReliability?: boolean;
      refreshHostThreads?: boolean;
    } = {},
  ): Promise<StatusSnapshot> {
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

    const canonicalReliability = loadCanonicalReliability
      && options.includeCanonicalReliability !== false
      ? await loadCanonicalReliability()
      : null;
    const jobs: StatusJobView[] = canonicalReliability
      ? canonicalReliability.jobs.map(({ projection }) => {
          const meta = contexts.find((entry) => entry.threadId === projection.threadId);
          const context = meta ? parseContextKey(meta.contextKey) : null;
          return {
            state: projection.phase === "terminal"
              ? projection.outcome === "completed" ? "completed"
                : projection.outcome === "aborted" ? "aborted" : "failed"
              : projection.phase === "delivering" ? "delivering"
                : projection.phase === "accepted" || projection.phase === "queued" ? "waiting" : "active",
            label: `Job ${projection.shortJobId}`,
            workspace: meta?.workspace ?? config.workspace,
            ...(context?.messageThreadId === undefined ? {} : { messageThreadId: context.messageThreadId }),
            createdAt: projection.timestamps.acceptedAt,
            updatedAt: projection.timestamps.updatedAt,
            projection,
          };
        })
      : reliability ? [] : legacyJobStore().list().map((job) => {
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
    let codexAvailable = canonicalReliability
      ? canonicalReliability.appServer.connectivity === "connected"
      : lastCodexAvailable;
    if (options.refreshHostThreads !== false) {
      try {
        const host = await listHostThreads(registry.getAppServerClient(), { now, activeSince });
        activeSince = host.activeSince;
        lastHostThreads = host.threads;
        lastCodexAvailable = true;
      } catch {
        if (!canonicalReliability) codexAvailable = false;
        lastCodexAvailable = codexAvailable;
      }
    }

    // A thread we opened has a topic to jump to, and a name the user chose.
    const hostThreads: HostThreadView[] = lastHostThreads.map((thread) => {
      const topicName = topicNameByThreadId.get(thread.id);
      const messageThreadId = boardChatId === undefined
        ? undefined
        : findBoundTopic(contexts, boardChatId, thread.id);
      return {
        ...thread,
        ...(messageThreadId === undefined ? {} : { messageThreadId }),
        label: topicName ?? thread.label,
      };
    });
    const recentThreads = listRecentRootThreads(
      new Date(now - STATUS_HISTORY_WINDOW_MS),
    ).map((thread) => {
      const messageThreadId = boardChatId === undefined
        ? undefined
        : findBoundTopic(contexts, boardChatId, thread.id);
      return {
        threadId: thread.id,
        label: topicNameByThreadId.get(thread.id) ?? threadLabel(thread),
        workspace: thread.cwd,
        source: thread.source,
        updatedAt: thread.updatedAt.getTime(),
        ...(messageThreadId === undefined ? {} : { messageThreadId }),
      };
    });

    const snapshot = buildStatusSnapshot(jobs, hostThreads, {
      limit: config.telegramMaxActiveTopics,
      now,
      recentThreads,
      ...(options.maxRecentThreads === undefined
        ? {}
        : { maxRecentThreads: options.maxRecentThreads }),
      codexAvailable,
    });
    if (boardChatId !== undefined) {
      const actionable = [...snapshot.running, ...snapshot.recentThreads]
        .filter((row): row is typeof row & { threadId: string } => Boolean(row.threadId));
      bindSavedStatusTopics(actionable, liveStatusTopicByThreadId);
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
    { command: "usage", description: "Token usage by project" },
    { command: "title", description: "Rename the current ticket topic" },
    { command: "mr", description: "Open merge requests, tap to review" },
    { command: "retry", description: "Resend the last prompt" },
    { command: "abort", description: "Cancel current operation" },
    { command: "launch_profiles", description: "Select launch profile" },
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

export function renderUsageReport(
  aggregates: UsageAggregate[],
  days: 7 | 30,
  weeklyLimit?: number,
  weeklyTotal?: number,
): { html: string; plain: string } {
  const html = [`<b>Использование токенов</b>`, `За ${days} дней`];
  const plain = ["Использование токенов", `За ${days} дней`];

  if (aggregates.length === 0) {
    html.push("", "Завершённых ходов пока нет.");
    plain.push("", "Завершённых ходов пока нет.");
  } else {
    for (const item of aggregates) {
      const summary = [
        `Вход: ${formatTokenCount(item.inputTokens)}`,
        `кэш: ${formatTokenCount(item.cachedInputTokens)}`,
        `выход: ${formatTokenCount(item.outputTokens)}`,
        `Всего: ${formatTokenCount(item.totalTokens)}`,
        `ходов: ${item.turns}`,
      ].join(" · ");
      html.push("", `📁 <code>${escapeHTML(item.workspace)}</code>`, summary);
      plain.push("", `📁 ${item.workspace}`, summary);
    }
  }

  if (weeklyLimit !== undefined && weeklyTotal !== undefined) {
    const status = tokenBudgetStatus(weeklyTotal, weeklyLimit);
    if (status === "warning") {
      const percentage = Math.floor((weeklyTotal / weeklyLimit) * 100);
      const warning = `⚠️ Использовано ${percentage}% недельного лимита (${formatTokenCount(weeklyTotal)} / ${formatTokenCount(weeklyLimit)}).`;
      html.push("", warning);
      plain.push("", warning);
    } else if (status === "exceeded") {
      const warning = `🚨 Недельный лимит исчерпан (${formatTokenCount(weeklyTotal)} / ${formatTokenCount(weeklyLimit)}).`;
      html.push("", warning);
      plain.push("", warning);
    }
  }

  return { html: html.join("\n"), plain: plain.join("\n") };
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
