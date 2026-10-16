import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handleGitlabPipelineCallback } from "../src/bot-gitlab-review.js";
import { GitlabReviewSelection } from "../src/gitlab-review-selection.js";

it("launches all selected notification messages and retains only failed selections", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-batch-"));
  const selection = new GitlabReviewSelection(path.join(dir, "db.sqlite"));
  const target = { chatId: -1001, messageThreadId: 7 };
  const a = { requestId: "a".repeat(32), ...target, messageId: 10 };
  const b = { requestId: "b".repeat(32), ...target, messageId: 11 };
  const activate = vi.fn().mockResolvedValueOnce("accepted").mockRejectedValueOnce(new Error("private"));
  const ctx = { from: { id: 42 }, chat: { id: -1001 }, callbackQuery: {
    data: `gpipeline:${a.requestId}`, message: { message_id: 10, message_thread_id: 7 },
  }, answerCallbackQuery: vi.fn(async () => true), reply: vi.fn(async () => ({})),
  editMessageReplyMarkup: vi.fn(async () => true) } as unknown as Context;
  try {
    selection.toggle(42, a); selection.toggle(42, b);
    await handleGitlabPipelineCallback(ctx, new Set([42]), {
      selection, loadTarget: async () => target, activate,
    });
    expect(activate.mock.calls.map((args) => args[0])).toEqual([a, b]);
    expect(selection.list(42, -1001, 7)).toEqual([b]);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("1"), expect.anything());
    expect(JSON.stringify((ctx.reply as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("private");
  } finally { selection.close(); rmSync(dir, { recursive: true, force: true }); }
});
