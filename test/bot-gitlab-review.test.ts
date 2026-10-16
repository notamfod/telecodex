import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

import { handleGitlabReviewCallback } from "../src/bot-gitlab-review.js";

const REQUEST_ID = "a".repeat(32);
const TARGET = { chatId: -100123, messageThreadId: 3861 };

function context(overrides: Record<string, unknown> = {}): Context {
  return {
    from: { id: 7 },
    chat: { id: TARGET.chatId },
    callbackQuery: {
      data: `greview:${REQUEST_ID}`,
      message: { message_id: 91, message_thread_id: TARGET.messageThreadId },
    },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
    ...overrides,
  } as unknown as Context;
}

function dependencies() {
  return {
    loadTarget: vi.fn(async () => TARGET),
    activate: vi.fn(async () => "accepted" as const),
  };
}

describe("GitLab review launch callback", () => {
  it("activates only the offered request and source message, then consumes the button", async () => {
    const ctx = context();
    const deps = dependencies();
    await handleGitlabReviewCallback(ctx, new Set([7]), deps);
    expect(deps.activate).toHaveBeenCalledWith({ requestId: REQUEST_ID, ...TARGET, messageId: 91 });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Ревью поставлено в очередь" });
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [] } });
  });

  it.each([
    { from: { id: 8 } },
    { chat: { id: -100999 } },
    { callbackQuery: { data: `greview:${REQUEST_ID}`, message: { message_id: 91, message_thread_id: 999 } } },
    { callbackQuery: { data: "greview:../../etc", message: { message_id: 91, message_thread_id: 3861 } } },
    { callbackQuery: { data: `greview:${REQUEST_ID}` } },
  ])("does not activate an unauthorized or mismatched callback %j", async (overrides) => {
    const ctx = context(overrides);
    const deps = dependencies();
    await handleGitlabReviewCallback(ctx, new Set([7]), deps);
    expect(deps.activate).not.toHaveBeenCalled();
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("leaves a retryable button when durable activation fails", async () => {
    const ctx = context();
    const deps = dependencies();
    deps.activate.mockRejectedValueOnce(new Error("secret response must not be shown"));
    await handleGitlabReviewCallback(ctx, new Set([7]), deps);
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Не удалось запустить ревью. Попробуй ещё раз.", show_alert: true });
  });

  it("safely consumes an already activated request", async () => {
    const ctx = context();
    const deps = { ...dependencies(), activate: vi.fn(async () => "duplicate" as const) };
    await handleGitlabReviewCallback(ctx, new Set([7]), deps);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Ревью уже запускали" });
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledOnce();
  });

  it("consumes only the launch button and preserves diff and GitLab navigation", async () => {
    const navigation = [{ text: "Дифф", url: "https://t.me/ExampleBot/app?startapp=review_x" },
      { text: "GitLab", url: "https://git.example.test/group/app" }];
    const ctx = context({ callbackQuery: { data: `greview:${REQUEST_ID}`, message: {
      message_id: 91, message_thread_id: TARGET.messageThreadId,
      reply_markup: { inline_keyboard: [[{ text: "Запустить", callback_data: `greview:${REQUEST_ID}` }], navigation] },
    } } });
    await handleGitlabReviewCallback(ctx, new Set([7]), dependencies());
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [navigation] } });
  });
});
