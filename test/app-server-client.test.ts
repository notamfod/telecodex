import { vi } from "vitest";

const socketState = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const instances: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly sent: string[] = [];
    readonly sendCallbacks: Array<(error?: Error) => void> = [];
    readyState = 0;
    deferClose = false;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(readonly url: string) {
      instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    removeAllListeners(event: string): this {
      this.listeners.delete(event);
      return this;
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    send(data: string, callback?: (error?: Error) => void): void {
      this.sent.push(data);
      if (callback) this.sendCallbacks.push(callback);
    }

    completeSend(index: number, error?: Error): void {
      this.sendCallbacks[index]?.(error);
    }

    receive(message: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(message)));
    }

    close(): void {
      if (this.deferClose) {
        this.readyState = 2;
        return;
      }
      this.finishClose();
    }

    finishClose(): void {
      this.readyState = 3;
      this.emit("close");
    }

    error(error: Error): void {
      this.emit("error", error);
    }

    private emit(event: string, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }
  }

  return { instances, FakeWebSocket };
});

vi.mock("ws", () => ({
  default: socketState.FakeWebSocket,
}));

import { AppServerClient, AppServerRequestError } from "../src/app-server-client.js";

describe("AppServerClient", () => {
  beforeEach(() => {
    socketState.instances.length = 0;
  });

  it("connects to the shared control socket and performs the initialize handshake", async () => {
    const client = new AppServerClient("/root/.codex/app-server-control/app-server-control.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;

    expect(socket.url).toBe(
      "ws+unix:///root/.codex/app-server-control/app-server-control.sock:/rpc",
    );

    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "telecodex",
          title: "TeleCodex",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });

    socket.receive({ id: 1, result: { userAgent: "codex/0.147.0" } });
    await connecting;

    expect(JSON.parse(socket.sent[1]!)).toEqual({ method: "initialized", params: {} });
    client.close();
  });

  it("routes request responses and server notifications", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;

    const notifications: unknown[] = [];
    client.onNotification((notification) => notifications.push(notification));

    const responsePromise = client.request<{ thread: { id: string } }>("thread/read", {
      threadId: "thread-1",
      includeTurns: false,
    });
    const request = JSON.parse(socket.sent[2]!);
    expect(request).toEqual({
      method: "thread/read",
      id: 2,
      params: { threadId: "thread-1", includeTurns: false },
    });

    socket.receive({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    });
    socket.receive({ id: 2, result: { thread: { id: "thread-1" } } });

    await expect(responsePromise).resolves.toEqual({ thread: { id: "thread-1" } });
    expect(notifications).toEqual([
      {
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "idle" } },
      },
    ]);
    client.close();
  });

  it("notifies subscribed listeners when the app-server connection closes", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;

    const listener = vi.fn();
    const removedListener = vi.fn();
    client.onDisconnect(listener);
    const unsubscribe = client.onDisconnect(removedListener);
    unsubscribe();

    socket.close();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(removedListener).not.toHaveBeenCalled();
  });

  it("does not let synchronous disconnect reentrancy clobber the replacement socket", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;
    let replacement!: Promise<void>;
    client.onDisconnect(() => {
      replacement = client.connect();
    });

    client.close();

    expect(socketState.instances).toHaveLength(2);
    expect(client.connect()).toBe(replacement);
    const current = socketState.instances[1]!;
    current.open();
    current.receive({ id: 2, result: {} });
    await replacement;
    client.close();
  });

  it("isolates disconnect listeners so teardown and later listeners still run", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;
    const laterListener = vi.fn();
    client.onDisconnect(() => {
      throw new Error("listener failure");
    });
    client.onDisconnect(laterListener);

    expect(() => client.close()).not.toThrow();

    expect(socket.readyState).toBe(3);
    expect(laterListener).toHaveBeenCalledTimes(1);
  });

  it("handles an established socket error by closing and notifying disconnect listeners", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;

    const listener = vi.fn();
    client.onDisconnect(listener);

    socket.error(new Error("socket reset"));

    expect(socket.readyState).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale socket error disrupt a newer connection attempt", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const staleSocket = socketState.instances[0]!;
    staleSocket.open();
    staleSocket.receive({ id: 1, result: {} });
    await connecting;
    staleSocket.close();

    const reconnecting = client.connect();
    expect(socketState.instances).toHaveLength(2);

    staleSocket.error(new Error("late stale error"));

    expect(client.connect()).toBe(reconnecting);
    expect(socketState.instances).toHaveLength(2);

    const currentSocket = socketState.instances[1]!;
    currentSocket.open();
    currentSocket.receive({ id: 2, result: {} });
    await reconnecting;
    client.close();
  });

  it("allows reconnect immediately after an initialization socket error", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const failedSocket = socketState.instances[0]!;
    failedSocket.deferClose = true;
    failedSocket.open();

    failedSocket.error(new Error("initialize transport failed"));

    await expect(connecting).rejects.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
    const reconnecting = client.connect();
    expect(socketState.instances).toHaveLength(2);

    failedSocket.receive({ id: 1, result: {} });
    expect(failedSocket.sent).toHaveLength(1);

    failedSocket.finishClose();
    expect(client.connect()).toBe(reconnecting);
    expect(socketState.instances).toHaveLength(2);
    const currentSocket = socketState.instances[1]!;
    currentSocket.open();
    currentSocket.receive({ id: 2, result: {} });
    await reconnecting;
    client.close();
  });

  it("rejects a connection when the socket closes cleanly during initialization", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const failedSocket = socketState.instances[0]!;
    failedSocket.open();

    failedSocket.finishClose();

    const outcome = await Promise.race([
      connecting.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ]);
    expect(outcome).toBeInstanceOf(Error);

    const reconnecting = client.connect();
    const currentSocket = socketState.instances[1]!;
    currentSocket.open();
    currentSocket.receive({ id: 2, result: {} });
    await reconnecting;
    client.close();
  });

  it("cleans up an initialize RPC error before allowing reconnect", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const failedSocket = socketState.instances[0]!;
    failedSocket.open();

    failedSocket.receive({
      id: 1,
      error: { code: -32600, message: "initialize rejected" },
    });

    await expect(connecting).rejects.toMatchObject({ code: "APP_SERVER_REJECTED" });
    expect(failedSocket.readyState).toBe(3);

    const reconnecting = client.connect();
    const currentSocket = socketState.instances[1]!;
    currentSocket.open();
    currentSocket.receive({ id: 2, result: {} });
    await reconnecting;
    client.close();
  });

  it("detaches a rejected initialize before the old close event", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const failed = socketState.instances[0]!;
    failed.deferClose = true;
    failed.open();
    failed.receive({ id: 1, error: { code: -32600, message: "rejected" } });

    await expect(connecting).rejects.toMatchObject({ code: "APP_SERVER_REJECTED" });
    const replacement = client.connect();
    expect(socketState.instances).toHaveLength(2);
    failed.finishClose();
    expect(client.connect()).toBe(replacement);
    const current = socketState.instances[1]!;
    current.open();
    current.receive({ id: 2, result: {} });
    await replacement;
    client.close();
  });

  it("detaches a connection deadline before the old close event", async () => {
    vi.useFakeTimers();
    try {
      const client = new AppServerClient("/tmp/codex.sock");
      const outcome = client.connect().catch((error: unknown) => error);
      const failed = socketState.instances[0]!;
      failed.deferClose = true;
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });
      expect(vi.getTimerCount()).toBe(0);

      const replacement = client.connect();
      failed.finishClose();
      expect(client.connect()).toBe(replacement);
      const current = socketState.instances[1]!;
      current.open();
      current.receive({ id: 1, result: {} });
      await replacement;
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses configured connect and request deadlines", async () => {
    vi.useFakeTimers();
    try {
      const connectingClient = new AppServerClient("/tmp/codex.sock", { connectMs: 7 });
      const connection = connectingClient.connect().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(7);
      await expect(connection).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });

      const client = new AppServerClient("/tmp/codex.sock", { requestMs: 11, turnStartMs: 13 });
      const connecting = client.connect();
      const socket = socketState.instances.at(-1)!;
      socket.open();
      socket.receive({ id: 1, result: {} });
      await connecting;
      const request = client.request("thread/read", { threadId: "thread-1" }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(11);
      await expect(request).resolves.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a JSON-RPC error as a proven safe rejection", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;

    const responsePromise = client.request("turn/start", { threadId: "thread-1", input: [] });
    const request = JSON.parse(socket.sent[2]!);
    socket.receive({ id: request.id, error: { code: -32600, message: "thread busy" } });

    const error = await responsePromise.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppServerRequestError);
    expect(error).toMatchObject({
      code: "APP_SERVER_REJECTED",
      rpcCode: -32600,
      reason: "THREAD_BUSY",
    });
    expect((error as Error).message).not.toContain("thread busy");
    client.close();
  });

  it("lets a received result win over reentrant close from onWritten", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;
    const onWritten = vi.fn(() => client.close());
    const response = client.request("thread/read", {}, { onWritten });
    const id = JSON.parse(socket.sent[2]!).id;

    socket.receive({ id, result: { ok: true } });

    await expect(response).resolves.toEqual({ ok: true });
    socket.completeSend(1);
    expect(onWritten).toHaveBeenCalledTimes(1);
  });

  it("lets a received rejection win over reentrant close from onWritten", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;
    const onWritten = vi.fn(() => client.close());
    const response = client.request("turn/start", {}, { onWritten });
    const id = JSON.parse(socket.sent[2]!).id;

    socket.receive({ id, error: { code: -32600, message: "thread busy" } });

    await expect(response).rejects.toMatchObject({ code: "APP_SERVER_REJECTED" });
    socket.completeSend(1);
    expect(onWritten).toHaveBeenCalledTimes(1);
  });
});
