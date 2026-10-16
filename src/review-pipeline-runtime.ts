import { runPipelineAgent } from "./review-pipeline-agent.js";
import { ReviewPipelineStore, type PipelineJob, type PipelineReport } from "./review-pipeline-store.js";
import { prepareReviewSnapshot } from "./review-pipeline-snapshot.js";

interface RuntimeOptions {
  store: ReviewPipelineStore;
  analyze?: (job: PipelineJob, role: "analyst" | "verifier", analyst?: PipelineReport,
    dependencies?: { signal?: AbortSignal }) => Promise<PipelineReport>;
  snapshot?: (job: PipelineJob) => Promise<PipelineJob>;
  deliver: (job: PipelineJob) => Promise<{ chatId: number; topicId: number; messageId: number }>;
  now?: () => number;
  onError?: () => void;
  onPhase?: (job: PipelineJob, phase: "analyst" | "verifier") => void;
  onReport?: (job: PipelineJob, role: "analyst" | "verifier", report: PipelineReport) => void;
}

/** Two independent jobs at a time; each verifier starts only after its analyst finishes. */
export class ReviewPipelineRuntime {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private closed = false;
  private readonly controller = new AbortController();

  constructor(private readonly options: RuntimeOptions) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => this.options.onError?.()); }, 10_000);
    this.timer.unref();
    void this.runOnce().catch(() => this.options.onError?.());
  }

  runOnce(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    const operation = this.run();
    this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; }).catch(() => undefined);
    return operation;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.active?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const { store } = this.options;
    const jobs = [store.claim(this.now()), store.claim(this.now())].filter((job): job is PipelineJob => !!job);
    await Promise.all(jobs.map(async (job) => {
      try {
        const pinned = await (this.options.snapshot ?? preparePipelineSnapshot)(job);
        if (this.closed) return;
        const analyze = this.options.analyze ?? runPipelineAgent;
        this.reportPhase(job, "analyst");
        const analyst = await analyze(pinned, "analyst", undefined, { signal: this.controller.signal });
        if (this.closed) return;
        this.reportResult(job, "analyst", analyst);
        this.reportPhase(job, "verifier");
        const verifier = await analyze(pinned, "verifier", analyst, { signal: this.controller.signal });
        if (!this.closed) {
          this.reportResult(job, "verifier", verifier);
          store.finishRound(job.id, analyst, verifier, this.now());
        }
      } catch {
        if (!this.closed) { store.failure(job.id, this.now()); this.options.onError?.(); }
      }
    }));
    for (const job of store.awaitingDelivery()) {
      if (this.closed) return;
      try {
        const target = await this.options.deliver(job);
        store.markDelivered(job.id, target.chatId, target.topicId, target.messageId);
      } catch { this.options.onError?.(); }
    }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private reportResult(job: PipelineJob, role: "analyst" | "verifier", report: PipelineReport): void {
    try { this.options.onReport?.(job, role, report); }
    catch { this.options.onError?.(); }
  }

  private reportPhase(job: PipelineJob, phase: "analyst" | "verifier"): void {
    try { this.options.onPhase?.(job, phase); }
    catch { this.options.onError?.(); }
  }
}

/** Keep queued findings attached to the reviewed revision when the scheduled checkout advances. */
export async function preparePipelineSnapshot(job: PipelineJob): Promise<PipelineJob> {
  const directory = await prepareReviewSnapshot(job.source.cwd, job.source.headSha);
  return { ...job, source: { ...job.source, cwd: directory } };
}
