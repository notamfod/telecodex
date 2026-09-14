import type { TopicTaskLifecycle, TopicTaskLifecycleIntent, TopicTaskPresence, TopicTaskRecord, TopicTaskStore } from "./topic-task-store.js";

export interface TopicTaskLifecycleRequest {
  contextKey: string;
  taskId: string;
  expectedVersion: number;
  latestJobId: string | null;
  latestJobVersion: number;
  desired: TopicTaskLifecycle;
}
export interface TopicTaskLifecycleResult {
  status: "complete" | "pending" | "blocked" | "stale" | "failed";
  task: TopicTaskRecord | null;
  intent?: TopicTaskLifecycleIntent;
  reason?: string;
}
export interface TopicTaskLifecycleDependencies {
  store: TopicTaskStore;
  guard: (task: TopicTaskRecord) => Promise<{ safe: boolean; reason?: string }>;
  transport: {
    close: (task: TopicTaskRecord) => Promise<unknown>;
    reopen: (task: TopicTaskRecord) => Promise<unknown>;
    probe: (task: TopicTaskRecord) => Promise<TopicTaskPresence>;
  };
  syncInbox: (task: TopicTaskRecord) => Promise<unknown>;
  // Production must share this lock with task ingress and use one lifecycle service.
  serialize?: <T>(contextKey: string, operation: () => Promise<T>) => Promise<T>;
}
export class TopicTaskLifecycleService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: TopicTaskLifecycleDependencies) {}

  private serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.deps.serialize ? this.deps.serialize(key, operation) : operation());
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }

  request(input: TopicTaskLifecycleRequest): Promise<TopicTaskLifecycleResult> {
    return this.serialized(input.contextKey, async () => {
      const task = this.deps.store.get(input.contextKey);
      if (!task || !task.enabled || task.taskId !== input.taskId || task.actionVersion !== input.expectedVersion || task.latestJobId !== input.latestJobId || task.latestJobVersion !== input.latestJobVersion) return { status: "stale", task };
      const prior = this.deps.store.getLifecycleIntent(task.contextKey);
      if (prior && prior.phase !== "complete" && prior.outcome !== "failed") return { status: "pending", task, intent: prior };
      if (input.desired !== "completed" && input.desired !== "open") return { status: "blocked", task, reason: "invalid_desired" };
      if (input.desired === "completed" && (task.lifecycle !== "open" || task.presence !== "open")) return { status: "blocked", task, reason: "topic_not_open" };
      if (input.desired === "open" && (task.lifecycle !== "completed" || task.presence !== "closed")) return { status: "blocked", task, reason: "topic_not_closed" };
      const guard = await this.deps.guard(task);
      if (!guard.safe) return { status: "blocked", task, reason: guard.reason };
      const intent = this.deps.store.beginLifecycleIntent(input);
      if (!intent) return { status: "stale", task: this.deps.store.get(input.contextKey) };
      return this.perform(intent, task);
    });
  }

  reconcile(operationId: string, options: { retryRemote?: boolean } = {}): Promise<TopicTaskLifecycleResult> {
    const found = this.deps.store.listPendingLifecycleIntents().find(intent => intent.operationId === operationId);
    if (!found) return Promise.resolve({ status: "stale", task: null });
    return this.serialized(found.contextKey, async () => {
      const intent = this.deps.store.getLifecycleIntent(found.contextKey)!;
      const task = this.deps.store.get(found.contextKey);
      if (intent.operationId !== operationId || !task || task.taskId !== intent.taskId) return { status: "stale", task };
      if (intent.phase === "complete") return { status: "complete", task, intent };
      if (!this.sameJob(intent, task)) return { status: "blocked", task, intent, reason: "job_changed" };
      if (intent.phase === "telegram_confirmed") return this.finish(intent, task);
      const presence = await this.probe(task);
      if (presence === this.desiredPresence(intent)) return this.confirm(intent, task);
      if (!options.retryRemote || presence === "unknown" || presence === "missing") return { status: "pending", task, intent };
      if (task.actionVersion !== intent.expectedVersion || task.latestJobId !== intent.latestJobId || task.latestJobVersion !== intent.latestJobVersion) return { status: "blocked", task, intent, reason: "job_changed" };
      const guard = await this.deps.guard(task);
      if (!guard.safe) return { status: "blocked", task, intent, reason: guard.reason };
      const fresh = this.deps.store.get(task.contextKey);
      if (!fresh || fresh.actionVersion !== task.actionVersion || fresh.taskId !== task.taskId) return { status: "blocked", task: fresh, intent, reason: "task_changed" };
      return this.perform(intent, fresh);
    });
  }

  private desiredPresence(intent: TopicTaskLifecycleIntent): "closed" | "open" { return intent.desired === "completed" ? "closed" : "open"; }
  private async probe(task: TopicTaskRecord): Promise<TopicTaskPresence> {
    try { return await this.deps.transport.probe(task); } catch { return "unknown"; }
  }
  private async perform(intent: TopicTaskLifecycleIntent, task: TopicTaskRecord): Promise<TopicTaskLifecycleResult> {
    try {
      if (intent.desired === "completed") await this.deps.transport.close(task);
      else await this.deps.transport.reopen(task);
    } catch (error) {
      const candidate = error as { error_code?: number; description?: string; message?: string };
      if (/NOT_MODIFIED/i.test(candidate.description ?? candidate.message ?? "") && await this.probe(task) === this.desiredPresence(intent)) return this.confirm(intent, task);
      const failed = candidate.error_code === 403 || candidate.error_code === 400 && !/NOT_MODIFIED/i.test(candidate.description ?? candidate.message ?? "");
      const saved = this.deps.store.updateLifecycleIntent({ ...intent, outcome: failed ? "failed" : "unknown", reason: failed ? "telegram_rejected" : "telegram_unconfirmed" });
      return { status: failed ? "failed" : "pending", task, intent: saved, reason: saved.reason! };
    }
    return this.confirm(intent, task);
  }
  private sameJob(intent: TopicTaskLifecycleIntent, task: TopicTaskRecord): boolean {
    return task.taskId === intent.taskId && task.latestJobId === intent.latestJobId && task.latestJobVersion === intent.latestJobVersion;
  }
  private async confirm(intent: TopicTaskLifecycleIntent, task: TopicTaskRecord): Promise<TopicTaskLifecycleResult> {
    let current = this.deps.store.get(task.contextKey);
    if (!current || !this.sameJob(intent, current) || current.actionVersion !== intent.expectedVersion) return { status: "blocked", task: current, intent, reason: "task_changed" };
    if (intent.desired === "completed") {
      const guard = await this.deps.guard(current);
      if (!guard.safe) return { status: "blocked", task: current, intent, reason: guard.reason };
      current = this.deps.store.get(task.contextKey);
      if (!current || !this.sameJob(intent, current) || current.actionVersion !== intent.expectedVersion) return { status: "blocked", task: current, intent, reason: "task_changed" };
    }
    const saved = this.deps.store.updateLifecycleIntent({ ...intent, phase: "telegram_confirmed", outcome: null, reason: null });
    return this.finish(saved, current);
  }
  private async finish(intent: TopicTaskLifecycleIntent, task: TopicTaskRecord): Promise<TopicTaskLifecycleResult> {
    const current = this.deps.store.get(task.contextKey);
    if (!current || current.taskId !== intent.taskId) return { status: "stale", task: current, intent };
    if (!this.sameJob(intent, current)) return { status: "blocked", task: current, intent, reason: "job_changed" };
    const alreadyApplied = current.lifecycle === intent.desired && current.presence === this.desiredPresence(intent);
    if (current.actionVersion !== intent.expectedVersion && !(alreadyApplied && current.actionVersion === intent.expectedVersion + 1)) return { status: "blocked", task: current, intent, reason: "task_changed" };
    const updated = alreadyApplied ? current : this.deps.store.update(current.contextKey, current.version, { lifecycle: intent.desired, presence: this.desiredPresence(intent) });
    if (!updated) return { status: "pending", task: current, intent, reason: "task_changed" };
    try { await this.deps.syncInbox(updated); } catch {
      const saved = this.deps.store.updateLifecycleIntent({ ...intent, reason: "inbox_sync_failed" });
      return { status: "pending", task: updated, intent: saved, reason: "inbox_sync_failed" };
    }
    const saved = this.deps.store.updateLifecycleIntent({ ...intent, phase: "complete", outcome: null, reason: null });
    return { status: "complete", task: updated, intent: saved };
  }
}
