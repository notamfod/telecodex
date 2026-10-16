import { describe, expect, it, vi } from "vitest";

import { ReviewPipelineJournalSessionClient } from "../src/review-pipeline-journal-session.js";

function harness() {
  const client = {
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(),
  };
  const turnManager = {
    runTurn: vi.fn(async (request: { callbacks: { beforeDispatchWrite?: () => void } }) => {
      request.callbacks.beforeDispatchWrite?.();
    }),
    cancelTurn: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const journal = new ReviewPipelineJournalSessionClient({ client, turnManager } as never);
  return { client, turnManager, journal };
}

describe("ReviewPipelineJournalSessionClient", () => {
  it("creates a durable read-only journal, saves its id before naming it", async () => {
    const h = harness();
    h.client.request
      .mockResolvedValueOnce({ thread: { id: "journal-thread", status: { type: "idle" } } })
      .mockResolvedValueOnce({});
    const created = vi.fn();

    await expect(h.journal.create("🔎 review batch", "/workspace/review", "gpt-5.6-luna", created))
      .resolves.toBe("journal-thread");

    expect(created).toHaveBeenCalledWith("journal-thread");
    expect(h.client.request).toHaveBeenNthCalledWith(1, "thread/start", expect.objectContaining({
      cwd: "/workspace/review",
      model: "gpt-5.6-luna",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      serviceName: "telecodex-review-pipeline",
      developerInstructions: expect.stringContaining("journal"),
    }));
    expect(h.client.request).toHaveBeenNthCalledWith(2, "thread/name/set", {
      threadId: "journal-thread",
      name: "🔎 review batch",
    });
  });

  it("keeps the known id when thread naming fails", async () => {
    const h = harness();
    h.client.request
      .mockResolvedValueOnce({ thread: { id: "journal-thread", status: { type: "idle" } } })
      .mockRejectedValueOnce(new Error("name unavailable"));
    const created = vi.fn();

    await expect(h.journal.create("review batch", "/workspace/review", "luna", created))
      .resolves.toBe("journal-thread");
    expect(created).toHaveBeenCalledWith("journal-thread");
  });

  it("inspects busy state and only markers from actual user-message content", async () => {
    const h = harness();
    h.client.request.mockResolvedValue({
      thread: {
        id: "journal-thread",
        status: { type: "active" },
        turns: [{ items: [
          { type: "userMessage", content: [{ type: "text", text: "[review-pipeline-journal:batch:1] started" }] },
          { type: "agentMessage", text: "[review-pipeline-journal:spoof]" },
          { type: "userMessage", content: [{ type: "text", text: "ignored [review-pipeline-journal:batch.2]" }] },
        ] }],
      },
    });

    await expect(h.journal.inspect("journal-thread")).resolves.toEqual({
      busy: true,
      markers: ["batch:1", "batch.2"],
    });
    expect(h.client.request).toHaveBeenCalledWith("thread/read", {
      threadId: "journal-thread",
      includeTurns: true,
    });
  });

  it("rejects malformed busy status instead of treating it as idle", async () => {
    const h = harness();
    h.client.request.mockResolvedValue({
      thread: { id: "journal-thread", status: { type: "unknown" }, turns: [] },
    });

    await expect(h.journal.inspect("journal-thread")).rejects.toThrow("Invalid journal thread status");
  });

  it("restores a journal title after an append overwrites it", async () => {
    const h = harness();

    await h.journal.setTitle("journal-thread", "🔎 review batch");

    expect(h.client.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "journal-thread",
      name: "🔎 review batch",
    });
  });

  it("writes a marked read-only turn through the durability barrier", async () => {
    const h = harness();
    const written = vi.fn();

    await h.journal.append("journal-thread", "/workspace/review", "luna", "batch:1", "Found one P2", written);

    expect(written).toHaveBeenCalledOnce();
    expect(h.turnManager.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "journal-thread",
      cwd: "/workspace/review",
      model: "luna",
      approvalPolicy: "never",
      sandbox: "read-only",
      reasoningEffort: "low",
      input: [{ type: "text", text: expect.stringContaining("[review-pipeline-journal:batch:1]"), text_elements: [] }],
    }));
  });

  it("cancels only its own active callback and leaves injected shared dependencies open", async () => {
    const h = harness();
    let release!: () => void;
    h.turnManager.runTurn.mockImplementationOnce(async (request: { callbacks: { beforeDispatchWrite?: () => void } }) => {
      request.callbacks.beforeDispatchWrite?.();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const append = h.journal.append("journal-thread", "/workspace/review", "luna", "batch:1", "Started", vi.fn());
    await vi.waitFor(() => expect(h.turnManager.runTurn).toHaveBeenCalledOnce());

    await h.journal.dispose();

    expect(h.turnManager.cancelTurn).toHaveBeenCalledWith("journal-thread", expect.anything());
    expect(h.turnManager.dispose).not.toHaveBeenCalled();
    expect(h.client.close).not.toHaveBeenCalled();
    release();
    await append;
  });
});
