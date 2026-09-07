import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createForumTopicLivenessProbe,
  isMissingForumTopicError,
  type ForumTopicDestination,
} from "../src/telegram-topic-liveness.js";

const destination: ForumTopicDestination = { chatId: -1001, messageThreadId: 41 };

describe("forum topic liveness", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects invalid destinations and timing values", () => {
    const sendChatAction = vi.fn(async () => true);
    for (const timeoutMs of [0, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createForumTopicLivenessProbe({ sendChatAction, timeoutMs }))
        .toThrow("Invalid timeoutMs");
    }
    for (const cacheTtlMs of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createForumTopicLivenessProbe({ sendChatAction, cacheTtlMs }))
        .toThrow("Invalid cacheTtlMs");
    }

    const probe = createForumTopicLivenessProbe({ sendChatAction });
    for (const chatId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => probe({ chatId, messageThreadId: 41 })).toThrow("Invalid Telegram chat id");
    }
    for (const messageThreadId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => probe({ chatId: -1001, messageThreadId }))
        .toThrow("Invalid Telegram topic id");
    }
  });

  it("accepts the maximum Node timer delay and a longer cache TTL", () => {
    expect(() => createForumTopicLivenessProbe({
      sendChatAction: vi.fn(async () => true),
      timeoutMs: 2_147_483_647,
      cacheTtlMs: 2_147_483_648,
    })).not.toThrow();
  });

  it("uses an ephemeral typing action in the target topic", async () => {
    const sendChatAction = vi.fn(async () => true);
    const probe = createForumTopicLivenessProbe({ sendChatAction });

    await expect(probe(destination)).resolves.toBe(true);

    expect(sendChatAction).toHaveBeenCalledWith(
      destination.chatId,
      "typing",
      { message_thread_id: destination.messageThreadId },
      expect.any(AbortSignal),
    );
  });

  it.each(["TOPIC_CLOSED", "Bad Request: topic is closed"])(
    "treats a closed topic as existing: %s",
    async (message) => {
      const probe = createForumTopicLivenessProbe({
        sendChatAction: vi.fn().mockRejectedValue(new Error(message)),
      });
      await expect(probe(destination)).resolves.toBe(true);
    },
  );

  it.each(["TOPIC_DELETED", "TOPIC_ID_INVALID", "message thread not found"])(
    "treats only a definitive missing response as missing: %s",
    async (message) => {
      const probe = createForumTopicLivenessProbe({
        sendChatAction: vi.fn().mockRejectedValue(new Error(message)),
      });
      await expect(probe(destination)).resolves.toBe(false);
      expect(isMissingForumTopicError(new Error(message))).toBe(true);
    },
  );

  it.each(["Too Many Requests: retry after 20", "network failed", "unknown"])(
    "propagates an ambiguous failure unchanged: %s",
    async (message) => {
      const error = new Error(message);
      const probe = createForumTopicLivenessProbe({
        sendChatAction: vi.fn().mockRejectedValue(error),
      });
      await expect(probe(destination)).rejects.toBe(error);
    },
  );

  it("shares one request and briefly caches its result", async () => {
    let now = 1_000;
    let release!: () => void;
    const pending = new Promise<true>((resolve) => { release = () => resolve(true); });
    const sendChatAction = vi.fn(() => pending);
    const probe = createForumTopicLivenessProbe({ sendChatAction, now: () => now });

    const first = probe(destination);
    const concurrent = probe(destination);
    expect(sendChatAction).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);

    await expect(probe(destination)).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledOnce();
    now += 5_001;
    sendChatAction.mockResolvedValueOnce(true);
    await expect(probe(destination)).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    const sendChatAction = vi.fn()
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce(true);
    const probe = createForumTopicLivenessProbe({ sendChatAction });

    await expect(probe(destination)).rejects.toThrow("network failed");
    await expect(probe(destination)).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("clears a failed request before its rejection reaches the caller", async () => {
    const sendChatAction = vi.fn()
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce(true);
    const probe = createForumTopicLivenessProbe({ sendChatAction });

    try {
      await probe(destination);
    } catch {
      // The next call must not observe the failed request's stale single-flight entry.
    }
    await expect(probe(destination)).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("lets a joining caller abort without cancelling the shared request", async () => {
    let release!: () => void;
    const pending = new Promise<true>((resolve) => { release = () => resolve(true); });
    let requestSignal: AbortSignal | undefined;
    const sendChatAction = vi.fn((_chatId, _action, _options, signal) => {
      requestSignal = signal;
      return pending;
    });
    const probe = createForumTopicLivenessProbe({ sendChatAction });
    const first = probe(destination);
    const joinerController = new AbortController();
    const joiner = probe(destination, joinerController.signal);

    joinerController.abort();
    await expect(joiner).rejects.toThrow("Telegram topic probe aborted");
    expect(requestSignal?.aborted).toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledOnce();
  });

  it("keeps the shared request alive when the initiating caller aborts", async () => {
    let release!: () => void;
    const pending = new Promise<true>((resolve) => { release = () => resolve(true); });
    let requestSignal: AbortSignal | undefined;
    const sendChatAction = vi.fn((_chatId, _action, _options, signal) => {
      requestSignal = signal;
      return pending;
    });
    const probe = createForumTopicLivenessProbe({ sendChatAction });
    const firstController = new AbortController();
    const first = probe(destination, firstController.signal);
    const second = probe(destination);

    firstController.abort();
    await expect(first).rejects.toThrow("Telegram topic probe aborted");
    expect(requestSignal?.aborted).toBe(false);
    release();
    await expect(second).resolves.toBe(true);
    expect(sendChatAction).toHaveBeenCalledOnce();
  });

  it("skips Telegram when the first caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sendChatAction = vi.fn(async () => true);
    const probe = createForumTopicLivenessProbe({ sendChatAction });

    await expect(probe(destination, controller.signal)).rejects.toThrow("Telegram topic probe aborted");
    expect(sendChatAction).not.toHaveBeenCalled();
  });

  it("caches a missing result and expires that negative cache", async () => {
    let now = 1_000;
    const sendChatAction = vi.fn().mockRejectedValue(new Error("TOPIC_DELETED"));
    const probe = createForumTopicLivenessProbe({ sendChatAction, now: () => now });

    await expect(probe(destination)).resolves.toBe(false);
    await expect(probe(destination)).resolves.toBe(false);
    expect(sendChatAction).toHaveBeenCalledOnce();
    now += 5_001;
    await expect(probe(destination)).resolves.toBe(false);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("aborts and rejects a probe after its deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const probe = createForumTopicLivenessProbe({
      sendChatAction: vi.fn((_chatId, _action, _options, signal) => {
        requestSignal = signal;
        return new Promise<never>(() => {});
      }),
    });

    const result = probe(destination);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).rejects.toThrow("Telegram topic probe timed out");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("propagates caller cancellation to Telegram", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const probe = createForumTopicLivenessProbe({
      sendChatAction: vi.fn((_chatId, _action, _options, signal) => {
        requestSignal = signal;
        return new Promise<never>(() => {});
      }),
    });

    const result = probe(destination, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("Telegram topic probe aborted");
    expect(requestSignal?.aborted).toBe(true);
  });
});
