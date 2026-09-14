import { expect, it } from "vitest";
import { projectTopicTaskActions } from "../src/topic-task-actions.js";
import type { TopicTaskRecord, TopicTaskLifecycleIntent } from "../src/topic-task-store.js";
const task = { contextKey: "-123:4", taskId: "task", version: 8, actionVersion: 3, enabled: true, lifecycle: "open", presence: "open", latestJobId: "job", latestJobVersion: 8 } as TopicTaskRecord;
const canonical = { kind: "retry_delivery" as const, jobId: "job", expectedVersion: 8, partKey: "part" };
it("preserves exact captured canonical action and task version", () => { const actions = projectTopicTaskActions({ task, canonicalActions: [canonical], guardSafe: true, intent: null }); expect(actions[0]).toEqual({ kind: "job", contextKey: task.contextKey, taskId: "task", expectedVersion: 3, latestJobId: "job", latestJobVersion: 8, action: canonical }); expect(actions[0]?.kind === "job" && actions[0].action).toBe(canonical); expect(actions[1]?.kind).toBe("complete"); });
it("blocks lifecycle without authoritative safe guard", () => { expect(projectTopicTaskActions({ task, canonicalActions: [], guardSafe: false, intent: null })).toEqual([]); });
it("offers reopen for completed closed topic", () => { expect(projectTopicTaskActions({ task: { ...task, lifecycle: "completed", presence: "closed" }, canonicalActions: [], guardSafe: true, intent: null })[0]?.kind).toBe("reopen"); });
it("filters canonical action belonging to a different captured job", () => { expect(projectTopicTaskActions({ task, canonicalActions: [{ ...canonical, jobId: "other" }], guardSafe: false, intent: null })).toEqual([]); });
it("pending intent blocks mutations but retains canonical read actions", () => { const read = { ...canonical, kind: "details" as const }; expect(projectTopicTaskActions({ task, canonicalActions: [canonical, read], guardSafe: true, intent: { phase: "pending", outcome: "unknown" } as TopicTaskLifecycleIntent }).map(a => a.kind === "job" ? a.action.kind : a.kind)).toEqual(["details"]); });
it.each([{ lifecycle: "completed" as const, presence: "closed" as const }, { lifecycle: "completed" as const, presence: "open" as const }, { lifecycle: "open" as const, presence: "closed" as const }])("closed task offers only canonical read actions before reopening: %j", patch => {
  const actions = projectTopicTaskActions({ task: { ...task, ...patch }, canonicalActions: [canonical, { ...canonical, kind: "retry_new_turn" }, { ...canonical, kind: "details" }], guardSafe: false, intent: null });
  expect(actions.map(a => a.kind === "job" ? a.action.kind : a.kind)).toEqual(["details"]);
});
it("missing open task offers canonical recovery and read actions only", () => {
  const recovery = { ...canonical, kind: "recover_missing_topic" as const };
  const actions = projectTopicTaskActions({ task: { ...task, presence: "missing" }, canonicalActions: [canonical, recovery, { ...canonical, kind: "inspect" }], guardSafe: true, intent: null });
  expect(actions.map(a => a.kind === "job" ? a.action.kind : a.kind)).toEqual(["recover_missing_topic", "inspect"]);
  expect(actions[0]?.kind === "job" && actions[0].action).toBe(recovery);
});
it.each([{ lifecycle: "completed" as const, intent: null }, { lifecycle: "open" as const, intent: { phase: "pending", outcome: "unknown" } as TopicTaskLifecycleIntent }])("missing topic recovery remains blocked by completed lifecycle or pending intent", ({ lifecycle, intent }) => {
  expect(projectTopicTaskActions({ task: { ...task, lifecycle, presence: "missing" }, canonicalActions: [{ ...canonical, kind: "recover_missing_topic" }], guardSafe: true, intent })).toEqual([]);
});
it("unknown presence retains canonical actions without offering completion", () => {
  expect(projectTopicTaskActions({ task: { ...task, presence: "unknown" }, canonicalActions: [canonical], guardSafe: true, intent: null }).map(a => a.kind)).toEqual(["job"]);
});
