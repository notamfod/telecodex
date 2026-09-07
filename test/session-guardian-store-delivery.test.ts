import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionGuardianStore } from "../src/session-guardian-store.js";
import type { GuardianFingerprint, GuardianRoute } from "../src/session-guardian-types.js";

const FINGERPRINT: GuardianFingerprint = {
  threadId: "019ff4ea-8c36-7c5f-8f08-010101010101",
  turnId: "019ff4ea-8c36-7c5f-8f08-020202020202",
  updatedAt: 1_723_000_000,
  itemCount: 2,
  lastItemType: "agentMessage",
};
const ROUTE: GuardianRoute = { chatId: -1_001_234_567_890, messageThreadId: 42 };
const MAX_INT32 = 2_147_483_647;

describe("SessionGuardianStore Telegram delivery state", () => {
  let directory: string;
  let databasePath: string;
  let stores: SessionGuardianStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-delivery-"));
    databasePath = path.join(directory, "guardian.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function openStore(): SessionGuardianStore {
    const store = new SessionGuardianStore(databasePath);
    stores.push(store);
    return store;
  }

  it("persists pending and successful delivery coordinates across reopen", () => {
    const first = openStore();
    const created = first.createAlert(FINGERPRINT, ROUTE, 1_000);
    expect(created).toEqual(expect.objectContaining({ deliveryState: "pending" }));
    expect(created).toEqual(expect.objectContaining({ statusDeliveryState: "none" }));
    expect(created).not.toHaveProperty("messageId");

    const delivered = first.recordDelivery(created.id, MAX_INT32);
    expect(delivered).toEqual(expect.objectContaining({
      deliveryState: "delivered",
      messageId: MAX_INT32,
      route: ROUTE,
    }));
    first.close();

    const reopened = openStore();
    expect(reopened.getAlert(created.id)).toEqual(delivered);
    expect(reopened.listOpenAlerts()).toEqual([delivered]);
  });

  it("makes successful delivery atomic, idempotent, and conflict-safe across stores", () => {
    const first = openStore();
    const second = openStore();
    const created = first.createAlert(FINGERPRINT, ROUTE, 1_000);

    const winner = first.recordDelivery(created.id, 123);
    expect(second.recordDelivery(created.id, 123)).toEqual(winner);
    expect(() => second.recordDelivery(created.id, 124)).toThrow(
      "Guardian alert delivery message conflicts",
    );
    expect(first.getAlert(created.id)).toEqual(winner);
  });

  it("records failed delivery idempotently and never downgrades delivered state", () => {
    const store = openStore();
    const created = store.createAlert(FINGERPRINT, ROUTE, 1_000);

    const failed = store.markDeliveryFailed(created.id);
    expect(failed).toEqual(expect.objectContaining({ deliveryState: "failed" }));
    expect(failed).not.toHaveProperty("messageId");
    expect(store.markDeliveryFailed(created.id)).toEqual(failed);

    const delivered = store.recordDelivery(created.id, 456);
    expect(store.markDeliveryFailed(created.id)).toEqual(delivered);
    expect(store.getAlert(created.id)).toEqual(delivered);
  });

  it("validates message IDs and reports unknown alerts deterministically", () => {
    const store = openStore();
    const created = store.createAlert(FINGERPRINT, ROUTE, 1_000);

    for (const messageId of [0, -1, 1.5, MAX_INT32 + 1, Number.NaN]) {
      expect(() => store.recordDelivery(created.id, messageId)).toThrow(
        "messageId must be a positive signed 32-bit integer",
      );
    }
    expect(() => store.recordDelivery("abcdefghijklmnopqrstuv", 1)).toThrow(
      "Unknown guardian alert",
    );
    expect(() => store.markDeliveryFailed("abcdefghijklmnopqrstuv")).toThrow(
      "Unknown guardian alert",
    );
  });

  it("enforces delivery consistency and topic bounds in SQLite", () => {
    const store = openStore();
    const created = store.createAlert(FINGERPRINT, ROUTE, 1_000);
    const db = new Database(databasePath);
    try {
      expect(() => db.prepare(
        "UPDATE alerts SET delivery_state = 'delivered' WHERE id = ?",
      ).run(created.id)).toThrow();
      expect(() => db.prepare(
        "UPDATE alerts SET delivery_message_id = 1 WHERE id = ?",
      ).run(created.id)).toThrow();
      expect(() => db.prepare(
        "UPDATE alerts SET delivery_state = 'invalid' WHERE id = ?",
      ).run(created.id)).toThrow();
      expect(() => db.prepare(
        "UPDATE alerts SET route_message_thread_id = ? WHERE id = ?",
      ).run(MAX_INT32 + 1, created.id)).toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    ["delivery_state = 'corrupt'", "delivery_state"],
    ["delivery_state = 'delivered', delivery_message_id = 0", "delivery_message_id"],
    [`route_message_thread_id = ${MAX_INT32 + 1}`, "route_message_thread_id"],
  ])("rejects corrupt decoded rows for %s", (assignment, field) => {
    const store = openStore();
    const created = store.createAlert(FINGERPRINT, ROUTE, 1_000);
    const db = new Database(databasePath);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(`UPDATE alerts SET ${assignment} WHERE id = ?`).run(created.id);
    } finally {
      db.close();
    }

    expect(() => store.getAlert(created.id)).toThrow(`Invalid guardian alert row: ${field}`);
    expect(() => store.listOpenAlerts()).toThrow(`Invalid guardian alert row: ${field}`);
  });

  it("accepts the signed int32 maximum topic and rejects the next integer", () => {
    const store = openStore();
    expect(store.createAlert(
      FINGERPRINT,
      { chatId: ROUTE.chatId, messageThreadId: MAX_INT32 },
      1_000,
    ).route.messageThreadId).toBe(MAX_INT32);
    expect(() => store.createAlert(
      { ...FINGERPRINT, turnId: "019ff4ea-8c36-7c5f-8f08-030303030303" },
      { chatId: ROUTE.chatId, messageThreadId: MAX_INT32 + 1 },
      2_000,
    )).toThrow("route.messageThreadId must be a positive signed 32-bit integer");
  });

  it("durably queues, retries, and completes a terminal status edit", () => {
    const first = openStore();
    const created = first.createAlert(FINGERPRINT, ROUTE, 1_000);
    const delivered = first.recordDelivery(created.id, 123);
    expect(delivered.statusDeliveryState).toBe("none");
    const closed = first.markOpenAlertSelfRecovered(created.id, "Thread progressed or became idle");
    expect(closed.alert.statusDeliveryState).toBe("pending");
    expect(first.listAlertsNeedingStatusDelivery()).toEqual([closed.alert]);

    const failed = first.markStatusDeliveryFailed(created.id);
    expect(failed.statusDeliveryState).toBe("failed");
    expect(first.markStatusDeliveryFailed(created.id)).toEqual(failed);
    first.close();

    const reopened = openStore();
    expect(reopened.listAlertsNeedingStatusDelivery()).toEqual([failed]);
    const completed = reopened.recordStatusDelivery(created.id);
    expect(completed.statusDeliveryState).toBe("delivered");
    expect(reopened.recordStatusDelivery(created.id)).toEqual(completed);
    expect(reopened.markStatusDeliveryFailed(created.id)).toEqual(completed);
    expect(reopened.listAlertsNeedingStatusDelivery()).toEqual([]);
  });

  it("queues status when a terminal alert receives its initial delivery later", () => {
    const store = openStore();
    const created = store.createAlert(FINGERPRINT, ROUTE, 1_000);
    store.markAlert(created.id, "failed", "Fresh state check failed");
    expect(store.getAlert(created.id)).toMatchObject({
      state: "failed", deliveryState: "pending", statusDeliveryState: "none",
    });
    expect(store.recordDelivery(created.id, 123)).toMatchObject({
      state: "failed", deliveryState: "delivered", statusDeliveryState: "pending",
    });
  });

  it("atomically queues status from finishRepair and rejects corrupt status rows", () => {
    const owner = openStore();
    const observer = openStore();
    const created = owner.createAlert(FINGERPRINT, ROUTE, 1_000);
    owner.recordDelivery(created.id, 123);
    expect(owner.claimRepair(created.id, 2_000)).toBe(true);
    owner.finishRepair(created.id, "restored", "Thread restored", 3_000);
    expect(observer.getAlert(created.id)).toMatchObject({
      state: "restored", statusDeliveryState: "pending",
    });
    expect(observer.recordStatusDelivery(created.id).statusDeliveryState).toBe("delivered");

    const db = new Database(databasePath);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare("UPDATE alerts SET status_delivery_state = 'corrupt' WHERE id = ?")
        .run(created.id);
    } finally { db.close(); }
    expect(() => owner.getAlert(created.id)).toThrow(
      "Invalid guardian alert row: status_delivery_state",
    );
  });
});
