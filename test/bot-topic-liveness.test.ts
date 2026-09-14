import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBot, type TelegramBotReliability } from "../src/bot.js";
import * as codexState from "../src/codex-state.js";

const workspaces: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("bot topic liveness transport", () => {
  it.each(["legacy", "canonical"])("uses the dedicated API in %s mode", async (mode) => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-topic-api-"));
    workspaces.push(workspace);
    vi.spyOn(codexState, "getThread").mockReturnValue({
      id: "thread-1", title: "Existing task", cwd: workspace,
      model: null, modelProvider: null, firstUserMessage: "Task",
      createdAt: new Date(1_000), updatedAt: new Date(2_000),
    });
    const sendChatAction = vi.fn(async () => true);
    const reliability: TelegramBotReliability | undefined = mode === "legacy" ? undefined : {
      handleWork: vi.fn(async () => null), latestJob: vi.fn(async () => null),
      retry: vi.fn(async () => {}), abort: vi.fn(async () => {}),
    };
    const bot = createBot({
      telegramBotToken: "123:test", telegramAllowedUserIds: [123],
      telegramAllowedUserIdSet: new Set([123]), workspace, maxFileSize: 1024,
      modelChoices: [], codexSandboxMode: "workspace-write", codexApprovalPolicy: "never",
      launchProfiles: [{ id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "never", unsafe: false }],
      defaultLaunchProfileId: "default", enableUnsafeLaunchProfiles: false,
      toolVerbosity: "summary", showTurnTokenUsage: false, enableTelegramLogin: false,
      enableTelegramReactions: false, statusBoardIntervalMs: 30_000,
      topicSyncEnabled: false, telegramMaxActiveTopics: 4, telegramProgressHeartbeatMs: 120_000,
    } as never, {
      onRemove: vi.fn(),
      listContexts: () => [{ contextKey: "-1001:41", threadId: "thread-1" }],
    } as never, reliability, { topicLivenessApi: { sendChatAction } });

    expect(bot.api.config.installedTransformers()).toHaveLength(mode === "legacy" ? 1 : 0);
    bot.botInfo = {
      id: 123, is_bot: true, first_name: "Test", username: "test_bot",
      can_join_groups: true, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
    };
    const apiCalls: string[] = [];
    // Intercept every ordinary API call so neither a passing nor failing test uses the network.
    bot.api.config.use(async (_previous, method) => {
      apiCalls.push(method);
      return { ok: true, result: true } as never;
    });

    for (const updateId of [1, 2]) {
      await bot.handleUpdate({
        update_id: updateId,
        callback_query: {
          id: `callback-${updateId}`, from: { id: 123, is_bot: false, first_name: "Allowed" },
          chat_instance: "test", data: "projopen:thread-1",
          message: {
            message_id: 12, date: 1,
            chat: { id: -1001, type: "supergroup", title: "Test", is_forum: true },
            message_thread_id: 7, text: "Status",
          },
        },
      });
    }

    expect(sendChatAction).toHaveBeenCalledExactlyOnceWith(
      -1001, "typing", { message_thread_id: 41 }, expect.any(AbortSignal),
    );
    expect(apiCalls).not.toContain("sendChatAction");
    expect(apiCalls).not.toContain("createForumTopic");
    expect(apiCalls.filter((method) => method === "answerCallbackQuery")).toHaveLength(2);
  });
});

describe("separate topics for Codex sessions", () => {
  async function harness(bindings: Array<{ contextKey: string; threadId: string }> = []) {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-session-topic-")); workspaces.push(workspace);
    const thread = { id: "019fda52-f2ec-7801-ba9c-8761cc89bae4", title: "Existing task", cwd: workspace,
      model: null, modelProvider: null, firstUserMessage: "Task", createdAt: new Date(1_000), updatedAt: new Date(2_000) };
    vi.spyOn(codexState, "getThread").mockImplementation(id => id === thread.id ? thread : null);
    vi.spyOn(codexState, "listUserThreads").mockReturnValue([thread]);
    const session = { switchSession: vi.fn(async () => ({ threadId: thread.id, workspace })), isProcessing: () => false,
      listAllSessions: () => [thread], getInfo: () => ({ threadId: "current", workspace }) };
    const registry = { onRemove: vi.fn(), listContexts: () => bindings, get: () => session, updateMetadata: vi.fn(),
      bindThreadDurably: vi.fn((contextKey, record) => { bindings.push({ contextKey, threadId: record.id }); }),
      getOrCreate: vi.fn(async () => session), bindThread: vi.fn() };
    const bot = createBot({ telegramBotToken: "123:test", telegramAllowedUserIds: [123], telegramAllowedUserIdSet: new Set([123]),
      workspace, maxFileSize: 1024, modelChoices: [], codexSandboxMode: "workspace-write", codexApprovalPolicy: "never",
      launchProfiles: [{ id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "never", unsafe: false }],
      defaultLaunchProfileId: "default", enableUnsafeLaunchProfiles: false, toolVerbosity: "summary", showTurnTokenUsage: false,
      enableTelegramLogin: false, enableTelegramReactions: false, statusBoardIntervalMs: 30_000, topicSyncEnabled: false,
      telegramMaxActiveTopics: 4, telegramProgressHeartbeatMs: 120_000,
    } as never, registry as never, undefined, { topicLivenessApi: { sendChatAction: vi.fn(async () => true) } });
    bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const calls: Array<{ method: string; payload: any }> = [];
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: method === "createForumTopic" ? { message_thread_id: 91, name: "Task" }
        : method === "sendMessage" ? { message_id: 500 } : true } as never;
    });
    let updateId = 0;
    const message = (text: string, isForum = true, topicId: number | null = 7) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 1, from: { id: 123, is_bot: false, first_name: "Allowed" },
      chat: isForum ? { id: -1001, type: "supergroup", title: "Test", is_forum: true } : { id: 123, type: "private", first_name: "Allowed" },
      ...(isForum && topicId !== null ? { message_thread_id: topicId } : {}), text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
    } });
    const callback = (data: string, topicId: number | null = 7) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: `cb-${updateId}`, from: { id: 123, is_bot: false, first_name: "Allowed" }, chat_instance: "test", data,
      message: { message_id: 12, date: 1, chat: { id: -1001, type: "supergroup", title: "Test", is_forum: true }, ...(topicId !== null ? { message_thread_id: topicId } : {}), text: "Sessions" },
    } });
    return { bot, thread, registry, session, calls, message, callback };
  }

  it.each(["topic", "sessions"])("/%s ID creates its own topic without changing the invoking context", async command => {
    const h = await harness([{ contextKey: "-1001:7", threadId: "019fda52-f2ec-7801-ba9c-8761cc89bae4" }]);
    await h.message(`/${command} ${h.thread.id}`);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled(); expect(h.registry.bindThread).not.toHaveBeenCalled();
    expect(h.registry.bindThreadDurably).toHaveBeenCalledExactlyOnceWith("-1001:91", h.thread);
    expect(h.calls.filter(call => call.method === "createForumTopic")).toHaveLength(1);
    expect(h.calls.some(call => call.method === "sendMessage" && call.payload.message_thread_id === 7 && call.payload.text.includes("https://t.me/c/1/91"))).toBe(true);
    await h.bot.disposeTaskProvisioning?.();
  });

  it("reuses another recorded topic and sends its link without starting Codex", async () => {
    const h = await harness([{ contextKey: "-1001:41", threadId: "019fda52-f2ec-7801-ba9c-8761cc89bae4" }]);
    await h.message(`/topic ${h.thread.id}`);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled(); expect(h.registry.bindThreadDurably).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.method === "createForumTopic")).toBe(false);
    expect(h.calls.some(call => call.payload.text?.includes("https://t.me/c/1/41"))).toBe(true);
    await h.bot.disposeTaskProvisioning?.();
  });

  it.each(["/topic", "/topic unknown", "/sessions unknown"])("rejects %s before session or topic mutations", async command => {
    const h = await harness(); await h.message(command);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled(); expect(h.registry.bindThreadDurably).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.method === "createForumTopic")).toBe(false);
    expect(h.calls.some(call => call.method === "sendMessage")).toBe(true);
    await h.bot.disposeTaskProvisioning?.();
  });

  it("keeps /topic forum-only without falling back to attach", async () => {
    const h = await harness(); await h.message(`/topic ${h.thread.id}`, false);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled(); expect(h.registry.bindThreadDurably).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.method === "createForumTopic")).toBe(false);
    expect(h.calls.some(call => call.payload.text?.includes("группе с топиками"))).toBe(true);
    await h.bot.disposeTaskProvisioning?.();
  });


  it.each(["topic", "sessions"].flatMap(command => [null, 1].map(topicId => [command, topicId] as const)))("opens /%s from General without creating a source session (topic=%s)", async (command, topicId) => {
    const h = await harness(); await h.message(`/${command} ${h.thread.id}`, true, topicId);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled(); expect(h.session.switchSession).not.toHaveBeenCalled();
    expect(h.registry.bindThreadDurably).toHaveBeenCalledExactlyOnceWith("-1001:91", h.thread);
    await h.bot.disposeTaskProvisioning?.();
  });

  it.each([["switch", true], ["sessions", false]] as const)("keeps /%s explicit current-context switching (forum=%s)", async (command, isForum) => {
    const h = await harness(); await h.message(`/${command} ${h.thread.id}`, isForum);
    expect(h.session.switchSession).toHaveBeenCalledExactlyOnceWith(h.thread.id);
    expect(h.registry.bindThreadDurably).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.method === "createForumTopic")).toBe(false);
    await h.bot.disposeTaskProvisioning?.();
  });

  it("opens a generic Codex thread button in a separate forum topic", async () => {
    const h = await harness(); await h.callback(`codex_thread:${h.thread.id}`);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled(); expect(h.session.switchSession).not.toHaveBeenCalled();
    expect(h.registry.bindThreadDurably).toHaveBeenCalledExactlyOnceWith("-1001:91", h.thread);
    await h.bot.disposeTaskProvisioning?.();
  });

  it("keeps old forum-session pagination separate from the explicit switch picker", async () => {
    const h = await harness();
    vi.mocked(codexState.listUserThreads).mockReturnValue(Array.from({ length: 15 }, (_, index) => ({ ...h.thread, id: `id-${index}` })));
    await h.message("/sessions");
    const oldPage = h.calls.flatMap(call => call.payload.reply_markup?.inline_keyboard?.flat() ?? [])
      .find(button => /page_1$/.test(button.callback_data ?? ""))?.callback_data;
    expect(oldPage).toBeDefined();
    await h.message("/switch");
    await h.callback(oldPage!);
    const edit = h.calls.filter(call => call.method === "editMessageReplyMarkup").at(-1);
    const buttons = edit?.payload.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(buttons.some(button => button.callback_data?.startsWith("projopen:"))).toBe(true);
    expect(buttons.some(button => /^sess_\d/.test(button.callback_data ?? ""))).toBe(false);
    expect(h.session.switchSession).not.toHaveBeenCalled();
    await h.bot.disposeTaskProvisioning?.();
  });

  it("refreshes the Dashboard after a topic pick without adding messages to its launcher", async () => {
    const h = await harness();
    h.bot.statusBoard = { isDashboardTopic: (_chat, topic) => topic === 7, protectTopicMessage: vi.fn(), refreshSafely: vi.fn() } as never;
    await h.callback(`projopen:${h.thread.id}`);
    expect(h.calls.some(call => call.method === "sendMessage" && call.payload.message_thread_id === 7)).toBe(false);
    expect(h.bot.statusBoard!.refreshSafely).toHaveBeenCalled();
    await h.bot.disposeTaskProvisioning?.();
  });
  it("lists forum sessions as own-topic picks without obtaining a current session", async () => {
    const h = await harness(); await h.message("/sessions", true, null);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled();
    const buttons = h.calls.flatMap(call => call.payload.reply_markup?.inline_keyboard?.flat() ?? []);
    expect(buttons.some(button => button.callback_data === `projopen:${h.thread.id}`)).toBe(true);
    await h.callback(`projopen:${h.thread.id}`, null);
    expect(h.registry.getOrCreate).not.toHaveBeenCalled();
    expect(h.registry.bindThreadDurably).toHaveBeenCalledExactlyOnceWith("-1001:91", h.thread);
    await h.bot.disposeTaskProvisioning?.();
  });
});
