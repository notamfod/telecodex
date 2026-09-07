import { vi } from "vitest";

import {
  TelegramBackgroundWriteGate,
  TelegramBackgroundWriteGateAdmissionCancelledError,
  TelegramBackgroundWriteGateDisposedError,
  type TelegramBackgroundWriteGateOptions,
} from "../src/telegram-background-write-gate.js";

const CHAT_A = -1_001;
const CHAT_B = -1_002;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("TelegramBackgroundWriteGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts the initial burst of three operations immediately", async () => {
    const gate = new TelegramBackgroundWriteGate();
    const starts: number[] = [];

    const results = [1, 2, 3].map((value) => gate.run(CHAT_A, "ordinary", async () => {
      starts.push(Date.now());
      return value;
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(starts).toEqual([0, 0, 0]);
    await expect(Promise.all(results)).resolves.toEqual([1, 2, 3]);
    gate.dispose();
  });

  it("admits three deferred operations concurrently and settles them independently", async () => {
    const gate = new TelegramBackgroundWriteGate({
      maxPerWindow: 4,
      windowMs: 400,
      burst: 3,
    });
    const starts: number[] = [];
    const settled: number[] = [];
    const controls = [1, 2, 3, 4].map(() => deferred<number>());
    const operations = controls.map((control, index) => gate.run(CHAT_A, "ordinary", () => {
      starts.push(index + 1);
      return control.promise;
    }).then((value) => {
      settled.push(value);
      return value;
    }));
    const operationError = new Error("operation failed");
    const secondOutcome = operations[1].catch((error: unknown) => error);

    expect(starts).toEqual([1, 2, 3]);

    controls[1].reject(operationError);
    await expect(secondOutcome).resolves.toBe(operationError);
    controls[2].resolve(3);
    await expect(operations[2]).resolves.toBe(3);
    expect(settled).toEqual([3]);
    expect(starts).toEqual([1, 2, 3]);

    controls[0].resolve(1);
    await expect(operations[0]).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(starts).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([1, 2, 3, 4]);

    controls[3].resolve(4);
    await expect(Promise.all([operations[0], operations[2], operations[3]])).resolves.toEqual([1, 3, 4]);
    gate.dispose();
  });

  it("applies a concurrent 429 cooldown from its completion time to queued work", async () => {
    const gate = new TelegramBackgroundWriteGate({
      maxPerWindow: 4,
      windowMs: 400,
      burst: 3,
    });
    const starts: number[] = [];
    const controls = [1, 2, 3, 4].map(() => deferred<number>());
    const operations = controls.map((control, index) => gate.run(CHAT_A, "ordinary", () => {
      starts.push(performance.now());
      return control.promise;
    }));
    const rateLimitError = { error_code: 429, parameters: { retry_after: 1 } };
    const firstOutcome = operations[0].catch((error: unknown) => error);

    expect(starts).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(37);
    controls[0].reject(rateLimitError);
    await expect(firstOutcome).resolves.toBe(rateLimitError);

    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 0, 0, 1_037]);

    controls[1].resolve(2);
    controls[2].resolve(3);
    controls[3].resolve(4);
    await expect(Promise.all(operations.slice(1))).resolves.toEqual([2, 3, 4]);
    gate.dispose();
  });

  it("waits for a refill permit before starting a fourth operation", async () => {
    const gate = new TelegramBackgroundWriteGate();
    const starts: number[] = [];
    const operations = [1, 2, 3, 4].map((value) => gate.run(CHAT_A, "ordinary", async () => {
      starts.push(Date.now());
      return value;
    }));

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 0, 0]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(starts).toEqual([0, 0, 0]);

    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 0, 0, 5_000]);
    await Promise.all(operations);
    gate.dispose();
  });

  it("starts at most twelve operations in any rolling sixty second window", async () => {
    const gate = new TelegramBackgroundWriteGate();
    const starts: number[] = [];
    const operations = Array.from({ length: 13 }, () => gate.run(CHAT_A, "ordinary", async () => {
      starts.push(Date.now());
    }));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(starts).toHaveLength(12);

    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(13);
    for (const end of starts) {
      expect(starts.filter((start) => start > end - 60_000 && start <= end).length).toBeLessThanOrEqual(12);
    }
    await Promise.all(operations);
    gate.dispose();
  });

  it("accounts for a queued attempt when it actually starts rather than when it is enqueued", async () => {
    const options: TelegramBackgroundWriteGateOptions = {
      maxPerWindow: 2,
      windowMs: 60_000,
      burst: 1,
    };
    const gate = new TelegramBackgroundWriteGate(options);
    const starts: number[] = [];
    let releaseFirst!: () => void;
    const first = gate.run(CHAT_A, "ordinary", () => new Promise<void>((resolve) => {
      starts.push(Date.now());
      releaseFirst = resolve;
    }));
    const second = gate.run(CHAT_A, "ordinary", async () => {
      starts.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(30_000);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 30_000]);
    await Promise.all([first, second]);

    const third = gate.run(CHAT_A, "ordinary", async () => {
      starts.push(Date.now());
    });
    const fourth = gate.run(CHAT_A, "ordinary", async () => {
      starts.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(starts).toEqual([0, 30_000]);

    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 30_000, 60_000]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(starts).toEqual([0, 30_000, 60_000]);

    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 30_000, 60_000, 90_000]);
    await Promise.all([third, fourth]);
    gate.dispose();
  });

  it("retains idle rate-limit debt and evicts the state only after it is fully replenished", async () => {
    const gate = new TelegramBackgroundWriteGate({
      maxPerWindow: 2,
      windowMs: 100,
      burst: 1,
    });
    const starts: number[] = [];
    const operation = async () => {
      starts.push(performance.now());
    };

    await gate.run(CHAT_A, "ordinary", operation);
    expect(vi.getTimerCount()).toBe(1);

    const second = gate.run(CHAT_A, "ordinary", operation);
    await vi.advanceTimersByTimeAsync(49);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(starts).toEqual([0, 50]);

    await vi.advanceTimersByTimeAsync(99);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);

    await gate.run(CHAT_A, "ordinary", operation);
    expect(starts).toEqual([0, 50, 150]);
    gate.dispose();
  });

  it("keeps an idle state until its shared Telegram cooldown expires", async () => {
    const gate = new TelegramBackgroundWriteGate({
      maxPerWindow: 2,
      windowMs: 100,
      burst: 1,
    });
    const rateLimitError = { error_code: 429, parameters: { retry_after: 1 } };

    await expect(gate.run(CHAT_A, "ordinary", async () => {
      throw rateLimitError;
    })).rejects.toBe(rateLimitError);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);

    const starts: number[] = [];
    await gate.run(CHAT_A, "ordinary", async () => {
      starts.push(performance.now());
    });
    expect(starts).toEqual([1_000]);
    gate.dispose();
  });

  it("cleans up timers for many one-shot chats after their rate-limit history expires", async () => {
    const gate = new TelegramBackgroundWriteGate();
    const operations = Array.from({ length: 1_000 }, (_, chatId) => gate.run(
      chatId,
      "ordinary",
      async () => undefined,
    ));

    await Promise.all(operations);
    expect(vi.getTimerCount()).toBe(1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);

    await expect(gate.run(0, "ordinary", async () => "fresh")).resolves.toBe("fresh");
    gate.dispose();
  });

  it("lets another chat proceed while one chat is rate limited", async () => {
    const gate = new TelegramBackgroundWriteGate();
    const rateLimitError = { error_code: 429, parameters: { retry_after: 23 } };
    const starts: string[] = [];

    await expect(gate.run(CHAT_A, "ordinary", async () => {
      throw rateLimitError;
    })).rejects.toBe(rateLimitError);

    const blocked = gate.run(CHAT_A, "ordinary", async () => {
      starts.push("A");
    });
    const independent = gate.run(CHAT_B, "ordinary", async () => {
      starts.push("B");
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(starts).toEqual(["B"]);
    await independent;
    await vi.advanceTimersByTimeAsync(23_000);
    await blocked;
    expect(starts).toEqual(["B", "A"]);
    gate.dispose();
  });

  it("selects a queued urgent operation before an older ordinary operation", async () => {
    const gate = new TelegramBackgroundWriteGate({ burst: 1 });
    const starts: string[] = [];
    let releaseRunning!: () => void;

    const running = gate.run(CHAT_A, "ordinary", () => new Promise<void>((resolve) => {
      starts.push("running");
      releaseRunning = resolve;
    }));
    const ordinary = gate.run(CHAT_A, "ordinary", async () => {
      starts.push("ordinary");
    });
    const urgent = gate.run(CHAT_A, "urgent", async () => {
      starts.push("urgent");
    });

    expect(starts).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(starts).toEqual(["running", "urgent"]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(starts).toEqual(["running", "urgent", "ordinary"]);
    releaseRunning();
    await Promise.all([running, ordinary, urgent]);
    gate.dispose();
  });

  it("blocks all producers for the same chat for exactly retry_after seconds", async () => {
    const gate = new TelegramBackgroundWriteGate();
    const rateLimitError = {
      error: { error_code: 429, parameters: { retry_after: 23 } },
    };
    const starts: number[] = [];

    await expect(gate.run(CHAT_A, "ordinary", async () => {
      throw rateLimitError;
    })).rejects.toBe(rateLimitError);

    const queued = ["ordinary", "urgent"].map((priority) => gate.run(
      CHAT_A,
      priority as "ordinary" | "urgent",
      async () => {
        starts.push(Date.now());
      },
    ));
    await vi.advanceTimersByTimeAsync(22_999);
    expect(starts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([23_000, 23_000]);
    await Promise.all(queued);
    gate.dispose();
  });

  it.each([
    { label: "missing", error: { error_code: 429 } },
    { label: "invalid", error: { error_code: 429, parameters: { retry_after: 0 } } },
  ])("uses the thirty second fallback for $label retry_after", async ({ error }) => {
    const gate = new TelegramBackgroundWriteGate();
    const starts: number[] = [];

    await expect(gate.run(CHAT_A, "ordinary", async () => {
      throw error;
    })).rejects.toBe(error);
    const queued = gate.run(CHAT_A, "ordinary", async () => {
      starts.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([30_000]);
    await queued;
    gate.dispose();
  });

  it("rejects queued and subsequent operations on dispose without cancelling in-flight work", async () => {
    const gate = new TelegramBackgroundWriteGate({ burst: 1 });
    let finishInFlight!: () => void;
    const inFlight = gate.run(CHAT_A, "ordinary", () => new Promise<void>((resolve) => {
      finishInFlight = resolve;
    }));
    const queuedOutcome = gate.run(CHAT_A, "ordinary", async () => undefined).catch(
      (error: unknown) => error,
    );

    gate.dispose();

    await expect(queuedOutcome).resolves.toMatchObject({
      message: "Telegram background write gate disposed",
    });
    await expect(queuedOutcome).resolves.toBeInstanceOf(TelegramBackgroundWriteGateDisposedError);
    const subsequentOutcome = gate.run(CHAT_A, "urgent", async () => undefined).catch(
      (error: unknown) => error,
    );
    await expect(subsequentOutcome).resolves.toMatchObject({
      message: "Telegram background write gate disposed",
    });
    await expect(subsequentOutcome).resolves.toBeInstanceOf(TelegramBackgroundWriteGateDisposedError);

    finishInFlight();
    await expect(inFlight).resolves.toBeUndefined();
  });

  it("cancels only the selected queued admission and leaves another queued operation runnable", async () => {
    const gate = new TelegramBackgroundWriteGate({ burst: 1 });
    const cancelledController = new AbortController();
    const cancelledOperation = vi.fn(async () => "cancelled");
    const survivingOperation = vi.fn(async () => "survived");

    await expect(gate.run(CHAT_A, "ordinary", async () => "occupant")).resolves.toBe("occupant");
    const cancelled = gate.run(
      CHAT_A,
      "ordinary",
      cancelledOperation,
      cancelledController.signal,
    ).catch((error: unknown) => error);
    const surviving = gate.run(CHAT_A, "ordinary", survivingOperation);

    cancelledController.abort();

    await expect(cancelled).resolves.toBeInstanceOf(
      TelegramBackgroundWriteGateAdmissionCancelledError,
    );
    expect(cancelledOperation).not.toHaveBeenCalled();
    expect(survivingOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(surviving).resolves.toBe("survived");
    expect(survivingOperation).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it("removes a cancelled sole queue entry and its drain timer before dispose", async () => {
    const gate = new TelegramBackgroundWriteGate({ burst: 1 });
    const controller = new AbortController();
    let releaseAdmitted!: () => void;
    const admitted = gate.run(CHAT_A, "ordinary", () => new Promise<void>((resolve) => {
      releaseAdmitted = resolve;
    }));
    const operation = vi.fn(async () => undefined);
    const queued = gate.run(CHAT_A, "ordinary", operation, controller.signal)
      .catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();

    await expect(queued).resolves.toBeInstanceOf(
      TelegramBackgroundWriteGateAdmissionCancelledError,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    gate.dispose();
    expect(vi.getTimerCount()).toBe(0);
    releaseAdmitted();
    await expect(admitted).resolves.toBeUndefined();
  });

  it("does not falsely cancel an operation after admission", async () => {
    const gate = new TelegramBackgroundWriteGate({ burst: 1 });
    const controller = new AbortController();
    let release!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const admitted = gate.run(CHAT_A, "ordinary", operation, controller.signal);
    let settled = false;
    void admitted.finally(() => { settled = true; });

    expect(operation).toHaveBeenCalledOnce();
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);

    release("admitted");
    await expect(admitted).resolves.toBe("admitted");
    gate.dispose();
  });

  it("keeps multiple admitted operations alive on dispose and removes their state after all settle", async () => {
    const gate = new TelegramBackgroundWriteGate();
    const controls = [1, 2, 3].map(() => deferred<number>());
    const admitted = controls.map((control) => gate.run(
      CHAT_A,
      "ordinary",
      () => control.promise,
    ));
    const admittedOutcomes = admitted.map((operation) => operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ));
    const queuedOutcome = gate.run(CHAT_A, "ordinary", async () => 4).catch(
      (error: unknown) => error,
    );

    gate.dispose();

    await expect(queuedOutcome).resolves.toBeInstanceOf(TelegramBackgroundWriteGateDisposedError);
    expect((gate as unknown as { states: Map<number, unknown> }).states.size).toBe(1);

    controls[2].resolve(3);
    await expect(admittedOutcomes[2]).resolves.toEqual({ value: 3 });
    controls[0].resolve(1);
    await expect(admittedOutcomes[0]).resolves.toEqual({ value: 1 });
    expect((gate as unknown as { states: Map<number, unknown> }).states.size).toBe(1);

    controls[1].resolve(2);
    await expect(admittedOutcomes[1]).resolves.toEqual({ value: 2 });
    expect((gate as unknown as { states: Map<number, unknown> }).states.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending queue timer on dispose while allowing another chat's in-flight work to settle", async () => {
    const gate = new TelegramBackgroundWriteGate();
    let finishInFlight!: (value: string) => void;
    const inFlight = gate.run(CHAT_A, "ordinary", () => new Promise<string>((resolve) => {
      finishInFlight = resolve;
    }));
    const burst = [1, 2, 3].map((value) => gate.run(CHAT_B, "ordinary", async () => value));
    let queuedStarted = false;
    const queuedOutcome = gate.run(CHAT_B, "ordinary", async () => {
      queuedStarted = true;
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    await expect(Promise.all(burst)).resolves.toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(1);

    gate.dispose();

    expect(vi.getTimerCount()).toBe(0);
    await expect(queuedOutcome).resolves.toMatchObject({
      message: "Telegram background write gate disposed",
    });
    await expect(queuedOutcome).resolves.toBeInstanceOf(TelegramBackgroundWriteGateDisposedError);
    expect(queuedStarted).toBe(false);

    finishInFlight("settled");
    await expect(inFlight).resolves.toBe("settled");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queuedStarted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await expect(gate.run(CHAT_B, "ordinary", async () => undefined)).rejects.toThrow(
      "Telegram background write gate disposed",
    );
  });

  it("rejects every queued operation and removes the state when the clock throws during drain", async () => {
    const clockError = new Error("clock failed");
    let reads = 0;
    const gate = new TelegramBackgroundWriteGate({
      now: () => {
        reads += 1;
        if (reads === 2) throw clockError;
        return 0;
      },
    });
    const starts: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const first = gate.run(CHAT_A, "ordinary", async () => {
        starts.push("first");
      }).catch((error: unknown) => error);
      const second = gate.run(CHAT_A, "ordinary", async () => {
        starts.push("second");
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      await expect(Promise.all([first, second])).resolves.toEqual([
        clockError,
        clockError,
      ]);
      expect(starts).toEqual([]);
      expect(unhandled).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      await expect(gate.run(CHAT_A, "ordinary", async () => "fresh")).resolves.toBe("fresh");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      gate.dispose();
    }
  });

  it("rejects a queued operation when an injected clock moves backward", async () => {
    let currentTime = 10;
    const gate = new TelegramBackgroundWriteGate({ burst: 1, now: () => currentTime });
    let releaseFirst!: () => void;
    let secondStarted = false;
    const first = gate.run(CHAT_A, "ordinary", () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const second = gate.run(CHAT_A, "ordinary", async () => {
      secondStarted = true;
    });
    const secondOutcome = second.catch((error: unknown) => error);

    currentTime = 5;
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(secondOutcome).resolves.toMatchObject({ message: "now must be nondecreasing" });
    expect(secondStarted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    gate.dispose();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite injected clock reading: %s",
    async (clockReading) => {
      const gate = new TelegramBackgroundWriteGate({ now: () => clockReading });

      await expect(gate.run(CHAT_A, "ordinary", async () => undefined)).rejects.toThrow(
        "now must return a finite number",
      );
      expect(vi.getTimerCount()).toBe(0);
      gate.dispose();
    },
  );

  it("does not use the wall clock for default elapsed-time accounting", async () => {
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock adjusted");
    });
    const gate = new TelegramBackgroundWriteGate();

    try {
      await expect(gate.run(CHAT_A, "ordinary", async () => "ok")).resolves.toBe("ok");
    } finally {
      gate.dispose();
      wallClock.mockRestore();
    }
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
  ])("rejects an invalid chat id: %s", async (chatId) => {
    const gate = new TelegramBackgroundWriteGate();
    const operation = vi.fn(async () => undefined);

    await expect(gate.run(chatId, "ordinary", operation)).rejects.toThrow(
      "chatId must be a safe integer",
    );
    expect(operation).not.toHaveBeenCalled();
    gate.dispose();
  });

  it.each([
    { maxPerWindow: 0 },
    { maxPerWindow: -1 },
    { maxPerWindow: 1.5 },
    { maxPerWindow: Number.MAX_SAFE_INTEGER + 1 },
    { windowMs: 0 },
    { windowMs: -1 },
    { windowMs: 1.5 },
    { windowMs: Number.MAX_SAFE_INTEGER + 1 },
    { burst: 0 },
    { burst: -1 },
    { burst: 1.5 },
    { burst: Number.MAX_SAFE_INTEGER + 1 },
    { maxPerWindow: 2, burst: 3 },
  ])("rejects invalid constructor options: %j", (options) => {
    expect(() => new TelegramBackgroundWriteGate(options)).toThrow();
  });
});
