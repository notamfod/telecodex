import { vi } from "vitest";

import type { AppServerNotification, AppServerRequestOptions }
  from "../src/app-server-client.js";
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
  onDisconnect(): () => void { return () => {}; }
  emit(notification: AppServerNotification): void { this.notification?.(notification); }
}

function callbacks(): AppServerTurnCallbacks {
  return {
    onStarted: vi.fn(), onTextDelta: vi.fn(), onToolStart: vi.fn(),
    onToolUpdate: vi.fn(), onToolEnd: vi.fn(), onAgentEnd: vi.fn(),
    onTurnOutcome: vi.fn(),
  };
}

function request(observed: AppServerTurnCallbacks, rich = false): AppServerTurnRequest {
  return {
    threadId: "thread-1",
    input: rich
      ? [{ type: "text", text: "look", text_elements: [] }, { type: "localImage", path: "/tmp/image.png" }]
      : [{ type: "text", text: "next", text_elements: [] }],
    cwd: "/workspace", approvalPolicy: "never", sandbox: "workspace-write",
    callbacks: observed,
  };
}

function emitError(client: FakeClient, turnId: string): void {
  client.emit({ method: "error", params: {
    threadId: "thread-1", turnId, error: { message: "Selected model is at capacity" },
  } });
}

function emitIdle(client: FakeClient): void {
  client.emit({ method: "thread/status/changed", params: {
    threadId: "thread-1", status: { type: "idle" },
  } });
}

describe("AppServerTurnManager terminal recovery", () => {
  it("settles an errored rich turn on idle and drains the next queued turn", async () => {
    const client = new FakeClient();
    let starts = 0;
    client.request.mockImplementation(async (
      method: string, _params: unknown, options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        starts += 1;
        options?.onWritten?.();
        return { turn: { id: `turn-${starts}`, status: "inProgress" } };
      }
      if (method === "thread/read") return { thread: { turns: [{
        id: "turn-1", status: "failed", error: { message: "server overloaded" }, items: [],
      }] } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1, { now: () => 1_800_000_000_123 });
    manager.trackThread("thread-1", "idle");
    const firstCallbacks = callbacks();
    const secondCallbacks = callbacks();
    const first = manager.runTurn(request(firstCallbacks, true));
    await vi.waitFor(() => expect(firstCallbacks.onStarted).toHaveBeenCalledWith("turn-1"));
    const second = manager.runTurn(request(secondCallbacks));

    emitError(client, "turn-1");
    emitIdle(client);

    await expect(first).rejects.toThrow("server overloaded");
    expect(firstCallbacks.onTurnOutcome).toHaveBeenCalledWith({
      status: "failed", eventAt: 1_800_000_000_123,
    });
    await vi.waitFor(() => expect(secondCallbacks.onStarted).toHaveBeenCalledWith("turn-2"));
    client.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-2", status: "completed" },
    } });
    await second;
    expect(client.request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(1);
  });

  it("reconciles when idle arrives before the exact error and settles only once", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string, _params: unknown, options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        return { turn: { id: "turn-race", status: "inProgress" } };
      }
      if (method === "thread/read") return { thread: { turns: [{
        id: "turn-race", status: "interrupted", error: { message: "interrupted" }, items: [],
      }] } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1, { now: () => 1_800_000_000_456 });
    manager.trackThread("thread-1", "idle");
    const observed = callbacks();
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-race"));

    emitIdle(client);
    emitError(client, "turn-race");

    await expect(completion).rejects.toThrow("interrupted");
    client.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-race", status: "interrupted" },
    } });
    expect(observed.onTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it("lets a late completion win while the terminal read is in flight", async () => {
    const client = new FakeClient();
    let releaseRead!: (value: unknown) => void;
    const read = new Promise<unknown>((resolve) => { releaseRead = resolve; });
    client.request.mockImplementation(async (
      method: string, _params: unknown, options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        return { turn: { id: "turn-late", status: "inProgress" } };
      }
      if (method === "thread/read") return read;
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1, { now: () => 1_800_000_000_789 });
    manager.trackThread("thread-1", "idle");
    const observed = callbacks();
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-late"));
    emitError(client, "turn-late");
    emitIdle(client);
    await vi.waitFor(() => expect(client.request.mock.calls.some(([method]) => method === "thread/read")).toBe(true));

    client.emit({ method: "turn/completed", emittedAtMs: 1_800_000_000_800, params: {
      threadId: "thread-1", turn: { id: "turn-late", status: "completed" },
    } });
    await completion;
    releaseRead({ thread: { turns: [{ id: "turn-late", status: "failed", items: [] }] } });
    await Promise.resolve();

    expect(observed.onTurnOutcome).toHaveBeenCalledTimes(1);
    expect(observed.onTurnOutcome).toHaveBeenCalledWith({
      status: "completed", eventAt: 1_800_000_000_800,
    });
  });
});
