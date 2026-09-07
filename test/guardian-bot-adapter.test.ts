import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBot } from "../src/bot.js";
import { registerGuardianCallbacks } from "../src/guardian-bot-adapter.js";
import { SessionGuardianIpcServer } from "../src/session-guardian-ipc.js";
import { GuardianIpcTimeoutError } from "../src/session-guardian-ipc.js";

const ALERT_ID = "abcdefghijklmnopqrstuv";

describe("guardian bot adapter", () => {
  it("registers the exact opaque callback and ignores invalid forms", () => {
    const subject = harness();
    registerGuardianCallbacks(subject.bot as never, { socketPath: "/tmp/guardian.sock" }, {
      client: { repairAlert: vi.fn() },
    });

    expect(subject.pattern.test(`guardian_restore:${ALERT_ID}`)).toBe(true);
    expect(subject.pattern.test(`guardian_restore:${ALERT_ID}x`)).toBe(false);
    expect(subject.pattern.test("guardian_restore:01a02451-2fc4-76c0-9f14-c75034c10017")).toBe(false);
    expect(subject.pattern.test(`xguardian_restore:${ALERT_ID}`)).toBe(false);
  });

  it.each([
    ["restored", "Сессия восстановлена.", false],
    ["self-recovered", "Сессия уже восстановилась сама.", false],
    ["observation-only", "Guardian работает в режиме наблюдения", true],
    ["repair-disabled", "Восстановление сейчас отключено.", true],
    ["expired", "Запрос больше не актуален.", false],
    ["no-longer-eligible", "Запрос больше не актуален.", false],
    ["failed", "Не удалось восстановить сессию.", true],
  ])("renders %s without internal detail and preserves retry when required", async (
    outcome, expected, preservesRestore,
  ) => {
    const repairAlert = vi.fn(async () => ({
      outcome,
      message: "secret prompt /root/.env raw stack",
      threadId: "01a02451-2fc4-76c0-9f14-c75034c10017",
    }));
    const subject = harness();
    registerGuardianCallbacks(subject.bot as never, { socketPath: "/tmp/guardian.sock" }, {
      client: { repairAlert },
    });

    await subject.run(`guardian_restore:${ALERT_ID}`);

    expect(subject.answer).toHaveBeenCalledBefore(repairAlert);
    expect(subject.answer).toHaveBeenCalledWith({ text: "Проверяю..." });
    expect(repairAlert).toHaveBeenCalledWith(ALERT_ID);
    expect(subject.edit).toHaveBeenCalledWith(
      expect.stringContaining(expected),
      { reply_markup: preservesRestore
        ? { inline_keyboard: [[{ text: "Restore", callback_data: `guardian_restore:${ALERT_ID}` }]] }
        : { inline_keyboard: [] } },
    );
    expect(JSON.stringify(subject.edit.mock.calls)).not.toContain("secret prompt");
    expect(subject.reply).not.toHaveBeenCalled();
  });

  it("sanitizes transient errors and never removes Restore when editing fails", async () => {
    const subject = harness({ editFailure: new Error("message missing") });
    registerGuardianCallbacks(subject.bot as never, { socketPath: "/tmp/guardian.sock" }, {
      client: {
        repairAlert: vi.fn(async () => {
          throw new Error("secret prompt and stack");
        }),
      },
    });

    await subject.run(`guardian_restore:${ALERT_ID}`);

    expect(subject.reply).toHaveBeenCalledWith(
      "Не удалось восстановить сессию. Попробуйте позже.",
      { message_thread_id: 77 },
    );
    expect(subject.removeMarkup).not.toHaveBeenCalled();
    expect(JSON.stringify(subject.reply.mock.calls)).not.toContain("secret prompt");
  });

  it("reports a continuing check instead of a false failure on IPC deadline", async () => {
    const subject = harness();
    registerGuardianCallbacks(subject.bot as never, { socketPath: "/tmp/guardian.sock" }, {
      client: {
        repairAlert: vi.fn(async () => {
          throw new GuardianIpcTimeoutError();
        }),
      },
    });

    await subject.run(`guardian_restore:${ALERT_ID}`);

    expect(subject.edit).toHaveBeenCalledWith(
      "Проверка продолжается. Итог появится в уведомлении Guardian.",
      { reply_markup: { inline_keyboard: [[{
        text: "Restore", callback_data: `guardian_restore:${ALERT_ID}`,
      }]] } },
    );
  });

  it("is registered after the existing global authorization middleware in createBot", () => {
    const source = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
    const authorization = source.indexOf("!config.telegramAllowedUserIdSet.has(fromId)");
    const registration = source.indexOf("registerGuardianCallbacks(bot");

    expect(authorization).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(authorization);
  });

  it("lets the existing global middleware reject unauthorized callbacks before IPC", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-auth-"));
    try {
      const bot = createBot({
        telegramBotToken: "123:test",
        telegramAllowedUserIds: [123],
        telegramAllowedUserIdSet: new Set([123]),
        workspace,
        maxFileSize: 1024,
        modelChoices: [],
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "never",
        launchProfiles: [{
          id: "default",
          label: "Default",
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          unsafe: false,
        }],
        defaultLaunchProfileId: "default",
        enableUnsafeLaunchProfiles: false,
        toolVerbosity: "summary",
        showTurnTokenUsage: false,
        enableTelegramLogin: false,
        enableTelegramReactions: false,
        statusBoardIntervalMs: 30_000,
        telegramForumChatId: -1001,
        topicSyncEnabled: false,
        telegramMaxActiveTopics: 4,
        telegramProgressHeartbeatMs: 120_000,
        sessionGuardianSocketPath: path.join(workspace, "missing.sock"),
      }, { onRemove: vi.fn() } as never);
      bot.botInfo = {
        id: 123,
        is_bot: true,
        first_name: "Guardian test",
        username: "guardian_test_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      };
      const apiCalls: Array<[string, Record<string, unknown>]> = [];
      bot.api.config.use(async (_previous, method, payload) => {
        apiCalls.push([method, payload as Record<string, unknown>]);
        return { ok: true, result: true } as never;
      });

      await bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "callback-1",
          from: { id: 999, is_bot: false, first_name: "Unauthorized" },
          chat_instance: "test",
          data: `guardian_restore:${ALERT_ID}`,
          message: {
            message_id: 5,
            date: 1,
            chat: { id: -1001, type: "supergroup", title: "Test" },
            text: "Guardian alert",
          },
        },
      });

      expect(apiCalls).toEqual([
        ["answerCallbackQuery", expect.objectContaining({ text: "Unauthorized" })],
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an allowed user in the wrong chat and reaches IPC in the configured chat", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-chat-auth-"));
    const socketPath = path.join(workspace, "guardian.sock");
    const repairAlert = vi.fn(async () => ({
      outcome: "restored" as const,
      threadId: "01a02451-2fc4-76c0-9f14-c75034c10017",
      detail: "Thread restored",
    }));
    const ipc = new SessionGuardianIpcServer({
      socketPath,
      status: async () => ({ outcome: "ok", message: "ready" }),
      checkAlert: repairAlert,
      repairAlert,
    });
    try {
      await ipc.start();
      const bot = createBot({
        telegramBotToken: "123:test",
        telegramAllowedUserIds: [123],
        telegramAllowedUserIdSet: new Set([123]),
        workspace,
        maxFileSize: 1024,
        modelChoices: [],
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "never",
        launchProfiles: [{
          id: "default",
          label: "Default",
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          unsafe: false,
        }],
        defaultLaunchProfileId: "default",
        enableUnsafeLaunchProfiles: false,
        toolVerbosity: "summary",
        showTurnTokenUsage: false,
        enableTelegramLogin: false,
        enableTelegramReactions: false,
        telegramForumChatId: -1001,
        statusBoardIntervalMs: 30_000,
        topicSyncEnabled: false,
        telegramMaxActiveTopics: 4,
        telegramProgressHeartbeatMs: 120_000,
        sessionGuardianSocketPath: socketPath,
      }, { onRemove: vi.fn() } as never);
      bot.botInfo = {
        id: 123,
        is_bot: true,
        first_name: "Guardian test",
        username: "guardian_test_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      };
      const apiCalls: Array<[string, Record<string, unknown>]> = [];
      bot.api.config.use(async (_previous, method, payload) => {
        apiCalls.push([method, payload as Record<string, unknown>]);
        return { ok: true, result: true } as never;
      });

      await bot.handleUpdate(guardianUpdate(-1002, 1));
      expect(repairAlert).not.toHaveBeenCalled();
      expect(apiCalls).toEqual([
        ["answerCallbackQuery", expect.objectContaining({ text: "Unauthorized" })],
      ]);

      apiCalls.length = 0;
      await bot.handleUpdate(guardianUpdate(-1001, 2));
      expect(repairAlert).toHaveBeenCalledTimes(1);
      expect(apiCalls.map(([method]) => method)).toEqual([
        "answerCallbackQuery",
        "editMessageText",
      ]);
      expect(apiCalls[0]![1]).toMatchObject({ text: "Проверяю..." });
    } finally {
      await ipc.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function guardianUpdate(chatId: number, updateId: number) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 123, is_bot: false, first_name: "Allowed" },
      chat_instance: "test",
      data: `guardian_restore:${ALERT_ID}`,
      message: {
        message_id: 5,
        date: 1,
        chat: { id: chatId, type: "supergroup" as const, title: "Test" },
        text: "Guardian alert",
      },
    },
  };
}

function harness(options: { editFailure?: Error } = {}) {
  let pattern = /never/;
  let handler: ((ctx: unknown) => Promise<void>) | undefined;
  const answer = vi.fn(async () => undefined);
  const edit = vi.fn(async () => {
    if (options.editFailure) throw options.editFailure;
  });
  const reply = vi.fn(async () => undefined);
  const removeMarkup = vi.fn(async () => undefined);
  const bot = {
    callbackQuery: (candidate: RegExp, callback: (ctx: unknown) => Promise<void>) => {
      pattern = candidate;
      handler = callback;
    },
  };
  return {
    bot,
    get pattern() { return pattern; },
    answer,
    edit,
    reply,
    removeMarkup,
    run: async (data: string) => {
      if (!handler) throw new Error("handler not registered");
      await handler({
        callbackQuery: {
          data,
          message: { message_thread_id: 77 },
        },
        answerCallbackQuery: answer,
        editMessageText: edit,
        editMessageReplyMarkup: removeMarkup,
        reply,
      });
    },
  };
}
