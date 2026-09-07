import { vi } from "vitest";

const runnerState = vi.hoisted(() => ({
  handle: {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    size: vi.fn(() => 0),
    task: vi.fn(() => Promise.resolve()),
    isRunning: vi.fn(() => true),
  },
  run: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({
  run: runnerState.run,
}));

import {
  startTelegramRunner,
  startTelegramRunnerAfterReconciliation,
} from "../src/telegram-runner.js";

describe("startTelegramRunner", () => {
  it("uses concurrent update handling so independent topics do not block each other", () => {
    runnerState.run.mockReturnValue(runnerState.handle);
    const bot = { handleUpdate: vi.fn() };

    const handle = startTelegramRunner(bot as never);

    expect(handle).toBe(runnerState.handle);
    expect(runnerState.run).toHaveBeenCalledWith(bot, {
      runner: {
        maxRetryTime: 54_000_000,
        retryInterval: "exponential",
      },
      sink: { concurrency: 100 },
    });
  });

  it("finishes injected reconciliation before accepting Telegram updates", async () => {
    const calls: string[] = [];
    const bot = {
      recoverPendingJobs: vi.fn(async () => {
        throw new Error("legacy recovery must not be called by the runner");
      }),
      handleUpdate: vi.fn(),
    };
    const reconcileUnfinishedJobs = vi.fn(async () => {
      calls.push("recover");
    });
    const start = vi.fn(() => {
      calls.push("poll");
      return runnerState.handle;
    });

    const handle = await startTelegramRunnerAfterReconciliation(
      bot as never,
      reconcileUnfinishedJobs,
      start,
    );

    expect(handle).toBe(runnerState.handle);
    expect(calls).toEqual(["recover", "poll"]);
    expect(bot.recoverPendingJobs).not.toHaveBeenCalled();
  });

  it("does not start polling when initial reconciliation rejects", async () => {
    const bot = { handleUpdate: vi.fn() };
    const reconcileUnfinishedJobs = vi.fn(async () => {
      throw new Error("ledger unavailable");
    });
    const start = vi.fn(() => runnerState.handle);

    await expect(
      startTelegramRunnerAfterReconciliation(
        bot as never,
        reconcileUnfinishedJobs,
        start,
      ),
    ).rejects.toThrow("ledger unavailable");
    expect(start).not.toHaveBeenCalled();
  });

  it("waits for bounded unavailable reconciliation to settle before polling", async () => {
    const bot = { handleUpdate: vi.fn() };
    let settle!: (result: { availability: "unavailable" }) => void;
    const boundedUnavailable = new Promise<{ availability: "unavailable" }>((resolve) => {
      settle = resolve;
    });
    const start = vi.fn(() => runnerState.handle);

    const pending = startTelegramRunnerAfterReconciliation(
      bot as never,
      () => boundedUnavailable,
      start,
    );
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();

    settle({ availability: "unavailable" });
    await expect(pending).resolves.toBe(runnerState.handle);
    expect(start).toHaveBeenCalledOnce();
  });

  it("does not start polling when shutdown begins during reconciliation", async () => {
    const bot = { handleUpdate: vi.fn() };
    let settle!: () => void;
    const reconciliation = new Promise<void>((resolve) => { settle = resolve; });
    let shuttingDown = false;
    const start = vi.fn(() => runnerState.handle);

    const pending = startTelegramRunnerAfterReconciliation(
      bot as never,
      () => reconciliation,
      start,
      () => !shuttingDown,
    );
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();

    shuttingDown = true;
    settle();

    await expect(pending).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
});
