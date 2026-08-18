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
  readonly remove = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
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
  now: () => NOW,
  logger,
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

  it("leaves the message text alone when nothing changed", async () => {
    const telegram = new FakeTelegram();
    const board = createBoard(telegram, async () => emptySnapshot());

    await board.refreshOnce();
    expect(await board.refreshOnce()).toBe("unchanged");
    expect(telegram.edit).not.toHaveBeenCalled();
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
    const board = createBoard(telegram, async () => emptySnapshot());
    await board.refreshOnce();
    telegram.pin.mockRejectedValueOnce(new Error("Bad Request: message to pin not found"));

    expect(await board.refreshOnce()).toBe("sent");
    expect(telegram.reopenTopic).toHaveBeenCalledWith(42);
    expect(telegram.send).toHaveBeenCalledTimes(2);
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
    expect(telegram.remove).toHaveBeenCalledWith(555);
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

    expect(board.isDashboardTopic(42)).toBe(true);
    expect(board.isDashboardTopic(43)).toBe(false);
  });

  it("deletes an accidental Dashboard message and closes the topic again", async () => {
    const telegram = new FakeTelegram();
    const store = createStore({ messageThreadId: 42, messageId: 777 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(await board.protectTopicMessage(42, 888)).toBe(true);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(888);
    expect(telegram.closeTopic).toHaveBeenCalledWith(42);
  });

  it("leaves messages from ordinary topics alone", async () => {
    const telegram = new FakeTelegram();
    const store = createStore({ messageThreadId: 42, messageId: 777 });
    const board = createBoard(telegram, async () => emptySnapshot(), store);

    expect(await board.protectTopicMessage(43, 888)).toBe(false);
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
});
