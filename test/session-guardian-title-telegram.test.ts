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

function snapshot(name = "Live title changed"): GuardianThreadSnapshot {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    threadStatus: "active",
    turnStatus: "inProgress",
    updatedAt: 1_723_000_000,
    itemCount: 2,
    lastItemType: "agentMessage",
    source: "cli",
    cwd: "/srv/projects/telecodex",
    name,
    canAcceptDirectInput: false,
    root: true,
  };
}

function alert(threadName?: string): GuardianAlert {
  return {
    id: ALERT_ID,
    fingerprint: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      updatedAt: 1_723_000_000,
      itemCount: 2,
      lastItemType: "agentMessage",
    },
    route: ROUTE,
    state: "open",
    deliveryState: "pending",
    statusDeliveryState: "none",
    createdAt: 1_723_000_600,
    ...(threadName === undefined ? {} : { threadName }),
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

async function renderBoth(threadName?: string): Promise<[string, string]> {
  const api = fakeApi();
  const notifier = new SessionGuardianTelegramNotifier(api);
  const pending = alert(threadName);
  const delivery = await notifier.sendAlert({
    alert: pending,
    snapshot: snapshot(),
    staleForMs: 61_000,
  });
  await notifier.editStatus({
    alert: {
      ...pending,
      state: "restored",
      deliveryState: "delivered",
      statusDeliveryState: "pending",
      messageId: 321,
    },
    delivery,
    status: { outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" },
  });
  return [api.sendMessage.mock.calls[0]![1], api.editMessageText.mock.calls[0]![2]];
}

describe("Guardian Telegram session titles", () => {
  it("uses the persisted escaped title in initial and terminal messages", async () => {
    const [initialText, terminalText] = await renderBoth("Persisted <title>");

    for (const text of [initialText, terminalText]) {
      expect(text).toContain("<b>Title:</b> Persisted &lt;title&gt;");
      expect(text).not.toContain("Live title changed");
      expect(text).not.toContain("<b>Name:</b>");
      expect(text.indexOf("Title:")).toBeLessThan(text.indexOf("Thread:"));
      expect(text).toContain(THREAD_ID);
    }
  });

  it("renders a stable fallback when the persisted title is missing", async () => {
    const [initialText, terminalText] = await renderBoth();
    expect(initialText).toContain("<b>Title:</b> Untitled");
    expect(terminalText).toContain("<b>Title:</b> Untitled");
  });

  it("truncates titles on Unicode code-point boundaries", async () => {
    const title = `${"🙂".repeat(170)}<unsafe>`;
    const [initialText, terminalText] = await renderBoth(title);

    for (const text of [initialText, terminalText]) {
      const titleLine = text.split("\n").find((line) => line.includes("Title:"));
      expect(titleLine).toBe(`<b>Title:</b> ${"🙂".repeat(159)}…`);
      expect(titleLine).not.toContain("<unsafe>");
    }
  });
});
