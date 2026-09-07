import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GUARDIAN_TELEGRAM_RETRY_OPTIONS,
  createGuardianTelegramApi,
} from "../src/session-guardian-telegram-api.js";

describe("guardian Telegram API deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts and rejects a never-settling send at the hard wall-clock deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const raw = {
      sendMessage: vi.fn((_chatId, _text, _options, requestSignal?: AbortSignal) => {
        signal = requestSignal;
        return new Promise<never>(() => undefined);
      }),
      editMessageText: vi.fn(),
    };
    const api = createGuardianTelegramApi(raw, { timeoutMs: 15_000 });
    const pending = api.sendMessage(-1001, "safe", {});

    expect(signal?.aborted).toBe(false);
    const rejection = expect(pending).rejects.toThrow("Guardian Telegram request timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes a signal to edit and clears the deadline after success", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const raw = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(async (_chatId, _messageId, _text, _options,
        requestSignal?: AbortSignal) => {
        signal = requestSignal;
        return { ok: true };
      }),
    };
    const api = createGuardianTelegramApi(raw, { timeoutMs: 15_000 });
    await expect(api.editMessageText(-1001, 5, "safe", {})).resolves.toEqual({ ok: true });
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses bounded auto-retry settings that rethrow network and 5xx failures", () => {
    expect(GUARDIAN_TELEGRAM_RETRY_OPTIONS).toMatchObject({
      maxRetryAttempts: 3,
      maxDelaySeconds: 60,
      rethrowHttpErrors: true,
      rethrowInternalServerErrors: true,
    });
  });
});
