import { afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createBotTopicTasks } from "../src/bot-topic-tasks.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function harness(withControls = false) {
 const workspace = mkdtempSync(path.join(os.tmpdir(), "bot-task-"));
 const api = { editMessageReplyMarkup: vi.fn(async () => true), closeForumTopic: vi.fn(async () => true), reopenForumTopic: vi.fn(async () => true), sendMessage: vi.fn(async () => ({ message_id: 42 })), editMessageText: vi.fn(async () => true), pinChatMessage: vi.fn(async () => true), sendChatAction: vi.fn(async () => true), editForumTopic: vi.fn(async () => true) };
 const reply = vi.fn(async () => {});
 const gate = { run: vi.fn(async (_chat, _priority, operation) => operation()) };
 const metadata = { workspace, topicName: "Проверить оплату", threadId: "thread-1" };
 const tasks = createBotTopicTasks({ api: api as never, workspace, forumChatId: -100123,
  metadata: () => metadata, isExcluded: () => false,
  ...(withControls ? { controls: { read: async () => ({ safe: true, projection: null }), serialize: async <T>(_key: string, fn: () => Promise<T>) => fn(), syncInbox: async () => {}, runJob: async () => {} } } : {}),
  gate: gate as never, report: vi.fn() });
 const ctx = { chat: { id: -100123 }, message: { message_thread_id: 5, text: "/task" }, reply } as never;
 cleanups.push(async () => { await tasks.dispose(); rmSync(workspace, { recursive: true, force: true }); });
 return { tasks, ctx, api, reply, workspace, gate, metadata };
}
it("does not create a database or send until explicit activation; commands reuse identity", async () => {
 const { tasks, ctx, api, workspace } = harness();
 await tasks.interact({ chatId: -100123, messageThreadId: 5 });
 expect(existsSync(path.join(workspace, ".telecodex", "topic-tasks.sqlite"))).toBe(false);
 await tasks.command(ctx); await tasks.command(ctx);
 expect(api.sendMessage).toHaveBeenCalledTimes(1); expect(api.pinChatMessage).toHaveBeenCalledTimes(1);
});
it("rejects foreign chats and keeps off durable", async () => {
 const { tasks, ctx, api } = harness();
 await tasks.command({ ...ctx as object, chat: { id: -100456 } } as never);
 expect(api.sendMessage).not.toHaveBeenCalled();
 await tasks.command(ctx);
 await tasks.command({ ...ctx as object, message: { message_thread_id: 5, text: "/task off" } } as never);
 expect(tasks.enabled({ chatId: -100123, messageThreadId: 5 })).toBe(false);
 await tasks.interact({ chatId: -100123, messageThreadId: 5 });
 expect(api.sendMessage).toHaveBeenCalledTimes(1);
});
it("records manual topic title and ignores automatic rename echoes", async () => {
 const { tasks, ctx } = harness(); await tasks.command(ctx);
 await tasks.manualTitle({ chatId: -100123, messageThreadId: 5 }, "Ручное название");
 expect(tasks.getManualTitle({ chatId: -100123, messageThreadId: 5 })).toBe("Ручное название");
 await tasks.interact({ chatId: -100123, messageThreadId: 5 });
 expect(tasks.getManualTitle({ chatId: -100123, messageThreadId: 5 })).toBe("Ручное название");
});

it("retains manual title queued before a stale metadata refresh", async () => {
 const { tasks, ctx, api } = harness();
 let finish!: () => void;
 api.sendMessage.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { message_id: 42 }; });
 const activation = tasks.command(ctx);
 await vi.waitFor(() => expect(finish).toBeDefined());
 const manual = tasks.manualTitle({ chatId: -100123, messageThreadId: 5 }, "Ручное");
 const automatic = tasks.interact({ chatId: -100123, messageThreadId: 5 });
 finish(); await Promise.all([activation, manual, automatic]);
 expect(tasks.getManualTitle({ chatId: -100123, messageThreadId: 5 })).toBe("Ручное");
});
it("refreshes automatic titles and gates probes as well as card writes", async () => {
 const { tasks, ctx, api, metadata, gate, reply } = harness(); await tasks.command(ctx);
 expect(gate.run).toHaveBeenCalledTimes(3);
 metadata.topicName = "Новое название";
 await tasks.interact({ chatId: -100123, messageThreadId: 5 });
 expect(api.editMessageText).toHaveBeenLastCalledWith(-100123, 42, expect.stringContaining("Новое название"), expect.anything(), expect.anything());
 expect(reply).toHaveBeenCalledWith(expect.any(String), { message_thread_id: 5 });
});
it("a corrupt optional card database conservatively blocks automatic rename without throwing", () => {
 const { tasks, workspace } = harness();
 mkdirSync(path.join(workspace, ".telecodex"));
 writeFileSync(path.join(workspace, ".telecodex", "topic-tasks.sqlite"), "corrupt");
 expect(tasks.shouldPreserveTitle({ chatId: -100123, messageThreadId: 5 })).toBe(true);
});
it("bounds an edit waiting for gate admission and never dispatches after cancellation", async () => {
 const { tasks, ctx, metadata, api, gate } = harness(); await tasks.command(ctx);
 const deadline = new AbortController();
 const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
 let queued = false;
 gate.run.mockImplementation((_chat, _priority, _operation, signal: AbortSignal) => new Promise((_resolve, reject) => {
   queued = true;
   if (signal.aborted) { reject(new Error("admission cancelled")); return; }
   signal.addEventListener("abort", () => reject(new Error("admission cancelled")), { once: true });
 }) as never);
 try {
   metadata.topicName = "Изменение";
   const operation = tasks.interact({ chatId: -100123, messageThreadId: 5 });
   await vi.waitFor(() => expect(queued).toBe(true));
   deadline.abort(); await operation;
   expect(api.editMessageText).not.toHaveBeenCalled();
 } finally { timeout.mockRestore(); }
});

it("a first manual-title activation attempts a rejected send only once", async () => {
 const { tasks, ctx, api } = harness();
 api.sendMessage.mockRejectedValue({ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } });
 await tasks.command({ ...ctx as object, message: { message_thread_id: 5, text: "/task title Имя" } } as never);
 expect(api.sendMessage).toHaveBeenCalledTimes(1);
});
it("serializes automatic and manual remote renames so manual wins", async () => {
 const { tasks, ctx, api } = harness(); await tasks.command(ctx);
 const destination = { chatId: -100123, messageThreadId: 5 };
 let finish!: () => void;
 api.editForumTopic.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return true; });
 const automatic = tasks.renameAutomatically(destination, "Автоматическое");
 await vi.waitFor(() => expect(finish).toBeDefined());
 const manual = tasks.renameManually(destination, "Ручное");
 finish(); await Promise.all([automatic, manual]);
 expect(api.editForumTopic.mock.calls.map(call => call[2])).toEqual([{ name: "Автоматическое" }, { name: "Ручное" }]);
 expect(tasks.getManualTitle(destination)).toBe("Ручное");
 expect(await tasks.renameAutomatically(destination, "Позднее авто")).toBe(false);
 expect(api.editForumTopic).toHaveBeenCalledTimes(2);
});
it("restores a manual Telegram name observed during an automatic request", async () => {
 const { tasks, ctx, api } = harness(); await tasks.command(ctx);
 const destination = { chatId: -100123, messageThreadId: 5 };
 let finish!: () => void;
 api.editForumTopic.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return true; });
 const automatic = tasks.renameAutomatically(destination, "Авто");
 await vi.waitFor(() => expect(finish).toBeDefined());
 const manualEvent = tasks.observeTopic(destination, undefined, "Из Telegram");
 await vi.waitFor(() => expect(tasks.getManualTitle(destination)).toBe("Из Telegram"));
 finish(); await Promise.all([automatic, manualEvent]);
 expect(api.editForumTopic.mock.calls.at(-1)?.[2]).toEqual({ name: "Из Telegram" });
});

it("keeps callback handles stable and skips identical keyboard writes", async () => {
 const { tasks, ctx, api } = harness(true);
 await tasks.command(ctx);
 const first = api.editMessageReplyMarkup.mock.calls.length;
 expect(first).toBe(1);
 await tasks.command(ctx);
 expect(api.editMessageReplyMarkup).toHaveBeenCalledTimes(first);
 const actions = await tasks.actions({ chatId: -100123, messageThreadId: 5 });
 expect(actions.map(action => action.kind)).toEqual(["complete"]);
 await tasks.runAction(actions[0]);
 expect(api.closeForumTopic).toHaveBeenCalledTimes(1);
 expect(api.sendMessage).toHaveBeenCalledTimes(1);
 expect((await tasks.actions({ chatId: -100123, messageThreadId: 5 })).map(action => action.kind)).toEqual(["reopen"]);
 expect(api.editMessageReplyMarkup).toHaveBeenCalledTimes(first + 1);
});
