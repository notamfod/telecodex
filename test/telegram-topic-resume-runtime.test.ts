import { vi } from "vitest";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { DeliveryPart } from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import {
  createTelegramTopicResumeRuntime,
  type TelegramTopicResumeRuntimeOptions,
} from "../src/telegram-topic-resume-runtime.js";
import type {
  TelegramTopicResumeRecord,
  TelegramTopicResumeState,
} from "../src/telegram-topic-resume-ledger.js";
import type { TelegramStatusAction } from "../src/telegram-status-projection.js";

const NOW = 10_000;
const DESTINATION = { chatId: -1001, messageThreadId: 41 } as const;

describe("TelegramTopicResumeRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it("reserves before probing and hands a live topic to the failed anchor retry", async () => {
    const harness = createHarness({ liveness: "live" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.store.reserveTopicResume).toHaveBeenCalledOnce();
    expect(harness.calls.slice(0, 2)).toEqual(["reserve", "probe"]);
    expect(harness.store.reserveTopicResume).toHaveBeenCalledWith(expect.objectContaining({
      externalEligibilitySnapshot: {
        thread: harness.thread,
        forumChatId: DESTINATION.chatId,
        hasThreadTopicBinding: true,
      },
    }));
    expect(harness.store.transitionTopicResume).toHaveBeenCalledWith(expect.objectContaining({
      state: "delivery_handoff",
      externalEligibilitySnapshot: {
        thread: harness.thread,
        forumChatId: DESTINATION.chatId,
        hasThreadTopicBinding: true,
      },
    }));
    const reservedSnapshot = harness.store.reserveTopicResume.mock.calls[0]![0]
      .externalEligibilitySnapshot;
    const handoffSnapshot = harness.store.transitionTopicResume.mock.calls
      .find(([input]) => input.state === "delivery_handoff")![0].externalEligibilitySnapshot;
    expect(handoffSnapshot).not.toBe(reservedSnapshot);
    expect(harness.outboxRetryFailed).toHaveBeenCalledWith(
      harness.action.jobId,
      "status-anchor",
      expect.any(Number),
    );
    expect(harness.resume()?.state).toBe("complete");
  });

  it("reopens one confirmed closed topic after entering reopen_in_flight", async () => {
    const harness = createHarness({ liveness: "closed" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.calls).toContain("transition:reopen_in_flight");
    expect(harness.calls.indexOf("transition:reopen_in_flight"))
      .toBeLessThan(harness.calls.indexOf("reopen"));
    expect(harness.store.transitionTopicResume).toHaveBeenCalledWith(expect.objectContaining({
      state: "reopen_in_flight",
      externalEligibilitySnapshot: {
        thread: harness.thread,
        forumChatId: DESTINATION.chatId,
        hasThreadTopicBinding: true,
      },
    }));
    expect(harness.reopenForumTopic).toHaveBeenCalledOnce();
    expect(harness.outboxRetryFailed).toHaveBeenCalledOnce();
  });

  it("fails a missing topic without reopening or handing off delivery", async () => {
    const harness = createHarness({ liveness: "missing" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.resume()).toMatchObject({
      state: "failed",
      reasonCode: "TOPIC_RESUME_SOURCE_MISSING",
    });
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
  });

  it("stores a probe 429 deadline and performs one due probe", async () => {
    const rateLimit = { error_code: 429, parameters: { retry_after: 5 } };
    const harness = createHarness({ classifyResults: [rateLimit, "live"] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.resume()).toMatchObject({
      state: "probe_retry_wait",
      nextAttemptAt: NOW + 5_000,
      reasonCode: "TOPIC_RESUME_PROBE_RATE_LIMITED",
    });
    expect(harness.scheduled).toHaveLength(1);
    harness.advanceTo(harness.scheduled[0]!.at);
    await harness.scheduled[0]!.wake();
    expect(harness.classifyForumTopic).toHaveBeenCalledTimes(2);
    expect(harness.outboxRetryFailed).toHaveBeenCalledOnce();
  });

  it("fails an ambiguous initial probe without any Telegram mutation", async () => {
    const failure = new Error("connection lost");
    const harness = createHarness({ classifyResults: [failure] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.resume()).toMatchObject({
      state: "failed",
      reasonCode: "TOPIC_RESUME_PROBE_UNKNOWN",
    });
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
  });

  it("stores a reopen 429 deadline and performs exactly one due reopen", async () => {
    const rateLimit = { error_code: 429, parameters: { retry_after: 5 } };
    const harness = createHarness({ liveness: "closed", reopenResults: [rateLimit, true] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);
    expect(harness.resume()).toMatchObject({
      state: "reopen_retry_wait",
      nextAttemptAt: NOW + 5_000,
      reasonCode: "TOPIC_RESUME_REOPEN_RATE_LIMITED",
    });
    expect(harness.reopenForumTopic).toHaveBeenCalledOnce();

    harness.advanceTo(harness.scheduled[0]!.at);
    await harness.scheduled[0]!.wake();
    expect(harness.reopenForumTopic).toHaveBeenCalledTimes(2);
    expect(harness.outboxRetryFailed).toHaveBeenCalledOnce();
  });

  it("fails only a recognized immediate reopen 4xx definitively", async () => {
    const harness = createHarness({ liveness: "closed", reopenResults: [{ error_code: 400 }] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.resume()).toMatchObject({
      state: "failed",
      reasonCode: "TOPIC_RESUME_REOPEN_FAILED",
    });
    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
  });

  it.each([
    new Error("timeout"),
    new Error("connection lost"),
    { description: "unreadable response" },
  ])("persists an ambiguous reopen and immediately performs one safe probe", async (failure) => {
    const harness = createHarness({ liveness: "closed", reopenResults: [failure] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.resume()).toMatchObject({
      state: "reopen_unknown",
      reasonCode: "TOPIC_RESUME_REOPEN_UNKNOWN",
    });
    expect(harness.classifyForumTopic).toHaveBeenCalledTimes(2);
    expect(harness.invalidateForumTopicLiveness).toHaveBeenCalledOnce();
    expect(harness.reopenForumTopic).toHaveBeenCalledOnce();

    await runtime.reconcile();
    expect(harness.classifyForumTopic).toHaveBeenCalledTimes(2);
    expect(harness.reopenForumTopic).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("429 Too Many Requests, retry after 5"),
    { error: { error_code: 429, parameters: { retry_after: 5 } } },
    { error: { error_code: 400 } },
  ])("treats a non-top-level reopen response as ambiguous", async (failure) => {
    const harness = createHarness({ liveness: "closed", reopenResults: [failure] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.resume()).toMatchObject({
      state: "reopen_unknown",
      reasonCode: "TOPIC_RESUME_REOPEN_UNKNOWN",
      nextAttemptAt: null,
    });
    expect(harness.scheduled).toHaveLength(0);
    expect(harness.reopenForumTopic).toHaveBeenCalledOnce();
    expect(harness.classifyForumTopic).toHaveBeenCalledTimes(2);
  });

  it("invalidates pre-reopen liveness before dispatching the mutation and safe probe", async () => {
    const harness = createHarness({
      classifyResults: ["closed", "closed"],
      reopenResults: [new Error("connection lost")],
    });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.calls.filter((call) => [
      "probe",
      "transition:reopen_in_flight",
      "invalidate",
      "reopen",
      "transition:reopen_unknown",
    ].includes(call))).toEqual([
      "probe",
      "transition:reopen_in_flight",
      "invalidate",
      "reopen",
      "transition:reopen_unknown",
      "probe",
    ]);
  });

  it("converts inherited reopen_in_flight to reopen_unknown without any Telegram call", async () => {
    const harness = createHarness({ initialState: "reopen_in_flight" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.resume()?.state).toBe("reopen_unknown");
    expect(harness.classifyForumTopic).not.toHaveBeenCalled();
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
  });

  it("repeats only the nondestructive probe for inherited probe_in_flight", async () => {
    const harness = createHarness({ initialState: "probe_in_flight", liveness: "live" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.classifyForumTopic).toHaveBeenCalledOnce();
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
    expect(harness.outboxRetryFailed).toHaveBeenCalledOnce();
  });

  it.each(["closed", "missing"] as const)(
    "keeps inherited reopen_unknown stopped after a confirmed %s probe",
    async (liveness) => {
      const harness = createHarness({ initialState: "reopen_unknown", liveness });
      const runtime = createTelegramTopicResumeRuntime(harness.options);

      await runtime.reconcile();

      expect(harness.resume()?.state).toBe("reopen_unknown");
      expect(harness.classifyForumTopic).toHaveBeenCalledOnce();
      expect(harness.reopenForumTopic).not.toHaveBeenCalled();
      expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
    },
  );

  it("continues inherited reopen_unknown only after a confirmed live probe", async () => {
    const harness = createHarness({ initialState: "reopen_unknown", liveness: "live" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
    expect(harness.outboxRetryFailed).toHaveBeenCalledOnce();
  });

  it("stores and schedules a safe-probe 429 from inherited reopen_unknown", async () => {
    const rateLimit = { error_code: 429, parameters: { retry_after: 5 } };
    const harness = createHarness({ initialState: "reopen_unknown", classifyResults: [rateLimit, "closed"] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.resume()).toMatchObject({
      state: "reopen_unknown",
      nextAttemptAt: NOW + 5_000,
      reasonCode: "TOPIC_RESUME_PROBE_RATE_LIMITED",
    });
    harness.advanceTo(harness.scheduled[0]!.at);
    await harness.scheduled[0]!.wake();
    expect(harness.classifyForumTopic).toHaveBeenCalledTimes(2);
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
  });

  it("retries an inherited handoff only at its exact handoff version", async () => {
    const harness = createHarness({ initialState: "delivery_handoff", outboxOutcome: "pending" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.outboxRetryFailed).toHaveBeenCalledWith(
      harness.action.jobId,
      "status-anchor",
      harness.initialResumeVersion,
    );
    expect(harness.outboxPump).not.toHaveBeenCalled();
    expect(harness.resume()?.state).toBe("delivery_handoff");
  });

  it("pumps and settles durable evidence when a handoff job version has advanced", async () => {
    const harness = createHarness({
      initialState: "delivery_handoff",
      handoffVersionAdvanced: true,
      outboxOutcome: "complete",
    });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
    expect(harness.outboxPump).toHaveBeenCalledOnce();
    expect(harness.resume()?.state).toBe("complete");
  });

  it.each([
    ["pending", "delivery_handoff", null],
    ["failed", "failed", "TOPIC_RESUME_DELIVERY_FAILED"],
    ["uncertain", "failed", "TOPIC_RESUME_DELIVERY_UNCERTAIN"],
    ["complete", "complete", null],
  ] as const)("settles %s delivery only from durable evidence", async (outcome, state, reasonCode) => {
    const harness = createHarness({ initialState: "delivery_handoff", outboxOutcome: outcome });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.reconcile();

    expect(harness.resume()).toMatchObject({ state, reasonCode });
  });

  it("serializes duplicate concurrent resume calls and reserves at most once", async () => {
    const harness = createHarness({ liveness: "live" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await Promise.all([runtime.resume(harness.action), runtime.resume(harness.action)]);

    expect(harness.store.reserveTopicResume).toHaveBeenCalledOnce();
    expect(harness.classifyForumTopic).toHaveBeenCalledOnce();
  });

  it("uses a fresh thread and binding snapshot inside the delivery handoff transition", async () => {
    const harness = createHarness({ liveness: "live", bindingResults: [true, true, false] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await expect(runtime.resume(harness.action)).rejects.toThrow("Telegram topic resume conflict");

    expect(harness.resume()?.state).toBe("probe_in_flight");
    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
  });

  it("uses a fresh thread and binding snapshot inside the reopen transition", async () => {
    const harness = createHarness({ liveness: "closed", bindingResults: [true, false] });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await expect(runtime.resume(harness.action)).rejects.toThrow("Telegram topic resume conflict");

    expect(harness.resume()?.state).toBe("probe_in_flight");
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
  });

  it("aborts an in-process probe on dispose without starting another Telegram call", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ classifyNeverSettles: true });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    const resumed = runtime.resume(harness.action);
    await vi.waitFor(() => expect(harness.classifyForumTopic).toHaveBeenCalledOnce());
    runtime.dispose();
    await resumed;

    expect(harness.classifySignal()?.aborted).toBe(true);
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records cancellation after reopen dispatch as unknown without repeating reopen", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ liveness: "closed", reopenNeverSettles: true });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    const resumed = runtime.resume(harness.action);
    await vi.waitFor(() => expect(harness.reopenForumTopic).toHaveBeenCalledOnce());
    runtime.dispose();
    await resumed;

    expect(harness.reopenSignal()?.aborted).toBe(true);
    expect(harness.resume()?.state).toBe("reopen_unknown");
    expect(harness.reopenForumTopic).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out one dispatched reopen, aborts it, and probes safely without reopening", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ liveness: "closed", reopenNeverSettles: true });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    const resumed = runtime.resume(harness.action);
    await vi.waitFor(() => expect(harness.reopenForumTopic).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await resumed;

    expect(harness.reopenSignal()?.aborted).toBe(true);
    expect(harness.resume()).toMatchObject({
      state: "reopen_unknown",
      reasonCode: "TOPIC_RESUME_REOPEN_UNKNOWN",
    });
    expect(harness.classifyForumTopic).toHaveBeenCalledTimes(2);
    expect(harness.reopenForumTopic).toHaveBeenCalledOnce();
  });
});

type DeliveryOutcome = "pending" | "failed" | "uncertain" | "complete";

function createHarness(settings: {
  liveness?: "live" | "closed" | "missing";
  classifyResults?: readonly unknown[];
  reopenResults?: readonly unknown[];
  initialState?: TelegramTopicResumeState;
  handoffVersionAdvanced?: boolean;
  outboxOutcome?: DeliveryOutcome;
  bindingResults?: readonly boolean[];
  classifyNeverSettles?: boolean;
  reopenNeverSettles?: boolean;
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
      if ((input.state === "reopen_in_flight" || input.state === "delivery_handoff")
        && (!input.externalEligibilitySnapshot?.thread
          || input.externalEligibilitySnapshot.forumChatId !== DESTINATION.chatId
          || !input.externalEligibilitySnapshot.hasThreadTopicBinding)) {
        throw new Error("Telegram topic resume conflict");
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
