import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBot,
  type TeleCodexBotOptions,
  type TelegramBotReliability,
} from "../src/bot.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";

const workspaces: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RECIPES_CONFIG;
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("canonical Telegram message routing", () => {
  it("does not construct the legacy JSON job store or prompt correctness owner", () => {
    const subject = harness();

    expect(existsSync(path.join(subject.workspace, ".telecodex", "jobs.json"))).toBe(false);
  });

  it.each([
    ["voice", { voice: { file_id: "voice-file", file_unique_id: "voice-unique", duration: 3 } }, {
      id: "voice:voice-unique", kind: "voice", telegramFileId: "voice-file",
      telegramFileUniqueId: "voice-unique",
    }],
    ["audio", { audio: {
      file_id: "audio-file", file_unique_id: "audio-unique", duration: 3,
      file_name: "note.m4a", mime_type: "audio/mp4", file_size: 123,
    } }, {
      id: "audio:audio-unique", kind: "audio", telegramFileId: "audio-file",
      telegramFileUniqueId: "audio-unique", name: "note.m4a", mimeType: "audio/mp4", size: 123,
    }],
    ["photo", { photo: [
      { file_id: "small", file_unique_id: "small-u", width: 10, height: 10 },
      { file_id: "large", file_unique_id: "large-u", width: 100, height: 100, file_size: 456 },
    ], caption: "look" }, {
      id: "photo:large-u", kind: "photo", telegramFileId: "large",
      telegramFileUniqueId: "large-u", name: "telegram-photo.jpg", mimeType: "image/jpeg", size: 456,
    }],
    ["document", { document: {
      file_id: "doc-file", file_unique_id: "doc-unique", file_name: "report.txt",
      mime_type: "text/plain", file_size: 789,
    }, caption: "review" }, {
      id: "document:doc-unique", kind: "document", telegramFileId: "doc-file",
      telegramFileUniqueId: "doc-unique", name: "report.txt", mimeType: "text/plain", size: 789,
    }],
  ] as const)("accepts %s before file access or session creation", async (kind, payload, attachment) => {
    const subject = harness();

    await subject.bot.handleUpdate(messageUpdate(41, payload));

    expect(subject.reliability.handleWork).toHaveBeenCalledWith({
      botId: "123",
      updateId: 41,
      chatId: -1001,
      messageThreadId: 7,
      messageId: 11,
      kind,
      text: "caption" in payload ? payload.caption : null,
      attachment,
      retryOfJobId: null,
    });
    expect(subject.getOrCreate).not.toHaveBeenCalled();
    expect(subject.apiCalls).toEqual([]);
  });

  it("routes text before session creation, reactions, or direct Codex work", async () => {
    const subject = harness();

    await subject.bot.handleUpdate(messageUpdate(42, { text: "Implement this" }));

    expect(subject.reliability.handleWork).toHaveBeenCalledWith({
      botId: "123",
      updateId: 42,
      chatId: -1001,
      messageThreadId: 7,
      messageId: 11,
      kind: "text",
      text: "Implement this",
      attachment: null,
      retryOfJobId: null,
    });
    expect(subject.getOrCreate).not.toHaveBeenCalled();
    expect(subject.apiCalls).toEqual([]);
  });

  it("uses the file id when Telegram omits file_unique_id", async () => {
    const subject = harness();

    await subject.bot.handleUpdate(messageUpdate(43, {
      document: { file_id: "only-file-id", file_name: "x.txt", mime_type: "text/plain" },
    }));

    expect(subject.reliability.handleWork).toHaveBeenCalledWith(expect.objectContaining({
      attachment: expect.objectContaining({ id: "document:only-file-id" }),
    }));
  });
});

describe("canonical Telegram control routing", () => {
  it("wires exact canonical Dashboard actions through the reliability facade", async () => {
    const subject = harness({
      telegramForumChatId: -1001,
      miniApp: { launchUrl: "https://example.test/mini-app" },
    });
    const action = {
      kind: "details" as const,
      jobId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 7,
    };
    subject.reliability.loadDashboardReliability.mockResolvedValueOnce({
      jobs: [{ projection: { jobId: action.jobId, actions: [action] }, events: [] }],
      appServer: { connectivity: "connected", reasonCode: null },
      guardian: { connectivity: "connected", mode: "observe", lastScanAt: 1, reasonCode: null },
      telegram: { deliveryHealth: "healthy", reasonCode: null },
    } as never);

    await subject.bot.dashboard!.runJobAction(action);

    expect(subject.reliability.runDashboardAction).toHaveBeenCalledWith(action);
  });

  it("does not bind pinned Dashboard controls to the Dashboard topic context", async () => {
    const subject = harness({ telegramForumChatId: -1001 });
    vi.spyOn(subject.bot.statusBoard!, "isDashboardMessage").mockImplementation(
      (chatId, messageThreadId, messageId) => chatId === -1001
        && messageThreadId === 7 && messageId === 12,
    );

    await subject.bot.handleUpdate(callbackUpdate(50, "tcj:d:job-board:7"));
    await subject.bot.handleUpdate(callbackUpdate(501, "tcj:a:job-board:8"));
    await subject.bot.handleUpdate(callbackUpdate(502, "tcj:r:job-board:9"));

    expect(subject.reliability.runDashboardAction.mock.calls).toEqual([
      [{ kind: "details", jobId: "job-board", expectedVersion: 7 }, undefined],
      [{ kind: "abort", jobId: "job-board", expectedVersion: 8 }],
      [{ kind: "retry_new_turn", jobId: "job-board", expectedVersion: 9 }],
    ]);
    expect(subject.reliability.abort).not.toHaveBeenCalled();
    expect(subject.reliability.retry).not.toHaveBeenCalled();
  });

  it("never grants pinned Dashboard bypass to the same topic and message ids in another chat", async () => {
    const subject = harness({ telegramForumChatId: -1001 });
    vi.spyOn(subject.bot.statusBoard!, "isDashboardMessage").mockImplementation(
      (chatId, messageThreadId, messageId) => chatId === -1001
        && messageThreadId === 7 && messageId === 12,
    );

    await subject.bot.handleUpdate(callbackUpdate(503, "tcj:a:job-spoof:10", -2002));

    expect(subject.reliability.runDashboardAction).not.toHaveBeenCalled();
    expect(subject.reliability.abort).toHaveBeenCalledWith({
      source: {
        botId: "123", updateId: 503, chatId: -2002,
        messageThreadId: 7, messageId: 12,
      },
      target: { jobId: "job-spoof", version: 10 },
    });
  });

  it("retries the exact latest durable job and never opens a session", async () => {
    const subject = harness();
    subject.reliability.latestJob.mockResolvedValue({ jobId: "job-1", version: 9 });

    await subject.bot.handleUpdate(messageUpdate(51, { text: "/retry" }));

    expect(subject.reliability.latestJob).toHaveBeenCalledWith({
      botId: "123", chatId: -1001, messageThreadId: 7,
    });
    expect(subject.reliability.retry).toHaveBeenCalledWith({
      source: { botId: "123", updateId: 51, chatId: -1001, messageThreadId: 7, messageId: 11 },
      target: { jobId: "job-1", version: 9 },
    });
    expect(subject.getOrCreate).not.toHaveBeenCalled();
  });

  it("aborts the exact latest durable job before replying", async () => {
    const subject = harness();
    subject.reliability.latestJob.mockResolvedValue({ jobId: "job-2", version: 4 });

    await subject.bot.handleUpdate(messageUpdate(52, { text: "/abort" }));

    expect(subject.reliability.abort).toHaveBeenCalledWith({
      source: { botId: "123", updateId: 52, chatId: -1001, messageThreadId: 7, messageId: 11 },
      target: { jobId: "job-2", version: 4 },
    });
    expect(subject.getOrCreate).not.toHaveBeenCalled();
    expect(subject.apiCalls.at(-1)?.[0]).toBe("sendMessage");
    expect(subject.reliability.abort.mock.invocationCallOrder[0]).toBeLessThan(
      subject.apiCall.mock.invocationCallOrder[0],
    );
  });

  it("expires an identity-less legacy abort button instead of targeting latest", async () => {
    const subject = harness();
    subject.reliability.latestJob.mockResolvedValue({ jobId: "job-3", version: 2 });

    await subject.bot.handleUpdate(callbackUpdate(53, "codex_abort:999:999"));

    expect(subject.reliability.latestJob).not.toHaveBeenCalled();
    expect(subject.reliability.abort).not.toHaveBeenCalled();
    expect(subject.getOrCreate).not.toHaveBeenCalled();
    expect(subject.apiCalls.at(-1)?.[0]).toBe("answerCallbackQuery");
    expect(subject.apiCalls.at(-1)?.[1]).toMatchObject({ text: "Status button expired" });
  });

  it("rejects a stale facade result without an expected version", async () => {
    const subject = harness();
    subject.reliability.latestJob.mockResolvedValue({ jobId: "job-stale", version: 0 });

    await expect(subject.bot.handleUpdate(messageUpdate(54, { text: "/retry" })))
      .rejects.toThrow("Invalid canonical Telegram job reference");

    expect(subject.reliability.retry).not.toHaveBeenCalled();
    expect(subject.getOrCreate).not.toHaveBeenCalled();
  });

  it("aborts the exact job and version encoded by a canonical status action", async () => {
    const subject = harness();

    await subject.bot.handleUpdate(callbackUpdate(55, "tcj:a:job-exact:17"));

    expect(subject.reliability.latestJob).not.toHaveBeenCalled();
    expect(subject.reliability.abort).toHaveBeenCalledWith({
      source: { botId: "123", updateId: 55, chatId: -1001, messageThreadId: 7, messageId: 12 },
      target: { jobId: "job-exact", version: 17 },
    });
    expect(subject.reliability.abort.mock.invocationCallOrder[0]).toBeLessThan(
      subject.apiCall.mock.invocationCallOrder[0],
    );
  });

  it("retries the exact status job using actual callback chat and topic identity", async () => {
    const subject = harness();

    await subject.bot.handleUpdate(callbackUpdate(56, "tcj:r:job-exact:18"));

    expect(subject.reliability.latestJob).not.toHaveBeenCalled();
    expect(subject.reliability.retry).toHaveBeenCalledWith({
      source: { botId: "123", updateId: 56, chatId: -1001, messageThreadId: 7, messageId: 12 },
      target: { jobId: "job-exact", version: 18 },
    });
    expect(subject.reliability.retry.mock.invocationCallOrder[0]).toBeLessThan(
      subject.apiCall.mock.invocationCallOrder[0],
    );
  });

  it("routes an exact delivery retry action with its durable part and context", async () => {
    const subject = harness();

    await subject.bot.handleUpdate(callbackUpdate(560, "tcj:y:job-exact:19:final:0000"));

    expect(subject.reliability.runDashboardAction).toHaveBeenCalledWith({
      kind: "retry_delivery", jobId: "job-exact", expectedVersion: 19, partKey: "final:0000",
    }, {
      botId: "123", chatId: -1001, messageThreadId: 7,
    });
    expect(subject.apiCalls.at(-1)).toEqual([
      "answerCallbackQuery", expect.objectContaining({ text: "Delivery retry queued" }),
    ]);
  });

  it("routes Guardian restore through the exact canonical job envelope", async () => {
    const subject = harness();

    await subject.bot.handleUpdate(callbackUpdate(561, "tcj:g:job-exact:20"));

    expect(subject.reliability.runDashboardAction).toHaveBeenCalledWith({
      kind: "guardian_restore", jobId: "job-exact", expectedVersion: 20,
    }, {
      botId: "123", chatId: -1001, messageThreadId: 7,
    });
  });

  it("routes missing-topic recovery only through the exact Dashboard action envelope", async () => {
    const subject = harness({ telegramForumChatId: -1001 });
    vi.spyOn(subject.bot.statusBoard!, "isDashboardMessage").mockReturnValue(true);

    await subject.bot.handleUpdate(callbackUpdate(562, "tcj:o:job-exact:541"));

    expect(subject.reliability.runDashboardAction).toHaveBeenCalledWith({
      kind: "recover_missing_topic", jobId: "job-exact", expectedVersion: 541,
    }, undefined);
    expect(subject.apiCalls.at(-1)).toEqual([
      "answerCallbackQuery", expect.objectContaining({ text: "Topic recovery started" }),
    ]);
  });

  it.each([
    ["resume_existing_topic", "u", "Topic resume started"],
    ["resume_existing_topic_warning", "w", "Warning replay started"],
  ] as const)("routes %s through the exact Dashboard action envelope", async (kind, code, label) => {
    const subject = harness({ telegramForumChatId: -1001 });
    vi.spyOn(subject.bot.statusBoard!, "isDashboardMessage").mockReturnValue(true);

    await subject.bot.handleUpdate(callbackUpdate(563, `tcj:${code}:job-exact:541`));

    expect(subject.reliability.runDashboardAction).toHaveBeenCalledWith({
      kind, jobId: "job-exact", expectedVersion: 541,
    }, undefined);
    expect(subject.apiCalls.at(-1)).toEqual([
      "answerCallbackQuery", expect.objectContaining({ text: label }),
    ]);
  });

  it.each([
    "tcj:a::1",
    "tcj:a:job:0",
    "tcj:r:job:not-a-version",
    "tcj:x:job:1",
    `tcj:a:${"x".repeat(49)}:1`,
  ])("does not register malformed or unsupported canonical action %s", async (data) => {
    const subject = harness();

    await subject.bot.handleUpdate(callbackUpdate(57, data));

    expect(subject.reliability.abort).not.toHaveBeenCalled();
    expect(subject.reliability.retry).not.toHaveBeenCalled();
    expect(subject.apiCalls).toEqual([]);
  });

  it("settles a stale status callback without retrying a different job", async () => {
    const subject = harness();
    subject.reliability.abort.mockRejectedValueOnce(new Error("Telegram job version conflict"));

    await subject.bot.handleUpdate(callbackUpdate(58, "tcj:a:job-exact:3"));

    expect(subject.reliability.abort).toHaveBeenCalledOnce();
    expect(subject.reliability.latestJob).not.toHaveBeenCalled();
    expect(subject.apiCalls.at(-1)).toEqual([
      "answerCallbackQuery",
      expect.objectContaining({ text: "Status changed, refresh" }),
    ]);
  });

  it.each(["/abort", "/retry"])("reports an optimistic race for %s without choosing latest again", async (command) => {
    const subject = harness();
    subject.reliability.latestJob.mockResolvedValue({ jobId: "job-race", version: 3 });
    const operation = command === "/abort" ? subject.reliability.abort : subject.reliability.retry;
    operation.mockRejectedValueOnce(new Error("Telegram job version conflict"));

    await subject.bot.handleUpdate(messageUpdate(59, { text: command }));

    expect(subject.reliability.latestJob).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    expect(subject.apiCalls.at(-1)).toEqual([
      "sendMessage",
      expect.objectContaining({ text: "Status changed, refresh and try again" }),
    ]);
  });
});

describe("canonical callback work routing", () => {
  it("validates the Sentry recipe and durably targets a dedicated readonly topic", async () => {
    const recipePath = path.join(mkdtempSync(path.join(tmpdir(), "telecodex-recipes-")), "recipes.json");
    workspaces.push(path.dirname(recipePath));
    writeFileSync(recipePath, JSON.stringify({ recipes: [{
      id: "sentry", kind: "sentry-top", cwd: "/srv/mircli", dofboxConfigModule: "/opt/dofbox.js",
      realm: "mircli", period: "24h", limit: 5,
      deliver: { chatId: -1001, messageThreadId: 7 },
    }] }));
    process.env.RECIPES_CONFIG = recipePath;
    const backgroundWriteGate = {
      run: vi.fn(async <T>(
        _chatId: number,
        _priority: "ordinary" | "urgent",
        operation: () => Promise<T>,
      ) => operation()),
    };
    const subject = harness({}, { backgroundWriteGate });

    await subject.bot.handleUpdate(callbackUpdate(61, "sentry_task:12345:MIR-BACK-2VY"));

    expect(subject.reliability.handleWork).toHaveBeenCalledWith(expect.objectContaining({
      botId: "123",
      updateId: expect.any(Number),
      chatId: -1001,
      messageThreadId: 7,
      messageId: 12,
      kind: "confirmation",
      text: expect.stringContaining("MIR-BACK-2VY"),
      attachment: null,
      retryOfJobId: null,
      sessionDefaults: expect.objectContaining({ workspace: "/srv/mircli", launchProfileId: "readonly" }),
      targetProvision: { kind: "forum_topic", topicName: "🔎 MIR-BACK-2VY · Sentry", state: "planned" },
    }));
    expect(subject.reliability.handleWork.mock.calls[0]![0].updateId).toBeGreaterThanOrEqual(
      5_000_000_000_000_000,
    );
    expect(subject.reliability.handleWork.mock.invocationCallOrder[0]).toBeLessThan(
      subject.apiCall.mock.invocationCallOrder[0],
    );
    expect(subject.getOrCreate).not.toHaveBeenCalled();
    expect(subject.apiCalls.map(([method]) => method)).toEqual([
      "answerCallbackQuery", "sendMessage",
    ]);
    expect(backgroundWriteGate.run).not.toHaveBeenCalled();
    delete process.env.RECIPES_CONFIG;
  });

  it("accepts an MR review into a dedicated readonly topic", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/projects/48/merge_requests/19/changes")) {
        return { ok: true, json: async () => ({ changes: [{
          new_path: "src/reliability.ts", old_path: "src/reliability.ts", diff: "+safe",
        }] }) };
      }
      if (!url.includes("/groups/46/merge_requests")) {
        throw new Error(`unexpected GitLab request: ${url}`);
      }
      return {
        ok: true,
        json: async () => [{
          iid: 19,
          project_id: 48,
          title: "MIR-7000 fix callback durability",
          source_branch: "MIR-7000",
          target_branch: "main",
          draft: false,
          web_url: "https://gitlab.example/acme/api/-/merge_requests/19",
          author: { username: "alice" },
          references: { full: "acme/api!19" },
        }],
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const subject = harness({
      gitlabUrl: "https://gitlab.example",
      gitlabToken: "token",
      gitlabGroupId: "46",
    });

    await subject.bot.handleUpdate(messageUpdate(62, { text: "/mr" }));
    subject.apiCalls.length = 0;
    subject.apiCall.mockClear();
    await subject.bot.handleUpdate(callbackUpdate(63, "mr:48:19"));

    expect(subject.reliability.handleWork).toHaveBeenCalledWith(expect.objectContaining({
      updateId: expect.any(Number),
      chatId: -1001,
      messageThreadId: 7,
      messageId: 12,
      kind: "confirmation",
      text: expect.stringContaining("!19"),
      attachment: null,
      targetProvision: expect.objectContaining({ kind: "forum_topic", state: "planned" }),
      sessionDefaults: expect.objectContaining({ launchProfileId: "readonly" }),
    }));
    expect(subject.reliability.handleWork.mock.invocationCallOrder[0]).toBeLessThan(
      subject.apiCall.mock.invocationCallOrder[0],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(subject.getOrCreate).not.toHaveBeenCalled();
    expect(subject.apiCalls.map(([method]) => method)).toEqual([
      "answerCallbackQuery", "sendMessage",
    ]);
  });
});

function harness(
  configOverrides: Record<string, unknown> = {},
  botOptions: TeleCodexBotOptions = {},
) {
  const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-message-routing-"));
  workspaces.push(workspace);
  const getOrCreate = vi.fn(async () => { throw new Error("session must not be opened"); });
  const setContextDefaults = vi.fn();
  const reliability = {
    handleWork: vi.fn(async (source: TelegramWorkSource) => source.targetProvision
      ? { chatId: source.chatId, messageThreadId: 91 }
      : null),
    registerCompletionProcessor: vi.fn(),
    latestJob: vi.fn<() => Promise<{ jobId: string; version: number } | null>>(async () => null),
    retry: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    loadDashboardSessionStatuses: vi.fn(async () => []),
    loadDashboardReliability: vi.fn(async () => ({
      jobs: [],
      appServer: { connectivity: "connected" as const, reasonCode: null },
      guardian: { connectivity: "connected" as const, mode: "observe" as const, lastScanAt: null, reasonCode: null },
      telegram: { deliveryHealth: "healthy" as const, reasonCode: null },
    })),
    runDashboardAction: vi.fn(async () => undefined),
  } satisfies TelegramBotReliability;
  const bot = createBot(
    { ...config(workspace), ...configOverrides },
    { onRemove: vi.fn(), getOrCreate, setContextDefaults } as never,
    reliability,
    botOptions,
  );
  bot.botInfo = {
    id: 123, is_bot: true, first_name: "Test", username: "test_bot",
    can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
  };
  const apiCalls: Array<[string, Record<string, unknown>]> = [];
  const apiCall = vi.fn(async (_previous, method: string, payload: Record<string, unknown>) => {
    apiCalls.push([method, payload]);
    if (method === "createForumTopic") return { ok: true, result: { message_thread_id: 91, name: payload.name } } as never;
    if (method === "sendMessage") return { ok: true, result: { message_id: 99, date: 1, chat: { id: -1001, type: "supergroup" }, text: payload.text } } as never;
    return { ok: true, result: true } as never;
  });
  bot.api.config.use(apiCall as never);
  expect(reliability.registerCompletionProcessor).toHaveBeenCalledOnce();
  return { bot, reliability, getOrCreate, setContextDefaults, apiCalls, apiCall, workspace };
}

function config(workspace: string) {
  return {
    telegramBotToken: "123:test", telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]), workspace, maxFileSize: 1024 * 1024,
    modelChoices: [], codexSandboxMode: "workspace-write", codexApprovalPolicy: "never",
    launchProfiles: [{ id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "never", unsafe: false }],
    defaultLaunchProfileId: "default", enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary", showTurnTokenUsage: false, enableTelegramLogin: false,
    enableTelegramReactions: true, statusBoardIntervalMs: 30_000,
    topicSyncEnabled: false, telegramMaxActiveTopics: 4, telegramProgressHeartbeatMs: 120_000,
  } as never;
}

function messageUpdate(updateId: number, payload: Record<string, unknown>) {
  const commandEntities = typeof payload.text === "string" && payload.text.startsWith("/")
    ? { entities: [{ type: "bot_command", offset: 0, length: payload.text.length }] }
    : {};
  return {
    update_id: updateId,
    message: {
      message_id: 11, date: 1, from: { id: 123, is_bot: false, first_name: "Allowed" },
      chat: { id: -1001, type: "supergroup", title: "Test" }, message_thread_id: 7,
      ...payload, ...commandEntities,
    },
  } as never;
}

function callbackUpdate(updateId: number, data: string, chatId = -1001) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`, from: { id: 123, is_bot: false, first_name: "Allowed" },
      chat_instance: "test", data,
      message: {
        message_id: 12, date: 1, chat: { id: chatId, type: "supergroup", title: "Test" },
        message_thread_id: 7, text: "Status",
      },
    },
  } as never;
}
