import { randomBytes } from "node:crypto";
import { projectTopicTaskActions, type TopicTaskAction } from "./topic-task-actions.js";
import { TopicTaskLifecycleService } from "./topic-task-lifecycle.js";
import type { TopicTaskRecord, TopicTaskStore } from "./topic-task-store.js";
import type { TelegramJobStatusProjection, TelegramStatusAction } from "./telegram-status-projection.js";

export interface TopicTaskControlsOptions {
  store: TopicTaskStore;
  eligible(task: { chatId: number; messageThreadId: number }): boolean;
  read(task: TopicTaskRecord): Promise<{ safe: boolean; projection: TelegramJobStatusProjection | null }>;
  serialize<T>(key: string, operation: () => Promise<T>): Promise<T>;
  transport: ConstructorParameters<typeof TopicTaskLifecycleService>[0]["transport"];
  syncInbox(task: TopicTaskRecord): Promise<unknown>;
  runJob(action: TelegramStatusAction, task: TopicTaskRecord): Promise<void>;
}
export const taskActionLabel = (action: TopicTaskAction): string => action.kind !== "job" ? action.kind === "complete" ? "Завершить задачу" : "Открыть снова" : ({ abort: "Остановить", refresh: "Обновить", details: "Подробнее", inspect: "Проверить", retry_new_turn: "Повторить прогон", guardian_restore: "Восстановить", retry_delivery: "Повторить доставку", recover_missing_topic: "Восстановить топик", resume_existing_topic: "Продолжить в топике", resume_existing_topic_warning: "Проверить продолжение", send_again_warning: "Проверить отправку" }[action.action.kind]);
export class TopicTaskControls {
  readonly lifecycle: TopicTaskLifecycleService;
  private readonly handles = new Map<string, TopicTaskAction>();
  constructor(private readonly options: TopicTaskControlsOptions) {
    this.lifecycle = new TopicTaskLifecycleService({ ...options, guard: task => this.guard(task) });
  }
  private async guard(task: TopicTaskRecord) {
    if (!this.options.eligible(task)) return { safe: false };
    const state = await this.options.read(task);
    return { safe: state.safe && (state.projection?.jobId ?? null) === task.latestJobId
      && (state.projection?.expectedVersion ?? 0) === task.latestJobVersion };
  }
  async actions(key: string): Promise<TopicTaskAction[]> {
    const task = this.options.store.get(key);
    if (!task || !this.options.eligible(task)) return [];
    const state = await this.options.read(task).catch(() => null);
    if (!state) return [];
    return projectTopicTaskActions({ task, canonicalActions: state.projection?.actions ?? [],
      guardSafe: state.safe && (state.projection?.jobId ?? null) === task.latestJobId && (state.projection?.expectedVersion ?? 0) === task.latestJobVersion,
      intent: this.options.store.getLifecycleIntent(key) });
  }
  async links(key: string): Promise<{ label: string; url: string }[]> {
    const task = this.options.store.get(key);
    if (!task?.enabled || !this.options.eligible(task) || !String(task.chatId).startsWith("-100")) return [];
    const base = `https://t.me/c/${String(task.chatId).slice(4)}/`;
    const links: { label: string; url: string }[] = [];
    if (task.presence !== "missing" && ["needs_input", "needs_approval"].includes(task.agentState)) {
      links.push({ label: task.agentState === "needs_input" ? "Ответить в топике" : "Открыть переписку",
        url: `${base}${task.messageThreadId}` });
    }
    if (task.lastResultMessageId) links.push({ label: "Последний результат", url: `${base}${task.lastResultMessageId}` });
    // A failed live inspection must not hide a previously confirmed result.
    const state = await this.options.read(task).catch(() => null);
    if (state?.projection?.jobId === task.latestJobId
      && state.projection.expectedVersion === task.latestJobVersion && state.projection.delivery.anchorMessageId) {
      const url = `${base}${state.projection.delivery.anchorMessageId}`;
      if (!links.some(link => link.url === url)) links.push({ label: "Подробности прогона", url });
    }
    return links;
  }
  token(action: TopicTaskAction): string {
    const serialized = JSON.stringify(action);
    for (const [token, existing] of this.handles) if (JSON.stringify(existing) === serialized) return token;
    const token = randomBytes(12).toString("base64url");
    this.handles.set(token, action);
    if (this.handles.size > 2048) this.handles.delete(this.handles.keys().next().value!);
    return token;
  }
  async callback(token: string, key: string) {
    const action = this.handles.get(token);
    if (!action || action.contextKey !== key) throw stale();
    return this.run(action);
  }
  async run(action: TopicTaskAction) {
    const legal = await this.actions(action.contextKey);
    if (!legal.some(candidate => sameTaskAction(candidate, action))) throw stale();
    if (action.kind !== "job") {
      const { kind, ...binding } = action;
      const result = await this.lifecycle.request({ ...binding, desired: kind === "complete" ? "completed" : "open" });
      if (result.status !== "complete") throw stale(result.status === "pending" ? "Изменение не подтверждено. Обнови состояние позже." : undefined);
      return;
    }
    // Canonical executor revalidates exact job identity and permissions.
    const task = this.options.store.get(action.contextKey)!;
    if (task.actionVersion !== action.expectedVersion || task.taskId !== action.taskId) throw stale();
    if (["details", "inspect"].includes(action.action.kind)) throw stale("Открой подробности прогона по ссылке в карточке.");
    await this.options.runJob(action.action, task);
  }
}
function stale(message = "Состояние изменилось. Обнови карточку или список."): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function sameTaskAction(left: TopicTaskAction, right: TopicTaskAction): boolean {
  return left.kind === right.kind && left.contextKey === right.contextKey && left.taskId === right.taskId
    && left.expectedVersion === right.expectedVersion && left.latestJobId === right.latestJobId
    && left.latestJobVersion === right.latestJobVersion && (left.kind !== "job" || right.kind === "job"
      && left.action.kind === right.action.kind && left.action.jobId === right.action.jobId
      && left.action.expectedVersion === right.action.expectedVersion
      && left.action.alertId === right.action.alertId && left.action.partKey === right.action.partKey);
}
