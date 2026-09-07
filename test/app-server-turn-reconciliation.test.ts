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

  emit(notification: AppServerNotification): void {
    this.notification?.(notification);
  }
}

function callbacks(): AppServerTurnCallbacks {
  return {
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

function complete(client: FakeClient, turnId: string): void {
  client.emit({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
  });
}

describe("AppServerTurnManager start reconciliation", () => {
  it("does not replay a pre-existing turn when the pre-dispatch baseline was unknown", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        throw new Error("App-server connection closed");
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            turns: [{ id: "turn-pre-existing", status: "completed", items: [] }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "idle");

    await expect(manager.runTurn(request(observed))).rejects.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(observed.onStarted).not.toHaveBeenCalled();
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "thread/resume",
      "thread/read",
    ]);
  });

  it("discovers the exact turn created after the stable baseline and replays its result", async () => {
    const client = new FakeClient();
    let starts = 0;
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        starts += 1;
        options?.onWritten?.();
        if (starts === 1) return { turn: { id: "turn-before", status: "inProgress" } };
        if (starts === 3) return { turn: { id: "turn-after-replay", status: "inProgress" } };
        throw new Error("App-server connection closed");
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            turns: [
              { id: "turn-before", status: "completed", items: [] },
              {
                id: "turn-discovered",
                status: "completed",
                items: [{ id: "answer", type: "agentMessage", text: "Recovered answer" }],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle", null);

    const beforeCallbacks = callbacks();
    const before = manager.runTurn(request(beforeCallbacks));
    await vi.waitFor(() => expect(beforeCallbacks.onStarted).toHaveBeenCalledWith("turn-before"));
    complete(client, "turn-before");
    await before;

    const recovered = callbacks();
    await expect(manager.runTurn(request(recovered))).resolves.toBeUndefined();
    expect(recovered.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-before",
      attempt: 1,
    });
    expect(recovered.onStarted).toHaveBeenCalledWith("turn-discovered");
    expect(recovered.onTextDelta).toHaveBeenCalledWith("Recovered answer");
    expect(recovered.onAgentEnd).toHaveBeenCalledOnce();

    const next = callbacks();
    const nextCompletion = manager.runTurn(request(next));
    await vi.waitFor(() => expect(next.onStarted).toHaveBeenCalledWith("turn-after-replay"));
    complete(client, "turn-after-replay");
    await nextCompletion;
  });

  it("cleans reconciliation state when a replay callback throws", async () => {
    const client = new FakeClient();
    let starts = 0;
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        starts += 1;
        options?.onWritten?.();
        if (starts === 2) return { turn: { id: "turn-after-error", status: "inProgress" } };
        throw new Error("App-server connection closed");
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            turns: [{
              id: "turn-replayed",
              status: "completed",
              items: [{ id: "answer", type: "agentMessage", text: "Recovered answer" }],
            }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle", null);
    const throwing = callbacks();
    throwing.onTextDelta = vi.fn(() => { throw new Error("replay observer"); });

    await expect(manager.runTurn(request(throwing))).rejects.toThrow("replay observer");
    const next = callbacks();
    const completion = manager.runTurn(request(next));
    await vi.waitFor(() => expect(next.onStarted).toHaveBeenCalledWith("turn-after-error"));
    complete(client, "turn-after-error");
    await completion;
  });

  it.each([
    [],
    [
      { id: "turn-a", status: "inProgress" },
      { id: "turn-b", status: "inProgress" },
    ],
  ])("keeps zero or multiple new turns ambiguous: %#", async (turns) => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "turn/start") {
        options?.onWritten?.();
        throw new Error("App-server connection closed");
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "active" }, turns: [] } };
      }
      if (method === "thread/read") return { thread: { turns } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle");

    await expect(manager.runTurn(request(callbacks()))).rejects.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("does not emit dispatch facts while reattaching a known recovered turn", async () => {
    const client = new FakeClient();
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    manager.trackThread("thread-1", "active");

    const completion = manager.recoverTurn(request(observed), "turn-existing");
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-existing"));
    expect(observed.onDispatching).not.toHaveBeenCalled();
    expect(observed.onDispatchWritten).not.toHaveBeenCalled();
    complete(client, "turn-existing");
    await completion;
  });

  it("settles active recovery when onStarted disposes the manager reentrantly", async () => {
    const client = new FakeClient();
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    observed.onStarted = vi.fn(() => manager.dispose());
    manager.trackThread("thread-1", "active", "turn-existing");

    const completion = manager.recoverTurn(request(observed), "turn-existing");
    const outcome = await Promise.race([
      completion.then(() => "resolved", (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(outcome).toMatchObject({ message: expect.stringMatching(/disposed/i) });
  });

  it("interrupts active recovery when onStarted cancels reentrantly", async () => {
    const client = new FakeClient();
    client.request.mockResolvedValue({});
    const manager = new AppServerTurnManager(client);
    const observed = callbacks();
    observed.onStarted = vi.fn(() => {
      void manager.cancelTurn("thread-1", observed);
    });
    manager.trackThread("thread-1", "active", "turn-existing");

    const completion = manager.recoverTurn(request(observed), "turn-existing");
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-existing"));
    expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-existing",
    });

    complete(client, "turn-existing");
    await completion;
  });

  it("does not regress the latest server turn when replaying an older recovered turn", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "thread/read") {
        return {
          thread: {
            turns: [
              { id: "turn-old", status: "completed", items: [] },
              { id: "turn-latest", status: "completed", items: [] },
            ],
          },
        };
      }
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-next", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle", "turn-latest");

    await manager.recoverTurn(request(callbacks()), "turn-old");
    const observed = callbacks();
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-next"));
    expect(observed.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-latest",
      attempt: 1,
    });

    complete(client, "turn-next");
    await completion;
  });

  it("derives the latest baseline from replay history when no identity was known", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      if (method === "thread/read") {
        return {
          thread: {
            turns: [
              { id: "turn-recovered", status: "completed", items: [] },
              { id: "turn-newer", status: "completed", items: [] },
            ],
          },
        };
      }
      if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
      options?.onWritten?.();
      return { turn: { id: "turn-next", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle");

    await manager.recoverTurn(request(callbacks()), "turn-recovered");
    const observed = callbacks();
    const completion = manager.runTurn(request(observed));
    await vi.waitFor(() => expect(observed.onStarted).toHaveBeenCalledWith("turn-next"));
    expect(observed.onDispatching).toHaveBeenCalledWith({
      previousTurnId: "turn-newer",
      attempt: 1,
    });

    complete(client, "turn-next");
    await completion;
  });
});
