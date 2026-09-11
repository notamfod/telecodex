import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";
import Database from "better-sqlite3";
import { seedResumeDelivery } from "./telegram-topic-resume-delivery-fixture.js";

import type { CodexThreadRecord } from "../src/codex-state.js";
import {
  boundedReliabilityProbeTimeoutMs,
  createTelegramReliabilityRuntime,
  type TelegramReliabilityRuntimeOptions,
} from "../src/telegram-reliability-runtime.js";
import { TelegramDeliveryApiError } from "../src/telegram-delivery-outbox.js";
import { TelegramBackgroundWriteGate } from "../src/telegram-background-write-gate.js";
import {
  classifyTelegramStatusError,
  createTelegramStatusTransport,
} from "../src/telegram-grammy-transport.js";
import { SqliteTelegramJobStore, type TelegramJob } from "../src/telegram-job-store.js";
import { TelegramJobIngress, type TelegramWorkSource } from "../src/telegram-job-ingress.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import { planTelegramTopicRecovery } from "../src/telegram-topic-recovery.js";
import { planTelegramTopicResume } from "../src/telegram-topic-resume.js";

const NOW = 1_700_000_500_000;
const THREAD = "11111111-1111-4111-8111-111111111111";

describe("Telegram reliability runtime", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let runtime: ReturnType<typeof createTelegramReliabilityRuntime> | null;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-reliability-runtime-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    runtime = null;
  });

  afterEach(async () => {
    await runtime?.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("caps internal dependency probes below the outer Dashboard deadline", () => {
    expect(boundedReliabilityProbeTimeoutMs(15_000)).toBe(1_500);
    expect(boundedReliabilityProbeTimeoutMs(900)).toBe(900);
    expect(() => boundedReliabilityProbeTimeoutMs(0)).toThrow("Invalid reliability probe timeout");
  });

  it("runs optional topic recovery reconciliation inside startup reconciliation", async () => {
    const harness = createHarness(store, directory);
    const listRecoveries = vi.spyOn(store, "listTopicRecoveries");
    runtime = createTelegramReliabilityRuntime({
      ...harness.options,
      topicRecovery: {
        forumChatId: -1001,
        hasThreadTopicBinding: vi.fn(() => true),
        probeForumTopic: vi.fn(async () => false),
        createForumTopic: vi.fn(async ({ chatId }) => ({ chatId, messageThreadId: 99 })),
        getThread: vi.fn(() => null),
        rebindThreadTopic: vi.fn(),
        sendWelcome: vi.fn(async () => undefined),
        scheduleWakeup: vi.fn(),
        reportReason: vi.fn(),
      },
    });

    await runtime.reconcile();

    expect(listRecoveries).toHaveBeenCalledWith(["in_flight"]);
    expect(listRecoveries).toHaveBeenCalledWith(["retry_wait"]);
    expect(listRecoveries).toHaveBeenCalledWith(["complete"]);
  });

  it("owns optional topic resume reconciliation only when composed", async () => {
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    runtime = createTelegramReliabilityRuntime({
      ...harness.options,
      topicResume: {
        forumChatId: -1001,
        classifyForumTopic: vi.fn(async () => "live" as const),
        reopenForumTopic: vi.fn(async () => true as const),
        getThread: vi.fn(() => null),
        hasThreadTopicBinding: vi.fn(() => false),
        scheduleWakeup: vi.fn(),
      },
    });

    await runtime.reconcile();

    expect(listResumes).toHaveBeenCalledWith(["reopen_in_flight"]);
    expect(listResumes).toHaveBeenCalledWith(["probe_in_flight"]);
    expect(listResumes).toHaveBeenCalledWith(["probe_retry_wait", "reopen_retry_wait"]);
    expect(listResumes).toHaveBeenCalledWith(["reopen_unknown"]);
    expect(listResumes).toHaveBeenCalledWith(["delivery_handoff"]);
  });

  it("keeps topic resume absent and unreachable when it is not composed", async () => {
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    runtime = createTelegramReliabilityRuntime(harness.options);

    const accepted = await runtime.handle(source());
    await runtime.reconcile();
    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === accepted.job.id)!.projection;
    expect(listResumes).not.toHaveBeenCalled();
    expect(JSON.stringify(projection.actions)).not.toContain("resume_existing_topic");
  });

  it("reconciles topic resume only after a scheduled delivery pump finishes", async () => {
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    let clock = NOW;
    let scheduledWake!: () => void | Promise<void>;
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    let call = 0;
    harness.delivery.deliver.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new TelegramDeliveryApiError("retry_after", 1_000);
      if (call === 2) {
        deliveryStarted();
        await new Promise<void>((resolve) => { releaseDelivery = resolve; });
      }
      return { messageId: 500 + call };
    });
    runtime = createTelegramReliabilityRuntime({
      ...harness.options,
      now: () => clock,
      scheduleDeliveryWakeup: (_at, wake) => { scheduledWake = wake; },
      topicResume: {
        forumChatId: -1001,
        classifyForumTopic: vi.fn(async () => "live" as const),
        reopenForumTopic: vi.fn(async () => true as const),
        getThread: vi.fn(() => null),
        hasThreadTopicBinding: vi.fn(() => false),
        scheduleWakeup: vi.fn(),
      },
    });

    await runtime.handle(source({ updateId: 2, messageId: 2 }));
    const callsBeforeWake = listResumes.mock.calls.length;
    clock += 1_000;
    const waking = Promise.resolve(scheduledWake());
    await started;

    expect(listResumes.mock.calls).toHaveLength(callsBeforeWake);
    releaseDelivery();
    await waking;
    expect(listResumes.mock.calls.length).toBeGreaterThan(callsBeforeWake);
  });

  it("reconciles topic resume only after an automatic delivery pump finishes", async () => {
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    harness.delivery.deliver.mockImplementationOnce(async () => {
      deliveryStarted();
      await new Promise<void>((resolve) => { releaseDelivery = resolve; });
      return { messageId: 601 };
    });
    runtime = createTelegramReliabilityRuntime({
      ...harness.options,
      topicResume: dormantTopicResumeOptions(),
    });

    const handling = runtime.handle(source({ updateId: 3, messageId: 3 }));
    await started;

    expect(listResumes).not.toHaveBeenCalled();
    releaseDelivery();
    await handling;
    expect(listResumes).toHaveBeenCalled();
  });

  it("drains a scheduled recovery outbox pump before shutdown can close the store", async () => {
    const recovery = seedDueTopicRecovery(store);
    vi.spyOn(store, "scanReconciliationCandidates").mockReturnValue({
      jobs: [], quarantined: [], nextCursor: null,
    });
    const harness = createHarness(store, directory);
    let scheduledWake!: () => void | Promise<void>;
    let deliveryStarted!: () => void;
    let releaseDelivery!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    runtime = createTelegramReliabilityRuntime({
      ...harness.options,
      topicRecovery: {
        forumChatId: recovery.oldDestination.chatId,
        hasThreadTopicBinding: vi.fn((_threadId, destination) =>
          destination.messageThreadId === recovery.oldDestination.messageThreadId),
        probeForumTopic: vi.fn(async () => false),
        createForumTopic: vi.fn(async () => recovery.newDestination),
        getThread: vi.fn(() => structuredClone(recovery.thread)),
        rebindThreadTopic: vi.fn(),
        sendWelcome: vi.fn(async () => undefined),
        scheduleWakeup: (_at, wake) => { scheduledWake = wake; },
        reportReason: vi.fn(),
      },
    });
    await runtime.reconcile();
    harness.delivery.deliver.mockImplementationOnce(() => new Promise((resolve) => {
      deliveryStarted();
      releaseDelivery = () => resolve({ messageId: 777 });
    }));

    const waking = Promise.resolve(scheduledWake());
    await started;
    let disposeResolved = false;
    const disposing = runtime.dispose().then(() => { disposeResolved = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect.soft(disposeResolved).toBe(false);
    releaseDelivery();
    await Promise.all([waking, disposing]);

    const storeMethods = [
      vi.spyOn(store, "get"),
      vi.spyOn(store, "listDueDeliveries"),
      vi.spyOn(store, "listSendingDeliveries"),
      vi.spyOn(store, "nextDeliveryWakeupAt"),
    ];
    const callsAtResolution = storeMethods.map((spy) => spy.mock.calls.length);
    store.close();
    await Promise.resolve(scheduledWake());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(storeMethods.map((spy) => spy.mock.calls.length)).toEqual(callsAtResolution);
    runtime = null;
  });

  it("reconciles topic resume only after a recovery-triggered outbox pump finishes", async () => {
    const recovery = seedDueTopicRecovery(store);
    vi.spyOn(store, "scanReconciliationCandidates").mockReturnValue({
      jobs: [], quarantined: [], nextCursor: null,
    });
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    let scheduledWake!: () => void | Promise<void>;
    let deliveryStarted!: () => void;
    let releaseDelivery!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    runtime = createTelegramReliabilityRuntime({
      ...harness.options,
      topicRecovery: {
        forumChatId: recovery.oldDestination.chatId,
        hasThreadTopicBinding: vi.fn((_threadId, destination) =>
          destination.messageThreadId === recovery.oldDestination.messageThreadId),
        probeForumTopic: vi.fn(async () => false),
        createForumTopic: vi.fn(async () => recovery.newDestination),
        getThread: vi.fn(() => structuredClone(recovery.thread)),
        rebindThreadTopic: vi.fn(),
        sendWelcome: vi.fn(async () => undefined),
        scheduleWakeup: (_at, wake) => { scheduledWake = wake; },
        reportReason: vi.fn(),
      },
      topicResume: dormantTopicResumeOptions(),
    });
    await runtime.reconcile();
    const resumeCallsBeforeWake = listResumes.mock.calls.length;
    harness.delivery.deliver.mockImplementationOnce(async () => {
      deliveryStarted();
      await new Promise<void>((resolve) => { releaseDelivery = resolve; });
      return { messageId: 602 };
    });

    const waking = Promise.resolve(scheduledWake());
    await started;

    expect(listResumes.mock.calls).toHaveLength(resumeCallsBeforeWake);
    releaseDelivery();
    await waking;
    expect(listResumes.mock.calls.length).toBeGreaterThan(resumeCallsBeforeWake);
  });

  it("uses urgent physical status writes for explicit and Dashboard refreshes", async () => {
    const queued = await seedQueued(store, directory, source({ updateId: 90, messageId: 90 }));
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await runtime.refresh(queued.id);
    let current = store.get(queued.id)!;
    store.transition({
      jobId: current.id,
      eventId: "explicit-refresh-activity",
      expectedVersion: current.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: NOW, health: "quiet" },
    });
    await runtime.refresh(queued.id);
    current = store.get(queued.id)!;
    store.transition({
      jobId: current.id,
      eventId: "dashboard-refresh-activity",
      expectedVersion: current.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: NOW, health: "checking" },
    });
    await runtime.runDashboardAction({
      kind: "refresh",
      jobId: queued.id,
      expectedVersion: store.get(queued.id)!.version,
    });

    expect(harness.status.send).toHaveBeenCalledWith(expect.objectContaining({ priority: "urgent" }));
    expect(harness.status.edit).toHaveBeenCalledTimes(2);
    expect(harness.status.edit.mock.calls.map(([message]) => message.priority))
      .toEqual(["urgent", "urgent"]);
  });

  it("accepts text, runs one exact turn, installs one plan, and physically completes delivery", async () => {
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    const accepted = await runtime.handle(source());

    expect(accepted.created).toBe(true);
    expect(harness.session.prompt).toHaveBeenCalledOnce();
    expect(harness.session.prompt.mock.calls[0]![0]).toMatchObject({ text: "inspect this" });
    expect(store.get(accepted.job.id)).toMatchObject({
      phase: "terminal", outcome: "completed", threadId: THREAD, turnId: "turn-exact",
      responsePlan: [],
    });
    expect(store.listEvents(accepted.job.id).filter(({ event }) => event.type === "turn.started"))
      .toHaveLength(1);
    expect(harness.delivery.deliver).toHaveBeenCalledOnce();
    expect(harness.delivery.deliver.mock.calls[0]![0]).toEqual({
      operation: "edit_text", chatId: -1001, messageId: 501, text: "answer",
    });
  });

  it("prepares durable Inbox completion before atomically installing its response plan", async () => {
    const harness = createHarness(store, directory);
    const prepareCompletion = vi.fn(async ({ result }) => ({
      result: {
        ...result,
        content: [{ kind: "text" as const, text: "answer without topic marker" }],
      },
      supplementalParts: [{
        partKey: "jira-confirm",
        kind: "notice" as const,
        payload: {
          operation: "send_text" as const,
          chatId: -1001,
          messageThreadId: 7,
          text: "saved",
          replyMarkup: { inlineKeyboard: [[{ text: "Send", callbackData: "jira_post:12" }]] },
        },
      }],
    }));
    harness.options.prepareCompletion = prepareCompletion;
    runtime = createTelegramReliabilityRuntime(harness.options);

    const accepted = await runtime.handle(source({
      kind: "confirmation",
      completion: { kind: "inbox_ticket", ticketId: 12 },
    }));

    expect(prepareCompletion).toHaveBeenCalledOnce();
    expect(prepareCompletion).toHaveBeenCalledWith(expect.objectContaining({
      jobId: accepted.job.id,
      source: expect.objectContaining({ completion: { kind: "inbox_ticket", ticketId: 12 } }),
    }));
    expect(store.get(accepted.job.id)?.responsePlan).toEqual([
      { partId: "final:0000", kind: "final" },
      { partId: "jira-confirm", kind: "notice" },
    ]);
    expect(harness.delivery.deliver.mock.calls.map(([payload]) => payload)).toEqual([
      { operation: "edit_text", chatId: -1001, messageId: 501, text: "Response follows." },
      {
        operation: "send_text", chatId: -1001, messageThreadId: 7,
        text: "answer without topic marker",
      },
      {
        operation: "send_text", chatId: -1001, messageThreadId: 7, text: "saved",
        replyMarkup: { inlineKeyboard: [[{ text: "Send", callbackData: "jira_post:12" }]] },
      },
    ]);
  });

  it("turns completion processing failures into a visible retryable terminal job", async () => {
    const harness = createHarness(store, directory);
    const completionError = new Error("Telegram completion processor is not configured");
    const onRuntimeError = vi.fn();
    harness.options.onRuntimeError = onRuntimeError;
    harness.options.prepareCompletion = vi.fn(async () => { throw completionError; });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const accepted = await runtime.handle(source({
      kind: "confirmation",
      completion: { kind: "inbox_ticket", ticketId: 12 },
    }));

    expect(accepted.job).toMatchObject({
      phase: "terminal",
      outcome: "failed",
      attention: {
        kind: "required",
        code: "completion_processing_failed",
        actions: ["inspect", "retry"],
      },
    });
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    expect(harness.status.edit.mock.calls.some(([message]) =>
      message.projection.attention.code === "completion_processing_failed"
      && message.projection.actions.some(({ kind }) => kind === "retry_new_turn")))
      .toBe(true);
    expect(onRuntimeError).toHaveBeenCalledWith({
      jobId: accepted.job.id,
      operation: "coordinator",
      error: completionError,
    });
    expect(onRuntimeError.mock.calls[0]![0].error).toBe(completionError);

    await expect(runtime.reconcile()).resolves.toMatchObject({ effectsFailed: 0 });
  });

  it("reports the exact error from an actual final outbox delivery attempt", async () => {
    const deliveryError = new TelegramDeliveryApiError("permanent");
    const reporterError = new Error("runtime reporter failed");
    const onRuntimeError = vi.fn(() => { throw reporterError; });
    const harness = createHarness(store, directory);
    harness.options.onRuntimeError = onRuntimeError;
    harness.delivery.deliver.mockRejectedValueOnce(deliveryError);
    runtime = createTelegramReliabilityRuntime(harness.options);

    const accepted = await runtime.handle(source({ updateId: 95, messageId: 95 }));

    expect(harness.delivery.deliver).toHaveBeenCalledOnce();
    expect(accepted.job).toMatchObject({ phase: "delivering", outcome: null });
    expect(onRuntimeError).toHaveBeenCalledOnce();
    expect(onRuntimeError).toHaveBeenCalledWith({
      jobId: accepted.job.id,
      operation: "delivery",
      error: deliveryError,
    });
    expect(onRuntimeError.mock.calls[0]![0].error).toBe(deliveryError);
    expect(store.listDeliveries(accepted.job.id)).toContainEqual(expect.objectContaining({
      state: "failed",
      attemptCount: 2,
      lastErrorCode: "telegram_permanent",
    }));
  });

  it("contains a throwing reporter on a detached coordinator failure", async () => {
    const completionError = new Error("completion coordination failed");
    const reporterError = new Error("runtime reporter failed");
    const onRuntimeError = vi.fn(() => { throw reporterError; });
    const harness = createHarness(store, directory);
    harness.options.onRuntimeError = onRuntimeError;
    harness.options.prepareCompletion = vi.fn(async () => { throw completionError; });
    runtime = createTelegramReliabilityRuntime(harness.options);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const outcome = await runtime.handle(source({
        updateId: 96,
        messageId: 96,
        kind: "confirmation",
        completion: { kind: "inbox_ticket", ticketId: 12 },
      })).then(
        (result) => ({ kind: "resolved" as const, result }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome).toMatchObject({
        kind: "resolved",
        result: { job: { phase: "terminal", outcome: "failed" } },
      });
      expect(onRuntimeError).toHaveBeenCalledOnce();
      expect(onRuntimeError.mock.calls[0]![0].error).toBe(completionError);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports one failed physical status refresh without logging its collapsed re-entry", async () => {
    const queued = await seedQueued(store, directory, source({
      updateId: 91,
      messageId: 91,
      text: "SECRET_PROMPT_MUST_NOT_ENTER_CONTEXT",
    }));
    const statusError = new Error("status write failed");
    const onRuntimeError = vi.fn();
    const harness = createHarness(store, directory);
    harness.options.onRuntimeError = onRuntimeError;
    let rejectStatus!: (error: unknown) => void;
    harness.status.send.mockImplementationOnce(() => new Promise<number>((_resolve, reject) => {
      rejectStatus = reject;
    }));
    runtime = createTelegramReliabilityRuntime(harness.options);

    const first = runtime.refresh(queued.id);
    const collapsed = runtime.refresh(queued.id);
    await vi.waitFor(() => expect(harness.status.send).toHaveBeenCalledOnce());
    rejectStatus(statusError);
    const outcomes = await Promise.allSettled([first, collapsed]);

    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "fulfilled"]);
    expect(harness.status.send).toHaveBeenCalledOnce();
    expect(onRuntimeError).toHaveBeenCalledOnce();
    const context = onRuntimeError.mock.calls[0]![0];
    expect(context).toEqual({
      jobId: queued.id,
      operation: "status_refresh",
      error: statusError,
    });
    expect(context.error).toBe(statusError);
    expect(Object.keys(context).sort()).toEqual(["error", "jobId", "operation"]);
    expect(context).not.toHaveProperty("prompt");
    expect(context).not.toHaveProperty("result");
  });

  it("reports one exact detached status heartbeat failure", async () => {
    vi.useFakeTimers();
    let currentTime = NOW;
    const queued = await seedQueued(store, directory, source({ updateId: 97, messageId: 97 }));
    const heartbeatError = new Error("detached status heartbeat failed");
    const onRuntimeError = vi.fn();
    const harness = createHarness(store, directory);
    harness.options.now = () => currentTime;
    harness.options.onRuntimeError = onRuntimeError;
    runtime = createTelegramReliabilityRuntime(harness.options);
    await runtime.refresh(queued.id);
    harness.status.edit.mockRejectedValueOnce(heartbeatError);

    currentTime += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onRuntimeError).toHaveBeenCalledOnce();
    expect(onRuntimeError).toHaveBeenCalledWith({
      jobId: queued.id,
      operation: "status_refresh",
      error: heartbeatError,
    });
    expect(onRuntimeError.mock.calls[0]![0].error).toBe(heartbeatError);
  });

  it("reports coordinator and reconciliation failures at their exact boundaries", async () => {
    const queued = await seedQueued(store, directory, source({ updateId: 92, messageId: 92 }));
    const coordinatorError = new Error("coordinator transition failed");
    const reconciliationError = new Error("reconciliation scan failed");
    const onRuntimeError = vi.fn();
    const harness = createHarness(store, directory);
    harness.options.onRuntimeError = onRuntimeError;
    runtime = createTelegramReliabilityRuntime(harness.options);
    const transition = store.transition.bind(store);
    vi.spyOn(store, "transition").mockImplementation((input) => {
      if (input.jobId === queued.id && input.event.type === "job.terminal"
        && input.event.outcome === "aborted") throw coordinatorError;
      return transition(input);
    });

    await expect(runtime.abort({
      source: {
        botId: "bot", updateId: 93, chatId: -1001, messageThreadId: 7, messageId: 93,
      },
      target: { jobId: queued.id, version: queued.version },
    })).rejects.toBe(coordinatorError);
    vi.spyOn(store, "scanReconciliationCandidates").mockImplementation(() => {
      throw reconciliationError;
    });
    await expect(runtime.reconcile()).rejects.toBe(reconciliationError);

    expect(onRuntimeError.mock.calls.map(([context]) => context)).toEqual([
      { jobId: queued.id, operation: "coordinator", error: coordinatorError },
      { jobId: null, operation: "reconciliation", error: reconciliationError },
    ]);
    expect(onRuntimeError.mock.calls[0]![0].error).toBe(coordinatorError);
    expect(onRuntimeError.mock.calls[1]![0].error).toBe(reconciliationError);
  });

  it("accepts exact controls from a dedicated durable target topic", async () => {
    const input = source({
      updateId: 22,
      targetContext: { chatId: -1001, messageThreadId: 91 },
    });
    acceptBare(store, "target-job", input, true);
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    const target = await runtime.latestJob({ botId: "bot", chatId: -1001, messageThreadId: 91 });
    expect(target).toEqual({ jobId: "target-job", version: 1 });

    await runtime.abort({
      source: {
        botId: "bot", updateId: 23, chatId: -1001, messageThreadId: 91, messageId: 30,
      },
      target: target!,
    });

    expect(store.get("target-job")).toMatchObject({ phase: "terminal", outcome: "aborted" });
  });

  it("durably accepts work before provisioning its dedicated target topic", async () => {
    const harness = createHarness(store, directory);
    const createForumTopic = vi.fn(async ({ chatId, topicName }: {
      chatId: number; topicName: string;
    }) => {
      expect(store.getBySourceKey({ botId: "bot", updateId: 24 })).not.toBeNull();
      const persisted = store.readSourcePayload(store.getBySourceKey({ botId: "bot", updateId: 24 })!.id);
      expect(persisted).toMatchObject({
        targetProvision: { kind: "forum_topic", topicName: "Readonly review", state: "in_flight" },
      });
      return { chatId, messageThreadId: 91 };
    });
    harness.options.createForumTopic = createForumTopic;
    runtime = createTelegramReliabilityRuntime(harness.options);

    const target = await runtime.handleWork(source({
      updateId: 24,
      targetProvision: { kind: "forum_topic", topicName: "Readonly review", state: "planned" },
    }));

    expect(target).toEqual({ chatId: -1001, messageThreadId: 91 });
    expect(store.readSourcePayload(store.listRecent(1)[0]!.id)).toMatchObject({
      targetContext: { chatId: -1001, messageThreadId: 91 },
      targetProvision: { kind: "forum_topic", topicName: "Readonly review", state: "complete" },
    });
    expect(harness.status.send).toHaveBeenCalledWith(expect.objectContaining({ messageThreadId: 91 }));
  });

  it("never repeats an ambiguous target topic creation during reconciliation", async () => {
    const harness = createHarness(store, directory);
    harness.options.createForumTopic = vi.fn()
      .mockRejectedValueOnce(new Error("timeout after write"))
      .mockResolvedValueOnce({ chatId: -1001, messageThreadId: 92 });
    runtime = createTelegramReliabilityRuntime(harness.options);

    await expect(runtime.handleWork(source({
      updateId: 25,
      targetProvision: { kind: "forum_topic", topicName: "Ambiguous topic", state: "planned" },
    }))).rejects.toThrow("timeout after write");

    const job = store.getBySourceKey({ botId: "bot", updateId: 25 })!;
    expect(store.readSourcePayload(job.id)).toMatchObject({
      targetProvision: { state: "in_flight" },
    });
    expect(store.get(job.id)).toMatchObject({
      phase: "accepted", health: "stalled",
      attention: { kind: "required", code: "target_topic_provision_unknown" },
    });

    await runtime.reconcile();

    expect(harness.options.createForumTopic).toHaveBeenCalledOnce();
    expect(harness.session.prompt).not.toHaveBeenCalled();

    const stalled = store.get(job.id)!;
    await runtime.retry({
      source: { botId: "bot", updateId: 26, chatId: -1001, messageThreadId: 7, messageId: 26 },
      target: { jobId: stalled.id, version: stalled.version },
    });

    expect(store.get(stalled.id)).toMatchObject({
      phase: "terminal", outcome: "recovery_interrupted",
    });
    expect(harness.options.createForumTopic).toHaveBeenCalledTimes(2);
    expect(harness.session.prompt).toHaveBeenCalledOnce();
  });

  it("reports the exact explicit status error while preserving target provision attention", async () => {
    const provisionError = new Error("timeout after target topic write");
    const statusError = new Error("attention status write failed");
    const onRuntimeError = vi.fn();
    const harness = createHarness(store, directory);
    harness.options.createForumTopic = vi.fn(async () => { throw provisionError; });
    harness.options.onRuntimeError = onRuntimeError;
    harness.status.send.mockRejectedValueOnce(statusError);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await expect(runtime.handleWork(source({
      updateId: 28,
      messageId: 28,
      targetProvision: { kind: "forum_topic", topicName: "Ambiguous status", state: "planned" },
    }))).rejects.toBe(provisionError);

    const job = store.getBySourceKey({ botId: "bot", updateId: 28 })!;
    expect(store.get(job.id)).toMatchObject({
      health: "stalled",
      attention: { kind: "required", code: "target_topic_provision_unknown" },
    });
    expect(onRuntimeError).toHaveBeenCalledOnce();
    expect(onRuntimeError).toHaveBeenCalledWith({
      jobId: job.id,
      operation: "status_refresh",
      error: statusError,
    });
    expect(onRuntimeError.mock.calls[0]![0].error).toBe(statusError);
  });

  it("bounds and aborts a hung target topic creation", async () => {
    vi.useFakeTimers();
    const harness = createHarness(store, directory);
    let signal: AbortSignal | undefined;
    harness.options.targetProvisionTimeoutMs = 25;
    harness.options.createForumTopic = vi.fn(async (input) => {
      signal = input.signal;
      return new Promise(() => {});
    });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const handling = runtime.handleWork(source({
      updateId: 27,
      targetProvision: { kind: "forum_topic", topicName: "Hung topic", state: "planned" },
    })).catch((error: unknown) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    await expect(handling).resolves.toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    expect(store.getBySourceKey({ botId: "bot", updateId: 27 })).toMatchObject({
      phase: "accepted", health: "stalled",
      attention: { kind: "required", code: "target_topic_provision_unknown" },
    });
  });

  it("does not return while exact thread resolution is deferred before turn registration", async () => {
    const harness = createHarness(store, directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.registry.getOrCreate.mockImplementation(async () => {
      await gate;
      return harness.session;
    });
    runtime = createTelegramReliabilityRuntime(harness.options);
    let settled = false;

    const handling = runtime.handle(source()).finally(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(harness.session.prompt).not.toHaveBeenCalled();

    release();
    await handling;
    expect(harness.session.prompt).toHaveBeenCalledOnce();
    expect(store.listRecent(1)[0]).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("returns bot-facing handleWork after scheduling without waiting for the turn outcome", async () => {
    const harness = createHarness(store, directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    harness.session.prompt.mockImplementationOnce(async (_input, callbacks) => {
      callbacks.beforeDispatchWrite?.({
        threadId: THREAD, previousTurnId: null, previousTurnKnown: true, attempt: 1,
      });
      callbacks.onDispatchWritten?.();
      callbacks.onStarted?.("turn-exact");
      callbacks.onTextDelta("answer");
      markStarted();
      await gate;
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: NOW });
    });
    runtime = createTelegramReliabilityRuntime(harness.options);
    let settled = false;

    const handling = runtime.handleWork(source()).finally(() => { settled = true; });
    await started;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const settledBeforeOutcome = settled;
    expect(store.listRecent(1)[0]).toMatchObject({ phase: "running", turnId: "turn-exact" });
    release();
    await handling;

    expect(settledBeforeOutcome).toBe(true);
  });

  it("drops commentary deliveries and sends only the final answer", async () => {
    const harness = createHarness(store, directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markCommentaryEnded!: () => void;
    const commentaryEnded = new Promise<void>((resolve) => { markCommentaryEnded = resolve; });
    harness.session.prompt.mockImplementationOnce(async (_input, callbacks) => {
      callbacks.beforeDispatchWrite?.({
        threadId: THREAD, previousTurnId: null, previousTurnKnown: true, attempt: 1,
      });
      callbacks.onDispatchWritten?.();
      callbacks.onStarted?.("turn-exact");
      callbacks.onAgentMessageStart?.({ itemId: "commentary-1", phase: "commentary" });
      callbacks.onTextDelta("Checking production.");
      callbacks.onAgentMessageEnd?.({ itemId: "commentary-1", phase: "commentary" });
      markCommentaryEnded();
      await gate;
      callbacks.onAgentMessageStart?.({ itemId: "final-1", phase: "final_answer" });
      callbacks.onTextDelta("Done.");
      callbacks.onAgentMessageEnd?.({ itemId: "final-1", phase: "final_answer" });
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: NOW });
    });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const handling = runtime.handle(source());
    await commentaryEnded;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whileRunning = harness.delivery.deliver.mock.calls.map(([payload]) => payload);
    const runningJob = store.listRecent(1)[0];
    release();
    await handling;

    expect(runningJob).toMatchObject({ phase: "running", turnId: "turn-exact" });
    expect(whileRunning).toEqual([]);
    expect(harness.delivery.deliver.mock.calls.map(([payload]) => payload)).toEqual([
      { operation: "edit_text", chatId: -1001, messageId: 501, text: "Done." },
    ]);
    expect(store.listDeliveries(runningJob!.id).filter((part) => part.kind === "summary")).toEqual([]);
  });

  it("cancels a genuinely queued background status write before final outbox delivery", async () => {
    vi.useFakeTimers();
    const harness = createHarness(store, directory);
    let elapsed = 0;
    harness.options.now = () => NOW + elapsed;
    const statusGate = new TelegramBackgroundWriteGate({
      maxPerWindow: 1,
      windowMs: 60_000,
      burst: 1,
      now: () => elapsed,
    });
    const sendMessage = vi.fn(async () => ({ message_id: 501 }));
    const editMessageText = vi.fn(async () => ({}));
    harness.options.statusTransport = createTelegramStatusTransport({
      sendMessage,
      editMessageText,
    } as never, 30_000, statusGate);
    harness.options.classifyStatusTransportError = classifyTelegramStatusError;
    let releaseActivity!: () => void;
    let markActivity!: () => void;
    let releaseFinal!: () => void;
    let markTurnStarted!: () => void;
    const activityGate = new Promise<void>((resolve) => { releaseActivity = resolve; });
    const activityObserved = new Promise<void>((resolve) => { markActivity = resolve; });
    const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve; });
    const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve; });
    harness.session.prompt.mockImplementationOnce(async (_input, callbacks) => {
      callbacks.beforeDispatchWrite?.({
        threadId: THREAD, previousTurnId: null, previousTurnKnown: true, attempt: 1,
      });
      callbacks.onDispatchWritten?.();
      callbacks.onStarted?.("turn-exact");
      markTurnStarted();
      await activityGate;
      callbacks.onActivity?.({ activity: "tool", eventAt: NOW + 1, method: "item/started" });
      markActivity();
      await finalGate;
      callbacks.onTextDelta("final bypasses status gate");
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: NOW });
    });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const handling = runtime.handle(source({ updateId: 94, messageId: 94 }));
    await turnStarted;
    for (let index = 0; index < 20 && sendMessage.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(sendMessage).toHaveBeenCalledOnce();
    releaseActivity();
    await activityObserved;
    elapsed = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);

    const state = (statusGate as unknown as {
      states: Map<number, { queue: readonly unknown[] }>;
    }).states.get(-1001);
    expect(state?.queue).toHaveLength(1);
    expect(editMessageText).not.toHaveBeenCalled();
    expect(harness.delivery.deliver).not.toHaveBeenCalled();

    try {
      releaseFinal();
      await vi.waitFor(() => expect(harness.delivery.deliver).toHaveBeenCalledOnce(), {
        timeout: 1_000,
        interval: 10,
      });
      expect(editMessageText).not.toHaveBeenCalled();
      await handling;

      expect(harness.delivery.deliver.mock.calls[0]![0]).toMatchObject({
        operation: "edit_text",
        text: "final bypasses status gate",
      });
    } finally {
      statusGate.dispose();
      await handling.catch(() => undefined);
    }
  });

  it("deduplicates the update across the whole pipeline and never replays its prompt", async () => {
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    const first = await runtime.handle(source());
    const duplicate = await runtime.handle(source({ text: "must not replace" }));
    await runtime.reconcile();

    expect(duplicate).toMatchObject({ created: false, job: { id: first.job.id } });
    expect(store.countJobs()).toBe(1);
    expect(harness.session.prompt).toHaveBeenCalledOnce();
    expect(harness.session.recoverPrompt).not.toHaveBeenCalled();
    expect(harness.delivery.deliver).toHaveBeenCalledOnce();
  });

  it("stops the job presenter before the outbox finalizes its anchor", async () => {
    vi.useFakeTimers();
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await runtime.handle(source());
    const statusEdits = harness.status.edit.mock.calls.length;
    expect(harness.delivery.deliver.mock.calls.at(-1)?.[0]).toMatchObject({
      operation: "edit_text", text: "answer",
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.status.edit).toHaveBeenCalledTimes(statusEdits);
    expect(harness.delivery.deliver).toHaveBeenCalledOnce();
  });

  it("keeps duplicate status re-entry behind an in-flight final anchor cutover", async () => {
    vi.useFakeTimers();
    const harness = createHarness(store, directory);
    let clock = NOW;
    harness.options.now = () => clock;
    let releasePreparation!: () => void;
    let markPreparing!: () => void;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const preparing = new Promise<void>((resolve) => { markPreparing = resolve; });
    harness.options.prepareCompletion = async ({ result }) => {
      markPreparing();
      await preparationGate;
      return { result, supplementalParts: [] };
    };
    let releaseDelivery!: () => void;
    let markDeliveryStarted!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
    harness.delivery.deliver.mockImplementationOnce(async () => {
      markDeliveryStarted();
      await deliveryGate;
      return { messageId: 501 };
    });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const handling = runtime.handle(source({
      kind: "confirmation",
      completion: { kind: "inbox_ticket", ticketId: 12 },
    }));
    await preparing;
    const guardianCallsBeforeCutover = harness.options.guardian.inspectThread.mock.calls.length;
    const statusEditsBeforeCutover = harness.status.edit.mock.calls.length;
    const duplicate = runtime.handleWork(source({
      kind: "confirmation",
      completion: { kind: "inbox_ticket", ticketId: 12 },
    }));
    clock += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const planWhileGuardianBlocked = store.listRecent(1)[0]!.responsePlan;
    const guardianCallsDuringCutover = harness.options.guardian.inspectThread.mock.calls.length;
    const statusEditsDuringCutover = harness.status.edit.mock.calls.length;

    releasePreparation();
    await deliveryStarted;
    releaseDelivery();
    await Promise.all([handling, duplicate]);

    expect(planWhileGuardianBlocked).toBeUndefined();
    expect(guardianCallsDuringCutover).toBe(guardianCallsBeforeCutover);
    expect(statusEditsDuringCutover).toBe(statusEditsBeforeCutover);
    expect(store.listRecent(1)[0]).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(harness.delivery.deliver).toHaveBeenCalledOnce();
  }, 15_000);

  it("uses exact durable versions for latest, retry, and abort controls", async () => {
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);
    const first = await runtime.handle(source());
    const latest = await runtime.latestJob({ botId: "bot", chatId: -1001, messageThreadId: 7 });
    expect(latest).toEqual({ jobId: first.job.id, version: store.get(first.job.id)!.version });

    const controlSource = {
      botId: "bot", updateId: 10, chatId: -1001, messageThreadId: 7, messageId: 30,
    };
    await expect(runtime.abort({
      source: controlSource, target: { jobId: first.job.id, version: latest!.version - 1 },
    }))
      .rejects.toThrow("Telegram job version conflict");
    expect(harness.session.abort).not.toHaveBeenCalled();
    await expect(runtime.abort({ source: controlSource, target: latest! }))
      .rejects.toThrow("Telegram job is not abortable");
    expect(harness.session.abort).not.toHaveBeenCalled();

    await runtime.retry({
      source: { botId: "bot", updateId: 2, chatId: -1001, messageThreadId: 7, messageId: 20 },
      target: latest!,
    });
    expect(store.countJobs()).toBe(2);
    expect(harness.session.prompt).toHaveBeenCalledTimes(2);
    expect(harness.session.prompt.mock.calls[1]![0]).toMatchObject({ text: "inspect this" });
    const retried = store.getBySourceKey({ botId: "bot", updateId: 2 })!;
    expect(store.readSourcePayload(retried.id)).toMatchObject({
      kind: "retry", retryOfJobId: first.job.id, text: "inspect this",
    });
  });

  it("returns bot-facing retry after scheduling without waiting for its new turn", async () => {
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);
    const first = await runtime.handle(source());
    const target = { jobId: first.job.id, version: store.get(first.job.id)!.version };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    harness.session.prompt.mockImplementationOnce(async (_input, callbacks) => {
      callbacks.beforeDispatchWrite?.({
        threadId: THREAD, previousTurnId: "turn-exact", previousTurnKnown: true, attempt: 1,
      });
      callbacks.onDispatchWritten?.(); callbacks.onStarted?.("turn-retry");
      markStarted();
      await gate;
      callbacks.onTextDelta("retry answer");
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: NOW });
    });
    let settled = false;

    const retrying = runtime.retry({
      source: { botId: "bot", updateId: 2, chatId: -1001, messageThreadId: 7, messageId: 20 },
      target,
    }).finally(() => { settled = true; });
    await started;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const settledBeforeOutcome = settled;
    release();
    await retrying;

    expect(settledBeforeOutcome).toBe(true);
  });

  it("atomically reserves one retry child for one parent version", async () => {
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);
    const first = await runtime.handle(source());
    const target = { jobId: first.job.id, version: store.get(first.job.id)!.version };

    const outcomes = await Promise.allSettled([2, 3].map((updateId) => runtime!.retry({
      source: { botId: "bot", updateId, chatId: -1001, messageThreadId: 7, messageId: 20 + updateId },
      target,
    })));

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(store.countJobs()).toBe(2);
    expect(harness.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("rejects direct and Dashboard retry while the exact parent is queued or running", async () => {
    const queued = await seedQueued(store, directory, source({ updateId: 80, messageId: 80 }));
    const running = seedRunning(store, queued, "active-turn");
    const otherQueued = await seedQueued(store, directory, source({ updateId: 81, messageId: 81 }));
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await expect(runtime.retry({
      source: { botId: "bot", updateId: 82, chatId: -1001, messageThreadId: 7, messageId: 82 },
      target: { jobId: otherQueued.id, version: otherQueued.version },
    })).rejects.toThrow("Telegram retry is no longer legal");
    await expect(runtime.retry({
      source: { botId: "bot", updateId: 83, chatId: -1001, messageThreadId: 7, messageId: 83 },
      target: { jobId: running.id, version: running.version },
    })).rejects.toThrow("Telegram retry is no longer legal");
    await expect(runtime.runDashboardAction({
      kind: "retry_new_turn", jobId: otherQueued.id, expectedVersion: otherQueued.version,
    })).rejects.toThrow("Dashboard action is no longer legal");
    await expect(runtime.runDashboardAction({
      kind: "retry_new_turn", jobId: running.id, expectedVersion: running.version,
    })).rejects.toThrow("Dashboard action is no longer legal");

    expect(store.countJobs()).toBe(2);
    expect(harness.session.prompt).not.toHaveBeenCalled();
  });

  it("retires an ambiguous dispatch before retrying so the new job is not starved by its topic lane", async () => {
    const ingress = new TelegramJobIngress({
      store,
      materializationRoot: path.join(directory, "materialized"),
      now: () => NOW,
      createId: (() => { let id = 0; return () => `ambiguous-seed-${++id}`; })(),
      downloadAttachment: async () => new Uint8Array(),
    });
    const accepted = ingress.accept(source({ updateId: 70, messageId: 70 }));
    await ingress.materialize(accepted.job.id);
    let parent = store.get(accepted.job.id)!;
    parent = store.transition({
      jobId: parent.id,
      eventId: "ambiguous-queued",
      expectedVersion: parent.version,
      event: { schemaVersion: 1, type: "job.queued", eventAt: NOW },
    });
    parent = store.transition({
      jobId: parent.id,
      eventId: "ambiguous-dispatch",
      expectedVersion: parent.version,
      event: {
        schemaVersion: 1,
        type: "dispatch.started",
        eventAt: NOW,
        dispatch: {
          id: "ambiguous-dispatch-id",
          threadId: THREAD,
          previousTurnId: null,
          attempt: 1,
          startedAt: NOW,
          transportWriteState: "prepared",
          nextAttemptAt: null,
        },
      },
    });
    parent = store.transition({
      jobId: parent.id,
      eventId: "ambiguous-flight",
      expectedVersion: parent.version,
      event: { schemaVersion: 1, type: "dispatch.in_flight", eventAt: NOW },
    });
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await runtime.retry({
      source: { botId: "bot", updateId: 71, chatId: -1001, messageThreadId: 7, messageId: 71 },
      target: { jobId: parent.id, version: parent.version },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(store.get(parent.id)).toMatchObject({ phase: "terminal", outcome: "recovery_interrupted" });
    expect(harness.session.prompt).toHaveBeenCalledOnce();
    expect(store.getBySourceKey({ botId: "bot", updateId: 71 })).toMatchObject({
      phase: "terminal",
      outcome: "completed",
    });
  });

  it("resumes an unplanned delivering job through the same plan and outbox pipeline", async () => {
    const jobId = await seedDelivering(store, directory);
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await runtime.reconcile();

    expect(store.get(jobId)).toMatchObject({
      phase: "terminal", outcome: "completed", responsePlan: [{ partId: "final:0000", kind: "final" }],
    });
    expect(harness.delivery.deliver).toHaveBeenCalledWith(
      {
        operation: "send_text", chatId: -1001, messageThreadId: 7,
        text: "recovered answer",
      },
      expect.any(AbortSignal),
    );
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.session.recoverPrompt).not.toHaveBeenCalled();
  });

  it("finds the exact topic through durable storage even behind more than one thousand noisy jobs", async () => {
    acceptBare(store, "z-target", source({ updateId: 40, messageId: 40 }));
    for (let index = 0; index < 1_001; index += 1) {
      acceptBare(store, `a-noise-${String(index).padStart(4, "0")}`, source({
        updateId: 1_000 + index, chatId: -2002, messageThreadId: 9, messageId: 1_000 + index,
      }));
    }
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await expect(runtime.latestJob({ botId: "bot", chatId: -1001, messageThreadId: 7 }))
      .resolves.toEqual({ jobId: "z-target", version: 1 });
  });

  it("rejects cross-topic abort before touching the exact durable job", async () => {
    let id = 0;
    const ingress = new TelegramJobIngress({
      store, materializationRoot: path.join(directory, "materialized"), now: () => NOW,
      createId: () => `abort-seed-${++id}`, downloadAttachment: async () => new Uint8Array(),
    });
    const accepted = ingress.accept(source({ updateId: 50, messageId: 50 }));
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    await expect(runtime.abort({
      source: { botId: "bot", updateId: 51, chatId: -2002, messageThreadId: 7, messageId: 51 },
      target: { jobId: accepted.job.id, version: accepted.job.version },
    })).rejects.toThrow("Telegram job source mismatch");

    expect(store.get(accepted.job.id)).toMatchObject({ phase: "accepted", version: accepted.job.version });
    expect(harness.session.abort).not.toHaveBeenCalled();
  });

  it("loads bounded Dashboard rows through the canonical status reader and validates exact actions", async () => {
    const harness = createHarness(store, directory);
    const checkAppServer = vi.fn(async () => undefined);
    const checkTelegram = vi.fn(async () => undefined);
    const guardianStatus = vi.fn(async () => ({
      outcome: "ok" as const,
      message: "ok",
      status: {
        running: true,
        observationOnly: true,
        repairEnabled: false,
        appServerConnected: true,
        scanStale: false,
        scans: 3,
        lastScanAt: NOW - 1_000,
      },
    }));
    harness.options.checkAppServer = checkAppServer;
    harness.options.checkTelegram = checkTelegram;
    harness.options.guardian.status = guardianStatus;
    runtime = createTelegramReliabilityRuntime(harness.options);
    const accepted = await runtime.handle(source());

    const snapshot = await runtime.loadDashboardReliability();
    const canonical = snapshot.jobs.find(({ projection }) => projection.jobId === accepted.job.id)!;

    expect(canonical.projection).toMatchObject({ jobId: accepted.job.id, state: "terminal_delivered" });
    const eventTypes = new Set(store.listEvents(accepted.job.id).map(({ event }) => event.type));
    expect(canonical.events.every(({ code }) => eventTypes.has(code as never))).toBe(true);
    expect(JSON.stringify(canonical.events)).not.toContain("answer");
    expect(snapshot).toMatchObject({
      appServer: { connectivity: "connected", reasonCode: null },
      guardian: { connectivity: "connected", mode: "observe", lastScanAt: NOW - 1_000 },
      telegram: { deliveryHealth: "healthy", reasonCode: null },
    });
    expect(checkAppServer).toHaveBeenCalledOnce();
    expect(checkTelegram).toHaveBeenCalledOnce();

    const details = canonical.projection.actions.find(({ kind }) => kind === "details")!;
    await expect(runtime.runDashboardAction({ ...details, expectedVersion: details.expectedVersion + 1 }))
      .rejects.toThrow("Dashboard action is no longer legal");
    await expect(runtime.runDashboardAction(details)).resolves.toBeUndefined();
  });

  it("exposes and executes only the exact server-proven missing-topic recovery action", async () => {
    const seeded = seedTopicRecoveryCandidate(store);
    const harness = createHarness(store, directory);
    const recovery = recoveryOptions(seeded);
    harness.options.topicRecovery = recovery.options;
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;
    const action = projection.actions.find(({ kind }) => kind === "recover_missing_topic");

    expect(action).toEqual({
      kind: "recover_missing_topic",
      jobId: seeded.candidate.jobId,
      expectedVersion: seeded.candidate.expectedVersion,
    });
    expect(store.getTopicRecovery(seeded.candidate.jobId)).toBeNull();
    await expect(runtime.runDashboardAction({ ...action!, expectedVersion: action!.expectedVersion + 1 }))
      .rejects.toThrow("Dashboard action is no longer legal");
    expect(recovery.createForumTopic).not.toHaveBeenCalled();

    await runtime.runDashboardAction(action!);

    expect(recovery.probeForumTopic).toHaveBeenCalledOnce();
    expect(recovery.createForumTopic).toHaveBeenCalledOnce();
    expect(store.getTopicRecovery(seeded.candidate.jobId)).toMatchObject({ state: "complete" });
  });

  it("hides recovery and anchor retry actions while topic recovery is active", async () => {
    const seeded = seedTopicRecoveryCandidate(store);
    store.reserveTopicRecovery({
      candidate: seeded.candidate,
      eventId: "dashboard-recovery-reserved",
      actionToken: "c".repeat(64),
      eventAt: NOW - 1,
    });
    const harness = createHarness(store, directory);
    harness.options.topicRecovery = recoveryOptions(seeded).options;
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;

    expect(projection.actions.some(({ kind }) => kind === "recover_missing_topic")).toBe(false);
    expect(projection.actions.some(({ kind, partKey }) =>
      kind === "retry_delivery" && partKey === "status-anchor")).toBe(false);
    expect(projection.actions.some(({ kind }) => kind === "details")).toBe(true);
  });

  it("keeps missing-topic recovery unreachable when its runtime is disabled", async () => {
    const seeded = seedTopicRecoveryCandidate(store);
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;

    expect(projection.actions.some(({ kind }) => kind === "recover_missing_topic")).toBe(false);
    expect(projection.actions).toContainEqual(expect.objectContaining({
      kind: "retry_delivery",
      partKey: "status-anchor",
    }));
  });

  it.each([
    ["standard", "resume_existing_topic", 1],
    ["warning_replay", "resume_existing_topic_warning", 4],
  ] as const)("exposes and executes only the exact %s resume action", async (mode, kind, baseline) => {
    const seeded = seedExistingTopicResumeCandidate(store, baseline);
    const harness = createHarness(store, directory);
    const topicResume = topicResumeOptions(seeded);
    harness.options.topicRecovery = failedRecoveryProjectionOptions(seeded);
    harness.options.topicResume = { ...topicResume.options, allowedModes: new Set([mode]) };
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;
    const action = projection.actions.find((candidate) => candidate.kind === kind);

    expect(action).toEqual({
      kind,
      jobId: seeded.candidate.jobId,
      expectedVersion: seeded.candidate.expectedVersion,
    });
    expect(projection.actions.some(({ kind, partKey }) =>
      kind === "retry_delivery" && partKey === "status-anchor")).toBe(true);
    expect(store.getTopicResume(seeded.candidate.jobId)).toBeNull();
    await expect(runtime.runDashboardAction({ ...action!, expectedVersion: action!.expectedVersion - 1 }))
      .rejects.toThrow("Dashboard action is no longer legal");
    expect(topicResume.classifyForumTopic).not.toHaveBeenCalled();
    const mismatchedKind = kind === "resume_existing_topic"
      ? "resume_existing_topic_warning" : "resume_existing_topic";
    await expect(runtime.runDashboardAction({ ...action!, kind: mismatchedKind }))
      .rejects.toThrow("Dashboard action is no longer legal");

    await runtime.runDashboardAction(action!);

    expect(topicResume.classifyForumTopic).toHaveBeenCalledOnce();
    expect(topicResume.reopenForumTopic).not.toHaveBeenCalled();
    expect(store.getTopicResume(seeded.candidate.jobId)).toMatchObject({ state: "complete" });
  });

  it("keeps Dashboard available when warning eligibility advances during projection", async () => {
    const seeded = seedExistingTopicResumeCandidate(store, 4);
    const harness = createHarness(store, directory);
    const topicResume = topicResumeOptions(seeded);
    harness.options.topicRecovery = failedRecoveryProjectionOptions(seeded);
    harness.options.topicResume = {
      ...topicResume.options,
      allowedModes: new Set(["warning_replay"]),
    };
    const inspectThread = harness.options.guardian.inspectThread;
    let advanced = false;
    harness.options.guardian.inspectThread = vi.fn(async (threadId) => {
      if (!advanced) {
        advanced = true;
        const current = store.get(seeded.job.id)!;
        store.transition({
          jobId: current.id,
          eventId: "warning-projection-race",
          expectedVersion: current.version,
          event: {
            schemaVersion: 1,
            type: "activity.observed",
            eventAt: NOW,
            health: "healthy",
          },
        });
      }
      return inspectThread(threadId);
    });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const raced = await runtime.loadDashboardReliability();
    const racedProjection = raced.jobs.find(({ projection }) =>
      projection.jobId === seeded.candidate.jobId)!.projection;
    expect(racedProjection.actions.some(({ kind }) =>
      kind === "resume_existing_topic_warning")).toBe(false);
    expect(store.getTopicResume(seeded.candidate.jobId)).toBeNull();

    const stable = await runtime.loadDashboardReliability();
    const stableProjection = stable.jobs.find(({ projection }) =>
      projection.jobId === seeded.candidate.jobId)!.projection;
    expect(stableProjection.actions).toContainEqual(expect.objectContaining({
      kind: "resume_existing_topic_warning",
      expectedVersion: store.get(seeded.candidate.jobId)!.version,
    }));
  });

  it.each([
    [1, []], [4, []], [1, ["warning_replay"]], [4, ["standard"]],
  ] as const)("does not expose or execute a mode outside the allowed set (%s, %s)", async (baseline, modes) => {
    const seeded = seedExistingTopicResumeCandidate(store, baseline);
    const harness = createHarness(store, directory);
    const topicResume = topicResumeOptions(seeded);
    harness.options.topicResume = { ...topicResume.options, allowedModes: new Set(modes) };
    runtime = createTelegramReliabilityRuntime(harness.options);
    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;
    expect(projection.actions.some(({ kind }) => kind.startsWith("resume_existing_topic"))).toBe(false);
    for (const kind of ["resume_existing_topic", "resume_existing_topic_warning"] as const) {
      await expect(runtime.runDashboardAction({
        kind, jobId: seeded.job.id, expectedVersion: seeded.job.version,
      })).rejects.toThrow("Dashboard action is no longer legal");
    }
    expect(store.getTopicResume(seeded.job.id)).toBeNull();
    expect(topicResume.classifyForumTopic).not.toHaveBeenCalled();
  });

  it("reloads current thread binding evidence before reserving an existing-topic resume", async () => {
    const seeded = seedExistingTopicResumeCandidate(store);
    const harness = createHarness(store, directory);
    const topicResume = topicResumeOptions(seeded);
    harness.options.topicResume = topicResume.options;
    runtime = createTelegramReliabilityRuntime(harness.options);
    const snapshot = await runtime.loadDashboardReliability();
    const action = snapshot.jobs.find(({ projection }) => projection.jobId === seeded.candidate.jobId)!
      .projection.actions.find(({ kind }) => kind === "resume_existing_topic")!;

    topicResume.hasThreadTopicBinding.mockReturnValue(false);

    await expect(runtime.runDashboardAction(action)).rejects.toThrow("Dashboard action is no longer legal");
    expect(topicResume.classifyForumTopic).not.toHaveBeenCalled();
    expect(topicResume.reopenForumTopic).not.toHaveBeenCalled();
    expect(store.getTopicResume(seeded.candidate.jobId)).toBeNull();
  });

  it("keeps exact existing-topic resume projection and execution absent when disabled", async () => {
    const seeded = seedExistingTopicResumeCandidate(store);
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;

    expect(projection.actions.some(({ kind }) => kind === "resume_existing_topic")).toBe(false);
    expect(projection.actions).toContainEqual(expect.objectContaining({
      kind: "retry_delivery",
      partKey: "status-anchor",
    }));
    await expect(runtime.runDashboardAction({
      kind: "resume_existing_topic",
      jobId: seeded.candidate.jobId,
      expectedVersion: seeded.candidate.expectedVersion,
    })).rejects.toThrow("Dashboard action is no longer legal");
    expect(store.getTopicResume(seeded.candidate.jobId)).toBeNull();
  });

  it("fails closed without hiding Dashboard when persisted resume evidence is malformed", async () => {
    const seeded = seedExistingTopicResumeCandidate(store);
    const harness = createHarness(store, directory);
    harness.options.topicResume = topicResumeOptions(seeded).options;
    vi.spyOn(store, "getStatusAnchorPlan").mockImplementation((jobId) => {
      if (jobId === seeded.candidate.jobId) {
        throw new Error("Malformed Telegram status anchor plan");
      }
      return null;
    });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;

    expect(projection.actions.some(({ kind }) => kind === "resume_existing_topic")).toBe(false);
    expect(projection.actions).toContainEqual(expect.objectContaining({
      kind: "retry_delivery",
      partKey: "status-anchor",
    }));
    expect(store.getTopicResume(seeded.candidate.jobId)).toBeNull();
  });

  it.each([
    ["resume row", "getTopicResume", "Malformed Telegram topic resume", false],
    ["source payload", "readSourcePayload", "Malformed Telegram job source payload", true],
  ] as const)("fails closed without hiding Dashboard for a malformed %s", async (
    _label,
    method,
    message,
    expectAnchorRetry,
  ) => {
    const seeded = seedExistingTopicResumeCandidate(store);
    const harness = createHarness(store, directory);
    harness.options.topicResume = topicResumeOptions(seeded).options;
    const original = store[method].bind(store);
    vi.spyOn(store, method).mockImplementation((jobId) => {
      if (jobId === seeded.candidate.jobId) throw new Error(message);
      return original(jobId) as never;
    });
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;

    expect(projection.actions.some(({ kind }) => kind === "resume_existing_topic")).toBe(false);
    expect(projection.actions.some(({ kind, partKey }) =>
      kind === "retry_delivery" && partKey === "status-anchor")).toBe(expectAnchorRetry);
  });

  it("keeps Dashboard available when a recovery candidate source is malformed", async () => {
    const seeded = seedTopicRecoveryCandidate(store);
    const readSourcePayload = store.readSourcePayload.bind(store);
    vi.spyOn(store, "readSourcePayload").mockImplementation((jobId) =>
      jobId === seeded.candidate.jobId ? { malformed: true } : readSourcePayload(jobId));
    const harness = createHarness(store, directory);
    harness.options.topicRecovery = recoveryOptions(seeded).options;
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;

    expect(projection.actions.some(({ kind }) => kind === "recover_missing_topic")).toBe(false);
  });

  it.each(["resume", "delivery", "recovery"])(
    "keeps Dashboard available and denies forged generic retry with malformed owned %s", async (kind) => {
      const seeded = seedResumeDelivery(store);
      const database = new Database(path.join(directory, "jobs.sqlite"));
      try {
        if (kind === "resume") database.exec("UPDATE topic_resume_attempts SET action_token = 'invalid'");
        if (kind === "delivery") database.exec("UPDATE deliveries SET payload_json = '['");
        if (kind === "recovery") database.exec("UPDATE topic_recoveries SET action_token = 'invalid'");
      } finally { database.close(); }
      const harness = createHarness(store, directory);
      harness.options.topicRecovery = {
        forumChatId: seeded.external.forumChatId, getThread: () => seeded.external.thread,
        hasThreadTopicBinding: () => true, probeForumTopic: async () => true,
        createForumTopic: async () => seeded.handoff.resume.destination,
        rebindThreadTopic: () => undefined, sendWelcome: async () => undefined,
      };
      runtime = createTelegramReliabilityRuntime(harness.options);
      const snapshot = await runtime.loadDashboardReliability();
      const projection = snapshot.jobs.find(({ projection }) => projection.jobId === seeded.jobId)!.projection;
      expect(projection.actions.some(({ kind }) => kind === "retry_delivery" || kind === "send_again_warning")).toBe(false);
      await expect(runtime.runDashboardAction({ kind: "retry_delivery", jobId: seeded.jobId,
        expectedVersion: projection.expectedVersion, partKey: "status-anchor" }))
        .rejects.toThrow("Dashboard action is no longer legal");
      expect(harness.delivery.deliver).not.toHaveBeenCalled();
    },
  );

  it.each(["resume", "recovery"])("quarantines malformed inherited %s ownership before runtime reconciliation", async (kind) => {
    const seeded = seedResumeDelivery(store);
    const database = new Database(path.join(directory, "jobs.sqlite"));
    try {
      if (kind === "resume") database.exec("UPDATE topic_resume_attempts SET action_token = 'invalid'");
      else database.exec("UPDATE topic_recoveries SET state = 'in_flight', action_token = 'invalid'");
    }
    finally { database.close(); }
    const harness = createHarness(store, directory);
    harness.options.topicResume = {
      allowedModes: new Set(["standard"]), forumChatId: seeded.external.forumChatId,
      getThread: () => seeded.external.thread, hasThreadTopicBinding: () => true,
      classifyForumTopic: vi.fn(async () => "live"), reopenForumTopic: vi.fn(async () => true),
    };
    harness.options.topicRecovery = {
      forumChatId: seeded.external.forumChatId, getThread: () => seeded.external.thread,
      hasThreadTopicBinding: () => true, probeForumTopic: async () => true,
      createForumTopic: async () => seeded.handoff.resume.destination,
      rebindThreadTopic: () => undefined, sendWelcome: async () => undefined,
    };
    runtime = createTelegramReliabilityRuntime(harness.options);
    await expect(runtime.reconcile()).resolves.toMatchObject({ effectsFailed: 0 });
    expect(store.hasJobQuarantine(seeded.jobId)).toBe(true);
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    await expect(runtime.reconcile()).resolves.toMatchObject({ effectsFailed: 0 });
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
  });

  it("contains malformed delivery evidence immediately after the initial handoff CAS", async () => {
    const seeded = seedExistingTopicResumeCandidate(store);
    const harness = createHarness(store, directory);
    harness.options.topicResume = topicResumeOptions(seeded).options;
    const transition = store.transitionTopicResume.bind(store);
    vi.spyOn(store, "transitionTopicResume").mockImplementation((input) => {
      const result = transition(input);
      if (input.state === "delivery_handoff") {
        const database = new Database(path.join(directory, "jobs.sqlite"));
        try { database.exec("UPDATE deliveries SET payload_json = '['"); }
        finally { database.close(); }
      }
      return result;
    });
    runtime = createTelegramReliabilityRuntime(harness.options);
    await expect(runtime.runDashboardAction({ kind: "resume_existing_topic", jobId: seeded.job.id,
      expectedVersion: seeded.job.version })).resolves.toBeUndefined();
    expect(store.hasJobQuarantine(seeded.job.id)).toBe(true);
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
  });

  it("loads durable Dashboard session statuses without live Guardian or connectivity probes", async () => {
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);
    const accepted = await runtime.handle(source());
    vi.clearAllMocks();

    const statuses = await runtime.loadDashboardSessionStatuses();

    expect(statuses).toContainEqual(expect.objectContaining({
      threadId: accepted.job.threadId,
      health: "healthy",
      attentionKind: "none",
    }));
    expect(harness.options.guardian.inspectThread).not.toHaveBeenCalled();
    expect(harness.options.checkTelegram).not.toHaveBeenCalled();
  });

  it("uses the current Dashboard delivery retry to recover an installed missing anchor", async () => {
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    harness.options.topicResume = dormantTopicResumeOptions();
    harness.options.prepareCompletion = vi.fn(async ({ result }) => ({
      result,
      supplementalParts: [{
        partKey: "notice:complete",
        kind: "notice" as const,
        payload: {
          operation: "send_text" as const,
          chatId: -1001,
          messageThreadId: 7,
          text: "Saved.",
        },
      }],
    }));
    harness.delivery.deliver.mockRejectedValueOnce(new TelegramDeliveryApiError("permanent"));
    runtime = createTelegramReliabilityRuntime(harness.options);
    const accepted = await runtime.handle(source({
      updateId: 97,
      messageId: 97,
      kind: "confirmation",
      completion: { kind: "inbox_ticket", ticketId: 12 },
    }));
    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) => value.jobId === accepted.job.id)!.projection;
    const action = projection.actions.find((candidate) =>
      candidate.kind === "retry_delivery" && candidate.partKey === "status-anchor")!;
    harness.delivery.deliver.mockClear();
    harness.session.prompt.mockClear();
    harness.session.recoverPrompt.mockClear();
    let call = 0;
    harness.delivery.deliver.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new TelegramDeliveryApiError("message_missing");
      return { messageId: 900 + call };
    });

    await expect(runtime.runDashboardAction({ ...action, expectedVersion: action.expectedVersion - 1 }))
      .rejects.toThrow("Dashboard action is no longer legal");
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    const resumeCallsBeforeRetry = listResumes.mock.calls.length;
    await runtime.runDashboardAction(action);

    expect(harness.delivery.deliver.mock.calls.map(([payload]) => payload.operation)).toEqual([
      "edit_text", "send_text", "send_text", "send_text",
    ]);
    expect(harness.delivery.deliver.mock.calls[1]![0]).toMatchObject({
      operation: "send_text", chatId: -1001, messageThreadId: 7,
    });
    expect(store.get(accepted.job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.session.recoverPrompt).not.toHaveBeenCalled();
    expect(listResumes.mock.calls.length).toBeGreaterThan(resumeCallsBeforeRetry);
  });

  it("reconciles topic resume after an explicit uncertain-delivery resend", async () => {
    const seeded = seedTopicRecoveryCandidate(store);
    let job = store.get(seeded.candidate.jobId)!;
    const anchor = store.listDeliveries(job.id).find((part) =>
      part.partKey === "status-anchor")!;
    const anchorSending = store.transitionDeliveryAndProject({
      jobId: job.id,
      partKey: anchor.partKey,
      expectedJobVersion: job.version,
      expectedState: "failed",
      expectedAttemptCount: anchor.attemptCount,
      state: "sending",
      attemptCount: anchor.attemptCount,
      allowFailedRetry: true,
      nextAttemptAt: NOW + 1_000,
      eventId: "explicit-resend-anchor-sending",
      updatedAt: NOW,
    });
    const anchorDelivered = store.transitionDeliveryAndProject({
      jobId: job.id,
      partKey: anchor.partKey,
      expectedJobVersion: anchorSending.job.version,
      expectedState: "sending",
      expectedAttemptCount: anchor.attemptCount,
      state: "delivered",
      attemptCount: anchor.attemptCount + 1,
      telegramMessageId: 701,
      eventId: "explicit-resend-anchor-delivered",
      updatedAt: NOW,
    });
    const follower = store.listDeliveries(job.id).find((part) =>
      part.partKey !== "status-anchor")!;
    const followerSending = store.transitionDeliveryAndProject({
      jobId: job.id,
      partKey: follower.partKey,
      expectedJobVersion: anchorDelivered.job.version,
      expectedState: "pending",
      expectedAttemptCount: follower.attemptCount,
      state: "sending",
      attemptCount: follower.attemptCount,
      nextAttemptAt: NOW + 1_000,
      eventId: "explicit-resend-follower-sending",
      updatedAt: NOW,
    });
    store.transitionDeliveryAndProject({
      jobId: job.id,
      partKey: follower.partKey,
      expectedJobVersion: followerSending.job.version,
      expectedState: "sending",
      expectedAttemptCount: follower.attemptCount,
      state: "uncertain",
      attemptCount: follower.attemptCount + 1,
      lastErrorCode: "telegram_send_uncertain",
      attention: {
        kind: "required",
        code: "telegram_delivery_uncertain",
        actions: ["send_again", "inspect"],
      },
      eventId: "explicit-resend-follower-uncertain",
      updatedAt: NOW,
    });
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    harness.options.topicResume = dormantTopicResumeOptions();
    runtime = createTelegramReliabilityRuntime(harness.options);
    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) =>
      value.jobId === seeded.candidate.jobId)!.projection;
    expect(projection.state).toBe("delivery_uncertain");
    const resend = projection.actions.find((candidate) =>
      candidate.kind === "send_again_warning")!;
    harness.delivery.deliver.mockResolvedValue({ messageId: 799 });
    const resumeCallsBeforeResend = listResumes.mock.calls.length;

    await runtime.runDashboardAction(resend);

    expect(listResumes.mock.calls.length).toBeGreaterThan(resumeCallsBeforeResend);
  });

  it("rejects a Dashboard delivery retry raced after validation before any Telegram call", async () => {
    const harness = createHarness(store, directory);
    const listResumes = vi.spyOn(store, "listTopicResumes");
    harness.options.topicResume = dormantTopicResumeOptions();
    harness.options.prepareCompletion = vi.fn(async ({ result }) => ({
      result,
      supplementalParts: [{
        partKey: "notice:complete",
        kind: "notice" as const,
        payload: {
          operation: "send_text" as const,
          chatId: -1001,
          messageThreadId: 7,
          text: "Saved.",
        },
      }],
    }));
    harness.delivery.deliver.mockRejectedValueOnce(new TelegramDeliveryApiError("permanent"));
    runtime = createTelegramReliabilityRuntime(harness.options);
    const accepted = await runtime.handle(source({
      updateId: 98,
      messageId: 98,
      kind: "confirmation",
      completion: { kind: "inbox_ticket", ticketId: 12 },
    }));
    const snapshot = await runtime.loadDashboardReliability();
    const projection = snapshot.jobs.find(({ projection: value }) => value.jobId === accepted.job.id)!.projection;
    const action = projection.actions.find((candidate) =>
      candidate.kind === "retry_delivery" && candidate.partKey === "status-anchor")!;
    harness.delivery.deliver.mockClear();
    harness.delivery.deliver.mockRejectedValue(new TelegramDeliveryApiError("message_missing"));
    const inspect = harness.options.guardian.inspectThread;
    let entered!: () => void;
    let release!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    harness.options.guardian.inspectThread = vi.fn(async (threadId) => {
      entered();
      await blocked;
      return inspect(threadId);
    });

    const resumeCallsBeforeRetry = listResumes.mock.calls.length;
    const retrying = runtime.runDashboardAction(action);
    await inspectionStarted;
    const current = store.get(accepted.job.id)!;
    store.transition({
      jobId: current.id,
      eventId: "dashboard-delivery-retry-race",
      expectedVersion: current.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: NOW, health: "healthy" },
    });
    release();

    await expect(retrying).rejects.toThrow("Telegram job version conflict");
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    expect(store.listDeliveries(accepted.job.id).find((part) => part.partKey === "status-anchor"))
      .toMatchObject({ state: "failed" });
    expect(listResumes.mock.calls.length).toBeGreaterThan(resumeCallsBeforeRetry);
  });

  it("preserves the last Guardian scan and reports a connected stale scanner", async () => {
    const harness = createHarness(store, directory);
    harness.options.guardian.status = vi.fn(async () => ({
      outcome: "degraded" as const,
      message: "Guardian is degraded",
      status: {
        running: true,
        observationOnly: true,
        repairEnabled: false,
        appServerConnected: true,
        scanStale: true,
        scans: 3,
        lastScanAt: NOW - 121_000,
      },
    }));
    runtime = createTelegramReliabilityRuntime(harness.options);

    await expect(runtime.loadDashboardReliability()).resolves.toMatchObject({
      guardian: {
        connectivity: "connected",
        mode: "observe",
        lastScanAt: NOW - 121_000,
        reasonCode: "GUARDIAN_SCAN_STALE",
      },
    });
  });

  it("bounds and aborts the Telegram API probe before reporting it unavailable", async () => {
    vi.useFakeTimers();
    const harness = createHarness(store, directory);
    let aborted = false;
    harness.options.checkTelegram = vi.fn((signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }));
    runtime = createTelegramReliabilityRuntime(harness.options);

    const loading = runtime.loadDashboardReliability();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(loading).resolves.toMatchObject({
      telegram: { deliveryHealth: "unavailable", reasonCode: "TELEGRAM_UNAVAILABLE" },
    });
    expect(aborted).toBe(true);
  });

  it("starts an explicit retry as a new canonical job from a currently legal Dashboard action", async () => {
    let id = 0;
    const ingress = new TelegramJobIngress({
      store, materializationRoot: path.join(directory, "materialized"), now: () => NOW,
      createId: () => `dashboard-retry-seed-${++id}`, downloadAttachment: async () => new Uint8Array(),
    });
    const accepted = ingress.accept(source({ updateId: 70, messageId: 70 }));
    await ingress.materialize(accepted.job.id);
    let job = store.get(accepted.job.id)!;
    job = store.transition({ jobId: job.id, eventId: "dashboard-retry-queued", expectedVersion: job.version,
      event: { schemaVersion: 1, type: "job.queued", eventAt: NOW } });
    store.transition({ jobId: job.id, eventId: "dashboard-retry-dispatch", expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.started", eventAt: NOW, dispatch: {
        id: "dashboard-retry-dispatch", threadId: THREAD, previousTurnId: null, attempt: 1,
        startedAt: NOW, transportWriteState: "written", nextAttemptAt: null,
      } } });
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);
    const snapshot = await runtime.loadDashboardReliability();
    const action = snapshot.jobs[0]!.projection.actions.find(({ kind }) => kind === "retry_new_turn")!;
    const transition = store.transition.bind(store);
    let crashBeforeRelease = true;
    vi.spyOn(store, "transition").mockImplementation((input) => {
      if (crashBeforeRelease && input.event.type === "job.terminal"
        && input.event.outcome === "recovery_interrupted") {
        crashBeforeRelease = false;
        throw new Error("simulated crash before parent release");
      }
      return transition(input);
    });

    await expect(runtime.runDashboardAction(action)).rejects.toThrow("simulated crash");
    expect(store.countJobs()).toBe(2);
    await runtime.runDashboardAction(action);

    expect(store.countJobs()).toBe(2);
    expect(store.listRecent(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: accepted.job.id, outcome: "recovery_interrupted" }),
      expect.objectContaining({ phase: "running", outcome: null }),
    ]));
    expect(harness.session.prompt).toHaveBeenCalledOnce();
  });

  it("keeps cards bounded while aggregating every canonical job", async () => {
    for (let index = 0; index < 201; index += 1) {
      acceptBare(store, `aggregate-${index}`, source({ updateId: 10_000 + index, messageId: 10_000 + index }));
    }
    const harness = createHarness(store, directory);
    runtime = createTelegramReliabilityRuntime(harness.options);

    const snapshot = await runtime.loadDashboardReliability();

    expect(snapshot.jobs).toHaveLength(200);
    expect(snapshot.aggregates).toMatchObject({
      counts: { inProgress: 201, undelivered: 201 },
    });

    const compact = await runtime.loadDashboardReliability(8);
    expect(compact.jobs).toHaveLength(8);
    expect(compact.aggregates).toMatchObject({
      counts: { inProgress: 201, undelivered: 201 },
    });
  });
});

function createHarness(store: SqliteTelegramJobStore, directory: string) {
  let threadId: string | null = null;
  let sandboxMode = "workspace-write";
  let sequence = 0;
  const session = {
    getInfo: vi.fn(() => ({ threadId, sandboxMode })),
    newThread: vi.fn(async () => { threadId = THREAD; return { threadId }; }),
    prompt: vi.fn(async (_input, callbacks) => {
      callbacks.beforeDispatchWrite?.({
        threadId: THREAD, previousTurnId: null, previousTurnKnown: true, attempt: 1,
      });
      callbacks.onDispatchWritten?.();
      callbacks.onStarted?.("turn-exact");
      callbacks.onTextDelta("answer");
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: NOW });
    }),
    recoverPrompt: vi.fn(async () => undefined),
    forkThread: vi.fn(async () => {
      threadId = THREAD;
      sandboxMode = "workspace-write";
      return { threadId };
    }),
    resumeThread: vi.fn(async (nextThreadId: string) => {
      threadId = nextThreadId;
      return { threadId };
    }),
    abortTurn: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const guardianInspection = {
    threadId: THREAD, turnId: "turn-exact", threadStatus: "idle" as const,
    turnStatus: "completed", updatedAt: NOW, itemCount: 1, lastItemType: "agent_message",
    source: "telecodex" as const, canAcceptDirectInput: true, root: true,
  };
  const delivery = { deliver: vi.fn(async () => ({ messageId: 501 })) };
  const status = {
    send: vi.fn(async () => 501), edit: vi.fn(async () => undefined),
  };
  const registry = {
    getOrCreate: vi.fn(async () => session), updateMetadata: vi.fn(), setContextDefaults: vi.fn(),
    listContexts: vi.fn(() => [{ contextKey: "-1001:7" as const, threadId: THREAD }]),
  };
  const options: TelegramReliabilityRuntimeOptions = {
    store,
    registry,
    materializationRoot: path.join(directory, "materialized"),
    exactTurnReader: { request: vi.fn(async () => ({
      thread: { id: THREAD, turns: [{ id: "turn-exact", status: "completed" }] },
    })) },
    guardian: { inspectThread: vi.fn(async () => ({
      outcome: "ok" as const, message: "ok", threadId: THREAD, thread: guardianInspection,
    })) },
    checkTelegram: vi.fn(async () => undefined),
    downloadAttachment: vi.fn(async () => new Uint8Array()),
    statusTransport: status,
    classifyStatusTransportError: () => ({ disposition: "permanent" }),
    deliveryTransport: delivery,
    now: () => NOW,
    createId: () => `runtime-${++sequence}`,
    scheduleCoordinatorWakeup: () => {},
    scheduleDeliveryWakeup: () => {},
  };
  return { options, session, registry, delivery, status };
}

function seedTopicRecoveryCandidate(store: SqliteTelegramJobStore) {
  const oldDestination = { chatId: -1001, messageThreadId: 7 } as const;
  const newDestination = { chatId: oldDestination.chatId, messageThreadId: 99 } as const;
  const input = source({ updateId: 404, messageId: 404, ...oldDestination });
  let job: TelegramJob = {
    schemaVersion: 1 as const,
    version: 1,
    id: "recovery-drain",
    source: { botId: input.botId, updateId: input.updateId },
    attachments: [],
    phase: "accepted" as const,
    health: "healthy" as const,
    activity: "unknown" as const,
    attention: { kind: "none" as const },
    outcome: null,
    dispatchId: null,
    threadId: null,
    turnId: null,
    responsePlan: undefined,
    deliveries: [],
    acceptedAt: NOW - 100,
    updatedAt: NOW - 100,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
  store.acceptUpdate({ job, sourcePayload: input, eventId: "recovery-drain-accepted" });
  job = store.transition({ jobId: job.id, eventId: "recovery-drain-queued", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "job.queued", eventAt: NOW - 99 } });
  job = store.transition({ jobId: job.id, eventId: "recovery-drain-dispatched", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "dispatch.started", eventAt: NOW - 98, dispatch: {
      id: "recovery-drain-dispatch", threadId: THREAD, previousTurnId: null, attempt: 1,
      startedAt: NOW - 98, transportWriteState: "written", nextAttemptAt: null,
    } } });
  job = store.transition({ jobId: job.id, eventId: "recovery-drain-started", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.started", eventAt: NOW - 97,
      identifiers: { turnId: "recovery-drain-turn" }, codexEventAt: NOW - 97 } });
  job = store.transition({ jobId: job.id, eventId: "recovery-drain-completed", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.completed", eventAt: NOW - 96,
      codexEventAt: NOW - 96, turnResult: { schemaVersion: 1, content: [] } } });
  const anchor = { operation: "send_text" as const, ...oldDestination, text: "Response follows." };
  const final = { operation: "send_text" as const, ...oldDestination, text: "Recovered result" };
  job = store.installDeliveryPlan({
    jobId: job.id,
    expectedVersion: job.version,
    eventId: "recovery-drain-plan",
    eventAt: NOW - 95,
    responsePlan: [{ partId: "final:0000", kind: "final" }],
    parts: [
      { jobId: job.id, partKey: "status-anchor", ordinal: 0, kind: "status-anchor",
        state: "pending", payload: anchor, contentHash: hashTelegramDeliveryPayload(anchor), updatedAt: NOW - 95 },
      { jobId: job.id, partKey: "final:0000", ordinal: 0, kind: "final",
        state: "pending", payload: final, contentHash: hashTelegramDeliveryPayload(final), updatedAt: NOW - 95 },
    ],
  });
  let changed = store.transitionDeliveryAndProject({
    jobId: job.id, partKey: "status-anchor", expectedJobVersion: job.version,
    expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
    eventId: "recovery-drain-anchor-sending", updatedAt: NOW - 94,
  });
  changed = store.transitionDeliveryAndProject({
    jobId: job.id, partKey: "status-anchor", expectedJobVersion: changed.job.version,
    expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
    lastErrorCode: "telegram_topic_missing", eventId: "recovery-drain-anchor-failed",
    updatedAt: NOW - 93,
    attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
  });
  job = changed.job;
  const thread: CodexThreadRecord = {
    id: THREAD,
    title: "Recovery drain",
    cwd: "/work/telecodex",
    model: null,
    modelProvider: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    firstUserMessage: "recover",
  };
  const candidate = planTelegramTopicRecovery({
    job,
    source: input,
    deliveries: store.listDeliveries(job.id),
    anchorPlan: { payload: anchor, contentHash: hashTelegramDeliveryPayload(anchor) },
    thread,
  });
  if (!candidate) throw new Error("Expected topic recovery drain candidate");
  return { oldDestination, newDestination, thread, candidate };
}

function seedDueTopicRecovery(store: SqliteTelegramJobStore) {
  const seeded = seedTopicRecoveryCandidate(store);
  const { candidate } = seeded;
  const reserved = store.reserveTopicRecovery({
    candidate,
    eventId: "recovery-drain-reserved",
    actionToken: "b".repeat(64),
    eventAt: NOW - 92,
  });
  store.deferTopicRecovery({
    jobId: candidate.jobId,
    expectedVersion: reserved.job.version,
    actionToken: reserved.recovery.actionToken,
    updatedAt: NOW - 1,
    nextAttemptAt: NOW,
  });
  return seeded;
}

function recoveryOptions(seeded: ReturnType<typeof seedTopicRecoveryCandidate>) {
  const probeForumTopic = vi.fn(async () => false);
  const createForumTopic = vi.fn(async () => seeded.newDestination);
  return {
    probeForumTopic,
    createForumTopic,
    options: {
      forumChatId: seeded.oldDestination.chatId,
      hasThreadTopicBinding: vi.fn((threadId, destination) =>
        threadId === seeded.thread.id
        && destination.chatId === seeded.oldDestination.chatId
        && destination.messageThreadId === seeded.oldDestination.messageThreadId),
      probeForumTopic,
      createForumTopic,
      getThread: vi.fn((threadId) => threadId === seeded.thread.id
        ? structuredClone(seeded.thread) : null),
      rebindThreadTopic: vi.fn(),
      sendWelcome: vi.fn(async () => undefined),
      scheduleWakeup: vi.fn(),
      reportReason: vi.fn(),
    } satisfies NonNullable<TelegramReliabilityRuntimeOptions["topicRecovery"]>,
  };
}

function topicResumeOptions(seeded: ReturnType<typeof seedExistingTopicResumeCandidate>) {
  const classifyForumTopic = vi.fn(async () => "live" as const);
  const reopenForumTopic = vi.fn(async () => true as const);
  const hasThreadTopicBinding = vi.fn((threadId: string, destination: {
    readonly chatId: number;
    readonly messageThreadId: number;
  }) => threadId === seeded.thread.id
    && destination.chatId === seeded.destination.chatId
    && destination.messageThreadId === seeded.destination.messageThreadId);
  return {
    classifyForumTopic,
    reopenForumTopic,
    hasThreadTopicBinding,
    options: {
      allowedModes: new Set(["standard"] as const),
      forumChatId: seeded.destination.chatId,
      classifyForumTopic,
      reopenForumTopic,
      getThread: vi.fn((threadId) => threadId === seeded.thread.id
        ? structuredClone(seeded.thread) : null),
      hasThreadTopicBinding,
      scheduleWakeup: vi.fn(),
    } satisfies NonNullable<TelegramReliabilityRuntimeOptions["topicResume"]>,
  };
}

function failedRecoveryProjectionOptions(
  seeded: ReturnType<typeof seedExistingTopicResumeCandidate>,
): NonNullable<TelegramReliabilityRuntimeOptions["topicRecovery"]> {
  return {
    forumChatId: seeded.destination.chatId,
    hasThreadTopicBinding: vi.fn(() => true),
    probeForumTopic: vi.fn(async () => true),
    createForumTopic: vi.fn(async () => ({
      chatId: seeded.destination.chatId,
      messageThreadId: seeded.destination.messageThreadId + 1,
    })),
    getThread: vi.fn(() => structuredClone(seeded.thread)),
    rebindThreadTopic: vi.fn(),
    sendWelcome: vi.fn(async () => undefined),
    scheduleWakeup: vi.fn(),
    reportReason: vi.fn(),
  };
}

function seedExistingTopicResumeCandidate(store: SqliteTelegramJobStore, baseline = 1) {
  const destination = { chatId: -1001, messageThreadId: 7 } as const;
  const input = source({ updateId: 405, messageId: 405, ...destination });
  let job: TelegramJob = {
    schemaVersion: 1, version: 1, id: "resume-existing-topic",
    source: { botId: input.botId, updateId: input.updateId }, attachments: [],
    phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" },
    outcome: null, dispatchId: null, threadId: null, turnId: null,
    responsePlan: undefined, deliveries: [], acceptedAt: NOW - 100, updatedAt: NOW - 100,
    terminalAt: null, dismissedAt: null, retainUntil: null,
  };
  store.acceptUpdate({ job, sourcePayload: input, eventId: "resume-existing-accepted" });
  job = store.transition({
    jobId: job.id, eventId: "resume-existing-queued", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "job.queued", eventAt: NOW - 99 },
  });
  job = store.transition({
    jobId: job.id, eventId: "resume-existing-dispatched", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "dispatch.started", eventAt: NOW - 98, dispatch: {
      id: "resume-existing-dispatch", threadId: THREAD, previousTurnId: null, attempt: 1,
      startedAt: NOW - 98, transportWriteState: "written", nextAttemptAt: null,
    } },
  });
  job = store.transition({
    jobId: job.id, eventId: "resume-existing-started", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.started", eventAt: NOW - 97,
      identifiers: { turnId: "resume-existing-turn" }, codexEventAt: NOW - 97 },
  });
  job = store.transition({
    jobId: job.id, eventId: "resume-existing-completed", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.completed", eventAt: NOW - 96,
      codexEventAt: NOW - 96, turnResult: { schemaVersion: 1, content: [] } },
  });
  const anchor = { operation: "send_text" as const, ...destination, text: "Response follows." };
  const final = {
    operation: "send_rich" as const, ...destination, markdown: "# Result", media: [],
    fallbackParts: [{
      partKey: "final:0000:fallback:0000", kind: "final" as const,
      payload: { operation: "send_text" as const, ...destination, text: "Result" },
    }],
  };
  const notice = { operation: "send_text" as const, ...destination, text: "Notice" };
  job = store.installDeliveryPlan({
    jobId: job.id, expectedVersion: job.version, eventId: "resume-existing-plan", eventAt: NOW - 95,
    responsePlan: [
      { partId: "final:0000", kind: "final" },
      { partId: "notice:0001", kind: "notice" },
    ],
    parts: [
      plannedResumePart(job.id, "status-anchor", 0, "status-anchor", anchor, NOW - 95),
      plannedResumePart(job.id, "final:0000", 0, "final", final, NOW - 95),
      plannedResumePart(job.id, "notice:0001", 1, "notice", notice, NOW - 95),
    ],
  });
  let changed = store.transitionDeliveryAndProject({
    jobId: job.id, partKey: "status-anchor", expectedJobVersion: job.version,
    expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
    eventId: "resume-existing-anchor-sending", updatedAt: NOW - 94,
  });
  changed = store.transitionDeliveryAndProject({
    jobId: job.id, partKey: "status-anchor", expectedJobVersion: changed.job.version,
    expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
    lastErrorCode: "telegram_permanent", eventId: "resume-existing-anchor-failed", updatedAt: NOW - 93,
    attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
  });
  job = changed.job;
  const thread: CodexThreadRecord = {
    id: THREAD, title: "Resume topic", cwd: "/work/telecodex", model: null, modelProvider: null,
    createdAt: new Date(0), updatedAt: new Date(0), firstUserMessage: "resume",
  };
  const anchorPlan = { payload: anchor, contentHash: hashTelegramDeliveryPayload(anchor) };
  const recoveryCandidate = planTelegramTopicRecovery({
    job, source: input, deliveries: store.listDeliveries(job.id), anchorPlan, thread,
  });
  if (!recoveryCandidate) throw new Error("Expected missing-topic candidate before failed history");
  const reserved = store.reserveTopicRecovery({
    candidate: recoveryCandidate, eventId: "resume-existing-recovery-reserved",
    actionToken: "d".repeat(64), eventAt: NOW - 92,
  });
  store.failTopicRecovery({
    jobId: job.id, expectedVersion: reserved.job.version, actionToken: reserved.recovery.actionToken,
    reasonCode: "TOPIC_RECOVERY_FAILED", updatedAt: NOW - 91,
  });
  job = store.get(job.id)!;
  if (baseline > 1) {
    store.transitionDelivery({ jobId: job.id, partKey: "status-anchor", state: "failed",
      attemptCount: baseline, lastErrorCode: "telegram_permanent", updatedAt: NOW - 90 });
    job = store.transition({ jobId: job.id, eventId: "warning-baseline-version",
      expectedVersion: job.version,
      event: { schemaVersion: 1, type: "delivery.changed", eventAt: NOW - 90 } });
  }
  const candidate = planTelegramTopicResume({
    job, source: input, deliveries: store.listDeliveries(job.id), anchorPlan, thread,
    recovery: store.getTopicRecovery(job.id), hasExistingAttempt: false,
    forumChatId: destination.chatId, hasThreadTopicBinding: true, quarantined: false,
  });
  if (!candidate) throw new Error("Expected existing-topic resume candidate");
  return { destination, input, job, thread, anchorPlan, candidate };
}

function plannedResumePart(
  jobId: string,
  partKey: string,
  ordinal: number,
  kind: string,
  payload: unknown,
  updatedAt: number,
) {
  return {
    jobId, partKey, ordinal, kind, state: "pending" as const, payload,
    contentHash: hashTelegramDeliveryPayload(payload), updatedAt,
  };
}

function dormantTopicResumeOptions(): NonNullable<TelegramReliabilityRuntimeOptions["topicResume"]> {
  return {
    forumChatId: -1001,
    classifyForumTopic: vi.fn(async () => "live" as const),
    reopenForumTopic: vi.fn(async () => true as const),
    getThread: vi.fn(() => null),
    hasThreadTopicBinding: vi.fn(() => false),
    scheduleWakeup: vi.fn(),
  };
}

function source(overrides: Partial<TelegramWorkSource> = {}): TelegramWorkSource {
  return {
    botId: "bot", updateId: 1, chatId: -1001, messageThreadId: 7, messageId: 19,
    kind: "text", text: "inspect this", attachment: null, retryOfJobId: null, ...overrides,
  };
}

async function seedDelivering(store: SqliteTelegramJobStore, directory: string): Promise<string> {
  let id = 0;
  const ingress = new TelegramJobIngress({
    store, materializationRoot: path.join(directory, "materialized"), now: () => NOW,
    createId: () => `seed-${++id}`, downloadAttachment: async () => new Uint8Array(),
  });
  const accepted = ingress.accept(source({ updateId: 9, messageId: 29 }));
  await ingress.materialize(accepted.job.id);
  let job = store.get(accepted.job.id)!;
  job = store.transition({ jobId: job.id, eventId: "seed-queued", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "job.queued", eventAt: NOW } });
  job = store.transition({ jobId: job.id, eventId: "seed-dispatch", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "dispatch.started", eventAt: NOW, dispatch: {
      id: "seed-dispatch", threadId: THREAD, previousTurnId: null, attempt: 1,
      startedAt: NOW, transportWriteState: "written", nextAttemptAt: null,
    } } });
  job = store.transition({ jobId: job.id, eventId: "seed-turn", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.started", eventAt: NOW,
      identifiers: { turnId: "seed-turn" } } });
  store.transition({ jobId: job.id, eventId: "seed-complete", expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.completed", eventAt: NOW,
      turnResult: { schemaVersion: 1, content: [{ kind: "text", text: "recovered answer" }] } } });
  return job.id;
}

async function seedQueued(
  store: SqliteTelegramJobStore,
  directory: string,
  input: TelegramWorkSource,
) {
  let id = 0;
  const ingress = new TelegramJobIngress({
    store, materializationRoot: path.join(directory, "materialized"), now: () => NOW,
    createId: () => `active-seed-${input.updateId}-${++id}`,
    downloadAttachment: async () => new Uint8Array(),
  });
  const accepted = ingress.accept(input);
  await ingress.materialize(accepted.job.id);
  const materialized = store.get(accepted.job.id)!;
  return store.transition({
    jobId: materialized.id,
    eventId: `active-seed-${input.updateId}-queued`,
    expectedVersion: materialized.version,
    event: { schemaVersion: 1, type: "job.queued", eventAt: NOW },
  });
}

function seedRunning(
  store: SqliteTelegramJobStore,
  queued: NonNullable<ReturnType<SqliteTelegramJobStore["get"]>>,
  turnId: string,
) {
  let job = store.transition({
    jobId: queued.id,
    eventId: `${queued.id}-dispatch`,
    expectedVersion: queued.version,
    event: { schemaVersion: 1, type: "dispatch.started", eventAt: NOW, dispatch: {
      id: `${queued.id}-dispatch`, threadId: THREAD, previousTurnId: null, attempt: 1,
      startedAt: NOW, transportWriteState: "written", nextAttemptAt: null,
    } },
  });
  return store.transition({
    jobId: job.id,
    eventId: `${queued.id}-running`,
    expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.started", eventAt: NOW,
      identifiers: { turnId }, codexEventAt: NOW },
  });
}

function acceptBare(
  store: SqliteTelegramJobStore,
  id: string,
  input: TelegramWorkSource,
  withStatusAnchor = false,
): void {
  const destination = input.targetContext ?? input;
  const anchorPayload = {
    chatId: destination.chatId,
    messageThreadId: destination.messageThreadId,
    sourceMessageId: input.messageId,
  };
  store.acceptUpdate({
    job: {
      schemaVersion: 1, id, version: 1,
      source: { botId: input.botId, updateId: input.updateId }, attachments: [],
      phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" },
      outcome: null, dispatchId: null, threadId: null, turnId: null,
      responsePlan: undefined, deliveries: [], acceptedAt: NOW, updatedAt: NOW,
      terminalAt: null, dismissedAt: null, retainUntil: null,
    },
    sourcePayload: input,
    eventId: `${id}:accepted`,
    ...(withStatusAnchor ? { initialDeliveries: [{
      jobId: id,
      partKey: "status-anchor",
      ordinal: 0,
      kind: "status-anchor" as const,
      state: "pending" as const,
      payload: anchorPayload,
      contentHash: createHash("sha256").update(JSON.stringify(anchorPayload)).digest("hex"),
      updatedAt: NOW,
    }] } : {}),
  });
}
