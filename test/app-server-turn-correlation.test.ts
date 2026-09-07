import { vi } from "vitest";

import {
  AppServerRequestError,
  type AppServerNotification,
  type AppServerRequestOptions,
} from "../src/app-server-client.js";
import {
  AppServerTurnManager,
  type AppServerTurnCallbacks,
  type AppServerTurnRequest,
} from "../src/app-server-turn-manager.js";

class FakeClient {
  readonly request = vi.fn();
  private notification?: (notification: AppServerNotification) => void;

  async connect(): Promise<void> {}

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notification = listener;
    return () => { this.notification = undefined; };
  }

  onDisconnect(): () => void {
    return () => {};
  }

  emit(method: string, params: Record<string, unknown>): void {
    this.notification?.({ method, params });
  }
}

function callbacks(): AppServerTurnCallbacks {
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
  };
}

function request(observed: AppServerTurnCallbacks): AppServerTurnRequest {
  return {
    threadId: "thread-1",
    input: [{ type: "text", text: "prompt", text_elements: [] }],
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    callbacks: observed,
  };
}

function completed(client: FakeClient, turnId: string): void {
  client.emit("turn/completed", {
    threadId: "thread-1",
    turn: { id: turnId, status: "completed" },
  });
}

describe("AppServerTurnManager turn/start correlation", () => {
  it.each([
    ["typed", new AppServerRequestError("APP_SERVER_REJECTED", -32600, "THREAD_BUSY")],
    ["legacy", new Error("thread busy")],
  ])("discards an external provisional start after a %s proven busy rejection", async (_label, busyError) => {
    const client = new FakeClient();
    let rejectFirst!: (error: Error) => void;
    let attempts = 0;
    client.request.mockImplementation((
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      attempts += 1;
      options?.onWritten?.();
      if (attempts === 1) {
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
      return Promise.resolve({ turn: { id: "turn-own", status: "inProgress" } });
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", "turn-old");
    const completion = manager.runTurn(request(observed));
    const completionOutcome = completion.then(() => undefined, (error: unknown) => error);
    await vi.waitFor(() => expect(observed.onDispatchWritten).toHaveBeenCalledOnce());

    client.emit("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    });
    client.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-external", status: "inProgress" },
    });
    expect(observed.onStarted).not.toHaveBeenCalled();
    expect(observed.onActivity).not.toHaveBeenCalled();
    rejectFirst(busyError);
    await vi.waitFor(() => expect(observed.onQueued).toHaveBeenCalledOnce());

    completed(client, "turn-external");
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-own"));
    expect(attempts).toBe(2);
    expect(vi.mocked(observed.onDispatching!).mock.calls.map(([event]) => event)).toEqual([
      { previousTurnId: "turn-old", attempt: 1 },
      { previousTurnId: "turn-external", attempt: 2 },
    ]);
    completed(client, "turn-own");
    await expect(completionOutcome).resolves.toBeUndefined();
  });

  it.each([
    ["typed", new AppServerRequestError("APP_SERVER_REJECTED", -32600, "THREAD_BUSY")],
    ["legacy", new Error("thread busy")],
  ])("drains after a provisional external completion precedes a %s busy rejection", async (
    _label,
    busyError,
  ) => {
    const client = new FakeClient();
    let rejectFirst!: (error: Error) => void;
    let attempts = 0;
    client.request.mockImplementation((
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      attempts += 1;
      options?.onWritten?.();
      if (attempts === 1) {
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
      return Promise.resolve({ turn: { id: "turn-own", status: "inProgress" } });
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", "turn-old");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onDispatchWritten).toHaveBeenCalledOnce());

    client.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-external", status: "inProgress" },
    });
    completed(client, "turn-external");
    rejectFirst(busyError);

    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-own"));
    expect(observed.onStarted).not.toHaveBeenCalledWith("turn-external");
    expect(observed.onActivity).not.toHaveBeenCalled();
    expect(vi.mocked(observed.onDispatching!).mock.calls.map(([event]) => event)).toEqual([
      { previousTurnId: "turn-old", attempt: 1 },
      { previousTurnId: "turn-external", attempt: 2 },
    ]);

    completed(client, "turn-own");
    await completion;
  });

  it("buffers completion until a matching turn/start response confirms ownership", async () => {
    const client = new FakeClient();
    let resolveStart!: (value: unknown) => void;
    client.request.mockImplementation((
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      options?.onWritten?.();
      return new Promise((resolve) => { resolveStart = resolve; });
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", null);
    const completion = manager.runTurn(request(observed));
    const outcome = completion.then(() => "resolved", () => "rejected");
    await vi.waitFor(() => expect(observed.onDispatchWritten).toHaveBeenCalledOnce());

    client.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-own", status: "inProgress" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-own",
      itemId: "answer",
      delta: "Buffered answer",
    });
    completed(client, "turn-own");
    expect(observed.onStarted).not.toHaveBeenCalled();
    expect(observed.onActivity).not.toHaveBeenCalled();
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");

    resolveStart({ turn: { id: "turn-own", status: "completed" } });
    await expect(completion).resolves.toBeUndefined();
    expect(observed.onStarted).toHaveBeenCalledOnce();
    expect(observed.onStarted).toHaveBeenCalledWith("turn-own");
    expect(vi.mocked(observed.onActivity!).mock.calls.map(([event]) => event.method)).toEqual([
      "turn/started",
      "item/agentMessage/delta",
      "turn/completed",
    ]);
    expect(observed.onTextDelta).toHaveBeenCalledWith("Buffered answer");
    expect(vi.mocked(observed.onStarted!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(observed.onTextDelta).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(observed.onTextDelta).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(observed.onAgentEnd).mock.invocationCallOrder[0]!,
    );
    expect(observed.onAgentEnd).toHaveBeenCalledOnce();
  });

  it("fails sticky unknown when the provisional notification buffer overflows", async () => {
    const client = new FakeClient();
    client.request.mockImplementation((
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") return Promise.reject(new Error(`Unexpected method: ${method}`));
      options?.onWritten?.();
      return new Promise(() => {});
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", null);
    const outcome = manager.runTurn(request(observed)).catch((error: unknown) => error);
    await vi.waitFor(() => expect(observed.onDispatchWritten).toHaveBeenCalledOnce());

    client.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-candidate", status: "inProgress" },
    });
    for (let index = 0; index < 256; index += 1) {
      client.emit("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-candidate",
        itemId: "answer",
        delta: String(index),
      });
    }

    await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(observed.onStarted).not.toHaveBeenCalled();
    expect(observed.onTextDelta).not.toHaveBeenCalled();
  });

  it("does not regress a known latest identity on a late unmatched completion", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-next", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", "turn-newer");

    completed(client, "turn-older");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-next"));
    expect(observed.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-newer",
      attempt: 1,
    });

    completed(client, "turn-next");
    await completion;
  });

  it("advances latest after the observed external active turn completes", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-next", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "active", "turn-old");

    client.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-external", status: "inProgress" },
    });
    completed(client, "turn-external");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-next"));
    expect(observed.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-external",
      attempt: 1,
    });

    completed(client, "turn-next");
    await completion;
  });

  it("advances latest for an external turn while a local prompt is only queued", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-local", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "active", "turn-old");
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onQueued).toHaveBeenCalledOnce());

    client.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-external", status: "inProgress" },
    });
    completed(client, "turn-external");

    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-local"));
    expect(observed.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-external",
      attempt: 1,
    });
    completed(client, "turn-local");
    await completion;
  });
});
