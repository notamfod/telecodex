import { vi } from "vitest";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { DeliveryPart } from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import type { TelegramTopicResumeRuntimeOptions }
  from "../src/telegram-topic-resume-runtime.js";
import type {
  TelegramTopicResumeRecord,
  TelegramTopicResumeState,
} from "../src/telegram-topic-resume-ledger.js";
import {
  hashTelegramTopicResumeTopology,
  isTelegramTopicResumeContinuationValid,
} from "../src/telegram-topic-resume.js";
import type { TelegramStatusAction } from "../src/telegram-status-projection.js";

export const NOW = 10_000;
export const DESTINATION = { chatId: -1001, messageThreadId: 41 } as const;

type DeliveryOutcome = "pending" | "failed" | "uncertain" | "complete";

export function createHarness(settings: {
  liveness?: "live" | "closed" | "missing";
  classifyResults?: readonly unknown[];
  reopenResults?: readonly unknown[];
  initialState?: TelegramTopicResumeState;
  handoffVersionAdvanced?: boolean;
  outboxOutcome?: DeliveryOutcome;
  bindingResults?: readonly boolean[];
  classifyNeverSettles?: boolean;
  reopenNeverSettles?: boolean;
  handoffAnchorMutation?: Partial<DeliveryPart>;
} = {}) {
  let clock = NOW;
  const calls: string[] = [];
  const thread: CodexThreadRecord = {
    id: "thread-1",
    title: "Resume topic",
    cwd: "/work/telecodex",
    model: null,
    modelProvider: null,
    createdAt: new Date(1_000),
    updatedAt: new Date(2_000),
    firstUserMessage: "resume",
  };
  const source = {
    botId: "bot",
    updateId: 1,
    ...DESTINATION,
    messageId: 1,
    kind: "text" as const,
    text: "request",
    attachment: null,
    retryOfJobId: null,
  };
  const anchorPayload = { operation: "send_text" as const, ...DESTINATION, text: "Anchor" };
  const finalPayload = {
    operation: "send_rich" as const,
    ...DESTINATION,
    markdown: "Result",
    media: [],
    fallbackParts: [{
      partKey: "final:0000:fallback:0000",
      kind: "final" as const,
      payload: { operation: "send_text" as const, ...DESTINATION, text: "Result" },
    }],
  };
  const noticePayload = { operation: "send_text" as const, ...DESTINATION, text: "Notice" };
  let deliveries: DeliveryPart[] = [
    delivery("status-anchor", 0, "status-anchor", "failed", anchorPayload, 1, NOW - 4),
    delivery("final:0000", 0, "final", "pending", finalPayload, 0, NOW - 5),
    delivery("notice:0001", 1, "notice", "pending", noticePayload, 0, NOW - 5),
  ];
  let job: TelegramJob = {
    schemaVersion: 1,
    version: 9,
    id: "job-1",
    source: { botId: source.botId, updateId: source.updateId },
    attachments: [],
    phase: "delivering",
    health: "stalled",
    activity: "unknown",
    attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
    outcome: null,
    dispatchId: "dispatch-1",
    threadId: thread.id,
    turnId: "turn-1",
    responsePlan: [
      { partId: "final:0000", kind: "final" },
      { partId: "notice:0001", kind: "notice" },
    ],
    deliveries: [
      { partId: "final:0000", state: "pending", attempts: 0, messageId: null, deliveredAt: null },
      { partId: "notice:0001", state: "pending", attempts: 0, messageId: null, deliveredAt: null },
    ],
    acceptedAt: NOW - 20,
    updatedAt: NOW - 1,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
  const anchorPlan = {
    payload: anchorPayload,
    contentHash: hashTelegramDeliveryPayload(anchorPayload),
  };
  const recovery = {
    jobId: job.id,
    actionToken: "b".repeat(64),
    state: "failed" as const,
    oldDestination: DESTINATION,
    newMessageThreadId: null,
    reservedJobVersion: 7,
    currentJobVersion: job.version,
    nextAttemptAt: null,
    reasonCode: "TOPIC_RECOVERY_FAILED" as const,
    startedAt: NOW - 10,
    updatedAt: NOW - 2,
  };
  const initialResumeVersion = 10;
  let resume: TelegramTopicResumeRecord | null = settings.initialState ? {
    jobId: job.id,
    actionToken: "a".repeat(64),
    state: settings.initialState,
    mode: "standard",
    anchorAttemptBaseline: 1,
    recoveryJobVersionBaseline: job.version,
    deliveryTopologyHash: hashTelegramTopicResumeTopology(job, deliveries),
    destination: DESTINATION,
    reservedJobVersion: 9,
    currentJobVersion: initialResumeVersion,
    nextAttemptAt: settings.initialState === "probe_retry_wait"
      || settings.initialState === "reopen_retry_wait" ? NOW : null,
    reasonCode: settings.initialState === "probe_retry_wait" ? "TOPIC_RESUME_PROBE_RATE_LIMITED"
      : settings.initialState === "reopen_retry_wait" ? "TOPIC_RESUME_REOPEN_RATE_LIMITED"
        : settings.initialState === "reopen_unknown" ? "TOPIC_RESUME_REOPEN_UNKNOWN"
          : null,
    startedAt: NOW - 2,
    updatedAt: NOW - 1,
  } : null;
  if (resume) job = { ...job, version: initialResumeVersion };
  if (settings.handoffVersionAdvanced) job = { ...job, version: initialResumeVersion + 1 };

  const advance = (updatedAt: number) => {
    job = { ...job, version: job.version + 1, updatedAt };
  };
  const store = {
    get: vi.fn(() => structuredClone(job)),
    readSourcePayload: vi.fn(() => structuredClone(source)),
    listDeliveries: vi.fn(() => structuredClone(deliveries)),
    getTopicRecovery: vi.fn(() => structuredClone(recovery)),
    getStatusAnchorPlan: vi.fn(() => structuredClone(anchorPlan)),
    hasJobQuarantine: vi.fn(() => false),
    getTopicResume: vi.fn(() => resume ? structuredClone(resume) : null),
    listTopicResumes: vi.fn((states: readonly TelegramTopicResumeState[]) =>
      resume && states.includes(resume.state) ? [structuredClone(resume)] : []),
    reserveTopicResume: vi.fn((input: {
      actionToken: string;
      eventAt: number;
      candidate: { expectedVersion: number };
    }) => {
      calls.push("reserve");
      if (resume || input.candidate.expectedVersion !== job.version) {
        throw new Error("Telegram topic resume conflict");
      }
      const reservedJobVersion = job.version;
      advance(input.eventAt);
      resume = {
        jobId: job.id,
        actionToken: input.actionToken,
        state: "probe_in_flight",
        mode: "standard",
        anchorAttemptBaseline: 1,
        recoveryJobVersionBaseline: reservedJobVersion,
        deliveryTopologyHash: hashTelegramTopicResumeTopology(job, deliveries),
        destination: DESTINATION,
        reservedJobVersion,
        currentJobVersion: job.version,
        nextAttemptAt: null,
        reasonCode: null,
        startedAt: input.eventAt,
        updatedAt: input.eventAt,
      };
      return { job: structuredClone(job), resume: structuredClone(resume) };
    }),
    transitionTopicResume: vi.fn((input: {
      expectedVersion: number;
      expectedState: TelegramTopicResumeState;
      state: TelegramTopicResumeState;
      externalEligibilitySnapshot?: {
        thread: CodexThreadRecord | null;
        forumChatId: number;
        hasThreadTopicBinding: boolean;
      };
      nextAttemptAt?: number | null;
      reasonCode?: TelegramTopicResumeRecord["reasonCode"];
      updatedAt: number;
    }) => {
      if (!resume || resume.currentJobVersion !== input.expectedVersion
        || resume.state !== input.expectedState) throw new Error("Telegram topic resume conflict");
      if (input.state === "reopen_in_flight" || input.state === "delivery_handoff") {
        const external = input.externalEligibilitySnapshot;
        if (!external || !isTelegramTopicResumeContinuationValid({
          job,
          source,
          deliveries,
          anchorPlan,
          thread: external.thread,
          recovery,
          hasExistingAttempt: true,
          forumChatId: external.forumChatId,
          hasThreadTopicBinding: external.hasThreadTopicBinding,
          quarantined: false,
          mode: resume.mode,
          reservedJobVersion: resume.reservedJobVersion,
          currentJobVersion: resume.currentJobVersion,
          anchorAttemptBaseline: resume.anchorAttemptBaseline,
          recoveryJobVersionBaseline: resume.recoveryJobVersionBaseline,
          deliveryTopologyHash: resume.deliveryTopologyHash,
        })) throw new Error("Telegram topic resume conflict");
      }
      calls.push(`transition:${input.state}`);
      advance(input.updatedAt);
      resume = {
        ...resume,
        state: input.state,
        currentJobVersion: job.version,
        nextAttemptAt: input.nextAttemptAt ?? null,
        reasonCode: input.reasonCode ?? null,
        updatedAt: input.updatedAt,
      };
      if (input.state === "delivery_handoff" && settings.handoffAnchorMutation) {
        deliveries = deliveries.map((part) => part.partKey === "status-anchor"
          ? { ...part, ...settings.handoffAnchorMutation }
          : part);
      }
      return { job: structuredClone(job), resume: structuredClone(resume) };
    }),
    settleTopicResumeDelivery: vi.fn((input: { expectedVersion: number; updatedAt: number }) => {
      if (!resume || input.expectedVersion !== job.version) {
        throw new Error("Telegram topic resume conflict");
      }
      const anchor = deliveries.find((part) => part.partKey === "status-anchor")!;
      if (anchor.state === "failed" && anchor.updatedAt > resume.updatedAt) {
        resume = { ...resume, state: "failed", reasonCode: "TOPIC_RESUME_DELIVERY_FAILED",
          currentJobVersion: job.version, updatedAt: input.updatedAt };
      } else if (anchor.state === "uncertain" && anchor.updatedAt > resume.updatedAt) {
        resume = { ...resume, state: "failed", reasonCode: "TOPIC_RESUME_DELIVERY_UNCERTAIN",
          currentJobVersion: job.version, updatedAt: input.updatedAt };
      } else if (job.phase === "terminal" && job.outcome === "completed"
        && deliveries.length === 3 && deliveries.every((part) => part.state === "delivered")
        && anchor.telegramMessageId !== null) {
        resume = { ...resume, state: "complete", reasonCode: null,
          currentJobVersion: job.version, updatedAt: input.updatedAt };
      }
      return structuredClone(resume);
    }),
  };

  const classifyQueue = [...(settings.classifyResults ?? [settings.liveness ?? "live"])];
  let classifySignal: AbortSignal | undefined;
  const classifyForumTopic = vi.fn(async (_destination, signal: AbortSignal) => {
    calls.push("probe");
    classifySignal = signal;
    if (settings.classifyNeverSettles) return new Promise<never>(() => {});
    const result = classifyQueue.shift() ?? settings.liveness ?? "live";
    if (result === "live" || result === "closed" || result === "missing") return result;
    throw result;
  });
  const reopenQueue = [...(settings.reopenResults ?? [true])];
  let reopenSignal: AbortSignal | undefined;
  const reopenForumTopic = vi.fn(async (_destination, signal: AbortSignal) => {
    calls.push("reopen");
    reopenSignal = signal;
    if (settings.reopenNeverSettles) return new Promise<never>(() => {});
    const result = reopenQueue.shift() ?? true;
    if (result === true) return true as const;
    throw result;
  });
  const invalidateForumTopicLiveness = vi.fn(() => { calls.push("invalidate"); });
  const applyOutboxOutcome = (outcome: DeliveryOutcome) => {
    if (outcome === "pending") return;
    const updatedAt = Math.max(clock, job.updatedAt, resume?.updatedAt ?? 0) + 1;
    if (outcome === "complete") {
      deliveries = deliveries.map((part, index) => ({
        ...part,
        state: "delivered",
        telegramMessageId: index + 1,
        updatedAt,
      }));
      job = { ...job, version: job.version + 4, phase: "terminal", outcome: "completed", updatedAt };
      return;
    }
    deliveries = deliveries.map((part) => part.partKey === "status-anchor"
      ? { ...part, state: outcome, updatedAt }
      : part);
    job = { ...job, version: job.version + 1, updatedAt };
  };
  const outboxRetryFailed = vi.fn(async () => applyOutboxOutcome(settings.outboxOutcome ?? "complete"));
  const outboxPump = vi.fn(async () => applyOutboxOutcome(settings.outboxOutcome ?? "pending"));
  const bindingQueue = [...(settings.bindingResults ?? [true])];
  const hasThreadTopicBinding = vi.fn(() => bindingQueue.shift() ?? true);
  const scheduled: Array<{ at: number; wake: () => Promise<void> }> = [];
  let id = 0;
  const options = {
    store,
    forumChatId: DESTINATION.chatId,
    classifyForumTopic,
    reopenForumTopic,
    invalidateForumTopicLiveness,
    getThread: vi.fn(() => structuredClone(thread)),
    hasThreadTopicBinding,
    outboxRetryFailed,
    outboxPump,
    now: () => clock,
    createId: () => `resume-${++id}`,
    operationTimeoutMs: 1_000,
    scheduleWakeup: (at: number, wake: () => void | Promise<void>) => {
      scheduled.push({ at, wake: async () => { await wake(); } });
    },
  } satisfies TelegramTopicResumeRuntimeOptions;
  const action: TelegramStatusAction = {
    kind: "retry_delivery",
    jobId: job.id,
    expectedVersion: job.version,
    partKey: "status-anchor",
  };
  return {
    options,
    action,
    store,
    thread,
    calls,
    scheduled,
    classifyForumTopic,
    reopenForumTopic,
    invalidateForumTopicLiveness,
    outboxRetryFailed,
    outboxPump,
    resume: () => resume,
    classifySignal: () => classifySignal,
    reopenSignal: () => reopenSignal,
    initialResumeVersion,
    advanceTo: (value: number) => { clock = value; },
  };
}

function delivery(
  partKey: string,
  ordinal: number,
  kind: string,
  state: DeliveryPart["state"],
  payload: unknown,
  attemptCount: number,
  updatedAt: number,
): DeliveryPart {
  return {
    jobId: "job-1",
    partKey,
    ordinal,
    kind,
    state,
    payload,
    contentHash: hashTelegramDeliveryPayload(payload),
    telegramMessageId: null,
    attemptCount,
    nextAttemptAt: null,
    lastErrorCode: state === "failed" ? "telegram_permanent" : null,
    updatedAt,
  };
}
