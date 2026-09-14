import { TelegramBackgroundWriteGateAdmissionCancelledError } from "./telegram-background-write-gate.js";
import { definitiveTelegramRetryAfterMs } from "./telegram-rate-limit.js";
import type { TaskProvisioningService } from "./task-provisioning.js";
import { ForumTopicAvailabilityUnknownError } from "./telegram-topic-liveness.js";
import path from "node:path";

import type { CodexThreadRecord } from "./codex-state.js";
import { contextKeyFromMessage, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { escapeHTML } from "./format.js";
import type { ContextMetadata } from "./session-registry.js";
import { buildTopicName, threadLabel, workspaceLabel } from "./topic-sync.js";

/** Telegram truncates button labels past 64 code points. */
const MAX_LABEL_LENGTH = 60;

export interface ProjectGroup {
  name: string;
  workspace: string;
  threads: CodexThreadRecord[];
}

export interface ProjectButton {
  label: string;
  callbackData: string;
}

/**
 * Groups Codex threads by the workspace they run in.
 *
 * Reads the Codex database rather than the Telegram topic bindings, so a
 * session stays reachable even after its forum topic is deleted.
 */
export function groupThreadsByProject(threads: CodexThreadRecord[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();

  for (const thread of threads) {
    const workspace = thread.cwd ?? "";
    let group = groups.get(workspace);
    if (!group) {
      group = { name: workspaceLabel(workspace), workspace, threads: [] };
      groups.set(workspace, group);
    }
    group.threads.push(thread);
  }

  for (const group of groups.values()) {
    group.threads.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  return [...groups.values()].sort((left, right) => lastUsed(right) - lastUsed(left));
}

export function projectButtons(groups: ProjectGroup[]): ProjectButton[] {
  return groups.map((group, index) => ({
    label: shorten(`${group.name} (${group.threads.length})`),
    callbackData: `proj_${index}`,
  }));
}

/** Carries the thread id itself, so a pick still works after a restart. */
export function sessionButtons(group: ProjectGroup): ProjectButton[] {
  return group.threads.map((thread) => ({
    label: shorten(threadLabel(thread)),
    callbackData: `projopen:${thread.id}`,
  }));
}

/**
 * The topic this thread is already bound to in this chat, if any.
 *
 * A binding without a topic id is the chat's General context; treating it as a
 * topic is what let a picked session hijack General instead of getting its own.
 */
export function findBoundTopic(
  contexts: ContextMetadata[],
  chatId: number,
  threadId: string,
): number | undefined {
  for (const entry of contexts) {
    const context = parseContextKey(entry.contextKey);
    if (
      entry.threadId === threadId &&
      context.chatId === chatId &&
      context.messageThreadId !== undefined
    ) {
      return context.messageThreadId;
    }
  }
  return undefined;
}

export async function findLiveBoundTopic(
  contexts: ContextMetadata[],
  chatId: number,
  threadId: string,
  topicIsAlive: (messageThreadId: number) => Promise<boolean>,
): Promise<number | undefined> {
  const checked = new Set<number>();
  for (const entry of contexts) {
    const context = parseContextKey(entry.contextKey);
    const messageThreadId = context.messageThreadId;
    if (
      entry.threadId !== threadId
      || context.chatId !== chatId
      || messageThreadId === undefined
      || checked.has(messageThreadId)
    ) {
      continue;
    }
    checked.add(messageThreadId);
    if (await topicIsAlive(messageThreadId)) return messageThreadId;
  }
  return undefined;
}

export async function partitionJobsByTopicLiveness<
  T extends { chatId: number; messageThreadId?: number },
>(
  jobs: T[],
  topicIsAlive: (chatId: number, messageThreadId: number) => Promise<boolean>,
): Promise<{ retained: T[]; dead: T[]; unknown: T[] }> {
  const retained: T[] = [];
  const dead: T[] = [];
  const unknown: T[] = [];

  for (const job of jobs) {
    if (job.messageThreadId === undefined || job.messageThreadId === 1) {
      retained.push(job);
      continue;
    }

    try {
      (await topicIsAlive(job.chatId, job.messageThreadId) ? retained : dead).push(job);
    } catch {
      unknown.push(job);
    }
  }

  return { retained, dead, unknown };
}

export interface EnsureThreadTopicOptions {
  provisioning: TaskProvisioningService;
  excludeContextKey?: string;
  isExcludedTopic?(messageThreadId: number): boolean;
  chatId: number;
  contexts: ContextMetadata[];
  topicIsAlive(messageThreadId: number): Promise<boolean>;
  createForumTopic(name: string): Promise<{ message_thread_id: number }>;
  bindThread(contextKey: TelegramContextKey, thread: CodexThreadRecord): void;
  sendWelcome(messageThreadId: number, name: string): Promise<void>;
}

export interface EnsuredThreadTopic {
  availability?: "unknown";
  created: boolean;
  messageThreadId: number;
  name: string;
  url: string;
}

export async function ensureThreadTopic(
  thread: CodexThreadRecord,
  options: EnsureThreadTopicOptions,
): Promise<EnsuredThreadTopic> {
  const name = buildTopicName(thread);
  // Shared with automatic sync: one durable creation identity across all entry points.
  const operationId = `sync:${options.chatId}:${thread.id}`;
  const previous = options.provisioning.store.get(operationId);
  let availability: "unknown" | undefined;
  const reusable = async (messageThreadId: number): Promise<boolean> => {
    if (messageThreadId <= 1 || options.isExcludedTopic?.(messageThreadId)) return false;
    try { return await options.topicIsAlive(messageThreadId); }
    catch (error) {
      if (!(error instanceof ForumTopicAvailabilityUnknownError)) throw error;
      availability = "unknown";
      return true;
    }
  };
  const result = (messageThreadId: number, created: boolean): EnsuredThreadTopic => ({
    created, messageThreadId, name, url: topicUrl(options.chatId, messageThreadId),
    ...(availability ? { availability } : {}),
  });
  if (previous?.state === "ready" && previous.messageThreadId) {
    if (!options.contexts.some(context => context.contextKey === `${options.chatId}:${previous.messageThreadId}` && context.threadId === thread.id)) {
      throw new Error("Сохранённая привязка топика изменилась. Автоматическое создание замены остановлено.");
    }
    if (!await reusable(previous.messageThreadId)) throw new Error("Сохранённый топик недоступен. Автоматическое создание замены остановлено.");
    return result(previous.messageThreadId, false);
  }
  if (!previous) {
    const bound = await findLiveBoundTopic(
      options.contexts.filter(context => context.contextKey !== options.excludeContextKey),
      options.chatId, thread.id, reusable,
    );
    if (bound !== undefined) return result(bound, false);
  }
  if (typeof previous?.metadata?.retryAfterUntil === "number" && Date.now() < previous.metadata.retryAfterUntil) {
    throw new Error("Telegram просит подождать перед созданием топика. Повтори команду позже.");
  }
  let created = false;
  let creationError: unknown;
  const record = await options.provisioning.provision(previous ?? {
    operationId, sourceContextKey: String(options.chatId), sourceMessageIds: [],
    title: name, workspace: thread.cwd, kind: "sync", metadata: { threadId: thread.id },
  }, {
    createTopic: async item => {
      try {
        const topic = await options.createForumTopic(item.title);
        created = true;
        return topic.message_thread_id;
      } catch (error) { creationError = error; throw error; }
    },
    bind: item => options.bindThread(contextKeyFromMessage(options.chatId, item.messageThreadId!), thread),
    ready: item => options.sendWelcome(item.messageThreadId!, item.title),
  });
  if (creationError !== undefined && record.failureStage === "create" && !record.messageThreadId) {
    const retryAfterMs = definitiveTelegramRetryAfterMs(creationError);
    if (retryAfterMs !== undefined || creationError instanceof TelegramBackgroundWriteGateAdmissionCancelledError) {
      options.provisioning.store.patch(operationId, { state: "accepted", failureStage: undefined,
        metadata: { ...record.metadata, retryAfterUntil: Date.now() + (retryAfterMs ?? 1000) } });
      throw new Error("Telegram просит подождать перед созданием топика. Повтори команду позже.");
    }
  }
  if (record.state !== "ready" || !record.messageThreadId) {
    throw new Error("Создание или привязка топика не подтверждены. Повторное создание остановлено; нужна проверка.");
  }
  return result(record.messageThreadId, created);
}

/** Private supergroups are addressed by their id without the -100 prefix. */
export function topicUrl(chatId: number, messageThreadId: number): string {
  return `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${messageThreadId}`;
}

export function renderProjectsHTML(groups: ProjectGroup[]): string {
  if (groups.length === 0) {
    return "No Codex sessions yet. Start one here or in the terminal.";
  }

  return [
    ...groups.map((group) => `📁 ${projectHeader(group)}`),
    "",
    "Pick a project to list its sessions.",
  ].join("\n");
}

export function renderProjectHTML(group: ProjectGroup): string {
  return [
    `📁 ${projectHeader(group)}`,
    "",
    "Выбери сессию для продолжения.",
  ].join("\n");
}

function projectHeader(group: ProjectGroup): string {
  return `<b>${escapeHTML(group.name)}</b> (${group.threads.length})${renderWorkspacePath(group)}`;
}

/** Only shows the path when its directory name survived redaction. */
function renderWorkspacePath(group: ProjectGroup): string {
  return group.name === path.basename(group.workspace)
    ? ` — <code>${escapeHTML(group.workspace)}</code>`
    : "";
}

function lastUsed(group: ProjectGroup): number {
  return group.threads[0]?.updatedAt.getTime() ?? 0;
}

/** A Codex title is the whole first message, so it needs a hard ceiling here. */
function shorten(label: string): string {
  const characters = [...label];
  return characters.length <= MAX_LABEL_LENGTH
    ? label
    : `${characters.slice(0, MAX_LABEL_LENGTH - 1).join("")}…`;
}
