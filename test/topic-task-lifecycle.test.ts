import { InboxStore } from "../src/inbox.js";
import { mkdtempSync, rmSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopicTaskStore, type TopicTaskRecord } from "../src/topic-task-store.js";
import { TopicTaskLifecycleService } from "../src/topic-task-lifecycle.js";
let directory: string; let store: TopicTaskStore; let task: TopicTaskRecord;
const transport = { close: vi.fn(), reopen: vi.fn(), probe: vi.fn() };
const guard = vi.fn(); const syncInbox = vi.fn();
function service() { return new TopicTaskLifecycleService({ store, transport, guard, syncInbox }); }
function request(desired: "completed" | "open" = "completed") { return { contextKey: task.contextKey, taskId: task.taskId, expectedVersion: task.actionVersion, latestJobId: task.latestJobId, latestJobVersion: task.latestJobVersion, desired }; }
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "lifecycle-")); store = new TopicTaskStore(path.join(directory, "tasks.sqlite")); const initial = store.ensure({ chatId: -123, messageThreadId: 45, title: "Task", workspace: "/srv", threadId: "session" }); task = store.update(initial.contextKey, initial.version, { presence: "open", cardState: "ready", cardMessageId: 91 })!; vi.resetAllMocks(); guard.mockResolvedValue({ safe: true }); transport.probe.mockResolvedValue("closed"); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
it("persists before Telegram and preserves task identity on completion", async () => { transport.close.mockImplementation(async () => { expect(store.getLifecycleIntent(task.contextKey)?.phase).toBe("pending"); expect(store.get(task.contextKey)?.lifecycle).toBe("open"); }); const result = await service().request(request()); expect(result.status).toBe("complete"); expect(result.task).toMatchObject({ taskId: task.taskId, threadId: "session", cardMessageId: 91, lifecycle: "completed", presence: "closed" }); expect(syncInbox).toHaveBeenCalledOnce(); });
it("serializes double clicks and rejects stale actions", async () => { const engine = service(); const results = await Promise.all([engine.request(request()), engine.request(request())]); expect(results.map(r => r.status)).toEqual(["complete", "stale"]); expect(transport.close).toHaveBeenCalledOnce(); });
it.each([{ taskId: "wrong" }, { expectedVersion: 1 }, { latestJobId: "different" }, { latestJobVersion: 9 }, { contextKey: "-123:46" }])("rejects stale binding %j", async patch => { expect((await service().request({ ...request(), ...patch })).status).toBe("stale"); expect(transport.close).not.toHaveBeenCalled(); });
it("blocks active work using authoritative guard", async () => { guard.mockResolvedValue({ safe: false, reason: "active_job" }); expect((await service().request(request())).status).toBe("blocked"); expect(transport.close).not.toHaveBeenCalled(); });
it("keeps timeout pending across restart, confirms by probe without repeating close", async () => { transport.close.mockRejectedValue(new Error("timeout")); const result = await service().request(request()); expect(result.status).toBe("pending"); expect(store.get(task.contextKey)?.lifecycle).toBe("open"); store.close(); store = new TopicTaskStore(path.join(directory, "tasks.sqlite")); expect(store.listPendingLifecycleIntents()).toHaveLength(1); expect((await service().reconcile(result.intent!.operationId)).status).toBe("complete"); expect(transport.close).toHaveBeenCalledOnce(); });
it("retains confirmed Telegram phase when Inbox sync fails and retries sync only", async () => { syncInbox.mockRejectedValueOnce(new Error("offline")); const result = await service().request(request()); expect(result.status).toBe("pending"); expect(result.intent?.phase).toBe("telegram_confirmed"); expect((await service().reconcile(result.intent!.operationId)).status).toBe("complete"); expect(transport.close).toHaveBeenCalledOnce(); });
it("marks forbidden as failed without closing task", async () => { transport.close.mockRejectedValue(Object.assign(new Error("forbidden"), { error_code: 403 })); expect((await service().request(request())).status).toBe("failed"); expect(store.get(task.contextKey)?.lifecycle).toBe("open"); });
it("reopens same task and session without any agent operation", async () => { await service().request(request()); task = store.get(task.contextKey)!; const result = await service().request(request("open")); expect(result.status).toBe("complete"); expect(result.task).toMatchObject({ taskId: task.taskId, lifecycle: "open", presence: "open", threadId: "session", cardMessageId: 91 }); expect(transport.reopen).toHaveBeenCalledOnce(); });
it("requires fresh probe for NOT_MODIFIED", async () => { transport.close.mockRejectedValue(new Error("TOPIC_NOT_MODIFIED")); transport.probe.mockResolvedValue("unknown"); expect((await service().request(request())).status).toBe("pending"); expect(store.get(task.contextKey)?.lifecycle).toBe("open"); expect(transport.probe).toHaveBeenCalledOnce(); });
it("never retries uncertain operation automatically; explicit retry checks fresh guard", async () => { transport.close.mockRejectedValue(new Error("timeout")); const result = await service().request(request()); transport.probe.mockResolvedValue("open"); expect((await service().reconcile(result.intent!.operationId)).status).toBe("pending"); guard.mockResolvedValue({ safe: false }); expect((await service().reconcile(result.intent!.operationId, { retryRemote: true })).status).toBe("blocked"); expect(transport.close).toHaveBeenCalledOnce(); });
it("rechecks CAS after an asynchronous guard changes the task", async () => {
  guard.mockImplementation(async () => { store.update(task.contextKey, task.version, { latestJobId: "new-job", latestJobVersion: 1 }); return { safe: true }; });
  expect((await service().request(request())).status).toBe("stale"); expect(transport.close).not.toHaveBeenCalled();
});
it("a missing topic stays pending and never triggers remote retry", async () => {
  transport.close.mockRejectedValue(new Error("timeout")); const result = await service().request(request());
  transport.probe.mockResolvedValue("missing"); expect((await service().reconcile(result.intent!.operationId, { retryRemote: true })).status).toBe("pending"); expect(transport.close).toHaveBeenCalledOnce();
});
it("rejects task version changes during an explicit reconciliation retry", async () => {
  transport.close.mockRejectedValue(new Error("timeout")); const result = await service().request(request());
  store.update(task.contextKey, task.version, { title: "edited" }); transport.probe.mockResolvedValue("open");
  expect((await service().reconcile(result.intent!.operationId, { retryRemote: true })).status).toBe("blocked"); expect(transport.close).toHaveBeenCalledOnce();
});
it("does not complete newer job after an uncertain close even when probe reports closed", async () => {
  transport.close.mockRejectedValue(new Error("timeout")); const result = await service().request(request());
  store.update(task.contextKey, task.version, { latestJobId: "new-job", latestJobVersion: 1, agentState: "running" });
  expect((await service().reconcile(result.intent!.operationId)).status).toBe("blocked");
  expect(store.get(task.contextKey)?.lifecycle).toBe("open"); expect(syncInbox).not.toHaveBeenCalled();
});
it("requires fresh safe guard before confirming an uncertain close by probe", async () => {
  transport.close.mockRejectedValue(new Error("timeout")); const result = await service().request(request()); guard.mockResolvedValue({ safe: false, reason: "active_job" });
  expect((await service().reconcile(result.intent!.operationId)).status).toBe("blocked"); expect(store.get(task.contextKey)?.lifecycle).toBe("open");
});
it("does not synchronize a new job using an old Telegram confirmed intent", async () => {
  syncInbox.mockRejectedValueOnce(new Error("offline")); const result = await service().request(request()); const current = store.get(task.contextKey)!;
  store.update(current.contextKey, current.version, { latestJobId: "new-job", latestJobVersion: 1, lifecycle: "open", presence: "open" });
  expect((await service().reconcile(result.intent!.operationId)).status).toBe("blocked"); expect(store.get(task.contextKey)?.lifecycle).toBe("open"); expect(syncInbox).toHaveBeenCalledOnce();
});
it("accepts captured action after card bookkeeping without weakening store CAS", async () => {
  const captured = { ...request(), expectedVersion: task.actionVersion };
  store.update(task.contextKey, task.version, { contentHash: "rendered", pinState: "pinned" });
  expect((await service().request(captured)).status).toBe("complete");
});
it("does not confirm an uncertain operation after a semantic action version change", async () => {
  transport.close.mockRejectedValue(new Error("timeout")); const result = await service().request(request());
  store.update(task.contextKey, task.version, { title: "changed scope" });
  expect((await service().reconcile(result.intent!.operationId)).status).toBe("blocked"); expect(store.get(task.contextKey)?.lifecycle).toBe("open");
});
it("does not finish a confirmed intent after the session binding changes", async () => {
  syncInbox.mockRejectedValueOnce(new Error("offline")); const result = await service().request(request()); const current = store.get(task.contextKey)!;
  store.update(current.contextKey, current.version, { threadId: "different-session" });
  expect((await service().reconcile(result.intent!.operationId)).status).toBe("blocked"); expect(syncInbox).toHaveBeenCalledOnce();
});

it.each(["completed", "open"] as const)("keeps %s pending after Inbox disk failure and durably reconciles in the same process", async desired => {
  const file = path.join(directory, "inbox.json");
  const inbox = new InboxStore(file);
  const ticket = inbox.createTicket({ inboxContextKey: "-123:5", workTopicId: 45, workspace: "/srv", prompt: "Task", source: "test" });
  if (desired === "open") {
    inbox.markResolved(ticket.id, 12345);
    task = store.update(task.contextKey, task.version, { lifecycle: "completed", presence: "closed" })!;
  }
  syncInbox.mockImplementation(async current => { inbox.setLifecycleDurably(ticket.id, current.lifecycle, 54321); });
  const engine = service();
  renameSync(file, `${file}.backup`); mkdirSync(file);
  const result = await engine.request(request(desired));
  expect(result.status).toBe("pending");
  expect(result.intent?.phase).toBe("telegram_confirmed");
  expect(inbox.getTicket(ticket.id)?.resolvedAt).toBe(desired === "open" ? 12345 : undefined);
  rmSync(file, { recursive: true }); renameSync(`${file}.backup`, file);
  const retry = await engine.reconcile(result.intent!.operationId);
  expect(retry.status).toBe("complete");
  expect(new InboxStore(file).getTicket(ticket.id)?.resolvedAt).toBe(desired === "open" ? undefined : 54321);
  expect(desired === "open" ? transport.reopen : transport.close).toHaveBeenCalledOnce();
});
