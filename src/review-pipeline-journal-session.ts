import {
  createCodexSessionDependencies,
  type CodexSessionDependencies,
} from "./codex-session.js";
import type { AppServerTurnCallbacks } from "./app-server-turn-manager.js";

const MARKER_PREFIX = "[review-pipeline-journal:";
const MARKER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_TEXT_LENGTH = 64_000;

type JournalThread = {
  id?: unknown;
  status?: { type?: unknown };
  turns?: unknown;
};

type ThreadResponse = { thread?: JournalThread };

/**
 * A narrowly-scoped, persistent Codex thread for the visible audit trail of
 * one review batch. The only model input is an append-only journal record.
 */
export class ReviewPipelineJournalSessionClient {
  private readonly dependencies: CodexSessionDependencies;
  private readonly ownsDependencies: boolean;
  private readonly activeCallbacks = new Map<string, Set<AppServerTurnCallbacks>>();
  private disposed = false;

  constructor(dependencies?: CodexSessionDependencies) {
    this.ownsDependencies = dependencies === undefined;
    this.dependencies = dependencies ?? createCodexSessionDependencies(1);
  }

  async create(
    title: string,
    cwd: string,
    model: string,
    onCreated?: (threadId: string) => void,
  ): Promise<string> {
    this.assertOpen();
    const name = requiredText(title, "title", 512);
    const workspace = requiredText(cwd, "cwd", 4_096);
    const selectedModel = requiredText(model, "model", 512);
    await this.dependencies.client.connect();
    const response = await this.dependencies.client.request<ThreadResponse>("thread/start", {
      cwd: workspace,
      model: selectedModel,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      serviceName: "telecodex-review-pipeline",
      developerInstructions: "You are a review-pipeline journal. Do not take actions, inspect files, call tools, delegate work, or rewrite the supplied journal entry. Reply exactly: Запись сохранена.",
    });
    const threadId = threadIdFrom(response);
    onCreated?.(threadId);
    this.dependencies.turnManager.trackThread?.(
      threadId,
      threadStatus(response.thread?.status?.type),
    );
    try {
      await this.dependencies.client.request("thread/name/set", { threadId, name });
    } catch {
      // The caller has already stored the authoritative id and can retry the title later.
    }
    return threadId;
  }

  async inspect(threadId: string): Promise<{ busy: boolean; markers: string[] }> {
    this.assertOpen();
    const id = requiredText(threadId, "threadId", 512);
    await this.dependencies.client.connect();
    const response = await this.dependencies.client.request<ThreadResponse>("thread/read", {
      threadId: id,
      includeTurns: true,
    });
    const thread = response.thread;
    if (!thread || thread.id !== id || !thread.status || typeof thread.status.type !== "string") {
      throw new Error("Invalid journal thread response");
    }
    if (!Array.isArray(thread.turns)) throw new Error("Invalid journal thread turns");
    const markers = new Set<string>();
    for (const turn of thread.turns) collectMarkers(turn, markers);
    return { busy: threadStatus(thread.status.type) === "active", markers: [...markers] };
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    this.assertOpen();
    const id = requiredText(threadId, "threadId", 512);
    const name = requiredText(title, "title", 512);
    await this.dependencies.client.connect();
    await this.dependencies.client.request("thread/name/set", { threadId: id, name });
  }

  async append(
    threadId: string,
    cwd: string,
    model: string,
    key: string,
    text: string,
    onWritten: () => void,
  ): Promise<void> {
    this.assertOpen();
    const id = requiredText(threadId, "threadId", 512);
    const workspace = requiredText(cwd, "cwd", 4_096);
    const selectedModel = requiredText(model, "model", 512);
    if (!MARKER_KEY.test(key)) throw new Error("Invalid journal marker key");
    const entry = requiredText(text, "text", MAX_TEXT_LENGTH);
    const callbacks: AppServerTurnCallbacks = {
      beforeDispatchWrite: onWritten,
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onToolEnd: () => {},
      onAgentEnd: () => {},
    };
    this.callbacksFor(id).add(callbacks);
    try {
      await this.dependencies.turnManager.runTurn({
        threadId: id,
        cwd: workspace,
        model: selectedModel,
        reasoningEffort: "low",
        approvalPolicy: "never",
        sandbox: "read-only",
        input: [{
          type: "text",
          text: `${MARKER_PREFIX}${key}]\nJournal entry. Do not take actions, use tools, or rewrite it. Reply exactly: Запись сохранена.\n\n${entry}`,
          text_elements: [],
        }],
        callbacks,
      });
    } finally {
      const active = this.activeCallbacks.get(id);
      active?.delete(callbacks);
      if (active?.size === 0) this.activeCallbacks.delete(id);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.activeCallbacks.entries()].flatMap(([threadId, callbacks]) =>
      [...callbacks].map(async (callbacks) => {
        await this.dependencies.turnManager.cancelTurn?.(threadId, callbacks);
      }),
    ));
    this.activeCallbacks.clear();
    if (this.ownsDependencies) {
      this.dependencies.turnManager.dispose?.();
      this.dependencies.client.close?.();
    }
  }

  private callbacksFor(threadId: string): Set<AppServerTurnCallbacks> {
    let callbacks = this.activeCallbacks.get(threadId);
    if (!callbacks) {
      callbacks = new Set();
      this.activeCallbacks.set(threadId, callbacks);
    }
    return callbacks;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Review pipeline journal session is disposed");
  }
}

function threadIdFrom(response: ThreadResponse): string {
  const id = response.thread?.id;
  if (typeof id !== "string" || !id.trim() || id.length > 512) {
    throw new Error("Invalid journal thread creation response");
  }
  return id;
}

function threadStatus(value: unknown): "notLoaded" | "idle" | "systemError" | "active" {
  if (value === "notLoaded" || value === "idle" || value === "systemError" || value === "active") {
    return value;
  }
  throw new Error("Invalid journal thread status");
}

function collectMarkers(value: unknown, markers: Set<string>): void {
  if (!isRecord(value) || !Array.isArray(value.items)) return;
  for (const item of value.items) {
    if (!isRecord(item) || item.type !== "userMessage" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") continue;
      for (const match of content.text.matchAll(/\[review-pipeline-journal:([A-Za-z0-9][A-Za-z0-9._:-]{0,191})\]/g)) {
        markers.add(match[1]!);
      }
    }
  }
}

function requiredText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid journal ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
