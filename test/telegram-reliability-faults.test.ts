import { existsSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { vi } from "vitest";

import { AppServerRequestError } from "../src/app-server-client.js";
import {
  TelegramDeliveryApiError,
} from "../src/telegram-delivery-outbox.js";
import { TelegramDurableStatusService } from "../src/telegram-durable-status.js";
import { TelegramJobCoordinator } from "../src/telegram-job-coordinator.js";
import { TelegramJobIngress } from "../src/telegram-job-ingress.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { createTelegramReconciliationRuntime } from "../src/telegram-reconciliation-runtime.js";
import { projectTelegramJobStatus } from "../src/telegram-status-projection.js";
import {
  FaultCodex,
  TelegramReliabilityFixture,
} from "./telegram-reliability-fixtures.js";

describe("Telegram reliability fault injection", () => {
  let fixture: TelegramReliabilityFixture;

  beforeEach(() => {
    fixture = new TelegramReliabilityFixture();
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.close();
  });

  it("duplicate_update_creates_one_job", () => {
    const ingress = fixture.ingress();
    const source = fixture.source({ updateId: 101 });

    const first = ingress.accept(source);
    const duplicate = ingress.accept(structuredClone(source));

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ created: false, job: first.job });
    expect(fixture.store.countJobs()).toBe(1);
    expect(fixture.store.listEvents(first.job.id).map(({ event }) => event.type))
      .toEqual(["update.accepted"]);
    expect(fixture.store.listDeliveries(first.job.id)).toHaveLength(1);
  });

  it("crash_after_inbox_commit_recovers_anchor", async () => {
    const accepted = fixture.ingress().accept(fixture.source()).job;
    expect(fixture.store.listDeliveries(accepted.id)[0]).toMatchObject({
      partKey: "status-anchor",
      state: "pending",
      telegramMessageId: null,
    });
    fixture.reopen();
    const send = vi.fn(async () => 501);
    const status = new TelegramDurableStatusService({
      store: fixture.store,
      guardian: { inspectThread: async () => { throw new Error("not used"); } },
      transport: { send, edit: async () => {} },
      classifyTransportError: () => ({ disposition: "permanent" }),
      now: () => fixture.now,
    });

    await status.refresh(accepted.id);
    await status.dispose();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -100_001,
      messageThreadId: 7,
      projection: expect.objectContaining({ jobId: accepted.id, phase: "accepted" }),
    }));
    expect(fixture.store.listDeliveries(accepted.id)[0]).toMatchObject({
      state: "delivered",
      telegramMessageId: 501,
      attemptCount: 1,
    });
  });

  it("turn_start_timeout_after_write_never_replays", async () => {
    const queued = fixture.queue(fixture.acceptText("write-timeout"));
    fixture.codex.startBehavior = async (request) => {
      request.callbacks.beforeDispatchWrite({
        threadId: request.threadId,
        previousTurnId: null,
        previousTurnKnown: true,
        attempt: 1,
      });
      request.callbacks.onDispatchWritten();
      throw new AppServerRequestError("APP_SERVER_ACCEPTANCE_UNKNOWN");
    };
    const first = fixture.coordinator();

    await first.pump();
    await vi.waitFor(() => expect(fixture.store.get(queued.id)?.attention).toMatchObject({
      kind: "required",
      code: "dispatch_acceptance_unknown",
    }));
    first.dispose();
    const recreated = fixture.coordinator();
    await recreated.pump();

    expect(fixture.codex.starts).toHaveLength(1);
    expect(fixture.store.get(queued.id)).toMatchObject({
      phase: "dispatching",
      dispatch: { transportWriteState: "written", attempt: 1 },
    });
    recreated.dispose();
  });

  it("lost_turn_completed_is_reconciled_from_thread_read", async () => {
    const running = fixture.running("lost-completed");
    fixture.codex.recoverBehavior = async (request, turnId) => {
      request.callbacks.onStarted(turnId);
      request.callbacks.onTextDelta("recovered result");
      request.callbacks.onTurnOutcome({ status: "completed", eventAt: fixture.now + 2 });
    };
    const coordinator = fixture.coordinator();
    const request = vi.fn(async () => ({
      thread: { id: running.threadId, turns: [{ id: running.turnId, status: "completed" }] },
    }));
    const run = reconciliation(fixture, coordinator, request);

    await run();
    await vi.waitFor(() => expect(fixture.store.get(running.id)?.phase).toBe("delivering"));

    expect(request).toHaveBeenCalledWith("thread/read", {
      threadId: running.threadId,
      includeTurns: true,
    });
    expect(fixture.codex.starts).toEqual([]);
    expect(fixture.codex.recoveries).toHaveLength(1);
    expect(fixture.store.get(running.id)?.turnResult?.content).toEqual([
      { kind: "text", text: "recovered result" },
    ]);
    coordinator.dispose();
  });

  it("restart_running_reattaches_exact_turn", async () => {
    const running = fixture.running("restart-active");
    fixture.codex.recoverBehavior = async (request, turnId) => {
      request.callbacks.onStarted(turnId);
      request.callbacks.onActivity({ activity: "model", eventAt: fixture.now + 1, method: "turn/active" });
    };
    const coordinator = fixture.coordinator();
    const request = vi.fn(async () => ({
      thread: { id: running.threadId, turns: [{ id: running.turnId, status: "inProgress" }] },
    }));

    await reconciliation(fixture, coordinator, request)();
    await vi.waitFor(() => expect(fixture.codex.recoveries).toHaveLength(1));

    expect(fixture.codex.recoveries[0]).toMatchObject({
      turnId: running.turnId,
      request: { jobId: running.id, threadId: running.threadId, prompt: { text: "", attachments: [] } },
    });
    expect(fixture.codex.starts).toEqual([]);
    expect(fixture.store.get(running.id)).toMatchObject({
      phase: "running",
      threadId: running.threadId,
      turnId: running.turnId,
    });
    coordinator.dispose();
  });

  it("restart_delivering_sends_only_pending_parts", async () => {
    const delivering = fixture.delivering("partial-restart", [
      { kind: "text", text: "x".repeat(8_500) },
    ]);
    const first = fixture.outbox();
    first.installPlan(delivering.id, {
      chatId: -100_001,
      messageThreadId: 7,
      anchorMessageId: 501,
    });
    const before = fixture.store.listDeliveries(delivering.id);
    const alreadyDelivered = before[0]!;
    fixture.store.transitionDelivery({
      jobId: delivering.id,
      partKey: alreadyDelivered.partKey,
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: fixture.now,
    });
    const pendingCount = before.length - 1;
    fixture.reopen();

    await fixture.outbox().pump();

    expect(fixture.telegram.calls).toHaveLength(pendingCount);
    expect(fixture.store.listDeliveries(delivering.id)
      .find((part) => part.partKey === alreadyDelivered.partKey)).toMatchObject({
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
    });
    expect(fixture.store.listDeliveries(delivering.id).every((part) => part.state === "delivered"))
      .toBe(true);
  });

  it("telegram_send_timeout_marks_new_message_uncertain", async () => {
    const delivering = fixture.delivering("send-timeout");
    const outbox = fixture.outbox({ timeoutMs: 5 });
    outbox.installPlan(delivering.id, {
      chatId: -100_001,
      messageThreadId: 7,
      anchorMessageId: null,
    });
    fixture.telegram.behavior = () => new Promise(() => {});

    await outbox.pump();

    expect(fixture.telegram.calls).toHaveLength(1);
    expect(fixture.telegram.calls[0]?.signal.aborted).toBe(true);
    expect(fixture.store.listDeliveries(delivering.id)
      .find((part) => part.partKey === "status-anchor")).toMatchObject({
      state: "uncertain",
      attemptCount: 1,
      lastErrorCode: "telegram_send_uncertain",
    });
    expect(fixture.store.get(delivering.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("telegram_edit_timeout_retries_known_anchor", async () => {
    const delivering = fixture.delivering("edit-timeout");
    const first = fixture.outbox({ timeoutMs: 5 });
    first.installPlan(delivering.id, {
      chatId: -100_001,
      messageThreadId: 7,
      anchorMessageId: 501,
    });
    fixture.telegram.behavior = () => new Promise(() => {});
    await first.pump();
    expect(fixture.store.listDeliveries(delivering.id)[0]).toMatchObject({
      state: "pending",
      attemptCount: 1,
      nextAttemptAt: fixture.now + 1_000,
    });

    fixture.now += 1_000;
    fixture.telegram.behavior = async () => ({ messageId: 501 });
    await fixture.outbox({ timeoutMs: 5 }).pump();

    expect(fixture.telegram.calls).toHaveLength(2);
    expect(fixture.store.get(delivering.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("partial_delivery_never_renders_done", () => {
    const delivering = fixture.delivering("partial-projection", [
      { kind: "text", text: "x".repeat(8_500) },
    ]);
    fixture.outbox().installPlan(delivering.id, {
      chatId: -100_001,
      messageThreadId: 7,
      anchorMessageId: 501,
    });
    fixture.store.transitionDelivery({
      jobId: delivering.id,
      partKey: "status-anchor",
      state: "delivered",
      attemptCount: 1,
      telegramMessageId: 501,
      updatedAt: fixture.now,
    });
    const job = fixture.store.get(delivering.id)!;
    const events = fixture.store.listEvents(delivering.id);

    const projection = projectTelegramJobStatus({
      job,
      latestEvent: events.at(-1)?.event ?? null,
      deliveries: fixture.store.listDeliveries(delivering.id),
      guardian: { availability: "available", inspection: null },
      queue: null,
      now: fixture.now,
    });

    expect(projection.delivery.delivered).toBeGreaterThan(0);
    expect(projection.delivery.pending).toBeGreaterThan(0);
    expect(projection.delivery.complete).toBe(false);
    expect(projection.isDone).toBe(false);
    expect(projection.state).not.toBe("done");
  });

  it("guardian_unavailable_keeps_job_visible", async () => {
    const running = fixture.running("guardian-down");
    const coordinator = fixture.coordinator();
    const run = createTelegramReconciliationRuntime({
      store: fixture.store,
      coordinator,
      materializer: fixture.ingress(),
      resumeDelivery: async () => {},
      refreshStatus: async () => {},
      exactTurnReader: { request: async () => ({ thread: { id: running.threadId, turns: [] } }) },
      guardian: { inspectThread: async () => { throw new Error("guardian socket unavailable"); } },
      now: () => fixture.now,
      createId: fixture.createId,
    });

    await run();

    const job = fixture.store.get(running.id)!;
    expect(job).toMatchObject({
      phase: "running",
      health: "unavailable",
      attention: { kind: "required", code: "guardian_unavailable", actions: ["inspect"] },
      reconciliation: { state: "applied" },
    });
    expect(fixture.store.listUnfinished().map(({ id }) => id)).toContain(running.id);
    coordinator.dispose();
  });

  it("full_disk_fails_before_dispatch", () => {
    const fullPath = path.join(fixture.directory, "full.sqlite");
    const fullStore = new SqliteTelegramJobStore(fullPath, { maxPageCount: 1 });
    const download = vi.fn(async () => new Uint8Array([1]));
    const codex = new FaultCodex();
    const ingress = new TelegramJobIngress({
      store: fullStore,
      materializationRoot: path.join(fixture.directory, "full-materialized"),
      createId: fixture.createId,
      downloadAttachment: download,
    });

    expect(() => ingress.accept(fixture.source({ text: "x".repeat(64 * 1024) }))).toThrow(/full/i);
    const coordinator = new TelegramJobCoordinator({
      store: fullStore,
      materializer: ingress,
      codex,
      createId: fixture.createId,
    });
    expect(fullStore.countJobs()).toBe(0);
    expect(fullStore.listDispatchable(10)).toEqual([]);
    expect(codex.starts).toEqual([]);
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(path.join(fixture.directory, "full-materialized"))).toBe(false);
    coordinator.dispose();
    fullStore.close();
  });

  it("corrupt_schema_fails_before_polling", () => {
    const corruptPath = path.join(fixture.directory, "corrupt.sqlite");
    const database = new Database(corruptPath);
    database.exec("CREATE TABLE unrelated (id INTEGER)");
    database.close();
    let pollingStarted = false;

    expect(() => {
      const store = new SqliteTelegramJobStore(corruptPath);
      pollingStarted = true;
      store.close();
    }).toThrow("Malformed telegram job schema");
    expect(pollingStarted).toBe(false);
  });

  it("crash_after_telegram_accepts_send_marks_uncertain", async () => {
    const delivering = fixture.delivering("accepted-send-crash");
    const first = fixture.outbox();
    first.installPlan(delivering.id, {
      chatId: -100_001,
      messageThreadId: 7,
      anchorMessageId: null,
    });
    fixture.store.transitionDelivery({
      jobId: delivering.id,
      partKey: "status-anchor",
      state: "sending",
      attemptCount: 0,
      nextAttemptAt: fixture.now,
      updatedAt: fixture.now,
    });
    fixture.reopen();

    await fixture.outbox().pump();

    expect(fixture.telegram.calls).toEqual([]);
    expect(fixture.store.listDeliveries(delivering.id)
      .find((part) => part.partKey === "status-anchor")).toMatchObject({
      state: "uncertain",
      attemptCount: 1,
      lastErrorCode: "telegram_send_uncertain",
    });
    expect(fixture.store.get(delivering.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("active_subagent_without_text_updates_activity", async () => {
    const queued = fixture.queue(fixture.acceptText("subagent-activity"));
    let release!: () => void;
    fixture.codex.startBehavior = (request) => {
      request.callbacks.beforeDispatchWrite({
        threadId: request.threadId,
        previousTurnId: null,
        previousTurnKnown: true,
        attempt: 1,
      });
      request.callbacks.onDispatchWritten();
      request.callbacks.onStarted("subagent-turn");
      request.callbacks.onActivity({
        activity: "subagent",
        eventAt: fixture.now + 25,
        method: "subagent/activity",
      });
      return new Promise<void>((resolve) => { release = resolve; });
    };
    const coordinator = fixture.coordinator();

    await coordinator.pump();
    await vi.waitFor(() => expect(fixture.store.get(queued.id)).toMatchObject({
      phase: "running",
      activity: "subagent",
      lastCodexEventAt: fixture.now + 25,
    }));

    expect(fixture.store.get(queued.id)?.turnResult).toBeUndefined();
    release();
    coordinator.dispose();
  });

  it("telegram_retry_after_does_not_consume_attempt", async () => {
    const delivering = fixture.delivering("retry-after");
    const outbox = fixture.outbox();
    outbox.installPlan(delivering.id, {
      chatId: -100_001,
      messageThreadId: 7,
      anchorMessageId: 501,
    });
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("retry_after", 2_000);
    };

    await outbox.pump();

    expect(fixture.store.listDeliveries(delivering.id)[0]).toMatchObject({
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: fixture.now + 2_000,
      lastErrorCode: "telegram_retry_after",
    });
  });

  it("telegram_noop_edit_is_success", async () => {
    const delivering = fixture.delivering("noop-edit");
    const outbox = fixture.outbox();
    outbox.installPlan(delivering.id, {
      chatId: -100_001,
      messageThreadId: 7,
      anchorMessageId: 501,
    });
    fixture.telegram.behavior = async () => {
      throw new TelegramDeliveryApiError("message_not_modified");
    };

    await outbox.pump();

    expect(fixture.telegram.calls[0]?.payload).toMatchObject({
      operation: "edit_text",
      messageId: 501,
    });
    expect(fixture.store.listDeliveries(delivering.id)[0]).toMatchObject({
      state: "delivered",
      telegramMessageId: 501,
      attemptCount: 1,
    });
    expect(fixture.store.get(delivering.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });
});

function reconciliation(
  fixture: TelegramReliabilityFixture,
  coordinator: TelegramJobCoordinator,
  request: (method: string, params: unknown) => Promise<unknown>,
) {
  return createTelegramReconciliationRuntime({
    store: fixture.store,
    coordinator,
    materializer: fixture.ingress(),
    resumeDelivery: async () => {},
    refreshStatus: async () => {},
    exactTurnReader: { request },
    guardian: { inspectThread: async () => { throw new Error("guardian must not be needed"); } },
    now: () => fixture.now,
    createId: fixture.createId,
  });
}
