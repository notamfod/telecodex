import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServerRequestError } from "../src/app-server-client.js";
import { SessionGuardianAppServer } from "../src/session-guardian-app-server.js";
import {
  fingerprintOf,
  type GuardianThreadSnapshot,
} from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";
const NOW_MS = 1_723_086_400_000;
const RECENT_WINDOW_MS = 86_400_000;

function listScope(trackedThreadIds: readonly string[] = []) {
  return {
    recentCutoffMs: NOW_MS - RECENT_WINDOW_MS,
    trackedThreadIds,
  };
}

type RequestHandler = (method: string, params?: unknown) => unknown | Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createClient(handler: RequestHandler, loadedResponse: unknown = { data: [] }) {
  return {
    request: vi.fn((method: string, params?: unknown) => Promise.resolve(
      method === "thread/loaded/list" ? loadedResponse : handler(method, params),
    )),
    close: vi.fn(),
  };
}

function rawThread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    status: { type: "active" },
    turns: [{
      id: TURN_ID,
      status: "inProgress",
      items: [{ type: "reasoning" }, { type: "agentMessage" }],
    }],
    updatedAt: 1_723_000_000,
    source: { custom: "telecodex" },
    cwd: "/srv/projects/telecodex",
    name: "Guardian design",
    canAcceptDirectInput: false,
    parentThreadId: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionGuardianAppServer", () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid listRootThreads total timeout: %s",
    (listRootThreadsTimeoutMs) => {
      const client = createClient(() => ({}));

      expect(() => new SessionGuardianAppServer(client, { listRootThreadsTimeoutMs }))
        .toThrow("listRootThreadsTimeoutMs must be a positive safe integer");
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("discovers an active loaded root using only loaded and read RPCs", async () => {
    const activeRoot = rawThread({ ephemeral: false });
    const client = createClient((method, params) => {
      if (method === "thread/read") {
        expect(params).toEqual({
          threadId: THREAD_ID,
          includeTurns: (params as { includeTurns: boolean }).includeTurns,
        });
        return { thread: activeRoot };
      }
      throw new Error(`Unexpected method: ${method}`);
    }, { data: [THREAD_ID] });

    const snapshots = await new SessionGuardianAppServer(client).listRootThreads(listScope());

    expect(snapshots.map((snapshot) => snapshot.threadId)).toEqual([THREAD_ID]);
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: false }],
      ["thread/read", { threadId: THREAD_ID, includeTurns: true }],
    ]);
  });

  it.each([
    ["idle root", rawThread({
      status: { type: "idle" },
      turns: [],
      ephemeral: false,
      canAcceptDirectInput: true,
    })],
    ["child", rawThread({ ephemeral: false, parentThreadId: THREAD_ID })],
    ["ephemeral root", rawThread({ ephemeral: true })],
  ])("skips a loaded %s after its lightweight header", async (_name, header) => {
    const client = createClient((method, params) => {
      if (method === "thread/read") {
        expect(params).toEqual({ threadId: THREAD_ID, includeTurns: false });
        return { thread: header };
      }
      throw new Error(`Unexpected method: ${method}`);
    }, { data: [THREAD_ID] });

    await expect(
      new SessionGuardianAppServer(client).listRootThreads(listScope()),
    ).resolves.toEqual([]);
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: false }],
    ]);
  });

  it("full-reads a tracked root absent from loaded/list", async () => {
    const trackedRoot = rawThread({
      status: { type: "idle" },
      turns: [],
      canAcceptDirectInput: true,
    });
    const client = createClient((method, params) => {
      if (method === "thread/read") {
        expect(params).toEqual({ threadId: THREAD_ID, includeTurns: true });
        return { thread: trackedRoot };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const snapshots = await new SessionGuardianAppServer(client).listRootThreads(
      listScope([THREAD_ID]),
    );

    expect(snapshots.map((snapshot) => snapshot.threadId)).toEqual([THREAD_ID]);
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: true }],
    ]);
  });

  it("keeps a tracked loaded ID despite a stale child header and deduplicates its full read", async () => {
    const staleHeader = rawThread({
      status: { type: "idle" },
      turns: [],
      ephemeral: true,
      parentThreadId: "019ff4ea-8c36-7c5f-8f08-111111111111",
      source: { subAgent: {} },
      canAcceptDirectInput: true,
    });
    const authoritativeRoot = rawThread({
      status: { type: "idle" },
      turns: [],
      ephemeral: false,
      canAcceptDirectInput: true,
    });
    const client = createClient((method, params) => {
      if (method === "thread/read") {
        return {
          thread: (params as { includeTurns: boolean }).includeTurns
            ? authoritativeRoot
            : staleHeader,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    }, { data: [THREAD_ID] });

    const snapshots = await new SessionGuardianAppServer(client).listRootThreads(
      listScope([THREAD_ID]),
    );

    expect(snapshots.map((snapshot) => snapshot.threadId)).toEqual([THREAD_ID]);
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: false }],
      ["thread/read", { threadId: THREAD_ID, includeTurns: true }],
    ]);
  });

  it("filters a tracked thread only after its authoritative full snapshot is also a child", async () => {
    const child = rawThread({
      source: { subAgent: {} },
      parentThreadId: "019ff4ea-8c36-7c5f-8f08-111111111111",
    });
    const client = createClient((method) => {
      if (method === "thread/read") return { thread: child };
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(
      new SessionGuardianAppServer(client).listRootThreads(listScope([THREAD_ID])),
    ).resolves.toEqual([]);
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: true }],
    ]);
  });

  it.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("keeps validating recentCutoffMs for API compatibility: %s", async (recentCutoffMs) => {
    const client = createClient(() => {
      throw new Error("request must not run");
    });

    await expect(
      new SessionGuardianAppServer(client).listRootThreads({
        recentCutoffMs,
        trackedThreadIds: [],
      }),
    ).rejects.toThrow("recentCutoffMs must be a non-negative safe integer");
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each([
    ["data must be an array", {}],
    ["ID must be a UUID", { data: [""] }],
    ["ID must be a UUID", { data: ["not-a-thread-id"] }],
    ["IDs must be unique", { data: [THREAD_ID, THREAD_ID] }],
    ["data must contain at most", { data: Array.from({ length: 10_001 }, () => THREAD_ID) }],
  ])("rejects malformed thread/loaded/list response when %s", async (message, loadedResponse) => {
    const client = createClient((method) => {
      throw new Error(`Unexpected method: ${method}`);
    }, loadedResponse);

    await expect(
      new SessionGuardianAppServer(client).listRootThreads(listScope()),
    ).rejects.toThrow(`Invalid app-server response: thread/loaded/list ${message}`);
    expect(client.request.mock.calls).toEqual([["thread/loaded/list", {}]]);
  });

  it.each([
    ["thread", {}, "thread must be an object"],
    ["id", { thread: rawThread({
      id: "019ff4ea-8c36-7c5f-8f08-999999999999",
      ephemeral: false,
    }) }, `thread.id must match ${THREAD_ID}`],
    ["status", { thread: rawThread({
      status: { type: "unknown" },
      ephemeral: false,
    }) }, "thread.status.type"],
    ["root", { thread: rawThread({ source: null, ephemeral: false }) }, "thread.source"],
    ["ephemeral missing", { thread: rawThread() }, "thread.ephemeral"],
    ["ephemeral malformed", { thread: rawThread({
      ephemeral: "false",
    }) }, "thread.ephemeral"],
  ])("rejects a malformed loaded thread header: %s", async (_name, headerResponse, message) => {
    const client = createClient((method, params) => {
      if (method === "thread/read") {
        expect(params).toEqual({ threadId: THREAD_ID, includeTurns: false });
        return headerResponse;
      }
      throw new Error(`Unexpected method: ${method}`);
    }, { data: [THREAD_ID] });

    await expect(
      new SessionGuardianAppServer(client).listRootThreads(listScope()),
    ).rejects.toThrow(`Invalid app-server response: thread/read.${message}`);
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: false }],
    ]);
  });

  it("normalizes thread/read using the last turn and its last item", async () => {
    const source = { custom: "telecodex" };
    const client = createClient((method) => {
      if (method !== "thread/read") throw new Error(`Unexpected method: ${method}`);
      return { thread: rawThread({ source }) };
    });
    const gateway = new SessionGuardianAppServer(client);

    const snapshot = await gateway.readThread(THREAD_ID);

    expect(snapshot).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      threadStatus: "active",
      turnStatus: "inProgress",
      updatedAt: 1_723_000_000,
      itemCount: 2,
      lastItemType: "agentMessage",
      source,
      cwd: "/srv/projects/telecodex",
      name: "Guardian design",
      canAcceptDirectInput: false,
      root: true,
    });
    expect(client.request).toHaveBeenCalledWith("thread/read", {
      threadId: THREAD_ID,
      includeTurns: true,
    });
  });

  it("marks source.subAgent and parentThreadId threads as non-root", async () => {
    const responses = [
      rawThread({ source: { subAgent: {} } }),
      rawThread({ source: "cli", parentThreadId: "parent-thread" }),
    ];
    const client = createClient((method) => {
      if (method !== "thread/read") throw new Error(`Unexpected method: ${method}`);
      return { thread: responses.shift() };
    });
    const gateway = new SessionGuardianAppServer(client);

    expect((await gateway.readThread(THREAD_ID)).root).toBe(false);
    expect((await gateway.readThread(THREAD_ID)).root).toBe(false);
  });

  it("discovers a valid loaded root whose direct-input state is null", async () => {
    const thread = rawThread({ canAcceptDirectInput: null, ephemeral: false });
    const client = createClient((method) => {
      if (method === "thread/read") return { thread };
      throw new Error(`Unexpected method: ${method}`);
    }, { data: [THREAD_ID] });

    const snapshots = await new SessionGuardianAppServer(client).listRootThreads(listScope());

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      threadId: THREAD_ID,
      canAcceptDirectInput: false,
      root: true,
    });
  });

  it("rejects a malformed full read instead of hiding an observation failure", async () => {
    const malformedReadClient = createClient(() => ({}));

    await expect(
      new SessionGuardianAppServer(malformedReadClient).readThread(THREAD_ID),
    ).rejects.toThrow("Invalid app-server response: thread/read.thread must be an object");
  });

  it("rejects thread/read when the returned thread ID does not match the request", async () => {
    const missingIdClient = createClient(() => ({ thread: {} }));
    const wrongIdClient = createClient(() => ({
      thread: rawThread({ id: "019ff4ea-8c36-7c5f-8f08-999999999999" }),
    }));

    await expect(
      new SessionGuardianAppServer(missingIdClient).readThread(THREAD_ID),
    ).rejects.toThrow(`Invalid app-server response: thread/read.thread.id must match ${THREAD_ID}`);
    await expect(
      new SessionGuardianAppServer(wrongIdClient).readThread(THREAD_ID),
    ).rejects.toThrow(`Invalid app-server response: thread/read.thread.id must match ${THREAD_ID}`);
  });

  it.each([
    ["status.type", { status: { type: "unknown" } }],
    ["turns", { turns: null }],
    ["updatedAt", { updatedAt: "yesterday" }],
    ["cwd", { cwd: null }],
    ["canAcceptDirectInput", { canAcceptDirectInput: "yes" }],
    ["turns[last].id", { turns: [{ id: "", status: "inProgress", items: [] }] }],
    ["turns[last].status", { turns: [{ id: TURN_ID, status: "", items: [] }] }],
    ["turns[last].items", { turns: [{ id: TURN_ID, status: "inProgress", items: null }] }],
    ["turns", { turns: [] }],
  ])("rejects a malformed required thread/read field: %s", async (field, overrides) => {
    const client = createClient(() => ({ thread: rawThread(overrides) }));

    await expect(
      new SessionGuardianAppServer(client).readThread(THREAD_ID),
    ).rejects.toThrow(`Invalid app-server response: thread/read.thread.${field}`);
  });

  it("creates a fingerprint only for an active in-progress turn", () => {
    const snapshot: GuardianThreadSnapshot = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      threadStatus: "active",
      turnStatus: "inProgress",
      updatedAt: 1_723_000_000,
      itemCount: 2,
      lastItemType: "agentMessage",
      source: "cli",
      cwd: "/srv/projects/telecodex",
      name: null,
      canAcceptDirectInput: false,
      root: true,
    };

    expect(fingerprintOf(snapshot)).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      updatedAt: 1_723_000_000,
      itemCount: 2,
      lastItemType: "agentMessage",
    });
    expect(fingerprintOf({ ...snapshot, threadStatus: "idle" })).toBeNull();
    expect(fingerprintOf({ ...snapshot, turnStatus: "completed" })).toBeNull();
    expect(fingerprintOf({ ...snapshot, turnId: null })).toBeNull();
  });

  it.each(["thread/loaded/list", "thread/read"] as const)(
    "retries transient overload for read-only RPC %s",
    async (overloadedMethod) => {
      vi.useFakeTimers();
      let overloads = 0;
      const client = {
        request: vi.fn(async (method: string) => {
          if (method === overloadedMethod && overloads++ === 0) {
            throw new AppServerRequestError("APP_SERVER_REJECTED", -32001, "OTHER");
          }
          if (method === "thread/loaded/list") return { data: [] };
          if (method === "thread/read") return { thread: rawThread() };
          throw new Error(`Unexpected method: ${method}`);
        }),
        close: vi.fn(),
      };
      const gateway = new SessionGuardianAppServer(client);

      const pending = overloadedMethod === "thread/read"
        ? gateway.readThread(THREAD_ID).then((snapshot) => snapshot.threadId)
        : gateway.listRootThreads(listScope()).then((snapshots) => snapshots.length);
      const assertion = overloadedMethod === "thread/read"
        ? expect(pending).resolves.toBe(THREAD_ID)
        : expect(pending).resolves.toBe(0);
      await vi.runAllTimersAsync();

      await assertion;
      expect(client.request.mock.calls.filter(([method]) => method === overloadedMethod)).toHaveLength(2);
    },
  );

  it.each(["APP_SERVER_NOT_SENT", "APP_SERVER_ACCEPTANCE_UNKNOWN"] as const)(
    "retries transient typed transport state %s for a read-only RPC",
    async (code) => {
      vi.useFakeTimers();
      const failure = new AppServerRequestError(code);
      let attempts = 0;
      const client = createClient(() => {
        attempts += 1;
        if (attempts === 1) throw failure;
        return { thread: rawThread() };
      });
      const gateway = new SessionGuardianAppServer(client);

      const pending = gateway.readThread(THREAD_ID);
      const assertion = expect(pending).resolves.toMatchObject({ threadId: THREAD_ID });
      await vi.runAllTimersAsync();

      await assertion;
      expect(client.request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["overload", new AppServerRequestError("APP_SERVER_REJECTED", -32001, "OTHER")],
    ["not sent", new AppServerRequestError("APP_SERVER_NOT_SENT")],
    ["acceptance unknown", new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN")],
  ] as const)("stops after bounded retries for %s", async (_label, failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const attemptTimes: number[] = [];
    const client = createClient(() => {
      attemptTimes.push(Date.now());
      throw failure;
    });
    const gateway = new SessionGuardianAppServer(client);

    const pending = gateway.readThread(THREAD_ID);
    const assertion = expect(pending).rejects.toBe(failure);
    await vi.runAllTimersAsync();

    await assertion;
    expect(client.request).toHaveBeenCalledTimes(7);
    expect(attemptTimes).toEqual([0, 100, 350, 850, 1_850, 3_350, 5_850]);
  });

  it.each([
    new AppServerRequestError("APP_SERVER_REJECTED", -32600, "OTHER"),
    new Error("transport failed"),
  ])("does not retry a non-overload read failure", async (failure) => {
    const client = createClient(() => {
      throw failure;
    });
    const gateway = new SessionGuardianAppServer(client);

    await expect(gateway.readThread(THREAD_ID)).rejects.toBe(failure);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    new AppServerRequestError("APP_SERVER_REJECTED", -32001, "OTHER"),
    new AppServerRequestError("APP_SERVER_NOT_SENT"),
    new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN"),
  ])("does not retry a transient failure for a mutating RPC", async (failure) => {
    const client = createClient(() => {
      throw failure;
    });
    const gateway = new SessionGuardianAppServer(client);

    await expect(gateway.interrupt(THREAD_ID, TURN_ID)).rejects.toBe(failure);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("cancels an overload backoff when the gateway closes", async () => {
    vi.useFakeTimers();
    const client = createClient(() => {
      throw new AppServerRequestError("APP_SERVER_REJECTED", -32001, "OTHER");
    });
    const gateway = new SessionGuardianAppServer(client);

    const outcome = gateway.readThread(THREAD_ID).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledTimes(1);

    gateway.close();
    await vi.runAllTimersAsync();

    await expect(outcome).resolves.toMatchObject({
      error: { message: "Session guardian app-server is closed" },
    });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("keeps overload retry inside the original inspection deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const attemptTimes: number[] = [];
    const client = createClient(() => {
      attemptTimes.push(Date.now());
      throw new AppServerRequestError("APP_SERVER_REJECTED", -32001, "OTHER");
    });
    const gateway = new SessionGuardianAppServer(client, { requestTimeoutMs: 1_000 });

    const outcome = gateway.readThread(THREAD_ID).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(attemptTimes).toEqual([0, 100, 350, 850]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({
      error: { message: "App-server request timed out: thread/read" },
    });
    expect(Date.now()).toBe(1_000);
    expect(client.request).toHaveBeenCalledTimes(4);
  });

  it("closes the client and names the method when a request exceeds its deadline", async () => {
    vi.useFakeTimers();
    const client = createClient(() => new Promise(() => undefined));
    const gateway = new SessionGuardianAppServer(client, { requestTimeoutMs: 25 });

    const pending = gateway.readThread(THREAD_ID);
    const assertion = expect(pending).rejects.toThrow(
      "App-server request timed out: thread/read",
    );
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("shares one deadline across loaded-list, header, and full-read stages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = {
      request: vi.fn((method: string, params?: unknown) => new Promise((resolve) => {
        setTimeout(() => {
          if (method === "thread/loaded/list") resolve({ data: [THREAD_ID] });
          else if (method === "thread/read") resolve({ thread: rawThread({ ephemeral: false }) });
          else throw new Error(`Unexpected method: ${method}`);
        }, (params as { includeTurns?: boolean } | undefined)?.includeTurns ? 40 : 35);
      })),
      close: vi.fn(),
    };
    const gateway = new SessionGuardianAppServer(client, {
      requestTimeoutMs: 10_000,
      listRootThreadsTimeoutMs: 100,
      monotonicClock: Date.now,
    });

    const pending = gateway.listRootThreads(listScope());
    const assertion = expect(pending).rejects.toThrow(
      "App-server request timed out: thread/read",
    );
    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(Date.now()).toBe(100);
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: false }],
      ["thread/read", { threadId: THREAD_ID, includeTurns: true }],
    ]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not start another listRootThreads stage after its total budget expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const secondThreadId = "019ff4ea-8c36-7c5f-8f08-030303030303";
    const client = {
      request: vi.fn((method: string) => new Promise((resolve) => {
        setTimeout(() => {
          if (method === "thread/loaded/list") {
            resolve({ data: [THREAD_ID, secondThreadId] });
          } else if (method === "thread/read") {
            resolve({ thread: rawThread({ status: { type: "idle" }, ephemeral: false }) });
          } else {
            throw new Error(`Unexpected method: ${method}`);
          }
        }, 50);
      })),
      close: vi.fn(),
    };
    const gateway = new SessionGuardianAppServer(client, {
      requestTimeoutMs: 10_000,
      listRootThreadsTimeoutMs: 100,
      monotonicClock: Date.now,
    });

    const pending = gateway.listRootThreads(listScope());
    const assertion = expect(pending).rejects.toThrow(
      "App-server request timed out: thread/read",
    );
    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(client.request.mock.calls).toEqual([
      ["thread/loaded/list", {}],
      ["thread/read", { threadId: THREAD_ID, includeTurns: false }],
    ]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("keeps the listRootThreads deadline when the wall clock moves backward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let monotonicNow = 0;
    const loaded = deferred<unknown>();
    const client = {
      request: vi.fn((method: string) => {
        if (method === "thread/loaded/list") return loaded.promise;
        if (method === "thread/read") return new Promise(() => undefined);
        throw new Error(`Unexpected method: ${method}`);
      }),
      close: vi.fn(),
    };
    const gateway = new SessionGuardianAppServer(client, {
      requestTimeoutMs: 10_000,
      listRootThreadsTimeoutMs: 100,
      monotonicClock: () => monotonicNow,
    });
    const pending = gateway.listRootThreads(listScope());
    let outcome: unknown;
    void pending.catch((error: unknown) => { outcome = error; });

    vi.setSystemTime(0);
    monotonicNow = 50;
    loaded.resolve({ data: [THREAD_ID] });
    await vi.advanceTimersByTimeAsync(0);
    monotonicNow = 100;
    await vi.advanceTimersByTimeAsync(50);

    try {
      expect(outcome).toMatchObject({ message: "App-server request timed out: thread/read" });
      expect(client.request).toHaveBeenCalledTimes(2);
      expect(client.close).toHaveBeenCalledOnce();
    } finally {
      gateway.close();
      await pending.catch(() => undefined);
    }
  });

  it("clears its deadline when client.request throws synchronously", async () => {
    vi.useFakeTimers();
    let shouldThrow = true;
    const client = createClient(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("synchronous request failure");
      }
      return { thread: rawThread() };
    });
    const gateway = new SessionGuardianAppServer(client, { requestTimeoutMs: 25 });

    await expect(gateway.readThread(THREAD_ID)).rejects.toThrow("synchronous request failure");
    await expect(gateway.readThread(THREAD_ID)).resolves.toMatchObject({ threadId: THREAD_ID });
    await vi.advanceTimersByTimeAsync(25);

    expect(client.close).not.toHaveBeenCalled();
  });

  it("interrupts exactly the requested thread and turn", async () => {
    const client = createClient(() => ({}));
    const gateway = new SessionGuardianAppServer(client);

    await gateway.interrupt(THREAD_ID, TURN_ID);

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
  });

  it("polls the condition until the thread becomes idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const states = [
      rawThread(),
      rawThread({ updatedAt: 1_723_000_001 }),
      rawThread({
        status: { type: "idle" },
        turns: [{ id: TURN_ID, status: "completed", items: [] }],
        canAcceptDirectInput: true,
      }),
    ];
    const client = createClient((method) => {
      if (method !== "thread/read") throw new Error(`Unexpected method: ${method}`);
      return { thread: states.shift() };
    });
    const gateway = new SessionGuardianAppServer(client, { pollIntervalMs: 1 });

    const pending = gateway.waitForIdle(THREAD_ID, 100);
    await vi.advanceTimersByTimeAsync(2);
    const snapshot = await pending;

    expect(snapshot.threadStatus).toBe("idle");
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("bounds idle polling by the supplied timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = createClient((method) => {
      if (method !== "thread/read") throw new Error(`Unexpected method: ${method}`);
      return { thread: rawThread() };
    });
    const gateway = new SessionGuardianAppServer(client, { pollIntervalMs: 1 });

    const pending = gateway.waitForIdle(THREAD_ID, 5);
    const assertion = expect(pending).rejects.toThrow(
      `Timed out waiting for thread ${THREAD_ID} to become idle`,
    );
    await vi.advanceTimersByTimeAsync(5);

    await assertion;
    expect(client.request.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops an in-flight idle wait and blocks future requests after close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = createClient(() => ({ thread: rawThread() }));
    const gateway = new SessionGuardianAppServer(client, { pollIntervalMs: 10 });

    const pending = gateway.waitForIdle(THREAD_ID, 100);
    const outcome = pending.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledTimes(1);

    gateway.close();
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcome).resolves.toMatchObject({
      error: { message: "Session guardian app-server is closed" },
    });
    expect(client.request).toHaveBeenCalledTimes(1);
    await expect(gateway.readThread(THREAD_ID)).rejects.toThrow(
      "Session guardian app-server is closed",
    );
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("cold reloads only the requested thread with exact RPCs", async () => {
    const client = createClient((method) => {
      if (method === "thread/read") {
        return {
          thread: rawThread({
            status: { type: "idle" },
            canAcceptDirectInput: true,
          }),
        };
      }
      return {};
    });
    const gateway = new SessionGuardianAppServer(client);

    const snapshot = await gateway.coldReload(THREAD_ID);

    expect(snapshot.threadStatus).toBe("idle");
    expect(client.request.mock.calls).toEqual([
      ["thread/archive", { threadId: THREAD_ID }],
      ["thread/unarchive", { threadId: THREAD_ID }],
      ["thread/resume", { threadId: THREAD_ID }],
      ["thread/read", { threadId: THREAD_ID, includeTurns: true }],
    ]);
  });

  it("best-effort unarchives after an archive rejection and preserves the primary error", async () => {
    const client = createClient((method) => {
      if (method === "thread/archive") throw new Error("archive response lost");
      if (method === "thread/unarchive") throw new Error("compensation failed");
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = new SessionGuardianAppServer(client);

    await expect(gateway.coldReload(THREAD_ID)).rejects.toThrow("archive response lost");
    expect(client.request.mock.calls).toEqual([
      ["thread/archive", { threadId: THREAD_ID }],
      ["thread/unarchive", { threadId: THREAD_ID }],
    ]);
  });

  it("best-effort unarchives after an ambiguous archive timeout", async () => {
    vi.useFakeTimers();
    const client = createClient((method) => {
      if (method === "thread/archive") return new Promise(() => undefined);
      if (method === "thread/unarchive") return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = new SessionGuardianAppServer(client, { requestTimeoutMs: 25 });

    const pending = gateway.coldReload(THREAD_ID);
    const assertion = expect(pending).rejects.toThrow(
      "App-server request timed out: thread/archive",
    );
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(client.request.mock.calls).toEqual([
      ["thread/archive", { threadId: THREAD_ID }],
      ["thread/unarchive", { threadId: THREAD_ID }],
    ]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it.each(["thread/resume", "thread/read"])(
    "does not leave history archived when %s fails",
    async (failingMethod) => {
      const client = createClient((method) => {
        if (method === failingMethod) throw new Error(`${failingMethod} failed`);
        return {};
      });
      const gateway = new SessionGuardianAppServer(client);

      await expect(gateway.coldReload(THREAD_ID)).rejects.toThrow(`${failingMethod} failed`);

      const expectedCalls: unknown[][] = [
        ["thread/archive", { threadId: THREAD_ID }],
        ["thread/unarchive", { threadId: THREAD_ID }],
        ["thread/resume", { threadId: THREAD_ID }],
      ];
      if (failingMethod === "thread/read") {
        expectedCalls.push(["thread/read", { threadId: THREAD_ID, includeTurns: true }]);
      }
      expect(client.request.mock.calls).toEqual(expectedCalls);
    },
  );

  it("delegates close to the shared app-server client", () => {
    const client = createClient(() => ({}));
    const gateway = new SessionGuardianAppServer(client);

    gateway.close();

    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
