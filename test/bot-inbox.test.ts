import { describe, expect, it, vi } from "vitest";

import { registerInboxHandlers } from "../src/bot-inbox.js";

describe("registerInboxHandlers", () => {
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

    expect(commands).toEqual(["inbox", "tickets", "title", "sentry"]);
    expect(callbacks).toEqual([
      "^inbox_batch:(\\d+):(one|each|cancel)$",
      "^ticket_dup:(\\d+):(reuse|new)$",
      "^ticket_start:(\\d+)$",
      "^jira_post:(\\d+)$",
      "^ticket_done:(\\d+)$",
    ]);
    expect(events).toEqual(["message"]);
  });
});
