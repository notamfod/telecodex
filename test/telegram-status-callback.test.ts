import { vi } from "vitest";

import {
  createTelegramStatusTransport,
  telegramStatusActionCallbackData,
} from "../src/telegram-grammy-transport.js";

describe("canonical Telegram status callbacks", () => {
  it("encodes the missing-topic recovery action within Telegram callback limits", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 51 }));
    const transport = createTelegramStatusTransport({
      sendMessage,
      editMessageText: vi.fn(),
    } as never);
    const action = {
      kind: "recover_missing_topic" as const,
      jobId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 541,
    };

    const callbackData = telegramStatusActionCallbackData(action);
    expect(callbackData).toBe("tcj:o:11111111-1111-4111-8111-111111111111:541");
    expect(Buffer.byteLength(callbackData!)).toBeLessThanOrEqual(64);
    await transport.send({
      chatId: -1001, messageThreadId: 7, html: "Recovery", plain: "Recovery",
      priority: "urgent", projection: {} as never, actions: [action],
    });

    expect(sendMessage).toHaveBeenCalledWith(-1001, "Recovery", expect.objectContaining({
      reply_markup: { inline_keyboard: [[{
        text: "Recover topic",
        callback_data: callbackData,
      }]] },
    }), expect.any(AbortSignal));
  });

  it.each([
    ["resume_existing_topic", "u", "Resume topic"],
    ["resume_existing_topic_warning", "w", "Resume; status may duplicate"],
  ] as const)("encodes %s within Telegram callback limits", async (kind, code, label) => {
    const sendMessage = vi.fn(async () => ({ message_id: 51 }));
    const transport = createTelegramStatusTransport({
      sendMessage,
      editMessageText: vi.fn(),
    } as never);
    const action = {
      kind,
      jobId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 541,
    };

    const callbackData = telegramStatusActionCallbackData(action);
    expect(callbackData).toBe(`tcj:${code}:11111111-1111-4111-8111-111111111111:541`);
    expect(Buffer.byteLength(callbackData!)).toBeLessThanOrEqual(64);
    await transport.send({
      chatId: -1001, messageThreadId: 7, html: "Resume", plain: "Resume",
      priority: "urgent", projection: {} as never, actions: [action],
    });

    expect(sendMessage).toHaveBeenCalledWith(-1001, "Resume", expect.objectContaining({
      reply_markup: { inline_keyboard: [[{
        text: label,
        callback_data: callbackData,
      }]] },
    }), expect.any(AbortSignal));
  });

  it.each([
    "legacy.job",
    "legacy:job",
    "x".repeat(41),
  ])("does not encode parser-incompatible status job id %s", (jobId) => {
    expect(telegramStatusActionCallbackData({
      kind: "abort", jobId, expectedVersion: 1,
    })).toBeNull();
  });

  it.each([
    "a",
    `${"A".repeat(38)}_-`,
  ])("encodes parser-compatible boundary status job id %s", (jobId) => {
    expect(telegramStatusActionCallbackData({
      kind: "abort", jobId, expectedVersion: 1,
    })).toBe(`tcj:a:${jobId}:1`);
  });

  it("encodes a parser-compatible 24-character part key", () => {
    const partKey = "a_.:-".repeat(4) + "abcd";

    expect(partKey).toHaveLength(24);
    expect(telegramStatusActionCallbackData({
      kind: "retry_delivery", jobId: "job", expectedVersion: 1, partKey,
    })).toBe(`tcj:y:job:1:${partKey}`);
  });

  it.each([
    "x".repeat(25),
    "invalid part",
    "invalid/part",
  ])("does not encode parser-incompatible status part key %s", (partKey) => {
    expect(telegramStatusActionCallbackData({
      kind: "retry_delivery", jobId: "job", expectedVersion: 1, partKey,
    })).toBeNull();
  });
});
