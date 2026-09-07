import { vi } from "vitest";

import {
  StatusBoard,
  type RenderedMessage,
  type StatusSnapshot,
} from "../src/status-board.js";

const CHAT_ID = -1001234567890;
const NOW = Date.UTC(2026, 7, 13, 6, 41, 0);
const minutes = (count: number): number => count * 60_000;

const emptySnapshot = (overrides: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  limit: 8,
  telegramActive: 0,
  running: [],
  queued: [],
  recent: [],
  recentThreads: [],
  recentThreadCount: 0,
  codexAvailable: true,
  failedJobs24h: 0,
  now: NOW,
  ...overrides,
});

const task = (overrides: Partial<StatusSnapshot["running"][number]> = {}) => ({
  threadId: "thread-running",
  label: "MIR-6319 оплата",
  workspace: "/srv/projects/mir-back",
  source: "телеграм",
  since: NOW - minutes(4),
  children: [],
  ...overrides,
});

class FakeTelegram {
  readonly createTopic = vi.fn<() => Promise<number>>().mockResolvedValue(42);
  readonly send = vi.fn<(threadId: number, message: RenderedMessage) => Promise<number>>().mockResolvedValue(777);
  readonly edit = vi.fn<(threadId: number, id: number, message: RenderedMessage) => Promise<void>>().mockResolvedValue(undefined);
  readonly pin = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
  readonly closeTopic = vi.fn<(threadId: number) => Promise<void>>().mockResolvedValue(undefined);
  readonly reopenTopic = vi.fn<(threadId: number) => Promise<void>>().mockResolvedValue(undefined);
  readonly unpin = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
  readonly removeMessage = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
  readonly remove = vi.fn(async (
    id: number,
    backgroundWrite: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<void> => {
    await backgroundWrite(() => this.unpin(id));
    await backgroundWrite(() => this.removeMessage(id));
  });
  readonly deleteMessage = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
}

interface FakeLocation {
  messageThreadId?: number;
  messageId?: number;
  legacyMessageId?: number;
}

const createStore = (initial: FakeLocation = {}) => {
  let state = initial;
  return {
    read: () => state,
    write: (value: FakeLocation) => {
      state = value;
    },
  };
};

const createBoard = (
  telegram: FakeTelegram,
  collect: () => Promise<StatusSnapshot>,
  store = createStore(),
  logger = { warn: vi.fn() },
  now: () => number = () => NOW,
  miniAppLaunchUrl?: string,
  backgroundWriteGate?: {
    run<T>(chatId: number, priority: "ordinary" | "urgent", operation: () => Promise<T>): Promise<T>;
  },
): StatusBoard => new StatusBoard({
  chatId: CHAT_ID,
  intervalMs: 30_000,
  collect,
  createTopic: telegram.createTopic,
  send: telegram.send,
  edit: telegram.edit,
  pin: telegram.pin,
  closeTopic: telegram.closeTopic,
  reopenTopic: telegram.reopenTopic,
  remove: telegram.remove,
  deleteMessage: telegram.deleteMessage,
  store,
  now,
  logger,
  miniAppLaunchUrl,
  backgroundWriteGate,
});

describe("StatusBoard lifecycle", () => {
  it("creates a Dashboard topic, posts the board there, pins it and closes the topic", async () => {
    const telegram = new FakeTelegram();
    const board = createBoard(telegram, async () => emptySnapshot());

    expect(await board.refreshOnce()).toBe("sent");
    expect(telegram.createTopic).toHaveBeenCalledOnce();
    expect(telegram.send).toHaveBeenCalledWith(42, expect.any(Object));
    expect(telegram.pin).toHaveBeenCalledWith(777);
    expect(telegram.closeTopic).toHaveBeenCalledWith(42);
  });

  it("routes every physical Dashboard write through one ordinary per-chat gate", async () => {
    const telegram = new FakeTelegram();
    const physicalOperations: string[] = [];
    let insideGate = 0;
    const backgroundWriteGate = {
      run: vi.fn(async <T>(
        chatId: number,
        priority: "ordinary" | "urgent",
        operation: () => Promise<T>,
      ): Promise<T> => {
        expect(chatId).toBe(CHAT_ID);
        expect(priority).toBe("ordinary");
        insideGate += 1;
        try { return await operation(); }
        finally { insideGate -= 1; }
      }),
    };
    const physical = <T>(name: string, value: T) => async (): Promise<T> => {
      expect(insideGate).toBe(1);
      physicalOperations.push(name);
      return value;
    };
    telegram.createTopic.mockImplementation(physical("createTopic", 42));
    telegram.send.mockImplementation(physical("send", 777));
    telegram.edit.mockImplementation(physical("edit", undefined));
    telegram.pin.mockImplementation(physical("pin", undefined));
    telegram.closeTopic.mockImplementation(physical("closeTopic", undefined));
    telegram.reopenTopic.mockImplementation(physical("reopenTopic", undefined));
    telegram.unpin.mockImplementation(physical("unpin", undefined));
    telegram.removeMessage.mockImplementation(physical("removeMessage", undefined));
    telegram.deleteMessage.mockImplementation(physical("deleteMessage", undefined));
    let snapshot = emptySnapshot();
    const collect = vi.fn(async () => {
      expect(insideGate).toBe(0);
      return snapshot;
    });
    const board = createBoard(
      telegram,
      collect,
      createStore({ messageId: 555 }),
      { warn: vi.fn() },
      () => NOW,
      undefined,
      backgroundWriteGate,
    );

    await board.refreshOnce();
    snapshot = emptySnapshot({ running: [task()] });
    await board.refreshOnce();
    telegram.edit.mockImplementationOnce(async () => {
      expect(insideGate).toBe(1);
      physicalOperations.push("edit");
      throw new Error("Bad Request: message to edit not found");
    });
    snapshot = emptySnapshot({ running: [task({ label: "changed" })] });
    await board.refreshOnce();
    await board.protectTopicMessage(CHAT_ID, 42, 888);

    expect(new Set(physicalOperations)).toEqual(new Set([
      "createTopic", "send", "edit", "pin", "closeTopic", "reopenTopic",
      "unpin", "removeMessage", "deleteMessage",
    ]));
    expect(backgroundWriteGate.run).toHaveBeenCalledTimes(physicalOperations.length);
    expect(backgroundWriteGate.run.mock.calls.every(
      ([chatId, priority]) => chatId === CHAT_ID && priority === "ordinary",
    )).toBe(true);
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it("leaves the message text alone when nothing changed", async () => {
    const telegram = new FakeTelegram();
    const board = createBoard(telegram, async () => emptySnapshot());

    await board.refreshOnce();
    telegram.closeTopic.mockClear();
    telegram.pin.mockClear();
    expect(await board.refreshOnce()).toBe("unchanged");
    expect(telegram.edit).not.toHaveBeenCalled();
    expect(telegram.closeTopic).not.toHaveBeenCalled();
    expect(telegram.pin).not.toHaveBeenCalled();
  });

  it("keeps the live status board visible beside the Mini App launcher", async () => {
    const telegram = new FakeTelegram();
    const collect = vi.fn(async () => emptySnapshot({ running: [task()] }));
    const board = createBoard(
      telegram,
      collect,
      createStore(),
      { warn: vi.fn() },
      () => NOW,
      "https://t.me/telecodex_bot/dashboard?startapp=dashboard",
    );

    expect(await board.refreshOnce()).toBe("sent");
    expect(await board.refreshOnce()).toBe("unchanged");
    expect(collect).toHaveBeenCalledTimes(2);
    expect(telegram.send).toHaveBeenCalledWith(42, {
      html: expect.stringContaining("MIR-6319 оплата"),
      buttons: expect.arrayContaining([{
        text: "Открыть Dashboard",
        url: "https://t.me/telecodex_bot/dashboard?startapp=dashboard",
      }]),
    });
  });

  it("requests topic-binding probes only during periodic health checks", async () => {
    const telegram = new FakeTelegram();
    let now = NOW;
    const collect = vi.fn(async (_options?: { validateTopicBindings: boolean }) => emptySnapshot());
    const board = createBoard(
      telegram,
      collect,
      createStore(),
      { warn: vi.fn() },
      () => now,
    );

    await board.refreshOnce();
    now += 30_000;
    await board.refreshOnce();
    now += 10 * 60_000;
    await board.refreshOnce();

    expect(collect.mock.calls).toEqual([
      [{ validateTopicBindings: true }],
      [{ validateTopicBindings: false }],
      [{ validateTopicBindings: true }],
    ]);
  });

  it("edits the board once the work changed", async () => {
    const telegram = new FakeTelegram();
    let snapshot = emptySnapshot();
    const board = createBoard(telegram, async () => snapshot);

    await board.refreshOnce();
    snapshot = emptySnapshot({ running: [task()] });

    expect(await board.refreshOnce()).toBe("edited");
    expect(telegram.edit).toHaveBeenCalledWith(42, 777, expect.objectContaining({
      html: expect.stringContaining("MIR-6319 оплата"),
    }));
  });

  it("edits the board when only a create button becomes a topic link", async () => {
    const telegram = new FakeTelegram();
    let snapshot = emptySnapshot({ running: [task()] });
    const board = createBoard(telegram, async () => snapshot);

    await board.refreshOnce();
    snapshot = emptySnapshot({ running: [task({ messageThreadId: 91 })] });

    expect(await board.refreshOnce()).toBe("edited");
    expect(telegram.edit).toHaveBeenCalledWith(42, 777, expect.objectContaining({
      buttons: [expect.objectContaining({ url: expect.stringContaining("/91") })],
    }));
  });

  it("pins a saved Dashboard board again after restart", async () => {
    const telegram = new FakeTelegram();
    const store = createStore({ messageThreadId: 42, messageId: 555 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(await board.refreshOnce()).toBe("edited");
    expect(telegram.pin).toHaveBeenCalledWith(555);
  });

  it("treats Telegram message-not-modified as a delivered board revision", async () => {
    const telegram = new FakeTelegram();
    telegram.edit.mockRejectedValueOnce(new Error("Bad Request: message is not modified"));
    const board = createBoard(
      telegram,
      async () => emptySnapshot(),
      createStore({ messageThreadId: 42, messageId: 555 }),
    );

    expect(await board.refreshOnce()).toBe("unchanged");
    expect(await board.refreshOnce()).toBe("unchanged");
    expect(telegram.edit).toHaveBeenCalledOnce();
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it("stamps the board with the time of the change", async () => {
    const telegram = new FakeTelegram();
    const board = createBoard(telegram, async () => emptySnapshot());

    await board.refreshOnce();

    const [, message] = telegram.send.mock.calls[0];
    expect(message.html).toMatch(/обновлено \d{2}:\d{2}/);
  });

  it("reopens the Dashboard and posts a new board when its message was deleted", async () => {
    const telegram = new FakeTelegram();
    telegram.edit.mockRejectedValueOnce(new Error("Bad Request: message to edit not found"));
    const store = createStore({ messageThreadId: 42, messageId: 555 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(await board.refreshOnce()).toBe("sent");
    expect(telegram.reopenTopic).toHaveBeenCalledWith(42);
    expect(telegram.send).toHaveBeenCalledWith(42, expect.any(Object));
  });

  it("recreates a deleted idle board even when its body did not change", async () => {
    const telegram = new FakeTelegram();
    let now = NOW;
    const board = createBoard(
      telegram,
      async () => emptySnapshot(),
      createStore(),
      { warn: vi.fn() },
      () => now,
    );
    await board.refreshOnce();
    telegram.pin.mockRejectedValueOnce(new Error("Bad Request: message to pin not found"));
    now += 10 * 60_000;

    expect(await board.refreshOnce()).toBe("sent");
    expect(telegram.reopenTopic).toHaveBeenCalledWith(42);
    expect(telegram.send).toHaveBeenCalledTimes(2);
  });

  it("pauses background Telegram calls for retry_after after a 429", async () => {
    const telegram = new FakeTelegram();
    let now = NOW;
    const board = createBoard(
      telegram,
      async () => emptySnapshot(),
      createStore(),
      { warn: vi.fn() },
      () => now,
    );
    await board.refreshOnce();
    now += 10 * 60_000;
    telegram.pin.mockImplementationOnce(async () => {
      now += 4 * 60_000;
      throw {
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 60 },
      };
    });

    await board.refreshSafely();
    telegram.closeTopic.mockClear();
    telegram.pin.mockClear();
    await board.refreshSafely();

    expect(telegram.closeTopic).not.toHaveBeenCalled();
    expect(telegram.pin).not.toHaveBeenCalled();

    now += 61_000;
    await board.refreshSafely();
    expect(telegram.closeTopic).toHaveBeenCalledOnce();
    expect(telegram.pin).toHaveBeenCalledOnce();
  });

  it("recreates Dashboard when the saved topic was deleted", async () => {
    const telegram = new FakeTelegram();
    telegram.closeTopic.mockRejectedValueOnce(new Error("Bad Request: TOPIC_ID_INVALID"));
    const store = createStore({ messageThreadId: 41, messageId: 555 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(await board.refreshOnce()).toBe("sent");
    expect(telegram.createTopic).toHaveBeenCalledOnce();
    expect(telegram.send).toHaveBeenCalledWith(42, expect.any(Object));
  });

  it("moves a legacy General board into Dashboard before removing it", async () => {
    const telegram = new FakeTelegram();
    const board = createBoard(telegram, async () => emptySnapshot(), createStore({ messageId: 555 }));

    expect(await board.refreshOnce()).toBe("sent");
    expect(telegram.remove).toHaveBeenCalledWith(555, expect.any(Function));
    expect(telegram.unpin).toHaveBeenCalledWith(555);
    expect(telegram.removeMessage).toHaveBeenCalledWith(555);
    expect(telegram.remove.mock.invocationCallOrder[0])
      .toBeGreaterThan(telegram.closeTopic.mock.invocationCallOrder[0]);
  });

  it("retries removing the legacy General board after a transient failure", async () => {
    const telegram = new FakeTelegram();
    telegram.remove.mockRejectedValueOnce(new Error("Bad Gateway"));
    const store = createStore({ messageId: 555 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    await board.refreshOnce();
    expect(store.read().legacyMessageId).toBe(555);
    await board.refreshOnce();
    expect(telegram.remove).toHaveBeenCalledTimes(2);
    expect(store.read().legacyMessageId).toBeUndefined();
  });

  it("recognises messages that belong to the Dashboard topic", () => {
    const telegram = new FakeTelegram();
    const store = createStore({ messageThreadId: 42, messageId: 777 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(board.isDashboardTopic(CHAT_ID, 42)).toBe(true);
    expect(board.isDashboardTopic(CHAT_ID - 1, 42)).toBe(false);
    expect(board.isDashboardTopic(CHAT_ID, 43)).toBe(false);
    expect(board.isDashboardMessage(CHAT_ID, 42, 777)).toBe(true);
    expect(board.isDashboardMessage(CHAT_ID - 1, 42, 777)).toBe(false);
    expect(board.isDashboardMessage(CHAT_ID, 42, 778)).toBe(false);
  });

  it("deletes an accidental Dashboard message and closes the topic again", async () => {
    const telegram = new FakeTelegram();
    const store = createStore({ messageThreadId: 42, messageId: 777 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(await board.protectTopicMessage(CHAT_ID, 42, 888)).toBe(true);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(888);
    expect(telegram.closeTopic).toHaveBeenCalledWith(42);
  });

  it("leaves messages from ordinary topics alone", async () => {
    const telegram = new FakeTelegram();
    const store = createStore({ messageThreadId: 42, messageId: 777 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(await board.protectTopicMessage(CHAT_ID, 43, 888)).toBe(false);
    expect(telegram.deleteMessage).not.toHaveBeenCalled();
    expect(telegram.closeTopic).not.toHaveBeenCalled();
  });

  it("keeps the board alive when it may not be pinned", async () => {
    const telegram = new FakeTelegram();
    telegram.pin.mockRejectedValue(new Error("Bad Request: not enough rights to pin a message"));
    const board = createBoard(telegram, async () => emptySnapshot());

    expect(await board.refreshOnce()).toBe("sent");
  });

  it("leaves the last board standing when the host cannot be read", async () => {
    const telegram = new FakeTelegram();
    let snapshot: StatusSnapshot | undefined = emptySnapshot({ running: [task()] });
    const logger = { warn: vi.fn() };
    const board = createBoard(telegram, async () => {
      if (!snapshot) throw new Error("app-server unreachable");
      return snapshot;
    }, createStore(), logger);

    await board.refreshOnce();
    telegram.edit.mockClear();
    snapshot = undefined;
    await board.refreshSafely();

    expect(telegram.edit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("runs one trailing refresh when a request arrives during collection", async () => {
    const telegram = new FakeTelegram();
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const board = createBoard(telegram, async () => {
      calls += 1;
      if (calls === 1) await firstStarted;
      return calls === 1 ? emptySnapshot() : emptySnapshot({ running: [task()] });
    });

    const first = board.refreshSafely();
    await Promise.resolve();
    await board.refreshSafely();
    releaseFirst();
    await first;

    expect(calls).toBe(2);
    expect(telegram.edit).toHaveBeenCalledWith(42, 777, expect.objectContaining({
      html: expect.stringContaining("MIR-6319 оплата"),
    }));
  });

  it("refreshes visible state within five seconds even with a slower configured interval", async () => {
    vi.useFakeTimers();
    const telegram = new FakeTelegram();
    const collect = vi.fn(async () => emptySnapshot());
    const board = createBoard(telegram, collect);

    try {
      board.start();
      await vi.advanceTimersByTimeAsync(0);
      collect.mockClear();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(collect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(collect).toHaveBeenCalledOnce();
    } finally {
      board.stop();
      vi.useRealTimers();
    }
  });
});
