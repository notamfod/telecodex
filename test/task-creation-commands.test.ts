import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import { TaskProvisioningService, TaskProvisioningStore } from "../src/task-provisioning.js";
import { registerTaskCreationCommands } from "../src/task-creation-commands.js";
const stores: TaskProvisioningStore[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));
function harness(store = new TaskProvisioningStore(":memory:")) {
  if (!stores.includes(store)) stores.push(store);
  const handlers: Record<string, (ctx: any) => Promise<void>> = {};
  const api = { createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 90 }), sendMessage: vi.fn().mockResolvedValue({ message_id: 88 }), copyMessage: vi.fn().mockResolvedValue({ message_id: 89 }) };
  const registry = { listContexts: () => [{ contextKey: "-100123:5", workspace: "/project", launchProfileId: "safe" }], setContextDefaultsDurably: vi.fn() };
  const deps = { provisioning: () => new TaskProvisioningService(store), registry, config: { workspace: "/project", telegramForumChatId: -100123, telegramAllowedUserIdSet: new Set([1]), defaultLaunchProfileId: "safe", launchProfiles: [{ id: "safe", label: "Safe", sandboxMode: "read-only", approvalPolicy: "never" }] }, listWorkspaces: () => ["/project", "/other"], registerTask: vi.fn() };
  registerTaskCreationCommands({ command: (name: string, fn: any) => { handlers[name] = fn; }, callbackQuery: (_: RegExp, fn: any) => { handlers.callback = fn; } } as unknown as Bot, deps as any);
  const ctx = (patch: any = {}) => ({ api, chat: { id: -100123, type: "supergroup", is_forum: true }, from: { id: 1 }, message: { message_id: 10, message_thread_id: 5, text: "/newtask Task" }, match: "Task", reply: vi.fn().mockResolvedValue({ message_id: 11 }), editMessageText: vi.fn().mockResolvedValue(true), answerCallbackQuery: vi.fn(), ...patch });
  const click = (data: string, patch: any = {}) => ctx({ message: undefined, callbackQuery: { data, message: { message_id: 11, message_thread_id: 5 } }, ...patch });
  const token = () => store.listPending<any>().find(([key]) => key.startsWith("manual-draft:"))![1].token;
  return { handlers, api, registry, deps, ctx, click, token, store };
}
describe("manual task drafts", () => {
  it("previews launch permissions without creating a topic or starting Codex", async () => {
    const h = harness(); const ctx = h.ctx(); await h.handlers.newtask(ctx);
    expect(ctx.reply.mock.calls[0][0]).toContain("read-only"); expect(h.api.createForumTopic).not.toHaveBeenCalled();
    await h.handlers.callback(h.click(`taskdraft:${h.token()}:create`));
    await h.handlers.callback(h.click(`taskdraft:${h.token()}:create`));
    expect(h.api.createForumTopic).toHaveBeenCalledTimes(1); expect(h.registry.setContextDefaultsDurably).toHaveBeenCalledWith("-100123:90", expect.objectContaining({ workspace: "/project", launchProfileId: "safe" }));
  });
  it("persists cancellation and rejects foreign user and context", async () => {
    const h = harness(); await h.handlers.newtask(h.ctx()); const data = `taskdraft:${h.token()}:create`;
    await h.handlers.callback(h.click(data, { from: { id: 2 } }));
    await h.handlers.callback(h.click(data, { callbackQuery: { data, message: { message_id: 11, message_thread_id: 6 } } }));
    await h.handlers.callback(h.click(`taskdraft:${h.token()}:cancel`));
    const restarted = harness(h.store); await restarted.handlers.callback(restarted.click(data)); expect(restarted.api.createForumTopic).not.toHaveBeenCalled(); expect(h.api.createForumTopic).not.toHaveBeenCalled();
  });
  it("restores project selection across restart and validates removed profile", async () => {
    const h = harness(); await h.handlers.newtask(h.ctx()); await h.handlers.callback(h.click(`taskdraft:${h.token()}:p1`));
    const restarted = harness(h.store); await restarted.handlers.callback(restarted.click(`taskdraft:${h.token()}:create`));
    expect(restarted.registry.setContextDefaultsDurably).toHaveBeenCalledWith("-100123:90", expect.objectContaining({ workspace: "/other" }));
    const h2 = harness(); await h2.handlers.newtask(h2.ctx()); h2.deps.config.launchProfiles = []; await h2.handlers.callback(h2.click(`taskdraft:${h2.token()}:create`)); expect(h2.api.createForumTopic).not.toHaveBeenCalled();
  });
  it("copies only selected attachment with bounded text and reciprocal links", async () => {
    const h = harness(); const ctx = h.ctx({ message: { message_id: 10, message_thread_id: 5, reply_to_message: { message_id: 7, message_thread_id: 5, caption: "x".repeat(10000), document: { file_name: "example.pdf" } } } });
    await h.handlers.extract(ctx); expect(ctx.reply.mock.calls[0][0].length).toBeLessThan(4000); expect(ctx.reply.mock.calls[0][0]).toContain("example.pdf");
    const click = h.click(`taskdraft:${h.token()}:create`); await h.handlers.callback(click);
    expect(h.api.copyMessage).toHaveBeenCalledWith(-100123, -100123, 7, { message_thread_id: 90 });
    expect(h.api.sendMessage.mock.calls[0][1]).toContain("https://t.me/c/123/7"); expect(click.editMessageText.mock.calls.at(-1)?.[0]).toContain("https://t.me/c/123/90");
  });
  it("reports deleted source as partial creation without retrying copy or topic", async () => {
    const h = harness(); h.api.copyMessage.mockRejectedValue({ error_code: 400, description: "message to copy not found" });
    await h.handlers.extract(h.ctx({ message: { message_id: 10, message_thread_id: 5, reply_to_message: { message_id: 7, text: "Question" } } }));
    const click = h.click(`taskdraft:${h.token()}:create`); await h.handlers.callback(click); await h.handlers.callback(click);
    expect(h.api.createForumTopic).toHaveBeenCalledTimes(1); expect(h.api.copyMessage).toHaveBeenCalledTimes(1); expect(click.editMessageText.mock.calls.at(-1)?.[0]).toMatch(/перенос|источник/i);
  });
  it("deduplicates a replayed command and refuses a stale preview message", async () => {
    const h = harness(); await h.handlers.newtask(h.ctx()); await h.handlers.newtask(h.ctx());
    expect(h.store.listPending().filter(([key]) => key.startsWith("manual-draft:"))).toHaveLength(1);
    const data = `taskdraft:${h.token()}:create`;
    await h.handlers.callback(h.click(data, { callbackQuery: { data, message: { message_id: 99, message_thread_id: 5 } } }));
    expect(h.api.createForumTopic).not.toHaveBeenCalled();
  });
  it("rejects extraction without a source and preserves unknown creation across restart", async () => {
    const h = harness(); const ctx = h.ctx(); await h.handlers.extract(ctx);
    expect(ctx.reply.mock.calls[0][0]).toContain("/extract"); expect(h.store.listPending()).toHaveLength(0);
    await h.handlers.newtask(h.ctx()); h.api.createForumTopic.mockRejectedValue(new Error("timeout"));
    await h.handlers.callback(h.click(`taskdraft:${h.token()}:create`));
    const restarted = harness(h.store); const click = restarted.click(`taskdraft:${h.token()}:create`);
    await restarted.handlers.callback(click); expect(restarted.api.createForumTopic).not.toHaveBeenCalled();
    expect(click.editMessageText.mock.calls[0][0]).toContain("неизвестен");
  });

  it("reports an unconfirmed preview on duplicate command without creating anything", async () => {
    const h = harness();
    const first = h.ctx({ reply: vi.fn().mockRejectedValue(new Error("timeout")) });
    await expect(h.handlers.newtask(first)).rejects.toThrow("timeout");
    const retry = h.ctx();
    await h.handlers.newtask(retry);
    expect(retry.reply).toHaveBeenCalledWith(expect.stringContaining("отправка предпросмотра не подтверждена"));
    expect(h.api.createForumTopic).not.toHaveBeenCalled();
  });

  it("keeps the known unknown outcome after project permissions change", async () => {
    const h = harness();
    await h.handlers.newtask(h.ctx());
    h.api.createForumTopic.mockRejectedValue(new Error("timeout"));
    const data = `taskdraft:${h.token()}:create`;
    await h.handlers.callback(h.click(data));
    h.deps.config.launchProfiles = [];
    const retry = h.click(data);
    await h.handlers.callback(retry);
    expect(h.api.createForumTopic).toHaveBeenCalledTimes(1);
    expect(retry.editMessageText.mock.calls[0][0]).toContain("неизвестен");
    expect(retry.editMessageText.mock.calls[0][0]).not.toContain("/newtask");
  });

});
