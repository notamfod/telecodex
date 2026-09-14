import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createTelegramReliabilityRuntime, type TelegramReliabilityRuntimeOptions } from "../src/telegram-reliability-runtime.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { TelegramJobIngress, type TelegramWorkSource } from "../src/telegram-job-ingress.js";
const NOW = 1_700_000_500_000;
const THREAD = "11111111-1111-4111-8111-111111111111";
describe("topic task runtime observer", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let runtime: ReturnType<typeof createTelegramReliabilityRuntime>;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "topic-task-runtime-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
  });
  afterEach(async () => { await runtime?.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  it("observes coordinator transitions and final delivered evidence in the actual target topic", async () => {
    const harness = createHarness(store, directory);
    const observe = vi.fn<NonNullable<TelegramReliabilityRuntimeOptions["topicTaskObserver"]>["observe"]>(async () => undefined);
    runtime = createTelegramReliabilityRuntime({ ...harness.options, topicTaskObserver: { enabled: () => true, observe } });
    await runtime.handle(source({ targetContext: { chatId: -1001, messageThreadId: 99 } }));
    await vi.waitFor(() => expect(observe.mock.calls.some(([job]) => job.phase === "terminal")).toBe(true));
    const calls = observe.mock.calls;
    expect(calls.some(([job]) => job.phase !== "terminal")).toBe(true);
    const [job, projection, deliveries, destination] = calls.find(([job]) => job.phase === "terminal")!;
    expect(job.outcome).toBe("completed");
    expect(projection.expectedVersion).toBe(job.version);
    expect(deliveries.some((part) => part.state === "delivered" && part.telegramMessageId === 501)).toBe(true);
    expect(destination).toEqual({ chatId: -1001, messageThreadId: 99 });
  });
  it.each(["reject", "pending"])("keeps canonical delivery independent of a %s observer", async (mode) => {
    const harness = createHarness(store, directory);
    const errors = vi.fn();
    const observe = vi.fn(() => mode === "reject" ? Promise.reject(new Error("observer failed")) : new Promise<void>(() => {}));
    runtime = createTelegramReliabilityRuntime({ ...harness.options, onRuntimeError: errors, topicTaskObserver: { enabled: () => true, observe } });
    await runtime.handle(source());
    expect(store.listRecent(1)[0]).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(observe).toHaveBeenCalled();
    if (mode === "reject") await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.objectContaining({ operation: "status_refresh" })));
  });
  it.each([
    ["waitingOnApproval", "turn-exact", "approval"],
    ["waitingOnUserInput", "turn-exact", "input"],
    ["sleeping", "turn-exact", undefined],
    ["conflicting", "turn-exact", undefined],
    ["unavailable", "turn-exact", undefined],
    ["waitingOnApproval", "another-turn", undefined],
  ] as const)("uses exact live waiting evidence %s for %s", async (flag, turnId, expected) => {
    const harness = createHarness(store, directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompt = harness.session.prompt.getMockImplementation()!;
    harness.session.prompt.mockImplementation(async (input, callbacks) => {
      await prompt(input, { ...callbacks, onTurnOutcome: undefined });
      await gate;
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: NOW });
    });
    harness.options.exactTurnReader = { request: vi.fn(async () => {
      if (flag === "unavailable") throw new Error("Unavailable");
      return { thread: {
        id: THREAD, status: { type: "active", activeFlags: flag === "conflicting"
          ? ["waitingOnApproval", "waitingOnUserInput"] : [flag] },
        turns: [{ id: turnId, status: "inProgress" }],
      } };
    }) };
    const observe = vi.fn<NonNullable<TelegramReliabilityRuntimeOptions["topicTaskObserver"]>["observe"]>(async () => undefined);
    runtime = createTelegramReliabilityRuntime({ ...harness.options,
      topicTaskObserver: { enabled: () => true, observe } });
    try {
      await runtime.handleWork(source());
      await vi.waitFor(() => expect(observe.mock.calls.some(([job]) => job.phase === "running")).toBe(true));
      const calls = observe.mock.calls.filter(([job]) => job.phase === "running");
      expect(calls.at(-1)?.[4]).toBe(expected);
    } finally { release(); }
  });
  it("preserves acceptance order when same-millisecond older work completes after newer work", async () => {
    const harness = createHarness(store, directory);
    const ingress = new TelegramJobIngress({ store, materializationRoot: directory,
      downloadAttachment: async () => new Uint8Array(), now: () => NOW });
    const older = ingress.accept(source({ updateId: 900 }));
    const newer = ingress.accept(source({ updateId: 2, messageId: 20 }));
    const olderOrder = store.getAcceptanceOrder(older.job.id);
    const newerOrder = store.getAcceptanceOrder(newer.job.id);
    expect(older.job.acceptedAt).toBe(newer.job.acceptedAt);
    expect(olderOrder).toBeLessThan(newerOrder!);
    const observe = vi.fn<NonNullable<TelegramReliabilityRuntimeOptions["topicTaskObserver"]>["observe"]>(async () => undefined);
    runtime = createTelegramReliabilityRuntime({ ...harness.options,
      topicTaskObserver: { enabled: () => true, observe } });
    await runtime.handle(source({ updateId: 2, messageId: 20 }));
    await runtime.handle(source({ updateId: 900 }));
    await vi.waitFor(() => expect(observe.mock.calls.some(([job]) => job.id === older.job.id && job.phase === "terminal")).toBe(true));
    expect(observe.mock.calls.filter(([job]) => job.id === older.job.id).every((call) => call[5] === olderOrder)).toBe(true);
    expect(store.getAcceptanceOrder(newer.job.id)).toBe(newerOrder);
    expect(store.getAcceptanceOrder("missing")).toBeNull();
    const terminalIds = [...new Set(observe.mock.calls.filter(([job]) => job.phase === "terminal").map(([job]) => job.id))];
    expect(terminalIds).toEqual([newer.job.id, older.job.id]);
    await runtime.dispose();
    expect(store.runRetention({ now: NOW + 2_000, payloadRetentionMs: 1_000,
      metadataRetentionMs: 10_000, batchSize: 10 }).payloadsPurged).toBe(2);
    expect(store.getAcceptanceOrder(older.job.id)).toBe(olderOrder);
    expect(store.getAcceptanceOrder(newer.job.id)).toBe(newerOrder);
  });
  it("refreshes only the latest accepted task projection without status or model writes", async () => {
    const harness = createHarness(store, directory);
    const ingress = new TelegramJobIngress({ store, materializationRoot: directory,
      downloadAttachment: async () => new Uint8Array(), now: () => NOW });
    const first = source({ updateId: 900, targetContext: { chatId: -1001, messageThreadId: 99 } });
    const second = source({ updateId: 2, messageId: 20, targetContext: { chatId: -1001, messageThreadId: 99 } });
    ingress.accept(first);
    const newer = ingress.accept(second);
    let enabled = false;
    const observe = vi.fn<NonNullable<TelegramReliabilityRuntimeOptions["topicTaskObserver"]>["observe"]>(async () => undefined);
    runtime = createTelegramReliabilityRuntime({ ...harness.options,
      topicTaskObserver: { enabled: () => enabled, observe } });
    await runtime.handle(second);
    await runtime.handle(first);
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.clearAllMocks();
    enabled = true;
    await runtime.refreshTopicTask({ botId: "bot", chatId: -1001, messageThreadId: 7 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observe).not.toHaveBeenCalled();
    await runtime.refreshTopicTask({ botId: "bot", chatId: -1001, messageThreadId: 99 });
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
    expect(observe.mock.calls.every(([job]) => job.id === newer.job.id && job.phase === "terminal")).toBe(true);
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.status.send).not.toHaveBeenCalled();
    expect(harness.status.edit).not.toHaveBeenCalled();
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
  });
  it("observes an eligible persisted job during startup reconciliation", async () => {
    const harness = createHarness(store, directory);
    const ingress = new TelegramJobIngress({ store, materializationRoot: directory,
      downloadAttachment: async () => new Uint8Array(), now: () => NOW });
    const accepted = ingress.accept(source());
    const observe = vi.fn<NonNullable<TelegramReliabilityRuntimeOptions["topicTaskObserver"]>["observe"]>(async () => undefined);
    runtime = createTelegramReliabilityRuntime({ ...harness.options,
      topicTaskObserver: { enabled: () => true, observe } });
    await runtime.reconcile();
    await vi.waitFor(() => expect(observe.mock.calls.some(([job]) => job.id === accepted.job.id)).toBe(true));
  });
  it("does not observe disabled tasks or activate through dashboard reads", async () => {
    const harness = createHarness(store, directory);
    const observe = vi.fn<NonNullable<TelegramReliabilityRuntimeOptions["topicTaskObserver"]>["observe"]>(async () => undefined);
    let enabled = false;
    runtime = createTelegramReliabilityRuntime({ ...harness.options, topicTaskObserver: { enabled: () => enabled, observe } });
    await runtime.handle(source());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observe).not.toHaveBeenCalled();
    expect(harness.options.exactTurnReader.request).not.toHaveBeenCalled();
    enabled = true;
    await runtime.loadDashboardReliability();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observe).not.toHaveBeenCalled();
    await runtime.refresh(store.listRecent(1)[0]!.id);
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
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

function source(overrides: Partial<TelegramWorkSource> = {}): TelegramWorkSource {
  return {
    botId: "bot", updateId: 1, chatId: -1001, messageThreadId: 7, messageId: 19,
    kind: "text", text: "inspect this", attachment: null, retryOfJobId: null, ...overrides,
  };
}
