import { vi } from "vitest";

import type { AppServerNotification } from "../src/app-server-client.js";
import type { AppServerTurnRequest } from "../src/app-server-turn-manager.js";
import { createDefaultLaunchProfile, createLaunchProfile } from "../src/codex-launch.js";
import { CodexSessionService } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

class FakeClient {
  readonly request = vi.fn();

  async connect(): Promise<void> {}

  onNotification(_listener: (notification: AppServerNotification) => void): () => void {
    return () => {};
  }

  onDisconnect(_listener: () => void): () => void {
    return () => {};
  }
}

class FakeTurnManager {
  readonly runTurn = vi.fn<(request: AppServerTurnRequest) => Promise<void>>().mockResolvedValue(undefined);
  readonly recoverTurn = vi.fn<(request: AppServerTurnRequest, turnId: string) => Promise<void>>().mockResolvedValue(undefined);
  readonly trackThread = vi.fn();
}

const createConfig = (): TeleCodexConfig => ({
  telegramBotToken: "bot-token",
  telegramAllowedUserIds: [123],
  telegramAllowedUserIdSet: new Set([123]),
  workspace: "/workspace/base",
  maxFileSize: 20 * 1024 * 1024,
  codexModel: "gpt-5.6-sol",
  modelChoices: [
    {
      id: "openai-default",
      label: "OpenAI GPT-5.6 Sol",
      provider: "openai",
      model: "gpt-5.6-sol",
      supportsImages: true,
    },
    {
      id: "glm-53",
      label: "Z.AI GLM-5.3",
      provider: "zai",
      model: "glm-5.3",
      supportsImages: false,
      webSearch: "disabled",
    },
  ],
  defaultModelChoiceId: "openai-default",
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "never",
  launchProfiles: [createDefaultLaunchProfile("workspace-write", "never")],
  defaultLaunchProfileId: "default",
  enableUnsafeLaunchProfiles: false,
  toolVerbosity: "summary",
  showTurnTokenUsage: false,
  enableTelegramLogin: false,
  enableTelegramReactions: false,
  telegramMaxActiveTopics: 4,
  telegramProgressHeartbeatMs: 120_000,
});

const createCallbacks = () => ({
  onQueued: vi.fn(),
  onTextDelta: vi.fn(),
  onToolStart: vi.fn(),
  onToolUpdate: vi.fn(),
  onToolEnd: vi.fn(),
  onAgentEnd: vi.fn(),
  onTodoUpdate: vi.fn(),
  onTurnComplete: vi.fn(),
});

describe("CodexSessionService with shared app-server", () => {
  it("names a new thread after the Telegram topic it belongs to", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-new", status: { type: "idle" } } };
      }
      return {};
    });

    await CodexSessionService.create(
      createConfig(),
      { topicName: "MIR-6319 · оплата не проходит" },
      { client, turnManager: new FakeTurnManager() },
    );

    expect(client.request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "thread-new",
      name: "MIR-6319 · оплата не проходит",
    });
  });

  it("starts a thread even when naming it fails", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-new", status: { type: "idle" } } };
      }
      throw new Error("name rejected");
    });

    const session = await CodexSessionService.create(
      createConfig(),
      { topicName: "какое-то имя" },
      { client, turnManager: new FakeTurnManager() },
    );

    expect(session.getInfo().threadId).toBe("thread-new");
  });

  it("leaves the thread unnamed when the context has no topic name", async () => {
    const client = new FakeClient();
    client.request.mockResolvedValue({ thread: { id: "thread-new", status: { type: "idle" } } });

    await CodexSessionService.create(
      createConfig(),
      undefined,
      { client, turnManager: new FakeTurnManager() },
    );

    expect(client.request).not.toHaveBeenCalledWith("thread/name/set", expect.anything());
  });

  it("resumes an existing thread through the shared app-server client", async () => {
    const client = new FakeClient();
    client.request.mockResolvedValue({
      thread: { id: "thread-existing", status: { type: "idle" } },
      cwd: "/workspace/existing",
      model: "glm-5.3",
      modelProvider: "zai",
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
      reasoningEffort: "high",
    });
    const turnManager = new FakeTurnManager();

    const session = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-existing", workspace: "/workspace/existing" },
      { client, turnManager },
    );

    expect(client.request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-existing",
    });
    expect(turnManager.trackThread).toHaveBeenCalledWith("thread-existing", "idle");
    expect(session.getInfo()).toEqual(
      expect.objectContaining({
        threadId: "thread-existing",
        workspace: "/workspace/existing",
        model: "glm-5.3",
        modelProvider: "zai",
        reasoningEffort: "high",
      }),
    );
  });

  it("sends prompts through the turn manager using app-server input shapes", async () => {
    const client = new FakeClient();
    client.request.mockResolvedValue({
      thread: { id: "thread-existing", status: { type: "idle" } },
      cwd: "/workspace/existing",
      model: "gpt-5.6-sol",
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
      reasoningEffort: "high",
    });
    const turnManager = new FakeTurnManager();
    const session = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-existing", workspace: "/workspace/existing" },
      { client, turnManager },
    );
    const callbacks = createCallbacks();

    await session.prompt(
      {
        text: "Проверь файл",
        stagedFileInstructions: "Файл сохранён в /workspace/inbox/report.csv",
        imagePaths: ["/workspace/inbox/chart.png"],
      },
      callbacks,
    );

    expect(turnManager.runTurn).toHaveBeenCalledWith({
      threadId: "thread-existing",
      input: [
        {
          type: "text",
          text: "Проверь файл\n\nФайл сохранён в /workspace/inbox/report.csv",
          text_elements: [],
        },
        { type: "localImage", path: "/workspace/inbox/chart.png" },
      ],
      cwd: "/workspace/existing",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      callbacks: expect.objectContaining({
        onQueued: callbacks.onQueued,
        onTextDelta: callbacks.onTextDelta,
        onAgentEnd: callbacks.onAgentEnd,
        onTurnComplete: expect.any(Function),
      }),
    });
  });

  it("creates a new thread through app-server without spawning codex exec", async () => {
    const client = new FakeClient();
    client.request.mockResolvedValue({
      thread: { id: "thread-new", status: { type: "idle" } },
      cwd: "/workspace/new",
      model: "gpt-5.6-sol",
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
      reasoningEffort: "medium",
    });
    const turnManager = new FakeTurnManager();
    const session = await CodexSessionService.create(
      createConfig(),
      { deferThreadStart: true },
      { client, turnManager },
    );

    const info = await session.newThread("/workspace/new", "glm-53");

    expect(client.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        cwd: "/workspace/new",
        model: "glm-5.3",
        modelProvider: "zai",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        serviceName: "telecodex",
      }),
    );
    expect(info.threadId).toBe("thread-new");
    expect(turnManager.trackThread).toHaveBeenCalledWith("thread-new", "idle");
  });

  it("forks a read-only thread into a writable profile while preserving its history", async () => {
    const client = new FakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        return {
          thread: { id: "thread-readonly", status: { type: "idle" } },
          cwd: "/workspace/existing",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          approvalPolicy: "never",
          sandbox: { type: "readOnly" },
          reasoningEffort: "high",
        };
      }
      if (method === "thread/fork") {
        return {
          thread: { id: "thread-implementation", status: { type: "idle" } },
          cwd: "/workspace/existing",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
          reasoningEffort: "high",
        };
      }
      return {};
    });
    const turnManager = new FakeTurnManager();
    const config = createConfig();
    config.launchProfiles.push(
      createLaunchProfile({
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
      createLaunchProfile({
        id: "implementation",
        label: "Implementation",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      }),
    );
    const session = await CodexSessionService.create(
      config,
      {
        resumeThreadId: "thread-readonly",
        workspace: "/workspace/existing",
        launchProfileId: "readonly",
      },
      { client, turnManager },
    );

    const info = await session.forkThread("implementation");

    expect(client.request).toHaveBeenCalledWith("thread/fork", {
      threadId: "thread-readonly",
      cwd: "/workspace/existing",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { model_reasoning_effort: "high" },
    });
    expect(info).toEqual(expect.objectContaining({
      threadId: "thread-implementation",
      launchProfileId: "implementation",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    }));
    expect(turnManager.trackThread).toHaveBeenCalledWith("thread-implementation", "idle");
  });

  it("reattaches callbacks to a persisted active turn", async () => {
    const client = new FakeClient();
    client.request.mockResolvedValue({
      thread: { id: "thread-existing", status: { type: "active" } },
      cwd: "/workspace/existing",
      model: "gpt-5.6-sol",
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
    });
    const turnManager = new FakeTurnManager();
    const session = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-existing" },
      { client, turnManager },
    );
    const callbacks = createCallbacks();

    await session.recoverPrompt("turn-existing", callbacks);

    expect(turnManager.recoverTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-existing",
        input: [],
        callbacks: expect.objectContaining({ onTextDelta: callbacks.onTextDelta }),
      }),
      "turn-existing",
    );
  });
});
