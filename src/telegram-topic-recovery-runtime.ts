import { createHash, randomUUID } from "node:crypto";

import type { CodexThreadRecord } from "./codex-state.js";
import { contextKeyFromMessage } from "./context-key.js";
import type { SqliteTelegramJobStore } from "./telegram-job-store.js";
import type { TelegramJob } from "./telegram-job-types.js";
import { telegramRetryAfterMs } from "./telegram-rate-limit.js";
import type { TelegramStatusAction } from "./telegram-status-projection.js";
import {
  planTelegramTopicRecovery,
  type TelegramTopicDestination,
  type TelegramTopicRecoveryCandidate,
} from "./telegram-topic-recovery.js";
import type {
  TelegramTopicRecoveryRecord,
  TelegramTopicRecoveryResult,
} from "./telegram-topic-recovery-ledger.js";
import type { TelegramWorkSource } from "./telegram-job-ingress.js";

const DEFAULT_CREATION_TIMEOUT_MS = 30_000;
const MAX_CREATION_TIMEOUT_MS = 300_000;

type TopicRecoveryStore = Pick<
  SqliteTelegramJobStore,
  | "get"
  | "readSourcePayload"
  | "listDeliveries"
  | "reserveTopicRecovery"
  | "deferTopicRecovery"
  | "resumeTopicRecovery"
  | "markTopicRecoveryUnknown"
  | "failTopicRecovery"
  | "completeTopicRecovery"
  | "getTopicRecovery"
  | "listTopicRecoveries"
>;

interface TelegramTopicRecoveryPlan {
  readonly candidate: TelegramTopicRecoveryCandidate;
  readonly thread: CodexThreadRecord;
}

export type TelegramTopicRecoveryRuntimeReasonCode =
  | "TOPIC_RECOVERY_BIND_FAILED"
  | "TOPIC_RECOVERY_WELCOME_FAILED";

export interface TelegramTopicRecoveryRuntimeOptions {
  readonly store: TopicRecoveryStore;
  readonly forumChatId: number;
  readonly hasThreadTopicBinding: (
    threadId: string,
    destination: TelegramTopicDestination,
  ) => boolean;
  readonly probeForumTopic: (destination: TelegramTopicDestination) => Promise<boolean>;
  readonly createForumTopic: (input: {
    readonly chatId: number;
    readonly topicName: string;
    readonly signal: AbortSignal;
  }) => Promise<TelegramTopicDestination>;
  readonly getThread: (threadId: string) => CodexThreadRecord | null;
  readonly rebindThreadTopic: (
    oldContextKey: string,
    newContextKey: string,
    thread: CodexThreadRecord,
  ) => void;
  readonly sendWelcome: (
    destination: TelegramTopicDestination,
    topicName: string,
  ) => Promise<void>;
  readonly outboxPump: () => Promise<void>;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly creationTimeoutMs?: number;
  readonly scheduleWakeup?: (at: number, wake: () => void | Promise<void>) => void;
  readonly reportReason?: (input: {
    readonly jobId: string;
    readonly reasonCode: TelegramTopicRecoveryRuntimeReasonCode;
  }) => void;
}

export interface TelegramTopicRecoveryRuntime {
  recover(action: TelegramStatusAction): Promise<void>;
  reconcile(): Promise<void>;
  dispose(): void;
}

export function createTelegramTopicRecoveryRuntime(
  options: TelegramTopicRecoveryRuntimeOptions,
): TelegramTopicRecoveryRuntime {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const creationTimeoutMs = boundedCreationTimeout(options.creationTimeoutMs);
  if (!Number.isSafeInteger(options.forumChatId) || options.forumChatId === 0) {
    throw new Error("Invalid Telegram topic recovery forum");
  }
  const effects = new Map<string, Promise<void>>();
  const scheduled = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  const report = (jobId: string, reasonCode: TelegramTopicRecoveryRuntimeReasonCode): void => {
    try { options.reportReason?.({ jobId, reasonCode }); }
    catch { /* Observability must not replace the recovery outcome. */ }
  };

  const enqueue = (jobId: string, effect: () => Promise<void>): Promise<void> => {
    const previous = effects.get(jobId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (!disposed) await effect();
    });
    effects.set(jobId, next);
    void next.finally(() => {
      if (effects.get(jobId) === next) effects.delete(jobId);
    }).catch(() => {});
    return next;
  };

  const bind = (
    recovery: TelegramTopicRecoveryRecord,
    thread: CodexThreadRecord,
  ): void => {
    if (recovery.newMessageThreadId === null) throw new Error("Topic recovery is incomplete");
    options.rebindThreadTopic(
      contextKeyFromMessage(
        recovery.oldDestination.chatId,
        recovery.oldDestination.messageThreadId,
      ),
      contextKeyFromMessage(recovery.oldDestination.chatId, recovery.newMessageThreadId),
      thread,
    );
  };

  const finishLocalEffects = async (
    jobId: string,
    recovery: TelegramTopicRecoveryRecord,
    thread: CodexThreadRecord,
    topicName: string,
  ): Promise<void> => {
    try { bind(recovery, thread); }
    catch { report(jobId, "TOPIC_RECOVERY_BIND_FAILED"); }
    const destination = {
      chatId: recovery.oldDestination.chatId,
      messageThreadId: recovery.newMessageThreadId!,
    };
    void Promise.resolve()
      .then(() => options.sendWelcome(destination, topicName))
      .catch(() => report(jobId, "TOPIC_RECOVERY_WELCOME_FAILED"));
    await options.outboxPump();
  };

  const fail = (result: TelegramTopicRecoveryResult): void => {
    options.store.failTopicRecovery({
      jobId: result.recovery.jobId,
      expectedVersion: result.recovery.currentJobVersion,
      actionToken: result.recovery.actionToken,
      reasonCode: "TOPIC_RECOVERY_FAILED",
      updatedAt: monotonicNow(now, result.job, result.recovery),
    });
  };

  const markUnknown = (result: TelegramTopicRecoveryResult): void => {
    options.store.markTopicRecoveryUnknown({
      jobId: result.recovery.jobId,
      expectedVersion: result.recovery.currentJobVersion,
      actionToken: result.recovery.actionToken,
      reasonCode: "TOPIC_RECOVERY_UNKNOWN",
      updatedAt: monotonicNow(now, result.job, result.recovery),
    });
  };

  const scheduleRetry = (recovery: TelegramTopicRecoveryRecord): void => {
    const at = recovery.nextAttemptAt;
    if (at === null || scheduled.get(recovery.jobId) === at || disposed) return;
    scheduled.set(recovery.jobId, at);
    const wake = (): void | Promise<void> => {
      if (disposed || scheduled.get(recovery.jobId) !== at) return;
      scheduled.delete(recovery.jobId);
      return enqueue(recovery.jobId, async () => {
        const current = options.store.getTopicRecovery(recovery.jobId);
        if (!current || current.state !== "retry_wait" || current.actionToken !== recovery.actionToken
          || current.nextAttemptAt === null || current.nextAttemptAt > now()) return;
        const plan = recoveryPlan(options, current.jobId);
        if (!plan || plan.candidate.expectedVersion !== current.currentJobVersion) return;
        const resumed = options.store.resumeTopicRecovery({
          jobId: current.jobId,
          expectedVersion: current.currentJobVersion,
          actionToken: current.actionToken,
          updatedAt: monotonicNow(now, requireJob(options.store, current.jobId), current),
        });
        await attempt(resumed, plan);
      });
    };
    if (options.scheduleWakeup) {
      options.scheduleWakeup(at, wake);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      wake();
    }, Math.max(0, at - now()));
    timers.add(timer);
  };

  const defer = (result: TelegramTopicRecoveryResult, retryAfterMs: number): void => {
    const updatedAt = monotonicNow(now, result.job, result.recovery);
    const recovery = options.store.deferTopicRecovery({
      jobId: result.recovery.jobId,
      expectedVersion: result.recovery.currentJobVersion,
      actionToken: result.recovery.actionToken,
      updatedAt,
      nextAttemptAt: boundedAdd(updatedAt, retryAfterMs),
    });
    scheduleRetry(recovery);
  };

  const handleFailure = (result: TelegramTopicRecoveryResult, error: unknown): void => {
    const retryAfterMs = telegramRetryAfterMs(error);
    if (retryAfterMs !== undefined) {
      defer(result, retryAfterMs);
      return;
    }
    if (isDefinitiveTelegramError(error)) fail(result);
    else markUnknown(result);
  };

  const attempt = async (
    result: TelegramTopicRecoveryResult,
    plan: TelegramTopicRecoveryPlan,
  ): Promise<void> => {
    const candidate = plan.candidate;
    try {
      if (await options.probeForumTopic(result.recovery.oldDestination)) {
        fail(result);
        return;
      }
    } catch (error) {
      handleFailure(result, error);
      return;
    }

    const controller = new AbortController();
    let target: TelegramTopicDestination;
    try {
      target = await withCreationTimeout(
        options.createForumTopic({
          chatId: result.recovery.oldDestination.chatId,
          topicName: candidate.topicName,
          signal: controller.signal,
        }),
        creationTimeoutMs,
        controller,
      );
      if (!validTarget(target, result.recovery.oldDestination)) {
        markUnknown(result);
        return;
      }
    } catch (error) {
      handleFailure(result, error);
      return;
    }

    const completed = options.store.completeTopicRecovery({
      jobId: result.recovery.jobId,
      expectedVersion: result.recovery.currentJobVersion,
      eventId: eventId(createId, "complete"),
      actionToken: result.recovery.actionToken,
      target,
      eventAt: monotonicNow(now, result.job, result.recovery),
    });
    await finishLocalEffects(
      candidate.jobId,
      completed.recovery,
      plan.thread,
      candidate.topicName,
    );
  };

  const recover = (action: TelegramStatusAction): Promise<void> => {
    assertRunning(disposed);
    return enqueue(action.jobId, async () => {
      if (options.store.getTopicRecovery(action.jobId)) return;
      const plan = recoveryPlan(options, action.jobId);
      if (!plan || plan.candidate.expectedVersion !== action.expectedVersion) {
        throw new Error("Telegram topic recovery is no longer eligible");
      }
      const reserved = options.store.reserveTopicRecovery({
        candidate: plan.candidate,
        eventId: eventId(createId, "reserve"),
        actionToken: createHash("sha256").update(createId()).digest("hex"),
        eventAt: monotonicNow(now, requireJob(options.store, plan.candidate.jobId)),
      });
      await attempt(reserved, plan);
    });
  };

  return {
    recover,
    async reconcile() {
      assertRunning(disposed);
      for (const recovery of options.store.listTopicRecoveries(["in_flight"])) {
        await enqueue(recovery.jobId, async () => {
          const current = options.store.getTopicRecovery(recovery.jobId);
          if (!current || current.state !== "in_flight") return;
          markUnknown({ job: requireJob(options.store, current.jobId), recovery: current });
        });
      }
      for (const recovery of options.store.listTopicRecoveries(["retry_wait"])) {
        scheduleRetry(recovery);
      }
      for (const recovery of options.store.listTopicRecoveries(["complete"])) {
        await enqueue(recovery.jobId, async () => {
          const current = options.store.getTopicRecovery(recovery.jobId);
          if (!current || current.state !== "complete") return;
          const job = requireJob(options.store, current.jobId);
          const thread = job.threadId ? options.getThread(job.threadId) : null;
          if (!thread || thread.id !== job.threadId) {
            report(current.jobId, "TOPIC_RECOVERY_BIND_FAILED");
            return;
          }
          try { bind(current, thread); }
          catch { report(current.jobId, "TOPIC_RECOVERY_BIND_FAILED"); }
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduled.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function recoveryPlan(
  options: TelegramTopicRecoveryRuntimeOptions,
  jobId: string,
): TelegramTopicRecoveryPlan | null {
  const store = options.store;
  const job = store.get(jobId);
  if (!job || !job.threadId) return null;
  const thread = options.getThread(job.threadId);
  if (!thread) return null;
  const deliveries = store.listDeliveries(job.id);
  const anchors = deliveries.filter((part) => part.partKey === "status-anchor");
  if (anchors.length !== 1) return null;
  const anchor = anchors[0]!;
  const source = store.readSourcePayload(job.id) as TelegramWorkSource | null;
  if (!source) return null;
  const candidate = planTelegramTopicRecovery({
    job,
    source,
    deliveries,
    anchorPlan: { payload: anchor.payload, contentHash: anchor.contentHash },
    thread,
  });
  return candidate
    && candidate.oldDestination.chatId === options.forumChatId
    && options.hasThreadTopicBinding(candidate.threadId, candidate.oldDestination)
    ? { candidate, thread }
    : null;
}

function requireJob(store: TopicRecoveryStore, jobId: string): TelegramJob {
  const job = store.get(jobId);
  if (!job) throw new Error("Unknown Telegram job");
  return job;
}

function monotonicNow(
  now: () => number,
  job: TelegramJob,
  recovery?: TelegramTopicRecoveryRecord,
): number {
  return Math.max(now(), job.updatedAt, recovery?.updatedAt ?? 0);
}

function boundedCreationTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CREATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CREATION_TIMEOUT_MS) {
    throw new Error("Invalid Telegram topic recovery timeout");
  }
  return timeout;
}

function boundedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid topic recovery deadline");
  return result;
}

function eventId(createId: () => string, purpose: string): string {
  const digest = createHash("sha256").update(createId()).digest("hex");
  return `topic-recovery:${purpose}:${digest}`;
}

function validTarget(
  target: TelegramTopicDestination,
  oldDestination: TelegramTopicDestination,
): boolean {
  return Number.isSafeInteger(target.chatId) && target.chatId === oldDestination.chatId
    && Number.isSafeInteger(target.messageThreadId) && target.messageThreadId > 0
    && target.messageThreadId !== oldDestination.messageThreadId;
}

function isDefinitiveTelegramError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = record(error);
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const code = current.error_code;
    if (typeof code === "number" && Number.isFinite(code)) return code >= 400 && code < 500;
    current = record(current.error);
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function withCreationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Telegram topic creation result is unknown"));
    }, timeoutMs);
    void operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function assertRunning(disposed: boolean): void {
  if (disposed) throw new Error("Telegram topic recovery runtime is disposed");
}
