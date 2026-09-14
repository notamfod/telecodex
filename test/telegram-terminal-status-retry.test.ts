import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { TelegramDeliveryOutbox, TelegramDeliveryApiError } from "../src/telegram-delivery-outbox.js";
import { hashTelegramDeliveryPayload, type TelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import type { TelegramJob } from "../src/telegram-job-types.js";

const NOW = 1_700_000_000_000;
describe("terminal status retry", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-terminal-retry-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function fixture(outcome: "failed" | "aborted") {
    const job: TelegramJob = {
      schemaVersion: 1, id: "job", version: 1, source: { botId: "bot", updateId: 1 },
      attachments: [], phase: "accepted", health: "healthy", activity: "unknown",
      attention: { kind: "required", code: "turn_failed", actions: ["inspect"] }, outcome: null,
      dispatchId: null, threadId: null, turnId: null, deliveries: [],
      acceptedAt: NOW, updatedAt: NOW, terminalAt: null, dismissedAt: null, retainUntil: null,
    };
    const payload: TelegramDeliveryPayload = { operation: "edit_text", chatId: -1001, messageId: 12, text: "Task failed" };
    store.acceptUpdate({ job, eventId: "accepted", sourcePayload: { kind: "text", text: "test" }, initialDeliveries: [{
      jobId: job.id, partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "failed",
      payload, contentHash: hashTelegramDeliveryPayload(payload), telegramMessageId: 12,
      attemptCount: 3, lastErrorCode: "telegram_status_edit_failed", updatedAt: NOW,
    }] });
    return store.transition({ jobId: job.id, eventId: "terminal", expectedVersion: 1,
      event: { schemaVersion: 1, type: "job.terminal", eventAt: NOW, outcome } });
  }
  it.each(["failed", "aborted"] as const)("retries %s status without changing task outcome or attention", async outcome => {
    const before = fixture(outcome);
    const calls: TelegramDeliveryPayload[] = [];
    const outbox = new TelegramDeliveryOutbox({ store, now: () => NOW + 1,
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
      telegram: { deliver: async payload => {
        calls.push(payload);
        if (payload.operation === "edit_text") throw new TelegramDeliveryApiError("message_missing");
        return { messageId: 90 };
      } },
    });
    await outbox.retryFailed("job", "status-anchor", { expectedJobVersion: before.version });
    expect(calls.map(p => p.operation)).toEqual(["edit_text", "send_text"]);
    expect(store.listDeliveries("job")[0]).toMatchObject({ state: "delivered", telegramMessageId: 90 });
    expect(store.get("job")).toMatchObject({ phase: "terminal", outcome, terminalAt: before.terminalAt, attention: before.attention });
    expect(store.get("job")!.responsePlan).toBeUndefined();
    expect(store.get("job")!.version).toBeGreaterThan(before.version);
    await expect(outbox.retryFailed("job", "status-anchor", { expectedJobVersion: before.version })).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
  it("keeps an ambiguous replacement fenced and preserves failed task state", async () => {
    const before = fixture("failed");
    let sends = 0;
    const outbox = new TelegramDeliveryOutbox({ store, now: () => NOW + 1,
      statusDestination: () => ({ chatId: -1001, messageThreadId: 7 }),
      telegram: { deliver: async payload => {
        if (payload.operation === "edit_text") throw new TelegramDeliveryApiError("message_missing");
        sends++; throw new Error("connection lost");
      } },
    });
    await outbox.retryFailed("job", "status-anchor", { expectedJobVersion: before.version });
    expect(store.listDeliveries("job")[0]?.state).toBe("uncertain");
    await expect(outbox.retryFailed("job", "status-anchor")).rejects.toThrow();
    expect(sends).toBe(1);
    expect(store.get("job")).toMatchObject({ phase: "terminal", outcome: "failed", attention: before.attention });
  });

  it("wakes and retries a rate-limited terminal status after explicit authorization", async () => {
    const before = fixture("failed");
    let now = NOW + 1;
    let calls = 0;
    const wakeups: number[] = [];
    const outbox = new TelegramDeliveryOutbox({ store, now: () => now,
      scheduleWakeup: at => { wakeups.push(at); },
      telegram: { deliver: async () => {
        if (++calls === 1) throw new TelegramDeliveryApiError("retry_after", 1_000);
        return { messageId: 12 };
      } },
    });
    await outbox.retryFailed("job", "status-anchor", { expectedJobVersion: before.version });
    expect(wakeups).toContain(now + 1_000);
    now += 1_000;
    await outbox.pump();
    expect(calls).toBe(2);
    expect(store.listDeliveries("job")[0]?.state).toBe("delivered");
    expect(store.get("job")).toMatchObject({ outcome: "failed", attention: before.attention });
  });

  it("contains an expired replacement-send lease after restart without sending again", async () => {
    let job = fixture("failed");
    let row = store.listDeliveries("job")[0]!;
    const first = store.transitionDeliveryAndProject({
      jobId: job.id, partKey: row.partKey, expectedJobVersion: job.version,
      expectedState: "failed", expectedAttemptCount: row.attemptCount, expectedContentHash: row.contentHash,
      state: "sending", attemptCount: row.attemptCount, allowFailedRetry: true,
      nextAttemptAt: NOW + 100, updatedAt: NOW + 1, eventId: "explicit-status-retry",
    });
    job = first.job;
    row = store.replaceMissingStatusAnchorEdit({
      jobId: job.id, expectedAttemptCount: first.delivery.attemptCount,
      expectedContentHash: first.delivery.contentHash, expectedLeaseUntil: NOW + 100,
      expectedMessageId: 12, updatedAt: NOW + 2,
      replacementPayload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Task failed" },
    });
    store.transitionDeliveryAndProject({
      jobId: job.id, partKey: row.partKey, expectedJobVersion: job.version,
      expectedState: "pending", expectedAttemptCount: row.attemptCount, expectedContentHash: row.contentHash,
      state: "sending", attemptCount: row.attemptCount, nextAttemptAt: NOW + 100,
      updatedAt: NOW + 3, eventId: "replacement-send-started",
    });
    store.close();
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    let calls = 0;
    const outbox = new TelegramDeliveryOutbox({ store, now: () => NOW + 101,
      telegram: { deliver: async () => { calls++; return { messageId: 99 }; } },
    });
    await outbox.pump();
    expect(calls).toBe(0);
    expect(store.listDeliveries("job")[0]?.state).toBe("uncertain");
    expect(store.get("job")).toMatchObject({ outcome: "failed", attention: job.attention });
  });

  it.each(["pending", "sending"] as const)("does not adopt an unauthorized historical %s anchor", async state => {
    fixture("failed");
    // The legacy status writer could leave these states without an explicit outbox retry.
    store.transitionDelivery({ jobId: "job", partKey: "status-anchor", state: "sending", attemptCount: 3, updatedAt: NOW + 1 });
    if (state === "pending") store.transitionDelivery({ jobId: "job", partKey: "status-anchor",
      state, attemptCount: 3, nextAttemptAt: NOW + 2, updatedAt: NOW + 2 });
    let calls = 0;
    const outbox = new TelegramDeliveryOutbox({ store, now: () => NOW + 101,
      telegram: { deliver: async () => { calls++; return { messageId: 12 }; } },
    });
    await outbox.pump();
    expect(calls).toBe(0);
    expect(store.listDeliveries("job")[0]?.state).toBe(state);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });
});
