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

export function isMissingForumTopicError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(message);
}

export async function probeForumTopic(
  messageThreadId: number,
  options: {
    reopen(messageThreadId: number): Promise<unknown>;
    close(messageThreadId: number): Promise<unknown>;
  },
): Promise<boolean> {
  try {
    await options.reopen(messageThreadId);
  } catch (error) {
    if (isMissingForumTopicError(error)) return false;
    if (isTopicNotModifiedError(error)) return true;
    throw error;
  }

  try {
    await options.close(messageThreadId);
  } catch (error) {
    if (!isTopicNotModifiedError(error)) throw error;
  }
  return true;
}

function isTopicNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TOPIC_NOT_MODIFIED|topic is already (?:open|closed)/i.test(message);
}

export interface EnsureThreadTopicOptions {
  chatId: number;
  contexts: ContextMetadata[];
  topicIsAlive(messageThreadId: number): Promise<boolean>;
  createForumTopic(name: string): Promise<{ message_thread_id: number }>;
  bindThread(contextKey: TelegramContextKey, thread: CodexThreadRecord): void;
  sendWelcome(messageThreadId: number, name: string): Promise<void>;
}

export interface EnsuredThreadTopic {
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
  const bound = await findLiveBoundTopic(
    options.contexts,
    options.chatId,
    thread.id,
    options.topicIsAlive,
  );
  if (bound !== undefined) {
    return {
      created: false,
      messageThreadId: bound,
      name,
      url: topicUrl(options.chatId, bound),
    };
  }

  const topic = await options.createForumTopic(name);
  const contextKey = contextKeyFromMessage(options.chatId, topic.message_thread_id);
  options.bindThread(contextKey, thread);
  await options.sendWelcome(topic.message_thread_id, name);
  return {
    created: true,
    messageThreadId: topic.message_thread_id,
    name,
    url: topicUrl(options.chatId, topic.message_thread_id),
  };
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
    "Tap a session to continue it in this topic.",
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
