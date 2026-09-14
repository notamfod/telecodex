import {
  createDashboardController,
  createDashboardSnapshotCollector,
  createSharedAsyncLoader,
} from "../src/dashboard-controller.js";
import type { StatusSnapshot } from "../src/status-board.js";
import type {
  TelegramJobStatusProjection,
  TelegramStatusAction,
} from "../src/telegram-status-projection.js";

const THREAD_ID = "019fef85-92e7-7841-a26a-dbb311b50e31";
const NOW = Date.UTC(2026, 7, 20, 7, 0, 0);

const emptySnapshot: StatusSnapshot = {
  limit: 4,
  telegramActive: 0,
  running: [],
  queued: [],
  recent: [],
  recentThreads: [],
  recentThreadCount: 0,
  codexAvailable: true,
  failedJobs24h: 0,
  now: NOW,
};

describe("Dashboard controller", () => {
  it("shares an in-flight reliability load and briefly reuses its result", async () => {
    let now = NOW;
    let resolve!: (value: { marker: number }) => void;
    const source = vi.fn(() => new Promise<{ marker: number }>((done) => { resolve = done; }));
    const load = createSharedAsyncLoader(source, { now: () => now, ttlMs: 100 });

    const first = load();
    const concurrent = load();
    expect(source).toHaveBeenCalledOnce();

    resolve({ marker: 1 });
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { marker: 1 },
      { marker: 1 },
    ]);
    await expect(load()).resolves.toEqual({ marker: 1 });
    expect(source).toHaveBeenCalledOnce();

    now += 101;
    source.mockResolvedValueOnce({ marker: 2 });
    await expect(load()).resolves.toEqual({ marker: 2 });
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("uses the same local-only snapshot options on every load", async () => {
    const collect = vi.fn(async () => emptySnapshot);
    const loadSnapshot = createDashboardSnapshotCollector(collect);

    await loadSnapshot();
    await loadSnapshot();
    await loadSnapshot();

    expect(collect.mock.calls).toEqual([
      [{ maxRecentThreads: Number.MAX_SAFE_INTEGER, includeCanonicalReliability: false, refreshHostThreads: false }],
      [{ maxRecentThreads: Number.MAX_SAFE_INTEGER, includeCanonicalReliability: false, refreshHostThreads: false }],
      [{ maxRecentThreads: Number.MAX_SAFE_INTEGER, includeCanonicalReliability: false, refreshHostThreads: false }],
    ]);
  });

  it("loads the browser-safe payload from the current status snapshot", async () => {
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect: async () => emptySnapshot,
      getThread: () => undefined,
      ensureThreadTopic: vi.fn(),
    });

    expect(await controller.loadDashboard({ view: "recent", offset: 10, limit: 20 })).toMatchObject({
      generatedAt: NOW,
      counts: { active: 0, recent: 0, attention: 0 },
      page: { view: "recent", offset: 10, limit: 20, total: 0, hasMore: false },
    });
  });

  it("loads only durable session statuses for the browser payload", async () => {
    const loadSessionStatuses = vi.fn(async () => []);
    const loadReliability = vi.fn(async () => { throw new Error("live reliability must not run"); });
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect: async () => emptySnapshot,
      loadSessionStatuses,
      loadReliability,
      runJobAction: vi.fn(),
      getThread: () => undefined,
      ensureThreadTopic: vi.fn(),
    });

    const payload = await controller.loadDashboard();
    expect(payload).not.toHaveProperty("reliability");
    expect(loadSessionStatuses).toHaveBeenCalledOnce();
    expect(loadReliability).not.toHaveBeenCalled();
  });

  it("loads the status snapshot and durable session statuses concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const collect = vi.fn(async () => { await gate; return emptySnapshot; });
    const loadSessionStatuses = vi.fn(async () => { await gate; return []; });
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect,
      loadSessionStatuses,
      getThread: () => undefined,
      ensureThreadTopic: vi.fn(),
    });

    const loading = controller.loadDashboard();
    expect(collect).toHaveBeenCalledOnce();
    expect(loadSessionStatuses).toHaveBeenCalledOnce();
    release();
    await loading;

    expect(collect).toHaveBeenCalledOnce();
  });

  it("creates or reuses a topic through the existing thread-topic flow", async () => {
    const thread = { id: THREAD_ID, cwd: "/root/project" } as never;
    const ensureThreadTopic = vi.fn(async () => ({
      created: false,
      messageThreadId: 42,
      name: "Project",
      url: "https://t.me/c/1234567890/42",
    }));
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect: async () => emptySnapshot,
      getThread: (id) => id === THREAD_ID ? thread : undefined,
      ensureThreadTopic,
    });

    await expect(controller.ensureTopic(THREAD_ID)).resolves.toEqual({
      created: false,
      url: "https://t.me/c/1234567890/42",
    });
    expect(ensureThreadTopic).toHaveBeenCalledWith(thread);
  });

  it("forwards an exact canonical action without changing its correlation", async () => {
    const runJobAction = vi.fn(async () => undefined);
    const action: TelegramStatusAction = {
      kind: "retry_delivery",
      jobId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 12,
      partKey: "final:0000",
    };
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect: async () => emptySnapshot,
      loadReliability: async () => reliabilityWithAction(action),
      runJobAction,
      getThread: () => undefined,
      ensureThreadTopic: vi.fn(),
    });

    await controller.runJobAction(action);

    expect(runJobAction).toHaveBeenCalledWith(action);
  });

  it("rejects an action not present in the current canonical projection", async () => {
    const runJobAction = vi.fn(async () => undefined);
    const legal: TelegramStatusAction = {
      kind: "retry_delivery",
      jobId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 12,
      partKey: "final:0000",
    };
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect: async () => emptySnapshot,
      loadReliability: async () => reliabilityWithAction(legal),
      runJobAction,
      getThread: () => undefined,
      ensureThreadTopic: vi.fn(),
    });

    await expect(controller.runJobAction({ ...legal, partKey: "final:0001" }))
      .rejects.toThrow("Dashboard action is no longer legal");
    expect(runJobAction).not.toHaveBeenCalled();
  });

  it.each(["resume_existing_topic", "resume_existing_topic_warning"] as const)(
    "forwards only the exact projected %s envelope", async (kind) => {
    const runJobAction = vi.fn(async () => undefined);
    const legal: TelegramStatusAction = {
      kind,
      jobId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 541,
    };
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect: async () => emptySnapshot,
      loadReliability: async () => reliabilityWithAction(legal),
      runJobAction,
      getThread: () => undefined,
      ensureThreadTopic: vi.fn(),
    });

    await expect(controller.runJobAction({ ...legal, partKey: "status-anchor" }))
      .rejects.toThrow("Dashboard action is no longer legal");
    await controller.runJobAction(legal);

    expect(runJobAction).toHaveBeenCalledOnce();
    expect(runJobAction).toHaveBeenCalledWith(legal);
  });

  it("does not create a topic for a thread unavailable on this host", async () => {
    const controller = createDashboardController({
      chatId: -1001234567890,
      collect: async () => emptySnapshot,
      getThread: () => undefined,
      ensureThreadTopic: vi.fn(),
    });

    await expect(controller.ensureTopic(THREAD_ID)).rejects.toThrow(
      "Thread is not available on this device",
    );
  });
});

function reliabilityWithAction(action: TelegramStatusAction) {
  return {
    jobs: [{
      projection: { jobId: action.jobId, actions: [action] } as TelegramJobStatusProjection,
      events: [],
    }],
    appServer: { connectivity: "connected" as const, reasonCode: null },
    guardian: {
      connectivity: "connected" as const,
      mode: "observe" as const,
      lastScanAt: NOW,
      reasonCode: null,
    },
    telegram: { deliveryHealth: "healthy" as const, reasonCode: null },
  };
}
it("decorates duplicate task bindings using exact task context and never task IDs as thread IDs", async () => {
  const tasks = [1, 2].map(i => ({ taskId: `task-${i}`, chatId: -100123, messageThreadId: i + 10, threadId: THREAD_ID, title: 'Persisted', workspace: '/work/project', agentState: 'running', lifecycle: 'open', lastEventAt: NOW, updatedAt: NOW }));
  const taskLinks = vi.fn(async () => []);
  const taskRowLinks = vi.fn(async task => [{ label: 'Topic', url: `https://t.me/c/123/${task.messageThreadId}` }]);
  const ensure = vi.fn();
  const controller = createDashboardController({ chatId: -100123, collect: async () => emptySnapshot, loadTasks: async () => tasks as never, taskLinks, taskRowLinks, getThread: () => undefined, ensureThreadTopic: ensure });
  const result = await controller.loadDashboard();
  expect(result.sessions).toHaveLength(2);
  expect(taskRowLinks.mock.calls.map(([task]) => task.messageThreadId)).toEqual([11, 12]);
  expect(taskLinks).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled();
});
