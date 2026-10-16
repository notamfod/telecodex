import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { handleMircliDeployCallback } from "../src/bot-mircli-deploy.js";

const config = { telegramForumChatId: -1001, telegramAllowedUserIdSet: new Set([7]) };
function context(overrides: Record<string, unknown> = {}): Context {
  return {
    from: { id: 7 }, chat: { id: -1001 },
    callbackQuery: { data: "mdeploy:production", message: {
      message_id: 91, message_thread_id: 3861, chat: { id: -1001 },
    } },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(), reply: vi.fn(), ...overrides,
  } as unknown as Context;
}

describe("MirCli deploy summary view callback", () => {
  it.each(["main", "production"] as const)("switches the existing message to %s and keeps controls", async ref => {
    const ctx = context({ callbackQuery: { data: `mdeploy:${ref}`, message: {
      message_id: 91, message_thread_id: 3861, chat: { id: -1001 },
    } } });
    const switchView = vi.fn(async () => undefined);
    await handleMircliDeployCallback(ctx, config, { switchView });
    expect(switchView).toHaveBeenCalledWith({ chatId: -1001, messageThreadId: 3861, messageId: 91, ref });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({});
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it.each([
    { from: { id: 8 } }, { chat: { id: -1002 } },
    { callbackQuery: { data: "mdeploy:staging", message: { message_id: 91, message_thread_id: 3861, chat: { id: -1001 } } } },
    { callbackQuery: { data: "mdeploy:main", message: { message_id: 0, message_thread_id: 3861, chat: { id: -1001 } } } },
    { callbackQuery: { data: "mdeploy:main", message: { message_id: 91, chat: { id: -1001 } } } },
    { callbackQuery: { data: "mdeploy:main", message: { message_id: 91, message_thread_id: 3861, chat: { id: -1002 } } } },
  ])("rejects invalid user or context %j", async overrides => {
    const ctx = context(overrides);
    const switchView = vi.fn(async () => undefined);
    await handleMircliDeployCallback(ctx, config, { switchView });
    expect(switchView).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("alerts with a sanitized error while preserving the buttons", async () => {
    const ctx = context();
    await handleMircliDeployCallback(ctx, config, { switchView: async () => { throw new Error("token secret"); } });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Не удалось переключить сводку. Попробуй ещё раз.", show_alert: true });
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
