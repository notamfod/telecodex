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

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    send(data: string): void {
      this.sent.push(data);
    }

    receive(message: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(message)));
    }

    close(): void {
      this.readyState = 3;
      this.emit("close");
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

import { AppServerClient } from "../src/app-server-client.js";

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

  it("rejects a JSON-RPC request when the server returns an error", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await connecting;

    const responsePromise = client.request("turn/start", { threadId: "thread-1", input: [] });
    const request = JSON.parse(socket.sent[2]!);
    socket.receive({ id: request.id, error: { code: -32600, message: "thread busy" } });

    await expect(responsePromise).rejects.toThrow("thread busy (code -32600)");
    client.close();
  });
});
