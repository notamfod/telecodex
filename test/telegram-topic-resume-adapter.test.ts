import type { ApiClientOptions } from "grammy";
import { vi } from "vitest";

import type { CodexThreadRecord } from "../src/codex-state.js";
import { createTelegramTopicResumeAdapter } from "../src/telegram-topic-resume-adapter.js";

describe("Telegram topic resume adapter", () => {
  it.each(["untyped", "server_error"] as const)("does not classify %s TOPIC_CLOSED text as a definitive closed topic", async (kind) => {
    const fetch = kind === "untyped" ? vi.fn().mockRejectedValue(new Error("TOPIC_CLOSED"))
      : vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 500,
        description: "TOPIC_CLOSED" }), { status: 500 }));
    const adapter = createTelegramTopicResumeAdapter({ token: "123:test",
      clientOptions: { fetch: fetch as ApiClientOptions["fetch"] }, forumChatId: -1001,
      registry: { listContexts: () => [] } as never, getThread: () => null });
    await expect(adapter.classifyForumTopic({ chatId: -1001, messageThreadId: 41 }, new AbortController().signal))
      .rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0]![0]).pathname.endsWith("/sendChatAction")).toBe(true);
  });

  it("shares one typed classifier and uses the dedicated retry-free reopen API", async () => {
    const thread: CodexThreadRecord = {
      id: "thread-adapter",
      title: "Adapter topic",
      cwd: "/work/telecodex",
      model: null,
      modelProvider: null,
      createdAt: new Date(1_000),
      updatedAt: new Date(2_000),
      firstUserMessage: "adapter",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: TOPIC_CLOSED",
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));
    const registry = {
      listContexts: vi.fn(() => [{ contextKey: "-1001:41", threadId: thread.id }]),
    };
    const adapter = createTelegramTopicResumeAdapter({
      token: "123:test",
      clientOptions: { fetch: fetch as ApiClientOptions["fetch"] },
      forumChatId: -1001,
      registry: registry as never,
      getThread: vi.fn(() => structuredClone(thread)),
    });
    const destination = { chatId: -1001, messageThreadId: 41 };
    const signal = new AbortController().signal;

    await expect(adapter.classifyForumTopic(destination, signal)).resolves.toBe("closed");
    await expect(adapter.classifyForumTopic(destination, signal)).resolves.toBe("closed");
    adapter.invalidateForumTopicLiveness(destination);
    await expect(adapter.reopenForumTopic(destination, signal)).resolves.toBe(true);
    await expect(adapter.classifyForumTopic(destination, signal)).resolves.toBe("unknown");

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new URL(fetch.mock.calls[0]![0]).pathname.endsWith("/sendChatAction")).toBe(true);
    expect(new URL(fetch.mock.calls[1]![0]).pathname.endsWith("/reopenForumTopic")).toBe(true);
    expect(new URL(fetch.mock.calls[2]![0]).pathname.endsWith("/sendChatAction")).toBe(true);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      chat_id: destination.chatId,
      message_thread_id: destination.messageThreadId,
    });
    expect(adapter.hasThreadTopicBinding(thread.id, destination)).toBe(true);
    expect(adapter.getThread(thread.id)).toEqual(thread);
  });
});
