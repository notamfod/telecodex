import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopicTaskControls } from "../src/topic-task-controls.js";
import { TopicTaskStore, type TopicTaskRecord } from "../src/topic-task-store.js";
import type { TelegramJobStatusProjection, TelegramStatusAction } from "../src/telegram-status-projection.js";
let directory: string; let store: TopicTaskStore; let task: TopicTaskRecord; let controls: TopicTaskControls;
const close = vi.fn(); const reopen = vi.fn(); const syncInbox = vi.fn(); const runJob = vi.fn(); const read = vi.fn(); const eligible = vi.fn();
function makeControls() { return new TopicTaskControls({ store, eligible, read, serialize: async (_key, operation) => operation(), transport: { close, reopen, probe: async () => "closed" }, syncInbox, runJob }); }
function projection(actions: TelegramStatusAction[]) { return { jobId: "job", expectedVersion: 2, actions } as TelegramJobStatusProjection; }
function bindJob() { task = store.update(task.contextKey, task.version, { latestJobId: "job", latestJobVersion: 2 })!; }
beforeEach(() => { vi.resetAllMocks(); directory = mkdtempSync(path.join(tmpdir(), "controls-")); store = new TopicTaskStore(path.join(directory, "tasks.sqlite")); const initial = store.ensure({ chatId: -123, messageThreadId: 42, title: "Task", workspace: "/srv", threadId: "session" }); task = store.update(initial.contextKey, initial.version, { presence: "open", cardState: "ready", cardMessageId: 70 })!; eligible.mockReturnValue(true); read.mockResolvedValue({ safe: true, projection: null }); controls = makeControls(); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
it("projects controls without mutating task or calling Telegram", async () => {
  const before = store.get(task.contextKey); expect((await controls.actions(task.contextKey)).map(a => a.kind)).toEqual(["complete"]);
  expect(store.get(task.contextKey)).toEqual(before); expect(close).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled(); expect(syncInbox).not.toHaveBeenCalled();
});
it("rejects a callback bound to another topic", async () => {
  const action = (await controls.actions(task.contextKey))[0]!; const token = controls.token(action);
  await expect(controls.callback(token, "-123:99")).rejects.toMatchObject({ statusCode: 409 }); expect(close).not.toHaveBeenCalled();
});
it("expires callback handles across process reconstruction", async () => {
  const token = controls.token((await controls.actions(task.contextKey))[0]!); controls = makeControls();
  await expect(controls.callback(token, task.contextKey)).rejects.toMatchObject({ statusCode: 409 }); expect(close).not.toHaveBeenCalled();
});
it("rejects captured action after a new job arrives", async () => {
  const token = controls.token((await controls.actions(task.contextKey))[0]!); bindJob();
  await expect(controls.callback(token, task.contextKey)).rejects.toMatchObject({ statusCode: 409 }); expect(close).not.toHaveBeenCalled();
});
it("closes once on concurrent callbacks and preserves task session and card", async () => {
  const token = controls.token((await controls.actions(task.contextKey))[0]!); const results = await Promise.allSettled([controls.callback(token, task.contextKey), controls.callback(token, task.contextKey)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(close).toHaveBeenCalledOnce(); expect(store.get(task.contextKey)).toMatchObject({ lifecycle: "completed", presence: "closed", taskId: task.taskId, threadId: "session", cardMessageId: 70 });
});
it("renders valid completion through card bookkeeping and reopens the same session", async () => {
  const token = controls.token((await controls.actions(task.contextKey))[0]!); store.update(task.contextKey, task.version, { contentHash: "new", pinState: "pinned" });
  await controls.callback(token, task.contextKey); const action = (await controls.actions(task.contextKey)).find(a => a.kind === "reopen")!;
  expect(action).toBeDefined(); await controls.run(action); expect(reopen).toHaveBeenCalledOnce(); expect(runJob).not.toHaveBeenCalled(); expect(store.get(task.contextKey)).toMatchObject({ lifecycle: "open", presence: "open", taskId: task.taskId, threadId: "session", cardMessageId: 70 });
});
it("forwards only exact current canonical action payload", async () => {
  bindJob(); const canonical: TelegramStatusAction = { kind: "retry_delivery", jobId: "job", expectedVersion: 2, partKey: "result:0" }; read.mockResolvedValue({ safe: false, projection: projection([canonical]) });
  const action = (await controls.actions(task.contextKey))[0]!; await controls.run(action); expect(runJob).toHaveBeenCalledWith(canonical, task);
  await expect(controls.run({ ...action, kind: "job", action: { ...canonical, partKey: "result:1" } })).rejects.toMatchObject({ statusCode: 409 }); expect(runJob).toHaveBeenCalledOnce();
});
it("pending lifecycle exposes only canonical read actions", async () => {
  bindJob(); read.mockResolvedValue({ safe: true, projection: projection([{ kind: "retry_delivery", jobId: "job", expectedVersion: 2 }, { kind: "details", jobId: "job", expectedVersion: 2 }]) });
  store.beginLifecycleIntent({ contextKey: task.contextKey, taskId: task.taskId, expectedVersion: task.actionVersion, latestJobId: "job", latestJobVersion: 2, desired: "completed" });
  expect((await controls.actions(task.contextKey)).map(a => a.kind === "job" ? a.action.kind : a.kind)).toEqual(["details"]);
});
it("suppresses completion if projection does not match captured latest job", async () => {
  bindJob(); read.mockResolvedValue({ safe: true, projection: { ...projection([]), jobId: "different" } }); expect(await controls.actions(task.contextKey)).toEqual([]);
});
it("rejects an action when eligibility is revoked after rendering", async () => {
  const action = (await controls.actions(task.contextKey))[0]!; eligible.mockReturnValue(false); await expect(controls.run(action)).rejects.toMatchObject({ statusCode: 409 }); expect(close).not.toHaveBeenCalled();
});
it("evicts old callback handles at the bounded capacity", async () => {
  const action = (await controls.actions(task.contextKey))[0]!; const token = controls.token(action); expect(controls.token(action)).toBe(token);
  for (let index = 1; index <= 2048; index++) controls.token({ ...action, expectedVersion: action.expectedVersion + index });
  await expect(controls.callback(token, task.contextKey)).rejects.toMatchObject({ statusCode: 409 }); expect(close).not.toHaveBeenCalled();
});

it("uses confirmed Telegram result and status links without remote writes", async () => {
  const initial = store.ensure({ chatId: -100123, messageThreadId: 50, title: "Linked task", workspace: "/srv" });
  const linked = store.update(initial.contextKey, initial.version, { latestJobId: "job", latestJobVersion: 2, lastResultMessageId: 90, agentState: "needs_input" })!;
  read.mockResolvedValue({ safe: false, projection: { ...projection([]), delivery: { anchorMessageId: 80 } } });
  expect(await controls.links(linked.contextKey)).toEqual([
    { label: "Ответить в топике", url: "https://t.me/c/123/50" },
    { label: "Последний результат", url: "https://t.me/c/123/90" },
    { label: "Подробности прогона", url: "https://t.me/c/123/80" },
  ]);
  expect(close).not.toHaveBeenCalled(); expect(runJob).not.toHaveBeenCalled();
});
it("does not acknowledge ineffective details as successful work", async () => {
  bindJob(); read.mockResolvedValue({ safe: false, projection: projection([{ kind: "details", jobId: "job", expectedVersion: 2 }]) });
  const action = (await controls.actions(task.contextKey))[0]!;
  await expect(controls.run(action)).rejects.toThrow("Открой подробности");
  expect(runJob).not.toHaveBeenCalled();
});


it("keeps the confirmed result accessible when live status is unavailable", async () => {
  const initial = store.ensure({ chatId: -100123, messageThreadId: 50, title: "Task", workspace: "/srv" });
  const linked = store.update(initial.contextKey, initial.version, { lastResultMessageId: 90 })!;
  read.mockRejectedValue(new Error("status unavailable"));
  expect(await controls.links(linked.contextKey)).toEqual([
    { label: "Последний результат", url: "https://t.me/c/123/90" },
  ]);
  expect(runJob).not.toHaveBeenCalled();
});

it("does not duplicate result links or use a stale status version", async () => {
  const initial = store.ensure({ chatId: -100123, messageThreadId: 50, title: "Task", workspace: "/srv" });
  const linked = store.update(initial.contextKey, initial.version, { latestJobId: "job", latestJobVersion: 2, lastResultMessageId: 90 })!;
  read.mockResolvedValue({ safe: false, projection: { ...projection([]), delivery: { anchorMessageId: 90 } } });
  expect(await controls.links(linked.contextKey)).toEqual([{ label: "Последний результат", url: "https://t.me/c/123/90" }]);
  read.mockResolvedValue({ safe: false, projection: { ...projection([]), expectedVersion: 1, delivery: { anchorMessageId: 80 } } });
  expect(await controls.links(linked.contextKey)).toEqual([{ label: "Последний результат", url: "https://t.me/c/123/90" }]);
});

it("fails closed for actions while preserving links when inspection is unavailable", async () => {
  const legal = (await controls.actions(task.contextKey))[0]!;
  read.mockRejectedValue(new Error("live status unavailable"));
  expect(await controls.actions(task.contextKey)).toEqual([]);
  await expect(controls.run(legal)).rejects.toMatchObject({ statusCode: 409 });
  expect(close).not.toHaveBeenCalled();
  expect(reopen).not.toHaveBeenCalled();
  expect(runJob).not.toHaveBeenCalled();
});
