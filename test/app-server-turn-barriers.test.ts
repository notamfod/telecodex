import { vi } from "vitest";

import type { AppServerNotification, AppServerRequestOptions } from "../src/app-server-client.js";
import {
  AppServerTurnManager,
  type AppServerTurnCallbacks,
} from "../src/app-server-turn-manager.js";

class FakeClient {
  readonly request = vi.fn();
  readonly sends: string[] = [];
  private notification?: (notification: AppServerNotification) => void;

  async connect(): Promise<void> {}
  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notification = listener;
    return () => { this.notification = undefined; };
  }
  onDisconnect(): () => void { return () => {}; }
  emit(notification: AppServerNotification): void { this.notification?.(notification); }
}

function callbacks(overrides: Partial<AppServerTurnCallbacks> = {}): AppServerTurnCallbacks {
  return {
    onTextDelta: vi.fn(), onToolStart: vi.fn(), onToolUpdate: vi.fn(), onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
    ...overrides,
  };
}

describe("AppServerTurnManager durable dispatch barriers", () => {
  it("reports the authoritative baseline at the exact send boundary", async () => {
    const client = new FakeClient();
    const order: string[] = [];
    client.request.mockImplementation(async (
      method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      expect(method).toBe("turn/start");
      options?.beforeSend?.();
      order.push("send");
      client.sends.push(method);
      options?.onWritten?.();
      return { turn: { id: "turn-new", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle", "turn-previous");

    const result = manager.runTurn({
      threadId: "thread-1", input: [], cwd: "/workspace", approvalPolicy: "never",
      sandbox: "workspace-write",
      callbacks: callbacks({
        beforeDispatchWrite: (fact) => order.push(`barrier:${JSON.stringify(fact)}`),
        onDispatching: () => order.push("observer"),
      }),
    });
    await vi.waitFor(() => expect(client.sends).toEqual(["turn/start"]));

    expect(order).toEqual([
      "observer",
      'barrier:{"threadId":"thread-1","previousTurnId":"turn-previous","previousTurnKnown":true,"attempt":1}',
      "send",
    ]);
    client.emit({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-new", status: "completed" } },
    });
    await result;
  });

  it("propagates a barrier failure and prevents transport bytes", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (
      _method: string,
      _params: unknown,
      options?: AppServerRequestOptions,
    ) => {
      options?.beforeSend?.();
      client.sends.push("turn/start");
      return { turn: { id: "must-not-start", status: "inProgress" } };
    });
    const manager = new AppServerTurnManager(client);
    manager.trackThread("thread-1", "idle");
    const barrierError = new Error("durable dispatch conflict");

    const result = manager.runTurn({
      threadId: "thread-1", input: [], cwd: "/workspace", approvalPolicy: "never",
      sandbox: "workspace-write",
      callbacks: callbacks({ beforeDispatchWrite: () => { throw barrierError; } }),
    });

    await expect(result).rejects.toBe(barrierError);
    expect(client.sends).toEqual([]);
  });

  it.each(["completed", "interrupted", "failed"])(
    "emits the observed %s outcome with server time before settlement",
    async (status) => {
      const client = new FakeClient();
      client.request.mockImplementation(async (_method, _params, options?: AppServerRequestOptions) => {
        options?.beforeSend?.();
        options?.onWritten?.();
        return { turn: { id: "turn-outcome", status: "inProgress" } };
      });
      const order: string[] = [];
      const onTurnOutcome = vi.fn((fact: { status: string; eventAt: number }) => {
        order.push(`outcome:${fact.status}:${fact.eventAt}`);
      });
      const manager = new AppServerTurnManager(client);
      manager.trackThread("thread-1", "idle");
      const result = manager.runTurn({
        threadId: "thread-1", input: [], cwd: "/workspace", approvalPolicy: "never",
        sandbox: "workspace-write", callbacks: callbacks({ onTurnOutcome }),
      });
      void result.then(() => order.push("resolved"), () => order.push("rejected"));
      await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());

      client.emit({
        method: "turn/completed", emittedAtMs: 1_800_000_000_123,
        params: { threadId: "thread-1", turn: { id: "turn-outcome", status } },
      });

      await vi.waitFor(() => expect(order.length).toBe(2));
      expect(order[0]).toBe(`outcome:${status}:1800000000123`);
      expect(order[1]).toBe(status === "completed" ? "resolved" : "rejected");
    },
  );
});
