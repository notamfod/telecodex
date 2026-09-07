import { vi } from "vitest";

import type { CodexThreadRecord } from "../src/codex-state.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import {
  createTelegramTopicRecoveryRuntime,
  type TelegramTopicRecoveryRuntimeOptions,
} from "../src/telegram-topic-recovery-runtime.js";
import type { TelegramStatusAction } from "../src/telegram-status-projection.js";
import type {
  TelegramTopicRecoveryRecord,
  TelegramTopicRecoveryState,
} from "../src/telegram-topic-recovery-ledger.js";

const NOW = 10_000;
const OLD = { chatId: -100123, messageThreadId: 41 } as const;
const NEW = { chatId: OLD.chatId, messageThreadId: 99 } as const;

describe("TelegramTopicRecoveryRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates, commits, binds, welcomes, and pumps exactly once after a missing probe", async () => {
    const harness = createHarness();
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await Promise.all([runtime.recover(harness.action), runtime.recover(harness.action)]);

    expect(harness.probeForumTopic).toHaveBeenCalledOnce();
    expect(harness.createForumTopic).toHaveBeenCalledOnce();
    expect(harness.store.completeTopicRecovery).toHaveBeenCalledOnce();
    expect(harness.rebindThreadTopic).toHaveBeenCalledWith(
      `${OLD.chatId}:${OLD.messageThreadId}`,
      `${NEW.chatId}:${NEW.messageThreadId}`,
      harness.thread,
    );
    expect(harness.sendWelcome).toHaveBeenCalledOnce();
    expect(harness.outboxPump).toHaveBeenCalledOnce();
  });

  it.each(["live", "closed"])("cancels when the old topic is %s but recoverable", async () => {
    const harness = createHarness({ probeResult: true });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.recover(harness.action);

    expect(harness.store.failTopicRecovery).toHaveBeenCalledOnce();
    expect(harness.createForumTopic).not.toHaveBeenCalled();
    expect(harness.outboxPump).not.toHaveBeenCalled();
  });

  it("defers a rate-limited creation until the Telegram retry deadline", async () => {
    const rateLimit = { error_code: 429, parameters: { retry_after: 5 } };
    const harness = createHarness({ creationError: rateLimit });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.recover(harness.action);

    expect(harness.store.deferTopicRecovery).toHaveBeenCalledWith(expect.objectContaining({
      nextAttemptAt: NOW + 5_000,
    }));
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]?.at).toBe(NOW + 5_000);
    expect(harness.outboxPump).not.toHaveBeenCalled();
  });

  it("marks a timed-out topic creation unknown and never schedules or pumps it", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ creationNeverSettles: true, creationTimeoutMs: 100 });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    const recovery = runtime.recover(harness.action);
    await vi.advanceTimersByTimeAsync(100);
    await recovery;

    expect(harness.store.markTopicRecoveryUnknown).toHaveBeenCalledOnce();
    expect(harness.store.failTopicRecovery).not.toHaveBeenCalled();
    expect(harness.scheduled).toEqual([]);
    expect(harness.outboxPump).not.toHaveBeenCalled();
  });

  it("fails closed on a definitive permanent creation error", async () => {
    const harness = createHarness({ creationError: { error_code: 400 } });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.recover(harness.action);

    expect(harness.store.failTopicRecovery).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "TOPIC_RECOVERY_FAILED",
    }));
    expect(harness.store.markTopicRecoveryUnknown).not.toHaveBeenCalled();
    expect(harness.outboxPump).not.toHaveBeenCalled();
  });

  it("converts inherited in-flight recovery to unknown without external effects", async () => {
    const harness = createHarness({ initialRecoveryState: "in_flight" });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.store.markTopicRecoveryUnknown).toHaveBeenCalledOnce();
    expect(harness.probeForumTopic).not.toHaveBeenCalled();
    expect(harness.createForumTopic).not.toHaveBeenCalled();
    expect(harness.scheduled).toEqual([]);
  });

  it("schedules a due retry and resumes it before the next creation attempt", async () => {
    const harness = createHarness({ initialRecoveryState: "retry_wait", retryAt: NOW });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.reconcile();
    expect(harness.scheduled).toHaveLength(1);
    await harness.scheduled[0]!.wake();

    expect(harness.store.resumeTopicRecovery).toHaveBeenCalledOnce();
    expect(harness.createForumTopic).toHaveBeenCalledOnce();
    expect(harness.store.completeTopicRecovery).toHaveBeenCalledOnce();
  });

  it("repairs only the local binding for a complete recovery", async () => {
    const harness = createHarness({ initialRecoveryState: "complete" });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.rebindThreadTopic).toHaveBeenCalledOnce();
    expect(harness.probeForumTopic).not.toHaveBeenCalled();
    expect(harness.createForumTopic).not.toHaveBeenCalled();
    expect(harness.sendWelcome).not.toHaveBeenCalled();
    expect(harness.outboxPump).not.toHaveBeenCalled();
  });

  it("keeps welcome delivery best-effort after the committed rebind", async () => {
    const harness = createHarness({ welcomeError: new Error("welcome unavailable") });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.recover(harness.action);

    expect(harness.reportReason).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "TOPIC_RECOVERY_WELCOME_FAILED",
    }));
    expect(harness.outboxPump).toHaveBeenCalledOnce();
  });

  it("binds the preflight thread descriptor even if the live index changes after creation", async () => {
    const harness = createHarness({ threadDisappearsAfterPlanning: true });
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);

    await runtime.recover(harness.action);

    expect(harness.rebindThreadTopic).toHaveBeenCalledWith(
      `${OLD.chatId}:${OLD.messageThreadId}`,
      `${NEW.chatId}:${NEW.messageThreadId}`,
      harness.thread,
    );
    expect(harness.outboxPump).toHaveBeenCalledOnce();
  });

  it("does not let a stuck best-effort welcome delay the committed outbox", async () => {
    const harness = createHarness();
    let resolveWelcome!: () => void;
    harness.sendWelcome.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveWelcome = resolve;
    }));
    const runtime = createTelegramTopicRecoveryRuntime(harness.options);
    const recovery = runtime.recover(harness.action);

    await vi.waitFor(() => expect(harness.sendWelcome).toHaveBeenCalledOnce());
    try {
      expect(harness.outboxPump).toHaveBeenCalledOnce();
    } finally {
      resolveWelcome();
      await recovery;
    }
  });
});

function createHarness(options: {
  probeResult?: boolean;
  creationError?: unknown;
  creationNeverSettles?: boolean;
  creationTimeoutMs?: number;
  initialRecoveryState?: TelegramTopicRecoveryState;
  retryAt?: number;
  welcomeError?: Error;
  threadDisappearsAfterPlanning?: boolean;
} = {}) {
  const thread: CodexThreadRecord = {
    id: "thread-1",
    title: "Recover topic",
    cwd: "/work/telecodex",
    model: null,
    modelProvider: null,
    createdAt: new Date(1_000),
    updatedAt: new Date(2_000),
    firstUserMessage: "recover",
  };
  const source = {
    botId: "bot",
    updateId: 1,
    ...OLD,
    messageId: 1,
    kind: "text" as const,
    text: "request",
    attachment: null,
    retryOfJobId: null,
  };
  const anchorPayload = { operation: "send_text" as const, ...OLD, text: "Response follows." };
  const finalPayload = { operation: "send_text" as const, ...OLD, text: "Result" };
  const deliveries = [
    {
      jobId: "job-1", partKey: "status-anchor", ordinal: 0, kind: "status-anchor",
      state: "failed" as const, payload: anchorPayload,
      contentHash: hashTelegramDeliveryPayload(anchorPayload), telegramMessageId: null,
      attemptCount: 1, nextAttemptAt: null, lastErrorCode: "telegram_topic_missing", updatedAt: NOW - 2,
    },
    {
      jobId: "job-1", partKey: "final:0000", ordinal: 0, kind: "final",
      state: "pending" as const, payload: finalPayload,
      contentHash: hashTelegramDeliveryPayload(finalPayload), telegramMessageId: null,
      attemptCount: 0, nextAttemptAt: null, lastErrorCode: null, updatedAt: NOW - 3,
    },
  ];
  let job = {
    schemaVersion: 1 as const,
    version: 7,
    id: "job-1",
    source: { botId: source.botId, updateId: source.updateId },
    attachments: [],
    phase: "delivering" as const,
    health: "stalled" as const,
    activity: "unknown" as const,
    attention: { kind: "required" as const, code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
    outcome: null,
    dispatchId: "dispatch-1",
    threadId: thread.id,
    turnId: "turn-1",
    responsePlan: [{ partId: "final:0000", kind: "final" as const }],
    deliveries: [{
      partId: "final:0000", state: "pending" as const, attempts: 0,
      messageId: null, deliveredAt: null,
    }],
    acceptedAt: NOW - 10,
    updatedAt: NOW - 1,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
  const initialState = options.initialRecoveryState;
  let recovery: TelegramTopicRecoveryRecord | null = initialState ? recoveryRecord(initialState, options.retryAt) : null;
  if (recovery) job = { ...job, version: recovery.currentJobVersion };
  const advance = () => { job = { ...job, version: job.version + 1, updatedAt: NOW }; };
  const store = {
    get: vi.fn(() => structuredClone(job)),
    readSourcePayload: vi.fn(() => structuredClone(source)),
    listDeliveries: vi.fn(() => structuredClone(deliveries)),
    getTopicRecovery: vi.fn(() => recovery ? structuredClone(recovery) : null),
    listTopicRecoveries: vi.fn((states: readonly TelegramTopicRecoveryState[]) =>
      recovery && states.includes(recovery.state) ? [structuredClone(recovery)] : []),
    reserveTopicRecovery: vi.fn((input: { actionToken: string; eventAt: number }) => {
      advance();
      recovery = {
        ...recoveryRecord("in_flight"), actionToken: input.actionToken,
        reservedJobVersion: 7, currentJobVersion: job.version,
        startedAt: input.eventAt, updatedAt: input.eventAt,
      };
      return { job: structuredClone(job), recovery: structuredClone(recovery) };
    }),
    deferTopicRecovery: vi.fn((input: { nextAttemptAt: number; updatedAt: number }) => {
      advance();
      recovery = { ...recovery!, state: "retry_wait", currentJobVersion: job.version,
        nextAttemptAt: input.nextAttemptAt, reasonCode: "TOPIC_RECOVERY_RATE_LIMITED", updatedAt: input.updatedAt };
      return structuredClone(recovery);
    }),
    resumeTopicRecovery: vi.fn((input: { updatedAt: number }) => {
      advance();
      recovery = { ...recovery!, state: "in_flight", currentJobVersion: job.version,
        nextAttemptAt: null, reasonCode: null, updatedAt: input.updatedAt };
      return { job: structuredClone(job), recovery: structuredClone(recovery) };
    }),
    markTopicRecoveryUnknown: vi.fn((input: { updatedAt: number }) => {
      advance();
      recovery = { ...recovery!, state: "unknown", currentJobVersion: job.version,
        nextAttemptAt: null, reasonCode: "TOPIC_RECOVERY_UNKNOWN", updatedAt: input.updatedAt };
      return structuredClone(recovery);
    }),
    failTopicRecovery: vi.fn((input: { updatedAt: number }) => {
      advance();
      recovery = { ...recovery!, state: "failed", currentJobVersion: job.version,
        nextAttemptAt: null, reasonCode: "TOPIC_RECOVERY_FAILED", updatedAt: input.updatedAt };
      return structuredClone(recovery);
    }),
    completeTopicRecovery: vi.fn((input: { eventAt: number; target: typeof NEW }) => {
      advance();
      recovery = { ...recovery!, state: "complete", currentJobVersion: job.version,
        newMessageThreadId: input.target.messageThreadId, nextAttemptAt: null,
        reasonCode: null, updatedAt: input.eventAt };
      return { job: structuredClone(job), recovery: structuredClone(recovery), anchor: deliveries[0]! };
    }),
  };
  const probeForumTopic = vi.fn(async () => options.probeResult ?? false);
  const createForumTopic = vi.fn(async () => {
    if (options.creationNeverSettles) return new Promise<never>(() => {});
    if (options.creationError) throw options.creationError;
    return NEW;
  });
  const rebindThreadTopic = vi.fn();
  const sendWelcome = vi.fn(async () => {
    if (options.welcomeError) throw options.welcomeError;
  });
  const outboxPump = vi.fn(async () => undefined);
  const reportReason = vi.fn();
  const getThread = options.threadDisappearsAfterPlanning
    ? vi.fn().mockReturnValueOnce(structuredClone(thread)).mockReturnValue(null)
    : vi.fn(() => structuredClone(thread));
  const scheduled: Array<{ at: number; wake: () => Promise<void> }> = [];
  const runtimeOptions = {
    store,
    probeForumTopic,
    createForumTopic,
    getThread,
    rebindThreadTopic,
    sendWelcome,
    outboxPump,
    now: () => NOW,
    createId: () => "runtime-event",
    creationTimeoutMs: options.creationTimeoutMs ?? 1_000,
    scheduleWakeup: (at: number, wake: () => void | Promise<void>) => {
      scheduled.push({ at, wake: async () => { await wake(); } });
    },
    reportReason,
  } satisfies TelegramTopicRecoveryRuntimeOptions;
  const action: TelegramStatusAction = {
    kind: "retry_delivery", jobId: job.id, expectedVersion: job.version, partKey: "status-anchor",
  };
  return {
    options: runtimeOptions, action, store, thread, probeForumTopic, createForumTopic,
    rebindThreadTopic, sendWelcome, outboxPump, reportReason, scheduled,
  };
}

function recoveryRecord(
  state: TelegramTopicRecoveryState,
  retryAt = NOW + 5_000,
): TelegramTopicRecoveryRecord {
  return {
    jobId: "job-1",
    actionToken: "a".repeat(64),
    state,
    oldDestination: OLD,
    newMessageThreadId: state === "complete" ? NEW.messageThreadId : null,
    reservedJobVersion: 7,
    currentJobVersion: 8,
    nextAttemptAt: state === "retry_wait" ? retryAt : null,
    reasonCode: state === "retry_wait" ? "TOPIC_RECOVERY_RATE_LIMITED"
      : state === "unknown" ? "TOPIC_RECOVERY_UNKNOWN"
        : state === "failed" ? "TOPIC_RECOVERY_FAILED" : null,
    startedAt: NOW - 2,
    updatedAt: NOW - 1,
  };
}
