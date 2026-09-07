import { describe, expect, it, vi } from "vitest";

import {
  SessionGuardianTelegramNotifier,
  type GuardianTelegramApi,
  type GuardianTelegramDelivery,
} from "../src/session-guardian-telegram.js";
import type { GuardianAlert } from "../src/session-guardian-store.js";
import type {
  GuardianAlertState,
  GuardianRepairResult,
  GuardianThreadSnapshot,
} from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";
const ALERT_ID = "abcdefghijklmnopqrstuv";
const ROUTE = { chatId: -1_001_234_567_890, messageThreadId: 42 };

function snapshot(
  overrides: Partial<GuardianThreadSnapshot> = {},
): GuardianThreadSnapshot {
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
    threadName: "Guardian integration",
    createdAt: 1_723_000_600,
    ...overrides,
  };
}

function fakeApi(messageId = 321): GuardianTelegramApi & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn(async () => ({ message_id: messageId })),
    editMessageText: vi.fn(async () => ({ ok: true })),
  };
}

async function deliver(
  notifier: SessionGuardianTelegramNotifier,
  alertValue = alert(),
): Promise<GuardianTelegramDelivery> {
  return notifier.sendAlert({
    alert: alertValue,
    snapshot: snapshot(),
    staleForMs: 3_661_999,
  });
}

describe("SessionGuardianTelegramNotifier", () => {
  it("renders the operational alert and routes it to the matched topic", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);

    await expect(deliver(notifier)).resolves.toEqual({
      alertId: ALERT_ID,
      chatId: ROUTE.chatId,
      messageThreadId: ROUTE.messageThreadId,
      messageId: 321,
    });

    expect(api.sendMessage).toHaveBeenCalledOnce();
    const [chatId, text, options] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(ROUTE.chatId);
    expect(text).toContain("Guardian integration");
    expect(text).toContain(THREAD_ID);
    expect(text).toContain("cli");
    expect(text).toContain("/srv/projects/telecodex");
    expect(text).toContain("1h 1m 1s");
    expect(text).toContain("agentMessage");
    expect(options).toMatchObject({
      parse_mode: "HTML",
      message_thread_id: 42,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{
          text: "Restore",
          callback_data: `guardian_restore:${ALERT_ID}`,
        }]],
      },
    });
  });

  it("omits message_thread_id entirely for a non-topic route", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);
    const value = alert({ route: { chatId: ROUTE.chatId } });

    const delivery = await notifier.sendAlert({
      alert: value,
      snapshot: snapshot(),
      staleForMs: 0,
    });

    expect(delivery).toEqual({
      alertId: ALERT_ID,
      chatId: ROUTE.chatId,
      messageId: 321,
    });
    const options = api.sendMessage.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).not.toHaveProperty("message_thread_id");
    expect(Object.values(options)).not.toContain(undefined);
  });

  it.each([
    ["thread", snapshot({ threadId: "019ff4ea-8c36-7c5f-8f08-030303030303" })],
    ["turn", snapshot({ turnId: "019ff4ea-8c36-7c5f-8f08-030303030303" })],
    ["updated time", snapshot({ updatedAt: 1_723_000_001 })],
    ["item count", snapshot({ itemCount: 8 })],
    ["last item", snapshot({ lastItemType: "toolCall" })],
    ["inactive state", snapshot({ threadStatus: "idle" })],
    ["non-root thread", snapshot({ root: false })],
  ])("rejects a %s mismatch before calling Telegram", async (_field, value) => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);

    await expect(notifier.sendAlert({ alert: alert(), snapshot: value, staleForMs: 1_000 }))
      .rejects.toThrow(/match|eligible/i);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["alert ID", alert({ id: `${THREAD_ID}` })],
    ["zero chat ID", alert({ route: { chatId: 0 } })],
    ["unsafe chat ID", alert({ route: { chatId: Number.MAX_SAFE_INTEGER } })],
    ["fractional topic ID", alert({ route: { chatId: -100, messageThreadId: 1.5 } })],
    ["oversized topic ID", alert({ route: { chatId: -100, messageThreadId: 2_147_483_648 } })],
  ])("rejects an invalid %s before calling Telegram", async (_field, value) => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);

    await expect(notifier.sendAlert({ alert: value, snapshot: snapshot(), staleForMs: 1_000 }))
      .rejects.toThrow();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN])(
    "rejects invalid Telegram message_id %s",
    async (messageId) => {
      const api = fakeApi(messageId);
      const notifier = new SessionGuardianTelegramNotifier(api);

      await expect(deliver(notifier)).rejects.toThrow(/message_id/);
      expect(api.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it("accepts the signed int32 maximum topic ID", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);

    await notifier.sendAlert({
      alert: alert({ route: { chatId: ROUTE.chatId, messageThreadId: 2_147_483_647 } }),
      snapshot: snapshot(),
      staleForMs: 1_000,
    });

    expect(api.sendMessage.mock.calls[0]![2]).toMatchObject({
      message_thread_id: 2_147_483_647,
    });
  });

  it("puts only the opaque alert ID in callback data", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);

    await deliver(notifier);

    const options = api.sendMessage.mock.calls[0]![2] as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    const callback = options.reply_markup.inline_keyboard[0]![0]!.callback_data;
    expect(callback).toBe(`guardian_restore:${ALERT_ID}`);
    expect(callback).not.toContain(THREAD_ID);
    expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
  });

  it.each<[
    string,
    "checking" | "no-longer-eligible" | GuardianRepairResult,
    string,
    GuardianAlertState,
    boolean,
  ]>([
    ["checking", "checking", "Checking", "checking", true],
    ["restored", { outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" }, "Restored", "restored", false],
    ["self-recovered", { outcome: "self-recovered", threadId: THREAD_ID, detail: "Thread progressed or became idle" }, "Self-recovered", "self-recovered", false],
    ["no-longer-eligible", "no-longer-eligible", "No longer eligible", "expired", false],
    ["expired", { outcome: "expired", threadId: THREAD_ID, detail: "Alert not found" }, "No longer eligible", "expired", false],
    ["repair-disabled", { outcome: "repair-disabled", threadId: THREAD_ID, detail: "Repair is disabled" }, "Repair disabled", "open", true],
    ["observation-only", { outcome: "observation-only", threadId: THREAD_ID, detail: "Observation-only mode" }, "Observation only", "checking", true],
    ["failed", { outcome: "failed", threadId: THREAD_ID, detail: "Wait for idle failed" }, "Failed", "failed", false],
  ])("edits the same alert message for %s", async (
    _name, status, expected, alertState, preservesRestore,
  ) => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);
    const alertValue = alert();
    const delivery = await deliver(notifier, alertValue);
    const currentAlert = alert({
      state: alertState,
      deliveryState: "delivered",
      messageId: delivery.messageId,
    });

    await notifier.editStatus({ alert: currentAlert, delivery, status });

    expect(api.editMessageText).toHaveBeenCalledOnce();
    const [chatId, messageId, text, options] = api.editMessageText.mock.calls[0]!;
    expect(chatId).toBe(ROUTE.chatId);
    expect(messageId).toBe(321);
    expect(text).toContain(THREAD_ID);
    expect(text).toContain(expected);
    expect(options).toMatchObject({
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: preservesRestore
        ? { inline_keyboard: [[{ text: "Restore", callback_data: `guardian_restore:${ALERT_ID}` }]] }
        : { inline_keyboard: [] },
    });
    expect(options).not.toHaveProperty("message_thread_id");
  });

  it("rejects a delivery route, alert, or result mismatch without editing", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);
    const alertValue = alert();
    const delivery = await deliver(notifier, alertValue);

    const checkingAlert = alert({
      state: "checking",
      deliveryState: "delivered",
      messageId: delivery.messageId,
    });
    await expect(notifier.editStatus({
      alert: checkingAlert,
      delivery: { ...delivery, messageThreadId: 43 },
      status: "checking",
    })).rejects.toThrow(/delivery|route/i);
    await expect(notifier.editStatus({
      alert: checkingAlert,
      delivery: { ...delivery, alertId: "zyxwvutsrqponmlkjihgfe" },
      status: "checking",
    })).rejects.toThrow(/delivery|alert/i);
    await expect(notifier.editStatus({
      alert: checkingAlert,
      delivery,
      status: {
        outcome: "observation-only",
        threadId: "019ff4ea-8c36-7c5f-8f08-030303030303",
        detail: "Observation-only mode",
      },
    })).rejects.toThrow(/thread/i);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("does not render an arbitrary upstream failure detail", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);
    const alertValue = alert();
    const delivery = await deliver(notifier, alertValue);

    await notifier.editStatus({
      alert: alert({ state: "failed", deliveryState: "delivered", messageId: delivery.messageId }),
      delivery,
      status: {
        outcome: "failed",
        threadId: THREAD_ID,
        detail: "request failed with BOT_TOKEN_DO_NOT_RENDER at /secret/path",
      },
    });

    const text = api.editMessageText.mock.calls[0]![2] as string;
    expect(text).toContain("Operational check failed");
    expect(text).not.toMatch(/BOT_TOKEN|secret\/path/);
  });

  it.each<[
    GuardianAlertState,
    "checking" | "no-longer-eligible" | GuardianRepairResult,
  ]>([
    ["open", "checking"],
    ["restored", { outcome: "failed", threadId: THREAD_ID, detail: "Wait for idle failed" }],
    ["open", "no-longer-eligible"],
    ["failed", { outcome: "observation-only", threadId: THREAD_ID, detail: "Observation-only mode" }],
  ])("rejects contradictory persisted state %s and rendered status", async (state, status) => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);
    const current = alert({ state, deliveryState: "delivered", messageId: 321 });

    await expect(notifier.editStatus({
      alert: current,
      delivery: {
        alertId: ALERT_ID,
        chatId: ROUTE.chatId,
        messageThreadId: ROUTE.messageThreadId,
        messageId: 321,
      },
      status,
    })).rejects.toThrow(/state|status/i);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("treats Telegram's message-is-not-modified response as idempotent success", async () => {
    const api = fakeApi();
    api.editMessageText
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("Bad Request: MESSAGE IS NOT MODIFIED"));
    const notifier = new SessionGuardianTelegramNotifier(api);
    const current = alert({ state: "checking", deliveryState: "delivered", messageId: 321 });
    const input = {
      alert: current,
      delivery: {
        alertId: ALERT_ID,
        chatId: ROUTE.chatId,
        messageThreadId: ROUTE.messageThreadId,
        messageId: 321,
      },
      status: "checking" as const,
    };

    await expect(notifier.editStatus(input)).resolves.toBeUndefined();
    await expect(notifier.editStatus(input)).resolves.toBeUndefined();
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("recognizes only safe message-is-not-modified error fields", async () => {
    const safeApi = fakeApi();
    safeApi.editMessageText.mockRejectedValue({
      description: "Bad Request: message is not modified",
    });
    const current = alert({ state: "checking", deliveryState: "delivered", messageId: 321 });
    const input = {
      alert: current,
      delivery: {
        alertId: ALERT_ID,
        chatId: ROUTE.chatId,
        messageThreadId: ROUTE.messageThreadId,
        messageId: 321,
      },
      status: "checking" as const,
    };
    await expect(new SessionGuardianTelegramNotifier(safeApi).editStatus(input))
      .resolves.toBeUndefined();

    const getter = vi.fn(() => "message is not modified");
    const coercion = vi.fn(() => "message is not modified");
    const hostile = { get description() { return getter(); }, toString: coercion };
    const hostileApi = fakeApi();
    hostileApi.editMessageText.mockRejectedValue(hostile);
    await expect(new SessionGuardianTelegramNotifier(hostileApi).editStatus(input))
      .rejects.toBe(hostile);
    expect(getter).not.toHaveBeenCalled();
    expect(coercion).not.toHaveBeenCalled();
  });

  it("propagates send and edit failures without retrying them", async () => {
    const sendFailure = new Error("send unavailable");
    const sendApi = fakeApi();
    sendApi.sendMessage.mockRejectedValue(sendFailure);
    const sendNotifier = new SessionGuardianTelegramNotifier(sendApi);

    await expect(deliver(sendNotifier)).rejects.toBe(sendFailure);
    expect(sendApi.sendMessage).toHaveBeenCalledOnce();

    const editFailure = new Error("edit unavailable");
    const editApi = fakeApi();
    editApi.editMessageText.mockRejectedValue(editFailure);
    const editNotifier = new SessionGuardianTelegramNotifier(editApi);
    const alertValue = alert();
    const delivery = await deliver(editNotifier, alertValue);

    await expect(editNotifier.editStatus({
      alert: alert({ state: "checking", deliveryState: "delivered", messageId: delivery.messageId }),
      delivery,
      status: "checking",
    })).rejects.toBe(editFailure);
    expect(editApi.editMessageText).toHaveBeenCalledOnce();
  });

  it("keeps text and callback within Telegram limits without broken Unicode or HTML", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);
    const huge = `${"😀".repeat(5_000)}${"<&".repeat(5_000)}`;
    const value = snapshot({ name: huge, cwd: huge, source: huge, lastItemType: huge });
    const alertValue = alert({
      fingerprint: { ...alert().fingerprint, lastItemType: huge },
    });

    await notifier.sendAlert({ alert: alertValue, snapshot: value, staleForMs: 1_000 });

    const text = api.sendMessage.mock.calls[0]![1] as string;
    const options = api.sendMessage.mock.calls[0]![2] as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(text.match(/&/g)?.length ?? 0).toBe(
      (text.match(/&(?:amp|lt|gt);/g) ?? []).length,
    );
    expect(Buffer.byteLength(
      options.reply_markup.inline_keyboard[0]![0]!.callback_data,
      "utf8",
    )).toBeLessThanOrEqual(64);
  });

  it("replaces lone surrogates before truncating and keeps valid pairs", async () => {
    const api = fakeApi();
    const notifier = new SessionGuardianTelegramNotifier(api);

    await notifier.sendAlert({
      alert: alert({ threadName: "before\uD800after 😀" }),
      snapshot: snapshot({ name: "before\uD800after 😀" }),
      staleForMs: 1_000,
    });

    const text = api.sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain("before�after 😀");
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
