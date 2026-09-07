import { vi } from "vitest";

const socketState = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const instances: FakeWebSocket[] = [];
  const control: { constructError?: Error } = {};

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly sent: string[] = [];
    readonly sendCallbacks: Array<(error?: Error) => void> = [];
    readyState = 0;
    deferClose = false;
    deferSendCallbacks = false;
    throwOnClose?: Error;
    throwOnSend?: Error;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(readonly url: string) {
      if (control.constructError) throw control.constructError;
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
      if (this.throwOnSend) {
        const error = this.throwOnSend;
        this.throwOnSend = undefined;
        throw error;
      }
      this.sent.push(data);
      if (!callback) return;
      this.sendCallbacks.push(callback);
      if (!this.deferSendCallbacks) callback();
    }

    completeSend(index: number, error?: Error): void {
      this.sendCallbacks[index]?.(error);
    }

    receive(message: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(message)));
    }

    close(): void {
      if (this.throwOnClose) throw this.throwOnClose;
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
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  return { instances, FakeWebSocket, control };
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

describe("AppServerClient deadlines and write evidence", () => {
  beforeEach(() => {
    socketState.instances.length = 0;
    socketState.control.constructError = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds connection establishment to ten seconds", async () => {
    vi.useFakeTimers();
    const client = new AppServerClient("/tmp/codex.sock");
    const outcome = client.connect().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leak a close throw from the connection deadline", async () => {
    vi.useFakeTimers();
    const client = new AppServerClient("/tmp/codex.sock");
    const outcome = client.connect().catch((error: unknown) => error);
    socketState.instances[0]!.throwOnClose = new Error("secret close failure");

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds initialize and classifies its in-flight timeout conservatively", async () => {
    vi.useFakeTimers();
    const client = new AppServerClient("/tmp/codex.sock");
    const outcome = client.connect().catch((error: unknown) => error);
    socketState.instances[0]!.open();

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an outer turn/start not-sent when only initialize was ambiguous", async () => {
    vi.useFakeTimers();
    const client = new AppServerClient("/tmp/codex.sock");
    const outcome = client.request("turn/start", {}).catch((error: unknown) => error);
    const socket = socketState.instances[0]!;
    socket.open();

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });
    expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual(["initialize"]);
  });

  it("times out ordinary requests at fifteen seconds and ignores late responses", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    const request = client.request("thread/read", {});
    const outcome = request.catch((error: unknown) => error);
    const lateId = JSON.parse(socket.sent[2]!).id;

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    socket.receive({ id: lateId, result: { late: true } });

    const current = client.request("thread/read", {});
    const currentId = JSON.parse(socket.sent[3]!).id;
    socket.receive({ id: currentId, result: { current: true } });
    await expect(current).resolves.toEqual({ current: true });
    client.close();
  });

  it("allows thirty seconds for turn/start acceptance", async () => {
    vi.useFakeTimers();
    const { client } = await connectedClient();
    const request = client.request("turn/start", {});
    const outcome = request.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    client.close();
  });

  it("does not claim not-sent after send returned without a callback", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    socket.deferSendCallbacks = true;
    const onWritten = vi.fn();
    const outcome = client.request("turn/start", {}, { timeoutMs: 25, onWritten }).catch(
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(25);

    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(onWritten).not.toHaveBeenCalled();
    client.close();
  });

  it("treats an asynchronous send callback error as unknown acceptance", async () => {
    const { client, socket } = await connectedClient();
    socket.deferSendCallbacks = true;
    const onWritten = vi.fn();
    const outcome = client.request("turn/start", {}, { onWritten }).catch(
      (error: unknown) => error,
    );
    socket.completeSend(1, new Error("secret bytes"));

    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(onWritten).not.toHaveBeenCalled();
    client.close();
  });

  it("reports a synchronous send throw as definitely not sent", async () => {
    const { client, socket } = await connectedClient();
    socket.throwOnSend = new Error("secret request");

    const error = await client.request("thread/read", { secret: true }).catch(
      (value: unknown) => value,
    );

    expect(error).toMatchObject({ code: "APP_SERVER_NOT_SENT" });
    expect((error as Error).message).not.toContain("secret");
    client.close();
  });

  it("classifies in-flight and written requests independently when the socket closes", async () => {
    const { client, socket } = await connectedClient();
    socket.deferSendCallbacks = true;
    const written = client.request("turn/start", {});
    socket.completeSend(1);
    const inFlight = client.request("thread/read", {});
    socket.close();

    await expect(written).rejects.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
    await expect(inFlight).rejects.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
  });

  it("uses response arrival as write proof and ignores a late callback", async () => {
    const { client, socket } = await connectedClient();
    socket.deferSendCallbacks = true;
    const onWritten = vi.fn();
    const response = client.request("thread/read", {}, { onWritten });
    const id = JSON.parse(socket.sent[2]!).id;

    socket.receive({ id, result: { ok: true } });
    await expect(response).resolves.toEqual({ ok: true });
    expect(onWritten).toHaveBeenCalledTimes(1);
    socket.completeSend(1);
    expect(onWritten).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("uses bounded server diagnostics to detect a half-open transport", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    const outcome = client.checkConnectivity(50).catch((error: unknown) => error);
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({ method: "server/diagnostics" });

    await vi.advanceTimersByTimeAsync(50);

    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    client.close();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid timeout %s before send",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const { client, socket } = await connectedClient();
      const sentBefore = socket.sent.length;

      const outcome = client.request("thread/read", {}, { timeoutMs }).catch(
        (error: unknown) => error,
      );

      await expect(outcome).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });
      expect(socket.sent).toHaveLength(sentBefore);
      expect(vi.getTimerCount()).toBe(0);
      client.close();
    },
  );

  it("keeps malformed server errors inside the safe typed boundary", async () => {
    const { client, socket } = await connectedClient();
    const response = client.request("thread/read", {});
    const id = JSON.parse(socket.sent[2]!).id;
    socket.receive({ id, error: { code: "secret", message: { prompt: "secret" } } });

    const error = await response.catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
    expect((error as Error).message).not.toContain("secret");
    client.close();
  });

  it("uses error-field presence so null errors cannot masquerade as success", async () => {
    const { client, socket } = await connectedClient();
    const response = client.request("thread/read", {});
    const id = JSON.parse(socket.sent[2]!).id;
    socket.receive({ id, error: null });

    await expect(response).rejects.toMatchObject({ code: "APP_SERVER_ACCEPTANCE_UNKNOWN" });
    client.close();
  });

  it("classifies construction failure and permits a clean retry", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    socketState.control.constructError = new Error("secret socket path");
    const error = await client.connect().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "APP_SERVER_NOT_SENT" });
    expect((error as Error).message).not.toContain("secret");

    socketState.control.constructError = undefined;
    const reconnecting = client.connect();
    const socket = socketState.instances[0]!;
    socket.open();
    socket.receive({ id: 1, result: {} });
    await reconnecting;
    client.close();
  });

  it("clears initialization and request timers during shutdown", async () => {
    vi.useFakeTimers();
    const client = new AppServerClient("/tmp/codex.sock");
    const outcome = client.connect().catch((error: unknown) => error);
    const socket = socketState.instances[0]!;
    socket.deferClose = true;
    socket.open();

    client.close();

    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(vi.getTimerCount()).toBe(0);
    socket.finishClose();
  });

  it("notifies disconnect exactly once when shutdown precedes the close event", async () => {
    const { client, socket } = await connectedClient();
    const listener = vi.fn();
    client.onDisconnect(listener);
    socket.deferClose = true;

    client.close();
    expect(listener).toHaveBeenCalledTimes(1);

    socket.finishClose();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tears down an established socket immediately on error without waiting for close", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    socket.deferClose = true;
    socket.deferSendCallbacks = true;
    const listener = vi.fn();
    client.onDisconnect(listener);

    const written = client.request("turn/start", {});
    const writtenOutcome = written.catch((error: unknown) => error);
    socket.completeSend(1);
    const inFlight = client.request("thread/read", {});
    const inFlightOutcome = inFlight.catch((error: unknown) => error);
    const lateId = JSON.parse(socket.sent[2]!).id;

    socket.error(new Error("secret transport failure"));

    await expect(writtenOutcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    await expect(inFlightOutcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);

    socket.receive({ id: lateId, result: { late: true } });
    socket.finishClose();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("settles initialization immediately when error has no close event", async () => {
    vi.useFakeTimers();
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const outcome = connecting.catch((error: unknown) => error);
    const socket = socketState.instances[0]!;
    const listener = vi.fn();
    client.onDisconnect(listener);
    socket.deferClose = true;
    socket.open();

    socket.error(new Error("secret initialize failure"));

    await expect(outcome).resolves.toMatchObject({
      code: "APP_SERVER_ACCEPTANCE_UNKNOWN",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    socket.receive({ id: 1, result: {} });
    socket.finishClose();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("settles unopened connect and its business request immediately on close", async () => {
    vi.useFakeTimers();
    const client = new AppServerClient("/tmp/codex.sock");
    const connecting = client.connect();
    const connectOutcome = connecting.catch((error: unknown) => error);
    const requestOutcome = client.request("turn/start", {}).catch((error: unknown) => error);
    const socket = socketState.instances[0]!;
    const listener = vi.fn();
    client.onDisconnect(listener);
    socket.deferClose = true;

    client.close();

    await Promise.resolve();
    await expect(connectOutcome).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });
    await expect(requestOutcome).resolves.toMatchObject({ code: "APP_SERVER_NOT_SENT" });
    expect(vi.getTimerCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("never lets a stale open initialize through the replacement socket", async () => {
    const client = new AppServerClient("/tmp/codex.sock");
    const staleOutcome = client.connect().catch((error: unknown) => error);
    const stale = socketState.instances[0]!;
    stale.deferClose = true;
    client.close();

    const reconnecting = client.connect();
    const current = socketState.instances[1]!;
    current.open();
    current.receive({ id: 1, result: {} });
    await reconnecting;
    const currentFrames = [...current.sent];

    stale.open();

    expect(stale.sent).toEqual([]);
    expect(current.sent).toEqual(currentFrames);
    stale.finishClose();
    await staleOutcome;
    client.close();
  });
});
