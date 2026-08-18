import { vi } from "vitest";

import { listHostThreads, trackActiveSince } from "../src/host-threads.js";

const NOW = Date.UTC(2026, 7, 13, 6, 41, 0);
const minutes = (count: number): number => count * 60_000;

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: "019ff4ea",
  cwd: "/srv/projects/billing",
  name: "#216 RBAC",
  preview: "Ниже — обращение из поддержки",
  source: "vscode",
  status: { type: "active", activeFlags: [] },
  ...overrides,
});

const createClient = (threads: Array<Record<string, unknown>>) => ({
  request: vi.fn(async (method: string, params: unknown) => {
    if (method === "thread/loaded/list") {
      return { data: threads.map((entry) => entry.id as string), nextCursor: null };
    }
    if (method === "thread/read") {
      const wanted = (params as { threadId: string }).threadId;
      const found = threads.find((entry) => entry.id === wanted);
      if (!found) throw new Error(`no such thread ${wanted}`);
      return { thread: found };
    }
    throw new Error(`unexpected method ${method}`);
  }),
});

describe("trackActiveSince", () => {
  it("remembers when a thread was first seen working", () => {
    const tracked = trackActiveSince(new Map(), [{ id: "a", active: true }], NOW);

    expect(tracked.get("a")).toBe(NOW);
  });

  it("keeps the original start once a thread keeps working", () => {
    const first = trackActiveSince(new Map(), [{ id: "a", active: true }], NOW);

    const later = trackActiveSince(first, [{ id: "a", active: true }], NOW + minutes(5));

    expect(later.get("a")).toBe(NOW);
  });

  it("forgets a thread that went idle, so its next turn starts fresh", () => {
    const first = trackActiveSince(new Map(), [{ id: "a", active: true }], NOW);

    const idle = trackActiveSince(first, [{ id: "a", active: false }], NOW + minutes(5));
    const again = trackActiveSince(idle, [{ id: "a", active: true }], NOW + minutes(9));

    expect(idle.has("a")).toBe(false);
    expect(again.get("a")).toBe(NOW + minutes(9));
  });

  it("forgets a thread that is no longer loaded at all", () => {
    const first = trackActiveSince(new Map(), [{ id: "a", active: true }], NOW);

    const tracked = trackActiveSince(first, [], NOW + minutes(1));

    expect(tracked.has("a")).toBe(false);
  });
});

describe("listHostThreads", () => {
  const list = async (threads: Array<Record<string, unknown>>, activeSince = new Map<string, number>()) =>
    listHostThreads(createClient(threads), { now: NOW, activeSince });

  it("reports a working thread as active", async () => {
    const { threads } = await list([thread()]);

    expect(threads).toEqual([expect.objectContaining({ id: "019ff4ea", active: true })]);
  });

  it("reports an idle thread as not active", async () => {
    const { threads } = await list([thread({ status: { type: "idle" } })]);

    expect(threads[0].active).toBe(false);
  });

  it("flags a thread that is waiting on an approval", async () => {
    const { threads } = await list([
      thread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }),
    ]);

    expect(threads[0].waitingOn).toBe("approval");
  });

  it("flags a thread that is waiting on the user", async () => {
    const { threads } = await list([
      thread({ status: { type: "active", activeFlags: ["waitingOnUserInput"] } }),
    ]);

    expect(threads[0].waitingOn).toBe("input");
  });

  it("prefers the thread name over its first message", async () => {
    const { threads } = await list([thread()]);

    expect(threads[0].label).toBe("#216 RBAC");
  });

  it("falls back to the first message when a thread has no name", async () => {
    const { threads } = await list([thread({ name: null })]);

    expect(threads[0].label).toBe("Ниже — обращение из поддержки");
  });

  it("names a thread by its id when there is nothing else", async () => {
    const { threads } = await list([thread({ name: null, preview: "" })]);

    expect(threads[0].label).toContain("019ff4ea");
  });

  it("carries a subagent's parent and nickname", async () => {
    const { threads } = await list([
      thread({
        id: "child",
        source: { subAgent: { thread_spawn: { parent_thread_id: "019ff4ea", agent_nickname: "Rawls" } } },
      }),
    ]);

    expect(threads[0]).toEqual(expect.objectContaining({
      parentThreadId: "019ff4ea",
      agentNickname: "Rawls",
    }));
  });

  it("names a subagent by the task it was given, not by its first message", async () => {
    const { threads } = await list([
      thread({
        id: "child",
        name: null,
        preview: "[https://gitlab.example.com/acme/apps/api/-/merge_requests/1401",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "019ff4ea",
              agent_nickname: "Schrodinger",
              agent_path: "/root/review_1401_1403",
            },
          },
        },
      }),
    ]);

    expect(threads[0].label).toBe("review_1401_1403");
  });

  it("labels where a thread is driven from", async () => {
    const { threads } = await list([thread({ source: "cli" })]);

    expect(threads[0].source).toBe("cli");
  });

  it("calls a thread TeleCodex started a Telegram thread", async () => {
    const { threads } = await list([thread({ source: { custom: "telecodex" } })]);

    expect(threads[0].source).toBe("телеграм");
  });

  it("times a thread from when it was first seen working", async () => {
    const { threads } = await list([thread()], new Map([["019ff4ea", NOW - minutes(12)]]));

    expect(threads[0].since).toBe(NOW - minutes(12));
  });

  it("keeps the other threads when one of them cannot be read", async () => {
    const client = createClient([thread(), thread({ id: "broken" })]);
    client.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === "thread/loaded/list") return { data: ["019ff4ea", "broken"], nextCursor: null };
      if ((params as { threadId: string }).threadId === "broken") throw new Error("gone");
      return { thread: thread() };
    });

    const { threads } = await listHostThreads(client, { now: NOW, activeSince: new Map() });

    expect(threads).toHaveLength(1);
  });

  it("returns the updated start times alongside the threads", async () => {
    const { activeSince } = await list([thread()]);

    expect(activeSince.get("019ff4ea")).toBe(NOW);
  });
});
