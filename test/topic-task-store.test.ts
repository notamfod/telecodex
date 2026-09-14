import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TopicTaskStore } from "../src/topic-task-store.js";

let directory: string;
let file: string;
let stores: TopicTaskStore[];
const input = { chatId: -100123, messageThreadId: 42, title: "Task", workspace: "/srv/project" };
function open() { const store = new TopicTaskStore(file); stores.push(store); return store; }
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "topic-task-")); file = path.join(directory, "topic-tasks.sqlite"); stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });

it("keeps stable identity and existing metadata across ensure and restart", () => {
  const store = open(); const task = store.ensure(input);
  expect(task).toMatchObject({ contextKey: "-100123:42", version: 1, enabled: true, presence: "unknown", cardState: "none" });
  expect(task.taskId).toMatch(/^[0-9a-f-]{36}$/);
  expect(store.ensure({ ...input, title: "replacement" })).toEqual(task);
  store.close(); expect(open().get(task.contextKey)).toEqual(task);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
it("preserves card and manual title when a new job arrives", () => {
  const store = open(); const task = store.ensure(input);
  const edited = store.update(task.contextKey, task.version, { title: "Manual", titleSource: "manual", cardState: "ready", cardMessageId: 123 });
  const updated = store.update(task.contextKey, edited!.version, { latestJobId: "job-1", latestJobAt: 100, latestJobVersion: 1, agentState: "queued" });
  store.close(); expect(open().get(task.contextKey)).toEqual(updated);
  expect(updated).toMatchObject({ title: "Manual", titleSource: "manual", cardState: "ready", cardMessageId: 123 });
});
it("uses CAS across independent connections", () => {
  const first = open(); const second = open(); const task = first.ensure(input);
  expect(first.update(task.contextKey, task.version, { title: "winner" })?.version).toBe(2);
  expect(second.update(task.contextKey, task.version, { title: "loser" })).toBeNull();
  expect(second.get(task.contextKey)?.title).toBe("winner");
});
it("keeps uncertain sending across restart", () => {
  const store = open(); const task = store.ensure(input);
  const pending = store.update(task.contextKey, task.version, { cardState: "sending", cardAttemptId: "attempt-1" });
  store.close(); expect(open().get(task.contextKey)).toEqual(pending);
});
it("lists only enabled records", () => {
  const store = open(); const a = store.ensure(input); store.ensure({ ...input, messageThreadId: 43 });
  store.update(a.contextKey, a.version, { enabled: false });
  expect(store.listEnabled().map((item) => item.messageThreadId)).toEqual([43]);
});
it.each([{ messageThreadId: 0 }, { chatId: 0 }, { title: "bad\nname" }, { workspace: "x".repeat(4097) }, { title: "sk-" + "a".repeat(32) }])("rejects invalid identity %j", (patch) => {
  expect(() => open().ensure({ ...input, ...patch })).toThrow();
});
it.each([{ cardState: "ready" }, { cardState: "sending" }, { ticketId: -1 }, { version: 99 }, { chatId: 12 }, { pinState: "pinned" }, { titleSource: "other" }])("rejects invalid updates %j", (patch) => {
  const store = open(); const task = store.ensure(input);
  expect(() => store.update(task.contextKey, task.version, patch as never)).toThrow();
  expect(store.get(task.contextKey)).toEqual(task);
});
it("does not claim a failed database write succeeded", () => {
  const store = open(); const task = store.ensure(input); const db = new Database(file);
  db.exec("CREATE TRIGGER reject_updates BEFORE UPDATE ON topic_tasks BEGIN SELECT RAISE(ABORT, 'write rejected'); END"); db.close();
  expect(() => store.update(task.contextKey, task.version, { title: "not saved" })).toThrow("write rejected");
  expect(store.get(task.contextKey)).toEqual(task);
});
it("fails closed for a newer schema", () => {
  const db = new Database(file); db.pragma("user_version = 99"); db.close();
  expect(() => open()).toThrow();
});
it("fails closed for corrupt records", () => {
  const store = open(); const task = store.ensure(input); store.close();
  const db = new Database(file); db.prepare("UPDATE topic_tasks SET payload = ?").run('{"version":1}'); db.close();
  expect(() => open().get(task.contextKey)).toThrow();
});
it("migrates a v1 database preserving original fields and initializing actionVersion", () => {
  const store = open(); const task = store.ensure(input); store.close();
  const db = new Database(file); const { actionVersion: _actionVersion, ...legacy } = task; db.prepare("UPDATE topic_tasks SET payload = ?").run(JSON.stringify(legacy)); db.exec("DROP TABLE lifecycle_intents"); db.pragma("user_version = 1"); db.close();
  const migrated = open(); expect(migrated.get(task.contextKey)).toEqual(task);
  expect(migrated.listPendingLifecycleIntents()).toEqual([]);
  const check = new Database(file); expect(check.pragma("user_version", { simple: true })).toBe(3); check.close();
});
it("CAS protects intent creation across connections", () => {
  const first = open(); const second = open(); const task = first.ensure(input);
  const request = { contextKey: task.contextKey, taskId: task.taskId, expectedVersion: task.version, latestJobId: null, latestJobVersion: 0, desired: "completed" as const };
  expect(first.beginLifecycleIntent(request)).not.toBeNull(); expect(second.beginLifecycleIntent(request)).toBeNull();
});
it("keeps semantic action version stable across card writes while preserving CAS", () => {
  const store = open(); const initial = store.ensure(input);
  expect(initial.actionVersion).toBe(1);
  const card = store.update(initial.contextKey, initial.version, { cardMessageId: 12, cardState: "ready", contentHash: "hash", pinState: "pinned" })!;
  expect(card.version).toBe(initial.version + 1); expect(card.actionVersion).toBe(initial.actionVersion);
  expect(store.update(initial.contextKey, initial.version, { contentHash: "lost" })).toBeNull();
  const job = store.update(card.contextKey, card.version, { latestJobId: "new-job", latestJobVersion: 1 })!;
  expect(job.actionVersion).toBe(card.actionVersion + 1);
  const unchanged = store.update(job.contextKey, job.version, { latestJobId: "new-job", latestJobVersion: 1 })!;
  expect(unchanged.actionVersion).toBe(job.actionVersion);
  expect(store.update(unchanged.contextKey, unchanged.version, { lifecycle: "completed" })?.actionVersion).toBe(job.actionVersion + 1);
});
it("migrates legacy v2 records and pending intents with the existing captured version", () => {
  const store = open(); const initial = store.ensure(input); const task = store.update(initial.contextKey, initial.version, { cardState: "ready", cardMessageId: 77 })!;
  const intent = store.beginLifecycleIntent({ contextKey: task.contextKey, taskId: task.taskId, expectedVersion: task.actionVersion, latestJobId: null, latestJobVersion: 0, desired: "completed" })!; store.close();
  const db = new Database(file); const { actionVersion: _actionVersion, ...legacy } = task;
  db.prepare("UPDATE topic_tasks SET payload = ?").run(JSON.stringify(legacy)); db.prepare("UPDATE lifecycle_intents SET payload = ?").run(JSON.stringify({ ...intent, expectedVersion: task.version })); db.pragma("user_version = 2"); db.close();
  const migrated = open(); expect(migrated.get(task.contextKey)).toEqual({ ...task, actionVersion: task.version }); expect(migrated.listPendingLifecycleIntents()[0]?.expectedVersion).toBe(task.version);
});
