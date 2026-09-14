import { dashboardProjectId, safeLabel, safeWorkspace, type DashboardSession } from "./dashboard-api.js";
import { topicUrl } from "./projects.js";
import type { TopicTaskRecord, TopicTaskAgentState } from "./topic-task-store.js";
export type DashboardTask = TopicTaskRecord & { ticketKey?: string };
const labels: Record<TopicTaskAgentState, string> = {
  idle: "Готова к продолжению", accepted: "Запрос принят", queued: "В очереди", running: "В работе",
  needs_input: "Нужен твой ответ", needs_approval: "Нужно твоё разрешение", stalled: "Нужно проверить прогон",
  delivering: "Доставляю результат", result_ready: "Результат готов", failed: "Не удалось завершить прогон", unknown: "Состояние требует проверки",
};
export function dashboardTaskSession(task: DashboardTask, host?: DashboardSession): DashboardSession {
  const state = task.lifecycle === "completed" ? "completed"
    : task.agentState === "queued" ? "queued"
      : ["needs_input", "needs_approval"].includes(task.agentState) ? "waiting"
        : ["stalled", "failed", "unknown"].includes(task.agentState) ? "stalled"
          : ["accepted", "running", "delivering"].includes(task.agentState) ? "active" : "recent";
  const waitingOn = task.agentState === "needs_input" ? "input" : task.agentState === "needs_approval" ? "approval" : undefined;
  const pending = ["accepted", "queued", "running", "delivering", "needs_input", "needs_approval"].includes(task.agentState);
  const telegramUrl = topicUrl(task.chatId, task.messageThreadId);
  const row: DashboardSession = {
    id: `task:${task.taskId}`, threadId: task.threadId, label: safeLabel(task.title), workspace: safeWorkspace(task.workspace),
    projectId: dashboardProjectId(task.workspace), ...(task.ticketKey ? { ticketKey: safeLabel(task.ticketKey) } : {}),
    state, ...(waitingOn ? { waitingOn } : {}), timestamp: task.lastEventAt ?? task.updatedAt,
    telegramUrl, ...(task.threadId ? { codexUrl: `codex://threads/${task.threadId}` } : {}), canCreateTopic: false,
    taskContext: { stateLabel: task.lifecycle === "completed" ? "Задача завершена" : labels[task.agentState],
      confirmedAt: task.lastEventAt, resultStatus: pending ? "pending" : task.lastResultMessageId ? "available" : "missing",
      ...(task.lastResultMessageId ? { resultUrl: `${telegramUrl}/${task.lastResultMessageId}` } : {}),
      ...(waitingOn ? { waitingLabel: labels[task.agentState] } : {}) },
  };
  if (state === "completed" || !host || host.state === "recent" || (state === "queued" && host.state === "active")) return row;
  if (state === host.state && waitingOn === host.waitingOn) return row;
  const stateLabel = host.state === "stalled" ? "Нужно проверить прогон" : host.state === "waiting"
    ? host.waitingOn === "approval" ? "Нужно твоё разрешение" : host.waitingOn === "input" ? "Нужен твой ответ" : "Нужно твоё действие"
    : "В работе";
  // The host supplies current activity, while confirmation time remains the durable task event.
  const { waitingOn: _waitingOn, ...base } = row;
  const { waitingLabel: _waitingLabel, ...context } = row.taskContext!;
  return { ...base, state: host.state, ...(host.waitingOn ? { waitingOn: host.waitingOn } : {}),
    timestamp: Math.max(row.timestamp, host.timestamp),
    taskContext: { ...context, stateLabel, resultStatus: "pending",
      ...(host.state === "waiting" ? { waitingLabel: stateLabel } : {}) } };
}
