import { vi } from "vitest";

import type { CodexThreadRecord } from "../src/codex-state.js";
import { createTelegramTopicRecoveryAdapter }
  from "../src/telegram-topic-recovery-adapter.js";

describe("Telegram topic recovery adapter", () => {
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

  it("does not compose adapters while recovery is disabled", () => {
    const harness = createHarness();

    const adapter = createTelegramTopicRecoveryAdapter({
      ...harness.options,
      enabled: false,
    });

    expect(adapter).toBeUndefined();
    expect(harness.api.createForumTopic).not.toHaveBeenCalled();
  });

  it("composes abortable Telegram and registry adapters when enabled", async () => {
    const harness = createHarness();
    const adapter = createTelegramTopicRecoveryAdapter(harness.options)!;
    const destination = { chatId: -1001, messageThreadId: 41 };
    const signal = new AbortController().signal;

    expect(adapter.hasThreadTopicBinding(thread.id, destination)).toBe(true);
    await expect(adapter.probeForumTopic(destination, signal)).resolves.toBe(true);
    await expect(adapter.createForumTopic({
      chatId: destination.chatId,
      topicName: "Replacement",
      signal,
    })).resolves.toEqual({ chatId: destination.chatId, messageThreadId: 99 });
    await adapter.sendWelcome(destination, "A <safe> topic", signal);
    adapter.rebindThreadTopic("old-context", "new-context", thread);

    expect(harness.api.sendChatAction).toHaveBeenCalledWith(
      destination.chatId,
      "typing",
      { message_thread_id: destination.messageThreadId },
      expect.any(AbortSignal),
    );
    expect(harness.api).not.toHaveProperty("reopenForumTopic");
    expect(harness.api).not.toHaveProperty("closeForumTopic");
    expect(harness.api.createForumTopic).toHaveBeenCalledWith(
      destination.chatId, "Replacement", {}, signal,
    );
    expect(harness.api.sendMessage).toHaveBeenCalledWith(
      destination.chatId,
      expect.stringContaining("A &lt;safe&gt; topic"),
      expect.objectContaining({ message_thread_id: destination.messageThreadId }),
      signal,
    );
    expect(harness.registry.rebindThreadTopic).toHaveBeenCalledWith(
      "old-context", "new-context", thread,
    );
    expect(adapter.getThread(thread.id)).toEqual(thread);
    expect(adapter.reportReason).toBe(harness.reportReason);
  });

  function createHarness() {
    const api = {
      sendChatAction: vi.fn(async () => true),
      createForumTopic: vi.fn(async () => ({ message_thread_id: 99 })),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    };
    const registry = {
      listContexts: vi.fn(() => [{ contextKey: "-1001:41", threadId: thread.id }]),
      rebindThreadTopic: vi.fn(),
    };
    const reportReason = vi.fn();
    return {
      api,
      registry,
      reportReason,
      options: {
        enabled: true,
        forumChatId: -1001,
        creationTimeoutMs: 1_000,
        api: api as never,
        registry: registry as never,
        getThread: vi.fn(() => structuredClone(thread)),
        reportReason,
      },
    };
  }
});
