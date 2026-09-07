import { describe, expect, it, vi } from "vitest";

import {
  createTeleCodexLifecycle,
  runTeleCodexShutdownSafely,
} from "../src/lifecycle.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("TeleCodex lifecycle", () => {
  it("cleans a failed polling runtime in dependency order and exits afterward", async () => {
    const events: string[] = [];
    const reliabilityDrain = deferred();
    const lifecycle = createTeleCodexLifecycle({
      onBegin: () => events.push("begin"),
      resources: () => ({
        topicSynchronizer: { stop: () => { events.push("topic.stop"); } },
        statusBoard: { stop: () => { events.push("status.stop"); } },
        miniAppServer: { close: async () => { events.push("mini.close"); } },
        runner: { stop: async () => { events.push("runner.stop"); } },
        retentionRuntime: { dispose: async () => { events.push("retention.dispose"); } },
        reliabilityRuntime: { dispose: () => {
          events.push("reliability.begin");
          return reliabilityDrain.promise.then(() => { events.push("reliability.end"); });
        } },
        backgroundWriteGate: { dispose: () => { events.push("gate.dispose"); } },
        sqliteJobStore: { close: () => { events.push("sqlite.close"); } },
        registry: { disposeAll: () => { events.push("registry.dispose"); } },
      }),
      exit: (code) => { events.push(`exit.${code}`); },
    });

    const termination = lifecycle.terminate({ exitCode: 1, runner: "inactive" });
    await vi.waitFor(() => expect(events).toContain("gate.dispose"));

    expect(events).toEqual([
      "begin",
      "topic.stop",
      "status.stop",
      "mini.close",
      "retention.dispose",
      "reliability.begin",
      "gate.dispose",
    ]);

    reliabilityDrain.resolve();
    await termination;

    expect(events).toEqual([
      "begin",
      "topic.stop",
      "status.stop",
      "mini.close",
      "retention.dispose",
      "reliability.begin",
      "gate.dispose",
      "reliability.end",
      "sqlite.close",
      "registry.dispose",
      "exit.1",
    ]);
  });

  it("supports partially initialized startup resources", async () => {
    const events: string[] = [];
    const lifecycle = createTeleCodexLifecycle({
      onBegin: () => events.push("begin"),
      resources: () => ({}),
      exit: (code) => { events.push(`exit.${code}`); },
    });

    await lifecycle.terminate({ exitCode: 1, runner: "inactive" });

    expect(events).toEqual(["begin", "exit.1"]);
  });

  it("shares one cleanup and exit promise across concurrent callers", async () => {
    const miniClosed = deferred();
    const onBegin = vi.fn();
    const close = vi.fn(() => miniClosed.promise);
    const exit = vi.fn();
    const lifecycle = createTeleCodexLifecycle({
      onBegin,
      resources: () => ({ miniAppServer: { close } }),
      exit,
    });

    const first = lifecycle.terminate({ exitCode: 1, runner: "inactive" });
    const second = lifecycle.terminate({ exitCode: 0, runner: "stop" });

    expect(second).toBe(first);
    expect(onBegin).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    miniClosed.resolve();
    await first;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("publishes the termination promise before a cleanup callback can reenter", async () => {
    let lifecycle!: ReturnType<typeof createTeleCodexLifecycle>;
    let reentrantTermination: Promise<void> | undefined;
    const exit = vi.fn();
    lifecycle = createTeleCodexLifecycle({
      onBegin: () => {
        reentrantTermination = lifecycle.terminate({ exitCode: 0, runner: "stop" });
      },
      resources: () => ({}),
      exit,
    });

    const termination = lifecycle.terminate({ exitCode: 1, runner: "inactive" });
    await termination;

    expect(reentrantTermination).toBe(termination);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("isolates cleanup failures and still closes later resources before exit", async () => {
    const events: string[] = [];
    const failures: string[] = [];
    const lifecycle = createTeleCodexLifecycle({
      onBegin: () => events.push("begin"),
      resources: () => ({
        topicSynchronizer: { stop: () => { events.push("topic"); throw new Error("topic"); } },
        statusBoard: { stop: () => { events.push("status"); throw new Error("status"); } },
        miniAppServer: { close: async () => { events.push("mini"); throw new Error("mini"); } },
        retentionRuntime: { dispose: async () => { events.push("retention"); throw new Error("retention"); } },
        reliabilityRuntime: { dispose: () => { events.push("reliability"); throw new Error("reliability"); } },
        backgroundWriteGate: { dispose: () => { events.push("gate"); throw new Error("gate"); } },
        sqliteJobStore: { close: () => { events.push("sqlite"); throw new Error("sqlite"); } },
        registry: { disposeAll: () => { events.push("registry"); throw new Error("registry"); } },
      }),
      onCleanupError: (step) => { failures.push(step); },
      exit: (code) => { events.push(`exit.${code}`); },
    });

    await lifecycle.terminate({ exitCode: 1, runner: "inactive" });

    expect(events).toEqual([
      "begin", "topic", "status", "mini", "retention", "reliability",
      "gate", "sqlite", "registry", "exit.1",
    ]);
    expect(failures).toEqual([
      "topic-synchronizer", "status-board", "mini-app", "retention-runtime",
      "reliability-runtime", "background-write-gate", "sqlite-job-store", "session-registry",
    ]);
  });

  it("bounds signal runner shutdown at five seconds and preserves active-job stores", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const lifecycle = createTeleCodexLifecycle({
        onBegin: () => events.push("begin"),
        resources: () => ({
          runner: { stop: () => new Promise<void>(() => undefined) },
          sqliteJobStore: { close: () => { events.push("sqlite.close"); } },
          registry: { disposeAll: () => { events.push("registry.dispose"); } },
        }),
        onRunnerStopIncomplete: () => { events.push("jobs.preserved"); },
        exit: (code) => { events.push(`exit.${code}`); },
      });

      const termination = lifecycle.terminate({ exitCode: 0, runner: "stop" });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(events).toEqual(["begin"]);

      await vi.advanceTimersByTimeAsync(1);
      await termination;

      expect(events).toEqual(["begin", "jobs.preserved", "exit.0"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a throwing exit at the signal-handler boundary", async () => {
    const exitError = new Error("exit failed");
    const onError = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const lifecycle = createTeleCodexLifecycle({
        onBegin: () => undefined,
        resources: () => ({}),
        exit: () => { throw exitError; },
      });
      let termination: Promise<void> | undefined;

      runTeleCodexShutdownSafely(() => {
        termination = lifecycle.terminate({ exitCode: 0, runner: "stop" });
        return termination;
      }, onError);

      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(exitError));
      await expect(termination).rejects.toBe(exitError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
