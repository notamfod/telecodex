import {
  buildStatusSnapshot,
  groupRunningThreads,
  telegramRetryAfterMs,
  type HostThreadView,
  type StatusJobView,
} from "../src/status-board.js";

const NOW = Date.UTC(2026, 7, 13, 6, 41, 0);
const minutes = (count: number): number => count * 60_000;

const host = (overrides: Partial<HostThreadView> = {}): HostThreadView => ({
  id: "thread-parent",
  label: "#216 RBAC",
  workspace: "/srv/projects/billing",
  source: "vscode",
  active: true,
  since: NOW - minutes(12),
  ...overrides,
});

describe("telegramRetryAfterMs", () => {
  it("reads direct Telegram retry_after seconds as milliseconds", () => {
    expect(telegramRetryAfterMs({
      error_code: 429,
      parameters: { retry_after: 12 },
    })).toBe(12_000);
  });

  it("reads retry_after through a typical grammY error wrapper", () => {
    expect(telegramRetryAfterMs({
      error: {
        error_code: 429,
        parameters: { retry_after: 23 },
      },
    })).toBe(23_000);
  });

  it("uses retry_after from the explicit 429 candidate instead of its wrapper", () => {
    expect(telegramRetryAfterMs({
      parameters: { retry_after: 3_600 },
      error: { error_code: 429, parameters: { retry_after: 2 } },
    })).toBe(2_000);
  });

  it("uses an inner explicit 429 candidate when its wrapper has a non-429 code", () => {
    expect(telegramRetryAfterMs({
      error_code: 403,
      parameters: { retry_after: 3_600 },
      error: { error_code: 429, parameters: { retry_after: 2 } },
    })).toBe(2_000);
  });

  it("does not borrow wrapper parameters for an explicit 429 candidate", () => {
    expect(telegramRetryAfterMs({
      parameters: { retry_after: 3_600 },
      error: { error_code: 429 },
    })).toBe(30_000);
  });

  it("uses the first valid delay among explicit 429 candidates", () => {
    expect(telegramRetryAfterMs({
      error_code: 429,
      error: { error_code: 429, parameters: { retry_after: 2 } },
    })).toBe(2_000);
  });

  it("uses retry_after from the text-only rate-limit candidate", () => {
    expect(telegramRetryAfterMs({
      parameters: { retry_after: 3_600 },
      error: {
        description: "Too Many Requests: retry later",
        parameters: { retry_after: 2 },
      },
    })).toBe(2_000);
  });

  it("does not borrow nested parameters for a text-only rate-limit candidate", () => {
    expect(telegramRetryAfterMs({
      description: "Too Many Requests: retry later",
      error: { parameters: { retry_after: 2 } },
    })).toBe(30_000);
  });

  it("uses the first valid delay among text-only rate-limit candidates", () => {
    expect(telegramRetryAfterMs({
      description: "Too Many Requests: retry later",
      error: {
        message: "429 rate limited",
        parameters: { retry_after: 2 },
      },
    })).toBe(2_000);
  });

  it.each([
    { error_code: 429 },
    { error_code: 429, parameters: { retry_after: 0 } },
    { error_code: 429, parameters: { retry_after: -1 } },
    { error_code: 429, parameters: { retry_after: 0.5 } },
    { error_code: 429, parameters: { retry_after: Number.NaN } },
    { error_code: 429, parameters: { retry_after: Number.POSITIVE_INFINITY } },
    { error_code: 429, parameters: { retry_after: Number.MAX_SAFE_INTEGER + 1 } },
    { error_code: 429, parameters: { retry_after: 7_200 } },
    { error_code: 429, parameters: { retry_after: "20" } },
  ])("uses the 30 second fallback for a 429 without valid retry_after", (error) => {
    expect(telegramRetryAfterMs(error)).toBe(30_000);
  });

  it.each([
    [1, 1_000],
    [3_600, 3_600_000],
  ])("accepts the retry_after boundary %i seconds", (retryAfter, expectedMs) => {
    expect(telegramRetryAfterMs({
      error_code: 429,
      parameters: { retry_after: retryAfter },
    })).toBe(expectedMs);
  });

  it("does not attach retry delay to a non-429 error", () => {
    expect(telegramRetryAfterMs({
      error_code: 500,
      description: "Too Many Requests from an upstream dependency",
      parameters: { retry_after: 12 },
    })).toBeUndefined();
  });
});

describe("groupRunningThreads", () => {
  it("nests an active subagent under its parent", () => {
    const tasks = groupRunningThreads([
      host(),
      host({ id: "child", parentThreadId: "thread-parent", agentNickname: "Rawls", since: NOW - minutes(3) }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].children).toHaveLength(1);
    expect(tasks[0].children[0].threadId).toBe("child");
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
