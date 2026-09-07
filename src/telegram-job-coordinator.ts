import { randomUUID } from "node:crypto";

import { AppServerRequestError } from "./app-server-client.js";
import {
  PreviousTurnUnknownError, boundedAdd, boundedId, createTelegramTurnObservation,
  eventAt, exactOwnedDispatch, exactQueuedSnapshot, isAborted, isOccupying,
  isVersionConflict, ownsDispatch, positiveInteger,
} from "./telegram-job-coordinator-support.js";
import type { SqliteTelegramJobStore } from "./telegram-job-store.js";
import {
  normalizeTelegramTurnResult, type TelegramTurnAttachmentReference, type TelegramTurnResultContent,
} from "./telegram-turn-result.js";
import type { JobActivity, MaterializedPrompt, TelegramJob } from "./telegram-job-types.js";

type CoordinatorStore = Pick<SqliteTelegramJobStore,
  "get" | "listUnfinished" | "listDispatchable" | "readSourcePayload" | "transition">;
const MAX_RETRY_AFTER_MS = 60_000;

export interface TelegramCoordinatorTurnCallbacks {
  beforeDispatchWrite(event: {
    threadId: string; previousTurnId: string | null; previousTurnKnown: boolean; attempt: number;
  }): void;
  onDispatchWritten(): void;
  onStarted(turnId: string): void;
  onActivity(event: { activity: JobActivity; eventAt: number; method: string }): void;
  onTextDelta(delta: string, message?: { readonly itemId: string; readonly phase?: string }): void;
  onAgentMessageEnd?(message: { readonly itemId: string; readonly phase?: string }): void;
  onOutputAttachment(attachment: TelegramTurnAttachmentReference): void;
  onTurnOutcome(event: { status: string; eventAt: number }): void;
}

export interface TelegramCoordinatorTurnRequest {
  readonly jobId: string;
  readonly threadId: string;
  readonly prompt: MaterializedPrompt;
  readonly callbacks: TelegramCoordinatorTurnCallbacks;
}

export interface TelegramCoordinatorCodexAdapter {
  resolveThread(job: TelegramJob): Promise<string>;
  startTurn(request: TelegramCoordinatorTurnRequest): Promise<void>;
  recoverTurn(request: TelegramCoordinatorTurnRequest, exactTurnId: string): Promise<void>;
  abortTurn(input: { readonly threadId: string; readonly turnId: string }): Promise<void>;
}

export interface TelegramJobCoordinatorOptions {
  readonly store: CoordinatorStore;
  readonly materializer: { materialize(jobId: string): Promise<MaterializedPrompt> };
  readonly codex: TelegramCoordinatorCodexAdapter;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly globalConcurrency?: number;
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
  readonly scheduleWakeup?: (at: number, wake: () => void) => void;
  readonly publishCommentary?: (input: {
    readonly jobId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly commentaryIndex: number;
    readonly text: string;
  }) => void;
}

export class TelegramCoordinatorRetryAfterError extends Error {
  readonly name = "TelegramCoordinatorRetryAfterError";
  constructor(readonly retryAfterMs: number) {
    super("Coordinator work is rate limited");
    positiveInteger(retryAfterMs, "retryAfterMs");
    if (retryAfterMs > MAX_RETRY_AFTER_MS) throw new Error("Invalid retryAfterMs");
  }
}

interface PreparedJob { readonly job: TelegramJob; readonly threadId: string; readonly lanes: readonly string[] }
export class TelegramJobCoordinator {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly globalConcurrency: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly active = new Map<string, Promise<void>>();
  private readonly materializing = new Map<string, Promise<void>>();
  private readonly recoveryScheduled = new Set<string>();
  private pumpPromise: Promise<void> | null = null;
  private pumpAgain = false;
  private disposed = false;
  constructor(private readonly options: TelegramJobCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.globalConcurrency = positiveInteger(options.globalConcurrency ?? 4, "globalConcurrency");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "maxAttempts");
    this.retryBackoffMs = positiveInteger(options.retryBackoffMs ?? 1_000, "retryBackoffMs");
  }

  pump(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pumpPromise) {
      this.pumpAgain = true;
      return this.pumpPromise;
    }
    const work = this.performPump().finally(() => {
      if (this.pumpPromise !== work) return;
      this.pumpPromise = null;
      if (this.pumpAgain && !this.disposed) {
        this.pumpAgain = false;
        void this.pump();
      }
    });
    this.pumpPromise = work;
    return work;
  }

  dispose(): void { this.disposed = true; }
  async recoverExactTurn(jobId: string): Promise<{ scheduled: boolean }> {
    if (this.disposed) return { scheduled: false };
    const id = boundedId(jobId);
    if (this.recoveryScheduled.has(id)) return { scheduled: false };
    const job = this.requireJob(id);
    if (job.phase !== "running" || !job.threadId || !job.turnId) {
      throw new Error("Telegram job is not recoverable");
    }
    const threadId = boundedId(job.threadId);
    const turnId = boundedId(job.turnId);
    this.recoveryScheduled.add(job.id);
    return { scheduled: this.register(job.id, () => this.executeRecovery(job, threadId, turnId)) };
  }

  async abort(jobId: string): Promise<void> {
    let job = this.requireJob(jobId);
    if (job.phase === "accepted" || job.phase === "queued") {
      this.transition(job, {
        schemaVersion: 1, type: "job.terminal", eventAt: eventAt(this.now, job), outcome: "aborted",
      });
      return;
    }
    if (job.phase !== "running" || !job.threadId || !job.turnId) return;
    job = this.transition(job, {
      schemaVersion: 1, type: "abort.requested", eventAt: eventAt(this.now, job),
      abortRequestedAt: eventAt(this.now, job),
    });
    try {
      await this.options.codex.abortTurn({ threadId: job.threadId!, turnId: job.turnId! });
    } catch {
      this.observe(job.id, (current) => ({
        schemaVersion: 1, type: "activity.observed", eventAt: eventAt(this.now, current),
        attention: { kind: "required", code: "abort_request_failed", actions: ["inspect"] },
      }));
    }
  }

  private async performPump(): Promise<void> {
    await this.queueAccepted();
    const unfinished = this.options.store.listUnfinished(1_000);
    let available = this.globalConcurrency - unfinished.filter(isOccupying).length;
    if (available <= 0) return;
    const occupied = new Set<string>();
    for (const job of unfinished.filter(isOccupying)) for (const lane of this.lanes(job)) occupied.add(lane);
    const blocked = new Set<string>();

    for (const queued of this.options.store.listDispatchable(1_000)) {
      if (this.disposed || available <= 0) break;
      const topicLane = this.topicLane(queued);
      if (blocked.has(topicLane)) continue;
      if ((queued.nextAttemptAt ?? 0) > this.now()) {
        for (const lane of this.lanes(queued)) blocked.add(lane);
        this.schedule(queued.nextAttemptAt!);
        continue;
      }
      let prepared: PreparedJob;
      try {
        const threadId = boundedId(await this.options.codex.resolveThread(queued));
        prepared = { job: queued, threadId, lanes: [topicLane, `thread:${threadId}`] };
      } catch (error) {
        if (error instanceof TelegramCoordinatorRetryAfterError) {
          const nextAttemptAt = boundedAdd(this.now(), error.retryAfterMs);
          this.defer(queued, nextAttemptAt);
          this.schedule(nextAttemptAt);
        } else if (error instanceof AppServerRequestError && error.code === "APP_SERVER_NOT_SENT") {
          const nextAttemptAt = boundedAdd(this.now(), this.retryBackoffMs);
          this.defer(queued, nextAttemptAt);
          this.schedule(nextAttemptAt);
        } else if (error instanceof AppServerRequestError && error.code === "APP_SERVER_REJECTED") {
          this.fail(queued, "app_server_rejected", ["inspect", "retry"]);
        } else {
          this.requireAttention(queued, "thread_resolution_unknown", ["inspect"]);
        }
        blocked.add(topicLane);
        continue;
      }
      if (prepared.lanes.some((lane) => occupied.has(lane) || blocked.has(lane))) {
        for (const lane of prepared.lanes) blocked.add(lane);
        continue;
      }
      for (const lane of prepared.lanes) occupied.add(lane);
      this.launch(prepared);
      available -= 1;
    }
  }

  private async queueAccepted(): Promise<void> {
    for (const snapshot of this.options.store.listUnfinished(1_000)) {
      if (this.disposed || snapshot.phase !== "accepted") continue;
      if (snapshot.attention.kind === "required") continue;
      if (awaitingTargetProvision(this.options.store.readSourcePayload(snapshot.id))) continue;
      if (!snapshot.materializedPrompt) {
        this.scheduleMaterialization(snapshot.id);
        continue;
      }
      const current = this.options.store.get(snapshot.id);
      if (!current || current.phase !== "accepted" || !current.materializedPrompt) continue;
      this.tryTransition(current, {
        schemaVersion: 1, type: "job.queued", eventAt: eventAt(this.now, current),
        attention: { kind: "none" },
      });
    }
  }

  private scheduleMaterialization(jobId: string): void {
    if (this.materializing.has(jobId) || this.disposed) return;
    const operation = this.options.materializer.materialize(jobId)
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.materializing.get(jobId) === operation) this.materializing.delete(jobId);
        if (!this.disposed) void this.pump();
      });
    this.materializing.set(jobId, operation);
  }

  private launch(prepared: PreparedJob): void {
    this.register(prepared.job.id, () => this.execute(prepared));
  }

  private register(jobId: string, run: () => Promise<void>): boolean {
    if (this.active.has(jobId)) return false;
    const execution = run().finally(() => {
      if (this.active.get(jobId) === execution) this.active.delete(jobId);
    });
    this.active.set(jobId, execution);
    void execution.catch(() => {});
    return true;
  }

  private async execute(prepared: PreparedJob): Promise<void> {
    let knownTurnId: string | null = null;
    let dispatchId: string | null = null;
    const attemptBase = prepared.job.dispatch?.attempt ?? 0;
    const observation = createTelegramTurnObservation({
      beforeDispatchWrite: (fact) => {
        if (fact.threadId !== prepared.threadId) throw new Error("Codex thread identity changed");
        if (!fact.previousTurnKnown) throw new PreviousTurnUnknownError();
        const current = this.requireJob(prepared.job.id);
        const barrierBase = dispatchId === null
          ? exactQueuedSnapshot(current, prepared.job)
          : exactOwnedDispatch(current, dispatchId);
        const attempt = attemptBase + positiveInteger(fact.attempt, "attempt");
        if (attempt > this.maxAttempts) {
          this.fail(barrierBase, "dispatch_attempts_exhausted", ["retry"]);
          throw new Error("Telegram dispatch attempt budget exhausted");
        }
        dispatchId = boundedId(this.createId());
        const started = this.transition(barrierBase, {
          schemaVersion: 1, type: "dispatch.started", eventAt: eventAt(this.now, barrierBase),
          dispatch: {
            id: dispatchId, threadId: fact.threadId, previousTurnId: fact.previousTurnId,
            attempt, startedAt: this.now(), transportWriteState: "prepared", nextAttemptAt: null,
          },
        });
        this.transition(started, {
          schemaVersion: 1, type: "dispatch.in_flight", eventAt: eventAt(this.now, started),
        });
      },
      onDispatchWritten: () => this.observeDispatch(prepared.job.id, dispatchId, "dispatch.written"),
      onStarted: (turnId) => {
        const boundedTurnId = boundedId(turnId);
        const stored = this.observeDispatch(prepared.job.id, dispatchId, "turn.started", {
          identifiers: { turnId: boundedTurnId }, codexEventAt: this.now(),
        });
        if (stored?.turnId === boundedTurnId) knownTurnId = boundedTurnId;
      },
      onActivity: (fact) => {
        const current = this.options.store.get(prepared.job.id);
        if (!current || !knownTurnId || current.turnId !== knownTurnId || current.phase !== "running") return;
        this.tryTransition(current, {
          schemaVersion: 1, type: "activity.observed", eventAt: eventAt(this.now, current),
          activity: fact.activity, codexEventAt: fact.eventAt,
        });
      },
      onCommentaryCompleted: (commentary) => {
        if (!knownTurnId) return;
        this.publishCommentary(prepared.job.id, knownTurnId, commentary);
      },
    });

    try {
      await this.options.codex.startTurn({
        jobId: prepared.job.id, threadId: prepared.threadId,
        prompt: structuredClone(prepared.job.materializedPrompt!), callbacks: observation.callbacks,
      });
      const result = observation.snapshot();
      this.finishObserved(prepared.job.id, result.outcome, result.content, result.invalidOutput);
    } catch (error) {
      this.handleExecutionError(prepared.job.id, error, observation.snapshot().outcome);
    } finally {
      if (!this.disposed) void this.pump();
    }
  }

  private async executeRecovery(job: TelegramJob, threadId: string, turnId: string): Promise<void> {
    let identityValid = true;
    const observation = createTelegramTurnObservation({
      beforeDispatchWrite: () => { throw new Error("Recovered turn cannot dispatch"); },
      onDispatchWritten: () => {},
      onStarted: (candidate) => {
        let candidateId: string | null = null;
        try { candidateId = boundedId(candidate); } catch {}
        if (candidateId !== turnId) {
          identityValid = false;
          this.requireRecoveryAttention(job.id, turnId, "turn_recovery_identity_mismatch");
        }
      },
      onActivity: (fact) => {
        const current = this.options.store.get(job.id);
        if (!identityValid || current?.phase !== "running" || current.turnId !== turnId) return;
        this.tryTransition(current, {
          schemaVersion: 1, type: "activity.observed", eventAt: eventAt(this.now, current),
          activity: fact.activity, codexEventAt: fact.eventAt,
        });
      },
      onCommentaryCompleted: (commentary) => {
        if (!identityValid) return;
        this.publishCommentary(job.id, turnId, commentary);
      },
    });
    try {
      await this.options.codex.recoverTurn({
        jobId: job.id, threadId, prompt: { text: "", attachments: [] }, callbacks: observation.callbacks,
      }, turnId);
      const result = observation.snapshot();
      if (!identityValid) return;
      this.finishObserved(job.id, result.outcome, result.content, result.invalidOutput, turnId);
    } catch {
      const result = observation.snapshot();
      if (result.outcome) this.finishObserved(job.id, result.outcome, result.content, result.invalidOutput, turnId);
      else this.requireRecoveryAttention(job.id, turnId, "turn_recovery_failed");
    } finally {
      if (!this.disposed) void this.pump();
    }
  }

  private finishObserved(
    jobId: string,
    outcome: { status: string; eventAt: number } | null,
    content: readonly TelegramTurnResultContent[],
    invalidOutput: boolean,
    expectedTurnId?: string,
  ): void {
    const current = this.options.store.get(jobId);
    if (!current || current.phase === "terminal" || current.phase === "delivering") return;
    if (expectedTurnId && (current.phase !== "running" || current.turnId !== expectedTurnId)) return;
    if (invalidOutput) {
      this.fail(current, "invalid_codex_output", ["inspect"]);
      return;
    }
    if (outcome?.status === "completed" && current.phase === "running" && current.turnId) {
      const turnId = current.turnId;
      let turnResult;
      try { turnResult = normalizeTelegramTurnResult({ schemaVersion: 1, content }); }
      catch { this.fail(current, "invalid_codex_output", ["inspect"]); return; }
      this.commitFact(jobId, (latest) => latest.phase === "running" && latest.turnId === turnId
        ? {
            schemaVersion: 1, type: "turn.completed" as const, eventAt: eventAt(this.now, latest),
            codexEventAt: outcome.eventAt, turnResult,
          }
        : null);
      return;
    }
    if (isAborted(outcome?.status)) {
      this.terminal(current, "aborted");
      return;
    }
    if (outcome && outcome.status !== "completed") {
      this.fail(current, "codex_turn_failed", ["inspect", "retry"]);
      return;
    }
    this.requireAttention(current, "turn_outcome_unknown", ["inspect"]);
  }

  private publishCommentary(
    jobId: string,
    turnId: string,
    commentary: { readonly itemId: string; readonly commentaryIndex: number; readonly text: string },
  ): void {
    const current = this.options.store.get(jobId);
    if (!current || current.phase !== "running" || current.turnId !== turnId) return;
    try {
      this.options.publishCommentary?.({
        jobId,
        turnId,
        itemId: boundedId(commentary.itemId),
        commentaryIndex: commentary.commentaryIndex,
        text: commentary.text,
      });
    } catch {
      this.requireAttention(current, "live_commentary_delivery_failed", ["inspect"]);
    }
  }

  private handleExecutionError(
    jobId: string,
    error: unknown,
    outcome: { status: string; eventAt: number } | null,
  ): void {
    const current = this.options.store.get(jobId);
    if (!current || current.phase === "terminal" || current.phase === "delivering") return;
    if (isVersionConflict(error)) return;
    if (error instanceof PreviousTurnUnknownError) {
      this.requireAttention(current, "previous_turn_unknown", ["inspect"]); return;
    }
    if (isAborted(outcome?.status)) { this.terminal(current, "aborted"); return; }
    if (outcome && outcome.status !== "completed") {
      this.fail(current, "codex_turn_failed", ["inspect", "retry"]); return;
    }
    if (error instanceof AppServerRequestError && error.code === "APP_SERVER_REJECTED") {
      this.fail(current, "app_server_rejected", ["inspect", "retry"]); return;
    }
    if (error instanceof AppServerRequestError && error.code === "APP_SERVER_NOT_SENT") {
      const attempt = current.dispatch?.attempt ?? 0;
      if (attempt >= this.maxAttempts) this.fail(current, "dispatch_attempts_exhausted", ["retry"]);
      else {
        const nextAttemptAt = boundedAdd(this.now(), this.retryBackoffMs);
        this.defer(current, nextAttemptAt);
      }
      return;
    }
    const code = error instanceof AppServerRequestError && error.code === "APP_SERVER_ACCEPTANCE_UNKNOWN"
      ? "dispatch_acceptance_unknown" : "turn_outcome_unknown";
    this.requireAttention(current, code, code === "dispatch_acceptance_unknown" ? ["inspect", "retry"] : ["inspect"]);
  }

  private observeDispatch(jobId: string, dispatchId: string | null, type: "dispatch.written" | "turn.started", extra = {}): TelegramJob | null {
    if (!dispatchId) return null;
    try {
      return this.commitFact(jobId, (current) => {
        if (current.dispatch?.id !== dispatchId) return null;
        if (type === "dispatch.written" && current.dispatch.transportWriteState === "written") return null;
        if (type === "turn.started" && current.phase === "running") return null;
        const event = { schemaVersion: 1, type, eventAt: eventAt(this.now, current), ...extra };
        return event as Parameters<CoordinatorStore["transition"]>[0]["event"];
      });
    } catch { return null; }
  }

  private defer(job: TelegramJob, nextAttemptAt: number): void {
    const dispatchId = job.dispatch?.id;
    this.commitFact(job.id, (current) => ownsDispatch(current, dispatchId)
      && (current.phase === "queued" || current.phase === "dispatching")
      ? { schemaVersion: 1, type: "job.deferred", eventAt: eventAt(this.now, current), nextAttemptAt, attention: { kind: "none" } }
      : null);
  }

  private fail(job: TelegramJob, code: string, actions: readonly string[]): void {
    const dispatchId = job.dispatch?.id;
    this.commitFact(job.id, (current) => !ownsDispatch(current, dispatchId)
      || current.phase === "terminal" || current.phase === "delivering"
      ? null
      : { schemaVersion: 1, type: "job.terminal", eventAt: eventAt(this.now, current), outcome: "failed", attention: { kind: "required", code, actions } });
  }

  private terminal(job: TelegramJob, outcome: "aborted"): void {
    const dispatchId = job.dispatch?.id;
    this.commitFact(job.id, (current) => !ownsDispatch(current, dispatchId)
      || current.phase === "terminal" || current.phase === "delivering"
      ? null
      : { schemaVersion: 1, type: "job.terminal", eventAt: eventAt(this.now, current), outcome });
  }

  private requireAttention(job: TelegramJob, code: string, actions: readonly string[]): void {
    const dispatchId = job.dispatch?.id;
    this.commitFact(job.id, (current) => !ownsDispatch(current, dispatchId)
      || current.phase === "terminal" || current.phase === "delivering"
      || (current.attention.kind === "required" && current.attention.code === code)
      ? null
      : { schemaVersion: 1, type: "activity.observed", eventAt: eventAt(this.now, current), attention: { kind: "required", code, actions } });
  }

  private requireRecoveryAttention(jobId: string, turnId: string, code: string): void {
    this.commitFact(jobId, (current) => current.phase !== "running" || current.turnId !== turnId
      || (current.attention.kind === "required" && current.attention.code === code)
      ? null
      : { schemaVersion: 1, type: "activity.observed", eventAt: eventAt(this.now, current), attention: { kind: "required", code, actions: ["inspect"] } });
  }

  private observe(jobId: string, event: (job: TelegramJob) => Parameters<CoordinatorStore["transition"]>[0]["event"]): void {
    const current = this.options.store.get(jobId);
    if (current) this.tryTransition(current, event(current));
  }

  private transition(job: TelegramJob, event: Parameters<CoordinatorStore["transition"]>[0]["event"]): TelegramJob {
    return this.options.store.transition({
      jobId: job.id, eventId: boundedId(this.createId()), expectedVersion: job.version, event,
    });
  }

  private tryTransition(job: TelegramJob, event: Parameters<CoordinatorStore["transition"]>[0]["event"]): TelegramJob | null {
    try { return this.transition(job, event); }
    catch (error) { if (isVersionConflict(error)) return this.options.store.get(job.id); throw error; }
  }

  private commitFact(
    jobId: string,
    build: (job: TelegramJob) => Parameters<CoordinatorStore["transition"]>[0]["event"] | null,
  ): TelegramJob | null {
    for (let conflicts = 0; conflicts < 16; conflicts += 1) {
      const current = this.options.store.get(jobId);
      if (!current) return null;
      const event = build(current);
      if (!event) return current;
      try { return this.transition(current, event); }
      catch (error) { if (!isVersionConflict(error)) throw error; }
    }
    throw new Error("Telegram job transition conflict");
  }

  private requireJob(jobId: string): TelegramJob {
    const job = this.options.store.get(boundedId(jobId));
    if (!job) throw new Error("Unknown Telegram job");
    return job;
  }

  private lanes(job: TelegramJob): readonly string[] {
    const lanes = [this.topicLane(job)];
    if (job.threadId) lanes.push(`thread:${job.threadId}`);
    return lanes;
  }

  private topicLane(job: TelegramJob): string {
    const raw = this.options.store.readSourcePayload(job.id);
    if (!raw || typeof raw !== "object") throw new Error("Malformed Telegram work source");
    const source = raw as { chatId?: unknown; messageThreadId?: unknown };
    if (!Number.isSafeInteger(source.chatId) || (source.messageThreadId !== null && !Number.isSafeInteger(source.messageThreadId))) {
      throw new Error("Malformed Telegram work source");
    }
    return `topic:${source.chatId}:${source.messageThreadId ?? "main"}`;
  }

  private schedule(at: number): void {
    this.options.scheduleWakeup?.(at, () => { if (!this.disposed) void this.pump(); });
  }
}

function awaitingTargetProvision(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return source.targetProvision !== undefined && source.targetContext === undefined;
}
