import type { TelegramStatusAction } from "./telegram-status-projection.js";
import type { TopicTaskLifecycleRequest } from "./topic-task-lifecycle.js";
import type { TopicTaskLifecycleIntent, TopicTaskRecord } from "./topic-task-store.js";

export type TopicTaskAction = Omit<TopicTaskLifecycleRequest, "desired"> & (
  | { kind: "job"; action: TelegramStatusAction }
  | { kind: "complete" | "reopen" }
);

/** Wrap canonical actions without reconstructing job identity or retry payloads. */
export function projectTopicTaskActions(input: {
  task: TopicTaskRecord;
  canonicalActions: readonly TelegramStatusAction[];
  guardSafe: boolean;
  intent: TopicTaskLifecycleIntent | null;
}): TopicTaskAction[] {
  const { task, intent } = input;
  if (!task.enabled) return [];
  const binding = { contextKey: task.contextKey, taskId: task.taskId, expectedVersion: task.actionVersion, latestJobId: task.latestJobId, latestJobVersion: task.latestJobVersion };
  const pending = intent !== null && intent.phase !== "complete" && intent.outcome !== "failed";
  const readKinds = new Set(["refresh", "details", "inspect"]);
  const actions: TopicTaskAction[] = input.canonicalActions
    .filter(action => action.jobId === task.latestJobId && action.expectedVersion === task.latestJobVersion)
    .filter(action => {
      if (readKinds.has(action.kind)) return true;
      if (pending || task.lifecycle === "completed" || task.presence === "closed") return false;
      return task.presence !== "missing" || action.kind === "recover_missing_topic";
    })
    .map(action => ({ ...binding, kind: "job", action }));
  if (!pending && input.guardSafe) {
    if (task.lifecycle === "open" && task.presence === "open") actions.push({ ...binding, kind: "complete" });
    if (task.lifecycle === "completed" && task.presence === "closed") actions.push({ ...binding, kind: "reopen" });
  }
  return actions;
}
