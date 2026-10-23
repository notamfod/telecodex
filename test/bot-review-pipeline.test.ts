import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { registerReviewPipelineHandlers, startReviewPipelineWorker } from "../src/bot-review-pipeline.js";
import { ReviewPipelineStore } from "../src/review-pipeline-store.js";

it("disables the worker once with a clear warning when the label catalog has no Jira credentials", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(startReviewPipelineWorker({ jiraPanel: { chatId: -1001, topicId: 7 } } as never, {} as never)).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("JIRA_COMMENT_SERVER"));
  } finally { warning.mockRestore(); }
});

it.each([false, true])("opens analysis once for the exact approved card and rejects another message (needs context: %s)", async (needsContext) => {
  const directory = mkdtempSync(path.join(tmpdir(), "tc-card-"));
  const previous = process.env.REVIEW_PIPELINE_DB;
  process.env.REVIEW_PIPELINE_DB = path.join(directory, "db.sqlite");
  const store = new ReviewPipelineStore(process.env.REVIEW_PIPELINE_DB);
  try {
    const job = store.enqueue({ recipe: "daily", project: "mir-admin", cwd: "/repo", headSha: "a".repeat(40),
      finding: { severity: "medium", file: "x.ts", category: "race", description: "late answer" } });
    store.claim();
    const report = { verdict: "confirmed" as const, assessment: { component: "Backend", labels: ["поиск"], kind: "bug" as const, basis: "Cancellation contract is violated.", trigger: "Cancel an active request.", expected: "Work stops.", actual: "Work continues." }, reason: "late answer", evidence: ["x.ts:1"], draft: {
      summary: "[Frontend]: Останавливать опрос", priority: "Medium" as const, problem: "Опрос продолжается",
      fix: "Проверять активность", benefit: "Нет лишних запросов", acceptance: ["Опрос прекращается"],
    } };
    store.finishRound(job.id, report, report);
    store.markDelivered(job.id, -1001, 7, 10);
    if (needsContext) {
      const uncertain = { verdict: "uncertain" as const, reason: "The runtime trigger is not established.", evidence: ["x.ts:1"] };
      store.reassessAwaiting(job.id, uncertain, uncertain, 10);
      expect(store.get(job.id)?.status).toBe("needs_context");
      expect(store.get(job.id)?.draft).toBeUndefined();
    }
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
    if (needsContext) {
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("Тип и компонент:</b> не подтверждены"), expect.anything());
    }
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

it("reports a database-open failure to the user instead of leaving a silent create button", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-card-open-"));
  const previous = process.env.REVIEW_PIPELINE_DB;
  const blocked = path.join(dir, "blocked"); writeFileSync(blocked, "not a directory");
  process.env.REVIEW_PIPELINE_DB = path.join(blocked, "db.sqlite");
  try {
    let callback!: (ctx: Context) => Promise<void>;
    registerReviewPipelineHandlers({ callbackQuery: (_pattern: RegExp, handler: typeof callback) => { callback = handler; } } as never,
      { telegramAllowedUserIdSet: new Set([42]), jiraPanel: { chatId: -1001, topicId: 7 } } as never,
      async () => 12);
    const ctx = { from: { id: 42 }, chat: { id: -1001 }, callbackQuery: { data: `rpcreate:${"a".repeat(24)}`,
      message: { message_id: 10, message_thread_id: 7 } }, answerCallbackQuery: vi.fn(async () => true),
      reply: vi.fn(async () => ({})), editMessageText: vi.fn(async () => true) } as unknown as Context;
    await expect(callback(ctx)).resolves.toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("не отправлялась"), { message_thread_id: 7 });
  } finally {
    if (previous === undefined) delete process.env.REVIEW_PIPELINE_DB; else process.env.REVIEW_PIPELINE_DB = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
