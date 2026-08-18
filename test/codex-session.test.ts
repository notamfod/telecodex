import { vi } from "vitest";

import { createDefaultLaunchProfile, createLaunchProfile } from "../src/codex-launch.js";
import type {
  CodexSessionCallbacks,
  CodexSessionDependencies,
} from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

const mockCodexState = vi.hoisted(() => ({
  getThread: vi.fn(),
  listThreads: vi.fn(),
  listWorkspaces: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock("../src/codex-state.js", () => mockCodexState);

import { CodexSessionService } from "../src/codex-session.js";

interface FakeDependencies extends CodexSessionDependencies {
  client: CodexSessionDependencies["client"] & {
    connect: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  };
  turnManager: CodexSessionDependencies["turnManager"] & {
    runTurn: ReturnType<typeof vi.fn>;
    cancelTurn: ReturnType<typeof vi.fn>;
  };
}

function createConfig(overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig {
  return {
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "o3",
    modelChoices: [],
    defaultModelChoiceId: undefined,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [
      createDefaultLaunchProfile("workspace-write", "never"),
      createLaunchProfile({
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    ],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    telegramMaxActiveTopics: 4,
    telegramProgressHeartbeatMs: 120_000,
    ...overrides,
  };
}

function createDependencies(): FakeDependencies {
  let threadCounter = 0;
  const client = {
    connect: vi.fn(async () => undefined),
    request: vi.fn(async (method: string, params?: unknown) => {
      const request = params as Record<string, unknown> | undefined;
      if (method === "thread/start") {
        threadCounter += 1;
        return {
          thread: { id: `thread-${threadCounter}`, status: { type: "idle" } },
          cwd: request?.cwd,
          model: request?.model,
          modelProvider: request?.modelProvider,
        };
      }
      if (method === "thread/resume") {
        return { thread: { id: request?.threadId, status: { type: "idle" } } };
      }
      throw new Error(`Unexpected method: ${method}`);
    }),
    onNotification: vi.fn(() => () => undefined),
    close: vi.fn(),
  };
  const turnManager = {
    runTurn: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  return { client, turnManager };
}

function createCallbacks(): CodexSessionCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
    onTodoUpdate: vi.fn(),
    onTurnComplete: vi.fn(),
  };
}

describe("CodexSessionService", () => {
  beforeEach(() => {
    mockCodexState.getThread.mockReset().mockReturnValue(undefined);
    mockCodexState.listThreads.mockReset().mockReturnValue([]);
    mockCodexState.listWorkspaces.mockReset().mockReturnValue([]);
    mockCodexState.listModels.mockReset().mockReturnValue([]);
  });

  it("starts the initial thread through the shared app-server", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);

    expect(dependencies.client.request).toHaveBeenCalledWith("thread/start", {
      cwd: "/workspace/base",
      model: "o3",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "telecodex",
    });
    expect(service.getInfo()).toEqual(expect.objectContaining({
      threadId: "thread-1",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
    }));
  });

  it("resumes an existing thread with per-context overrides", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(createConfig(), {
      workspace: "/workspace/resumed",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      resumeThreadId: "thread-resume",
    }, dependencies);

    expect(dependencies.client.request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-resume",
    });
    expect(service.getInfo()).toEqual(expect.objectContaining({
      threadId: "thread-resume",
      workspace: "/workspace/resumed",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      sandboxMode: "read-only",
    }));
  });

  it("can defer thread creation and apply the selected profile to the first thread", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(
      createConfig(),
      { deferThreadStart: true },
      dependencies,
    );

    expect(service.hasActiveThread()).toBe(false);
    service.setLaunchProfile("readonly");
    await service.newThread();

    expect(dependencies.client.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ sandbox: "read-only" }),
    );
  });

  it("reports the active profile separately from the next selected profile", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);

    service.setLaunchProfile("readonly");

    expect(service.getInfo()).toEqual(expect.objectContaining({
      launchProfileId: "default",
      nextLaunchProfileId: "readonly",
      nextLaunchProfileLabel: "Read Only",
    }));
  });

  it("keeps the active model while selecting GLM for the next thread", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(
      createConfig({
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
      }),
      undefined,
      dependencies,
    );

    service.setModelChoice("glm-53");

    expect(service.getInfo()).toEqual(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        nextModel: "glm-5.3",
        nextModelProvider: "zai",
        nextModelChoiceId: "glm-53",
      }),
    );

    await service.prompt("continue", createCallbacks());
    expect(dependencies.turnManager.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-sol" }),
    );
    expect(dependencies.turnManager.runTurn.mock.calls[0]![0]).not.toHaveProperty("modelProvider");
  });

  it("starts a GLM thread with its provider and capability config", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(
      createConfig({
        modelChoices: [
          {
            id: "openai-default",
            label: "OpenAI",
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
      }),
      { deferThreadStart: true },
      dependencies,
    );

    const info = await service.newThread("/workspace/glm", "glm-53");

    expect(dependencies.client.request).toHaveBeenCalledWith("thread/start", {
      cwd: "/workspace/glm",
      model: "glm-5.3",
      modelProvider: "zai",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "telecodex",
      config: { web_search: "disabled" },
    });
    expect(info).toEqual(
      expect.objectContaining({
        model: "glm-5.3",
        modelProvider: "zai",
        modelChoiceId: "glm-53",
        supportsImages: false,
      }),
    );
  });

  it("reports and persists the selected choice before a thread exists", async () => {
    const service = await CodexSessionService.create(
      createConfig({
        modelChoices: [
          {
            id: "openai-default",
            label: "OpenAI",
            provider: "openai",
            model: "gpt-5.6-sol",
            supportsImages: true,
          },
          {
            id: "glm-53",
            label: "GLM",
            provider: "zai",
            model: "glm-5.3",
            supportsImages: false,
          },
        ],
        defaultModelChoiceId: "openai-default",
      }),
      { deferThreadStart: true },
      createDependencies(),
    );

    service.setModelChoice("glm-53");

    expect(service.getInfo()).toEqual(
      expect.objectContaining({
        threadId: null,
        model: "glm-5.3",
        modelProvider: "zai",
        modelChoiceId: "glm-53",
      }),
    );
  });

  it("maps text, staged files, and images into an app-server turn", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);
    const callbacks = createCallbacks();

    await service.prompt({
      text: "analyze",
      stagedFileInstructions: "Files staged at /inbox:\n- log.txt",
      imagePaths: ["/tmp/image.png"],
    }, callbacks);

    expect(dependencies.turnManager.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-1",
      cwd: "/workspace/base",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      input: [
        {
          type: "text",
          text: "analyze\n\nFiles staged at /inbox:\n- log.txt",
          text_elements: [],
        },
        { type: "localImage", path: "/tmp/image.png" },
      ],
    }));
  });

  it("accumulates token usage reported by the turn manager", async () => {
    const dependencies = createDependencies();
    dependencies.turnManager.runTurn.mockImplementation(async (request) => {
      request.callbacks.onTurnComplete?.({
        inputTokens: 11,
        cachedInputTokens: 3,
        outputTokens: 7,
      });
    });
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);
    const callbacks = createCallbacks();

    await service.prompt("first", callbacks);

    expect(callbacks.onTurnComplete).toHaveBeenCalledWith({
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 7,
    });
    expect(service.getInfo().sessionTokens).toEqual({ input: 11, cached: 3, output: 7 });
  });

  it("prevents switching while a Telegram turn is pending", async () => {
    const dependencies = createDependencies();
    let release!: () => void;
    dependencies.turnManager.runTurn.mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);
    const prompt = service.prompt("wait", createCallbacks());

    await vi.waitFor(() => expect(service.isProcessing()).toBe(true));
    await expect(service.switchSession("thread-other")).rejects.toThrow(
      "Cannot switch session while a turn is in progress",
    );
    release();
    await prompt;
  });

  it("cancels the queued or active app-server turn", async () => {
    const dependencies = createDependencies();
    let release!: () => void;
    dependencies.turnManager.runTurn.mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);
    const callbacks = createCallbacks();
    const prompt = service.prompt("stop", callbacks);
    await vi.waitFor(() => expect(service.isProcessing()).toBe(true));

    await service.abort();

    const activeCallbacks = dependencies.turnManager.runTurn.mock.calls[0][0].callbacks;
    expect(dependencies.turnManager.cancelTurn).toHaveBeenCalledWith("thread-1", activeCallbacks);
    release();
    await prompt;
  });

  it("starts new threads with the selected model, effort, and profile", async () => {
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);
    service.setModel("gpt-5.6-sol");
    service.setReasoningEffort("high");
    service.setLaunchProfile("readonly");

    const info = await service.newThread("/workspace/other");

    expect(dependencies.client.request).toHaveBeenLastCalledWith("thread/start", {
      cwd: "/workspace/other",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "telecodex",
      config: { model_reasoning_effort: "high" },
    });
    expect(info).toEqual(expect.objectContaining({
      threadId: "thread-2",
      workspace: "/workspace/other",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      launchProfileId: "readonly",
    }));
  });

  it("uses Codex state metadata when switching sessions", async () => {
    mockCodexState.getThread.mockReturnValue({
      id: "thread-saved",
      cwd: "/workspace/saved",
      model: "gpt-5.4",
    });
    const dependencies = createDependencies();
    const service = await CodexSessionService.create(createConfig(), undefined, dependencies);

    const info = await service.switchSession("thread-saved");

    expect(dependencies.client.request).toHaveBeenLastCalledWith("thread/resume", {
      threadId: "thread-saved",
    });
    expect(info).toEqual(expect.objectContaining({
      workspace: "/workspace/saved",
      model: "gpt-5.4",
    }));
  });

  it("delegates session, workspace, and model listings to Codex state", async () => {
    mockCodexState.listThreads.mockReturnValue([{ id: "thread-a" }]);
    mockCodexState.listWorkspaces.mockReturnValue(["/workspace/a"]);
    mockCodexState.listModels.mockReturnValue([{ slug: "gpt-5.6-sol" }]);
    const service = await CodexSessionService.create(
      createConfig(),
      { deferThreadStart: true },
      createDependencies(),
    );

    expect(service.listAllSessions(7)).toEqual([{ id: "thread-a" }]);
    expect(mockCodexState.listThreads).toHaveBeenCalledWith(7);
    expect(service.listWorkspaces()).toEqual(["/workspace/a"]);
    expect(service.listModels()).toEqual([{ slug: "gpt-5.6-sol" }]);
  });

  it("hands the active thread back without deleting it", async () => {
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-existing" },
      createDependencies(),
    );

    expect(service.handback()).toEqual({
      threadId: "thread-existing",
      workspace: "/workspace/base",
    });
    expect(service.hasActiveThread()).toBe(false);
  });
});
