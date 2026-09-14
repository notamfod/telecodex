import { TelegramBackgroundWriteGateAdmissionCancelledError, TelegramBackgroundWriteGateDisposedError } from "./telegram-background-write-gate.js";
import { createHash, randomUUID } from "node:crypto";
import type { DeliveryPart, TelegramJob } from "./telegram-job-store.js";
import type { TelegramJobStatusProjection } from "./telegram-status-projection.js";
import { classifyTelegramStatusError } from "./telegram-grammy-transport.js";
import { renderTopicTask, taskAgentState } from "./topic-task-projection.js";
import { TopicTaskStore, type TopicTaskIdentity, type TopicTaskPatch, type TopicTaskRecord } from "./topic-task-store.js";

export interface TaskDestination { chatId: number; messageThreadId: number }
export interface TopicTaskTransport {
  send(destination: TaskDestination, html: string): Promise<number>;
  edit(destination: TaskDestination, messageId: number, html: string): Promise<void>;
  syncActions?(task: TopicTaskRecord): Promise<void>;
  pin(destination: TaskDestination, messageId: number): Promise<void>;
  probe(destination: TaskDestination): Promise<"live" | "closed" | "missing" | "unknown">;
}

/** Per-topic serialization; sending intent is never leased or retried after uncertainty. */
export class TopicTaskCardService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(readonly store: TopicTaskStore, private readonly transport: TopicTaskTransport) {}

  enabled(destination: TaskDestination): boolean {
    return !this.disposed && this.store.get(keyOf(destination))?.enabled === true;
  }

  activate(identity: TopicTaskIdentity): Promise<void> {
    return this.enqueue(keyOf(identity), async () => {
      const task = this.store.ensure(identity);
      if (!task.enabled) this.patch(task, { enabled: true });
      await this.render(task.contextKey, true);
    });
  }

  update(key: string, patch: TopicTaskPatch, options: { automaticTitle?: boolean; recheckPresence?: boolean; render?: boolean } = {}): Promise<void> {
    return this.enqueue(key, async () => {
      const task = this.store.get(key);
      if (!task) return;
      const next = { ...patch };
      if (options.automaticTitle && task.titleSource === "manual") { delete next.title; delete next.titleSource; }
      this.patch(task, next);
      if (options.render !== false) await this.render(key, options.recheckPresence);
    });
  }

  refresh(key: string, explicit = false): Promise<void> {
    return this.enqueue(key, () => this.render(key, explicit));
  }

  observe(job: TelegramJob, projection: TelegramJobStatusProjection, deliveries: readonly DeliveryPart[], destination: TaskDestination, waitingOn?: "input" | "approval", acceptanceOrder = job.acceptedAt): Promise<void> {
    const key = keyOf(destination);
    return this.enqueue(key, async () => {
      const task = this.store.get(key);
      if (!task?.enabled || projection.jobId !== job.id || projection.expectedVersion !== job.version) return;
      if (acceptanceOrder < task.latestJobOrder || (task.latestJobId === job.id && job.version < task.latestJobVersion)) return;
      if (acceptanceOrder === task.latestJobOrder && task.latestJobId && task.latestJobId !== job.id) return;
      const result = confirmedResultMessage(job, projection, deliveries);
      this.patch(task, {
        latestJobOrder: acceptanceOrder, latestJobId: job.id, latestJobAt: job.acceptedAt, latestJobVersion: job.version,
        threadId: job.threadId, agentState: taskAgentState(projection, waitingOn),
        lastEventAt: Math.max(job.updatedAt, projection.timestamps.lastEventAt ?? 0),
        ...(result ? { lastResultMessageId: result } : {}),
      });
      await this.render(key);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.pending.values()]);
    this.store.close();
  }

  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(key, next);
    void next.finally(() => { if (this.pending.get(key) === next) this.pending.delete(key); }).catch(() => {});
    return next;
  }

  private patch(task: TopicTaskRecord, patch: TopicTaskPatch): TopicTaskRecord {
    const updated = this.store.update(task.contextKey, task.version, patch);
    if (!updated) throw new Error("Task card changed concurrently");
    return updated;
  }

  private async presence(task: TopicTaskRecord, requireResponse = false): Promise<TopicTaskRecord> {
    let presence: TopicTaskRecord["presence"];
    try { const result = await this.transport.probe(task); presence = result === "live" ? "open" : result; }
    catch (error) {
      presence = "unknown";
      if (requireResponse) {
        if (task.presence !== "missing" && task.presence !== "closed") this.patch(task, { presence });
        throw error;
      }
    }
    // Inconclusive typing cannot erase a definitive deletion/closure observation.
    if (presence === "unknown" && (task.presence === "missing" || task.presence === "closed")) return task;
    return this.patch(task, { presence });
  }

  private async render(key: string, recheckPresence = false): Promise<void> {
    let task = this.store.get(key);
    if (!task?.enabled || this.disposed) return;
    if (recheckPresence && task.cardState === "ready" && task.presence !== "open") task = await this.presence(task);
    if (task.cardState === "sending" || task.cardState === "unknown") return;
    if (task.cardState === "none") {
      try { task = await this.presence(task, true); } catch { return; }
      if (task.presence === "missing" || task.presence === "closed") return;
      const rendered = renderTopicTask(task);
      const hash = digest(rendered.html);
      task = this.patch(task, { cardState: "sending", cardAttemptId: randomUUID() });
      let messageId: number;
      try { messageId = await this.transport.send(task, rendered.html); }
      catch (error) {
        const code = (error as { error_code?: number })?.error_code;
        const rejected = error instanceof TelegramBackgroundWriteGateAdmissionCancelledError
          || error instanceof TelegramBackgroundWriteGateDisposedError
          || (typeof code === "number" && code >= 400 && code < 500);
        const description = (error as { description?: string })?.description ?? "";
        const presence = code === 400 && /message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/iu.test(description) ? "missing"
          : code === 400 && /TOPIC_CLOSED|topic is closed/iu.test(description) ? "closed" : task.presence;
        this.patch(task, rejected ? { cardState: "none", cardAttemptId: null, enabled: false, presence } : { cardState: "unknown" });
        return;
      }
      // If committing the ID fails the durable 'sending' intent still blocks duplicate creation.
      task = this.patch(task, { cardState: "ready", cardMessageId: messageId, contentHash: hash, presence: "open" });
    }
    if (!task.cardMessageId) return;
    if (task.presence === "missing") return;
    if (task.pinState === "none" && task.presence === "open") {
      task = this.patch(task, { pinState: "unknown" });
      try {
        await this.transport.pin(task, task.cardMessageId!);
        task = this.patch(task, { pinState: "pinned" });
      } catch (error) {
        const code = (error as { error_code?: number })?.error_code;
        task = this.patch(task, { pinState: code === 400 || code === 403 ? "forbidden" : "unknown" });
      }
    }
    const html = renderTopicTask(task).html;
    const hash = digest(html);
    if (hash === task.contentHash) { await this.transport.syncActions?.(task); return; }
    try {
      await this.transport.edit(task, task.cardMessageId!, html);
      task = this.patch(task, { contentHash: hash });
      await this.transport.syncActions?.(task);
    } catch (error) {
      const apiError = error as { error_code?: number; description?: string };
      if (apiError?.error_code === 400 && /message is not modified/iu.test(apiError.description ?? "")) {
        this.patch(task, { contentHash: hash });
        return;
      }
      const classification = classifyTelegramStatusError("edit", error);
      if (classification.disposition !== "message_missing") return;
      try { task = await this.presence(task, true); } catch { return; }
      if (task.presence === "missing" || task.presence === "closed") return;
      // The old message is definitively absent. An intended replacement send may
      // proceed on inconclusive typing; its durable intent fences any ambiguity.
      this.patch(task, { cardState: "none", cardMessageId: null, cardAttemptId: null, contentHash: null, pinState: "none" });
      await this.render(key);
    }
  }
}

function keyOf(destination: TaskDestination): string { return `${destination.chatId}:${destination.messageThreadId}`; }
function digest(html: string): string { return createHash("sha256").update(html).digest("hex"); }

export function confirmedResultMessage(job: TelegramJob, projection: TelegramJobStatusProjection, deliveries: readonly DeliveryPart[]): number | null {
  if (!projection.isDone || job.phase !== "terminal" || job.outcome !== "completed" || job.responsePlan === undefined) return null;
  const final = deliveries.find((part) => part.jobId === job.id && part.state === "delivered" && part.telegramMessageId
    && job.responsePlan!.some((planned) => planned.partId === part.partKey && (planned.kind === "final" || planned.kind === "attachment")));
  if (final) return final.telegramMessageId;
  const hasAnswer = job.turnResult?.content.some((part) => part.kind === "text" && part.phase !== "commentary" && part.text.trim());
  if (job.responsePlan.some((part) => part.kind === "final") || !hasAnswer) return null;
  const anchor = deliveries.find((part) => part.jobId === job.id && part.partKey === "status-anchor" && part.state === "delivered"
    && ["edit_text", "edit_rich", "send_text", "send_rich"].includes((part.payload as { operation?: string })?.operation ?? ""));
  return anchor?.telegramMessageId ?? null;
}

export function isTaskCardCurrent(task: TopicTaskRecord): boolean {
  return task.cardState === "ready" && task.contentHash === digest(renderTopicTask(task).html);
}
