import { basename } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexThreadRecord } from "../src/codex-state.js";
import { buildTopicName, TopicSynchronizer } from "../src/topic-sync.js";

function thread(overrides: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  return {
    id: "019fda52-f2ec-7801-ba9c-8761cc89bae4",
    title: "Investigate Telegram integration",
    cwd: "/srv/projects/storefront",
    model: "gpt-5.6-sol",
    createdAt: new Date(10_000),
    updatedAt: new Date(20_000),
    firstUserMessage: "Investigate Telegram integration",
    ...overrides,
  };
}

describe("buildTopicName", () => {
  it("uses the workspace basename and a normalized title", () => {
    const value = buildTopicName(thread({ title: "  Multi-line\n\n title  " }));

    expect(value).toBe(`${basename("/srv/projects/storefront")} · Multi-line title`);
  });

  it("does not expose Telegram bot tokens in topic names", () => {
    const value = buildTopicName(
      thread({ title: "Configure bot 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi" }),
    );

    expect(value).toBe("storefront · Session 019fda52");
    expect(value).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("does not expose suspicious workspace directory names", () => {
    const value = buildTopicName(
      thread({
        cwd: "/root/Documents/Codex/8603016081-aafkgoyncrfhv9yjcln8mifaff-uyqbb6vu",
        title: "Configure bot 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi",
      }),
    );

    expect(value).toBe("Codex · Session 019fda52");
    expect(value).not.toContain("8603016081");
  });

  it("limits topic names to 128 Unicode characters", () => {
    const value = buildTopicName(thread({ title: "я".repeat(200) }));

    expect([...value]).toHaveLength(128);
  });
});

describe("TopicSynchronizer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates and binds topics only for unbound user threads", async () => {
    const first = thread({ id: "thread-1", title: "First" });
    const second = thread({ id: "thread-2", title: "Second" });
    const bound = new Set(["thread-1"]);
    const bindThread = vi.fn((contextKey: string, item: CodexThreadRecord) => bound.add(item.id));
    const createForumTopic = vi.fn().mockResolvedValue({ message_thread_id: 42 });
    const synchronizer = new TopicSynchronizer({
      chatId: -100123,
      intervalMs: 30_000,
      listUserThreads: () => [first, second],
      registry: {
        isThreadBoundInChat: (threadId) => bound.has(threadId),
        bindThread,
      },
      createForumTopic,
    });

    const result = await synchronizer.syncOnce();

    expect(result).toEqual({ created: 1, skipped: 1, failed: 0 });
    expect(createForumTopic).toHaveBeenCalledWith(-100123, "storefront · Second");
    expect(bindThread).toHaveBeenCalledWith("-100123:42", second);
  });

  it("continues after one topic creation fails", async () => {
    const warn = vi.fn();
    const bindThread = vi.fn();
    const createForumTopic = vi
      .fn()
      .mockRejectedValueOnce(new Error("Telegram unavailable"))
      .mockResolvedValueOnce({ message_thread_id: 44 });
    const synchronizer = new TopicSynchronizer({
      chatId: -100123,
      intervalMs: 30_000,
      listUserThreads: () => [thread({ id: "thread-1" }), thread({ id: "thread-2" })],
      registry: { isThreadBoundInChat: () => false, bindThread },
      createForumTopic,
      logger: { info: vi.fn(), warn },
    });

    const result = await synchronizer.syncOnce();

    expect(result).toEqual({ created: 1, skipped: 0, failed: 1 });
    expect(bindThread).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("thread-1"));
  });

  it("runs immediately and then on the configured interval", async () => {
    vi.useFakeTimers();
    const listUserThreads = vi.fn(() => []);
    const synchronizer = new TopicSynchronizer({
      chatId: -100123,
      intervalMs: 5_000,
      listUserThreads,
      registry: { isThreadBoundInChat: () => false, bindThread: vi.fn() },
      createForumTopic: vi.fn(),
    });

    synchronizer.start();
    await vi.runAllTicks();
    expect(listUserThreads).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(listUserThreads).toHaveBeenCalledTimes(2);

    synchronizer.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listUserThreads).toHaveBeenCalledTimes(2);
  });
});
