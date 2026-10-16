import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { registerReviewPipelineHandlers } from "../src/bot-review-pipeline.js";
import { ReviewPipelineStore } from "../src/review-pipeline-store.js";

it("opens analysis once for the exact approved card and rejects another message", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tc-card-"));
  const previous = process.env.REVIEW_PIPELINE_DB;
  process.env.REVIEW_PIPELINE_DB = path.join(directory, "db.sqlite");
  const store = new ReviewPipelineStore(process.env.REVIEW_PIPELINE_DB);
  try {
    const job = store.enqueue({ recipe: "daily", project: "mir-admin", cwd: "/repo", headSha: "a".repeat(40),
      finding: { severity: "medium", file: "x.ts", category: "race", description: "late answer" } });
    store.claim();
    const report = { verdict: "confirmed" as const, reason: "late answer", evidence: ["x.ts:1"], draft: {
      summary: "[Frontend]: Останавливать опрос", priority: "Medium" as const, problem: "Опрос продолжается",
      fix: "Проверять активность", benefit: "Нет лишних запросов", acceptance: ["Опрос прекращается"],
    } };
    store.finishRound(job.id, report, report);
    store.markDelivered(job.id, -1001, 7, 10);
    let callback!: (ctx: Context) => Promise<void>;
    const bot = { callbackQuery: (_pattern: RegExp, handler: (ctx: Context) => Promise<void>) => { callback = handler; } };
    const open = vi.fn(async () => 12);
    registerReviewPipelineHandlers(bot as never, { telegramAllowedUserIdSet: new Set([42]),
      jiraPanel: { chatId: -1001, topicId: 7 } } as never, open);
    const ctx = { from: { id: 42 }, chat: { id: -1001 }, callbackQuery: {
      data: `rpcontinue:${job.id}`, message: { message_id: 10, message_thread_id: 7 },
    }, answerCallbackQuery: vi.fn(async () => true), reply: vi.fn(async () => ({})),
    editMessageText: vi.fn(async () => true) } as unknown as Context;
    await callback(ctx);
    await callback(ctx);
    expect(open).toHaveBeenCalledOnce();
    expect(store.get(job.id)).toMatchObject({ status: "continuing", analysisTopicId: 12 });
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("https://t.me/c/1/12"), expect.anything());
    const other = { ...ctx, callbackQuery: { data: `rpcontinue:${job.id}`,
      message: { message_id: 11, message_thread_id: 7 } } } as unknown as Context;
    await callback(other);
    expect(open).toHaveBeenCalledOnce();
  } finally {
    store.close();
    if (previous === undefined) delete process.env.REVIEW_PIPELINE_DB; else process.env.REVIEW_PIPELINE_DB = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
