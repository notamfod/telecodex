import { vi } from "vitest";

import {
  AppServerRequestError,
  type AppServerNotification,
  type AppServerRequestOptions,
} from "../src/app-server-client.js";
import { mapAppServerActivity } from "../src/app-server-activity.js";
import {
  AppServerTurnManager,
  type AppServerTurnCallbacks,
  type AppServerTurnRequest,
} from "../src/app-server-turn-manager.js";
import type { JobActivity } from "../src/telegram-job-types.js";

type FactCallbacks = AppServerTurnCallbacks & {
  onDispatching: (event: { previousTurnId: string | null; attempt: number }) => void;
  onDispatchWritten: () => void;
  onActivity: (event: { activity: JobActivity; eventAt: number; method: string }) => void;
};

class FakeClient {
  readonly request = vi.fn();
  private notification?: (notification: AppServerNotification & { emittedAtMs?: number }) => void;
  private disconnect?: () => void;

  async connect(): Promise<void> {}

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notification = listener;
    return () => { this.notification = undefined; };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnect = listener;
    return () => { this.disconnect = undefined; };
  }

  emit(notification: AppServerNotification & { emittedAtMs?: number }): void {
    this.notification?.(notification);
  }
}

function callbacks(): FactCallbacks {
  return {
    onQueued: vi.fn(),
    onDispatching: vi.fn(),
    onDispatchWritten: vi.fn(),
    onActivity: vi.fn(),
    onStarted: vi.fn(),
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
    onTurnComplete: vi.fn(),
  };
}

function request(value: FactCallbacks): AppServerTurnRequest {
  return {
    threadId: "thread-1",
    input: [{ type: "text", text: "prompt", text_elements: [] }],
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    callbacks: value,
  };
}

function complete(client: FakeClient, turnId: string, emittedAtMs = 2_000): void {
  client.emit({
    method: "turn/completed",
    emittedAtMs,
    params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
  });
}

describe("AppServerTurnManager execution facts", () => {
  it.each([
    ["item/agentMessage/delta", {}, { activity: "model", sample: true }],
    ["item/reasoning/summaryTextDelta", {}, { activity: "model", sample: true }],
    ["item/reasoning/textDelta", {}, { activity: "model", sample: true }],
    ["thread/tokenUsage/updated", {}, { activity: "model", sample: true }],
    ["item/plan/delta", {}, { activity: "model", sample: true }],
    ["item/commandExecution/outputDelta", {}, { activity: "tool", sample: true }],
    ["item/commandExecution/terminalInteraction", {}, { activity: "tool", sample: true }],
    ["item/fileChange/outputDelta", {}, { activity: "tool", sample: true }],
    ["item/fileChange/patchUpdated", {}, { activity: "tool", sample: true }],
    ["item/mcpToolCall/progress", {}, { activity: "tool", sample: true }],
    ["command/exec/outputDelta", {}, { activity: "tool", sample: true }],
    ["process/outputDelta", {}, { activity: "tool", sample: true }],
    ["process/exited", {}, { activity: "tool", sample: false }],
    ["turn/started", {}, { activity: "model", sample: false }],
    ["turn/completed", {}, { activity: "unknown", sample: false }],
    ["error", {}, { activity: "unknown", sample: false }],
    ["turn/plan/updated", {}, { activity: "model", sample: false }],
    [
      "thread/status/changed",
      { status: { activeFlags: ["waitingOnUserInput"] } },
      { activity: "waiting", sample: false },
    ],
    [
      "item/started",
      { item: { type: "agentMessage" } },
      { activity: "model", sample: false },
    ],
    [
      "item/completed",
      { item: { type: "commandExecution" } },
      { activity: "tool", sample: false },
    ],
  ])("maps %s to its exact activity sampling policy", (method, params, expected) => {
    expect(mapAppServerActivity(method, params)).toEqual(expected);
  });

  it("reports exact dispatch attempts, write boundaries, and previous turn identity", async () => {
    const client = new FakeClient();
    let starts = 0;
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      starts += 1;
      options?.onWritten?.();
      return { turn: { id: `turn-${starts}`, status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle");

    const firstCallbacks = callbacks();
    const first = manager.runTurn(request(firstCallbacks));
    await vi.waitFor(() => expect(firstCallbacks.onStarted).toHaveBeenCalledWith("turn-1"));
    complete(client, "turn-1");
    await first;

    const secondCallbacks = callbacks();
    const second = manager.runTurn(request(secondCallbacks));
    await vi.waitFor(() => expect(secondCallbacks.onStarted).toHaveBeenCalledWith("turn-2"));

    expect(firstCallbacks.onDispatching).toHaveBeenCalledWith({
      previousTurnId: null,
      attempt: 1,
    });
    expect(secondCallbacks.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-1",
      attempt: 1,
    });
    expect(firstCallbacks.onDispatchWritten).toHaveBeenCalledOnce();
    expect(secondCallbacks.onDispatchWritten).toHaveBeenCalledOnce();
    complete(client, "turn-2");
    await second;
  });

  it("uses an external completed turn as the exact baseline for the queued prompt", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "active" }, turns: [] } };
      }
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-own", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onQueued).toHaveBeenCalledOnce());

    complete(client, "turn-external");
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-own"));
    expect(observed.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-external",
      attempt: 1,
    });

    complete(client, "turn-own");
    await completion;
  });

  it("increments attempts and refreshes the baseline after a proven rejected attempt", async () => {
    const client = new FakeClient();
    let starts = 0;
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "thread/resume") {
        return {
          thread: {
            id: "thread-1",
            status: { type: "idle" },
            turns: [{ id: "previous-turn", status: "completed" }],
          },
        };
      }
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      starts += 1;
      options?.onWritten?.();
      if (starts === 1) {
        throw new AppServerRequestError("APP_SERVER_REJECTED", -32600, "THREAD_NOT_FOUND");
      }
      return { turn: { id: "turn-retried", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");

    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-retried"));

    expect(observed.onDispatching.mock.calls.map(([event]) => event)).toEqual([
      { previousTurnId: null, attempt: 1 },
      { previousTurnId: "previous-turn", attempt: 2 },
    ]);
    expect(observed.onDispatchWritten).toHaveBeenCalledTimes(2);
    complete(client, "turn-retried");
    await completion;
  });

  it("maps exact server notifications to immediate activity facts", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-facts", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client, 4, { now: () => 0 });
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-facts"));

    const emit = (method: string, emittedAtMs: number, params: Record<string, unknown>) => {
      client.emit({ method, emittedAtMs, params: { threadId: "thread-1", turnId: "turn-facts", ...params } });
    };
    client.emit({
      method: "item/started",
      emittedAtMs: 100,
      params: { threadId: "thread-1", turnId: "other-turn", item: { id: "wrong", type: "commandExecution" } },
    });
    emit("item/agentMessage/delta", 101, { delta: "a" });
    emit("item/reasoning/textDelta", 102, { delta: "r", itemId: "reasoning" });
    emit("item/plan/delta", 103, { delta: "plan" });
    emit("turn/plan/updated", 104, { plan: [] });
    emit("item/started", 105, { item: { id: "command", type: "commandExecution", command: "pwd" } });
    emit("item/mcpToolCall/progress", 106, { itemId: "mcp", message: "working" });
    emit("item/started", 107, { item: { id: "collab", type: "collabAgentToolCall", tool: "spawnAgent" } });
    emit("item/started", 108, { item: { id: "child", type: "subAgentActivity", kind: "started" } });
    emit("item/started", 109, { item: { id: "sleep", type: "sleep", durationMs: 500 } });
    client.emit({
      method: "thread/status/changed",
      emittedAtMs: 110,
      params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
    });
    emit("turn/started", 111, { turn: { id: "turn-facts", status: "inProgress" } });
    emit("error", 112, { error: { message: "failure fact" } });
    complete(client, "turn-facts", 113);
    await completion;

    expect(observed.onActivity.mock.calls.map(([event]) => event)).toEqual([
      { activity: "model", eventAt: 101, method: "item/agentMessage/delta" },
      { activity: "model", eventAt: 104, method: "turn/plan/updated" },
      { activity: "tool", eventAt: 105, method: "item/started" },
      { activity: "tool", eventAt: 106, method: "item/mcpToolCall/progress" },
      { activity: "subagent", eventAt: 107, method: "item/started" },
      { activity: "subagent", eventAt: 108, method: "item/started" },
      { activity: "waiting", eventAt: 109, method: "item/started" },
      { activity: "waiting", eventAt: 110, method: "thread/status/changed" },
      { activity: "model", eventAt: 111, method: "turn/started" },
      { activity: "unknown", eventAt: 112, method: "error" },
      { activity: "unknown", eventAt: 113, method: "turn/completed" },
    ]);
  });

  it("samples repeated progress by activity and lets activity changes through immediately", async () => {
    let now = 0;
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-sample", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client, 4, {
      activityCoalesceMs: 1_000,
      now: () => now,
    });
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledOnce());

    const toolProgress = () => client.emit({
      method: "item/commandExecution/outputDelta",
      emittedAtMs: now,
      params: {
        threadId: "thread-1",
        turnId: "turn-sample",
        itemId: "command",
        delta: "x",
      },
    });
    for (let index = 0; index < 100; index += 1) {
      now = index;
      toolProgress();
    }
    now = 100;
    client.emit({
      method: "item/agentMessage/delta",
      emittedAtMs: now,
      params: { threadId: "thread-1", turnId: "turn-sample", delta: "model" },
    });
    now = 101;
    toolProgress();
    now = 1_101;
    toolProgress();

    expect(observed.onActivity.mock.calls.map(([event]) => event)).toEqual([
      { activity: "tool", eventAt: 0, method: "item/commandExecution/outputDelta" },
      { activity: "model", eventAt: 100, method: "item/agentMessage/delta" },
      { activity: "tool", eventAt: 101, method: "item/commandExecution/outputDelta" },
      { activity: "tool", eventAt: 1_101, method: "item/commandExecution/outputDelta" },
    ]);
    complete(client, "turn-sample", 1_102);
    await completion;
  });

  it("never samples lifecycle activity events", async () => {
    let now = 0;
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-lifecycle", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client, 4, {
      activityCoalesceMs: 1_000,
      now: () => now,
    });
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledOnce());

    const emit = (method: string, params: Record<string, unknown>) => {
      client.emit({
        method,
        emittedAtMs: now,
        params: { threadId: "thread-1", turnId: "turn-lifecycle", ...params },
      });
      now += 1;
    };
    emit("item/started", { item: { id: "command-1", type: "commandExecution" } });
    emit("item/started", { item: { id: "command-2", type: "commandExecution" } });
    emit("process/exited", { processId: "process-1", exitCode: 0 });
    emit("process/exited", { processId: "process-1", exitCode: 0 });
    emit("turn/plan/updated", { plan: [] });
    emit("turn/plan/updated", { plan: [] });

    expect(observed.onActivity.mock.calls.map(([event]) => event.method)).toEqual([
      "item/started",
      "item/started",
      "process/exited",
      "process/exited",
      "turn/plan/updated",
      "turn/plan/updated",
    ]);
    complete(client, "turn-lifecycle", now);
    await completion;
  });

  it("replays provisional activity with its original receipt time", async () => {
    let now = 0;
    let resolveStart!: (value: unknown) => void;
    const client = new FakeClient();
    client.request.mockImplementation((
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      options?.onWritten?.();
      return new Promise((resolve) => { resolveStart = resolve; });
    });
    const manager = new AppServerTurnManager(client, 4, {
      activityCoalesceMs: 1_000,
      now: () => now,
    });
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", null);
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onDispatchWritten).toHaveBeenCalledOnce());

    client.emit({
      method: "turn/started",
      emittedAtMs: 0,
      params: { threadId: "thread-1", turn: { id: "turn-buffered", status: "inProgress" } },
    });
    now = 10;
    client.emit({
      method: "item/commandExecution/outputDelta",
      emittedAtMs: -1,
      params: {
        threadId: "thread-1",
        turnId: "turn-buffered",
        itemId: "command",
        delta: "first",
      },
    });
    now = 1_010;
    client.emit({
      method: "item/commandExecution/outputDelta",
      emittedAtMs: -1,
      params: {
        threadId: "thread-1",
        turnId: "turn-buffered",
        itemId: "command",
        delta: "second",
      },
    });
    expect(observed.onActivity).not.toHaveBeenCalled();

    now = 5_000;
    resolveStart({ turn: { id: "turn-buffered", status: "inProgress" } });
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-buffered"));
    expect(observed.onActivity.mock.calls.map(([event]) => event)).toEqual([
      { activity: "model", eventAt: 0, method: "turn/started" },
      { activity: "tool", eventAt: 10, method: "item/commandExecution/outputDelta" },
      { activity: "tool", eventAt: 1_010, method: "item/commandExecution/outputDelta" },
    ]);

    now = 6_000;
    complete(client, "turn-buffered", now);
    await completion;
  });

  it("isolates fact observers from turn and scheduler invariants", async () => {
    const client = new FakeClient();
    let starts = 0;
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      starts += 1;
      options?.onWritten?.();
      return { turn: { id: `turn-${starts}`, status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle");

    const throwing = callbacks();
    throwing.onDispatching = vi.fn(() => { throw new Error("dispatch observer"); });
    throwing.onDispatchWritten = vi.fn(() => { throw new Error("write observer"); });
    throwing.onActivity = vi.fn(() => { throw new Error("activity observer"); });
    const first = manager.runTurn(request(throwing));
    await vi.waitFor(() => expect(throwing.onStarted).toHaveBeenCalledWith("turn-1"));
    client.emit({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "tool", type: "commandExecution" } },
    });
    complete(client, "turn-1");
    await expect(first).resolves.toBeUndefined();

    const next = callbacks();
    const second = manager.runTurn(request(next));
    await vi.waitFor(() => expect(next.onStarted).toHaveBeenCalledWith("turn-2"));
    complete(client, "turn-2");
    await second;
  });

  it("lets onStarted cancel the just-bound starting turn reentrantly", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/interrupt") return {};
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-cancel", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    observed.onStarted = vi.fn(() => {
      void manager.cancelTurn("thread-1", observed);
    });
    manager.trackThread("thread-1", "idle");

    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-cancel"));
    expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-cancel",
    });

    complete(client, "turn-cancel");
    await completion;
  });

  it("does not publish a provisional turn/started when the response conflicts", async () => {
    const client = new FakeClient();
    let resolveStart!: (value: unknown) => void;
    client.request.mockImplementation((method: string, _params: unknown, options?: AppServerRequestOptions) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      options?.onWritten?.();
      return new Promise((resolve) => { resolveStart = resolve; });
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");
    const outcome = manager.runTurn(request(observed)).catch((error: unknown) => error);
    await vi.waitFor(() => expect(observed.onDispatching).toHaveBeenCalledOnce());

    client.emit({
      method: "turn/started",
      emittedAtMs: 500,
      params: { threadId: "thread-1", turn: { id: "turn-notified", status: "inProgress" } },
    });
    resolveStart({ turn: { id: "turn-conflict", status: "inProgress" } });

    await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
    expect(observed.onStarted).not.toHaveBeenCalled();
    expect(observed.onActivity).not.toHaveBeenCalled();
  });

  it("binds an early turn/started once when the later response has the same identity", async () => {
    const client = new FakeClient();
    let resolveStart!: (value: unknown) => void;
    client.request.mockImplementation((method: string, _params: unknown, options?: AppServerRequestOptions) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      options?.onWritten?.();
      return new Promise((resolve) => { resolveStart = resolve; });
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onDispatchWritten).toHaveBeenCalledOnce());

    client.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-same", status: "inProgress" } },
    });
    resolveStart({ turn: { id: "turn-same", status: "completed" } });
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-same"));
    expect(observed.onStarted).toHaveBeenCalledOnce();

    complete(client, "turn-same");
    await completion;
  });

  it("ignores a foreign turn/started until this prompt has write evidence", async () => {
    const client = new FakeClient();
    let resolveStart!: (value: unknown) => void;
    client.request.mockImplementation((method: string) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      return new Promise((resolve) => { resolveStart = resolve; });
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onDispatching).toHaveBeenCalledOnce());

    client.emit({
      method: "thread/status/changed",
      emittedAtMs: 399,
      params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
    });
    client.emit({
      method: "turn/started",
      emittedAtMs: 400,
      params: { threadId: "thread-1", turn: { id: "foreign-turn", status: "inProgress" } },
    });
    expect(observed.onStarted).not.toHaveBeenCalled();
    expect(observed.onActivity).not.toHaveBeenCalled();

    resolveStart({ turn: { id: "own-turn", status: "inProgress" } });
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("own-turn"));
    complete(client, "own-turn");
    await completion;
  });
});
