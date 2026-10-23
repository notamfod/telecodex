import type { Api, Bot, Context } from "grammy";
import type { TeleCodexConfig } from "./config.js";
import { escapeHTML } from "./format.js";
import { JiraIssueCreateClient } from "./jira-issue-create.js";
import { ReviewPipelineActions } from "./review-pipeline-actions.js";
import { reviewPipelineDbPath, reviewPipelineProgressDbPath } from "./review-pipeline-path.js";
import { ReviewPipelineRuntime } from "./review-pipeline-runtime.js";
import { pipelineDraftKeyboard, renderPipelineDraft } from "./review-pipeline-render.js";
import { getConfirmedAssessment, ReviewPipelineStore, type PipelineJob } from "./review-pipeline-store.js";
import { acquireRecipeRunLock } from "./recipe-run-lock.js";
import { topicUrl } from "./projects.js";
import { ReviewPipelineProgressStore } from "./review-pipeline-progress-store.js";
import { ReviewPipelineProgressRuntime } from "./review-pipeline-progress.js";
import { ReviewPipelineJournalStore } from "./review-pipeline-journal-store.js";
import { ReviewPipelineJournalSessionClient } from "./review-pipeline-journal-session.js";
import { ReviewPipelineJournalRuntime } from "./review-pipeline-journal.js";
import { resolveAvailablePipelineModel } from "./review-pipeline-agent.js";
import { buildCodexThreadKeyboard } from "./thread-links.js";

const CALLBACK = /^(rpcreate|rpcontinue):([a-f0-9]{24})$/;
const active = new Map<string, Promise<void>>();

export function registerReviewPipelineHandlers(
  bot: Pick<Bot<Context>, "callbackQuery">,
  config: TeleCodexConfig,
  openAnalysis: (ctx: Context, job: PipelineJob) => Promise<number>,
): void {
  bot.callbackQuery(CALLBACK, async (ctx) => {
    const match = CALLBACK.exec(ctx.callbackQuery?.data ?? "");
    const message = ctx.callbackQuery?.message;
    const topicId = message && "message_thread_id" in message ? message.message_thread_id : undefined;
    const panel = config.jiraPanel;
    if (!match || !ctx.from || !config.telegramAllowedUserIdSet.has(ctx.from.id) || !panel || !ctx.chat
      || ctx.chat.id !== panel.chatId || topicId !== panel.topicId || !message) {
      await ctx.answerCallbackQuery({ text: "Кнопка недоступна", show_alert: true }); return;
    }
    if (active.has(match[2])) { await ctx.answerCallbackQuery({ text: "Решение уже обрабатывается" }); return; }
    await ctx.answerCallbackQuery({ text: match[1] === "rpcreate" ? "Создаю задачу..." : "Продолжаю анализ..." });
    const operation = (async () => {
      let store: ReviewPipelineStore | undefined;
      try {
        store = new ReviewPipelineStore(reviewPipelineDbPath());
        const actions = new ReviewPipelineActions({ store,
          ...(config.jiraComment ? { jira: new JiraIssueCreateClient(config.jiraComment) } : {}),
          openAnalysis: (job) => openAnalysis(ctx, job) });
        const result = await actions.decide(match[2], match[1] === "rpcreate" ? "create" : "continue", {
          chatId: panel.chatId, topicId: panel.topicId, messageId: message.message_id,
        });
        const job = result.job;
        if (job && (result.outcome === "created" || result.outcome === "continuing")) {
          const suffix = result.outcome === "created"
            ? `Создана задача: <a href="${escapeHTML(job.issueUrl!)}">${escapeHTML(job.issueKey!)}</a>`
            : `Анализ запущен: <a href="${topicUrl(panel.chatId, job.analysisTopicId!)}">открыть топик</a>`;
          await ctx.editMessageText(`${renderPipelineDraft(job)}\n\n${suffix}`, {
            parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] },
          }).catch(() => undefined);
        } else {
          const text = result.outcome === "unknown"
            ? "Результат создания пока не подтверждён. Повторное нажатие проверит Jira и не создаст дубль."
            : result.outcome === "needs_review"
            ? "Тип задачи, компонент и функциональные метки ещё не подтверждены. Нажмите «Продолжить анализ» для повторной проверки."
            : "Черновик уже обработан или создание Jira не настроено.";
          await ctx.reply(text, { message_thread_id: panel.topicId });
        }
      } catch {
        await ctx.reply(store ? "Не удалось завершить действие. Решение сохранено, можно повторить проверку."
          : "Не удалось открыть состояние пайплайна. Задача не отправлялась в Jira. Попробуйте ещё раз позже.", {
          message_thread_id: panel.topicId,
        });
      } finally { store?.close(); }
    })();
    active.set(match[2], operation);
    try { await operation; } finally { active.delete(match[2]); }
  });
}

export function startReviewPipelineWorker(config: TeleCodexConfig, api: Api): { dispose(): Promise<void> } | undefined {
  const panel = config.jiraPanel;
  if (!panel) return undefined;
  if (!config.jiraComment) {
    console.warn("Review pipeline disabled: configure JIRA_COMMENT_SERVER, JIRA_COMMENT_LOGIN, and JIRA_COMMENT_TOKEN to classify Jira functional labels.");
    return undefined;
  }
  const file = reviewPipelineDbPath();
  const release = acquireRecipeRunLock(`${file}.worker.lock`, { nonBlocking: true });
  let store: ReviewPipelineStore;
  try { store = new ReviewPipelineStore(file); store.recover(); }
  catch (error) { release(); throw error; }
  let progress: ReviewPipelineProgressStore;
  try { progress = new ReviewPipelineProgressStore(reviewPipelineProgressDbPath()); progress.recoverMessages(); }
  catch (error) { store.close(); release(); throw error; }
  let journalStore: ReviewPipelineJournalStore;
  let journal: ReviewPipelineJournalRuntime;
  try {
    const model = resolveAvailablePipelineModel("analyst");
    journalStore = new ReviewPipelineJournalStore(`${reviewPipelineProgressDbPath()}.journal`);
    journalStore.recoverCreations();
    journal = new ReviewPipelineJournalRuntime({ journal: journalStore, progress, jobs: store,
      client: new ReviewPipelineJournalSessionClient(), cwd: process.cwd(), model,
      onError: () => console.warn("Review pipeline journal: update pending; check journal state"),
    });
  } catch (error) { progress.close(); store.close(); release(); throw error; }
  const sessionKeyboard = (batchId: string) => {
    const id = journal.threadId(batchId);
    return id ? buildCodexThreadKeyboard(`[История ревью](codex://threads/${id})`) : undefined;
  };
  const progressRuntime = new ReviewPipelineProgressRuntime({ progress, jobs: store,
    jiraUrl: topicUrl(panel.chatId, panel.topicId),
    sessionId: (batchId) => journal.threadId(batchId),
    send: async (batch, html) => (await api.sendMessage(batch.target.chatId, html, {
      message_thread_id: batch.target.messageThreadId, parse_mode: "HTML", link_preview_options: { is_disabled: true },
      reply_markup: sessionKeyboard(batch.id),
    }, AbortSignal.timeout(10_000) as never)).message_id,
    edit: async (batch, html) => {
      try {
        await api.editMessageText(batch.target.chatId, batch.messageId!, html, {
          parse_mode: "HTML", link_preview_options: { is_disabled: true },
          reply_markup: sessionKeyboard(batch.id),
        }, AbortSignal.timeout(10_000) as never);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("message is not modified"))) throw error;
      }
    },
    onError: () => console.warn("Review pipeline progress: delivery unavailable; check progress state"),
  });
  const runtime = new ReviewPipelineRuntime({ store,
    onPhase: (job, phase) => { progress.markAgent(job.id, phase); journal.recordPhase(job, phase); },
    onReport: (job, role, report) => journal.recordReport(job, role, report),
    deliver: async (job) => {
      const message = await api.sendMessage(panel.chatId, renderPipelineDraft(job), {
        message_thread_id: panel.topicId, parse_mode: "HTML", link_preview_options: { is_disabled: true },
        reply_markup: pipelineDraftKeyboard(job.id, !!getConfirmedAssessment(job)),
      }, AbortSignal.timeout(15_000) as never);
      return { chatId: panel.chatId, topicId: panel.topicId, messageId: message.message_id };
    },
    onError: () => console.warn("Review pipeline: retry scheduled; check lightweight model configuration and delivery"),
  });
  journal.start();
  progressRuntime.start();
  runtime.start();
  return { dispose: async () => {
    try { await runtime.dispose(); await progressRuntime.dispose(); await journal.dispose(); }
    finally { journalStore.close(); progress.close(); store.close(); release(); }
  } };
}
