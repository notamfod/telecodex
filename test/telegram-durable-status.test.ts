import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import {
  TelegramDurableStatusService,
  type TelegramDurableStatusOptions,
} from "../src/telegram-durable-status.js";
import {
  TelegramBackgroundWriteGate,
} from "../src/telegram-background-write-gate.js";
import {
  classifyTelegramStatusError,
  createTelegramStatusTransport,
} from "../src/telegram-grammy-transport.js";
import { TelegramJobIngress, type TelegramWorkSource } from "../src/telegram-job-ingress.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { GuardianThreadInspection } from "../src/session-guardian-ipc-client.js";

const START = 1_700_000_400_000;
const THREAD = "11111111-1111-4111-8111-111111111111";

describe("TelegramDurableStatusService", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let now: number;
  let nextId: number;
  let services: TelegramDurableStatusService[];
  let send: ReturnType<typeof vi.fn>;
  let edit: ReturnType<typeof vi.fn>;
  let inspectThread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-durable-status-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    now = START;
    nextId = 0;
    services = [];
    send = vi.fn(async () => 501);
    edit = vi.fn(async () => undefined);
    inspectThread = vi.fn(async (threadId: string) => inspection(threadId));
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.dispose()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("projects the latest durable state and sends to the exact persisted topic destination", async () => {
    const first = await accept(1);
    const second = await accept(2);
    queue(first.id);
    queue(second.id);
    const bulkQueueRead = vi.spyOn(store, "listDispatchable").mockImplementation(() => {
      throw new Error("unbounded queue materialization");
    });
    const service = status();

    await service.refresh(second.id);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1_000_000_001,
      messageThreadId: 7,
      priority: "urgent",
      projection: expect.objectContaining({
        jobId: second.id,
        expectedVersion: store.get(second.id)!.version,
        queue: { position: 2, ageMs: 0 },
        timestamps: expect.objectContaining({ lastEventAt: now, latestDeliveryAt: now }),
      }),
    }));
    expect(store.listDeliveries(second.id)).toEqual([
      expect.objectContaining({
        partKey: "status-anchor", state: "delivered", telegramMessageId: 501,
        attemptCount: 1, nextAttemptAt: null,
        payload: expect.objectContaining({ operation: "send_text", chatId: -1_000_000_001,
          messageThreadId: 7 }),
      }),
    ]);
    expect(bulkQueueRead).not.toHaveBeenCalled();
  });

  it("sends the durable status anchor to a persisted target topic", async () => {
    const accepted = await accept(101, { chatId: -1_000_000_001, messageThreadId: 91 });
    const service = status();

    await service.refresh(accepted.id);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1_000_000_001,
      messageThreadId: 91,
    }));
  });

  it("exposes the same canonical projection reader used by Telegram status", async () => {
    const accepted = await accept(32);
    queue(accepted.id);
    const service = status();

    const projection = await service.readProjection(accepted.id);
    await service.refresh(accepted.id);

    expect(send.mock.calls[0]![0].projection).toEqual(projection);
  });

  it("uses read-only Guardian evidence and exposes bounded unavailability", async () => {
    const accepted = await accept(3);
    running(accepted.id);
    inspectThread.mockRejectedValueOnce(new Error("private guardian detail"));
    const service = status();

    await service.refresh(accepted.id);

    expect(inspectThread).toHaveBeenCalledWith(THREAD);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      projection: expect.objectContaining({
        guardian: expect.objectContaining({
          availability: "unavailable", reasonCode: "GUARDIAN_UNAVAILABLE",
        }),
      }),
    }));
    expect(JSON.stringify(send.mock.calls)).not.toContain("private guardian detail");
  });

  it("projects terminal durable state without inspecting its retained thread", async () => {
    const accepted = await accept(34);
    running(accepted.id);
    terminalFailure(accepted.id);
    inspectThread.mockRejectedValueOnce(new Error("Guardian must not affect terminal state"));
    const service = status();

    const projection = await service.readProjection(accepted.id);

    expect(inspectThread).not.toHaveBeenCalled();
    expect(projection).toMatchObject({
      threadId: THREAD,
      phase: "terminal",
      outcome: "failed",
      state: "terminal_failed",
      guardian: {
        availability: "available",
        health: null,
        reasonCode: null,
        threadStatus: null,
      },
      attention: { kind: "required", code: "test_failure", actions: ["details"] },
      reasonCodes: ["test_failure"],
      actions: [{ kind: "details", jobId: accepted.id }],
    });
  });

  it("bounds a hung Guardian inspection before the five-second refresh deadline", async () => {
    vi.useFakeTimers();
    const accepted = await accept(31);
    running(accepted.id);
    inspectThread.mockImplementation(() => new Promise(() => {}));
    const service = status();

    const refreshing = service.refresh(accepted.id);
    await vi.advanceTimersByTimeAsync(4_000);
    await refreshing;

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      projection: expect.objectContaining({ guardian: expect.objectContaining({ availability: "unavailable" }) }),
    }));
  });

  it("schedules a stale projection for the next service cadence without recursive inspection", async () => {
    vi.useFakeTimers();
    const accepted = await accept(33);
    running(accepted.id);
    let release!: () => void;
    const firstInspection = new Promise<GuardianThreadInspection>((resolve) => {
      release = () => resolve(inspection(THREAD));
    });
    inspectThread.mockReturnValueOnce(firstInspection);
    const service = status();

    const refreshing = service.refresh(accepted.id);
    await vi.waitFor(() => expect(inspectThread).toHaveBeenCalledOnce());
    now += 1;
    const current = store.get(accepted.id)!;
    const latest = store.transition({
      jobId: current.id,
      eventId: `activity-${current.id}`,
      expectedVersion: current.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: now, activity: "tool" },
    });
    release();

    await expect(refreshing).resolves.toBeUndefined();
    expect(inspectThread).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inspectThread).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      projection: expect.objectContaining({ expectedVersion: latest.version }),
    }));
  });

  it("never repeats an acceptance-unknown initial send, including after service recreation", async () => {
    vi.useFakeTimers();
    const accepted = await accept(4);
    const timeout = new Error("send timeout");
    send.mockRejectedValue(timeout);
    const first = status({
      classifyTransportError: () => ({ disposition: "acceptance_unknown" }),
    });

    await expect(first.refresh(accepted.id)).rejects.toBe(timeout);
    expect(first.activePresenterCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "uncertain", telegramMessageId: null, attemptCount: 1,
      lastErrorCode: "telegram_status_send_uncertain",
    });
    await first.refresh(accepted.id);
    await first.dispose();
    now += 10_000;
    const recreated = status({
      classifyTransportError: () => ({ disposition: "acceptance_unknown" }),
    });
    await expect(recreated.refresh(accepted.id, "urgent")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(recreated.activePresenterCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps a recreated permanent-failed anchor quiescent without a presenter or timer", async () => {
    vi.useFakeTimers();
    const accepted = await accept(41);
    const permanent = new Error("chat not found");
    send.mockRejectedValue(permanent);
    const first = status({
      classifyTransportError: () => ({ disposition: "permanent" }),
    });
    await expect(first.refresh(accepted.id)).rejects.toBe(permanent);
    await first.dispose();

    const recreated = status({
      classifyTransportError: () => ({ disposition: "permanent" }),
    });
    await expect(recreated.refresh(accepted.id, "urgent")).resolves.toBeUndefined();

    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "failed", telegramMessageId: null, attemptCount: 1,
      lastErrorCode: "telegram_status_send_failed",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(recreated.activePresenterCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledOnce();
  });

  it("clears stale blocked suppression after a durable anchor repair", async () => {
    vi.useFakeTimers();
    const accepted = await accept(42);
    const permanent = new Error("chat not found");
    send.mockRejectedValueOnce(permanent);
    const service = status({
      classifyTransportError: () => ({ disposition: "permanent" }),
    });
    await expect(service.refresh(accepted.id)).rejects.toBe(permanent);
    const failed = store.listDeliveries(accepted.id)[0]!;
    store.transitionDelivery({
      jobId: accepted.id,
      partKey: failed.partKey,
      state: "pending",
      attemptCount: failed.attemptCount,
      telegramMessageId: failed.telegramMessageId,
      nextAttemptAt: now,
      updatedAt: now,
    });

    await service.refresh(accepted.id, "urgent");

    expect(send).toHaveBeenCalledTimes(2);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 501, attemptCount: 2,
    });
    expect(service.activePresenterCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps a recreated retryable pending anchor on its persisted retry schedule", async () => {
    vi.useFakeTimers();
    const accepted = await accept(43);
    const retryable = new Error("temporary send failure");
    send.mockRejectedValueOnce(retryable);
    const first = status({
      classifyTransportError: () => ({ disposition: "retryable" }),
    });
    await expect(first.refresh(accepted.id)).rejects.toBe(retryable);
    await first.dispose();

    const recreated = status({
      classifyTransportError: () => ({ disposition: "retryable" }),
    });
    await recreated.refresh(accepted.id, "urgent");

    expect(send).toHaveBeenCalledOnce();
    expect(recreated.activePresenterCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    now += 4_999;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(send).toHaveBeenCalledOnce();
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 501, attemptCount: 2,
    });
  });

  it("keeps a queued initial send pending when the background gate is disposed before admission", async () => {
    const accepted = await accept(113);
    const gate = new TelegramBackgroundWriteGate({
      maxPerWindow: 1,
      windowMs: 60_000,
      burst: 1,
    });
    let releaseOccupant: (() => void) | undefined;
    const occupant = gate.run(-1_000_000_001, "ordinary", () =>
      new Promise<void>((resolve) => {
        releaseOccupant = resolve;
      }),
    );
    const sendMessage = vi.fn(async () => ({ message_id: 991 }));
    const runSpy = vi.spyOn(gate, "run");
    const service = status({
      transport: createTelegramStatusTransport({
        sendMessage,
        editMessageText: vi.fn(),
      } as never, 25, gate),
      classifyTransportError: classifyTelegramStatusError,
    });

    try {
      const refresh = service.refresh(accepted.id).catch((error: unknown) => error);
      await vi.waitFor(() => expect(runSpy).toHaveBeenCalledOnce());

      expect(sendMessage).not.toHaveBeenCalled();
      gate.dispose();
      const error = await refresh;

      expect(error).toMatchObject({ message: "Telegram background write gate disposed" });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
        state: "pending",
        attemptCount: 1,
        nextAttemptAt: START + 5_000,
        lastErrorCode: "telegram_status_send_retry",
      });
    } finally {
      releaseOccupant?.();
      await occupant;
    }
  });

  it("begins job disposal by cancelling its queued status admission synchronously", async () => {
    const accepted = await accept(114);
    const gate = new TelegramBackgroundWriteGate({
      maxPerWindow: 1,
      windowMs: 60_000,
      burst: 1,
    });
    let releaseOccupant!: () => void;
    const occupant = gate.run(-1_000_000_001, "ordinary", () =>
      new Promise<void>((resolve) => { releaseOccupant = resolve; }));
    const sendMessage = vi.fn(async () => ({ message_id: 992 }));
    const runSpy = vi.spyOn(gate, "run");
    const service = status({
      transport: createTelegramStatusTransport({
        sendMessage,
        editMessageText: vi.fn(),
      } as never, 25, gate),
      classifyTransportError: classifyTelegramStatusError,
    });
    const refresh = service.refresh(accepted.id).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledOnce());
    expect(sendMessage).not.toHaveBeenCalled();

    const disposing = service.disposeJob(accepted.id);

    expect(service.activePresenterCount).toBe(0);
    await expect(refresh).resolves.toBeUndefined();
    await expect(disposing).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "pending",
      attemptCount: 1,
      nextAttemptAt: START + 5_000,
      lastErrorCode: "telegram_status_send_retry",
    });

    releaseOccupant();
    await occupant;
    gate.dispose();
  });

  it("safely retries a known edit with exact CAS attempt and lease state", async () => {
    const accepted = await accept(5);
    const retryable = new Error("edit timeout");
    edit.mockRejectedValueOnce(retryable).mockResolvedValueOnce(undefined);
    const service = status({ classifyTransportError: (_operation, error) =>
      ({ disposition: error === retryable ? "retryable" : "permanent" }) });

    await service.refresh(accepted.id);
    checking(accepted.id);
    await expect(service.refresh(accepted.id, "urgent")).rejects.toBe(retryable);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "pending", telegramMessageId: 501, attemptCount: 2,
      nextAttemptAt: START + 10_000, lastErrorCode: "telegram_status_edit_retry",
    });
    now += 10_000;
    await service.refresh(accepted.id);

    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1]![0]).toMatchObject({ chatId: -1_000_000_001, messageId: 501 });
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 501, attemptCount: 3, nextAttemptAt: null,
    });
  });

  it("replaces a deleted live anchor once and edits the replacement on the next refresh", async () => {
    const accepted = await accept(115, { chatId: -1_000_000_001, messageThreadId: 91 });
    send.mockResolvedValueOnce(501).mockResolvedValueOnce(777);
    const missing = new Error("Bad Request: message to edit not found");
    const replacement = vi.spyOn(store, "replaceMissingStatusAnchorEdit");
    let leasedEdit: ReturnType<typeof store.listDeliveries>[number] | undefined;
    edit.mockImplementationOnce(async () => {
      leasedEdit = store.listDeliveries(accepted.id)[0];
      throw missing;
    });
    const service = status({
      classifyTransportError: (operation, error) => operation === "edit" && error === missing
        ? { disposition: "message_missing" }
        : { disposition: "permanent" },
    });
    await service.refresh(accepted.id);
    running(accepted.id);

    await expect(service.refresh(accepted.id, "urgent")).resolves.toBeUndefined();

    expect(leasedEdit).toMatchObject({
      state: "sending", telegramMessageId: 501, attemptCount: 1,
    });
    expect(replacement).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledWith({
      jobId: accepted.id,
      expectedAttemptCount: leasedEdit!.attemptCount,
      expectedContentHash: leasedEdit!.contentHash,
      expectedLeaseUntil: leasedEdit!.nextAttemptAt,
      expectedMessageId: 501,
      replacementPayload: {
        operation: "send_text", chatId: -1_000_000_001,
        messageThreadId: 91, text: expect.any(String),
      },
      updatedAt: now,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const replacementMessage = send.mock.calls[1]![0];
    expect(replacementMessage).toMatchObject({
      chatId: -1_000_000_001, messageThreadId: 91,
      actions: replacementMessage.projection.actions,
    });
    expect(replacementMessage.actions.length).toBeGreaterThan(0);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 777, attemptCount: 3,
      payload: {
        operation: "send_text", chatId: -1_000_000_001,
        messageThreadId: 91, text: replacementMessage.html,
      },
    });

    checking(accepted.id);
    now += 10_000;
    await service.refresh(accepted.id, "urgent");

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(2);
    const refreshedMessage = edit.mock.calls[1]![0];
    expect(refreshedMessage).toMatchObject({
      chatId: -1_000_000_001, messageThreadId: 91, messageId: 777, priority: "urgent",
      actions: refreshedMessage.projection.actions,
    });
    expect(refreshedMessage.actions.length).toBeGreaterThan(0);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 777, attemptCount: 4,
    });
  });

  it.each(["acceptance_unknown", "retryable", "permanent"] as const)(
    "retires the presenter when persisting a %s replacement-send failure fails",
    async (disposition) => {
      vi.useFakeTimers();
      const accepted = await accept(disposition === "acceptance_unknown" ? 116
        : disposition === "retryable" ? 117 : 118);
      const missing = new Error("missing edit");
      const sendFailure = new Error(`replacement send ${disposition}`);
      const persistenceFailure = new Error(`persist ${disposition} failed`);
      let failFinish = false;
      const brokenStore = storeWith({
        finishStatusAnchorRevision: (input: Parameters<typeof store.finishStatusAnchorRevision>[0]) => {
          if (failFinish) throw persistenceFailure;
          return store.finishStatusAnchorRevision(input);
        },
      });
      send.mockResolvedValueOnce(501).mockRejectedValueOnce(sendFailure);
      edit.mockRejectedValueOnce(missing);
      const service = status({
        store: brokenStore,
        classifyTransportError: (operation, error) => {
          if (operation === "edit" && error === missing) return { disposition: "message_missing" };
          if (operation === "send" && error === sendFailure && disposition === "retryable") {
            return { disposition, retryAfterMs: 23_000 };
          }
          return { disposition };
        },
      });
      await service.refresh(accepted.id);
      running(accepted.id);
      failFinish = true;

      await expect(service.refresh(accepted.id, "urgent")).rejects.toBe(persistenceFailure);

      expect(service.activePresenterCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(send).toHaveBeenCalledTimes(2);
      expect(edit).toHaveBeenCalledOnce();
      expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
        state: "sending", telegramMessageId: null, attemptCount: 2,
      });

      await expect(service.refresh(accepted.id, "urgent")).resolves.toBeUndefined();
      now += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(send).toHaveBeenCalledTimes(2);
      expect(edit).toHaveBeenCalledOnce();
      expect(service.activePresenterCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("counts a retryable physical send while keeping it durably retryable", async () => {
    const accepted = await accept(51);
    const retryable = new Error("send rejected before acceptance");
    send.mockRejectedValueOnce(retryable);
    const service = status({ classifyTransportError: () => ({ disposition: "retryable" }) });

    await expect(service.refresh(accepted.id)).rejects.toBe(retryable);

    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "pending", telegramMessageId: null, attemptCount: 1,
      nextAttemptAt: START + 5_000, lastErrorCode: "telegram_status_send_retry",
    });
  });

  it("does not finish a known edit when its durable message target changes", async () => {
    const accepted = await accept(52);
    const retryable = new Error("edit timeout");
    const service = status({ classifyTransportError: () => ({ disposition: "retryable" }) });
    await service.refresh(accepted.id);
    edit.mockImplementationOnce(async () => {
      const row = store.listDeliveries(accepted.id)[0]!;
      store.transitionDelivery({
        jobId: accepted.id, partKey: row.partKey, state: "sending",
        attemptCount: row.attemptCount, telegramMessageId: 999,
        nextAttemptAt: row.nextAttemptAt, updatedAt: row.updatedAt,
      });
      throw retryable;
    });

    checking(accepted.id);
    await expect(service.refresh(accepted.id, "urgent")).rejects.toThrow("message target changed");

    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "sending", telegramMessageId: 999, attemptCount: 1,
    });
    await service.dispose();
    now += 5_000;
    const recreated = status({ classifyTransportError: () => ({ disposition: "retryable" }) });

    await recreated.refresh(accepted.id, "urgent");

    expect(send).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1]![0]).toMatchObject({ messageId: 999 });
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 999, attemptCount: 2,
    });
  });

  it("does not duplicate a send when delivered-finish storage fails", async () => {
    vi.useFakeTimers();
    const accepted = await accept(6);
    const finishFailure = new Error("sqlite unavailable");
    const brokenStore = storeWith({ finishStatusAnchorRevision: () => { throw finishFailure; } });
    const first = status({ store: brokenStore });

    await expect(first.refresh(accepted.id)).rejects.toBe(finishFailure);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "sending", telegramMessageId: null, attemptCount: 0,
    });
    await first.dispose();
    now += 10_000;
    const onBackgroundError = vi.fn();
    const recreated = status({ onBackgroundError });
    await expect(recreated.refresh(accepted.id, "urgent")).resolves.toBeUndefined();
    expect(recreated.activePresenterCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledOnce();
    expect(onBackgroundError).not.toHaveBeenCalled();

    const blocked = store.listDeliveries(accepted.id)[0]!;
    store.transitionDelivery({
      jobId: accepted.id,
      partKey: blocked.partKey,
      state: "pending",
      attemptCount: blocked.attemptCount,
      telegramMessageId: blocked.telegramMessageId,
      nextAttemptAt: now,
      updatedAt: now,
    });
    await recreated.refresh(accepted.id, "urgent");

    expect(send).toHaveBeenCalledTimes(2);
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 501, attemptCount: 1,
    });
    expect(recreated.activePresenterCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("refreshes active jobs at ten seconds and disposes owned timers", async () => {
    vi.useFakeTimers();
    const accepted = await accept(7);
    const service = status();

    await service.refresh(accepted.id, "urgent");
    expect(service.activePresenterCount).toBe(1);
    checking(accepted.id);
    const initialEvents = store.listEvents(accepted.id);
    now += 9_999;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(edit).not.toHaveBeenCalled();
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ priority: "urgent" });
    expect(edit.mock.calls[0]![0]).toMatchObject({ priority: "ordinary" });
    expect(store.listEvents(accepted.id)).toEqual(initialEvents);

    await service.dispose();
    const callsAfterDispose = send.mock.calls.length + edit.mock.calls.length;
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send.mock.calls.length + edit.mock.calls.length).toBe(callsAfterDispose);
    expect(service.activePresenterCount).toBe(0);
  });

  it("checks a running job on heartbeat without writing age-only status revisions", async () => {
    vi.useFakeTimers();
    const accepted = await accept(117);
    running(accepted.id);
    const service = status();
    await service.refresh(accepted.id);
    const inspectionsBefore = inspectThread.mock.calls.length;
    for (let tick = 0; tick < 3; tick++) {
      now += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(inspectThread).toHaveBeenCalledTimes(inspectionsBefore + 3);
    expect(send).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    checking(accepted.id);
    await service.refresh(accepted.id, "urgent");
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]![0]).toMatchObject({
      priority: "urgent", projection: { expectedVersion: store.get(accepted.id)!.version },
    });
  });

  it("reports a detached heartbeat failure once and retires its blocked presenter", async () => {
    vi.useFakeTimers();
    const accepted = await accept(70);
    const heartbeatError = new Error("automatic heartbeat edit failed");
    const reporterError = new Error("background reporter failed");
    const onBackgroundError = vi.fn(() => { throw reporterError; });
    const service = status({
      onBackgroundError,
      classifyTransportError: () => ({ disposition: "acceptance_unknown" }),
    });
    await service.refresh(accepted.id, "urgent");
    edit.mockRejectedValueOnce(heartbeatError);
    checking(accepted.id);

    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onBackgroundError).toHaveBeenCalledOnce();
    expect(onBackgroundError).toHaveBeenCalledWith(accepted.id, heartbeatError);
    expect(service.activePresenterCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(edit).toHaveBeenCalledOnce();
  });

  it("reports a synchronous detached scheduler failure exactly once", async () => {
    vi.useFakeTimers();
    const accepted = await accept(75);
    const scheduleError = new Error("status schedule read failed synchronously");
    const reporterError = new Error("background reporter failed");
    const onBackgroundError = vi.fn(() => { throw reporterError; });
    const service = status({ onBackgroundError });
    await service.refresh(accepted.id, "urgent");
    vi.spyOn(store, "listDeliveries").mockImplementationOnce(() => { throw scheduleError; });

    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onBackgroundError).toHaveBeenCalledOnce();
    expect(onBackgroundError).toHaveBeenCalledWith(accepted.id, scheduleError);
    expect(send).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces an in-flight projection to one latest trailing refresh", async () => {
    vi.useFakeTimers();
    const accepted = await accept(71);
    running(accepted.id);
    const onBackgroundError = vi.fn();
    const service = status({ onBackgroundError });
    await service.refresh(accepted.id);
    edit.mockClear();
    const inspectionsBefore = inspectThread.mock.calls.length;

    let release!: () => void;
    const deferred = new Promise<GuardianThreadInspection>((resolve) => {
      release = () => resolve(inspection(THREAD));
    });
    inspectThread.mockReturnValueOnce(deferred);
    const refreshing = service.refresh(accepted.id, "urgent");
    await vi.waitFor(() => expect(inspectThread).toHaveBeenCalledTimes(inspectionsBefore + 1));
    const requests = Array.from({ length: 100 }, () => service.refresh(accepted.id));
    expect(requests.every((request) => request === refreshing)).toBe(true);
    const current = store.get(accepted.id)!;
    const latest = store.transition({
      jobId: current.id,
      eventId: `latest-${current.id}`,
      expectedVersion: current.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: now, health: "checking" },
    });
    release();

    await refreshing;
    expect(inspectThread).toHaveBeenCalledTimes(inspectionsBefore + 1);
    expect(send).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    now += 9_999;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(inspectThread).toHaveBeenCalledTimes(inspectionsBefore + 1);
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(inspectThread).toHaveBeenCalledTimes(inspectionsBefore + 2);
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]![0]).toMatchObject({
      priority: "ordinary",
      projection: { expectedVersion: latest.version },
    });
    expect(onBackgroundError).not.toHaveBeenCalled();
  });

  it("reports one failed physical trailing refresh without reporting its collapsed request", async () => {
    const accepted = await accept(74);
    running(accepted.id);
    const trailingError = new Error("trailing status edit failed");
    const onBackgroundError = vi.fn();
    const service = status({
      onBackgroundError,
      classifyTransportError: () => ({ disposition: "retryable" }),
    });
    await service.refresh(accepted.id);
    let current = store.get(accepted.id)!;
    store.transition({
      jobId: current.id,
      eventId: `first-trailing-${current.id}`,
      expectedVersion: current.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: now, health: "checking" },
    });
    edit.mockImplementationOnce(async () => {
      current = store.get(accepted.id)!;
      store.transition({
        jobId: current.id,
        eventId: `second-trailing-${current.id}`,
        expectedVersion: current.version,
        event: { schemaVersion: 1, type: "activity.observed", eventAt: now, health: "healthy" },
      });
      now += 10_000;
    }).mockRejectedValueOnce(trailingError);

    const refreshing = service.refresh(accepted.id, "urgent");
    const collapsed = service.refresh(accepted.id);
    expect(collapsed).toBe(refreshing);
    await refreshing;
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledOnce());

    expect(onBackgroundError).toHaveBeenCalledWith(accepted.id, trailingError);
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("returns a future ordinary refresh immediately with exactly one owned timer", async () => {
    vi.useFakeTimers();
    const accepted = await accept(73);
    const service = status();
    await service.refresh(accepted.id);
    let resolved = false;
    checking(accepted.id);

    const future = service.refresh(accepted.id).then(() => { resolved = true; });
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(edit).not.toHaveBeenCalled();
    now += 9_999;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(edit).not.toHaveBeenCalled();
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    await future;
    expect(edit).toHaveBeenCalledOnce();
  });

  it("defers even urgent refreshes behind the durable retry anchor", async () => {
    vi.useFakeTimers();
    const accepted = await accept(72);
    const service = status();
    await service.refresh(accepted.id);
    const row = store.listDeliveries(accepted.id)[0]!;
    store.transitionDelivery({
      jobId: accepted.id,
      partKey: row.partKey,
      state: "pending",
      attemptCount: row.attemptCount,
      telegramMessageId: row.telegramMessageId,
      nextAttemptAt: now + 20_000,
      lastErrorCode: "telegram_status_edit_retry",
      updatedAt: now,
    });

    await expect(service.refresh(accepted.id, "urgent")).resolves.toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
    now += 19_999;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(edit).not.toHaveBeenCalled();
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]![0]).toMatchObject({ priority: "urgent" });
  });

  it("settles and removes a terminal job only after physical anchor completion", async () => {
    const accepted = await accept(8);
    const service = status();
    await service.refresh(accepted.id, "urgent");
    terminalFailure(accepted.id);

    await service.refresh(accepted.id, "urgent");

    expect(edit).toHaveBeenLastCalledWith(expect.objectContaining({
      priority: "urgent",
      projection: expect.objectContaining({ phase: "terminal" }),
    }));
    expect(store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered", telegramMessageId: 501,
    });
    expect(service.activePresenterCount).toBe(0);
  });

  it("disposes one job presenter without editing its final anchor or stopping other jobs", async () => {
    vi.useFakeTimers();
    const first = await accept(81);
    const second = await accept(82);
    const service = status();
    await service.refresh(first.id);
    await service.refresh(second.id);
    expect(service.activePresenterCount).toBe(2);
    edit.mockClear();

    await service.disposeJob(first.id);
    checking(second.id);

    expect(service.activePresenterCount).toBe(1);
    expect(edit).not.toHaveBeenCalled();
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]![0]).toMatchObject({
      projection: expect.objectContaining({ jobId: second.id }),
    });
  });

  async function accept(
    updateId: number,
    targetContext?: TelegramWorkSource["targetContext"],
  ) {
    const ingress = new TelegramJobIngress({
      store,
      materializationRoot: path.join(directory, "materialized"),
      now: () => now,
      createId: () => `generated-${++nextId}`,
      downloadAttachment: async () => new Uint8Array(),
    });
    const source: TelegramWorkSource = {
      botId: "bot", updateId, chatId: -1_000_000_001, messageThreadId: 7,
      messageId: updateId, kind: "text", text: `prompt ${updateId}`,
      attachment: null, retryOfJobId: null,
      ...(targetContext ? { targetContext } : {}),
    };
    const result = ingress.accept(source);
    await ingress.materialize(result.job.id);
    return result.job;
  }

  function checking(jobId: string): void {
    const job = store.get(jobId)!;
    store.transition({ jobId, eventId: `checking-${jobId}-${job.version}`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "activity.observed", eventAt: now, health: "checking" } });
  }

  function queue(jobId: string): void {
    const job = store.get(jobId)!;
    store.transition({ jobId, eventId: `queue-${jobId}`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "job.queued", eventAt: now } });
  }

  function running(jobId: string): void {
    queue(jobId);
    let job = store.get(jobId)!;
    store.transition({ jobId, eventId: `dispatch-${jobId}`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.started", eventAt: now,
        dispatch: { id: `dispatch-${jobId}`, threadId: THREAD, previousTurnId: null,
          attempt: 1, startedAt: now, transportWriteState: "prepared", nextAttemptAt: null } } });
    job = store.get(jobId)!;
    store.transition({ jobId, eventId: `inflight-${jobId}`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.in_flight", eventAt: now } });
    job = store.get(jobId)!;
    store.transition({ jobId, eventId: `written-${jobId}`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.written", eventAt: now } });
    job = store.get(jobId)!;
    store.transition({ jobId, eventId: `turn-${jobId}`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "turn.started", eventAt: now,
        identifiers: { turnId: `turn-${jobId}` }, codexEventAt: now } });
  }

  function terminalFailure(jobId: string): void {
    const job = store.get(jobId)!;
    store.transition({ jobId, eventId: `terminal-${jobId}`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: now,
        outcome: "failed", attention: { kind: "required", code: "test_failure", actions: ["details"] } } });
  }

  function status(overrides: Partial<TelegramDurableStatusOptions> = {}): TelegramDurableStatusService {
    const service = new TelegramDurableStatusService({
      store,
      guardian: { inspectThread },
      transport: { send, edit },
      classifyTransportError: () => ({ disposition: "permanent" }),
      now: () => now,
      ...overrides,
    });
    services.push(service);
    return service;
  }

  function storeWith(overrides: Record<string, unknown>): TelegramDurableStatusOptions["store"] {
    return {
      get: store.get.bind(store),
      listEventSummaries: store.listEventSummaries.bind(store),
      getDispatchableQueuePosition: store.getDispatchableQueuePosition.bind(store),
      listDeliveries: store.listDeliveries.bind(store),
      readStatusDeliveryEvidence: store.readStatusDeliveryEvidence.bind(store),
      hasTopicResume: store.hasTopicResume.bind(store),
      readSourcePayload: store.readSourcePayload.bind(store),
      prepareStatusAnchorRevision: store.prepareStatusAnchorRevision.bind(store),
      finishStatusAnchorRevision: store.finishStatusAnchorRevision.bind(store),
      replaceMissingStatusAnchorEdit: store.replaceMissingStatusAnchorEdit.bind(store),
      ...overrides,
    } as TelegramDurableStatusOptions["store"];
  }
});

function inspection(threadId: string): GuardianThreadInspection {
  return {
    threadId, turnId: "turn", threadStatus: "active", turnStatus: "inProgress",
    updatedAt: START, itemCount: 1, lastItemType: "agent_message", source: "telecodex",
    canAcceptDirectInput: false, root: true,
  };
}
