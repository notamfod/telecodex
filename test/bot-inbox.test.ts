import { afterEach, describe, expect, it, vi } from "vitest";

import { registerInboxHandlers } from "../src/bot-inbox.js";

describe("registerInboxHandlers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers inbox commands, callbacks, and the message interceptor", () => {
    const commands: string[] = [];
    const callbacks: string[] = [];
    const events: string[] = [];
    const bot = {
      command: (command: string) => { commands.push(command); },
      callbackQuery: (pattern: RegExp) => { callbacks.push(pattern.source); },
      on: (event: string) => { events.push(event); },
      api: {},
    };

    registerInboxHandlers({
      bot: bot as never,
      config: { workspace: "/work", defaultLaunchProfileId: "default" } as never,
      registry: {} as never,
      inbox: {} as never,
      topicActivity: { rememberIdleIcon: vi.fn() },
      getContextSession: vi.fn(),
      isBusy: vi.fn(),
      handleTicketPrompt: vi.fn(),
      topicIsAlive: vi.fn(),
      sendText: vi.fn(),
      safeReply: vi.fn(),
    });

    expect(commands).toEqual(["inbox", "tickets", "title"]);
    expect(callbacks).toEqual([
      "^inbox_batch:(\\d+):(one|each|cancel)$",
      "^ticket_dup:(\\d+):(reuse|new)$",
      "^ticket_start:(\\d+)$",
      "^jira_post:(\\d+)$",
      "^ticket_done:(\\d+)$",
    ]);
    expect(events).toEqual(["message"]);
  });

  it("durably accepts a ticket callback before marking it started or opening a session", async () => {
    const callbacks = new Map<string, (ctx: any) => Promise<void>>();
    const bot = {
      command: vi.fn(),
      callbackQuery: (pattern: RegExp, handler: (ctx: any) => Promise<void>) => {
        callbacks.set(pattern.source, handler);
      },
      on: vi.fn(),
      api: {},
    };
    const ticket = {
      id: 7,
      inboxContextKey: "-1001:7",
      workTopicId: 7,
      workspace: "/work",
      launchProfileId: "default",
      prompt: "Investigate ticket safely",
      source: "telegram",
      createdAt: 1,
    };
    const markStarted = vi.fn(() => { (ticket as typeof ticket & { startedAt?: number }).startedAt = 2; });
    const accept = vi.fn(async () => undefined);
    const getContextSession = vi.fn(async () => { throw new Error("session must not open"); });
    const setContextDefaults = vi.fn();

    registerInboxHandlers({
      bot: bot as never,
      config: { workspace: "/work", defaultLaunchProfileId: "default" } as never,
      registry: { listContexts: vi.fn(() => []), setContextDefaults } as never,
      inbox: {
        getTicket: vi.fn(() => ticket),
        get: vi.fn(() => ({ launchProfileId: "full-access", realm: "mircli" })),
        markStarted,
      } as never,
      topicActivity: { rememberIdleIcon: vi.fn() },
      getContextSession,
      isBusy: vi.fn(),
      handleTicketPrompt: vi.fn(),
      handleCanonicalTicketPrompt: accept,
      topicIsAlive: vi.fn(),
      sendText: vi.fn(),
      safeReply: vi.fn(),
    });
    const ctx = {
      match: ["ticket_start:7", "7"],
      chat: { id: -1001 },
      callbackQuery: { message: { message_thread_id: 7 } },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    };

    await callbacks.get("^ticket_start:(\\d+)$")!(ctx);

    expect(accept).toHaveBeenCalledWith(ctx, expect.objectContaining({
      id: ticket.id,
      launchProfileId: "full-access",
      prompt: expect.stringContaining("используй все подходящие доступные инструменты"),
    }));
    expect(accept.mock.calls[0]?.[1].prompt).toContain("dofbox --realm mircli");
    expect(setContextDefaults).toHaveBeenCalledWith("-1001:7", {
      workspace: "/work",
      launchProfileId: "full-access",
    });
    expect(accept.mock.invocationCallOrder[0]).toBeLessThan(markStarted.mock.invocationCallOrder[0]);
    expect(getContextSession).not.toHaveBeenCalled();
  });

  it("repairs a stale started flag without launching a second analysis for a bound thread", async () => {
    const callbacks = new Map<string, (ctx: any) => Promise<void>>();
    const bot = {
      command: vi.fn(),
      callbackQuery: (pattern: RegExp, handler: (ctx: any) => Promise<void>) => {
        callbacks.set(pattern.source, handler);
      },
      on: vi.fn(),
      api: {},
    };
    const ticket = {
      id: 9,
      inboxContextKey: "-1001:3",
      workTopicId: 11,
      workspace: "/work",
      launchProfileId: "default",
      prompt: "Investigate",
      source: "telegram",
      createdAt: 1,
    };
    const markStarted = vi.fn(() => { (ticket as typeof ticket & { startedAt?: number }).startedAt = 2; });
    const accept = vi.fn(async () => undefined);
    const ctx = {
      match: ["ticket_start:9", "9"],
      chat: { id: -1001 },
      callbackQuery: { message: { message_thread_id: 11 } },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    };

    registerInboxHandlers({
      bot: bot as never,
      config: { workspace: "/work", defaultLaunchProfileId: "default" } as never,
      registry: {
        listContexts: vi.fn(() => [{ contextKey: "-1001:11", threadId: "thread-existing" }]),
        setContextDefaults: vi.fn(),
      } as never,
      inbox: { getTicket: vi.fn(() => ticket), get: vi.fn(() => undefined), markStarted } as never,
      topicActivity: { rememberIdleIcon: vi.fn() },
      getContextSession: vi.fn(),
      isBusy: vi.fn(),
      handleTicketPrompt: vi.fn(),
      handleCanonicalTicketPrompt: accept,
      topicIsAlive: vi.fn(),
      sendText: vi.fn(),
      safeReply: vi.fn(),
    });

    await callbacks.get("^ticket_start:(\\d+)$")!(ctx);

    expect(markStarted).toHaveBeenCalledWith(9);
    expect(accept).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Разбор уже запускали" });
  });

  it.each([
    ["a probe timeout", new Error("Telegram topic probe timed out")],
    ["a Telegram 429", new Error("429: Too Many Requests: retry after 1")],
  ])("does not offer a replacement topic after %s", async (_label, probeError) => {
    vi.useFakeTimers();
    let messageHandler!: (ctx: any, next: () => Promise<void>) => Promise<void>;
    const createForumTopic = vi.fn();
    const bot = {
      command: vi.fn(),
      callbackQuery: vi.fn(),
      on: (event: string, handler: typeof messageHandler) => {
        if (event === "message") messageHandler = handler;
      },
      api: { createForumTopic },
    };
    const sendText = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = {
      id: 7,
      externalKey: "MIR-123",
      inboxContextKey: "-1001:7",
      workTopicId: 41,
      workspace: "/work",
      prompt: "Investigate",
      source: "telegram",
      createdAt: 1,
    };

    registerInboxHandlers({
      bot: bot as never,
      config: { workspace: "/work", defaultLaunchProfileId: "default" } as never,
      registry: {} as never,
      inbox: {
        get: vi.fn(() => ({ workspace: "/work", template: "{message}" })),
        listTicketsByKey: vi.fn(() => [previous]),
      } as never,
      topicActivity: { rememberIdleIcon: vi.fn() },
      getContextSession: vi.fn(),
      isBusy: vi.fn(),
      handleTicketPrompt: vi.fn(),
      topicIsAlive: vi.fn().mockRejectedValue(probeError),
      sendText,
      safeReply: vi.fn(),
    });

    await messageHandler({
      chat: { id: -1001 },
      message: {
        message_id: 10,
        message_thread_id: 7,
        text: "MIR-123 повторное обращение",
      },
    }, vi.fn(async () => undefined));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendText.mock.calls.some(([, text]) =>
      String(text).includes("активного рабочего топика у него нет")
    )).toBe(false);
    expect(createForumTopic).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Inbox burst failed:", expect.any(String));
  });
});
