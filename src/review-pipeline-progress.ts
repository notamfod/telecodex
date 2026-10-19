import path from "node:path";
import { escapeHTML } from "./format.js";
import { fingerprintFinding } from "./recipes.js";
import type { ReviewPipelineStore, PipelineJob } from "./review-pipeline-store.js";
import type { ProgressBatch, ReviewPipelineProgressStore } from "./review-pipeline-progress-store.js";

interface Options {
  progress: ReviewPipelineProgressStore;
  jobs: ReviewPipelineStore;
  send: (batch: ProgressBatch, text: string) => Promise<number>;
  edit: (batch: ProgressBatch, text: string) => Promise<void>;
  jiraUrl?: string;
  sessionId?: (batchId: string) => string | undefined;
  onError?: () => void;
}

/** One durable Telegram message per exact batch, updated only when its state changes. */
export class ReviewPipelineProgressRuntime {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private closed = false;
  private readonly acknowledged = new Map<string, number>();

  constructor(private readonly options: Options) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, 10_000);
    this.timer.unref();
    void this.runOnce();
  }

  runOnce(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.run().catch(() => this.options.onError?.()).finally(() => { this.active = undefined; });
    return this.active;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  private async run(): Promise<void> {
    for (const batch of this.options.progress.listBatches()) {
      if (this.closed) return;
      const { text, finished } = renderPipelineProgress(batch, this.options);
      if (text === batch.deliveredText) continue;
      let messageId = batch.messageId ?? this.acknowledged.get(batch.id);
      if (!messageId && (batch.sendState || !this.options.progress.claimMessage(batch.id))) continue;
      try {
        if (messageId) await this.options.edit({ ...batch, messageId }, text);
        else {
          try {
            messageId = await this.options.send(batch, text);
            this.acknowledged.set(batch.id, messageId);
          } catch (error) {
            this.options.progress.failMessage(batch.id, definitiveSendFailure(error));
            throw error;
          }
        }
        this.options.progress.markMessage(batch.id, messageId, text, finished);
        this.acknowledged.delete(batch.id);
      } catch { this.options.onError?.(); }
    }
  }
}

function definitiveSendFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("error_code" in error)) return false;
  return [400, 403, 429].includes(Number(error.error_code));
}

function renderPipelineProgress(batch: ProgressBatch, options: Options): { text: string; finished: boolean } {
  let checked = 0;
  let finished = true;
  const allJobs = new Map<string, PipelineJob>();
  const rows: string[] = [];
  for (const event of batch.events) {
    const name = path.posix.basename(event.projectPath);
    const range = options.progress.range(event);
    const jobs = options.jobs.listForSource(name, event.after, range?.result?.findings);
    for (const job of jobs) allJobs.set(job.id, job);
    const reviewed = range?.phase === "reviewed";
    if (reviewed) checked++;
    const allEnqueued = range?.result?.findings.every((finding) => jobs.some((job) =>
      fingerprintFinding(job.source.finding) === fingerprintFinding(finding))) ?? false;
    const done = reviewed && allEnqueued && jobs.every(settled);
    if (!done) finished = false;
    let status = reviewed ? "изменения проверены" : range?.phase === "reviewing"
      ? `проверка изменений${range.totalChunks ? `, часть ${range.chunk ?? 0}/${range.totalChunks}` : ""}`
      : range?.phase === "failed" ? "повтор проверки запланирован" : "ожидает проверки изменений";
    const paused = jobs.filter((job) => job.status === "needs_context").length;
    if (done) status = paused ? `нужен контекст: ${paused}; автоповтор остановлен`
      : jobs.length ? "проверка замечаний завершена" : "замечаний нет";
    else if (jobs.length) status += `; ${jobs.map((job) => jobStatus(job, options.progress)).join("; ")}`;
    rows.push(`• <b>${escapeHTML(name.slice(0, 42))}</b> <code>${event.after.slice(0, 8)}</code>: ${escapeHTML(status)}`);
  }
  const jobs = [...allJobs.values()];
  const drafts = jobs.filter((job) => job.messageId !== undefined).length;
  const disproved = jobs.filter((job) => job.status === "disproved").length;
  const paused = jobs.filter((job) => job.status === "needs_context").length;
  const sessionId = options.sessionId?.(batch.id);
  const scheduled = batch.events.every((event) => event.projectPath.startsWith("recipes/"));
  const text = [
    `<b>${finished ? paused ? "⏸ Нужен контекст" : "✅ Пайплайн завершён" : scheduled ? "🔄 Плановый пайплайн ревью" : "🔄 Пайплайн ревью"}</b> · ${scheduled ? "проектов" : "уведомлений"}: ${batch.events.length}`,
    `Изменения проверены: ${checked}/${batch.events.length}`,
    `Замечаний: ${jobs.length} · черновиков: ${drafts} · отклонено: ${disproved}${paused ? ` · нужен контекст: ${paused}` : ""}`,
    "",
    ...rows,
    ...(sessionId ? ["", `Сессия Codex: <code>${escapeHTML(sessionId)}</code>`] : []),
    ...(options.jiraUrl ? ["", `<a href="${escapeHTML(options.jiraUrl)}">Черновики и подтверждение Jira</a>`] : []),
  ].join("\n");
  // A batch may contain up to 30 notifications and many findings. Keep Telegram updates bounded.
  if (text.length <= 4000) return { text, finished };
  const compact = rows.map((row) => row.length > 95 ? `${row.slice(0, row.indexOf(": ") + 2)}в обработке` : row);
  return { text: text.replace(rows.join("\n"), compact.join("\n")), finished };
}

function settled(job: PipelineJob): boolean {
  return job.status === "disproved" || job.status === "needs_context" || job.messageId !== undefined
    && ["awaiting", "creating", "created", "continuing"].includes(job.status);
}

function jobStatus(job: PipelineJob, progress: ReviewPipelineProgressStore): string {
  if (job.status === "working") return `${progress.agent(job.id) === "verifier" ? "проверяющий" : "аналитик"}, раунд ${job.round}`;
  if (job.status === "queued") return job.round ? `повторный анализ запланирован, раунд ${job.round + 1}` : "ожидает аналитика";
  if (job.status === "disproved") return "замечание не подтвердилось";
  if (job.status === "needs_context") return "нужен контекст; автоповтор остановлен";
  if (job.status === "created") return `создана ${job.issueKey}`;
  if (job.status === "continuing") return "продолжение в отдельном топике";
  return job.messageId ? "черновик в Jira-топике" : "отправка черновика в Jira-топик";
}
