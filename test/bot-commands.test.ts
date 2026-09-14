import { describe, expect, it, vi } from "vitest";

import {
  bindSavedStatusTopics,
  deliverPromptError,
  deliverPromptSuccess,
  DISABLED_MODEL_SELECTION_CALLBACK_PATTERN,
  registerCommands,
  removeStatusBoardMessage,
  renderUsageReport,
  TELEGRAM_RETRY_OPTIONS,
} from "../src/bot.js";
import * as botModule from "../src/bot.js";

describe("status board Telegram policy", () => {
  it("invalidates a cached binding deleted from the registry", () => {
    const cache = new Map<string, number>();
    bindSavedStatusTopics([{ threadId: "A", messageThreadId: 42 }], cache);
    const rows = [{ threadId: "A", messageThreadId: undefined }];

    expect(bindSavedStatusTopics(rows, cache)).toBeUndefined();
    expect(rows[0].messageThreadId).toBeUndefined();
    expect(cache.has("A")).toBe(false);
  });

  it("moves a reassigned topic to its current registry owner", () => {
    const cache = new Map<string, number>();
    bindSavedStatusTopics([{ threadId: "A", messageThreadId: 42 }], cache);
    const rows = [
      { threadId: "A", messageThreadId: undefined },
      { threadId: "B", messageThreadId: 42 },
    ];

    bindSavedStatusTopics(rows, cache);

    expect(rows.map((row) => row.messageThreadId)).toEqual([undefined, 42]);
    expect(cache).toEqual(new Map([["B", 42]]));
  });

  it("replaces a binding changed for the same thread", () => {
    const cache = new Map<string, number>();
    bindSavedStatusTopics([{ threadId: "A", messageThreadId: 42 }], cache);
    const rows = [{ threadId: "A", messageThreadId: 43 }];

    bindSavedStatusTopics(rows, cache);

    expect(rows[0].messageThreadId).toBe(43);
    expect(cache).toEqual(new Map([["A", 43]]));
  });

  it("projects a defined binding across duplicate rows in the same snapshot", () => {
    const cache = new Map<string, number>();
    const rows = [
      { threadId: "A", messageThreadId: undefined },
      { threadId: "A", messageThreadId: 42 },
    ];

    bindSavedStatusTopics(rows, cache);

    expect(rows.map((row) => row.messageThreadId)).toEqual([42, 42]);
    expect(cache).toEqual(new Map([["A", 42]]));
  });

  it("propagates a rate limit while removing the legacy board", async () => {
    const rateLimit = {
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 20 },
    };
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(removeStatusBoardMessage(
      vi.fn().mockRejectedValue(rateLimit),
      remove,
    )).rejects.toBe(rateLimit);

    expect(remove).not.toHaveBeenCalled();
  });
});

describe("Telegram delivery policy", () => {
  it("accepts Telegram retry_after delays up to one minute", () => {
    expect(TELEGRAM_RETRY_OPTIONS).toEqual({
      maxRetryAttempts: 3,
      maxDelaySeconds: 60,
    });
  });

  it("delivers the final answer and images before completing progress", async () => {
    const calls: string[] = [];

    await deliverPromptSuccess({
      deliverResponse: async () => { calls.push("response"); },
      deliverImages: async () => { calls.push("images"); },
      completeProgress: async () => { calls.push("progress"); },
      onProgressError: vi.fn(),
    });

    expect(calls).toEqual(["response", "images", "progress"]);
  });

  it("keeps a delivered answer successful when the progress update fails", async () => {
    const progressError = new Error("429 Too Many Requests");
    const onProgressError = vi.fn();

    await expect(deliverPromptSuccess({
      deliverResponse: vi.fn().mockResolvedValue(undefined),
      deliverImages: vi.fn().mockResolvedValue(undefined),
      completeProgress: vi.fn().mockRejectedValue(progressError),
      onProgressError,
    })).resolves.toBeUndefined();

    expect(onProgressError).toHaveBeenCalledWith(progressError);
  });

  it("delivers an error before marking progress as failed", async () => {
    const calls: string[] = [];

    await deliverPromptError({
      deliverResponse: async () => { calls.push("error"); },
      failProgress: async () => { calls.push("progress"); },
      onDeliveryError: vi.fn(),
      onProgressError: vi.fn(),
    });

    expect(calls).toEqual(["error", "progress"]);
  });
});

describe("TeleCodex command menu", () => {
  it("exposes persistent task cards in the command menu", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    await registerCommands({ api: { setMyCommands } } as never);
    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "task", description: "Карточка задачи в этом топике" },
    ]));
  });
  it("registers /tickets for unresolved ticket navigation", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "tickets", description: "Незавершённые обращения Inbox" },
    ]));
  });

  it("registers /title as the manual ticket-topic fallback", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "title", description: "Переименовать топик тикета" },
    ]));
  });

  it("registers /usage for project token totals", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "usage", description: "Расход токенов по проектам" },
    ]));
  });

  it("does not register removed integration commands", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    const commands = setMyCommands.mock.calls[0]?.[0] as Array<{ command: string }>;
    expect(commands.map(({ command }) => command)).not.toContain("sentry");
  });

  it("does not register the disabled model picker", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    const commands = setMyCommands.mock.calls[0]?.[0] as Array<{ command: string }>;
    expect(commands.map(({ command }) => command)).not.toContain("model");
  });
});

describe("disabled model picker compatibility", () => {
  it.each([
    "jobmodel:0123456789ab:glm-53",
    "startmodel:glm-53",
    "model_glm-53",
  ])("recognizes stale callback %s", (callbackData) => {
    expect(DISABLED_MODEL_SELECTION_CALLBACK_PATTERN.test(callbackData)).toBe(true);
  });

  it("does not consume unrelated callbacks", () => {
    expect(DISABLED_MODEL_SELECTION_CALLBACK_PATTERN.test("effort_high")).toBe(false);
  });
});

describe("read-only implementation handoff", () => {
  it("blocks every text message while a session transition is in flight", () => {
    const shouldBlock = Reflect.get(botModule, "shouldBlockTextDuringSessionTransition") as
      | ((state: { switching: boolean }) => boolean)
      | undefined;
    expect(shouldBlock).toBeTypeOf("function");
    if (!shouldBlock) return;

    expect(shouldBlock({ switching: true })).toBe(true);
    expect(shouldBlock({ switching: false })).toBe(false);
  });

  it("forks only an explicit implementation authorization into the default writable profile", async () => {
    const handoff = Reflect.get(botModule, "maybeForkImplementationThread") as
      | ((input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    expect(handoff).toBeTypeOf("function");
    if (!handoff) return;

    const forkThread = vi.fn().mockResolvedValue({
      threadId: "thread-implementation",
      sandboxMode: "danger-full-access",
      launchProfileId: "default",
    });
    const session = {
      getInfo: () => ({ threadId: "thread-readonly", sandboxMode: "read-only" }),
      forkThread,
    };
    const profiles = [
      { id: "default", label: "Default", sandboxMode: "danger-full-access", approvalPolicy: "never", unsafe: true },
      { id: "readonly", label: "Read Only", sandboxMode: "read-only", approvalPolicy: "never", unsafe: false },
    ];

    await expect(handoff({
      text: "Приступай",
      session,
      launchProfiles: profiles,
      defaultLaunchProfileId: "default",
    })).resolves.toEqual(expect.objectContaining({ threadId: "thread-implementation" }));
    expect(forkThread).toHaveBeenCalledWith("default");

    forkThread.mockClear();
    await expect(handoff({
      text: "Надо бы это реализовать позже",
      session,
      launchProfiles: profiles,
      defaultLaunchProfileId: "default",
    })).resolves.toBeUndefined();
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("accepts a ticket label together with the authorization", async () => {
    const handoff = Reflect.get(botModule, "maybeForkImplementationThread") as
      | ((input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    expect(handoff).toBeTypeOf("function");
    if (!handoff) return;

    const forkThread = vi.fn().mockResolvedValue({ threadId: "thread-implementation" });
    await handoff({
      text: "NO-TICKET, делай",
      session: {
        getInfo: () => ({ threadId: "thread-readonly", sandboxMode: "read-only" }),
        forkThread,
      },
      launchProfiles: [
        { id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "never", unsafe: false },
      ],
      defaultLaunchProfileId: "default",
    });

    expect(forkThread).toHaveBeenCalledWith("default");
  });

  it.each(["Сделай", "Исправь", "implement"])("accepts explicit authorization %s", async (text) => {
    const handoff = Reflect.get(botModule, "maybeForkImplementationThread") as
      | ((input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    expect(handoff).toBeTypeOf("function");
    if (!handoff) return;

    const forkThread = vi.fn().mockResolvedValue({ threadId: "thread-implementation" });
    await handoff({
      text,
      session: {
        getInfo: () => ({ threadId: "thread-readonly", sandboxMode: "read-only" }),
        forkThread,
      },
      launchProfiles: [
        { id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "never", unsafe: false },
      ],
      defaultLaunchProfileId: "default",
    });

    expect(forkThread).toHaveBeenCalledWith("default");
  });

  it("does not treat ambiguous proceed as permission escalation", async () => {
    const handoff = Reflect.get(botModule, "maybeForkImplementationThread") as
      | ((input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    expect(handoff).toBeTypeOf("function");
    if (!handoff) return;

    const forkThread = vi.fn();
    await expect(handoff({
      text: "proceed",
      session: {
        getInfo: () => ({ threadId: "thread-readonly", sandboxMode: "read-only" }),
        forkThread,
      },
      launchProfiles: [
        { id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "never", unsafe: false },
      ],
      defaultLaunchProfileId: "default",
    })).resolves.toBeUndefined();
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("persists and dispatches before a best-effort handoff notification", async () => {
    const prepare = Reflect.get(botModule, "prepareImplementationHandoff") as
      | ((input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    expect(prepare).toBeTypeOf("function");
    if (!prepare) return;

    const calls: string[] = [];
    let finishPrompt!: () => void;
    const prompt = new Promise<void>((resolve) => {
      finishPrompt = () => {
        calls.push("prompt-finished");
        resolve();
      };
    });
    const result = await prepare({
      text: "Делай",
      session: {
        getInfo: () => ({ threadId: "thread-readonly", sandboxMode: "read-only" }),
        forkThread: vi.fn().mockImplementation(async () => {
          calls.push("fork");
          return { threadId: "thread-implementation", launchProfileBehavior: "danger-full-access / never" };
        }),
      },
      launchProfiles: [
        { id: "default", label: "Default", sandboxMode: "danger-full-access", approvalPolicy: "never", unsafe: true },
      ],
      defaultLaunchProfileId: "default",
      persistSession: () => { calls.push("metadata"); },
      dispatchPrompt: () => {
        calls.push("prompt-created");
        return prompt;
      },
      notify: async () => {
        calls.push("notify");
        throw new Error("Telegram unavailable");
      },
      onNotificationError: () => { calls.push("notify-error"); },
    });

    expect(result).toEqual(expect.objectContaining({ threadId: "thread-implementation" }));
    expect(calls.slice(0, 4)).toEqual(["fork", "metadata", "prompt-created", "notify"]);
    finishPrompt();
    await expect(Reflect.get(result!, "prompt")).resolves.toBeUndefined();
    await vi.waitFor(() => expect(calls).toContain("notify-error"));
  });

  it("refuses an implementation handoff when no writable profile is configured", async () => {
    const handoff = Reflect.get(botModule, "maybeForkImplementationThread") as
      | ((input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)
      | undefined;
    expect(handoff).toBeTypeOf("function");
    if (!handoff) return;

    await expect(handoff({
      text: "Делай",
      session: {
        getInfo: () => ({ threadId: "thread-readonly", sandboxMode: "read-only" }),
        forkThread: vi.fn(),
      },
      launchProfiles: [
        { id: "readonly", label: "Read Only", sandboxMode: "read-only", approvalPolicy: "never", unsafe: false },
      ],
      defaultLaunchProfileId: "readonly",
    })).rejects.toThrow("No writable launch profile");
  });
});

describe("usage report", () => {
  it("shows project totals and the weekly 80 percent warning", () => {
    const report = renderUsageReport([
      { workspace: "/work/alpha", inputTokens: 800, cachedInputTokens: 200, outputTokens: 100, totalTokens: 900, turns: 2 },
    ], 30, 1_000, 800);

    expect(report.html).toContain("За 30 дней");
    expect(report.html).toContain("/work/alpha");
    expect(report.html).toContain("Всего: 900");
    expect(report.html).toContain("80% недельного лимита");
    expect(report.plain).not.toContain("<code>");
  });

  it("shows an exceeded warning at the weekly limit", () => {
    const report = renderUsageReport([], 7, 1_000, 1_000);

    expect(report.html).toContain("Недельный лимит исчерпан");
  });
});

it("registers each command once with explicit session destination labels", async () => {
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  await registerCommands({ api: { setMyCommands } } as never);
  const commands = setMyCommands.mock.calls[0]![0] as Array<{ command: string; description: string }>;
  expect(new Set(commands.map(item => item.command)).size).toBe(commands.length);
  expect(commands).toEqual(expect.arrayContaining([
    { command: "topic", description: "Топик для сессии Codex по ID" },
    { command: "switch", description: "Сменить сессию в текущем контексте" },
    { command: "attach", description: "Привязать ID к текущему контексту" },
  ]));
});
