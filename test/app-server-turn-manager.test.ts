import { vi } from "vitest";

import type { AppServerNotification } from "../src/app-server-client.js";
import {
  AppServerTurnManager,
  type AppServerTurnCallbacks,
  type AppServerTurnRequest,
} from "../src/app-server-turn-manager.js";

class FakeAppServerClient {
  readonly request = vi.fn();
  private listener?: (notification: AppServerNotification) => void;

  async connect(): Promise<void> {}

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(method: string, params: unknown): void {
    this.listener?.({ method, params });
  }
}

const createCallbacks = (): AppServerTurnCallbacks => ({
  onQueued: vi.fn(),
  onStarted: vi.fn(),
  onTextDelta: vi.fn(),
  onToolStart: vi.fn(),
  onToolUpdate: vi.fn(),
  onToolEnd: vi.fn(),
  onAgentEnd: vi.fn(),
  onAgentMessageStart: vi.fn(),
  onAgentMessageEnd: vi.fn(),
  onTodoUpdate: vi.fn(),
  onTurnComplete: vi.fn(),
  onGeneratedImage: vi.fn(),
});

const createRequest = (callbacks: AppServerTurnCallbacks): AppServerTurnRequest => ({
  threadId: "thread-1",
  input: [{ type: "text", text: "queued prompt", text_elements: [] }],
  cwd: "/workspace/project",
  model: "gpt-5.6-sol",
  approvalPolicy: "never",
  sandbox: "workspace-write",
  callbacks,
});

const createThreadRequest = (
  threadId: string,
  callbacks: AppServerTurnCallbacks,
): AppServerTurnRequest => ({
  ...createRequest(callbacks),
  threadId,
});

describe("AppServerTurnManager", () => {
  it("starts the first turn of a newly created in-memory thread without resuming it", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        return { turn: { id: "first-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    manager.trackThread("thread-1", "idle");
    const completion = manager.runTurn(createRequest(callbacks));
    void completion.catch(() => undefined);

    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("turn/start", expect.anything()));
    expect(client.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
  });

  it("starts a turn immediately when the shared thread is idle", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ threadId: "thread-1", input: createRequest(callbacks).input }),
      );
    });

    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "message-1",
      delta: "Готово",
    });
    client.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      tokenUsage: {
        last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 },
      },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(callbacks.onQueued).not.toHaveBeenCalled();
    expect(callbacks.onStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Готово");
    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
    });
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("queues behind a turn started by the direct Codex client", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "active", activeFlags: [] } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(callbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    }));
    expect(client.request).not.toHaveBeenCalledWith("turn/start", expect.anything());

    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "direct-turn",
      itemId: "direct-message",
      delta: "Не отправлять в Telegram",
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "direct-turn", status: "completed", error: null },
    });

    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: "thread-1" }));
    });
    expect(callbacks.onStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextDelta).not.toHaveBeenCalled();

    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "telegram-message",
      delta: "Ответ Telegram",
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Ответ Telegram");
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("routes command output and final status only for the Telegram turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("turn/start", expect.anything()));

    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "commandExecution", id: "cmd-1", command: "npm test", status: "inProgress" },
    });
    client.emit("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "cmd-1",
      delta: "all green\n",
    });
    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "commandExecution", id: "cmd-1", command: "npm test", status: "completed" },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await completion;
    expect(callbacks.onToolStart).toHaveBeenCalledWith("npm test", "cmd-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("cmd-1", "all green\n");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-1", false);
  });

  it("preserves agent message boundaries and phases", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("turn/start", expect.anything()));

    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "commentary-1", phase: "commentary" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "commentary-1",
      delta: "Проверяю.",
    });
    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "commentary-1", phase: "commentary" },
    });
    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "final-1", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      itemId: "final-1",
      delta: "Готово.",
    });
    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: { type: "agentMessage", id: "final-1", phase: "final_answer" },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await completion;
    expect(callbacks.onAgentMessageStart).toHaveBeenNthCalledWith(1, {
      itemId: "commentary-1",
      phase: "commentary",
    });
    expect(callbacks.onAgentMessageStart).toHaveBeenNthCalledWith(2, {
      itemId: "final-1",
      phase: "final_answer",
    });
    expect(callbacks.onAgentMessageEnd).toHaveBeenNthCalledWith(1, {
      itemId: "commentary-1",
      phase: "commentary",
    });
    expect(callbacks.onAgentMessageEnd).toHaveBeenNthCalledWith(2, {
      itemId: "final-1",
      phase: "final_answer",
    });
  });

  it("routes generated images with their saved path", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("turn/start", expect.anything()));

    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "telegram-turn",
      item: {
        type: "imageGeneration",
        id: "image-1",
        status: "completed",
        savedPath: "/root/.codex/generated_images/thread-1/image-1.png",
        result: "base64-image",
      },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "telegram-turn", status: "completed", error: null },
    });

    await completion;
    expect(callbacks.onGeneratedImage).toHaveBeenCalledWith({
      path: "/root/.codex/generated_images/thread-1/image-1.png",
    });
  });

  it("removes a queued Telegram turn without interrupting the direct turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockResolvedValue({
      thread: { id: "thread-1", status: { type: "active", activeFlags: [] } },
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();

    const completion = manager.runTurn(createRequest(callbacks));
    await vi.waitFor(() => expect(callbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    }));
    await manager.cancelTurn("thread-1", callbacks);

    await expect(completion).rejects.toThrow("aborted");
    expect(client.request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
  });

  it("interrupts the active Telegram turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: "telegram-turn", status: "inProgress" } };
      }
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client);
    const callbacks = createCallbacks();
    const completion = manager.runTurn(createRequest(callbacks));
    void completion.catch(() => undefined);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("turn/start", expect.anything()));

    await manager.cancelTurn("thread-1", callbacks);

    expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "telegram-turn",
    });
  });

  it("limits active Telegram turns globally and reports queue capacity", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      if (method === "thread/resume") {
        return { thread: { id: threadId, status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const firstCallbacks = createCallbacks();
    const secondCallbacks = createCallbacks();

    const first = manager.runTurn(createThreadRequest("thread-a", firstCallbacks));
    const second = manager.runTurn(createThreadRequest("thread-b", secondCallbacks));
    void first.catch(() => undefined);
    void second.catch(() => undefined);

    await vi.waitFor(() => expect(firstCallbacks.onStarted).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(secondCallbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      active: 1,
      limit: 1,
      reason: "global-limit",
    }));
    expect(client.request).not.toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thread-b" }),
    );

    client.emit("turn/completed", {
      threadId: "thread-a",
      turn: { id: "turn-thread-a", status: "completed", error: null },
    });

    await vi.waitFor(() => expect(secondCallbacks.onStarted).toHaveBeenCalledTimes(1));
    client.emit("turn/completed", {
      threadId: "thread-b",
      turn: { id: "turn-thread-b", status: "completed", error: null },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("does not spend a global slot while waiting for a direct Codex turn", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const threadId = (params as { threadId?: string })?.threadId;
      if (method === "thread/resume") {
        return {
          thread: {
            id: threadId,
            status: { type: threadId === "thread-direct" ? "active" : "idle" },
          },
        };
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${threadId}`, status: "inProgress" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const waitingCallbacks = createCallbacks();
    const runnableCallbacks = createCallbacks();

    const waiting = manager.runTurn(createThreadRequest("thread-direct", waitingCallbacks));
    const runnable = manager.runTurn(createThreadRequest("thread-free", runnableCallbacks));
    void waiting.catch(() => undefined);
    void runnable.catch(() => undefined);

    await vi.waitFor(() => expect(waitingCallbacks.onQueued).toHaveBeenCalledWith({
      position: 1,
      reason: "thread-active",
    }));
    await vi.waitFor(() => expect(runnableCallbacks.onStarted).toHaveBeenCalledTimes(1));
    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thread-free" }),
    );

    client.emit("turn/completed", {
      threadId: "thread-free",
      turn: { id: "turn-thread-free", status: "completed", error: null },
    });
    await runnable;

    client.emit("turn/completed", {
      threadId: "thread-direct",
      turn: { id: "direct-app-turn", status: "completed", error: null },
    });
    await vi.waitFor(() => expect(waitingCallbacks.onStarted).toHaveBeenCalledTimes(1));
    client.emit("turn/completed", {
      threadId: "thread-direct",
      turn: { id: "turn-thread-direct", status: "completed", error: null },
    });
    await waiting;
  });

  it("reattaches to an active Telegram turn after restart without starting it twice", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "active" } } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const callbacks = createCallbacks();

    const completion = manager.recoverTurn(createRequest(callbacks), "turn-existing");
    await vi.waitFor(() => expect(callbacks.onStarted).toHaveBeenCalledWith("turn-existing"));
    expect(client.request).not.toHaveBeenCalledWith("turn/start", expect.anything());

    client.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-existing",
      item: { type: "agentMessage", id: "final", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-existing",
      itemId: "final",
      delta: "Recovered result",
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-existing", status: "completed", error: null },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Recovered result");
  });

  it("replays a turn that completed while TeleCodex was offline", async () => {
    const client = new FakeAppServerClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            turns: [{
              id: "turn-existing",
              status: "completed",
              items: [{
                type: "agentMessage",
                id: "final",
                phase: "final_answer",
                text: "Offline result",
              }],
            }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const manager = new AppServerTurnManager(client, 1);
    const callbacks = createCallbacks();

    await expect(manager.recoverTurn(createRequest(callbacks), "turn-existing")).resolves.toBeUndefined();

    expect(client.request).toHaveBeenCalledWith("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });
    expect(callbacks.onAgentMessageStart).toHaveBeenCalledWith({
      itemId: "final",
      phase: "final_answer",
    });
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("Offline result");
    expect(callbacks.onAgentMessageEnd).toHaveBeenCalledWith({
      itemId: "final",
      phase: "final_answer",
    });
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });
});
