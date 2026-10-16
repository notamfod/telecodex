import { createHash } from "node:crypto";
import path from "node:path";
import type { ReviewPipelineJournalSessionClient } from "./review-pipeline-journal-session.js";
import { ReviewPipelineJournalStore } from "./review-pipeline-journal-store.js";
import type { ProgressBatch, ReviewPipelineProgressStore } from "./review-pipeline-progress-store.js";
import type { PipelineJob, PipelineReport, ReviewPipelineStore } from "./review-pipeline-store.js";

type Role = "analyst" | "verifier";
interface Options {
  journal: ReviewPipelineJournalStore;
  progress: ReviewPipelineProgressStore;
  jobs: ReviewPipelineStore;
  client: Pick<ReviewPipelineJournalSessionClient, "create" | "inspect" | "append" | "dispose">
    & { setTitle?: (threadId: string, title: string) => Promise<void> };
  cwd: string;
  model: string;
  onError?: () => void;
}

/** One persistent, visible journal per batch; independent agents remain the executors. */
export class ReviewPipelineJournalRuntime {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private closed = false;
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
    await this.options.client.dispose();
    await this.active;
  }
  threadId(batchId: string): string | undefined {
    return this.options.journal.sessions().find((session) => session.batchId === batchId)?.threadId;
  }
  recordPhase(job: PipelineJob, role: Role): void {
    this.forJob(job, (batch) => this.event(batch, `phase:${job.id}:${job.round}:${role}`,
      `${label(role)} начал проверку ${job.source.project}, ${job.source.finding.file}. Раунд ${job.round}.`));
  }
  recordReport(job: PipelineJob, role: Role, report: PipelineReport): void {
    this.forJob(job, (batch) => this.event(batch, `report:${job.id}:${job.round}:${role}:${hash(report)}`,
      `${label(role)}, раунд ${job.round}. ${job.source.project} ${job.source.headSha}\n${job.source.finding.file}\n${renderReport(report)}`));
  }
  private ensure(batch: ProgressBatch): void {
    this.options.journal.ensureSession(batch.id, `Ревью Mircli · ${batch.events.length} уведомлений · ${batch.id.slice(0, 8)}`, this.options.cwd);
  }
  private event(batch: ProgressBatch, key: string, text: string): void {
    this.ensure(batch);
    this.options.journal.appendEvent(batch.id, key, `${new Date().toISOString()}\n${text}`);
  }
  private forJob(job: PipelineJob, callback: (batch: ProgressBatch) => void): void {
    for (const batch of this.options.progress.listBatches()) {
      if (batch.events.some((event) => {
        if (path.posix.basename(event.projectPath) !== job.source.project) return false;
        const range = this.options.progress.range(event);
        return !!range?.result && this.options.jobs.listForSource(job.source.project, event.after, range.result.findings)
          .some((candidate) => candidate.id === job.id);
      })) callback(batch);
    }
  }
  private capture(): void {
    for (const batch of this.options.progress.listBatches()) {
      this.ensure(batch);
      this.event(batch, "batch", `Пакет фонового ревью: ${batch.events.length} уведомлений. Здесь журнал проверок независимых агентов.\n`
        + batch.events.map((event) => `${event.projectPath}: ${event.before ?? ""} -> ${event.after}`).join("\n"));
      for (const source of batch.events) {
        const range = this.options.progress.range(source);
        if (range) this.event(batch, `range:${hash([source, range])}`, `Проверка изменений ${source.projectPath} ${source.after}: ${range.phase}`
          + `; часть ${range.chunk ?? 0}/${range.totalChunks ?? "?"}; замечаний ${range.result?.findings.length ?? "?"}.`);
        const jobs = range?.result
          ? this.options.jobs.listForSource(path.posix.basename(source.projectPath), source.after, range.result.findings) : [];
        for (const job of jobs) {
          const key = `finding:${job.id}`;
          const firstObservation = !this.options.journal.hasEvent(batch.id, key);
          if (firstObservation) {
            this.event(batch, key, `Замечание ${job.id}: ${job.source.project} ${job.source.headSha}\n${JSON.stringify(job.source.finding)}`);
          }
          job.reports.forEach((report, index) => {
            const latestPair = index >= job.reports.length - 2;
            if (!firstObservation && (!latestPair || job.status === "working")) return;
            const role: Role = index % 2 === 0 ? "analyst" : "verifier";
            const observed = latestPair && this.options.journal.hasEvent(batch.id, `report:${job.id}:${job.round}:${role}:${hash(report)}`);
            if (!observed) this.event(batch, `saved:${job.id}:${job.round}:${index}:${hash(report)}`,
              `Сохранённый отчёт ${role === "analyst" ? "аналитика" : "проверяющего"} (снимок после ${job.round} запусков): ${job.source.finding.file}\n${renderReport(report)}`);
          });
          this.event(batch, `status:${job.id}:${hash([job.status, job.round, job.messageId, job.issueKey, job.analysisTopicId])}`,
            `Замечание ${job.id}: ${job.status}, раунд ${job.round}.`
            + (job.messageId ? ` Черновик: https://t.me/c/${String(job.chatId).replace(/^-100/, "")}/${job.messageId}` : "")
            + (job.issueUrl ? ` Jira: ${job.issueUrl}` : "")
            + (job.analysisTopicId ? ` Продолжение в топике ${job.analysisTopicId}.` : ""));
        }
      }
    }
  }
  private async run(): Promise<void> {
    this.capture();
    const { journal, client } = this.options;
    for (let session of journal.sessions()) {
      if (this.closed) return;
      try {
        if (!session.threadId) {
          if (!journal.claimSession(session.batchId)) continue;
          try {
            const id = await client.create(session.title, session.cwd, this.options.model,
              (id) => journal.attachSession(session.batchId, id));
            journal.attachSession(session.batchId, id);
          } catch (error) { journal.failSession(session.batchId, notSent(error)); throw error; }
          session = journal.sessions().find((item) => item.batchId === session.batchId)!;
        }
        if (this.closed) return;
        if (!session.pending && journal.pendingEvents(session.batchId, 1).length === 0) continue;
        const state = await client.inspect(session.threadId!);
        if (session.pending && state.markers.includes(session.pending.key)) {
          journal.markWritten(session.batchId);
          journal.acknowledgeAppend(session.batchId);
          session = { ...session, pending: undefined };
          await client.setTitle?.(session.threadId!, session.title).catch(() => this.options.onError?.());
        }
        if (state.busy || session.pending?.state === "written") continue;
        if (!session.pending) {
          const events = journal.pendingEvents(session.batchId, 8);
          const selected = events.filter((_event, index) => Buffer.byteLength(events.slice(0, index + 1).map((event) => event.text).join("\n\n")) < 60_000);
          if (!selected.length) continue;
          session = journal.prepareAppend(session.batchId, hash(selected.map((event) => event.id)), selected.map((event) => event.id), selected.map((event) => event.text).join("\n\n"));
        }
        const pending = session.pending!;
        try {
          await client.append(session.threadId!, session.cwd, this.options.model, pending.key, pending.text,
            () => journal.markWritten(session.batchId));
          journal.acknowledgeAppend(session.batchId);
          // First-turn auto titling can replace a name assigned before the initial turn.
          await client.setTitle?.(session.threadId!, session.title).catch(() => this.options.onError?.());
        } catch (error) {
          if (notSent(error) && journal.sessions().find((item) => item.batchId === session.batchId)?.pending?.state === "written") {
            journal.resetAppend(session.batchId);
          }
          throw error;
        }
      } catch { this.options.onError?.(); }
    }
  }
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function label(role: Role): string { return role === "analyst" ? "Аналитик" : "Проверяющий"; }
function renderReport(report: PipelineReport): string {
  return `Вывод: ${report.verdict}\n${report.reason}\nДоказательства: ${report.evidence.join(", ")}`
    + (report.draft ? `\nПредложение задачи: ${JSON.stringify(report.draft)}` : "");
}
function notSent(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "APP_SERVER_NOT_SENT";
}
