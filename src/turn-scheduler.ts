export interface TurnSchedulerCallbacks {
  onQueued?: (status: { position: number; active: number; limit: number }) => void;
  onStarted?: () => void;
}

export class TurnScheduler {
  private readonly activeTopicKeys = new Set<string>();
  private readonly queue: Array<ScheduledJob<unknown>> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("TurnScheduler limit must be an integer of at least 1");
    }
  }

  run<T>(
    topicKey: string,
    task: () => Promise<T>,
    callbacks: TurnSchedulerCallbacks = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: ScheduledJob<T> = { topicKey, task, callbacks, resolve, reject };
      if (this.canStart(topicKey)) {
        this.start(job);
        return;
      }

      this.queue.push(job as ScheduledJob<unknown>);
      callbacks.onQueued?.({
        position: this.queue.length,
        active: this.activeTopicKeys.size,
        limit: this.limit,
      });
    });
  }

  cancel(topicKey: string, callbacks: TurnSchedulerCallbacks): boolean {
    const index = this.queue.findIndex(
      (job) => job.topicKey === topicKey && job.callbacks === callbacks,
    );
    if (index < 0) return false;

    const [job] = this.queue.splice(index, 1);
    job.reject(new Error("Scheduled turn aborted"));
    return true;
  }

  private canStart(topicKey: string): boolean {
    return this.activeTopicKeys.size < this.limit && !this.activeTopicKeys.has(topicKey);
  }

  private start<T>(job: ScheduledJob<T>): void {
    this.activeTopicKeys.add(job.topicKey);
    job.callbacks.onStarted?.();

    void Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.activeTopicKeys.delete(job.topicKey);
        this.drain();
      });
  }

  private drain(): void {
    while (this.activeTopicKeys.size < this.limit) {
      const index = this.queue.findIndex((job) => !this.activeTopicKeys.has(job.topicKey));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      this.start(job);
    }
  }
}

interface ScheduledJob<T> {
  topicKey: string;
  task: () => Promise<T>;
  callbacks: TurnSchedulerCallbacks;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
}
