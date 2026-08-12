import { vi } from "vitest";

import { TurnScheduler } from "../src/turn-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TurnScheduler", () => {
  it("runs up to the configured number of topic keys in parallel", async () => {
    const scheduler = new TurnScheduler(2);
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const starts: string[] = [];
    const queued = vi.fn();

    const a = scheduler.run("topic-a", async () => {
      starts.push("a");
      await first.promise;
    });
    const b = scheduler.run("topic-b", async () => {
      starts.push("b");
      await second.promise;
    });
    const c = scheduler.run("topic-c", async () => {
      starts.push("c");
      await third.promise;
    }, { onQueued: queued });

    await vi.waitFor(() => expect(starts).toEqual(["a", "b"]));
    expect(queued).toHaveBeenCalledWith({ position: 1, active: 2, limit: 2 });

    first.resolve();
    await vi.waitFor(() => expect(starts).toEqual(["a", "b", "c"]));
    second.resolve();
    third.resolve();
    await Promise.all([a, b, c]);
  });

  it("serializes tasks with the same topic key even when another slot is free", async () => {
    const scheduler = new TurnScheduler(2);
    const first = deferred();
    const order: string[] = [];

    const a1 = scheduler.run("topic-a", async () => {
      order.push("a1-start");
      await first.promise;
      order.push("a1-end");
    });
    const a2 = scheduler.run("topic-a", async () => {
      order.push("a2");
    });
    const b = scheduler.run("topic-b", async () => {
      order.push("b");
    });

    await vi.waitFor(() => expect(order).toEqual(["a1-start", "b"]));
    first.resolve();
    await Promise.all([a1, a2, b]);
    expect(order).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });

  it("cancels a queued task without disturbing active topics", async () => {
    const scheduler = new TurnScheduler(1);
    const first = deferred();
    const active = scheduler.run("topic-a", () => first.promise);
    const callbacks = { onQueued: vi.fn() };
    const queued = scheduler.run("topic-b", async () => undefined, callbacks);

    await vi.waitFor(() => expect(callbacks.onQueued).toHaveBeenCalled());
    expect(scheduler.cancel("topic-b", callbacks)).toBe(true);
    await expect(queued).rejects.toThrow("aborted");

    first.resolve();
    await active;
  });
});
