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

import { startTelegramRunner } from "../src/telegram-runner.js";

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
});
