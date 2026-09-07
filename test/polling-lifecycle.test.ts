import { describe, expect, it, vi } from "vitest";

import { restartPollingAfterDelay } from "../src/polling-lifecycle.js";

describe("polling lifecycle", () => {
  it("does not restart polling when shutdown begins during retry backoff", async () => {
    let releaseDelay!: () => void;
    const delay = new Promise<void>((resolve) => { releaseDelay = resolve; });
    let shuttingDown = false;
    const wait = vi.fn(() => delay);
    const restart = vi.fn(async () => undefined);

    const retry = restartPollingAfterDelay({
      delayMs: 3_000,
      isShuttingDown: () => shuttingDown,
      wait,
      restart,
    });
    expect(wait).toHaveBeenCalledWith(3_000);

    shuttingDown = true;
    releaseDelay();
    await retry;

    expect(restart).not.toHaveBeenCalled();
  });
});
