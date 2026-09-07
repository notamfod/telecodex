import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { vi } from "vitest";

import {
  TelegramDeliveryApiError,
  TelegramDeliveryOutbox,
  type TelegramDeliveryPayload,
} from "../src/telegram-delivery-outbox.js";
import {
  SqliteTelegramJobStore,
  type DeliveryPart,
  type ProjectedDeliveryTransitionInput,
  type ReplanRichDeliveryInput,
} from "../src/telegram-job-store.js";
import { TelegramReliabilityFixture } from "./telegram-reliability-fixtures.js";

describe("TelegramDeliveryOutbox rich fallback and recovery", () => {
  let fixture: TelegramReliabilityFixture;

  beforeEach(() => { fixture = new TelegramReliabilityFixture(); });
  afterEach(() => { vi.useRealTimers(); fixture.close(); });

  function installEdit(id: string, worker = fixture.outbox()): TelegramDeliveryOutbox {
    const job = fixture.delivering(id);
    worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
    return worker;
  }

  function installSend(id: string, worker = fixture.outbox()): TelegramDeliveryOutbox {
    const job = fixture.delivering(id);
    worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: null });
    return worker;
  }

  function richRow(jobId: string): DeliveryPart {
    const row = fixture.store.listDeliveries(jobId).find((part) => {
      const operation = (part.payload as { operation?: unknown }).operation;
      return operation === "edit_rich" || operation === "send_rich";
    });
    if (!row) throw new Error("Missing rich delivery row");
    return row;
  }

  function interceptedStore(
    replace: (input: ReplanRichDeliveryInput) => ReturnType<SqliteTelegramJobStore["replaceRejectedRichDelivery"]>,
  ): SqliteTelegramJobStore {
    return new Proxy(fixture.store, {
      get(target, property) {
        if (property === "replaceRejectedRichDelivery") return replace;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("replans one format-rejected rich edit and sends only its legacy fallback", async () => {
    const worker = installEdit("format-rejected");
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: 501 };
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich", "edit_text"]);
    expect(fixture.store.listDeliveries("format-rejected")).toEqual([
      expect.objectContaining({
        partKey: "status-anchor", state: "delivered", attemptCount: 1,
        payload: expect.objectContaining({ operation: "edit_text" }),
      }),
    ]);
    expect(fixture.store.get("format-rejected")).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("replans one format-rejected rich send without retrying the rich representation", async () => {
    const worker = installSend("format-rejected-send");
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "send_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: payload.operation === "send_text" && payload.text === "Response follows." ? 800 : 801 };
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual([
      "send_text", "send_rich", "send_text",
    ]);
    expect(fixture.store.listDeliveries("format-rejected-send")
      .some((part) => (part.payload as { operation?: unknown }).operation === "send_rich")).toBe(false);
    expect(fixture.store.get("format-rejected-send")).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("opens a per-instance rich circuit after method-unavailable and preflights later pending rich rows", async () => {
    const worker = fixture.outbox();
    installEdit("circuit-a", worker);
    installEdit("circuit-b", worker);
    installSend("circuit-c", worker);
    let richCalls = 0;
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        richCalls += 1;
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
      }
      return { messageId: 501 };
    };

    await worker.pump();

    expect(richCalls).toBe(1);
    expect(fixture.telegram.calls.filter(({ payload }) => payload.operation === "edit_rich"
      || payload.operation === "send_rich")).toHaveLength(1);
    expect(fixture.store.get("circuit-a")).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(fixture.store.get("circuit-b")).toMatchObject({ phase: "terminal", outcome: "completed" });
    expect(fixture.store.get("circuit-c")).toMatchObject({ phase: "terminal", outcome: "completed" });

    const fresh = fixture.outbox();
    installEdit("circuit-d", fresh);
    fixture.telegram.behavior = async () => ({ messageId: 501 });
    await fresh.pump();
    expect(fixture.telegram.calls.at(-1)?.payload.operation).toBe("edit_rich");
  });

  it("does not steal a live sending lease when circuit preflight started from stale pending evidence", async () => {
    let staleDue: DeliveryPart | undefined;
    const circuitStore = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "listDueDeliveries") {
          return (...args: Parameters<SqliteTelegramJobStore["listDueDeliveries"]>) => {
            if (staleDue) { const row = staleDue; staleDue = undefined; return [row]; }
            return target.listDueDeliveries(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const circuitWorker = installEdit("lease-circuit", fixture.outbox({ store: circuitStore }));
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
      }
      return { messageId: 501 };
    };
    await circuitWorker.pump();
    fixture.telegram.calls.length = 0;

    const liveWorker = installSend("lease-target");
    const pending = richRow("lease-target");
    fixture.store.transitionDelivery({
      jobId: pending.jobId, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 800, updatedAt: fixture.now,
    });
    staleDue = richRow("lease-target");
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation !== "send_rich") throw new Error("Unexpected delivery");
      started();
      await blocked;
      return { messageId: 801 };
    };

    const livePump = liveWorker.pump();
    await entered;
    const leasedJob = fixture.store.get(pending.jobId)!;
    const leasedRow = richRow(pending.jobId);
    await circuitWorker.pump();
    const afterRaceRow = richRow(pending.jobId);
    const afterRaceJob = fixture.store.get(pending.jobId);
    const retry = circuitWorker.retryFailed(pending.jobId, pending.partKey).catch((error: unknown) => error);
    release();
    await livePump;

    expect(afterRaceRow).toEqual(leasedRow);
    expect(afterRaceJob).toEqual(leasedJob);
    await expect(retry).resolves.toMatchObject({ message: "Delivery is not failed" });
    expect(fixture.telegram.calls).toHaveLength(1);
    expect(richRow(pending.jobId)).toMatchObject({ state: "delivered", attemptCount: 1 });
  });

  it("replans an explicit failed-rich retry while this outbox rich circuit is open", async () => {
    const worker = fixture.outbox();
    installEdit("retry-circuit-target", worker);
    const failed = richRow("retry-circuit-target");
    let job = fixture.store.get(failed.jobId)!;
    let moved = fixture.store.transitionDeliveryAndProject({
      jobId: failed.jobId, partKey: failed.partKey, expectedJobVersion: job.version,
      expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
      eventId: "retry-circuit-target:sending", updatedAt: fixture.now,
    });
    job = moved.job;
    moved = fixture.store.transitionDeliveryAndProject({
      jobId: failed.jobId, partKey: failed.partKey, expectedJobVersion: job.version,
      expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
      lastErrorCode: "telegram_permanent",
      attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
      eventId: "retry-circuit-target:failed", updatedAt: fixture.now,
    });
    installEdit("retry-circuit-opener", worker);
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
      }
      return { messageId: 501 };
    };
    await worker.pump();
    fixture.telegram.calls.length = 0;
    fixture.telegram.behavior = async () => ({ messageId: 501 });

    await worker.retryFailed(moved.delivery.jobId, moved.delivery.partKey);

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_text"]);
    expect(fixture.store.get(moved.delivery.jobId)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("restores fallback-failure attention when an explicit circuit retry cannot replan", async () => {
    const store = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "replaceRejectedRichDelivery") {
          return (input: ReplanRichDeliveryInput) => {
            if (input.jobId === "retry-circuit-failure") throw new Error("injected replan failure");
            return target.replaceRejectedRichDelivery(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = fixture.outbox({ store });
    installEdit("retry-circuit-failure", worker);
    const target = richRow("retry-circuit-failure");
    let job = fixture.store.get(target.jobId)!;
    let moved = fixture.store.transitionDeliveryAndProject({
      jobId: target.jobId, partKey: target.partKey, expectedJobVersion: job.version,
      expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
      eventId: "retry-circuit-failure:sending", updatedAt: fixture.now,
    });
    job = moved.job;
    moved = fixture.store.transitionDeliveryAndProject({
      jobId: target.jobId, partKey: target.partKey, expectedJobVersion: job.version,
      expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
      lastErrorCode: "telegram_permanent",
      attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
      eventId: "retry-circuit-failure:failed", updatedAt: fixture.now,
    });
    installEdit("retry-circuit-failure-opener", worker);
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
      }
      return { messageId: 501 };
    };
    await worker.pump();
    fixture.telegram.calls.length = 0;

    await worker.retryFailed(moved.delivery.jobId, moved.delivery.partKey);

    expect(fixture.telegram.calls).toEqual([]);
    expect(richRow(target.jobId)).toMatchObject({
      state: "failed", attemptCount: 1, lastErrorCode: "telegram_rich_fallback_failed",
    });
    expect(fixture.store.get(target.jobId)?.attention).toEqual({
      kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"],
    });
  });

  it("keeps an ambiguous send_rich uncertain without installing fallback", async () => {
    vi.useFakeTimers();
    const worker = installSend("rich-send-timeout", fixture.outbox({ timeoutMs: 10 }));
    fixture.telegram.behavior = (payload) => payload.operation === "send_rich"
      ? new Promise(() => {})
      : Promise.resolve({ messageId: 800 });

    const pumping = worker.pump();
    await vi.advanceTimersByTimeAsync(11);
    await pumping;

    const row = richRow("rich-send-timeout");
    expect(row).toMatchObject({ state: "uncertain", attemptCount: 1, lastErrorCode: "telegram_send_uncertain" });
    expect(fixture.store.listDeliveries("rich-send-timeout").some((part) => part.partKey.includes(":fallback:"))).toBe(false);
  });

  it("safely retries an ambiguous edit_rich until it succeeds", async () => {
    vi.useFakeTimers();
    const worker = installEdit("rich-edit-timeout", fixture.outbox({ timeoutMs: 10 }));
    fixture.telegram.behavior = () => new Promise(() => {});

    const pumping = worker.pump();
    await vi.advanceTimersByTimeAsync(11);
    await pumping;
    expect(richRow("rich-edit-timeout")).toMatchObject({
      state: "pending", attemptCount: 1, nextAttemptAt: fixture.now + 1_000,
    });

    fixture.telegram.behavior = async () => ({ messageId: 501 });
    fixture.now += 1_000;
    await worker.pump();
    expect(fixture.telegram.calls).toHaveLength(2);
    expect(fixture.store.get("rich-edit-timeout")).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("fails an ambiguous edit_rich at its configured attempt limit", async () => {
    vi.useFakeTimers();
    const worker = installEdit("rich-edit-limit", fixture.outbox({ timeoutMs: 10, attemptLimit: 1 }));
    fixture.telegram.behavior = () => new Promise(() => {});

    const pumping = worker.pump();
    await vi.advanceTimersByTimeAsync(11);
    await pumping;

    expect(richRow("rich-edit-limit")).toMatchObject({
      state: "failed", attemptCount: 1, lastErrorCode: "telegram_edit_failed",
    });
  });

  it("recovers sending send_rich as uncertain but sending edit_rich as a safe retry", async () => {
    const worker = fixture.outbox();
    installSend("restart-rich-send", worker);
    const send = richRow("restart-rich-send");
    fixture.store.transitionDelivery({
      jobId: send.jobId, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 800, updatedAt: fixture.now,
    });
    fixture.store.transitionDelivery({
      jobId: send.jobId, partKey: send.partKey, state: "sending", attemptCount: 0,
      nextAttemptAt: fixture.now, updatedAt: fixture.now,
    });
    installEdit("restart-rich-edit", worker);
    const edit = richRow("restart-rich-edit");
    fixture.store.transitionDelivery({
      jobId: edit.jobId, partKey: edit.partKey, state: "sending", attemptCount: 0,
      nextAttemptAt: fixture.now, telegramMessageId: 501, updatedAt: fixture.now,
    });

    await worker.pump();

    expect(richRow("restart-rich-send")).toMatchObject({ state: "uncertain", attemptCount: 1 });
    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich"]);
    expect(fixture.store.get("restart-rich-edit")).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("keeps restart ambiguity for a sending send_rich even when its local media disappeared", async () => {
    const attachmentRoot = path.join(fixture.directory, "attachments");
    mkdirSync(attachmentRoot, { recursive: true });
    const job = fixture.delivering("restart-missing-rich-media", [
      { kind: "text", text: "chart" },
      { kind: "attachment", attachment: { kind: "image", path: "missing.png" } },
    ]);
    const worker = fixture.outbox({ attachmentRoot });
    worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
    const send = richRow(job.id);
    fixture.store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: fixture.now,
    });
    fixture.store.transitionDelivery({
      jobId: job.id, partKey: send.partKey, state: "sending", attemptCount: 0,
      nextAttemptAt: fixture.now, updatedAt: fixture.now,
    });

    await worker.pump();

    expect(fixture.telegram.calls).toEqual([]);
    expect(richRow(job.id)).toMatchObject({
      state: "uncertain", attemptCount: 1, lastErrorCode: "telegram_send_uncertain",
    });
  });

  it("does not let restart recovery downgrade fallback-failure attention to uncertain", async () => {
    const worker = installSend("restart-fallback-attention");
    const send = richRow("restart-fallback-attention");
    fixture.store.transitionDelivery({
      jobId: send.jobId, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 800, updatedAt: fixture.now,
    });
    let job = fixture.store.get(send.jobId)!;
    job = fixture.store.transitionDeliveryAndProject({
      jobId: send.jobId, partKey: send.partKey, expectedJobVersion: job.version,
      expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
      eventId: "restart-fallback-sending", updatedAt: fixture.now,
    }).job;
    fixture.store.transition({
      jobId: job.id, eventId: "restart-fallback-attention", expectedVersion: job.version,
      event: { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: fixture.now,
        deliveries: job.deliveries, attention: {
          kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"],
        } },
    });

    await worker.pump();

    expect(fixture.telegram.calls).toEqual([]);
    expect(richRow(send.jobId)).toMatchObject({
      state: "failed", lastErrorCode: "telegram_rich_fallback_failed",
    });
    expect(fixture.store.get(send.jobId)?.attention).toMatchObject({
      kind: "required", code: "telegram_rich_fallback_failed",
    });
  });

  it("fails with bounded attention and sends no fallback when the replan transaction fails", async () => {
    const store = interceptedStore(() => { throw new Error("injected replan failure"); });
    const worker = installEdit("replan-fault", fixture.outbox({ store }));
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich"]);
    expect(richRow("replan-fault")).toMatchObject({
      state: "failed", attemptCount: 1, lastErrorCode: "telegram_rich_fallback_failed",
    });
    expect(fixture.store.get("replan-fault")?.attention).toEqual({
      kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"],
    });
  });

  it("continues from an exact fallback installed by the worker that won the replan race", async () => {
    const store = interceptedStore((input) => {
      fixture.store.replaceRejectedRichDelivery(input);
      throw new Error("Telegram job version conflict");
    });
    const worker = installEdit("exact-race", fixture.outbox({ store }));
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: 501 };
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich", "edit_text"]);
    expect(fixture.store.get("exact-race")).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("rechecks exact fallback when it appears between catch reload and failure attention", async () => {
    let rejectedInput: ReplanRichDeliveryInput | undefined;
    let interposed = false;
    const store = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "replaceRejectedRichDelivery") {
          return (input: ReplanRichDeliveryInput) => {
            rejectedInput = input;
            throw new Error("Telegram delivery conflict");
          };
        }
        if (property === "transitionDeliveryAndProject") {
          return (input: ProjectedDeliveryTransitionInput) => {
            if (!interposed && input.state === "failed"
              && input.attention?.kind === "required"
              && input.attention.code === "telegram_rich_fallback_failed") {
              interposed = true;
              if (!rejectedInput) throw new Error("Missing rejected replan input");
              target.replaceRejectedRichDelivery(rejectedInput);
            }
            return target.transitionDeliveryAndProject(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = installEdit("exact-race-before-attention", fixture.outbox({ store }));
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: 501 };
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich", "edit_text"]);
    expect(fixture.store.get("exact-race-before-attention")).toMatchObject({
      phase: "terminal", outcome: "completed", attention: { kind: "none" },
    });
  });

  it("rechecks exact fallback after the final bounded attention conflict", async () => {
    let rejectedInput: ReplanRichDeliveryInput | undefined;
    let attentionAttempts = 0;
    const store = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "replaceRejectedRichDelivery") {
          return (input: ReplanRichDeliveryInput) => {
            rejectedInput = input;
            throw new Error("Telegram delivery conflict");
          };
        }
        if (property === "transitionDeliveryAndProject") {
          return (input: ProjectedDeliveryTransitionInput) => {
            if (input.state === "failed"
              && input.attention?.kind === "required"
              && input.attention.code === "telegram_rich_fallback_failed") {
              attentionAttempts += 1;
              if (attentionAttempts < 8) throw new Error("Telegram job version conflict");
              if (!rejectedInput) throw new Error("Missing rejected replan input");
              target.replaceRejectedRichDelivery(rejectedInput);
            }
            return target.transitionDeliveryAndProject(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = installEdit("exact-race-final-conflict", fixture.outbox({ store }));
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: 501 };
    };

    await worker.pump();

    expect(attentionAttempts).toBe(8);
    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich", "edit_text"]);
    expect(fixture.store.get("exact-race-final-conflict")).toMatchObject({
      phase: "terminal", outcome: "completed", attention: { kind: "none" },
    });
  });

  it("recognizes an exact edit fallback committed before the rejected call returns", async () => {
    const worker = installEdit("exact-race-before-error");
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        const row = richRow("exact-race-before-error");
        const job = fixture.store.get(row.jobId)!;
        fixture.store.replaceRejectedRichDelivery({
          jobId: row.jobId, partKey: row.partKey, expectedJobVersion: job.version,
          expectedState: "sending", expectedAttemptCount: row.attemptCount,
          expectedContentHash: row.contentHash, eventId: "winner-before-error",
          eventAt: fixture.now, reasonCode: "rich_format_rejected",
        });
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: 501 };
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich", "edit_text"]);
    expect(fixture.store.get("exact-race-before-error")).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("recognizes an exact send fallback committed before the rejected call returns", async () => {
    const worker = installSend("exact-send-race-before-error");
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "send_rich") {
        const row = richRow("exact-send-race-before-error");
        const job = fixture.store.get(row.jobId)!;
        fixture.store.replaceRejectedRichDelivery({
          jobId: row.jobId, partKey: row.partKey, expectedJobVersion: job.version,
          expectedState: "sending", expectedAttemptCount: row.attemptCount,
          expectedContentHash: row.contentHash, eventId: "send-winner-before-error",
          eventAt: fixture.now, reasonCode: "rich_format_rejected",
        });
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: payload.operation === "send_text" && payload.text === "Response follows." ? 800 : 801 };
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual([
      "send_text", "send_rich", "send_text",
    ]);
    expect(fixture.store.get("exact-send-race-before-error")).toMatchObject({
      phase: "terminal", outcome: "completed",
    });
  });

  it("fails closed when a replan conflict did not install the exact fallback", async () => {
    const store = interceptedStore(() => { throw new Error("Telegram delivery conflict"); });
    const worker = installEdit("mismatched-race", fixture.outbox({ store }));
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich"]);
    expect(richRow("mismatched-race")).toMatchObject({ state: "failed", lastErrorCode: "telegram_rich_fallback_failed" });
    expect(fixture.store.get("mismatched-race")?.attention).toMatchObject({
      kind: "required", code: "telegram_rich_fallback_failed",
    });
  });

  it("does not mutate fallback state after another worker changes its initiating sending evidence", async () => {
    let injected = false;
    const store = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "replaceRejectedRichDelivery") {
          return () => { throw new Error("injected replan failure"); };
        }
        if (property === "transitionDeliveryAndProject") {
          return (input: ProjectedDeliveryTransitionInput) => {
            if (!injected && input.state === "failed") {
              injected = true;
              const job = target.get(input.jobId)!;
              const row = target.listDeliveries(input.jobId).find((part) => part.partKey === input.partKey)!;
              target.transitionDeliveryAndProject({
                jobId: row.jobId, partKey: row.partKey, expectedJobVersion: job.version,
                expectedState: "sending", expectedAttemptCount: row.attemptCount,
                state: "pending", attemptCount: row.attemptCount,
                eventId: "racing-worker-pending", updatedAt: fixture.now,
              });
            }
            return target.transitionDeliveryAndProject(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = installEdit("fallback-failure-race", fixture.outbox({ store }));
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich"]);
    expect(richRow("fallback-failure-race")).toMatchObject({
      state: "pending", attemptCount: 0, lastErrorCode: null,
    });
    expect(fixture.store.get("fallback-failure-race")?.attention).toEqual({ kind: "none" });
  });

  it("does not mutate fallback state after its initiating content hash changes", async () => {
    let injected = false;
    const store = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "replaceRejectedRichDelivery") {
          return () => { throw new Error("injected replan failure"); };
        }
        if (property === "transitionDeliveryAndProject") {
          return (input: ProjectedDeliveryTransitionInput) => {
            if (!injected && input.state === "failed") {
              injected = true;
              const database = new Database(fixture.databasePath);
              try {
                database.prepare("UPDATE deliveries SET content_hash = ? WHERE job_id = ? AND part_key = ?")
                  .run("0".repeat(64), input.jobId, input.partKey);
              } finally { database.close(); }
            }
            return target.transitionDeliveryAndProject(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = installEdit("fallback-hash-race", fixture.outbox({ store }));
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich"]);
    expect(richRow("fallback-hash-race")).toMatchObject({
      state: "sending", attemptCount: 0, contentHash: "0".repeat(64), lastErrorCode: null,
    });
    expect(fixture.store.get("fallback-hash-race")?.attention).toEqual({ kind: "none" });
  });

  it("schedules a bounded wakeup after eight fallback-failure CAS conflicts", async () => {
    let failures = 0;
    const wakeups: number[] = [];
    const store = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "replaceRejectedRichDelivery") {
          return () => { throw new Error("injected replan failure"); };
        }
        if (property === "transitionDeliveryAndProject") {
          return (input: ProjectedDeliveryTransitionInput) => {
            if (input.state === "failed") {
              failures += 1;
              throw new Error("Telegram delivery conflict");
            }
            return target.transitionDeliveryAndProject(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = installEdit("fallback-cas-exhausted", fixture.outbox({
      store, scheduleWakeup: (at) => wakeups.push(at),
    }));
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
    };

    await worker.pump();

    expect(failures).toBe(8);
    expect(wakeups).toContain(fixture.now + 1_000);
    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual(["edit_rich"]);
    expect(richRow("fallback-cas-exhausted")).toMatchObject({ state: "sending", attemptCount: 0 });
  });

  it("fails the exact rich row without overwriting unrelated required attention", async () => {
    const store = interceptedStore(() => { throw new Error("injected replan failure"); });
    const worker = installEdit("fallback-unrelated-attention", fixture.outbox({ store }));
    const job = fixture.store.get("fallback-unrelated-attention")!;
    fixture.store.transition({
      jobId: job.id, eventId: "fallback-unrelated-attention:event", expectedVersion: job.version,
      event: { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: fixture.now,
        deliveries: job.deliveries,
        attention: { kind: "required", code: "manual_hold", actions: ["inspect"] } },
    });
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
    };

    await worker.pump();

    expect(richRow("fallback-unrelated-attention")).toMatchObject({ state: "failed", attemptCount: 1 });
    expect(fixture.store.get("fallback-unrelated-attention")?.attention).toEqual({
      kind: "required", code: "manual_hold", actions: ["inspect"],
    });
  });

  it("treats message-not-modified as success only for known rich edits", async () => {
    const worker = fixture.outbox();
    installEdit("noop-rich-edit", worker);
    installSend("noop-rich-send", worker);
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich" || payload.operation === "send_rich") {
        throw new TelegramDeliveryApiError("message_not_modified");
      }
      return { messageId: 800 };
    };

    await worker.pump();

    expect(fixture.store.listDeliveries("noop-rich-edit")[0]).toMatchObject({
      state: "delivered", telegramMessageId: 501,
    });
    expect(richRow("noop-rich-send")).toMatchObject({ state: "uncertain" });
  });

  it("refuses duplicate-send approval for an uncertain edit_rich", async () => {
    const worker = installEdit("warned-rich-edit");
    const row = richRow("warned-rich-edit");
    fixture.store.transitionDelivery({
      jobId: row.jobId, partKey: row.partKey, state: "uncertain", attemptCount: 1,
      telegramMessageId: 501, updatedAt: fixture.now,
    });

    await expect(worker.sendAgainWithWarning(row.jobId, row.partKey))
      .rejects.toThrow("Known edits do not need duplicate-send approval");
    expect(fixture.telegram.calls).toEqual([]);
  });

  it("refuses duplicate-send approval while rich fallback failure attention is active", async () => {
    const worker = installSend("warned-fallback-failure");
    const send = richRow("warned-fallback-failure");
    fixture.store.transitionDelivery({
      jobId: send.jobId, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 800, updatedAt: fixture.now,
    });
    let job = fixture.store.get(send.jobId)!;
    let transition = fixture.store.transitionDeliveryAndProject({
      jobId: send.jobId, partKey: send.partKey, expectedJobVersion: job.version,
      expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
      eventId: "warned-fallback-sending", updatedAt: fixture.now,
    });
    job = transition.job;
    transition = fixture.store.transitionDeliveryAndProject({
      jobId: send.jobId, partKey: send.partKey, expectedJobVersion: job.version,
      expectedState: "sending", expectedAttemptCount: 0, state: "uncertain", attemptCount: 1,
      nextAttemptAt: null, lastErrorCode: "telegram_send_uncertain",
      attention: { kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"] },
      eventId: "warned-fallback-uncertain", updatedAt: fixture.now,
    });

    await expect(worker.sendAgainWithWarning(send.jobId, send.partKey))
      .rejects.toThrow("Rich fallback failure requires inspection");
    expect(fixture.telegram.calls).toEqual([]);
    expect(transition.delivery.state).toBe("uncertain");
  });

});
