import type { ContextMetadata, SessionRegistry } from "./session-registry.js";
import type { TelegramContextKey } from "./context-key.js";
import { taskTopicName } from "./task-title.js";

interface Options {
  registry: Pick<SessionRegistry, "listContexts" | "setTopicNameDurably" | "getAppServerClient">;
  eligible(metadata: ContextMetadata): boolean;
  title(metadata: ContextMetadata): string | undefined;
  ticketKey?(metadata: ContextMetadata): string | undefined;
  edit(contextKey: TelegramContextKey, title: string): Promise<void>;
  report(error: unknown): void;
}

/** Desired names live in the registry; confirmations are intentionally rechecked after restart. */
export class TopicTitleSynchronizer {
  private readonly tails = new Map<TelegramContextKey, Promise<void>>();
  private readonly confirmed = new Map<TelegramContextKey, { telegram?: string; codex?: string }>();
  private reconciling = false;
  private stopped = false;
  private cursor = 0;

  constructor(private readonly options: Options) {}

  rename(contextKey: TelegramContextKey, title: string, ticketKey?: string): Promise<void> {
    return this.enqueue(contextKey, async () => {
      const meta = this.metadata(contextKey);
      if (this.stopped || !meta || !this.options.eligible(meta)) return;
      const name = taskTopicName(title, meta.workspace, ticketKey ?? this.options.ticketKey?.(meta));
      this.options.registry.setTopicNameDurably(contextKey, name);
      this.confirmed.delete(contextKey);
      await this.synchronize(contextKey, name);
    });
  }

  async reconcile(contextKey?: TelegramContextKey): Promise<void> {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      const candidates = this.options.registry.listContexts().filter(meta => this.options.eligible(meta)
        && (!contextKey || meta.contextKey === contextKey));
      const offset = contextKey ? 0 : this.cursor % Math.max(1, candidates.length);
      const batch = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, 10);
      if (!contextKey) this.cursor = (offset + batch.length) % Math.max(1, candidates.length);
      for (const meta of batch) {
        if (this.stopped) break;
        await this.enqueue(meta.contextKey, async () => {
          // Resolve inside the queue so a manual rename always supersedes stale reconciliation.
          const current = this.metadata(meta.contextKey);
          if (this.stopped || !current || !this.options.eligible(current)) return;
          const title = this.options.title(current);
          if (!title) return;
          const name = taskTopicName(title, current.workspace, this.options.ticketKey?.(current));
          if (current.topicName !== name) this.options.registry.setTopicNameDurably(current.contextKey, name);
          await this.synchronize(current.contextKey, name);
        }).catch(this.options.report);
      }
      const live = new Set(this.options.registry.listContexts().map(meta => meta.contextKey));
      for (const key of this.confirmed.keys()) if (!live.has(key)) this.confirmed.delete(key);
    } finally { this.reconciling = false; }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.tails.values()]);
  }

  private metadata(key: TelegramContextKey): ContextMetadata | undefined {
    return this.options.registry.listContexts().find(meta => meta.contextKey === key);
  }

  private enqueue(key: TelegramContextKey, operation: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.tails.set(key, next);
    void next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key); }).catch(() => {});
    return next;
  }

  private async synchronize(key: TelegramContextKey, name: string): Promise<void> {
    const confirmed = this.confirmed.get(key) ?? {};
    this.confirmed.set(key, confirmed);
    if (confirmed.telegram !== name) {
      await this.options.edit(key, name);
      confirmed.telegram = name;
    }
    const current = this.metadata(key);
    if (this.stopped || !current || current.topicName !== name || !current.threadId) return;
    const identity = `${current.threadId}\0${name}`;
    if (confirmed.codex === identity) return;
    try {
      await this.options.registry.getAppServerClient().request("thread/name/set", {
        threadId: current.threadId, name,
      }, { timeoutMs: 5_000 });
      confirmed.codex = identity;
    } catch (error) {
      // Telegram already has the desired title. Keep it durable and retry on reconciliation.
      this.options.report(error);
    }
  }
}
