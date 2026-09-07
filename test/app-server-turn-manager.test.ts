import { vi } from "vitest";

import {
  AppServerRequestError,
  type AppServerNotification,
} from "../src/app-server-client.js";
import {
  AppServerTurnManager,
  hookBlockReason,
  type AppServerTurnCallbacks,
  type AppServerTurnRequest,
} from "../src/app-server-turn-manager.js";

class FakeAppServerClient {
  readonly request = vi.fn();
  private listener?: (notification: AppServerNotification) => void;
  private disconnectListener?: () => void;

  async connect(): Promise<void> {}

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListener = listener;
    return () => {
      this.disconnectListener = undefined;
    };
  }

  emit(method: string, params: unknown): void {
    this.listener?.({ method, params });
  }

  disconnect(): void {
    this.disconnectListener?.();
  }

  hasDisconnectListener(): boolean {
    return this.disconnectListener !== undefined;
  }
}

const createCallbacks = (): AppServerTurnCallbacks => ({
  onQueued: vi.fn(),
  onStarted: vi.fn(),
  onTextDelta: vi.fn(),
  onToolStart: vi.fn(),
  onToolUpdate: vi.fn(),
  onToolEnd: vi.fn(),
  onAgentEnd: vi.fn(),
  onAgentMessageStart: vi.fn(),
  onAgentMessageEnd: vi.fn(),
  onTodoUpdate: vi.fn(),
  onTurnComplete: vi.fn(),
  onGeneratedImage: vi.fn(),
});

const createRequest = (callbacks: AppServerTurnCallbacks): AppServerTurnRequest => ({
  threadId: "thread-1",
  input: [{ type: "text", text: "queued prompt", text_elements: [] }],
  cwd: "/workspace/project",
  model: "gpt-5.6-sol",
  approvalPolicy: "never",
  sandbox: "workspace-write",
  callbacks,
});

const createThreadRequest = (
  threadId: string,
  callbacks: AppServerTurnCallbacks,
): AppServerTurnRequest => ({
  ...createRequest(callbacks),
  threadId,
});

describe("hookBlockReason", () => {
  it("reads what the hook wanted the user to see", () => {
    expect(
      hookBlockReason({
        statusMessage: "Checking synchronized thread ownership",
        entries: [{ kind: "feedback", text: "Reopen this exact task before continuing." }],
      }),
    ).toBe("Reopen this exact task before continuing.");
  });

  it("ignores context entries, which are written for the model rather than the user", () => {
    expect(
      hookBlockReason({
        statusMessage: "Checking ownership",
        entries: [{ kind: "context", text: "owner=windows epoch=2" }],
      }),
    ).toBe("Checking ownership");
  });

  it("falls back to something sayable when the hook explained nothing", () => {
    expect(hookBlockReason({ entries: [] })).not.toBe("");
  });
});

describe("AppServerTurnManager", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a turn locally queued when turn/start is proven not sent", async () => {
    const client = new FakeAppServerClient();
    client.request.mockRejectedValue(new AppServerRequestError("APP_SERVER_NOT_SENT"));
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    const outcome = completion.then(
      () => "resolved",
      (error: unknown) => error,
    );

    await vi.waitFor(() =>
      expect(callbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        reason: "app-server-unavailable",
      }),
    );
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");

    manager.dispose();
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/disposed/i) });
  });

  it("preserves unknown turn/start acceptance for attention without reconciliation or retry", async () => {
    const client = new FakeAppServerClient();
    client.request.mockRejectedValue(
      new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN"),
    );
    const manager = new AppServerTurnManager(client);

    manager.trackThread("thread-1", "idle");
    const outcome = manager.runTurn(createRequest(createCallbacks())).catch(
      (error: unknown) => error,
    );

    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["turn/start"]);
  });

  it.each([
    {},
    { turn: null },
    { turn: { id: "", status: "inProgress" } },
    { turn: { id: "x".repeat(513), status: "inProgress" } },
    { turn: { id: "turn-unsafe", status: 42 } },
    { turn: { id: "turn-unsafe", status: "" } },
    { turn: { id: "turn-unsafe", status: "x".repeat(129) } },
  ])("treats malformed turn/start success as sticky unknown acceptance: %#", async (result) => {
    const client = new FakeAppServerClient();
    client.request.mockResolvedValue(result);
    const manager = new AppServerTurnManager(client);
    const queuedCallbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const outcome = manager.runTurn(createRequest(createCallbacks())).catch(
      (error: unknown) => error,
    );
    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });

    const queued = manager.runTurn(createRequest(queuedCallbacks));
    const queuedOutcome = queued.catch((error: unknown) => error);
    await vi.waitFor(() => expect(queuedCallbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    }));
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["turn/start"]);

    manager.dispose();
    await expect(queuedOutcome).resolves.toMatchObject({ message: expect.stringMatching(/disposed/i) });
  });

  it("accepts a completed turn/start status when the response shape is safe", async () => {
    const client = new FakeAppServerClient();
    client.request.mockResolvedValue({ turn: { id: "fast-turn", status: "completed" } });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith("fast-turn"));
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "fast-turn", status: "completed" },
    });
    await completion;
  });

  it.each([
    "APP_SERVER_NOT_SENT",
    "APP_SERVER_ACCEPTANCE_UNKNOWN",
  ] as const)("queues after recovery resume fails with %s because the prompt was not retried", async (code) => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let starts = 0;
    let resumes = 0;
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "turn/start") {
        starts += 1;
        if (starts === 1) {
          throw new AppServerRequestError("APP_SERVER_REJECTED", -32600, "THREAD_NOT_FOUND");
        }
        return { turn: { id: "recovered-turn", status: "inProgress" } };
      }
      if (method === "thread/resume") {
        resumes += 1;
        if (resumes === 1) throw new AppServerRequestError(code);
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(callbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "app-server-unavailable",
    }));
    expect(calls).toEqual(["turn/start", "thread/resume"]);

    client.disconnect();
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith("recovered-turn"));
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "recovered-turn", status: "completed" },
    });
    await completion;
  });

  it("keeps a proven recovery resume rejection as the control failure", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        throw new AppServerRequestError("APP_SERVER_REJECTED", -32600, "THREAD_NOT_FOUND");
      }
      throw new AppServerRequestError("APP_SERVER_REJECTED", -32602, "OTHER");
    });
    const manager = new AppServerTurnManager(client);

    manager.trackThread("thread-1", "idle");
    await expect(manager.runTurn(createRequest(createCallbacks()))).rejects.toMatchObject({
      code: "APP_SERVER_REJECTED",
      rpcCode: -32602,
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "thread/resume",
    ]);
  });

  it("preserves queue and scheduler invariants when onQueued cancels reentrantly and throws", async () => {
    const client = new FakeAppServerClient();
    client.request.mockRejectedValue(new AppServerRequestError("APP_SERVER_NOT_SENT"));
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    callbacks.onQueued = vi.fn(() => {
      void manager.cancelTurn("thread-1", callbacks);
      throw new Error("observer failure");
    });

    manager.trackThread("thread-1", "idle");
    await expect(manager.runTurn(createRequest(callbacks))).rejects.toThrow("Codex turn aborted");

    const internals = manager as unknown as {
      scheduler: { activeTopicKeys: Set<string> };
      threads: Map<string, { queue: unknown[]; startingJob?: unknown; scheduledJob?: unknown }>;
    };
    await vi.waitFor(() => expect(internals.scheduler.activeTopicKeys.size).toBe(0));
    expect(internals.threads.get("thread-1")).toMatchObject({
      queue: [],
      startingJob: undefined,
      scheduledJob: undefined,
    });
  });

  it("keeps dispatch ambiguity sticky across idle and unmatched completion facts", async () => {
    const client = new FakeAppServerClient();
    let starts = 0;
    client.request.mockImplementation(async (method: string) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      starts += 1;
      if (starts === 1) {
        throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
      }
      return { turn: { id: "duplicate-turn", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const firstCallbacks = createCallbacks();
    const secondCallbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const firstOutcome = manager.runTurn(createRequest(firstCallbacks)).catch(
      (error: unknown) => error,
    );
    await expect(firstOutcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });

    const second = manager.runTurn(createRequest(secondCallbacks));
    const secondOutcome = second.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(secondCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        reason: "thread-active",
      }),
    );

    manager.trackThread("thread-1", "idle");
    client.emit("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "unmatched-turn",
      item: { id: "unmatched-item", type: "commandExecution" },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "unmatched-turn", status: "completed" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(starts).toBe(1);
    expect(secondCallbacks.onStarted).not.toHaveBeenCalled();
    expect(await Promise.race([secondOutcome, Promise.resolve("pending")])).toBe("pending");

    manager.dispose();
    await expect(secondOutcome).resolves.toMatchObject({ message: expect.stringMatching(/disposed/i) });
  });

  it("uses allowlisted rejection reasons without reading raw app-server messages", async () => {
    const client = new FakeAppServerClient();
    let startAttempts = 0;
    client.request.mockImplementation(async (method: string) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      startAttempts += 1;
      if (startAttempts === 1) {
        throw new AppServerRequestError("APP_SERVER_REJECTED", -32600, "THREAD_BUSY");
      }
      return { turn: { id: "turn-after-busy", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() =>
      expect(callbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        reason: "thread-active",
      }),
    );
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "external-turn", status: "completed" },
    });
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith("turn-after-busy"));
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-after-busy", status: "completed" },
    });
    await completion;
  });

  it("does not impose a total timeout after turn/start has been accepted", async () => {
    vi.useFakeTimers();
    const client = new FakeAppServerClient();
    client.request.mockResolvedValue({ turn: { id: "long-turn", status: "inProgress" } });
    const manager = new AppServerTurnManager(client);

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(createCallbacks()));
    const outcome = completion.then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "long-turn", status: "completed" },
    });
    await expect(completion).resolves.toBeUndefined();
  });

  it("resumes an inactive cached thread after disconnect before starting its next turn", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "reconnected-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    client.disconnect();
    const completion = manager.runTurn(createRequest(callbacks));

    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith("reconnected-turn"));
    expect(calls).toEqual(["thread/resume", "turn/start"]);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "reconnected-turn", status: "completed" },
    });
    await completion;
  });

  it("resumes a scheduled idle thread after disconnect when its global slot opens", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      calls.push(`${method}:${threadId}`);
      if (method === "thread/resume") {
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const activeCallbacks = createCallbacks();
    const scheduledCallbacks = createCallbacks();

    manager.trackThread("thread-active", "idle");
    manager.trackThread("thread-scheduled", "idle");
    const active = manager.runTurn(createThreadRequest("thread-active", activeCallbacks));
    const scheduled = manager.runTurn(
      createThreadRequest("thread-scheduled", scheduledCallbacks),
    );
    await vi.waitFor(() => expect(activeCallbacks.onStarted).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(scheduledCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        active: 1,
        limit: 1,
        reason: "global-limit",
      }),
    );

    client.disconnect();
    client.emit("turn/completed", {
      threadId: "thread-active",
      turn: { id: "turn-thread-active", status: "completed" },
    });

    await active;
    await vi.waitFor(() =>
      expect(scheduledCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-scheduled"),
    );
    expect(calls.filter((call) => call.endsWith(":thread-scheduled"))).toEqual([
      "thread/resume:thread-scheduled",
      "turn/start:thread-scheduled",
    ]);

    client.emit("turn/completed", {
      threadId: "thread-scheduled",
      turn: { id: "turn-thread-scheduled", status: "completed" },
    });
    await scheduled;
  });

  it("reconciles an active turn after disconnect and releases its global slot", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      if (method === "thread/resume") {
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: threadId,
            turns: [{
              id: "turn-thread-active",
              status: "completed",
              items: [{
                type: "agentMessage",
                id: "recovered-final",
                phase: "final_answer",
                text: "Recovered after disconnect",
              }],
            }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const activeCallbacks = createCallbacks();
    const waitingCallbacks = createCallbacks();

    manager.trackThread("thread-active", "idle");
    manager.trackThread("thread-waiting", "idle");
    const active = manager.runTurn(createThreadRequest("thread-active", activeCallbacks));
    const waiting = manager.runTurn(createThreadRequest("thread-waiting", waitingCallbacks));
    await vi.waitFor(() =>
      expect(activeCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-active"),
    );
    await vi.waitFor(() =>
      expect(waitingCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        active: 1,
        limit: 1,
        reason: "global-limit",
      }),
    );

    client.disconnect();

    await expect(active).resolves.toBeUndefined();
    expect(activeCallbacks.onTextDelta).toHaveBeenCalledWith("Recovered after disconnect");
    await vi.waitFor(() =>
      expect(waitingCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-waiting"),
    );

    client.emit("turn/completed", {
      threadId: "thread-waiting",
      turn: { id: "turn-thread-waiting", status: "completed" },
    });
    await waiting;
  });

  it("reattaches an active disconnected turn once without duplicating it", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let activeResumeCompleted = false;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      calls.push(`${method}:${threadId}`);
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      if (method === "thread/resume") {
        if (threadId === "thread-active") {
          await resumeGate;
          activeResumeCompleted = true;
          return { thread: { id: threadId, status: { type: "active" } } };
        }
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "thread/read" && threadId === "thread-active") {
        return {
          thread: {
            id: threadId,
            turns: [{ id: "turn-thread-active", status: "inProgress" }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const activeCallbacks = createCallbacks();
    const waitingCallbacks = createCallbacks();

    manager.trackThread("thread-active", "idle");
    manager.trackThread("thread-waiting", "idle");
    const active = manager.runTurn(createThreadRequest("thread-active", activeCallbacks));
    const waiting = manager.runTurn(createThreadRequest("thread-waiting", waitingCallbacks));
    await vi.waitFor(() =>
      expect(activeCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-active"),
    );
    await vi.waitFor(() =>
      expect(waitingCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        active: 1,
        limit: 1,
        reason: "global-limit",
      }),
    );

    client.disconnect();
    client.disconnect();
    releaseResume();

    await vi.waitFor(() =>
      expect(calls.filter((call) => call === "thread/resume:thread-active")).toHaveLength(1),
    );
    await vi.waitFor(() => expect(activeResumeCompleted).toBe(true));
    await vi.waitFor(() =>
      expect(calls.filter((call) => call === "thread/read:thread-active")).toHaveLength(1),
    );
    expect(calls.filter((call) => call === "turn/start:thread-active")).toHaveLength(1);
    expect(waitingCallbacks.onStarted).not.toHaveBeenCalled();

    client.emit("turn/completed", {
      threadId: "thread-active",
      turn: { id: "turn-thread-active", status: "completed" },
    });
    await active;
    await vi.waitFor(() =>
      expect(waitingCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-waiting"),
    );

    client.emit("turn/completed", {
      threadId: "thread-waiting",
      turn: { id: "turn-thread-waiting", status: "completed" },
    });
    await waiting;
  });

  it("settles a lost active job when reconnect finds a different active turn", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      calls.push(`${method}:${threadId}`);
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      if (method === "thread/resume") {
        return {
          thread: {
            id: threadId,
            status: { type: threadId === "thread-active" ? "active" : "idle" },
          },
        };
      }
      if (method === "thread/read" && threadId === "thread-active") {
        return {
          thread: {
            id: threadId,
            turns: [
              { id: "turn-thread-active", status: "completed", items: [] },
              { id: "different-active-turn", status: "inProgress" },
            ],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const activeCallbacks = createCallbacks();
    const waitingCallbacks = createCallbacks();

    manager.trackThread("thread-active", "idle");
    manager.trackThread("thread-waiting", "idle");
    const active = manager.runTurn(createThreadRequest("thread-active", activeCallbacks));
    const activeOutcome = active.then(
      () => undefined,
      (error: unknown) => error,
    );
    const waiting = manager.runTurn(createThreadRequest("thread-waiting", waitingCallbacks));
    await vi.waitFor(() =>
      expect(activeCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-active"),
    );
    await vi.waitFor(() =>
      expect(waitingCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        active: 1,
        limit: 1,
        reason: "global-limit",
      }),
    );

    client.disconnect();

    await expect(activeOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/different active turn.*recover/i),
    });
    expect(calls.filter((call) => call === "turn/start:thread-active")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(waitingCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-waiting"),
    );

    client.emit("turn/completed", {
      threadId: "thread-active",
      turn: { id: "different-active-turn", status: "completed" },
    });
    expect(activeCallbacks.onAgentEnd).not.toHaveBeenCalled();
    expect(calls.filter((call) => call === "turn/start:thread-active")).toHaveLength(1);

    client.emit("turn/completed", {
      threadId: "thread-waiting",
      turn: { id: "turn-thread-waiting", status: "completed" },
    });
    await waiting;
  });

  it("does not replay input when the connection closes during turn/start", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let rejectPendingStart!: (error: Error) => void;
    const pendingStart = new Promise<never>((_resolve, reject) => {
      rejectPendingStart = reject;
    });
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      calls.push(`${method}:${threadId}`);
      if (method === "turn/start" && threadId === "thread-starting") {
        return pendingStart;
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      if (method === "thread/resume") {
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: threadId,
            turns: [{ id: "unknown-new-turn", status: "completed", items: [] }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const startingCallbacks = createCallbacks();
    const waitingCallbacks = createCallbacks();

    manager.trackThread("thread-starting", "idle", null);
    manager.trackThread("thread-waiting", "idle");
    const starting = manager.runTurn(
      createThreadRequest("thread-starting", startingCallbacks),
    );
    const startingOutcome = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(calls).toContain("turn/start:thread-starting"),
    );
    const waiting = manager.runTurn(createThreadRequest("thread-waiting", waitingCallbacks));
    await vi.waitFor(() =>
      expect(waitingCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        active: 1,
        limit: 1,
        reason: "global-limit",
      }),
    );

    client.disconnect();
    rejectPendingStart(new Error("App-server connection closed"));

    await expect(startingOutcome).resolves.toBeUndefined();
    expect(startingCallbacks.onStarted).toHaveBeenCalledWith("unknown-new-turn");
    expect(startingCallbacks.onAgentEnd).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.endsWith(":thread-starting"))).toEqual([
      "turn/start:thread-starting",
      "thread/resume:thread-starting",
      "thread/read:thread-starting",
    ]);
    await vi.waitFor(() =>
      expect(waitingCallbacks.onStarted).toHaveBeenCalledWith("turn-thread-waiting"),
    );

    client.emit("turn/completed", {
      threadId: "thread-waiting",
      turn: { id: "turn-thread-waiting", status: "completed" },
    });
    await waiting;
  });

  it("disposes terminally while lost turn/start reconciliation is pending", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let rejectPendingStart!: (error: Error) => void;
    const pendingStart = new Promise<never>((_resolve, reject) => {
      rejectPendingStart = reject;
    });
    let releaseReconciliation!: () => void;
    const reconciliationGate = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      calls.push(`${method}:${threadId}`);
      if (method === "turn/start" && threadId === "thread-starting") {
        return pendingStart;
      }
      if (method === "thread/resume" && threadId === "thread-starting") {
        await reconciliationGate;
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "thread/resume") {
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "thread/read") {
        return { thread: { id: threadId, turns: [] } };
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const startingCallbacks = createCallbacks();
    const waitingCallbacks = createCallbacks();

    manager.trackThread("thread-starting", "idle");
    manager.trackThread("thread-waiting", "idle");
    const starting = manager.runTurn(
      createThreadRequest("thread-starting", startingCallbacks),
    );
    const waiting = manager.runTurn(createThreadRequest("thread-waiting", waitingCallbacks));
    const startingOutcome = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    const waitingOutcome = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(calls).toContain("turn/start:thread-starting"),
    );
    await vi.waitFor(() =>
      expect(waitingCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        active: 1,
        limit: 1,
        reason: "global-limit",
      }),
    );

    client.disconnect();
    rejectPendingStart(new Error("App-server connection closed"));
    await vi.waitFor(() =>
      expect(calls).toContain("thread/resume:thread-starting"),
    );

    manager.dispose();
    releaseReconciliation();

    await expect(startingOutcome).resolves.toMatchObject({ message: expect.stringMatching(/disposed/i) });
    await expect(waitingOutcome).resolves.toMatchObject({ message: expect.stringMatching(/disposed/i) });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("thread/read:thread-starting");
    expect(calls).not.toContain("turn/start:thread-waiting");
    const scheduler = (manager as unknown as {
      scheduler: { activeTopicKeys: Set<string> };
    }).scheduler;
    await vi.waitFor(() => expect(scheduler.activeTopicKeys.size).toBe(0));

    const afterDispose = manager.runTurn(
      createThreadRequest("thread-after-dispose", createCallbacks()),
    );
    await expect(afterDispose).rejects.toThrow(/disposed/i);
    expect(calls).not.toContain("thread/resume:thread-after-dispose");
    expect(calls).not.toContain("turn/start:thread-after-dispose");
  });

  it("resumes once and retries turn/start once when a disconnect race loses the thread", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let startAttempts = 0;
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        startAttempts += 1;
        if (startAttempts === 1) {
          throw new Error("thread not found: thread-1 (code -32600)");
        }
        return { turn: { id: "retried-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));

    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith("retried-turn"));
    expect(calls).toEqual(["turn/start", "thread/resume", "turn/start"]);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "retried-turn", status: "completed" },
    });
    await completion;
  });

  it("surfaces a genuinely missing thread after one failed resume", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start" || method === "thread/resume") {
        throw new Error("thread not found: thread-1 (code -32600)");
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);

    manager.trackThread("thread-1", "idle");
    await expect(manager.runTurn(createRequest(createCallbacks()))).rejects.toThrow(
      "thread not found: thread-1",
    );
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "thread/resume",
    ]);
  });

  it("surfaces a second thread-not-found without retrying forever", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        throw new Error("thread not found: thread-1 (code -32600)");
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);

    manager.trackThread("thread-1", "idle");
    await expect(manager.runTurn(createRequest(createCallbacks()))).rejects.toThrow(
      "thread not found: thread-1",
    );
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "thread/resume",
      "turn/start",
    ]);
  });

  it("re-resumes and drains an already queued turn after recovery is exhausted", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let startAttempts = 0;
    let releaseFirstStart!: () => void;
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        startAttempts += 1;
        if (startAttempts === 1) {
          await firstStartGate;
          throw new Error("thread not found: thread-1 (code -32600)");
        }
        if (startAttempts === 2) {
          throw new Error("thread not found: thread-1 (code -32600)");
        }
        return { turn: { id: "queued-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const firstCallbacks = createCallbacks();
    const queuedCallbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const first = manager.runTurn(createRequest(firstCallbacks));
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(startAttempts).toBe(1));

    const queued = manager.runTurn(createRequest(queuedCallbacks));
    await vi.waitFor(() =>
      expect(queuedCallbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        reason: "thread-active",
      }),
    );
    releaseFirstStart();

    await expect(firstOutcome).resolves.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(queuedCallbacks.onStarted).toHaveBeenCalledWith("queued-turn"));
    expect(calls).toEqual([
      "turn/start",
      "thread/resume",
      "turn/start",
      "thread/resume",
      "turn/start",
    ]);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "queued-turn", status: "completed" },
    });
    await queued;
  });

  it("keeps concurrent same-thread turns queued while their initial resume is shared", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let startAttempts = 0;
    let resumeAttempts = 0;
    let releaseInitialResume!: () => void;
    const initialResumeGate = new Promise<void>((resolve) => {
      releaseInitialResume = resolve;
    });
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/resume") {
        resumeAttempts += 1;
        if (resumeAttempts === 1) await initialResumeGate;
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        startAttempts += 1;
        if (startAttempts <= 2) {
          throw new Error("thread not found: thread-1 (code -32600)");
        }
        return { turn: { id: "concurrent-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const firstCallbacks = createCallbacks();
    const concurrentCallbacks = createCallbacks();

    const first = manager.runTurn(createRequest(firstCallbacks));
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    const concurrent = manager.runTurn(createRequest(concurrentCallbacks));
    await vi.waitFor(() => expect(resumeAttempts).toBe(1));
    releaseInitialResume();

    await expect(firstOutcome).resolves.toBeInstanceOf(Error);
    await vi.waitFor(() =>
      expect(concurrentCallbacks.onStarted).toHaveBeenCalledWith("concurrent-turn"),
    );
    expect(concurrentCallbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    });
    expect(calls).toEqual([
      "thread/resume",
      "turn/start",
      "thread/resume",
      "turn/start",
      "thread/resume",
      "turn/start",
    ]);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "concurrent-turn", status: "completed" },
    });
    await concurrent;
  });

  it("does not retry unrelated invalid-request errors", async () => {
    const client = new FakeAppServerClient();
    client.request.mockRejectedValue(new Error("invalid turn input (code -32600)"));
    const manager = new AppServerTurnManager(client);

    manager.trackThread("thread-1", "idle");
    await expect(manager.runTurn(createRequest(createCallbacks()))).rejects.toThrow(
      "invalid turn input",
    );
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
  });

  it.each([
    "database busy",
    "server busy",
  ])("surfaces unrelated busy errors instead of queueing forever: %s", async (message) => {
    const client = new FakeAppServerClient();
    client.request.mockRejectedValue(new Error(message));
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const outcome = manager.runTurn(createRequest(callbacks)).then(
      () => undefined,
      (error: unknown) => error,
    );
    const result = await Promise.race([
      outcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ]);

    expect(result).toBeInstanceOf(Error);
    expect(callbacks.onQueued).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    "thread busy",
    "thread has an active turn",
    "turn is already running",
  ])("keeps the turn queued when turn/start reports %s", async (message) => {
    const client = new FakeAppServerClient();
    let startAttempts = 0;
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        startAttempts += 1;
        if (startAttempts === 1) throw new Error(message);
        return { turn: { id: "turn-after-busy", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));

    await vi.waitFor(() =>
      expect(callbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        reason: "thread-active",
      }),
    );
    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "external-turn", status: "completed" },
    });
    await vi.waitFor(() =>
      expect(callbacks.onStarted).toHaveBeenCalledWith("turn-after-busy"),
    );
    expect(startAttempts).toBe(2);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-after-busy", status: "completed" },
    });
    await completion;
  });

  it("resumes and drains a queue-only thread after a busy turn disconnects", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let startAttempts = 0;
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        startAttempts += 1;
        if (startAttempts === 1) throw new Error("thread busy");
        return { turn: { id: "turn-after-reconnect", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() =>
      expect(callbacks.onQueued).toHaveBeenCalledWith({
        position: 1,
        reason: "thread-active",
      }),
    );

    client.disconnect();

    await vi.waitFor(() =>
      expect(callbacks.onStarted).toHaveBeenCalledWith("turn-after-reconnect"),
    );
    expect(calls).toEqual(["turn/start", "thread/resume", "turn/start"]);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-after-reconnect", status: "completed" },
    });
    await completion;
  });

  it("unsubscribes from disconnects when disposed", () => {
    const client = new FakeAppServerClient();
    const manager = new AppServerTurnManager(client);

    expect(client.hasDisconnectListener()).toBe(true);
    manager.dispose();
    expect(client.hasDisconnectListener()).toBe(false);
  });

  it("reloads a thread by evicting it, because unsubscribing leaves it loaded", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      return {};
    });
    const manager = new AppServerTurnManager(client);

    await manager.reloadThread("thread-1");

    expect(calls).toEqual(["thread/archive", "thread/unarchive", "thread/resume"]);
  });

  it("unarchives after dispose races with a successful archive", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/archive") await archiveGate;
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      return {};
    });
    const manager = new AppServerTurnManager(client);

    const reloadOutcome = manager.reloadThread("thread-1").then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(calls).toEqual(["thread/archive"]));

    manager.dispose();
    releaseArchive();

    await expect(reloadOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/disposed/i),
    });
    expect(calls).toEqual(["thread/archive", "thread/unarchive"]);
    expect(calls).not.toContain("thread/resume");
    expect(calls).not.toContain("turn/start");
  });

  it("puts the thread back even when the reload itself fails", async () => {
    const client = new FakeAppServerClient();
    const calls: string[] = [];
    client.request.mockImplementation(async (method: string) => {
      calls.push(method);
      if (method === "thread/resume") {
        throw new Error("resume exploded");
      }
      return {};
    });
    const manager = new AppServerTurnManager(client);

    await expect(manager.reloadThread("thread-1")).rejects.toThrow("resume exploded");
    expect(calls).toContain("thread/unarchive");
  });

  it("refuses to reload a thread with a turn in flight", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        return { turn: { id: "busy-turn", status: "inProgress" } };
      }
      return {};
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    void completion.catch(() => undefined);
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        "turn/start",
        expect.anything(),
        expect.objectContaining({ onWritten: expect.any(Function) }),
      ),
    );

    await expect(manager.reloadThread("thread-1")).rejects.toThrow(/in flight|active/i);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "busy-turn", status: "completed" },
    });
    await completion;
  });

  it("reports why a hook blocked the turn, and still completes it", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        return { turn: { id: "blocked-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = { ...createCallbacks(), onHookBlocked: vi.fn() };

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        "turn/start",
        expect.anything(),
        expect.objectContaining({ onWritten: expect.any(Function) }),
      ),
    );

    client.emit("hook/completed", {
      threadId: "thread-1",
      turnId: "blocked-turn",
      run: {
        eventName: "userPromptSubmit",
        status: "blocked",
        statusMessage: "Checking synchronized thread ownership",
        entries: [{ kind: "feedback", text: "Reopen this exact task before continuing." }],
      },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "blocked-turn", status: "completed" },
    });

    await completion;
    expect(callbacks.onHookBlocked).toHaveBeenCalledWith({
      eventName: "userPromptSubmit",
      reason: "Reopen this exact task before continuing.",
    });
  });

  it("says nothing about hooks that ran and let the turn through", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        return { turn: { id: "open-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = { ...createCallbacks(), onHookBlocked: vi.fn() };

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        "turn/start",
        expect.anything(),
        expect.objectContaining({ onWritten: expect.any(Function) }),
      ),
    );

    client.emit("hook/completed", {
      threadId: "thread-1",
      turnId: "open-turn",
      run: { eventName: "userPromptSubmit", status: "completed", entries: [] },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "open-turn", status: "completed" },
    });

    await completion;
    expect(callbacks.onHookBlocked).not.toHaveBeenCalled();
  });

  it("starts the first turn of a newly created in-memory thread without resuming it", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        return { turn: { id: "first-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    void completion.catch(() => undefined);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.objectContaining({ onWritten: expect.any(Function) }),
    ));
    expect(client.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
  });

  it("starts a turn immediately when the shared thread is idle", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ threadId: "thread-1", input: createRequest(callbacks).input }),
        expect.objectContaining({ onWritten: expect.any(Function) }),
      );
    });

    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "message-1",
      delta: "Готово",
    });
    client.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      tokenUsage: {
        last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 },
      },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(callbacks.onQueued).not.toHaveBeenCalled();
    expect(callbacks.onStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Готово");
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
    });
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("queues behind a turn started by the direct Codex client", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "active", activeFlags: [] } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(callbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    }));
    expect(client.request).not.toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything(),
    );

    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "direct-turn",
      itemId: "direct-message",
      delta: "Не отправлять в Telegram",
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "direct-turn", status: "completed", error: null },
    });

    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ threadId: "thread-1" }),
        expect.objectContaining({ onWritten: expect.any(Function) }),
      );
    });
    expect(callbacks.onStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextDelta).not.toHaveBeenCalled();

    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "telegram-message",
      delta: "Ответ Telegram",
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Ответ Telegram");
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("routes command output and final status only for the Telegram turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.objectContaining({ onWritten: expect.any(Function) }),
    ));

    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "commandExecution", id: "cmd-1", command: "npm test", status: "inProgress" },
    });
    client.emit("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "cmd-1",
      delta: "all green\n",
    });
    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "commandExecution", id: "cmd-1", command: "npm test", status: "completed" },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await completion;
    expect(callbacks.onToolStart).toHaveBeenCalledWith("npm test", "cmd-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("cmd-1", "all green\n");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-1", false);
  });

  it("preserves agent message boundaries and phases", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.objectContaining({ onWritten: expect.any(Function) }),
    ));

    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "commentary-1", phase: "commentary" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "commentary-1",
      delta: "Проверяю.",
    });
    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "commentary-1", phase: "commentary" },
    });
    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "final-1", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "final-1",
      delta: "Готово.",
    });
    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "final-1", phase: "final_answer" },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await completion;
    expect(callbacks.onAgentMessageStart).toHaveBeenNthCalledWith(1, {
      itemId: "commentary-1",
      phase: "commentary",
    });
    expect(callbacks.onAgentMessageStart).toHaveBeenNthCalledWith(2, {
      itemId: "final-1",
      phase: "final_answer",
    });
    expect(callbacks.onAgentMessageEnd).toHaveBeenNthCalledWith(1, {
      itemId: "commentary-1",
      phase: "commentary",
    });
    expect(callbacks.onAgentMessageEnd).toHaveBeenNthCalledWith(2, {
      itemId: "final-1",
      phase: "final_answer",
    });
  });

  it("routes generated images with their saved path", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.objectContaining({ onWritten: expect.any(Function) }),
    ));

    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: {
        type: "imageGeneration",
        id: "image-1",
        status: "completed",
        savedPath: "/root/.codex/generated_images/thread-1/image-1.png",
        result: "base64-image",
      },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await completion;
    expect(callbacks.onGeneratedImage).toHaveBeenCalledWith({
      path: "/root/.codex/generated_images/thread-1/image-1.png",
    });
  });

  it("removes a queued Telegram turn without interrupting the direct turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockResolvedValue({
      thread: { id: "thread-1", status: { type: "active", activeFlags: [] } },
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(callbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    }));
    await manager.cancelTurn("thread-1", callbacks);

    await expect(completion).rejects.toThrow("aborted");
    expect(client.request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
  });

  it("interrupts the active Telegram turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    void completion.catch(() => undefined);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.objectContaining({ onWritten: expect.any(Function) }),
    ));

    await manager.cancelTurn("thread-1", callbacks);

    expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "telegram-turn",
    });
  });

  it("limits active Telegram turns globally and reports queue capacity", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      if (method === "thread/resume") {
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const firstCallbacks = createCallbacks();
    const secondCallbacks = createCallbacks();

    const first = manager.runTurn(createThreadRequest("thread-a", firstCallbacks));
    const second = manager.runTurn(createThreadRequest("thread-b", secondCallbacks));
    void first.catch(() => undefined);
    void second.catch(() => undefined);

    await vi.waitFor(() => expect(firstCallbacks.onStarted).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(secondCallbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      active: 1,
      limit: 1,
      reason: "global-limit",
    }));
    expect(client.request).not.toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thread-b" }),
      expect.anything(),
    );

    client.emit("turn/completed", {
      threadId: "thread-a",
      turn: { id: "turn-thread-a", status: "completed", error: null },
    });

    await vi.waitFor(() => expect(secondCallbacks.onStarted).toHaveBeenCalledTimes(1));
    client.emit("turn/completed", {
      threadId: "thread-b",
      turn: { id: "turn-thread-b", status: "completed", error: null },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("does not spend a global slot while waiting for a direct Codex turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      if (method === "thread/resume") {
        return {
          thread: {
            id: threadId,
            status: { type: threadId === "thread-direct" ? "active" : "idle" },
          },
        };
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const waitingCallbacks = createCallbacks();
    const runnableCallbacks = createCallbacks();

    const waiting = manager.runTurn(createThreadRequest("thread-direct", waitingCallbacks));
    const runnable = manager.runTurn(createThreadRequest("thread-free", runnableCallbacks));
    void waiting.catch(() => undefined);
    void runnable.catch(() => undefined);

    await vi.waitFor(() => expect(waitingCallbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    }));
    await vi.waitFor(() => expect(runnableCallbacks.onStarted).toHaveBeenCalledTimes(1));
    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thread-free" }),
      expect.objectContaining({ onWritten: expect.any(Function) }),
    );

    client.emit("turn/completed", {
      threadId: "thread-free",
      turn: { id: "turn-thread-free", status: "completed", error: null },
    });
    await runnable;

    client.emit("turn/completed", {
      threadId: "thread-direct",
      turn: { id: "direct-app-turn", status: "completed", error: null },
    });
    await vi.waitFor(() => expect(waitingCallbacks.onStarted).toHaveBeenCalledTimes(1));
    client.emit("turn/completed", {
      threadId: "thread-direct",
      turn: { id: "turn-thread-direct", status: "completed", error: null },
    });
    await waiting;
  });

  it("reattaches to an active Telegram turn after restart without starting it twice", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "active" } } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const callbacks = createCallbacks();

    const completion = manager.recoverTurn(createRequest(callbacks), "turn-existing");
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith("turn-existing"));
    expect(client.request).not.toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything(),
    );

    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-existing",
      item: { type: "agentMessage", id: "final", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-existing",
      itemId: "final",
      delta: "Recovered result",
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-existing", status: "completed", error: null },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Recovered result");
  });

  it("replays a turn that completed while TeleCodex was offline", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            turns: [{
              id: "turn-existing",
              status: "completed",
              items: [{
                type: "agentMessage",
                id: "final",
                phase: "final_answer",
                text: "Offline result",
              }],
            }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const callbacks = createCallbacks();

    await expect(manager.recoverTurn(createRequest(callbacks), "turn-existing")).resolves.toBeUndefined();

    expect(client.request).toHaveBeenCalledWith("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });
    expect(callbacks.onAgentMessageStart).toHaveBeenCalledWith({
      itemId: "final",
      phase: "final_answer",
    });
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Offline result");
    expect(callbacks.onAgentMessageEnd).toHaveBeenCalledWith({
      itemId: "final",
      phase: "final_answer",
    });
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });
});
