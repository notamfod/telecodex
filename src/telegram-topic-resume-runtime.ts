import { createHash, randomUUID } from "node:crypto";

import type { CodexThreadRecord } from "./codex-state.js";
import type { TelegramWorkSource } from "./telegram-job-ingress.js";
import type { SqliteTelegramJobStore } from "./telegram-job-store.js";
import type { TelegramJob } from "./telegram-job-types.js";
import { telegramRetryAfterMs } from "./telegram-rate-limit.js";
import type { TelegramStatusAction } from "./telegram-status-projection.js";
import type { ForumTopicLiveness } from "./telegram-topic-liveness.js";
import { planTelegramTopicResume, type TelegramTopicResumeCandidate }
  from "./telegram-topic-resume.js";
import type {
  TelegramTopicResumeExternalEligibilitySnapshot,
  TelegramTopicResumeReasonCode,
  TelegramTopicResumeRecord,
  TelegramTopicResumeResult,
  TelegramTopicResumeState,
} from "./telegram-topic-resume-ledger.js";
import type { TelegramTopicDestination } from "./telegram-topic-recovery.js";
import {
  boundedAdd,
  boundedOperationTimeout,
  destinationFromSource,
  eventId,
  immediateTelegramRetryAfterMs,
  isDefinitiveTelegram4xx,
  monotonicNow,
  requireJob,
} from "./telegram-topic-resume-runtime-support.js";

const OPERATION_CANCELLED = Symbol("telegram-topic-resume-operation-cancelled");
export type TopicResumeStore = Pick<
  SqliteTelegramJobStore,
  | "get" | "readSourcePayload" | "listDeliveries" | "getTopicRecovery"
  | "getStatusAnchorPlan" | "hasJobQuarantine" | "reserveTopicResume"
  | "transitionTopicResume" | "settleTopicResumeDelivery" | "getTopicResume"
  | "listTopicResumes"
>;

export interface TelegramTopicResumeRuntime {
  resume(action: TelegramStatusAction): Promise<void>;
  reconcile(): Promise<void>;
  dispose(): void;
}

export interface TelegramTopicResumeRuntimeOptions {
  readonly store: TopicResumeStore;
  readonly forumChatId: number;
  readonly classifyForumTopic: (destination: TelegramTopicDestination, signal: AbortSignal) =>
    Promise<"live" | "closed" | "missing">;
  readonly reopenForumTopic: (destination: TelegramTopicDestination, signal: AbortSignal) =>
    Promise<true>;
  readonly invalidateForumTopicLiveness?: (destination: TelegramTopicDestination) => void;
  readonly getThread: (threadId: string) => CodexThreadRecord | null;
  readonly hasThreadTopicBinding: (threadId: string, destination: TelegramTopicDestination) =>
    boolean;
  readonly outboxRetryFailed: (jobId: string, partKey: "status-anchor",
    expectedJobVersion: number) => Promise<void>;
  readonly outboxPump: () => Promise<void>;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly operationTimeoutMs?: number;
  readonly scheduleWakeup?: (at: number, wake: () => void | Promise<void>) => void;
  readonly trackEffect?: (effect: Promise<void>) => void;
}

export function createTelegramTopicResumeRuntime(
  options: TelegramTopicResumeRuntimeOptions,
): TelegramTopicResumeRuntime {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const operationTimeoutMs = boundedOperationTimeout(options.operationTimeoutMs);
  if (!Number.isSafeInteger(options.forumChatId) || options.forumChatId === 0) {
    throw new Error("Invalid Telegram topic resume forum");
  }
  const effects = new Map<string, Promise<void>>();
  const scheduled = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const activeOperations = new Set<{ cancel(): void }>();
  const probedUnknownAttempts = new Set<string>();
  let disposed = false;

  const track = (effect: Promise<void>): void => {
    try {
      options.trackEffect?.(effect);
    } catch { /* lifecycle observation is best effort */ }
  };

  const enqueue = (jobId: string, effect: () => Promise<void>): Promise<void> => {
    const previous = effects.get(jobId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (!disposed) await effect();
    });
    effects.set(jobId, next);
    track(next);
    void next.finally(() => {
      if (effects.get(jobId) === next) effects.delete(jobId);
    }).catch(() => {});
    return next;
  };

  const transition = (resume: TelegramTopicResumeRecord, state: TelegramTopicResumeState,
    reasonCode: TelegramTopicResumeReasonCode | null = null,
    nextAttemptAt: number | null = null): TelegramTopicResumeResult => {
    const externalEligibilitySnapshot = state === "reopen_in_flight"
      || state === "delivery_handoff"
      ? { externalEligibilitySnapshot: readExternalEligibilitySnapshot(options, resume) }
      : {};
    return options.store.transitionTopicResume({
      jobId: resume.jobId,
      expectedVersion: resume.currentJobVersion,
      actionToken: resume.actionToken,
      expectedState: resume.state,
      state,
      reasonCode,
      nextAttemptAt,
      updatedAt: monotonicNow(now, requireJob(options.store, resume.jobId), resume),
      ...externalEligibilitySnapshot,
    });
  };

  const settle = (resume: TelegramTopicResumeRecord): void => {
    const job = requireJob(options.store, resume.jobId);
    options.store.settleTopicResumeDelivery({
      jobId: resume.jobId,
      expectedVersion: job.version,
      actionToken: resume.actionToken,
      updatedAt: monotonicNow(now, job, resume),
    });
  };

  const handoff = async (resume: TelegramTopicResumeRecord): Promise<void> => {
    const current = options.store.getTopicResume(resume.jobId);
    if (!current || current.actionToken !== resume.actionToken
      || current.state !== "delivery_handoff") return;
    const job = requireJob(options.store, current.jobId);
    const anchors = options.store.listDeliveries(current.jobId)
      .filter((part) => part.partKey === "status-anchor");
    const anchor = anchors[0];
    const anchorCanStart = job.version === current.currentJobVersion
      && anchors.length === 1 && anchor?.state === "failed"
      && anchor.attemptCount === current.anchorAttemptBaseline
      && anchor.lastErrorCode === "telegram_permanent"
      && anchor.telegramMessageId === null && anchor.nextAttemptAt === null;
    try {
      if (anchorCanStart) {
        await options.outboxRetryFailed(current.jobId, "status-anchor", current.currentJobVersion);
      } else if (job.version > current.currentJobVersion) {
        await options.outboxPump();
      }
    } finally {
      settle(current);
    }
  };

  const enterHandoff = async (resume: TelegramTopicResumeRecord,
    staleReason: TelegramTopicResumeReasonCode | null): Promise<void> => {
    if (!externalStateIsCurrent(options, resume)) {
      if (staleReason !== null) transition(resume, "failed", staleReason);
      return;
    }
    const handedOff = transition(resume, "delivery_handoff");
    await handoff(handedOff.resume);
  };

  const scheduleRetry = (resume: TelegramTopicResumeRecord): void => {
    const at = resume.nextAttemptAt;
    if (at === null || disposed || scheduled.get(resume.jobId) === at) return;
    scheduled.set(resume.jobId, at);
    const wake = (): void | Promise<void> => {
      if (disposed || scheduled.get(resume.jobId) !== at) return;
      scheduled.delete(resume.jobId);
      return enqueue(resume.jobId, async () => {
        const current = options.store.getTopicResume(resume.jobId);
        if (!current || current.actionToken !== resume.actionToken
          || current.nextAttemptAt === null || current.nextAttemptAt > now()) return;
        if (current.state === "probe_retry_wait") {
          const probing = transition(current, "probe_in_flight");
          await probe(probing, "initial");
        } else if (current.state === "reopen_retry_wait") {
          const reopening = transition(current, "reopen_in_flight");
          await reopen(reopening);
        } else if (current.state === "reopen_unknown") {
          await probe({ job: requireJob(options.store, current.jobId), resume: current }, "unknown");
        }
      });
    };
    if (options.scheduleWakeup) {
      options.scheduleWakeup(at, wake);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      void wake();
    }, Math.max(0, at - now()));
    timers.add(timer);
  };

  const deferProbe = (resume: TelegramTopicResumeRecord, retryAfterMs: number): void => {
    const updatedAt = monotonicNow(now, requireJob(options.store, resume.jobId), resume);
    const result = resume.state === "reopen_unknown"
      ? options.store.transitionTopicResume({
          jobId: resume.jobId,
          expectedVersion: resume.currentJobVersion,
          actionToken: resume.actionToken,
          expectedState: "reopen_unknown",
          state: "reopen_unknown",
          reasonCode: "TOPIC_RESUME_PROBE_RATE_LIMITED",
          nextAttemptAt: boundedAdd(updatedAt, retryAfterMs),
          updatedAt,
        })
      : options.store.transitionTopicResume({
          jobId: resume.jobId,
          expectedVersion: resume.currentJobVersion,
          actionToken: resume.actionToken,
          expectedState: "probe_in_flight",
          state: "probe_retry_wait",
          reasonCode: "TOPIC_RESUME_PROBE_RATE_LIMITED",
          nextAttemptAt: boundedAdd(updatedAt, retryAfterMs),
          updatedAt,
        });
    scheduleRetry(result.resume);
  };

  const runOwnedOperation = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timeout!: ReturnType<typeof setTimeout>;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        timers.delete(timeout);
        activeOperations.delete(active);
        return true;
      };
      const active = {
        cancel: () => {
          controller.abort();
          if (finish()) reject(OPERATION_CANCELLED);
        },
      };
      timeout = setTimeout(() => {
        controller.abort();
        if (finish()) reject(new Error("Telegram topic resume operation timed out"));
      }, operationTimeoutMs);
      timers.add(timeout);
      activeOperations.add(active);
      let result: Promise<T>;
      try {
        result = operation(controller.signal);
      } catch (error) {
        if (finish()) reject(error);
        return;
      }
      void result.then(
        (value) => { if (finish()) resolve(value); },
        (error) => { if (finish()) reject(error); },
      );
    });
  };

  const reopen = async (result: TelegramTopicResumeResult): Promise<void> => {
    const resume = result.resume;
    if (!externalStateIsCurrent(options, resume)) {
      transition(resume, "failed", "TOPIC_RESUME_REOPEN_FAILED");
      return;
    }
    options.invalidateForumTopicLiveness?.(resume.destination);
    try {
      await runOwnedOperation((signal) => options.reopenForumTopic(resume.destination, signal));
    } catch (error) {
      const retryAfterMs = immediateTelegramRetryAfterMs(error);
      if (retryAfterMs !== undefined) {
        const updatedAt = monotonicNow(now, requireJob(options.store, resume.jobId), resume);
        const waiting = options.store.transitionTopicResume({
          jobId: resume.jobId,
          expectedVersion: resume.currentJobVersion,
          actionToken: resume.actionToken,
          expectedState: "reopen_in_flight",
          state: "reopen_retry_wait",
          reasonCode: "TOPIC_RESUME_REOPEN_RATE_LIMITED",
          nextAttemptAt: boundedAdd(updatedAt, retryAfterMs),
          updatedAt,
        });
        scheduleRetry(waiting.resume);
      } else if (isDefinitiveTelegram4xx(error)) {
        transition(resume, "failed", "TOPIC_RESUME_REOPEN_FAILED");
      } else {
        const unknown = transition(resume, "reopen_unknown", "TOPIC_RESUME_REOPEN_UNKNOWN");
        if (!disposed) {
          probedUnknownAttempts.add(unknown.resume.actionToken);
          await probe(unknown, "unknown");
        }
      }
      return;
    }
    if (!disposed) await enterHandoff(resume, "TOPIC_RESUME_REOPEN_FAILED");
  };

  const probe = async (result: TelegramTopicResumeResult,
    mode: "initial" | "unknown"): Promise<void> => {
    const resume = result.resume;
    let liveness: ForumTopicLiveness;
    try {
      liveness = await runOwnedOperation(
        (signal) => options.classifyForumTopic(resume.destination, signal),
      );
    } catch (error) {
      if (error === OPERATION_CANCELLED) return;
      const retryAfterMs = telegramRetryAfterMs(error);
      if (retryAfterMs !== undefined) {
        deferProbe(resume, retryAfterMs);
      } else if (mode === "initial") {
        transition(resume, "failed", "TOPIC_RESUME_PROBE_UNKNOWN");
      }
      return;
    }
    if (disposed) return;
    if (mode === "unknown") {
      if (liveness === "live") await enterHandoff(resume, null);
      return;
    }
    if (liveness === "missing") {
      transition(resume, "failed", "TOPIC_RESUME_SOURCE_MISSING");
    } else if (liveness === "closed") {
      const reopening = transition(resume, "reopen_in_flight");
      await reopen(reopening);
    } else {
      await enterHandoff(resume, "TOPIC_RESUME_SOURCE_MISSING");
    }
  };

  const resume = (action: TelegramStatusAction): Promise<void> => {
    assertRunning(disposed);
    return enqueue(action.jobId, async () => {
      if (options.store.getTopicResume(action.jobId)) return;
      const job = options.store.get(action.jobId);
      if (!job?.threadId || job.version !== action.expectedVersion) {
        throw new Error("Telegram topic resume is no longer eligible");
      }
      const source = options.store.readSourcePayload(job.id) as TelegramWorkSource | null;
      const destination = destinationFromSource(source);
      const thread = options.getThread(job.threadId);
      const snapshot = {
        thread,
        forumChatId: options.forumChatId,
        hasThreadTopicBinding: thread !== null
          && options.hasThreadTopicBinding(thread.id, destination),
      };
      const candidate = currentCandidate(options, job, source, snapshot);
      if (!candidate || candidate.expectedVersion !== action.expectedVersion) {
        throw new Error("Telegram topic resume is no longer eligible");
      }
      const reserved = options.store.reserveTopicResume({
        candidate,
        externalEligibilitySnapshot: snapshot,
        eventId: eventId(createId, "reserve"),
        actionToken: createHash("sha256").update(createId()).digest("hex"),
        eventAt: monotonicNow(now, requireJob(options.store, candidate.jobId)),
      });
      await probe(reserved, "initial");
    });
  };

  return {
    resume,
    async reconcile() {
      assertRunning(disposed);
      const inheritedReopens = options.store.listTopicResumes(["reopen_in_flight"]);
      const inheritedProbes = options.store.listTopicResumes(["probe_in_flight"]);
      const inheritedWaiting = options.store.listTopicResumes([
        "probe_retry_wait",
        "reopen_retry_wait",
      ]);
      const inheritedUnknown = options.store.listTopicResumes(["reopen_unknown"]);
      const inheritedHandoffs = options.store.listTopicResumes(["delivery_handoff"]);
      for (const inherited of inheritedReopens) {
        await enqueue(inherited.jobId, async () => {
          const current = options.store.getTopicResume(inherited.jobId);
          if (current?.state === "reopen_in_flight" && current.actionToken === inherited.actionToken) {
            transition(current, "reopen_unknown", "TOPIC_RESUME_REOPEN_UNKNOWN");
          }
        });
      }
      for (const inherited of inheritedProbes) {
        await enqueue(inherited.jobId, async () => {
          const current = options.store.getTopicResume(inherited.jobId);
          if (current?.state === "probe_in_flight" && current.actionToken === inherited.actionToken) {
            await probe({ job: requireJob(options.store, current.jobId), resume: current }, "initial");
          }
        });
      }
      for (const waiting of inheritedWaiting) {
        scheduleRetry(waiting);
      }
      for (const unknown of inheritedUnknown) {
        if (unknown.nextAttemptAt !== null && unknown.nextAttemptAt > now()) {
          scheduleRetry(unknown);
          continue;
        }
        await enqueue(unknown.jobId, async () => {
          const current = options.store.getTopicResume(unknown.jobId);
          if (current?.state === "reopen_unknown" && current.actionToken === unknown.actionToken) {
            if (probedUnknownAttempts.has(current.actionToken)) return;
            probedUnknownAttempts.add(current.actionToken);
            await probe({ job: requireJob(options.store, current.jobId), resume: current }, "unknown");
          }
        });
      }
      for (const inherited of inheritedHandoffs) {
        await enqueue(inherited.jobId, () => handoff(inherited));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduled.clear();
      for (const operation of [...activeOperations]) operation.cancel();
      activeOperations.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      probedUnknownAttempts.clear();
    },
  };
}

function currentCandidate(options: TelegramTopicResumeRuntimeOptions, job: TelegramJob,
  source: TelegramWorkSource | null, external: {
  readonly thread: CodexThreadRecord | null;
  readonly forumChatId: number;
  readonly hasThreadTopicBinding: boolean;
}): TelegramTopicResumeCandidate | null {
  if (!source) return null;
  return planTelegramTopicResume({
    job,
    source,
    deliveries: options.store.listDeliveries(job.id),
    anchorPlan: options.store.getStatusAnchorPlan(job.id),
    thread: external.thread,
    recovery: options.store.getTopicRecovery(job.id),
    hasExistingAttempt: options.store.getTopicResume(job.id) !== null,
    forumChatId: external.forumChatId,
    hasThreadTopicBinding: external.hasThreadTopicBinding,
    quarantined: options.store.hasJobQuarantine(job.id),
  });
}

function externalStateIsCurrent(options: TelegramTopicResumeRuntimeOptions,
  resume: TelegramTopicResumeRecord): boolean {
  const job = options.store.get(resume.jobId);
  if (!job?.threadId || job.version !== resume.currentJobVersion
    || resume.destination.chatId !== options.forumChatId) return false;
  const external = readExternalEligibilitySnapshot(options, resume);
  return external.thread !== null && external.thread.id === job.threadId
    && external.hasThreadTopicBinding;
}

function readExternalEligibilitySnapshot(
  options: TelegramTopicResumeRuntimeOptions,
  resume: TelegramTopicResumeRecord,
): TelegramTopicResumeExternalEligibilitySnapshot {
  const job = options.store.get(resume.jobId);
  const thread = job?.threadId ? options.getThread(job.threadId) : null;
  return {
    thread,
    forumChatId: options.forumChatId,
    hasThreadTopicBinding: thread !== null
      && options.hasThreadTopicBinding(thread.id, resume.destination),
  };
}

function assertRunning(disposed: boolean): void {
  if (disposed) throw new Error("Telegram topic resume runtime is disposed");
}
