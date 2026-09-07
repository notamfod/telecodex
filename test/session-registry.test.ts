import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile, createLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";
import type { CodexThreadRecord } from "../src/codex-state.js";

const mockFsState = vi.hoisted(() => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  let renameFailure: Error | null = null;

  return {
    files,
    directories,
    failNextRename: (error: Error) => { renameFailure = error; },
    rename: (source: string, destination: string) => {
      if (renameFailure) {
        const error = renameFailure;
        renameFailure = null;
        throw error;
      }
      const content = files.get(source);
      if (content === undefined) throw new Error(`ENOENT: ${source}`);
      files.set(destination, content);
      files.delete(source);
    },
    reset: () => {
      files.clear();
      directories.clear();
      renameFailure = null;
    },
  };
});

const mockSessionState = vi.hoisted(() => {
  const create = vi.fn();
  const dependencies = {
    client: { connect: vi.fn(), request: vi.fn(), onNotification: vi.fn(), close: vi.fn() },
    turnManager: { runTurn: vi.fn(), cancelTurn: vi.fn(), dispose: vi.fn() },
  };
  const sessions: Array<{
    getInfo: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    isProcessing: ReturnType<typeof vi.fn>;
    applyDeferredDefaults: ReturnType<typeof vi.fn>;
    setInfo: (next: Partial<{
      threadId: string | null;
      workspace: string;
      model?: string;
      modelProvider?: string;
      modelChoiceId?: string;
      nextModelChoiceId?: string;
      reasoningEffort?: string;
      launchProfileId: string;
      launchProfileLabel: string;
      launchProfileBehavior: string;
      sandboxMode: string;
      approvalPolicy: string;
      unsafeLaunch: boolean;
      nextLaunchProfileId?: string;
      nextLaunchProfileLabel?: string;
      nextLaunchProfileBehavior?: string;
      nextUnsafeLaunch?: boolean;
    }>) => void;
  }> = [];

  const reset = () => {
    create.mockReset();
    dependencies.client.request.mockReset();
    dependencies.client.close.mockReset();
    dependencies.turnManager.dispose.mockReset();
    sessions.length = 0;
  };

  return {
    create,
    dependencies,
    sessions,
    reset,
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn((targetPath: string) => mockFsState.files.has(targetPath) || mockFsState.directories.has(targetPath)),
  mkdirSync: vi.fn((targetPath: string) => {
    mockFsState.directories.add(targetPath);
  }),
  readFileSync: vi.fn((targetPath: string) => {
    const content = mockFsState.files.get(targetPath);
    if (content === undefined) {
      throw new Error(`ENOENT: ${targetPath}`);
    }
    return content;
  }),
  renameSync: vi.fn((source: string, destination: string) => {
    mockFsState.rename(source, destination);
  }),
  writeFileSync: vi.fn((targetPath: string, content: string) => {
    mockFsState.files.set(targetPath, content);
    mockFsState.directories.add(path.dirname(targetPath));
  }),
}));

vi.mock("../src/codex-session.js", () => ({
  CodexSessionService: {
    create: mockSessionState.create,
  },
  createCodexSessionDependencies: () => mockSessionState.dependencies,
}));

import { SessionRegistry } from "../src/session-registry.js";

describe("SessionRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createConfig = (overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig => ({
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
    telegramTopicRecoveryEnabled: false,
    telegramMaxActiveTopics: 4,
    telegramProgressHeartbeatMs: 120_000,
    ...overrides,
  });

  it("checks shared app-server connectivity through the typed request deadline", async () => {
    mockSessionState.dependencies.client.request.mockResolvedValueOnce({});
    const registry = new SessionRegistry(createConfig());

    await registry.checkAppServerConnectivity(2_000);

    expect(mockSessionState.dependencies.client.request).toHaveBeenCalledWith(
      "server/diagnostics",
      {},
      { timeoutMs: 2_000 },
    );
  });

  const createMockSession = (info: {
    threadId: string | null;
    workspace: string;
    model?: string;
    modelProvider?: string;
    modelChoiceId?: string;
    nextModelChoiceId?: string;
    reasoningEffort?: string;
    launchProfileId: string;
    launchProfileLabel: string;
    launchProfileBehavior: string;
    sandboxMode: string;
    approvalPolicy: string;
    unsafeLaunch: boolean;
  }) => {
    let currentInfo = { ...info };
    const session = {
      getInfo: vi.fn(() => ({ ...currentInfo })),
      dispose: vi.fn(),
      isProcessing: vi.fn(() => false),
      applyDeferredDefaults: vi.fn((defaults: { workspace: string; launchProfileId?: string }) => {
        currentInfo = {
          ...currentInfo,
          workspace: defaults.workspace,
          ...(defaults.launchProfileId ? {
            launchProfileId: defaults.launchProfileId,
            sandboxMode: defaults.launchProfileId === "readonly" ? "read-only" : "workspace-write",
          } : {}),
        };
      }),
      setInfo: (next: Partial<typeof currentInfo>) => {
        currentInfo = { ...currentInfo, ...next };
      },
    };
    mockSessionState.sessions.push(session);
    return session;
  };

  beforeEach(() => {
    mockFsState.reset();
    mockSessionState.reset();
    mockSessionState.create.mockImplementation(async (config: TeleCodexConfig, options?: {
      workspace?: string;
      model?: string;
      modelProvider?: string;
      modelChoiceId?: string;
      reasoningEffort?: string;
      launchProfileId?: string;
      resumeThreadId?: string;
    }) =>
      createMockSession({
        threadId: options?.resumeThreadId ?? null,
        workspace: options?.workspace ?? config.workspace,
        model: options?.model ?? config.codexModel,
        modelProvider: options?.modelProvider,
        modelChoiceId: options?.modelChoiceId,
        reasoningEffort: options?.reasoningEffort,
        launchProfileId: options?.launchProfileId ?? config.defaultLaunchProfileId,
        launchProfileLabel: options?.launchProfileId === "readonly" ? "Read Only" : "Default",
        launchProfileBehavior: options?.launchProfileId === "readonly" ? "read-only / never" : "workspace-write / never",
        sandboxMode: options?.launchProfileId === "readonly" ? "read-only" : "workspace-write",
        approvalPolicy: "never",
        unsafeLaunch: false,
      }),
    );
  });

  it("returns the same session instance for the same context key", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123");

    expect(first).toBe(second);
    expect(mockSessionState.create).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight session creation for concurrent updates in one topic", async () => {
    let resolveCreation!: (session: ReturnType<typeof createMockSession>) => void;
    mockSessionState.create.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreation = resolve;
    }));
    const registry = new SessionRegistry(createConfig());

    const first = registry.getOrCreate("123:42");
    const second = registry.getOrCreate("123:42");
    expect(mockSessionState.create).toHaveBeenCalledTimes(1);

    const session = createMockSession({
      threadId: "thread-shared",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    resolveCreation(session);

    await expect(first).resolves.toBe(session);
    await expect(second).resolves.toBe(session);
  });

  it("returns different session instances for different context keys", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123:42");

    expect(first).not.toBe(second);
    expect(mockSessionState.create).toHaveBeenCalledTimes(2);
  });

  it("persists a newly created thread before its first prompt", async () => {
    mockSessionState.create.mockResolvedValueOnce(createMockSession({
      threadId: "thread-new",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    }));
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("123:42");

    expect(registry.listContexts()).toEqual([
      expect.objectContaining({ contextKey: "123:42", threadId: "thread-new" }),
    ]);
  });

  it("binds a thread to a topic without starting a Codex session", () => {
    const config = createConfig();
    const registry = new SessionRegistry(config);
    const thread: CodexThreadRecord = {
      id: "thread-visible",
      title: "Visible chat",
      cwd: "/workspace/project",
      model: "gpt-5.6-sol",
      modelProvider: "zai",
      createdAt: new Date(10_000),
      updatedAt: new Date(20_000),
      firstUserMessage: "Visible chat",
    };

    registry.bindThread("-100123:42", thread);

    expect(registry.isThreadBoundInChat("thread-visible", -100123)).toBe(true);
    expect(registry.isThreadBoundInChat("thread-visible", -100999)).toBe(false);
    expect(registry.listContexts()).toEqual([
      {
        contextKey: "-100123:42",
        threadId: "thread-visible",
        workspace: "/workspace/project",
        model: "gpt-5.6-sol",
        modelProvider: "zai",
        launchProfileId: "default",
        updatedAt: 20_000,
      },
    ]);
    expect(mockSessionState.create).not.toHaveBeenCalled();

    const restored = new SessionRegistry(config);
    expect(restored.isThreadBoundInChat("thread-visible", -100123)).toBe(true);
  });

  it("atomically rebinds a thread and removes the stale active context", async () => {
    const config = createConfig();
    const registry = new SessionRegistry(config);
    const thread: CodexThreadRecord = {
      id: "thread-visible",
      title: "Visible chat",
      cwd: "/workspace/project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      createdAt: new Date(10_000),
      updatedAt: new Date(20_000),
      firstUserMessage: "Visible chat",
    };
    registry.bindThread("-100123:41", thread);
    const oldSession = await registry.getOrCreate("-100123:41");
    const removed: string[] = [];
    registry.onRemove((contextKey) => removed.push(contextKey));

    registry.rebindThreadTopic("-100123:41", "-100123:99", thread);

    expect(registry.listContexts()).toEqual([
      expect.objectContaining({ contextKey: "-100123:99", threadId: thread.id }),
    ]);
    expect(registry.has("-100123:41")).toBe(false);
    expect(oldSession.dispose).toHaveBeenCalledOnce();
    expect(removed).toEqual(["-100123:41"]);
    const persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    expect(JSON.parse(mockFsState.files.get(persistPath)!)).toEqual([
      expect.objectContaining({ contextKey: "-100123:99", threadId: thread.id }),
    ]);
    expect([...mockFsState.files.keys()].filter((file) => file.startsWith(`${persistPath}.tmp-`)))
      .toEqual([]);
  });

  it("restores the old binding and readable file when atomic replacement fails", async () => {
    const config = createConfig();
    const registry = new SessionRegistry(config);
    const thread: CodexThreadRecord = {
      id: "thread-visible",
      title: "Visible chat",
      cwd: "/workspace/project",
      model: null,
      modelProvider: null,
      createdAt: new Date(10_000),
      updatedAt: new Date(20_000),
      firstUserMessage: "Visible chat",
    };
    registry.bindThread("-100123:41", thread);
    const oldSession = await registry.getOrCreate("-100123:41");
    const persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    const prior = mockFsState.files.get(persistPath);
    mockFsState.failNextRename(new Error("replacement failed"));

    expect(() => registry.rebindThreadTopic("-100123:41", "-100123:99", thread))
      .toThrow("Failed to persist rebound context metadata");

    expect(mockFsState.files.get(persistPath)).toBe(prior);
    expect(registry.listContexts()).toEqual([
      expect.objectContaining({ contextKey: "-100123:41", threadId: thread.id }),
    ]);
    expect(registry.has("-100123:41")).toBe(true);
    expect(oldSession.dispose).not.toHaveBeenCalled();
  });

  it("disposes an in-flight stale session instead of resurrecting the old context", async () => {
    let resolveCreation!: (session: ReturnType<typeof createMockSession>) => void;
    mockSessionState.create.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreation = resolve;
    }));
    const registry = new SessionRegistry(createConfig());
    const thread: CodexThreadRecord = {
      id: "thread-visible",
      title: "Visible chat",
      cwd: "/workspace/project",
      model: null,
      modelProvider: null,
      createdAt: new Date(10_000),
      updatedAt: new Date(20_000),
      firstUserMessage: "Visible chat",
    };
    registry.bindThread("-100123:41", thread);
    const pending = registry.getOrCreate("-100123:41");

    registry.rebindThreadTopic("-100123:41", "-100123:99", thread);
    const staleSession = createMockSession({
      threadId: thread.id,
      workspace: thread.cwd,
      model: undefined,
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    resolveCreation(staleSession);

    await expect(pending).rejects.toThrow("Telegram session context changed");
    expect(staleSession.dispose).toHaveBeenCalledOnce();
    expect(registry.has("-100123:41")).toBe(false);
    expect(registry.listContexts()).toEqual([
      expect.objectContaining({ contextKey: "-100123:99", threadId: thread.id }),
    ]);
  });

  it("disposes an in-flight session already starting under the rebound context", async () => {
    let resolveCreation!: (session: ReturnType<typeof createMockSession>) => void;
    mockSessionState.create.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreation = resolve;
    }));
    const registry = new SessionRegistry(createConfig());
    const thread: CodexThreadRecord = {
      id: "thread-visible",
      title: "Visible chat",
      cwd: "/workspace/project",
      model: null,
      modelProvider: null,
      createdAt: new Date(10_000),
      updatedAt: new Date(20_000),
      firstUserMessage: "Visible chat",
    };
    registry.bindThread("-100123:41", thread);
    const pending = registry.getOrCreate("-100123:99");
    const removed: string[] = [];
    registry.onRemove((contextKey) => removed.push(contextKey));

    registry.rebindThreadTopic("-100123:41", "-100123:99", thread);
    const staleSession = createMockSession({
      threadId: "stale-thread",
      workspace: "/workspace/base",
      model: undefined,
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    resolveCreation(staleSession);

    await expect(pending).rejects.toThrow("Telegram session context changed");
    expect(staleSession.dispose).toHaveBeenCalledOnce();
    expect(registry.has("-100123:99")).toBe(false);
    expect(removed).toEqual(["-100123:41", "-100123:99"]);
    expect(registry.listContexts()).toEqual([
      expect.objectContaining({ contextKey: "-100123:99", threadId: thread.id }),
    ]);
  });

  it("preserves the old context launch and reasoning settings during rebind", () => {
    const config = createConfig();
    const persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    mockFsState.files.set(persistPath, JSON.stringify([{
      contextKey: "-100123:41",
      threadId: "thread-visible",
      workspace: "/workspace/project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      modelChoiceId: "selected-model",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      topicName: "Pinned topic",
      updatedAt: 10_000,
    }]));
    const registry = new SessionRegistry(config);
    const thread: CodexThreadRecord = {
      id: "thread-visible",
      title: "Visible chat",
      cwd: "/workspace/project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      createdAt: new Date(5_000),
      updatedAt: new Date(20_000),
      firstUserMessage: "Visible chat",
    };

    registry.rebindThreadTopic("-100123:41", "-100123:99", thread);

    expect(registry.listContexts()).toEqual([{
      contextKey: "-100123:99",
      threadId: thread.id,
      workspace: "/workspace/project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      modelChoiceId: "selected-model",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      topicName: "Pinned topic",
      updatedAt: 10_000,
    }]);
  });

  it("two topic contexts in the same chat maintain independent sessions", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("67890:1");
    const second = await registry.getOrCreate("67890:2");

    expect(first).not.toBe(second);
    expect(registry.has("67890:1")).toBe(true);
    expect(registry.has("67890:2")).toBe(true);
  });

  it("removing one topic context does not affect another in the same chat", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("67890:1");
    await registry.getOrCreate("67890:2");
    registry.remove("67890:1");

    expect(registry.has("67890:1")).toBe(false);
    expect(registry.has("67890:2")).toBe(true);
  });

  it("restores distinct per-context workspace, model, reasoning effort, and thread ids", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-a",
          workspace: "/workspace/a",
          model: "o4-mini",
          reasoningEffort: "low",
          launchProfileId: "readonly",
          updatedAt: 10,
        },
        {
          contextKey: "123:42",
          threadId: "thread-b",
          workspace: "/workspace/b",
          model: "gpt-5.4",
          reasoningEffort: "high",
          launchProfileId: "default",
          updatedAt: 20,
        },
      ]),
    );

    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123:42");

    expect(mockSessionState.create).toHaveBeenNthCalledWith(1, createConfig(), {
      workspace: "/workspace/a",
      model: "o4-mini",
      modelProvider: "openai",
      modelChoiceId: undefined,
      reasoningEffort: "low",
      launchProfileId: "readonly",
      resumeThreadId: "thread-a",
    }, mockSessionState.dependencies);
    expect(mockSessionState.create).toHaveBeenNthCalledWith(2, createConfig(), {
      workspace: "/workspace/b",
      model: "gpt-5.4",
      modelProvider: "openai",
      modelChoiceId: undefined,
      reasoningEffort: "high",
      launchProfileId: "default",
      resumeThreadId: "thread-b",
    }, mockSessionState.dependencies);
    expect(first.getInfo()).toEqual({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      modelProvider: "openai",
      modelChoiceId: undefined,
      reasoningEffort: "low",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    expect(second.getInfo()).toEqual({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
      modelProvider: "openai",
      modelChoiceId: undefined,
      reasoningEffort: "high",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
  });

  it("persists provider and the next selected model choice", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = (await registry.getOrCreate("123:42")) as any;

    session.setInfo({
      threadId: "thread-glm",
      workspace: "/workspace/glm",
      model: "glm-5.3",
      modelProvider: "zai",
      modelChoiceId: "glm-53",
      nextModelChoiceId: "openai-default",
    });
    registry.updateMetadata("123:42", session);

    expect(registry.listContexts()[0]).toEqual(
      expect.objectContaining({
        model: "glm-5.3",
        modelProvider: "zai",
        modelChoiceId: "openai-default",
      }),
    );
  });

  it("loads old metadata without rewriting it and supplies an OpenAI resume hint", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    const original = JSON.stringify([
      {
        contextKey: "123:42",
        threadId: "old-thread",
        workspace: "/workspace",
        model: "gpt-5.6-sol",
        updatedAt: 1,
      },
    ]);
    mockFsState.files.set(persistPath, original);

    const registry = new SessionRegistry(createConfig());
    expect(mockFsState.files.get(persistPath)).toBe(original);

    await registry.getOrCreate("123:42");

    expect(mockSessionState.create).toHaveBeenCalledWith(
      createConfig(),
      expect.objectContaining({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        resumeThreadId: "old-thread",
      }),
      mockSessionState.dependencies,
    );
  });

  it("does not implicitly resume a persisted non-OpenAI thread", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123:42",
          threadId: "thread-glm",
          workspace: "/workspace/glm",
          model: "glm-5.3",
          modelProvider: "zai",
          modelChoiceId: "glm-53",
          updatedAt: 1,
        },
      ]),
    );

    const registry = new SessionRegistry(createConfig());
    await registry.getOrCreate("123:42", { deferThreadStart: true });

    expect(mockSessionState.create).toHaveBeenCalledWith(
      createConfig(),
      expect.objectContaining({
        workspace: "/workspace/glm",
        model: undefined,
        modelProvider: undefined,
        modelChoiceId: undefined,
        resumeThreadId: undefined,
        deferThreadStart: true,
      }),
      mockSessionState.dependencies,
    );
  });

  it("falls back to the default launch profile when persisted metadata references a missing profile", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-a",
          workspace: "/workspace/a",
          launchProfileId: "missing",
          updatedAt: 10,
        },
      ]),
    );

    const registry = new SessionRegistry(createConfig());
    await registry.getOrCreate("123");

    expect(mockSessionState.create).toHaveBeenCalledWith(createConfig(), {
      workspace: "/workspace/a",
      model: undefined,
      reasoningEffort: undefined,
      launchProfileId: undefined,
      resumeThreadId: "thread-a",
    }, mockSessionState.dependencies);
    expect(warnSpy).toHaveBeenCalledWith(
      'Unknown persisted launch profile "missing" for 123. Falling back to default.',
    );
  });

  it("updates metadata and lists contexts sorted by newest first", async () => {
    const registry = new SessionRegistry(createConfig());
    const first = (await registry.getOrCreate("123")) as any;
    const second = (await registry.getOrCreate("123:42")) as any;
    const dateNowSpy = vi.spyOn(Date, "now");

    first.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    dateNowSpy.mockReturnValueOnce(1000);
    registry.updateMetadata("123", first as any);

    second.setInfo({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    dateNowSpy.mockReturnValueOnce(2000);
    registry.updateMetadata("123:42", second as any);

    expect(registry.listContexts()).toEqual([
      {
        contextKey: "123:42",
        threadId: "thread-b",
        workspace: "/workspace/b",
        model: "gpt-5.4",
        reasoningEffort: "high",
        launchProfileId: "default",
        updatedAt: 2000,
      },
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o4-mini",
        reasoningEffort: undefined,
        launchProfileId: "readonly",
        updatedAt: 1000,
      },
    ]);
  });

  it("persists the next selected launch profile when it differs from the active thread profile", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = (await registry.getOrCreate("123")) as any;

    session.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
      nextLaunchProfileId: "readonly",
      nextLaunchProfileLabel: "Read Only",
      nextLaunchProfileBehavior: "read-only / never",
      nextUnsafeLaunch: false,
    });
    registry.updateMetadata("123", session as any);

    expect(registry.listContexts()).toEqual([
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o3",
        reasoningEffort: undefined,
        launchProfileId: "readonly",
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("removes a context and disposes its session", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = await registry.getOrCreate("123");

    registry.updateMetadata("123", session as any);
    registry.remove("123");

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(registry.has("123")).toBe(false);
    expect(registry.listContexts()).toEqual([]);
  });

  it("persists metadata and reloads it in a new registry", async () => {
    const config = createConfig();
    const persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    const registry = new SessionRegistry(config);
    const session = (await registry.getOrCreate("123")) as any;

    session.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      reasoningEffort: "medium",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    registry.updateMetadata("123", session as any);

    expect(mockFsState.files.get(persistPath)).toContain("thread-a");

    const reloaded = new SessionRegistry(config);
    expect(reloaded.listContexts()).toEqual([
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o4-mini",
        reasoningEffort: "medium",
        launchProfileId: "default",
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("disposeAll disposes all sessions and clears the map", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("100");
    await registry.getOrCreate("200");

    expect(registry.has("100")).toBe(true);
    expect(registry.has("200")).toBe(true);

    registry.disposeAll();

    expect(registry.has("100")).toBe(false);
    expect(registry.has("200")).toBe(false);
    expect(mockSessionState.dependencies.turnManager.dispose).toHaveBeenCalledTimes(1);
    expect(mockSessionState.dependencies.client.close).toHaveBeenCalledTimes(1);
  });

  it("remove fires onRemove callback", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("100");
    const removed: string[] = [];
    registry.onRemove((key) => removed.push(key));

    registry.remove("100");

    expect(removed).toEqual(["100"]);
    expect(registry.has("100")).toBe(false);
  });
  it("starts a session with the workspace and launch profile a topic was set up with", async () => {
    const registry = new SessionRegistry(createConfig());

    registry.setContextDefaults("-100123:512", {
      workspace: "/workspace/billing",
      launchProfileId: "readonly",
    });

    await registry.getOrCreate("-100123:512");

    expect(mockSessionState.create).toHaveBeenCalledWith(
      createConfig(),
      expect.objectContaining({
        workspace: "/workspace/billing",
        launchProfileId: "readonly",
        resumeThreadId: undefined,
      }),
      mockSessionState.dependencies,
    );
  });

  it("applies new durable defaults to an already cached deferred session", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = await registry.getOrCreate("-100123:513", { deferThreadStart: true });

    registry.setContextDefaults("-100123:513", {
      workspace: "/workspace/sentry",
      launchProfileId: "readonly",
      topicName: "Sentry",
    });

    expect(session.applyDeferredDefaults).toHaveBeenCalledWith({
      workspace: "/workspace/sentry",
      launchProfileId: "readonly",
      topicName: "Sentry",
    });
    expect(session.getInfo()).toMatchObject({
      workspace: "/workspace/sentry", sandboxMode: "read-only",
    });
  });
});
