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
