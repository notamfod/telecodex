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

function callbacks(): AppServerTurnCallbacks {
  return {
    onStarted: vi.fn(),
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
    onTurnComplete: vi.fn(),
  };
}

function request(observed: AppServerTurnCallbacks, text: string): AppServerTurnRequest {
  return {
    threadId: "thread-1",
    input: [{ type: "text", text, text_elements: [] }],
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    callbacks: observed,
  };
}

describe("AppServerTurnManager completion observers", () => {
  it.each(["onTurnComplete", "onAgentEnd"] as const)(
    "settles and drains when %s throws",
    async (throwingObserver) => {
      const client = new FakeClient();
      let turn = 0;
      client.request.mockImplementation(async (
        method: string,
        _params: unknown,
        options?: AppServerRequestOptions,
      ) => {
        if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
        options?.onWritten?.();
        turn += 1;
        return { turn: { id: `turn-${turn}`, status: "inProgress" } };
      });
      const manager = new AppServerTurnManager(client);
      manager.trackThread("thread-1", "idle", null);
      const firstCallbacks = callbacks();
      vi.mocked(firstCallbacks[throwingObserver]!).mockImplementation(() => {
        throw new Error(`${throwingObserver} observer failed`);
      });
      const secondCallbacks = callbacks();

      const first = manager.runTurn(request(firstCallbacks, "first"));
      await vi.waitFor(() => expect(firstCallbacks.onStarted).toHaveBeenCalledWith("turn-1"));
      const second = manager.runTurn(request(secondCallbacks, "second"));
      client.emit("thread/tokenUsage/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 } },
      });

      expect(() => client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      })).not.toThrow();
      await expect(first).resolves.toBeUndefined();
      await vi.waitFor(() => expect(secondCallbacks.onStarted).toHaveBeenCalledWith("turn-2"));

      client.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-2", status: "completed" },
      });
      await expect(second).resolves.toBeUndefined();
    },
  );
});
