import { vi } from "vitest";

import { createTelegramTopicResumeRuntime }
  from "../src/telegram-topic-resume-runtime.js";
import { createHarness, DESTINATION, NOW }
  from "./telegram-topic-resume-runtime-fixture.js";

describe("TelegramTopicResumeRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["retry_delivery", "resume_existing_topic_warning"] as const)(
    "rejects the mismatched %s action before reserving", async (kind) => {
      const harness = createHarness();
      const runtime = createTelegramTopicResumeRuntime(harness.options);
      await expect(runtime.resume({ ...harness.action, kind })).rejects.toThrow(/eligible/);
      expect(harness.store.reserveTopicResume).not.toHaveBeenCalled();
      expect(harness.classifyForumTopic).not.toHaveBeenCalled();
      runtime.dispose();
    },
  );

  it("copies its allowed modes and denies new reservations while dormant", async () => {
    const harness = createHarness();
    const allowedModes = new Set<"standard" | "warning_replay">();
    const runtime = createTelegramTopicResumeRuntime({ ...harness.options, allowedModes });
    allowedModes.add("standard");
    await expect(runtime.resume(harness.action)).rejects.toThrow(/eligible/);
    expect(harness.store.reserveTopicResume).not.toHaveBeenCalled();
    runtime.dispose();
  });

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

  it("does not hand off delivery on unknown topic availability", async () => {
    const harness = createHarness({ liveness: "unknown" });
    const runtime = createTelegramTopicResumeRuntime(harness.options);
    await runtime.resume(harness.action);
    expect(harness.resume()).toMatchObject({ state: "failed", reasonCode: "TOPIC_RESUME_PROBE_UNKNOWN" });
    expect(harness.reopenForumTopic).not.toHaveBeenCalled();
    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
    runtime.dispose();
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

  it.each(["closed", "missing", "unknown"] as const)(
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

  it.each([
    new Error("429 Too Many Requests, retry after 5"),
    { error: { error_code: 429, parameters: { retry_after: 5 } } },
    { error_code: 500, error: { error_code: 429, parameters: { retry_after: 5 } } },
    { error_code: 429 },
    { error_code: 429, parameters: { retry_after: 0 } },
    { error_code: 429, parameters: { retry_after: 3601 } },
    { error_code: 429, parameters: { retry_after: "5" } },
  ])("never schedules an inherited probe retry from ambiguous or unbounded 429 evidence", async (failure) => {
    for (const initialState of ["probe_in_flight", "reopen_unknown"] as const) {
      const harness = createHarness({ initialState, classifyResults: [failure] });
      const runtime = createTelegramTopicResumeRuntime(harness.options);
      await runtime.reconcile();
      expect(harness.resume()).toMatchObject({ state: "reopen_unknown", nextAttemptAt: null,
        reasonCode: "TOPIC_RESUME_REOPEN_UNKNOWN" });
      expect(harness.scheduled).toHaveLength(0);
      await runtime.reconcile();
      expect(harness.classifyForumTopic).toHaveBeenCalledOnce();
      expect(harness.reopenForumTopic).not.toHaveBeenCalled();
      runtime.dispose();
    }
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

  it.each([
    ["attempt baseline", { attemptCount: 2 }],
    ["missing error", { lastErrorCode: null }],
    ["wrong error", { lastErrorCode: "telegram_not_sent" }],
    ["message id", { telegramMessageId: 71 }],
    ["retry deadline", { nextAttemptAt: NOW + 30 }],
  ] as const)("delegates handoff %s drift to outbox containment", async (_name, mutation) => {
    const harness = createHarness({
      liveness: "live",
      outboxOutcome: "pending",
      handoffAnchorMutation: mutation,
    });
    const runtime = createTelegramTopicResumeRuntime(harness.options);

    await runtime.resume(harness.action);

    expect(harness.outboxRetryFailed).not.toHaveBeenCalled();
    expect(harness.outboxPump).toHaveBeenCalledOnce();
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
