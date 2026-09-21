import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InboxStore } from "../src/inbox.js";
import { registerInboxHandlers } from "../src/bot-inbox.js";
import { TaskProvisioningService, TaskProvisioningStore } from "../src/task-provisioning.js";
import { ForumTopicAvailabilityUnknownError } from "../src/telegram-topic-liveness.js";
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(file?: string) {
  if (!file) { const dir = mkdtempSync(path.join(tmpdir(), "inbox-provision-")); dirs.push(dir); file = path.join(dir, "inbox.json"); }
  const inbox = new InboxStore(file); inbox.enable("-1001:7", { workspace: "/work", template: "{message}" });
  const store = new TaskProvisioningStore(`${file}.sqlite`); const provisioning = new TaskProvisioningService(store);
  const callbacks = new Map<string, any>(); let receive: any;
  const api = { createForumTopic: vi.fn(async () => ({ message_thread_id: 22 })), forwardMessage: vi.fn(async () => ({})) };
  const sendText = vi.fn(async () => ({}));
  const topicIsAlive = vi.fn(async () => false);
  const registry = { setContextDefaults: vi.fn(), listContexts: vi.fn(() => [] as any[]), rebindThreadTopic: vi.fn() };
  const handlers = registerInboxHandlers({ bot: { command: vi.fn(), callbackQuery: (pattern: RegExp, handler: any) => callbacks.set(pattern.source, handler), on: (_: string, handler: any) => { receive = handler; }, api } as never,
    config: { workspace: "/work" } as never, registry: registry as never, inbox, provisioning,
    topicActivity: { rememberIdleIcon: vi.fn() }, getContextSession: vi.fn(), isBusy: vi.fn(), handleTicketPrompt: vi.fn(), topicIsAlive, sendText, safeReply: vi.fn() });
  const message = (id: number, extra = {}) => receive({ chat: { id: -1001 }, message: { message_id: id, message_thread_id: 7, text: "Investigate this problem", ...extra } }, vi.fn());
  const click = async (prefix: string, id: string, choice: string, fail = false) => callbacks.get([...callbacks.keys()].find(key => key.startsWith(`^${prefix}:`))!)({ match: ["", id, choice], chat: { id: -1001 }, callbackQuery: { message: { message_thread_id: 7 } }, answerCallbackQuery: vi.fn(async () => { if (fail) throw new Error("network"); }), editMessageText: vi.fn(async () => {}), editMessageReplyMarkup: vi.fn(async () => {}) });
  return { file, inbox, store, api, sendText, message, click, handlers, topicIsAlive, registry };
}
it.each(["probe", "send", "attachment", "resolved"])("replaces a deleted topic detected by %s and keeps the Codex thread", async (stage) => {
  vi.useFakeTimers(); const first = setup();
  const old = first.inbox.createTicket({ inboxContextKey: "-1001:7", externalKey: "MIR-42", workTopicId: 11, workspace: "/work", prompt: "Original investigation", source: "telegram" });
  first.inbox.markStarted(old.id);
  if (stage === "resolved") first.inbox.markResolved(old.id);
  first.registry.listContexts.mockReturnValue([{ contextKey: "-1001:11", threadId: "existing-thread" }]);
  const missing = Object.assign(new Error("Bad Request: message thread not found"), { error_code: 400 });
  if (stage !== "probe") first.topicIsAlive.mockRejectedValue(new ForumTopicAvailabilityUnknownError());
  if (stage === "send" || stage === "resolved") first.sendText.mockRejectedValueOnce(missing);
  if (stage === "attachment") first.api.forwardMessage.mockRejectedValueOnce(missing);
  await first.message(123, { text: "MIR-42 New evidence", document: { file_id: "doc" } });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(first.api.createForumTopic).toHaveBeenCalledTimes(1);
  expect(first.registry.rebindThreadTopic).toHaveBeenCalledWith("-1001:11", "-1001:22");
  expect(first.registry.setContextDefaults).not.toHaveBeenCalled();
  expect(first.inbox.getTicket(old.id)).toMatchObject({ workTopicId: 22, prompt: expect.stringContaining("Original investigation") });
  expect(first.inbox.getTicket(old.id)?.prompt).toContain("New evidence");
  expect(first.inbox.getTicket(old.id)?.startedAt).toBeUndefined();
  expect(first.inbox.getTicket(old.id)?.continuationPending).toBe(true);
  expect(first.inbox.listTicketsByKey("-1001:7", "MIR-42")).toHaveLength(1);
  expect(first.store.list()[0]).toMatchObject({ state: "ready", messageThreadId: 22 });
  expect(first.inbox.listFailures("-1001:7")).toHaveLength(0);
  expect(first.api.forwardMessage).toHaveBeenLastCalledWith(-1001, -1001, 123, { message_thread_id: 22 });
  first.store.close(); const restart = setup(first.file);
  await restart.message(123, { text: "MIR-42 New evidence" }); await vi.advanceTimersByTimeAsync(2_000);
  expect(restart.api.createForumTopic).not.toHaveBeenCalled(); restart.store.close();
});
it.each(["registry", "inbox"])("keeps the old binding when %s continuation persistence fails", async (stage) => {
  vi.useFakeTimers(); const first = setup(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const old = first.inbox.createTicket({ inboxContextKey: "-1001:7", externalKey: "MIR-42", workTopicId: 11, workspace: "/work", prompt: "old", source: "telegram" });
  first.registry.listContexts.mockReturnValue([{ contextKey: "-1001:11", threadId: "existing-thread" }]);
  if (stage === "registry") first.registry.rebindThreadTopic.mockImplementationOnce(() => { throw new Error("persist failed"); });
  else vi.spyOn(first.inbox, "continueTicket").mockImplementationOnce(() => { throw new Error("persist failed"); });
  await first.message(123, { text: "MIR-42 New evidence" }); await vi.advanceTimersByTimeAsync(2_000);
  expect(first.inbox.getTicket(old.id)?.workTopicId).toBe(11);
  if (stage === "inbox") expect(first.registry.rebindThreadTopic).toHaveBeenLastCalledWith("-1001:22", "-1001:11");
  expect(first.registry.setContextDefaults).not.toHaveBeenCalled();
  expect(first.store.list()[0]).toMatchObject({ state: "failed", failureStage: "bind" });
  first.store.close(); log.mockRestore();
});
it("does not recreate a delivered topic when the inbox receipt destination is missing", async () => {
  vi.useFakeTimers(); const first = setup(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
  first.inbox.createTicket({ inboxContextKey: "-1001:7", externalKey: "MIR-42", workTopicId: 11, workspace: "/work", prompt: "old", source: "telegram" });
  first.topicIsAlive.mockResolvedValue(true);
  first.sendText.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error("message thread not found"), { error_code: 400 }));
  await first.message(123, { text: "MIR-42 New evidence" }); await vi.advanceTimersByTimeAsync(2_000);
  expect(first.api.createForumTopic).not.toHaveBeenCalled();
  expect(first.store.list()[0]?.state).toBe("unknown"); first.store.close(); log.mockRestore();
});
it("finishes a continuation after restart with the Codex thread already rebound", async () => {
  vi.useFakeTimers(); const first = setup();
  const old = first.inbox.createTicket({ inboxContextKey: "-1001:7", externalKey: "MIR-42", workTopicId: 11, workspace: "/work", prompt: "Original context", source: "telegram" });
  await first.message(123, { text: "MIR-42 New evidence" }); await first.handlers.dispose();
  const operationId = "inbox:-1001:7:123";
  first.store.accept({ operationId, sourceContextKey: "-1001:7", sourceMessageIds: [123], title: "MIR-42", workspace: "/work", kind: "inbox", metadata: { ticketId: old.id, continueTicketId: old.id, previousWorkTopicId: 11 } });
  first.store.patch(operationId, { state: "provisioning", messageThreadId: 22 });
  first.store.close(); const restart = setup(first.file);
  restart.registry.listContexts.mockReturnValue([{ contextKey: "-1001:22", threadId: "existing-thread" }]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(restart.api.createForumTopic).not.toHaveBeenCalled();
  expect(restart.registry.setContextDefaults).not.toHaveBeenCalled();
  expect(restart.registry.rebindThreadTopic).not.toHaveBeenCalled();
  expect(restart.inbox.getTicket(old.id)).toMatchObject({ workTopicId: 22, prompt: expect.stringContaining("Original context"), continuationPending: true });
  expect(restart.inbox.getTicket(old.id)?.startedAt).toBeUndefined();
  expect(restart.store.get(operationId)?.state).toBe("ready");
  restart.store.close();
});
it.each(["text", "document", "album"])("deduplicates %s updates across restart", async (kind) => {
  vi.useFakeTimers(); const first = setup(); const extra = kind === "document" ? { document: { file_id: "doc" } } : kind === "album" ? { photo: [{}], media_group_id: "album1" } : {};
  await first.message(123, extra); if (kind === "album") await first.message(124, extra);
  await vi.advanceTimersByTimeAsync(2_000); expect(first.api.createForumTopic).toHaveBeenCalledTimes(1);
  expect(first.api.forwardMessage).toHaveBeenCalledTimes(kind === "text" ? 0 : kind === "album" ? 2 : 1);
  first.store.close(); const restart = setup(first.file); await restart.message(123, extra); await vi.advanceTimersByTimeAsync(2_000); expect(restart.api.createForumTopic).not.toHaveBeenCalled(); restart.store.close();
});
it("restores a grouping choice and accepts a repeated click once", async () => {
  vi.useFakeTimers(); const first = setup(); await first.message(123); await first.message(124); await vi.advanceTimersByTimeAsync(2_000);
  const key = first.store.listPending().find(([id]) => id.startsWith("batch:"))![0]; first.store.close();
  const restart = setup(first.file); await restart.click("inbox_batch", key.slice(6), "one"); await restart.click("inbox_batch", key.slice(6), "one"); expect(restart.api.createForumTopic).toHaveBeenCalledTimes(1); expect(restart.store.pending<any>(key).completed).toBe(true); restart.store.close();
});
it("restores duplicate-ticket choice after restart", async () => {
  vi.useFakeTimers(); const first = setup(); const old = first.inbox.createTicket({ inboxContextKey: "-1001:7", externalKey: "MIR-42", workTopicId: 11, workspace: "/work", prompt: "old", source: "telegram" }); first.inbox.markResolved(old.id);
  first.topicIsAlive.mockResolvedValue(true);
  await first.message(123, { text: "MIR-42 Investigate again" }); await vi.advanceTimersByTimeAsync(2_000);
  const key = first.store.listPending().find(([id]) => id.startsWith("duplicate:"))![0]; first.store.close(); const restart = setup(first.file);
  await restart.click("ticket_dup", key.slice(10), "new"); expect(restart.api.createForumTopic).toHaveBeenCalledTimes(1); expect(restart.inbox.listTicketsByKey("-1001:7", "MIR-42")).toHaveLength(2); restart.store.close();
});
it("shows attachment failure as an existing topic and never resends on repeated update", async () => {
  vi.useFakeTimers(); const log = vi.spyOn(console, "error").mockImplementation(() => {}); const first = setup(); first.api.forwardMessage.mockRejectedValueOnce(new Error("timeout"));
  await first.message(123, { document: { file_id: "doc" } }); await vi.advanceTimersByTimeAsync(2_000);
  expect(first.store.list()[0]).toMatchObject({ state: "failed", messageThreadId: 22, failureStage: "ready" }); expect(first.inbox.listFailures("-1001:7")[0]?.outcome).toBe("topic_exists");
  await first.message(123, { document: { file_id: "doc" } }); await vi.advanceTimersByTimeAsync(2_000); expect(first.api.forwardMessage).toHaveBeenCalledTimes(1); first.store.close(); log.mockRestore();
});
it("fails binding durably when Inbox persistence fails", async () => {
  vi.useFakeTimers(); const log = vi.spyOn(console, "error").mockImplementation(() => {}); const first = setup();
  const original = first.inbox.attachTopic.bind(first.inbox); vi.spyOn(first.inbox, "attachTopic").mockImplementation((id, topic) => { vi.spyOn(first.inbox as any, "save").mockReturnValue(false); original(id, topic); });
  await first.message(123); await vi.advanceTimersByTimeAsync(2_000); expect(first.store.list()[0]).toMatchObject({ state: "failed", messageThreadId: 22, failureStage: "bind" }); first.store.close(); log.mockRestore();
});
it("shutdown leaves a buffered document available to restart", async () => {
  vi.useFakeTimers(); const first = setup(); await first.message(123, { document: { file_id: "doc" } }); await first.handlers.dispose(); first.store.close();
  await vi.advanceTimersByTimeAsync(2_000); expect(first.api.createForumTopic).not.toHaveBeenCalled();
  const restart = setup(first.file); await vi.advanceTimersByTimeAsync(2_000); expect(restart.api.createForumTopic).toHaveBeenCalledTimes(1); expect(restart.api.forwardMessage).toHaveBeenCalledTimes(1); await restart.handlers.dispose(); restart.store.close();
});
it("does not replay an interrupted append after restart", async () => {
  vi.useFakeTimers(); const log = vi.spyOn(console, "error").mockImplementation(() => {}); const first = setup(); await first.message(123, { document: { file_id: "doc" } }); await vi.advanceTimersByTimeAsync(2_000);
  const operation = first.store.list()[0]!; first.store.patch(operation.operationId, { state: "bound" });
  const receipt = first.store.pending<any>("message:-1001:7:123"); first.store.setPending("message:-1001:7:123", { ...receipt, buffered: true }); first.store.close();
  const restart = setup(first.file); await vi.advanceTimersByTimeAsync(2_000); expect(restart.store.list()[0]?.state).toBe("unknown"); expect(restart.api.createForumTopic).not.toHaveBeenCalled(); expect(restart.api.forwardMessage).not.toHaveBeenCalled(); restart.store.close(); log.mockRestore();
});
it("cancelled grouping stays cancelled when Telegram acknowledgement fails", async () => {
  vi.useFakeTimers(); const first = setup(); await first.message(123); await first.message(124); await vi.advanceTimersByTimeAsync(2_000);
  const key = first.store.listPending().find(([id]) => id.startsWith("batch:"))![0];
  await first.click("inbox_batch", key.slice(6), "cancel", true); expect(first.api.createForumTopic).not.toHaveBeenCalled(); first.store.close();
});
