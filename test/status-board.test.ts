import {
  buildStatusSnapshot,
  groupRunningThreads,
  renderStatusBoard,
  type HostThreadView,
  type StatusJobView,
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

const host = (overrides: Partial<HostThreadView> = {}): HostThreadView => ({
  id: "thread-parent",
  label: "#216 RBAC",
  workspace: "/srv/projects/billing",
  source: "vscode",
  active: true,
  since: NOW - minutes(12),
  ...overrides,
});

describe("groupRunningThreads", () => {
  it("nests an active subagent under its parent", () => {
    const tasks = groupRunningThreads([
      host(),
      host({ id: "child", parentThreadId: "thread-parent", agentNickname: "Rawls", since: NOW - minutes(3) }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].children).toHaveLength(1);
    expect(tasks[0].children[0].label).toContain("Rawls");
  });

  it("keeps a parent that is only waiting on its subagents", () => {
    const tasks = groupRunningThreads([
      host({ active: false }),
      host({ id: "child", parentThreadId: "thread-parent", agentNickname: "Rawls", active: true }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].children).toHaveLength(1);
  });

  it("drops a thread whose whole subtree is idle", () => {
    const tasks = groupRunningThreads([
      host({ active: false }),
      host({ id: "child", parentThreadId: "thread-parent", active: false }),
    ]);

    expect(tasks).toEqual([]);
  });

  it("hides a subagent that already finished", () => {
    const tasks = groupRunningThreads([
      host(),
      host({ id: "done", parentThreadId: "thread-parent", agentNickname: "Franklin", active: false }),
    ]);

    expect(tasks[0].children).toEqual([]);
  });

  it("does not promote an active subagent whose parent is not loaded", () => {
    const tasks = groupRunningThreads([
      host({ id: "orphan", parentThreadId: "gone", agentNickname: "Rawls" }),
    ]);

    expect(tasks).toEqual([]);
  });

  it("keeps an active grandchild under the loaded root", () => {
    const tasks = groupRunningThreads([
      host({ active: false }),
      host({ id: "child", parentThreadId: "thread-parent", active: false }),
      host({ id: "grandchild", parentThreadId: "child", agentNickname: "Rawls" }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].children.map((child) => child.label)).toEqual([
      expect.stringContaining("Rawls"),
    ]);
  });

  it("puts the longest running task first", () => {
    const tasks = groupRunningThreads([
      host({ id: "new", label: "new", since: NOW - minutes(1) }),
      host({ id: "old", label: "old", since: NOW - minutes(30) }),
    ]);

    expect(tasks.map((entry) => entry.label)).toEqual(["old", "new"]);
  });

  it("carries the waiting flag through to the task", () => {
    const tasks = groupRunningThreads([host({ waitingOn: "approval" })]);

    expect(tasks[0].waitingOn).toBe("approval");
  });
});

describe("renderStatusBoard", () => {
  it("counts tasks, not the subagents underneath them", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({
        running: [task({ children: [{ label: "Rawls · review_216", since: NOW - minutes(3) }] })],
      }),
      CHAT_ID,
    );

    expect(body).toContain("активны 1");
  });

  it("shows how many of the Telegram slots are taken", () => {
    const { body } = renderStatusBoard(emptySnapshot({ telegramActive: 2 }), CHAT_ID);

    expect(body).toContain("телеграм 2/8");
  });

  it("summarizes waits and root threads updated during the last 24 hours", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({
        running: [task({ waitingOn: "input" })],
        recentThreadCount: 7,
      }),
      CHAT_ID,
    );

    expect(body).toContain("ждут 1");
    expect(body).toContain("за 24ч 7");
  });

  it("indents a subagent under its task", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({
        running: [task({ children: [{ label: "Rawls · review_216", since: NOW - minutes(3) }] })],
      }),
      CHAT_ID,
    );

    expect(body).toContain("↳");
    expect(body).toContain("Rawls · review_216");
  });

  it("names where a thread is being driven from", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({ running: [task({ source: "vscode" })] }),
      CHAT_ID,
    );

    expect(body).toContain("vscode");
  });

  it("marks a thread that is waiting on you rather than working", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({ running: [task({ waitingOn: "approval" })] }),
      CHAT_ID,
    );

    expect(body).toContain("🟡");
    expect(body).toContain("ждёт подтверждения");
  });

  it("distinguishes waiting for input from waiting for approval", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({ running: [task({ waitingOn: "input" })] }),
      CHAT_ID,
    );

    expect(body).toContain("ждёт ответа");
  });

  it("shows how long each task has been going", () => {
    const { body } = renderStatusBoard(emptySnapshot({ running: [task()] }), CHAT_ID);

    expect(body).toContain("mir-back");
    expect(body).toContain("4м");
  });

  it("lists queued turns under their own heading", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({
        queued: [
          { label: "починить билд", workspace: "/srv/projects/mir-front", messageThreadId: 30, since: NOW },
        ],
      }),
      CHAT_ID,
    );

    expect(body).toContain("Очередь");
    expect(body).toContain("починить билд");
  });

  it("marks a failed turn differently from a finished one", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({
        recent: [
          { label: "MIR-6420", workspace: "/srv/projects/mir-back", messageThreadId: 14, finishedAt: NOW - minutes(2), ok: true },
          { label: "тесты CDR", workspace: "/srv/projects/billing", messageThreadId: 15, finishedAt: NOW - minutes(8), ok: false },
        ],
      }),
      CHAT_ID,
    );

    expect(body).toContain("✅");
    expect(body).toContain("❌");
  });

  it("shows recent Codex roots with their source and relative update time", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({
        recentThreads: [{
          threadId: "thread-recent",
          label: "Исправить пагинацию",
          workspace: "/srv/projects/mir-back",
          source: "vscode",
          updatedAt: NOW - minutes(48),
        }],
        recentThreadCount: 3,
      }),
      CHAT_ID,
    );

    expect(body).toContain("Последние 24 часа");
    expect(body).toContain("Исправить пагинацию");
    expect(body).toContain("48м");
    expect(body).toContain("vscode");
    expect(body).toContain("ещё 2");
  });

  it("reports Codex availability and failed jobs during the last day", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({ codexAvailable: false, failedJobs24h: 2 }),
      CHAT_ID,
    );

    expect(body).toContain("Codex app-server недоступен");
    expect(body).toContain("Задачи · ошибок 2 за 24ч");
  });

  it("times finished turns on the clock so an idle board stops changing", () => {
    const snapshot = emptySnapshot({
      recent: [
        { label: "MIR-6420", workspace: "/srv/projects/mir-back", messageThreadId: 14, finishedAt: NOW - minutes(2), ok: true },
      ],
    });

    const early = renderStatusBoard(snapshot, CHAT_ID).body;
    const late = renderStatusBoard({ ...snapshot, now: NOW + minutes(20) }, CHAT_ID).body;

    expect(early).toMatch(/\d{2}:\d{2}/);
    expect(late).toBe(early);
  });

  it("says so when there is no work at all", () => {
    const { body } = renderStatusBoard(emptySnapshot(), CHAT_ID);

    expect(body).toContain("ничего не выполняется");
  });

  it("hides a label that leaks a bot token", () => {
    const { body } = renderStatusBoard(
      emptySnapshot({
        running: [task({ label: "проверь 123456789:AAHfitzz-abcdefghijklmnopqrstuvwxyz012" })],
      }),
      CHAT_ID,
    );

    expect(body).not.toContain("AAHfitzz");
  });

  it("links a task that has a topic", () => {
    const { buttons } = renderStatusBoard(
      emptySnapshot({ running: [task({ messageThreadId: 12 })] }),
      CHAT_ID,
    );

    expect(buttons).toEqual([
      { text: expect.stringContaining("↗"), url: "https://t.me/c/1234567890/12" },
    ]);
  });

  it("offers to create a topic for a root thread running outside Telegram", () => {
    const { buttons } = renderStatusBoard(
      emptySnapshot({ running: [task({ source: "vscode", messageThreadId: undefined })] }),
      CHAT_ID,
    );

    expect(buttons).toEqual([{
      text: expect.stringContaining("＋"),
      callbackData: "projopen:thread-running",
    }]);
  });

  it("gives recent roots the same create-or-open action and caps all actions at eight", () => {
    const recentThreads = Array.from({ length: 9 }, (_, index) => ({
      threadId: `recent-${index}`,
      label: `Recent ${index}`,
      workspace: "/srv/projects/mir-back",
      source: "cli",
      updatedAt: NOW - minutes(index + 1),
      ...(index === 0 ? { messageThreadId: 50 } : {}),
    }));
    const { buttons } = renderStatusBoard(
      emptySnapshot({ running: [task({ messageThreadId: 12 })], recentThreads, recentThreadCount: 9 }),
      CHAT_ID,
    );

    expect(buttons).toHaveLength(8);
    expect(buttons[1]).toEqual({
      text: expect.stringContaining("↗"),
      url: "https://t.me/c/1234567890/50",
    });
    expect(buttons[2]).toEqual({
      text: expect.stringContaining("＋"),
      callbackData: "projopen:recent-1",
    });
  });
});

describe("buildStatusSnapshot", () => {
  const job = (overrides: Partial<StatusJobView>): StatusJobView => ({
    state: "active",
    label: "работа",
    workspace: "/srv/projects/mir-back",
    messageThreadId: 12,
    createdAt: NOW - minutes(3),
    updatedAt: NOW - minutes(1),
    ...overrides,
  });

  const build = (jobs: StatusJobView[], hosts: HostThreadView[] = [], options = {}) =>
    buildStatusSnapshot(jobs, hosts, { limit: 8, now: NOW, ...options });

  it("takes the running list from the host, not from Telegram jobs", () => {
    const snapshot = build([job({ state: "active" })], [host({ label: "#216 RBAC" })]);

    expect(snapshot.running.map((entry) => entry.label)).toEqual(["#216 RBAC"]);
  });

  it("counts a delivering turn against the Telegram slots", () => {
    const snapshot = build([job({ state: "delivering" })]);

    expect(snapshot.telegramActive).toBe(1);
  });

  it("puts a waiting turn in the queue", () => {
    const snapshot = build([job({ state: "waiting" })]);

    expect(snapshot.queued).toHaveLength(1);
  });

  it("keeps a turn awaiting model selection visible in the queue", () => {
    const snapshot = build([job({ state: "awaiting-model" })]);

    expect(snapshot.queued).toHaveLength(1);
    expect(snapshot.telegramActive).toBe(0);
  });

  it("reports a failed turn as not ok", () => {
    const snapshot = build([job({ state: "failed" })]);

    expect(snapshot.recent).toEqual([expect.objectContaining({ ok: false })]);
  });

  it("forgets a turn that finished long ago", () => {
    const snapshot = build([job({ state: "completed", updatedAt: NOW - minutes(45) })]);

    expect(snapshot.recent).toHaveLength(0);
  });

  it("keeps only the newest few finished turns", () => {
    const finished = [1, 2, 3, 4, 5].map((index) =>
      job({ state: "completed", label: `job-${index}`, updatedAt: NOW - minutes(index) }),
    );

    const snapshot = build(finished, [], { maxRecent: 3 });

    expect(snapshot.recent.map((row) => row.label)).toEqual(["job-1", "job-2", "job-3"]);
  });

  it("excludes active roots from recent history and counts Telegram failures over 24 hours", () => {
    const recentThreads = [
      {
        threadId: "thread-parent",
        label: "Still active",
        workspace: "/srv/projects/billing",
        source: "vscode",
        updatedAt: NOW - minutes(1),
      },
      {
        threadId: "thread-done",
        label: "Recently done",
        workspace: "/srv/projects/billing",
        source: "cli",
        updatedAt: NOW - minutes(2),
      },
    ];
    const snapshot = buildStatusSnapshot(
      [job({ state: "failed", updatedAt: NOW - minutes(30) })],
      [host({ id: "thread-parent" })],
      { limit: 8, now: NOW, recentThreads, codexAvailable: false },
    );

    expect(snapshot.recentThreads.map((row) => row.threadId)).toEqual(["thread-done"]);
    expect(snapshot.recentThreadCount).toBe(1);
    expect(snapshot.failedJobs24h).toBe(1);
    expect(snapshot.codexAvailable).toBe(false);
  });
});
