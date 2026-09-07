import { vi } from "vitest";

import {
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

type ObservedCallbacks = AppServerTurnCallbacks & {
  onStarted: ReturnType<typeof vi.fn>;
  onActivity: ReturnType<typeof vi.fn>;
  onTextDelta: ReturnType<typeof vi.fn>;
  onAgentEnd: ReturnType<typeof vi.fn>;
};

function callbacks(): ObservedCallbacks {
  return {
    onStarted: vi.fn(),
    onActivity: vi.fn(),
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

function bufferAnswer(client: FakeClient, turnId: string, completed: boolean): void {
  client.emit("turn/started", {
    threadId: "thread-1",
    turn: { id: turnId, status: "inProgress" },
  });
  client.emit("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId,
    itemId: "answer",
    delta: "Buffered answer",
  });
  if (completed) {
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: turnId, status: "completed" },
    });
  }
}

describe("AppServerTurnManager lost acknowledgement correlation", () => {
  it("confirms and flushes buffered activity when reconciliation finds the active turn", async () => {
    const client = new FakeClient();
    let rejectStart!: (error: Error) => void;
    client.request.mockImplementation((
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      }
      if (method === "thread/resume") {
        return Promise.resolve({ thread: { id: "thread-1", status: { type: "active" } } });
      }
      if (method === "thread/read") {
        return Promise.resolve({ thread: { turns: [{ id: "turn-own", status: "inProgress" }] } });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", null);
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything(),
    ));

    bufferAnswer(client, "turn-own", false);
    rejectStart(new Error("App-server connection closed"));
    await vi.waitFor(() => expect(observed.onTextDelta).toHaveBeenCalledWith("Buffered answer"));
    expect(observed.onStarted).toHaveBeenCalledWith("turn-own");
    expect(observed.onActivity.mock.calls.map(([event]) => event.method)).toEqual([
      "turn/started",
      "item/agentMessage/delta",
    ]);

    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-own", status: "completed" },
    });
    await completion;
  });

  it("flushes a buffered terminal result once without replay duplicates", async () => {
    const client = new FakeClient();
    let rejectStart!: (error: Error) => void;
    client.request.mockImplementation((method: string, _params: unknown, options?: AppServerRequestOptions) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      }
      if (method === "thread/resume") {
        return Promise.resolve({ thread: { id: "thread-1", status: { type: "idle" } } });
      }
      if (method === "thread/read") {
        return Promise.resolve({
          thread: {
            turns: [{
              id: "turn-own",
              status: "completed",
              items: [{ id: "answer", type: "agentMessage", text: "Full stored answer" }],
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", null);
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything(),
    ));

    bufferAnswer(client, "turn-own", true);
    rejectStart(new Error("App-server connection closed"));
    await completion;

    expect(observed.onStarted).toHaveBeenCalledOnce();
    expect(observed.onTextDelta).toHaveBeenCalledOnce();
    expect(observed.onTextDelta).toHaveBeenCalledWith("Full stored answer");
    expect(observed.onTextDelta).not.toHaveBeenCalledWith("Buffered answer");
    expect(observed.onAgentEnd).toHaveBeenCalledOnce();
    expect(observed.onActivity).not.toHaveBeenCalled();
  });

  it("keeps a mismatched provisional turn sticky unknown during reconciliation", async () => {
    const client = new FakeClient();
    let rejectStart!: (error: Error) => void;
    client.request.mockImplementation((method: string, _params: unknown, options?: AppServerRequestOptions) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      }
      if (method === "thread/resume") {
        return Promise.resolve({ thread: { id: "thread-1", status: { type: "idle" } } });
      }
      if (method === "thread/read") {
        return Promise.resolve({
          thread: { turns: [{ id: "turn-other", status: "completed", items: [] }] },
        });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle", null);
    const outcome = manager.runTurn(request(observed)).catch((error: unknown) => error);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything(),
    ));

    bufferAnswer(client, "turn-candidate", false);
    rejectStart(new Error("App-server connection closed"));

    await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
    expect(observed.onStarted).not.toHaveBeenCalled();
    expect(observed.onTextDelta).not.toHaveBeenCalled();
    expect(client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("does not replay a terminal turn after onStarted disposes the manager", async () => {
    const client = new FakeClient();
    let rejectStart!: (error: Error) => void;
    client.request.mockImplementation((method: string, _params: unknown, options?: AppServerRequestOptions) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      }
      if (method === "thread/resume") {
        return Promise.resolve({ thread: { id: "thread-1", status: { type: "idle" } } });
      }
      if (method === "thread/read") {
        return Promise.resolve({
          thread: {
            turns: [{
              id: "turn-own",
              status: "completed",
              items: [{ id: "answer", type: "agentMessage", text: "Stored answer" }],
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    observed.onStarted.mockImplementation(() => manager.dispose());
    manager.trackThread("thread-1", "idle", null);
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything(),
    ));

    rejectStart(new Error("App-server connection closed"));

    await expect(completion).rejects.toThrow("disposed");
    expect(observed.onTextDelta).not.toHaveBeenCalled();
    expect(observed.onAgentEnd).not.toHaveBeenCalled();
  });
});
