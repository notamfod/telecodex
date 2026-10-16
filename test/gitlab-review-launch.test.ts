import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GitlabReviewLaunchContextError,
  GitlabReviewLaunchNotFoundError,
  GitlabReviewLaunchNotReadyError,
  GitlabReviewLaunchStore,
  renderGitlabReviewLaunchCard,
} from "../src/gitlab-review-launch.js";
import type { GitlabReviewEvent } from "../src/gitlab-review-queue.js";

describe("GitLab review manual launch store", () => {
  let directory: string;
  let statePath: string;
  let now: number;
  const target = { chatId: -100123, messageThreadId: 3861 };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-review-launch-"));
    statePath = path.join(directory, "launches.json");
    now = 1_000_000;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function event(id = "push:one"): GitlabReviewEvent {
    return {
      dedupId: id,
      projectId: 42,
      projectPath: "group/project",
      ref: "refs/heads/main",
      after: "a".repeat(40),
      receivedAt: now,
    };
  }

  async function open(overrides: Record<string, unknown> = {}) {
    const sendCard = vi.fn(async () => 501);
    const enqueue = vi.fn(async () => "accepted" as const);
    const store = await GitlabReviewLaunchStore.open({
      statePath,
      target,
      sendCard,
      enqueue,
      now: () => now,
      createRequestId: () => "1".repeat(32),
      retryBaseMs: 1_000,
      retryMaxMs: 300_000,
      autoSchedule: false,
      ...overrides,
    });
    return { store, sendCard, enqueue };
  }

  it("durably offers one card without enqueueing review until an exact click", async () => {
    const { store, sendCard, enqueue } = await open();
    await expect(store.offer(event(), { commitTitle: "fix <unsafe>", commitCount: 2, author: "A & B" }))
      .resolves.toEqual({ outcome: "accepted", requestId: "1".repeat(32) });
    expect(JSON.parse(readFileSync(statePath, "utf8")).offers).toHaveLength(1);
    expect(sendCard).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    await expect(store.runDueNotifications()).resolves.toBe(true);
    expect(sendCard).toHaveBeenCalledWith(expect.objectContaining({
      html: expect.stringContaining("fix &lt;unsafe&gt;"),
      callbackData: `greview:${"1".repeat(32)}`,
    }), target, expect.any(AbortSignal));
    expect(enqueue).not.toHaveBeenCalled();

    await expect(store.activate({ requestId: "1".repeat(32), ...target, messageId: 501 }))
      .resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      dedupId: "push:one",
      receivedAt: now,
    }));
    expect(store.feedbackOffers()).toEqual([expect.objectContaining({
      requestId: "1".repeat(32),
      dedupId: "push:one",
      messageId: 501,
      target,
    })]);
  });

  it("deduplicates repeated webhooks, cards, and clicks durably", async () => {
    const first = await open();
    await first.store.offer(event());
    await expect(first.store.offer(event())).resolves.toEqual({
      outcome: "duplicate",
      requestId: "1".repeat(32),
    });
    await first.store.runDueNotifications();
    await first.store.activate({ requestId: "1".repeat(32), ...target, messageId: 501 });
    await expect(first.store.activate({ requestId: "1".repeat(32), ...target, messageId: 501 }))
      .resolves.toBe("duplicate");
    expect(first.sendCard).toHaveBeenCalledOnce();
    expect(first.enqueue).toHaveBeenCalledOnce();
    await first.store.close();

    const second = await open({ createRequestId: () => "2".repeat(32) });
    await expect(second.store.offer(event())).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(second.store.activate({ requestId: "1".repeat(32), ...target, messageId: 501 }))
      .resolves.toBe("duplicate");
    expect(second.enqueue).not.toHaveBeenCalled();
    await second.store.close();
  });

  it("rejects unknown, premature, and mismatched activation coordinates", async () => {
    const { store } = await open();
    await store.offer(event());
    await expect(store.activate({ requestId: "2".repeat(32), ...target, messageId: 501 }))
      .rejects.toBeInstanceOf(GitlabReviewLaunchNotFoundError);
    await expect(store.activate({ requestId: "1".repeat(32), ...target, messageId: 501 }))
      .rejects.toBeInstanceOf(GitlabReviewLaunchNotReadyError);
    await store.runDueNotifications();
    for (const patch of [{ chatId: -999 }, { messageThreadId: 999 }, { messageId: 999 }]) {
      await expect(store.activate({ requestId: "1".repeat(32), ...target, messageId: 501, ...patch }))
        .rejects.toBeInstanceOf(GitlabReviewLaunchContextError);
    }
  });

  it("recovers offered notification and activating enqueue after restart", async () => {
    const sendCard = vi.fn()
      .mockRejectedValueOnce(new Error("telegram unavailable"))
      .mockResolvedValue(501);
    const first = await open({ sendCard });
    await first.store.offer(event());
    await first.store.runDueNotifications();
    expect(first.store.status()).toMatchObject({ offered: 1, nextNotifyAt: now + 1_000 });
    await first.store.close();

    now += 1_000;
    const enqueueFailure = vi.fn(async () => { throw new Error("queue unavailable"); });
    const second = await open({ sendCard, enqueue: enqueueFailure });
    await second.store.runDueNotifications();
    await expect(second.store.activate({ requestId: "1".repeat(32), ...target, messageId: 501 }))
      .rejects.toThrow("queue unavailable");
    expect(second.store.status().activating).toBe(1);
    await second.store.close();

    const enqueue = vi.fn(async () => "duplicate" as const);
    const third = await open({ sendCard, enqueue });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(third.store.status().activated).toBe(1);
    await third.store.close();
  });

  it("holds the writer lock until an activation enqueue finishes during close", async () => {
    let releaseEnqueue!: () => void;
    const enqueueGate = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
    const enqueue = vi.fn(async () => {
      await enqueueGate;
      return "accepted" as const;
    });
    const first = await open({ enqueue });
    await first.store.offer(event());
    await first.store.runDueNotifications();

    const activation = first.store.activate({ requestId: "1".repeat(32), ...target, messageId: 501 });
    await Promise.resolve();
    let closed = false;
    const closing = first.store.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    await expect(open()).rejects.toThrow("active writer");

    releaseEnqueue();
    await expect(activation).resolves.toBe("accepted");
    await closing;
    const reopened = await open();
    await reopened.store.close();
  });

  it("retries without restart after persisting notification backoff temporarily fails", async () => {
    const savedPath = `${statePath}.saved`;
    const sendCard = vi.fn()
      .mockImplementationOnce(async () => {
        renameSync(statePath, savedPath);
        mkdirSync(statePath);
        throw new Error("telegram unavailable");
      })
      .mockResolvedValue(501);
    const { store } = await open({ sendCard });
    await store.offer(event());
    await expect(store.runDueNotifications()).rejects.toThrow();
    expect(store.status()).toMatchObject({ offered: 1, nextNotifyAt: now + 1_000 });

    rmSync(statePath, { recursive: true });
    renameSync(savedPath, statePath);
    now += 1_000;
    await expect(store.runDueNotifications()).resolves.toBe(true);
    expect(store.status()).toMatchObject({ offered: 0, notified: 1 });
    expect(sendCard).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it("rolls back an offer when atomic persistence fails", async () => {
    const { store } = await open();
    await store.offer(event("push:first"));
    const savedPath = `${statePath}.saved`;
    renameSync(statePath, savedPath);
    mkdirSync(statePath);

    await expect(store.offer(event("push:second"))).rejects.toThrow();
    expect(store.status().total).toBe(1);

    rmSync(statePath, { recursive: true });
    renameSync(savedPath, statePath);
    await store.close();
  });

  it("fails closed on malformed or unbounded persisted offers", async () => {
    writeFileSync(statePath, JSON.stringify({ version: 1, offers: [{ summary: { author: "x".repeat(10_000) } }] }));
    await expect(open()).rejects.toThrow("state is invalid");
  });

  it("escapes and bounds every optional card field", () => {
    const card = renderGitlabReviewLaunchCard(event(), {
      commitTitle: "<&>".repeat(100),
      author: "&".repeat(100),
      commitCount: 999,
    }, "f".repeat(32));
    expect(card.html).toContain("&lt;&amp;&gt;");
    expect(card.html).not.toContain("<&>");
    expect(card.html.length).toBeLessThan(1024);
    expect(card.callbackData).toBe(`greview:${"f".repeat(32)}`);
  });
});
