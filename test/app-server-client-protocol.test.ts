import { vi } from "vitest";

const socketState = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const instances: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly sent: string[] = [];
    readyState = 0;
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

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0;
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    send(data: string, callback?: (error?: Error) => void): void {
      this.sent.push(data);
      callback?.();
    }

    receive(message: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(message)));
    }

    close(): void {
      this.readyState = 3;
      this.emit("close");
    }

    emitLate(event: string, ...args: unknown[]): void {
      this.emit(event, ...args);
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  return { instances, FakeWebSocket };
});

vi.mock("ws", () => ({ default: socketState.FakeWebSocket }));

import { AppServerClient } from "../src/app-server-client.js";

async function connectedClient(): Promise<{
  client: AppServerClient;
  socket: InstanceType<typeof socketState.FakeWebSocket>;
}> {
  const client = new AppServerClient("/tmp/codex.sock");
  const connecting = client.connect();
  const socket = socketState.instances[0]!;
  socket.open();
  socket.receive({ id: 1, result: {} });
  await connecting;
  return { client, socket };
}

describe("AppServerClient JSON-RPC response boundary", () => {
  beforeEach(() => {
    socketState.instances.length = 0;
  });

  it.each([
    { id: 2 },
    { id: 2, result: {}, error: { code: -32600, message: "rejected" } },
    { id: 2, error: null },
    { id: 2, error: [] },
    { id: 2, error: { code: "-32600", message: "rejected" } },
    { id: 2, error: { code: -32600, message: 42 } },
    { id: 2, error: { code: Number.MAX_SAFE_INTEGER + 1, message: "rejected" } },
  ])("treats malformed response envelope as unknown acceptance: %#", async (envelope) => {
    const { client, socket } = await connectedClient();
    const response = client.request("thread/read", {});

    socket.receive(envelope);

    await expect(response).rejects.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    client.close();
  });

  it("accepts a valid result envelope", async () => {
    const { client, socket } = await connectedClient();
    const response = client.request("thread/read", {});

    socket.receive({ id: 2, result: null });

    await expect(response).resolves.toBeNull();
    client.close();
  });

  it("runs the blocking durability barrier before WebSocket.send", async () => {
    const { client, socket } = await connectedClient();
    const order: string[] = [];
    const response = client.request("turn/start", {}, {
      beforeSend: () => order.push(`barrier:${socket.sent.length}`),
      onWritten: () => order.push(`written:${socket.sent.length}`),
    });

    expect(order).toEqual(["barrier:2", "written:3"]);
    socket.receive({ id: 2, result: { turn: { id: "turn-1", status: "inProgress" } } });
    await expect(response).resolves.toMatchObject({ turn: { id: "turn-1" } });
    client.close();
  });

  it("propagates a durability barrier failure with zero request frames", async () => {
    const { client, socket } = await connectedClient();
    const frames = [...socket.sent];
    const onWritten = vi.fn();
    const barrierError = new Error("ledger unavailable");

    const response = client.request("turn/start", {}, {
      beforeSend: () => { throw barrierError; },
      onWritten,
    });

    await expect(response).rejects.toBe(barrierError);
    expect(socket.sent).toEqual(frames);
    expect(onWritten).not.toHaveBeenCalled();
    client.close();
  });

  it("classifies a well-formed server error as a proven rejection", async () => {
    const { client, socket } = await connectedClient();
    const response = client.request("thread/read", {});

    socket.receive({ id: 2, error: { code: -32600, message: "thread not found: t" } });

    await expect(response).rejects.toMatchObject({
      code: "APP_SERVER_REJECTED",
      rpcCode: -32600,
      reason: "THREAD_NOT_FOUND",
    });
    client.close();
  });

  it.each(["", null, false, 0])(
    "rejects a correlated envelope with own method=%j as unknown acceptance",
    async (method) => {
      const { client, socket } = await connectedClient();
      const response = client.request("thread/read", {});

      socket.receive({ id: 2, method, result: { unsafe: true } });

      await expect(response).rejects.toMatchObject({
        code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
      });
      client.close();
    },
  );

  it("delivers only notifications with a non-empty string method", async () => {
    const { client, socket } = await connectedClient();
    const listener = vi.fn();
    client.onNotification(listener);

    for (const method of ["", null, false, 0, 1, {}, []]) {
      socket.receive({ method, params: { unsafe: true } });
    }
    socket.receive({ method: "turn/started", params: { turnId: "turn-1" } });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      method: "turn/started",
      params: { turnId: "turn-1" },
    });
    client.close();
  });

  it("retains an exact top-level server emission timestamp on notifications", async () => {
    const { client, socket } = await connectedClient();
    const listener = vi.fn();
    client.onNotification(listener);

    socket.receive({
      method: "turn/started",
      emittedAtMs: 1_800_000_000_123,
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });

    expect(listener).toHaveBeenCalledWith({
      method: "turn/started",
      emittedAtMs: 1_800_000_000_123,
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    client.close();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "123", null])(
    "drops an invalid server emission timestamp: %j",
    async (emittedAtMs) => {
      const { client, socket } = await connectedClient();
      const listener = vi.fn();
      client.onNotification(listener);

      socket.receive({
        method: "turn/started",
        emittedAtMs,
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      });

      expect(listener).toHaveBeenCalledWith({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      });
      client.close();
    },
  );

  it("detaches generation listeners and ignores every stale socket event", async () => {
    const { client, socket } = await connectedClient();
    const disconnect = vi.fn();
    client.onDisconnect(disconnect);

    client.close();

    expect(socket.listenerCount("message")).toBe(0);
    expect(socket.listenerCount("open")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(1);
    const frames = [...socket.sent];
    expect(() => {
      socket.emitLate("message", Buffer.from(JSON.stringify({ id: 99, result: {} })));
      socket.emitLate("open");
      socket.emitLate("close");
      socket.emitLate("error", new Error("late"));
    }).not.toThrow();
    expect(socket.sent).toEqual(frames);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
