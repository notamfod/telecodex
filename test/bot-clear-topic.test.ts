import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "grammy";
import { createBot, type TeleCodexBot, type TelegramBotReliability } from "../src/bot.js";
import { InboxStore } from "../src/inbox.js";
import { TopicTaskStore } from "../src/topic-task-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

function harness(options: { canonical?: boolean; ticket?: boolean } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "clear-topic-"));
  let bindings = [{ contextKey: "-100123:42", threadId: "thread-1", workspace, topicName: "Моя задача", updatedAt: 1 }];
  const calls: Array<{ method: string; payload: any }> = [];
  const order: string[] = [];
  const faults = new Map<string, unknown>();
  let processing = false;
  let safe = true;
  let admin = true;
  let externalIdle = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  if (options.ticket) {
    const inbox = new InboxStore(path.join(workspace, ".telecodex", "inbox.json"));
    inbox.enable("-100123:7", { workspace, template: "Task" });
    inbox.createTicket({ inboxContextKey: "-100123:7", workTopicId: 42, workspace, prompt: "Request", source: "Inbox", topicTitle: "Моя задача" });
    const store = new TopicTaskStore(path.join(workspace, ".telecodex", "topic-tasks.sqlite"));
    const task = store.ensure({ chatId: -100123, messageThreadId: 42, title: "Моя задача", workspace, threadId: "thread-1", ticketId: 1 });
    store.update(task.contextKey, task.version, { titleSource: "manual", cardMessageId: 100, cardState: "ready", enabled: false });
    store.close();
  }
  const registry = { onRemove: vi.fn(), listContexts: () => bindings, get: () => ({ isProcessing: () => processing }),
    getAppServerClient: () => ({ request: vi.fn(async () => ({ thread: { id: "thread-1", status: { type: externalIdle ? "idle" : "active" }, turns: [] } })) }),
    rebindThreadTopic: vi.fn((oldKey: string, newKey: string) => {
      order.push("bind"); if (faults.has("bind")) throw faults.get("bind");
      bindings = bindings.map(b => b.contextKey === oldKey ? { ...b, contextKey: newKey } : b);
    }),
  };
  const reliability: TelegramBotReliability | undefined = options.canonical ? {
    handleWork: vi.fn(async () => null), latestJob: vi.fn(async () => null), retry: vi.fn(async () => {}), abort: vi.fn(async () => {}),
    readTaskContext: vi.fn(async () => ({ safe, projection: null })),
    withTaskContext: async (_context, operation) => operation(),
  } : undefined;
  const config = { telegramBotToken: "123:test", telegramAllowedUserIds: [123], telegramAllowedUserIdSet: new Set([123]),
    telegramForumChatId: -100123, workspace, maxFileSize: 1024, modelChoices: [], codexSandboxMode: "workspace-write", codexApprovalPolicy: "never",
    launchProfiles: [{ id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "never", unsafe: false }],
    defaultLaunchProfileId: "default", enableUnsafeLaunchProfiles: false, toolVerbosity: "summary", showTurnTokenUsage: false,
    enableTelegramLogin: false, enableTelegramReactions: false, statusBoardIntervalMs: 30_000, topicSyncEnabled: false,
    telegramMaxActiveTopics: 4, telegramProgressHeartbeatMs: 120_000,
  };
  let nextId = 0;
  let bot: TeleCodexBot;
  function start() {
    const clearApi = new Api("123:test");
    bot = createBot(config as never, registry as never, reliability, { clearTopicApi: clearApi });
    bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const intercept: Parameters<typeof bot.api.config.use>[0] = async (_previous, method, payload) => {
      calls.push({ method, payload }); order.push(method);
      if (faults.has(method)) {
        const fault = faults.get(method);
        if (typeof fault === "function") fault(); else throw fault;
      }
      return { ok: true, result: method === "createForumTopic" ? { message_thread_id: 91, name: "Моя задача" }
        : method === "getChatMember" ? { status: admin ? "administrator" : "member", can_manage_topics: admin, can_delete_messages: admin }
        : method === "sendMessage" ? { message_id: 500, chat: { id: -100123 }, message_thread_id: 91 } : true } as never;
    };
    bot.api.config.use(intercept); clearApi.config.use(intercept);
  }
  start();
  cleanups.push(async () => { await bot.taskCards?.dispose(); await bot.disposeTaskProvisioning?.(); rmSync(workspace, { recursive: true, force: true }); });
  const message = (topicId = 42, userId = 123, chatId = -100123, text = "/clear_all") => bot.handleUpdate({ update_id: ++nextId, message: {
    message_id: nextId, date: 1, from: { id: userId, is_bot: false, first_name: "User" },
    chat: { id: chatId, type: "supergroup", title: "Test", is_forum: true }, message_thread_id: topicId,
    text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
  } });
  const rename = (name: string) => bot.handleUpdate({ update_id: ++nextId, message: {
    message_id: nextId, date: 1, from: { id: 123, is_bot: false, first_name: "User" },
    chat: { id: -100123, type: "supergroup", title: "Test", is_forum: true }, message_thread_id: 42, forum_topic_edited: { name },
  } });
  return { message, rename, calls, order, registry, faults, config, workspace, bindings: () => bindings,
    busy: () => { processing = true; },
    unsafe: () => { safe = false; }, noRights: () => { admin = false; }, externalBusy: () => { externalIdle = false; },
    restart: async () => { await bot.taskCards?.dispose(); await bot.disposeTaskProvisioning?.(); start(); },
    api: (method: string) => calls.filter(c => c.method === method),
  };
}

describe("/clear_all", () => {
  it("preserves an observed manual topic rename across restart", async () => {
    const h = harness(); await h.rename("Новое название"); await h.restart(); await h.message();
    expect(h.api("createForumTopic")[0]?.payload.name).toBe("Новое название");
  });
  it("recreates only the current topic and persists the same session before deletion", async () => {
    const h = harness(); await h.message();
    expect(h.api("createForumTopic")).toEqual([{ method: "createForumTopic", payload: expect.objectContaining({ chat_id: -100123, name: "Моя задача" }) }]);
    expect(h.bindings()).toEqual([expect.objectContaining({ contextKey: "-100123:91", threadId: "thread-1" })]);
    expect(h.api("deleteForumTopic")).toEqual([{ method: "deleteForumTopic", payload: { chat_id: -100123, message_thread_id: 42 } }]);
    expect(h.order.indexOf("bind")).toBeLessThan(h.order.indexOf("deleteForumTopic"));
    expect(h.api("sendMessage").some(c => c.payload.message_thread_id === 91)).toBe(true);
  });
  it.each([[1, 123, -100123], [42, 999, -100123], [42, 123, -100999]])("rejects protected or unauthorized context %j", async (topic, user, chat) => {
    const h = harness(); await h.message(topic, user, chat);
    expect(h.api("createForumTopic")).toHaveLength(0); expect(h.api("deleteForumTopic")).toHaveLength(0);
  });
  it("does not accept arbitrary topic ids as command arguments", async () => {
    const h = harness(); await h.message(42, 123, -100123, "/clear_all 99");
    expect(h.api("deleteForumTopic")).toHaveLength(0);
  });
  it("leaves an active session untouched", async () => {
    const h = harness(); h.busy(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(0); expect(h.registry.rebindThreadTopic).not.toHaveBeenCalled();
  });
  it("checks bot permissions before creating a replacement", async () => {
    const h = harness(); h.noRights(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(0); expect(h.api("deleteForumTopic")).toHaveLength(0);
  });
  it("blocks a thread active outside Telegram", async () => {
    const h = harness(); h.externalBusy(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(0);
  });
  it("rechecks activity after Telegram calls before moving the session", async () => {
    const h = harness(); h.faults.set("sendMessage", () => h.externalBusy()); await h.message();
    expect(h.registry.rebindThreadTopic).not.toHaveBeenCalled();
    expect(h.api("deleteForumTopic")).toHaveLength(0);
  });
  it("blocks canonical jobs that have not finished delivery", async () => {
    const h = harness({ canonical: true }); h.unsafe(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(0);
  });
  it("moves the Inbox ticket and persistent task card in canonical mode", async () => {
    const h = harness({ canonical: true, ticket: true }); await h.message();
    expect(h.api("deleteForumTopic")).toHaveLength(1);
    const inbox = new InboxStore(path.join(h.workspace, ".telecodex", "inbox.json"));
    expect(inbox.getTicket(1)?.workTopicId).toBe(91);
    const tasks = new TopicTaskStore(path.join(h.workspace, ".telecodex", "topic-tasks.sqlite"));
    try {
      expect(tasks.get("-100123:42")).toBeNull();
      expect(tasks.get("-100123:91")).toMatchObject({ ticketId: 1, threadId: "thread-1", titleSource: "manual", cardMessageId: null });
    } finally { tasks.close(); }
  });
  it("protects Inbox source topics", async () => {
    const h = harness({ ticket: true }); await h.message(7);
    expect(h.api("createForumTopic")).toHaveLength(0);
  });
  it("does not delete history when creation fails", async () => {
    const h = harness(); h.faults.set("createForumTopic", new Error("connection lost")); await h.message();
    expect(h.api("deleteForumTopic")).toHaveLength(0); expect(h.bindings()[0].contextKey).toBe("-100123:42");
  });
  it("does not retry ambiguous creation after restart", async () => {
    const h = harness(); h.faults.set("createForumTopic", new Error("connection lost")); await h.message();
    h.faults.clear(); await h.restart(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(1); expect(h.api("deleteForumTopic")).toHaveLength(0);
  });
  it("keeps normal commands available after ambiguous creation", async () => {
    const h = harness(); h.faults.set("createForumTopic", new Error("connection lost")); await h.message();
    h.faults.clear(); await h.restart(); await h.message(42, 123, -100123, "/help");
    expect(h.api("sendMessage").at(-1)?.payload.text).toContain("/newtask");
  });
  it("does not delete the original when the replacement disappears before retry", async () => {
    const h = harness(); h.faults.set("bind", new Error("disk full")); await h.message();
    h.faults.clear(); await h.restart();
    h.faults.set("editMessageText", { error_code: 400, description: "Bad Request: message to edit not found" });
    await h.message();
    expect(h.api("deleteForumTopic")).toHaveLength(0);
    expect(h.bindings()[0].contextKey).toBe("-100123:42");
  });
  it("resumes a failed binding without creating another topic", async () => {
    const h = harness(); h.faults.set("bind", new Error("disk full")); await h.message();
    expect(h.api("deleteForumTopic")).toHaveLength(0);
    h.faults.clear(); await h.restart(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(1); expect(h.api("deleteForumTopic")).toHaveLength(1);
    expect(h.bindings()[0].contextKey).toBe("-100123:91");
  });
  it("retries deletion against the old topic after restart", async () => {
    const h = harness(); h.faults.set("deleteForumTopic", new Error("connection lost")); await h.message();
    h.faults.clear(); await h.restart(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(1);
    expect(h.api("deleteForumTopic").every(c => c.payload.message_thread_id === 42)).toBe(true);
    expect(h.registry.rebindThreadTopic).toHaveBeenCalledTimes(1);
  });
  it("resumes unfinished clearing from the new topic", async () => {
    const h = harness(); h.faults.set("deleteForumTopic", new Error("connection lost")); await h.message();
    h.faults.clear(); await h.restart(); await h.message(91);
    expect(h.api("createForumTopic")).toHaveLength(1);
    expect(h.api("deleteForumTopic").every(c => c.payload.message_thread_id === 42)).toBe(true);
  });
  it("coalesces concurrent commands in the same topic", async () => {
    const h = harness(); await Promise.all([h.message(), h.message()]);
    expect(h.api("createForumTopic")).toHaveLength(1); expect(h.api("deleteForumTopic")).toHaveLength(1);
  });
  it("ignores stale commands from an already cleared topic after restart", async () => {
    const h = harness(); await h.message(); await h.restart(); await h.message();
    expect(h.api("createForumTopic")).toHaveLength(1); expect(h.api("deleteForumTopic")).toHaveLength(1);
  });
});
