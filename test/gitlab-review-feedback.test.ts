import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitlabReviewFeedbackStore } from "../src/gitlab-review-feedback.js";
import type { GitlabReviewFeedback } from "../src/gitlab-review-queue.js";

describe("GitLab review card feedback", () => {
  let directory: string;
  let statePath: string;
  let now: number;
  let phase: GitlabReviewFeedback | undefined;

  const offer = {
    requestId: "1".repeat(32),
    dedupId: "push:one",
    event: {
      dedupId: "push:one",
      projectId: 42,
      projectPath: "group/project",
      ref: "refs/heads/main" as const,
      after: "a".repeat(40),
      receivedAt: 1_000_000,
    },
    summary: { commitTitle: "safe <title>" },
    target: { chatId: -100123, messageThreadId: 3861 },
    messageId: 501,
  };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-review-feedback-"));
    statePath = path.join(directory, "feedback.json");
    now = 1_000_000;
    phase = { phase: "queued" };
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function open(editCard = vi.fn(async () => undefined)) {
    const store = await GitlabReviewFeedbackStore.open({
      statePath,
      listOffers: () => [offer],
      feedbackFor: () => phase,
      editCard,
      now: () => now,
      retryBaseMs: 1_000,
      autoSchedule: false,
    });
    return { store, editCard };
  }

  it("edits only the original card through queued, running, and exact completion states", async () => {
    const { store, editCard } = await open();
    await store.runDue();
    expect(editCard).toHaveBeenLastCalledWith(
      offer,
      expect.stringContaining("⏳ Ревью поставлено в очередь"),
      expect.any(AbortSignal),
    );

    phase = { phase: "running" };
    await store.runDue();
    expect(editCard).toHaveBeenLastCalledWith(
      offer,
      expect.stringContaining("🔄 Ревью выполняется"),
      expect.any(AbortSignal),
    );

    phase = { phase: "completed", result: { outcome: "reviewed", findings: 0, freshFindings: 0 } };
    await store.runDue();
    expect(editCard).toHaveBeenLastCalledWith(
      offer,
      expect.stringContaining("проблем не найдено"),
      expect.any(AbortSignal),
    );
    expect(editCard.mock.calls.at(-1)?.[1]).toContain("safe &lt;title&gt;");
    expect(editCard).toHaveBeenCalledTimes(3);
    await store.close();

    const restarted = await open(editCard);
    await restarted.store.runDue();
    expect(editCard).toHaveBeenCalledTimes(3);
    await restarted.store.close();
  });

  it("distinguishes unchanged, fresh findings, duplicates, retry, and legacy completion", async () => {
    const cases: Array<[GitlabReviewFeedback, string]> = [
      [{ phase: "retrying" }, "повтор запланирован"],
      [{ phase: "completed", result: { outcome: "unchanged" } }, "новых изменений нет"],
      [{ phase: "completed", result: { outcome: "reviewed", findings: 3, freshFindings: 2 } }, "новых замечаний: 2"],
      [{ phase: "completed", result: { outcome: "reviewed", findings: 3, freshFindings: 0 } }, "новых замечаний нет"],
      [{ phase: "completed" }, "Ревью завершено"],
    ];
    const { store, editCard } = await open();
    for (const [next, expected] of cases) {
      phase = next;
      await store.runDue();
      expect(editCard.mock.calls.at(-1)?.[1]).toContain(expected);
    }
    await store.close();
  });

  it("adds a short escaped AI summary, survives restart, and refreshes changed detail text", async () => {
    const detail = { baseSha: "a".repeat(40), headSha: "b".repeat(40), items: [
      { priority: "P1" as const, file: "src/auth.ts", line: 7, description: "Unchecked <user> input" },
      { priority: "P2" as const, file: "src/x.ts", line: 9, description: "Missing retry" },
      { priority: "P3" as const, file: "src/y.ts", description: "third finding" },
    ] };
    phase = { phase: "completed", result: { outcome: "reviewed", findings: 3, freshFindings: 3, details: detail } };
    const { store, editCard } = await open();
    await store.runDue();
    expect(editCard.mock.calls.at(-1)?.[1]).toContain("[P1] src/auth.ts:7");
    expect(editCard.mock.calls.at(-1)?.[1]).toContain("Unchecked &lt;user&gt; input");
    expect(editCard.mock.calls.at(-1)?.[1]).not.toContain("third finding");
    await store.close();
    const resumed = await open(editCard);
    await resumed.store.runDue();
    expect(editCard).toHaveBeenCalledOnce();
    phase = { phase: "completed", result: { outcome: "reviewed", findings: 3, freshFindings: 3,
      details: { ...detail, items: [{ ...detail.items[0], description: "Updated" }] } } };
    await resumed.store.runDue();
    expect(editCard).toHaveBeenCalledTimes(2);
    expect(editCard.mock.calls.at(-1)?.[1]).toContain("Updated");
    await resumed.store.close();
  });

  it("retries Telegram failure without changing a completed queue outcome", async () => {
    phase = { phase: "completed", result: { outcome: "unchanged" } };
    const editCard = vi.fn()
      .mockRejectedValueOnce(new Error("telegram secret response"))
      .mockResolvedValue(undefined);
    const { store } = await open(editCard);
    await expect(store.runDue()).resolves.toBe(true);
    expect(store.status()).toMatchObject({ pending: 1, nextAttemptAt: now + 1_000 });

    now += 1_000;
    await store.runDue();
    expect(editCard).toHaveBeenCalledTimes(2);
    expect(store.status()).toMatchObject({ pending: 0 });
    await store.close();
  });

  it("retries an idempotent edit after completion persistence temporarily fails", async () => {
    phase = { phase: "completed", result: { outcome: "unchanged" } };
    const savedPath = `${statePath}.saved`;
    const editCard = vi.fn()
      .mockImplementationOnce(async () => {
        renameSync(statePath, savedPath);
        mkdirSync(statePath);
      })
      .mockResolvedValue(undefined);
    const { store } = await open(editCard);
    await expect(store.runDue()).rejects.toThrow();
    expect(store.status()).toMatchObject({ pending: 1, nextAttemptAt: now + 1_000 });

    rmSync(statePath, { recursive: true });
    renameSync(savedPath, statePath);
    now += 1_000;
    await store.runDue();
    expect(editCard).toHaveBeenCalledTimes(2);
    expect(store.status().pending).toBe(0);
    await store.close();
  });

  it("prunes feedback whose launch offer was already evicted", async () => {
    writeFileSync(statePath, JSON.stringify({ version: 1, entries: [{
      requestId: "2".repeat(32),
      desired: "completed",
      delivered: "completed",
      status: "idle",
      nextAttemptAt: null,
      attempt: 0,
      updatedAt: now - 1,
    }] }));
    const { store } = await open();
    await store.runDue();
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.entries.map((entry: { requestId: string }) => entry.requestId))
      .toEqual([offer.requestId]);
    await store.close();
  });

  it("continues with other cards while a timed-out edit waits for retry", async () => {
    const second = {
      ...offer,
      requestId: "2".repeat(32),
      dedupId: "push:two",
      event: { ...offer.event, dedupId: "push:two", after: "b".repeat(40) },
      messageId: 502,
    };
    const calls: string[] = [];
    const editCard = vi.fn(async (candidate: typeof offer) => {
      calls.push(candidate.requestId);
      if (candidate.requestId === offer.requestId && calls.length === 1) throw new Error("timeout");
    });
    const store = await GitlabReviewFeedbackStore.open({
      statePath,
      listOffers: () => [offer, second],
      feedbackFor: () => ({ phase: "queued" }),
      editCard,
      now: () => now,
      retryBaseMs: 1_000,
      autoSchedule: false,
    });
    await store.runDue();
    await store.runDue();
    expect(calls).toEqual([offer.requestId, second.requestId]);
    now += 1_000;
    await store.runDue();
    expect(calls).toEqual([offer.requestId, second.requestId, offer.requestId]);
    await store.close();
  });
});
