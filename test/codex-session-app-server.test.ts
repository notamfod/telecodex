import { vi } from "vitest";

import type { AppServerNotification } from "../src/app-server-client.js";
import type { AppServerTurnRequest } from "../src/app-server-turn-manager.js";
import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import { CodexSessionService } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

class FakeClient {
  readonly request = vi.fn();

  async connect(): Promise<void> {}

  onNotification(_listener: (notification: AppServerNotification) => void): () => void {
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
  it("resumes an existing thread through the shared app-server client", async () => {
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

    expect(client.request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-existing",
    });
    expect(turnManager.trackThread).toHaveBeenCalledWith("thread-existing", "idle");
    expect(session.getInfo()).toEqual(
      expect.objectContaining({
        threadId: "thread-existing",
        workspace: "/workspace/existing",
        model: "gpt-5.6-sol",
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
          text: "Файл сохранён в /workspace/inbox/report.csv\n\nПроверь файл",
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

    const info = await session.newThread("/workspace/new", "gpt-5.6-sol");

    expect(client.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        cwd: "/workspace/new",
        model: "gpt-5.6-sol",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        serviceName: "telecodex",
      }),
    );
    expect(info.threadId).toBe("thread-new");
    expect(turnManager.trackThread).toHaveBeenCalledWith("thread-new", "idle");
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
