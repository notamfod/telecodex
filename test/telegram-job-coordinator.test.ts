import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { AppServerRequestError } from "../src/app-server-client.js";
import { TelegramJobCoordinator, TelegramCoordinatorRetryAfterError,
  type TelegramCoordinatorCodexAdapter,
  type TelegramCoordinatorTurnRequest,
} from "../src/telegram-job-coordinator.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { MaterializedPrompt, TelegramJob } from "../src/telegram-job-types.js";

const START = 1_700_000_000_000;
const PROMPT: MaterializedPrompt = { text: "hello", attachments: [] };
interface PendingTurn {
  readonly request: TelegramCoordinatorTurnRequest;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}
class FakeCodex implements TelegramCoordinatorCodexAdapter {
  readonly starts: TelegramCoordinatorTurnRequest[] = [];
  readonly writes: TelegramCoordinatorTurnRequest[] = [];
  readonly aborts: Array<{ threadId: string; turnId: string }> = [];
  readonly pending: PendingTurn[] = [];
  readonly prepared = new Map<string, { threadId: string; previousTurnId: string | null }>();
  prepareError: Error | null = null;
  resolveGate?: () => Promise<void>;
  startBehavior?: (request: TelegramCoordinatorTurnRequest) => void;

  async resolveThread(job: TelegramJob): Promise<string> {
    await this.resolveGate?.();
    if (this.prepareError) {
      const error = this.prepareError;
      this.prepareError = null;
      throw error;
    }
    return this.prepared.get(job.id)?.threadId ?? `thread-${job.id}`;
  }

  startTurn(request: TelegramCoordinatorTurnRequest): Promise<void> {
    this.starts.push(request);
    request.callbacks.beforeDispatchWrite({
      threadId: request.threadId,
      previousTurnId: this.prepared.get(request.jobId)?.previousTurnId ?? null,
      previousTurnKnown: true,
      attempt: 1,
    });
    this.writes.push(request);
    this.startBehavior?.(request);
    return new Promise<void>((resolve, reject) => this.pending.push({ request, resolve, reject }));
  }
  async recoverTurn(): Promise<void> {}
  async abortTurn(input: { threadId: string; turnId: string }): Promise<void> {
    this.aborts.push(input);
  }
}

describe("TelegramJobCoordinator", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let now: number;
  let sequence: number;
  let codex: FakeCodex;
  let scheduled: Array<{ at: number; wake: () => void }>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-coordinator-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    now = START;
    sequence = 0;
    codex = new FakeCodex();
    scheduled = [];
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createCoordinator(overrides: Partial<ConstructorParameters<typeof TelegramJobCoordinator>[0]> = {}) {
    return new TelegramJobCoordinator({
      store,
      materializer: { materialize: async () => PROMPT },
      codex,
      now: () => now,
      createId: () => `event-${++sequence}`,
      globalConcurrency: 2,
      scheduleWakeup: (at, wake) => scheduled.push({ at, wake }),
      ...overrides,
    });
  }

  function accept(id: string, updateId: number, topic = 1): TelegramJob {
    const job: TelegramJob = {
      schemaVersion: 1,
      id,
      version: 1,
      source: { botId: "bot", updateId },
      attachments: [],
      phase: "accepted",
      health: "healthy",
      activity: "unknown",
      attention: { kind: "none" },
      outcome: null,
      dispatchId: null,
      threadId: null,
      turnId: null,
      responsePlan: undefined,
      deliveries: [],
      acceptedAt: now,
      updatedAt: now,
      terminalAt: null,
      dismissedAt: null,
      retainUntil: null,
    };
    store.acceptUpdate({
      job,
      sourcePayload: {
        botId: "bot", updateId, chatId: -100, messageThreadId: topic,
        messageId: updateId, kind: "text", text: "hello", attachment: null, retryOfJobId: null,
      },
      eventId: `accept-${id}`,
    });
    return store.transition({
      jobId: id,
      eventId: `materialize-${id}`,
      expectedVersion: 1,
      event: { schemaVersion: 1, type: "materialization.succeeded", eventAt: job.updatedAt, materializedPrompt: PROMPT },
    });
  }

  async function waitForJob(jobId: string, predicate: (job: TelegramJob) => boolean): Promise<TelegramJob> {
    await vi.waitFor(() => expect(predicate(store.get(jobId)!)).toBe(true));
    return store.get(jobId)!;
  }

  it("persists accepted -> queued -> dispatching -> written -> running facts before later activity", async () => {
    accept("job-1", 1);
    codex.prepared.set("job-1", { threadId: "thread-1", previousTurnId: "turn-previous" });
    codex.startBehavior = (request) => {
      request.callbacks.onDispatchWritten();
      request.callbacks.onStarted("turn-1");
      request.callbacks.onActivity({ activity: "tool", eventAt: START + 20, method: "item/started" });
    };

    await createCoordinator().pump();

    const job = store.get("job-1")!;
    expect(job).toMatchObject({
      phase: "running", threadId: "thread-1", turnId: "turn-1", lastCodexEventAt: START + 20,
      dispatch: {
        id: expect.any(String), threadId: "thread-1", previousTurnId: "turn-previous",
        attempt: 1, startedAt: START, transportWriteState: "written", nextAttemptAt: null,
      },
    });
    expect(store.listEvents("job-1").map(({ event }) => event.type)).toEqual([
      "update.accepted", "materialization.succeeded", "job.queued", "dispatch.started",
      "dispatch.in_flight", "dispatch.written", "turn.started", "activity.observed",
    ]);
    expect(codex.starts).toHaveLength(1);
  });

  it("does not let a hung attachment materialization block an already materialized text job", async () => {
    const hanging: TelegramJob = {
      schemaVersion: 1,
      id: "job-hanging",
      version: 1,
      source: { botId: "bot", updateId: 1 },
      attachments: [],
      phase: "accepted",
      health: "healthy",
      activity: "unknown",
      attention: { kind: "none" },
      outcome: null,
      dispatchId: null,
      threadId: null,
      turnId: null,
      responsePlan: undefined,
      deliveries: [],
      acceptedAt: now,
      updatedAt: now,
      terminalAt: null,
      dismissedAt: null,
      retainUntil: null,
    };
    store.acceptUpdate({
      job: hanging,
      sourcePayload: {
        botId: "bot", updateId: 1, chatId: -100, messageThreadId: 1,
        messageId: 1, kind: "voice", text: null, attachment: null, retryOfJobId: null,
      },
      eventId: "accept-hanging",
    });
    accept("job-ready", 2, 2);
    const materialize = vi.fn((jobId: string) => jobId === "job-hanging"
      ? new Promise<MaterializedPrompt>(() => {})
      : Promise.resolve(PROMPT));
    const coordinator = createCoordinator({ materializer: { materialize } });

    await coordinator.pump();

    expect(materialize).toHaveBeenCalledWith("job-hanging");
    expect(codex.starts.map((request) => request.jobId)).toEqual(["job-ready"]);
    expect(store.get("job-hanging")?.phase).toBe("accepted");
  });

  it("enforces durable topic FIFO and global concurrency after recreation", async () => {
    accept("job-a", 1, 7);
    accept("job-b", 2, 7);
    accept("job-c", 3, 8);
    const first = createCoordinator({ globalConcurrency: 1 });
    await first.pump();
    codex.starts[0]!.callbacks.onDispatchWritten();
    codex.starts[0]!.callbacks.onStarted("turn-a");
    first.dispose();

    const recreated = createCoordinator({ globalConcurrency: 2 });
    await recreated.pump();
    expect(codex.starts.map((request) => request.jobId)).toEqual(["job-a", "job-c"]);

    codex.starts[0]!.callbacks.onTurnOutcome({ status: "completed", eventAt: now + 30 });
    codex.pending[0]!.resolve();
    await waitForJob("job-a", (job) => job.phase === "delivering");
    await recreated.pump();
    expect(codex.starts.map((request) => request.jobId)).toEqual(["job-a", "job-c", "job-b"]);
  });

  it("serializes different topics that resolve to the same bound Codex thread", async () => {
    accept("job-a", 1, 7);
    accept("job-b", 2, 8);
    codex.prepared.set("job-a", { threadId: "shared", previousTurnId: null });
    codex.prepared.set("job-b", { threadId: "shared", previousTurnId: null });

    await createCoordinator({ globalConcurrency: 2 }).pump();

    expect(codex.starts.map((request) => request.jobId)).toEqual(["job-a"]);
  });

  it("reloads a transition conflict and never dispatches stale queued work", async () => {
    accept("job-conflict", 1);
    const base = store;
    const conflictingStore = {
      ...store,
      get: base.get.bind(base), listUnfinished: base.listUnfinished.bind(base),
      listDispatchable: base.listDispatchable.bind(base), readSourcePayload: base.readSourcePayload.bind(base),
      transition: (input: Parameters<typeof base.transition>[0]) => {
        if (input.event.type === "dispatch.started") {
          const current = base.get(input.jobId)!;
          base.transition({
            jobId: input.jobId, eventId: "winner", expectedVersion: current.version,
            event: { schemaVersion: 1, type: "job.terminal", eventAt: current.updatedAt + 1, outcome: "failed" },
          });
          throw new Error("Telegram job version conflict");
        }
        return base.transition(input);
      },
    };

    await createCoordinator({ store: conflictingStore }).pump();

    expect(store.get("job-conflict")).toMatchObject({ phase: "terminal", outcome: "failed" });
    expect(codex.starts).toHaveLength(1);
    expect(codex.writes).toHaveLength(0);
  });

  it("uses the in-flight ledger CAS as a blocking transport-write barrier", async () => {
    accept("job-write-conflict", 1);
    const base = store;
    const conflictingStore = {
      ...store,
      get: base.get.bind(base), listUnfinished: base.listUnfinished.bind(base),
      listDispatchable: base.listDispatchable.bind(base), readSourcePayload: base.readSourcePayload.bind(base),
      transition: (input: Parameters<typeof base.transition>[0]) => {
        if (input.event.type === "dispatch.in_flight") throw new Error("Telegram job version conflict");
        return base.transition(input);
      },
    };

    await createCoordinator({ store: conflictingStore }).pump();

    expect(codex.starts).toHaveLength(1);
    expect(codex.writes).toHaveLength(0);
    expect(store.get("job-write-conflict")).toMatchObject({ phase: "dispatching" });
  });

  it("lets only one coordinator instance cross the queued dispatch CAS", async () => {
    accept("job-race", 1);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    codex.resolveGate = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };

    await Promise.all([createCoordinator().pump(), createCoordinator().pump()]);

    expect(codex.writes).toHaveLength(1);
    const events = store.listEvents("job-race").map(({ event }) => event.type);
    expect(events.filter((type) => type === "dispatch.in_flight")).toHaveLength(1);
    expect(events).not.toContain("activity.observed");
    expect(store.get("job-race")!.attention).toEqual({ kind: "none" });
  });

  it("backs off only proven pre-write failures and exhausts the default five-attempt budget", async () => {
    accept("job-retry", 1);
    const coordinator = createCoordinator({ globalConcurrency: 1, retryBackoffMs: 100 });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await coordinator.pump();
      codex.pending.at(-1)!.reject(new AppServerRequestError("APP_SERVER_NOT_SENT"));
      const expectedPhase = attempt === 5 ? "terminal" : "queued";
      await waitForJob("job-retry", (job) => job.phase === expectedPhase);
      if (attempt < 5) {
        expect(store.get("job-retry")!.dispatch?.nextAttemptAt).toBe(now + 100);
        now += 100;
      }
    }

    expect(codex.starts).toHaveLength(5);
    expect(store.get("job-retry")).toMatchObject({
      phase: "terminal", outcome: "failed",
      attention: { kind: "required", code: "dispatch_attempts_exhausted", actions: ["retry"] },
    });
    expect(scheduled).toHaveLength(4);
  });

  it("does not consume an attempt for a bounded retry_after pause", async () => {
    expect(() => new TelegramCoordinatorRetryAfterError(60_001)).toThrow("Invalid retryAfterMs");
    accept("job-paused", 1);
    codex.prepareError = new TelegramCoordinatorRetryAfterError(2_000);
    const coordinator = createCoordinator();

    await coordinator.pump();
    expect(store.get("job-paused")!.phase).toBe("queued");
    expect(store.get("job-paused")!.dispatch?.attempt ?? 0).toBe(0);
    expect(store.get("job-paused")!.nextAttemptAt).toBe(START + 2_000);
    expect(scheduled[0]?.at).toBe(START + 2_000);

    coordinator.dispose();
    const recreated = createCoordinator();
    await recreated.pump();
    expect(codex.starts).toHaveLength(0);
    now += 2_000;
    await recreated.pump();
    expect(store.get("job-paused")!.dispatch?.attempt).toBe(1);
    expect(codex.starts).toHaveLength(1);
  });

  it("durably backs off a proven pre-dispatch transport failure across recreation", async () => {
    accept("job-resolve-retry", 1);
    codex.prepareError = new AppServerRequestError("APP_SERVER_NOT_SENT");
    const first = createCoordinator({ retryBackoffMs: 100 });

    await first.pump();
    expect(store.get("job-resolve-retry")).toMatchObject({ phase: "queued", nextAttemptAt: now + 100 });
    expect(store.get("job-resolve-retry")!.dispatch).toBeUndefined();
    expect(scheduled.at(-1)?.at).toBe(now + 100);
    first.dispose();

    const recreated = createCoordinator({ retryBackoffMs: 100 });
    await recreated.pump();
    expect(codex.starts).toHaveLength(0);
    now += 100;
    await recreated.pump();
    expect(codex.starts).toHaveLength(1);
    expect(store.get("job-resolve-retry")!.dispatch?.attempt).toBe(1);
  });

  it.each([
    [new AppServerRequestError("APP_SERVER_REJECTED", -32602, "OTHER"), "terminal", "app_server_rejected"],
    [new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN"), "queued", "thread_resolution_unknown"],
  ] as const)("classifies a thread-resolution failure without a hidden retry", async (error, phase, code) => {
    accept("job-resolve-error", 1);
    codex.prepareError = error;

    await createCoordinator().pump();

    expect(store.get("job-resolve-error")).toMatchObject({
      phase, attention: { kind: "required", code },
    });
    expect(codex.starts).toHaveLength(0);
  });

  it.each([
    ["explicit rejection", new AppServerRequestError("APP_SERVER_REJECTED", -32602, "OTHER"), "app_server_rejected", "terminal"],
    ["in-flight timeout", new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN"), "dispatch_acceptance_unknown", "dispatching"],
  ] as const)("classifies %s without leaking payloads or replaying", async (_name, error, code, phase) => {
    accept("job-error", 1);
    const coordinator = createCoordinator();
    await coordinator.pump();
    codex.pending[0]!.reject(error);
    await waitForJob("job-error", (job) => job.attention.kind === "required");

    expect(store.get("job-error")).toMatchObject({
      phase,
      attention: { kind: "required", code, actions: ["inspect", "retry"] },
    });
    await coordinator.pump();
    expect(codex.starts).toHaveLength(1);
  });

  it("aborts queued work without Codex and records running abort request before observed outcome", async () => {
    accept("queued", 1);
    const coordinator = createCoordinator();
    await coordinator.abort("queued");
    expect(store.get("queued")).toMatchObject({ phase: "terminal", outcome: "aborted" });
    expect(codex.starts).toHaveLength(0);

    accept("running", 2);
    const runningCoordinator = createCoordinator({ globalConcurrency: 1 });
    await runningCoordinator.pump();
    codex.starts[0]!.callbacks.onDispatchWritten();
    codex.starts[0]!.callbacks.onStarted("turn-running");
    await runningCoordinator.abort("running");
    expect(store.listEvents("running").map(({ event }) => event.type)).toContain("abort.requested");
    expect(codex.aborts).toEqual([{ threadId: "thread-running", turnId: "turn-running" }]);

    codex.starts[0]!.callbacks.onTurnOutcome({ status: "interrupted", eventAt: now + 1 });
    codex.pending[0]!.reject(new Error("Codex turn aborted"));
    await waitForJob("running", (job) => job.phase === "terminal");
    expect(store.get("running")).toMatchObject({ outcome: "aborted", abortRequestedAt: expect.any(Number) });
  });

  it("does not infer an aborted outcome from an unrelated failure after interrupt", async () => {
    accept("running-failure", 1);
    const coordinator = createCoordinator();
    await coordinator.pump();
    codex.starts[0]!.callbacks.onStarted("turn-running");
    await coordinator.abort("running-failure");
    codex.pending[0]!.reject(new Error("unrelated transport failure"));

    const job = await waitForJob("running-failure", (value) => value.attention.kind === "required");
    expect(job).toMatchObject({ phase: "running", outcome: null });
  });

  it("persists an observed non-success terminal status as a safe failed outcome", async () => {
    accept("running-failed", 1);
    await createCoordinator().pump();
    codex.starts[0]!.callbacks.onStarted("turn-failed");
    codex.starts[0]!.callbacks.onTurnOutcome({ status: "failed", eventAt: now + 1 });
    codex.pending[0]!.reject(new Error("unsafe daemon detail"));

    const job = await waitForJob("running-failed", (value) => value.phase === "terminal");
    expect(job).toMatchObject({
      outcome: "failed",
      attention: { kind: "required", code: "codex_turn_failed", actions: ["inspect", "retry"] },
    });
    expect(JSON.stringify(job)).not.toContain("unsafe daemon detail");
  });

  it("never attributes activity when the matching turn identity CAS did not persist", async () => {
    accept("turn-conflict", 1);
    const base = store;
    const conflictingStore = {
      ...store,
      get: base.get.bind(base), listUnfinished: base.listUnfinished.bind(base),
      listDispatchable: base.listDispatchable.bind(base), readSourcePayload: base.readSourcePayload.bind(base),
      transition: (input: Parameters<typeof base.transition>[0]) => {
        if (input.event.type === "turn.started") throw new Error("Telegram job version conflict");
        return base.transition(input);
      },
    };
    await createCoordinator({ store: conflictingStore }).pump();
    const request = codex.starts[0]!;

    request.callbacks.onStarted("turn-unpersisted");
    request.callbacks.onActivity({ activity: "model", eventAt: now + 1, method: "item/agentMessage/delta" });

    expect(store.get("turn-conflict")).toMatchObject({ phase: "dispatching", turnId: null });
    expect(store.listEvents("turn-conflict").map(({ event }) => event.type)).not.toContain("activity.observed");
  });

  it("stores a serializable ordered result without Telegram delivery side effects", async () => {
    accept("job-result", 1);
    await createCoordinator().pump();
    const request = codex.starts[0]!;
    request.callbacks.onDispatchWritten();
    request.callbacks.onStarted("turn-result");
    request.callbacks.onTextDelta("hello ");
    request.callbacks.onOutputAttachment({ kind: "image", path: "outputs/chart.png" });
    request.callbacks.onTextDelta("world");
    request.callbacks.onTurnOutcome({ status: "completed", eventAt: now + 30 });
    codex.pending[0]!.resolve();

    const job = await waitForJob("job-result", (value) => value.phase === "delivering");
    expect(job.turnResult).toEqual({
      schemaVersion: 1,
      content: [
        { kind: "text", text: "hello " },
        { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
        { kind: "text", text: "world" },
      ],
    });
    expect(JSON.parse(JSON.stringify(job.turnResult))).toEqual(job.turnResult);
    expect(job.responsePlan).toBeUndefined();
    expect(job.deliveries).toEqual([]);
  });

  it("keeps commentary messages separate from the final answer", async () => {
    const publishCommentary = vi.fn();
    accept("job-phased-result", 1);
    await createCoordinator({ publishCommentary }).pump();
    const request = codex.starts[0]!;
    request.callbacks.onDispatchWritten();
    request.callbacks.onStarted("turn-phased-result");
    const emit = request.callbacks.onTextDelta as unknown as (
      delta: string,
      message: { itemId: string; phase: string },
    ) => void;
    emit("Check", { itemId: "commentary-1", phase: "commentary" });
    emit("ing.", { itemId: "commentary-1", phase: "commentary" });
    expect(publishCommentary).not.toHaveBeenCalled();
    request.callbacks.onAgentMessageEnd?.({ itemId: "commentary-1", phase: "commentary" });
    expect(store.get("job-phased-result")?.phase).toBe("running");
    expect(publishCommentary).toHaveBeenCalledWith({
      jobId: "job-phased-result",
      turnId: "turn-phased-result",
      itemId: "commentary-1",
      commentaryIndex: 0,
      text: "Checking.",
    });
    emit("Still checking.", { itemId: "commentary-2", phase: "commentary" });
    request.callbacks.onAgentMessageEnd?.({ itemId: "commentary-2", phase: "commentary" });
    emit("hidden", { itemId: "reasoning-1", phase: "reasoning" });
    request.callbacks.onAgentMessageEnd?.({ itemId: "reasoning-1", phase: "reasoning" });
    emit("Done.", { itemId: "final-1", phase: "final_answer" });
    request.callbacks.onAgentMessageEnd?.({ itemId: "final-1", phase: "final_answer" });
    expect(publishCommentary).toHaveBeenCalledTimes(2);
    request.callbacks.onTurnOutcome({ status: "completed", eventAt: now + 30 });
    codex.pending[0]!.resolve();

    const job = await waitForJob("job-phased-result", (value) => value.phase === "delivering");
    expect(job.turnResult?.content).toEqual([
      { kind: "text", phase: "commentary", text: "Checking." },
      { kind: "text", phase: "commentary", text: "Still checking." },
      { kind: "text", phase: "final_answer", text: "Done." },
    ]);
  });

  it("coalesces token deltas into logical text around attachment boundaries", async () => {
    accept("job-many-deltas", 1);
    await createCoordinator().pump();
    const request = codex.starts[0]!;
    request.callbacks.onStarted("turn-many-deltas");
    for (let index = 0; index < 300; index += 1) request.callbacks.onTextDelta("x");
    request.callbacks.onOutputAttachment({ kind: "image", path: "outputs/chart.png" });
    request.callbacks.onTextDelta("tail");
    request.callbacks.onTurnOutcome({ status: "completed", eventAt: now + 1 });
    codex.pending[0]!.resolve();

    const job = await waitForJob("job-many-deltas", (value) => value.phase === "delivering");
    expect(job.turnResult?.content).toEqual([
      { kind: "text", text: "x".repeat(300) },
      { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
      { kind: "text", text: "tail" },
    ]);
  });

  it.each([
    { kind: "image", path: "/tmp/raw.png" },
    { kind: "image", path: "../raw.png" },
    { kind: "image", path: "outputs/raw.png", base64: "unsafe" },
  ])("rejects an unsafe adapter attachment without persisting its payload: %#", async (attachment) => {
    accept("job-unsafe-output", 1);
    await createCoordinator().pump();
    const request = codex.starts[0]!;
    request.callbacks.onStarted("turn-unsafe-output");
    (request.callbacks.onOutputAttachment as (value: unknown) => void)(attachment);
    request.callbacks.onTurnOutcome({ status: "completed", eventAt: now + 1 });
    codex.pending[0]!.resolve();

    const job = await waitForJob("job-unsafe-output", (value) => value.phase === "terminal");
    expect(job).toMatchObject({
      outcome: "failed",
      attention: { kind: "required", code: "invalid_codex_output", actions: ["inspect"] },
    });
    const persisted = JSON.stringify(store.listEvents(job.id));
    expect(persisted).not.toContain("/tmp/raw.png");
    expect(persisted).not.toContain("../raw.png");
    expect(persisted).not.toContain("\"base64\"");
  });
});
