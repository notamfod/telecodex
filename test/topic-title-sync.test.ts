import { describe, expect, it, vi } from "vitest";
import type { ContextMetadata } from "../src/session-registry.js";
import { TopicTitleSynchronizer } from "../src/topic-title-sync.js";

function harness() {
  const metadata: ContextMetadata = { contextKey: "-1001:42", workspace: "/work/mircli", threadId: "thread-1", topicName: "MIR-7 Проверить оплату", updatedAt: 0 };
  const request = vi.fn(async () => ({}));
  const edit = vi.fn(async () => {});
  const registry = {
    listContexts: () => [metadata],
    setTopicNameDurably: vi.fn((_key: string, name: string) => { metadata.topicName = name; }),
    getAppServerClient: () => ({ request }),
  };
  const options = { registry: registry as never, edit, eligible: () => true, title: (meta: ContextMetadata) => meta.topicName, report: vi.fn() };
  return { metadata, registry, request, edit, options, sync: new TopicTitleSynchronizer(options) };
}

describe("TopicTitleSynchronizer", () => {
  it("gives Telegram and Codex exactly the same name and avoids repeated writes", async () => {
    const h = harness();
    await h.sync.reconcile();
    const name = "🔎 [mircli] MIR-7 · Проверить оплату";
    expect(h.metadata.topicName).toBe(name);
    expect(h.edit).toHaveBeenCalledWith("-1001:42", name);
    expect(h.request).toHaveBeenCalledWith("thread/name/set", { threadId: "thread-1", name }, expect.anything());
    await h.sync.reconcile();
    expect(h.edit).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("restores a canonical Telegram name even if an external edit normalizes to the cached name", async () => {
    const h = harness();
    await h.sync.reconcile();
    await h.sync.rename("-1001:42", "MIR-7 Проверить оплату");
    expect(h.edit).toHaveBeenCalledTimes(2);
    expect(h.edit).toHaveBeenLastCalledWith("-1001:42", "🔎 [mircli] MIR-7 · Проверить оплату");
  });

  it("bounds background batches and eventually reaches every topic", async () => {
    const h = harness();
    const contexts = Array.from({ length: 12 }, (_, i) => ({ ...h.metadata, contextKey: `-1001:${i + 2}`, threadId: null }));
    h.registry.listContexts = () => contexts;
    h.registry.setTopicNameDurably.mockImplementation((key, name) => { contexts.find(meta => meta.contextKey === key)!.topicName = name; });
    await h.sync.reconcile();
    expect(h.edit).toHaveBeenCalledTimes(10);
    await h.sync.reconcile();
    expect(h.edit).toHaveBeenCalledTimes(12);
    await h.sync.dispose();
    await h.sync.rename("-1001:2", "Ignored after shutdown");
    expect(h.edit).toHaveBeenCalledTimes(12);
  });

  it("keeps a failed Codex rename retryable after restart without reverting the title", async () => {
    const h = harness();
    h.request.mockRejectedValueOnce(new Error("offline"));
    await h.sync.rename("-1001:42", "Исправить оплату", "MIR-7");
    const name = h.metadata.topicName;
    const restarted = new TopicTitleSynchronizer(h.options);
    await restarted.reconcile();
    expect(h.request).toHaveBeenLastCalledWith("thread/name/set", { threadId: "thread-1", name }, expect.anything());
    expect(name).toBe("🛠 [mircli] MIR-7 · Исправить оплату");
  });

  it("retries Telegram failure and applies a saved name to a newly bound thread", async () => {
    const h = harness();
    h.metadata.threadId = null;
    h.edit.mockRejectedValueOnce(new Error("offline"));
    await expect(h.sync.rename("-1001:42", "Проверить оплату")).rejects.toThrow("offline");
    await h.sync.reconcile();
    expect(h.request).not.toHaveBeenCalled();
    h.metadata.threadId = "thread-new";
    await h.sync.reconcile();
    expect(h.request).toHaveBeenLastCalledWith("thread/name/set", { threadId: "thread-new", name: h.metadata.topicName }, expect.anything());
  });

  it("serializes renames so a late automatic response cannot overwrite a newer name", async () => {
    const h = harness();
    let finish!: () => void;
    h.edit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = h.sync.rename("-1001:42", "Первое");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = h.sync.rename("-1001:42", "Второе");
    finish();
    await Promise.all([first, second]);
    expect(h.metadata.topicName).toBe("💬 [mircli] · Второе");
    expect(h.request.mock.calls.at(-1)?.[1]).toEqual({ threadId: "thread-1", name: h.metadata.topicName });
  });
});
