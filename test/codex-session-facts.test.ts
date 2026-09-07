import { vi } from "vitest";

import type { AppServerNotification } from "../src/app-server-client.js";
import type { AppServerTurnRequest } from "../src/app-server-turn-manager.js";
import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import {
  CodexSessionService,
  type CodexSessionCallbacks,
  type CodexSessionDependencies,
} from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

function config(): TeleCodexConfig {
  return {
    telegramBotToken: "token",
    telegramAllowedUserIds: [1],
    telegramAllowedUserIdSet: new Set([1]),
    workspace: "/workspace",
    maxFileSize: 1_000,
    modelChoices: [],
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
  } as TeleCodexConfig;
}

function dependencies(): CodexSessionDependencies & {
  runTurn: ReturnType<typeof vi.fn>;
  recoverTurn: ReturnType<typeof vi.fn>;
} {
  const runTurn = vi.fn<(request: AppServerTurnRequest) => Promise<void>>().mockResolvedValue(undefined);
  const recoverTurn = vi.fn<(request: AppServerTurnRequest, turnId: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  return {
    client: {
      connect: vi.fn(async () => undefined),
      request: vi.fn(async () => ({ thread: { id: "thread-1", status: { type: "idle" } } })),
      onNotification: (_listener: (notification: AppServerNotification) => void) => () => undefined,
      onDisconnect: (_listener: () => void) => () => undefined,
    },
    turnManager: { runTurn, recoverTurn },
    runTurn,
    recoverTurn,
  };
}

function callbacks(): CodexSessionCallbacks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onDispatching: vi.fn(),
    onDispatchWritten: vi.fn(),
    onActivity: vi.fn(),
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
  } as CodexSessionCallbacks & Record<string, ReturnType<typeof vi.fn>>;
}

describe("CodexSessionService fact forwarding", () => {
  it("forwards the latest bounded server turn identity when resuming a thread", async () => {
    const deps = dependencies();
    const trackThread = vi.fn();
    deps.turnManager.trackThread = trackThread;
    deps.client.request = vi.fn(async () => ({
      thread: {
        id: "thread-1",
        status: { type: "idle" },
        turns: [
          { id: "turn-exact", status: "completed" },
          { id: "x".repeat(513), status: "completed" },
        ],
      },
    }));

    await CodexSessionService.create(config(), { resumeThreadId: "thread-1" }, deps);

    expect(trackThread).toHaveBeenCalledWith("thread-1", "idle", "turn-exact");
  });

  it("forwards dispatch and activity facts through prompt", async () => {
    const deps = dependencies();
    deps.runTurn.mockImplementation(async (turn) => {
      turn.callbacks.onDispatching?.({ previousTurnId: null, attempt: 1 });
      turn.callbacks.onDispatchWritten?.();
      turn.callbacks.onActivity?.({ activity: "model", eventAt: 123, method: "item/agentMessage/delta" });
    });
    const service = await CodexSessionService.create(config(), undefined, deps);
    const observed = callbacks();

    await service.prompt("prompt", observed);

    expect(observed.onDispatching).toHaveBeenCalledWith({ previousTurnId: null, attempt: 1 });
    expect(observed.onDispatchWritten).toHaveBeenCalledOnce();
    expect(observed.onActivity).toHaveBeenCalledWith({
      activity: "model",
      eventAt: 123,
      method: "item/agentMessage/delta",
    });
  });

  it("forwards facts through recovery without inventing dispatch facts", async () => {
    const deps = dependencies();
    deps.recoverTurn.mockImplementation(async (turn) => {
      turn.callbacks.onActivity?.({ activity: "tool", eventAt: 456, method: "item/started" });
    });
    const service = await CodexSessionService.create(config(), undefined, deps);
    const observed = callbacks();

    await service.recoverPrompt("turn-existing", observed);

    expect(observed.onActivity).toHaveBeenCalledWith({
      activity: "tool",
      eventAt: 456,
      method: "item/started",
    });
    expect(observed.onDispatching).not.toHaveBeenCalled();
    expect(observed.onDispatchWritten).not.toHaveBeenCalled();
  });

  it.each(["onDispatching", "onDispatchWritten", "onActivity"] as const)(
    "isolates a throwing %s observer while prompting",
    async (callbackName) => {
      const deps = dependencies();
      deps.runTurn.mockImplementation(async (turn) => {
        if (callbackName === "onDispatching") {
          turn.callbacks.onDispatching?.({ previousTurnId: null, attempt: 1 });
        } else if (callbackName === "onDispatchWritten") {
          turn.callbacks.onDispatchWritten?.();
        } else {
          turn.callbacks.onActivity?.({ activity: "unknown", eventAt: 789, method: "turn/started" });
        }
      });
      const service = await CodexSessionService.create(config(), undefined, deps);
      const observed = callbacks();
      observed[callbackName] = vi.fn(() => { throw new Error("observer failure"); });

      await expect(service.prompt("prompt", observed)).resolves.toBeUndefined();
      expect(observed[callbackName]).toHaveBeenCalledOnce();
    },
  );
});
