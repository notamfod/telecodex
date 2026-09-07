import { describe, expect, it, vi } from "vitest";

import {
  SessionGuardianTelegramNotifier,
  type GuardianTelegramApi,
} from "../src/session-guardian-telegram.js";
import type { GuardianAlert } from "../src/session-guardian-store.js";
import type { GuardianThreadSnapshot } from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";
const ALERT_ID = "abcdefghijklmnopqrstuv";
const ROUTE = { chatId: -1_001_234_567_890, messageThreadId: 42 };

function snapshot(overrides: Partial<GuardianThreadSnapshot> = {}): GuardianThreadSnapshot {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    threadStatus: "active",
    turnStatus: "inProgress",
    updatedAt: 1_723_000_000,
    itemCount: 7,
    lastItemType: "agentMessage",
    source: "cli",
    cwd: "/srv/projects/telecodex",
    name: "Guardian integration",
    canAcceptDirectInput: false,
    root: true,
    ...overrides,
  };
}

function alert(overrides: Partial<GuardianAlert> = {}): GuardianAlert {
  return {
    id: ALERT_ID,
    fingerprint: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      updatedAt: 1_723_000_000,
      itemCount: 7,
      lastItemType: "agentMessage",
    },
    route: ROUTE,
    state: "open",
    deliveryState: "pending",
    statusDeliveryState: "none",
    createdAt: 1_723_000_600,
    ...overrides,
  };
}

function fakeApi(): GuardianTelegramApi & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 321 })),
    editMessageText: vi.fn(async () => ({ ok: true })),
  };
}

describe("SessionGuardianTelegramNotifier safety boundaries", () => {
  it("escapes fields and excludes conversation and arbitrary source object data", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);
    const hostile = snapshot({
      name: "<b>name & owner</b>",
      cwd: "/repo/<admin>&secret",
      source: {
        custom: "telecodex-secret-token",
        token: "BOT_TOKEN_DO_NOT_RENDER",
        nested: { prompt: "PRIVATE_PROMPT" },
      },
      lastItemType: "tool<call>&result",
    }) as GuardianThreadSnapshot & Record<string, unknown>;
    hostile.preview = "PRIVATE_PREVIEW";
    hostile.prompt = "PRIVATE_PROMPT";
    hostile.response = "PRIVATE_RESPONSE";
    hostile.items = [{ tool_output: "PRIVATE_TOOL_OUTPUT" }];
    const value = alert({
      fingerprint: { ...alert().fingerprint, lastItemType: "tool<call>&result" },
      threadName: "<b>name & owner</b>",
    });

    await notifier.sendAlert({ alert: value, snapshot: hostile, staleForMs: 61_000 });

    const text = api.sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain("&lt;b&gt;name &amp; owner&lt;/b&gt;");
    expect(text).toContain("/repo/&lt;admin&gt;&amp;secret");
    expect(text).toContain("tool&lt;call&gt;&amp;result");
    expect(text).toContain("unknown");
    expect(text).not.toMatch(/<b>name|telecodex-secret-token|BOT_TOKEN|PRIVATE_/);
  });

  it.each([
    ["cli", "cli"],
    ["vscode", "cli"],
    ["exec", "cli"],
    ["appServer", "app-server"],
    [{ custom: "telecodex" }, "telecodex"],
    [{ subAgent: {} }, "subagent"],
    [{ subAgent: null }, "unknown"],
    [{ subAgent: undefined }, "unknown"],
    ["SECRET_SOURCE_STRING", "unknown"],
    [123_456, "unknown"],
    [true, "unknown"],
    [{ custom: "SECRET_OBJECT_VALUE" }, "unknown"],
  ])("maps source %j to safe category %s", async (source, expected) => {
    const api = fakeApi();
    await new SessionGuardianTelegramNotifier(api).sendAlert({
      alert: alert(),
      snapshot: snapshot({ source }),
      staleForMs: 1_000,
    });
    const text = api.sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain(`<b>Source:</b> ${expected}`);
    expect(text).not.toMatch(/SECRET_|123456|true/);
  });

  it("does not invoke getters while categorizing an object source", async () => {
    const getter = vi.fn(() => "telecodex");
    const source = {};
    Object.defineProperty(source, "custom", { enumerable: true, get: getter });
    const api = fakeApi();

    await new SessionGuardianTelegramNotifier(api).sendAlert({
      alert: alert(), snapshot: snapshot({ source }), staleForMs: 1_000,
    });

    expect(getter).not.toHaveBeenCalled();
    expect(api.sendMessage.mock.calls[0]![1]).toContain("<b>Source:</b> unknown");
  });

  it("rejects non-string IDs without coercion", async () => {
    const coercion = vi.fn(() => ALERT_ID);
    const maliciousId = { toString: coercion, [Symbol.toPrimitive]: coercion };
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);

    await expect(notifier.sendAlert({
      alert: alert({ id: maliciousId as unknown as string }),
      snapshot: snapshot(),
      staleForMs: 1_000,
    })).rejects.toThrow(/alert id/i);
    await expect(notifier.editStatus({
      alert: alert({ state: "checking", deliveryState: "delivered", messageId: 321 }),
      delivery: {
        alertId: maliciousId as unknown as string,
        chatId: ROUTE.chatId,
        messageThreadId: ROUTE.messageThreadId,
        messageId: 321,
      },
      status: "checking",
    })).rejects.toThrow(/delivery/i);
    expect(coercion).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("returns the captured target when caller input mutates during send", async () => {
    let resolveSend!: (value: { message_id: number }) => void;
    const api = fakeApi();
    api.sendMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
    const notifier = new SessionGuardianTelegramNotifier(api);
    const mutable = alert({ route: { ...ROUTE } });

    const pending = notifier.sendAlert({ alert: mutable, snapshot: snapshot(), staleForMs: 1_000 });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    (mutable as { id: string }).id = "zyxwvutsrqponmlkjihgfe";
    (mutable as { route: GuardianAlert["route"] }).route = { chatId: -999, messageThreadId: 99 };
    resolveSend({ message_id: 321 });

    await expect(pending).resolves.toEqual({
      alertId: ALERT_ID,
      chatId: ROUTE.chatId,
      messageThreadId: ROUTE.messageThreadId,
      messageId: 321,
    });
    expect(api.sendMessage.mock.calls[0]![2]).toMatchObject({
      message_thread_id: ROUTE.messageThreadId,
      reply_markup: { inline_keyboard: [[{
        callback_data: `guardian_restore:${ALERT_ID}`,
      }]] },
    });
  });
});
