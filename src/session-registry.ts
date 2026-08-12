import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findLaunchProfile } from "./codex-launch.js";
import {
  CodexSessionService,
  createCodexSessionDependencies,
  type CodexSessionDependencies,
} from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import { parseContextKey, type TelegramContextKey } from "./context-key.js";
import type { CodexThreadRecord } from "./codex-state.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  updatedAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly sessionCreations = new Map<TelegramContextKey, Promise<CodexSessionService>>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private readonly sessionDependencies: CodexSessionDependencies;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(
    private readonly config: TeleCodexConfig,
    sessionDependencies?: CodexSessionDependencies,
  ) {
    this.persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    this.sessionDependencies = sessionDependencies ?? createCodexSessionDependencies(
      config.telegramMaxActiveTopics,
    );
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }
    const pending = this.sessionCreations.get(contextKey);
    if (pending) return pending;

    const meta = this.metadata.get(contextKey);
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    const creation = CodexSessionService.create(this.config, {
      workspace: meta?.workspace,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
    }, this.sessionDependencies);
    this.sessionCreations.set(contextKey, creation);

    try {
      session = await creation;
      this.sessions.set(contextKey, session);
      if (session.getInfo().threadId) {
        this.updateMetadata(contextKey, session);
      }
      return session;
    } finally {
      if (this.sessionCreations.get(contextKey) === creation) {
        this.sessionCreations.delete(contextKey);
      }
    }
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionService): void {
    const info = session.getInfo();
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  isThreadBoundInChat(threadId: string, chatId: number): boolean {
    return [...this.metadata.values()].some((entry) => {
      const context = parseContextKey(entry.contextKey);
      return (
        entry.threadId === threadId &&
        context.chatId === chatId &&
        context.messageThreadId !== undefined
      );
    });
  }

  /**
   * Pins the workspace and launch profile a context should start with.
   *
   * Used for a topic that has no Codex thread yet, so an inbox ticket can be
   * forced onto a safe sandbox regardless of the host-wide default.
   */
  setContextDefaults(
    contextKey: TelegramContextKey,
    defaults: { workspace: string; launchProfileId?: string },
  ): void {
    this.metadata.set(contextKey, {
      contextKey,
      threadId: null,
      workspace: defaults.workspace,
      launchProfileId: defaults.launchProfileId,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  bindThread(contextKey: TelegramContextKey, thread: CodexThreadRecord): void {
    this.metadata.set(contextKey, {
      contextKey,
      threadId: thread.id,
      workspace: thread.cwd,
      model: thread.model ?? undefined,
      launchProfileId: this.config.defaultLaunchProfileId,
      updatedAt: thread.updatedAt.getTime(),
    });
    this.persistMetadata();
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.sessionCreations.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.sessionCreations.clear();
    this.sessionDependencies.turnManager.dispose?.();
    this.sessionDependencies.client.close?.();
  }

  private persistMetadata(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, entry);
        }
      }
    } catch {
      // Silently ignore load errors.
    }
  }
}

function resolveLaunchProfileId(
  config: TeleCodexConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
