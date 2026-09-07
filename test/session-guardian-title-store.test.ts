import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionGuardianDetector } from "../src/session-guardian-detector.js";
import { SessionGuardianStore } from "../src/session-guardian-store.js";
import { fingerprintOf } from "../src/session-guardian-types.js";
import type {
  GuardianFingerprint,
  GuardianRoute,
  GuardianThreadSnapshot,
} from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";
const ALERT_ID = "abcdefghijklmnopqrstuv";
const ROUTE: GuardianRoute = { chatId: -1_001_234_567_890, messageThreadId: 42 };
const FINGERPRINT: GuardianFingerprint = {
  threadId: THREAD_ID,
  turnId: TURN_ID,
  updatedAt: 1_723_000_000,
  itemCount: 2,
  lastItemType: "agentMessage",
};

function snapshot(name = "Checkout recovery"): GuardianThreadSnapshot {
  return {
    ...FINGERPRINT,
    threadStatus: "active",
    turnStatus: "inProgress",
    source: "cli",
    cwd: "/srv/projects/telecodex",
    name,
    canAcceptDirectInput: false,
    root: true,
  };
}

function createVersionOneDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE observations (
      thread_id TEXT PRIMARY KEY NOT NULL CHECK(length(thread_id) > 0),
      turn_id TEXT NOT NULL CHECK(length(turn_id) > 0),
      fingerprint_updated_at REAL NOT NULL CHECK(fingerprint_updated_at >= 0),
      item_count INTEGER NOT NULL CHECK(typeof(item_count) = 'integer' AND item_count >= 0),
      last_item_type TEXT CHECK(last_item_type IS NULL OR length(last_item_type) > 0),
      first_observed_at REAL NOT NULL CHECK(first_observed_at >= 0), last_observed_at REAL NOT NULL CHECK(last_observed_at >= 0),
      unchanged_count INTEGER NOT NULL CHECK(typeof(unchanged_count) = 'integer' AND unchanged_count >= 1),
      CHECK(first_observed_at <= last_observed_at)
    ) STRICT;
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 22 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
      thread_id TEXT NOT NULL CHECK(length(thread_id) > 0), turn_id TEXT NOT NULL CHECK(length(turn_id) > 0),
      fingerprint_updated_at REAL NOT NULL CHECK(fingerprint_updated_at >= 0),
      item_count INTEGER NOT NULL CHECK(typeof(item_count) = 'integer' AND item_count >= 0),
      last_item_type TEXT CHECK(last_item_type IS NULL OR length(last_item_type) > 0),
      route_chat_id INTEGER NOT NULL CHECK(typeof(route_chat_id) = 'integer' AND route_chat_id != 0 AND abs(route_chat_id) <= 4503599627370495),
      route_message_thread_id INTEGER CHECK(route_message_thread_id IS NULL OR (typeof(route_message_thread_id) = 'integer' AND route_message_thread_id > 0 AND route_message_thread_id <= 2147483647)),
      delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','failed','delivered')),
      delivery_message_id INTEGER,
      status_delivery_state TEXT NOT NULL DEFAULT 'none' CHECK(status_delivery_state IN ('none','pending','failed','delivered')),
      state TEXT NOT NULL CHECK(state IN ('open','checking','restored','self-recovered','observation-only','repair-disabled','expired','failed')),
      detail TEXT, created_at REAL NOT NULL CHECK(created_at >= 0),
      CHECK((delivery_state = 'delivered' AND typeof(delivery_message_id) = 'integer' AND delivery_message_id > 0 AND delivery_message_id <= 2147483647) OR (delivery_state IN ('pending','failed') AND delivery_message_id IS NULL)),
      CHECK((status_delivery_state = 'none' AND (delivery_state != 'delivered' OR state IN ('open','checking'))) OR (status_delivery_state IN ('pending','failed','delivered') AND delivery_state = 'delivered' AND state IN ('restored','self-recovered','observation-only','repair-disabled','expired','failed')))
    ) STRICT;
    CREATE TABLE repair_attempts (
      alert_id TEXT PRIMARY KEY NOT NULL REFERENCES alerts(id),
      claim_token TEXT NOT NULL CHECK(length(claim_token) = 22 AND claim_token NOT GLOB '*[^A-Za-z0-9_-]*'), started_at REAL NOT NULL CHECK(started_at >= 0),
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('restored','self-recovered','observation-only','repair-disabled','expired','failed')),
      detail TEXT, finished_at REAL CHECK(finished_at IS NULL OR finished_at >= 0),
      CHECK((outcome IS NULL AND finished_at IS NULL) OR (outcome IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at))
    ) STRICT;
    CREATE UNIQUE INDEX alerts_thread_turn_unique ON alerts(thread_id, turn_id);
    PRAGMA user_version = 1;
  `);
  db.prepare(`
    INSERT INTO alerts (
      id, thread_id, turn_id, fingerprint_updated_at, item_count, last_item_type,
      route_chat_id, route_message_thread_id, delivery_state, delivery_message_id,
      status_delivery_state, state, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'delivered', 3389, 'delivered', 'restored',
      'Thread restored', 1723000600)
  `).run(ALERT_ID, THREAD_ID, TURN_ID, FINGERPRINT.updatedAt, FINGERPRINT.itemCount,
    FINGERPRINT.lastItemType, ROUTE.chatId, ROUTE.messageThreadId);
  db.prepare(`
    INSERT INTO repair_attempts (alert_id, claim_token, started_at, outcome, detail, finished_at)
    VALUES (?, 'zyxwvutsrqponmlkjihgfe', 1723000601, 'restored', 'Thread restored', 1723000602)
  `).run(ALERT_ID);
  db.close();
}

describe("Guardian alert session title storage", () => {
  let directory: string;
  let databasePath: string;
  let stores: SessionGuardianStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-title-store-"));
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

  it("migrates version 1 alerts without inventing a title", () => {
    createVersionOneDatabase(databasePath);

    const store = openStore();
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(store.getAlert(ALERT_ID)).toMatchObject({ id: ALERT_ID, state: "restored" });
      expect(store.getAlert(ALERT_ID)).not.toHaveProperty("threadName");
      expect(db.prepare("SELECT outcome FROM repair_attempts WHERE alert_id = ?")
        .pluck().get(ALERT_ID)).toBe("restored");
    } finally {
      db.close();
    }
  });

  it("persists the first alert title across duplicate creation and reopen", () => {
    const store = openStore();
    const alert = store.createAlert(FINGERPRINT, ROUTE, 61_000, "Checkout recovery");
    const duplicate = store.createAlert(FINGERPRINT, ROUTE, 62_000, "Changed later");

    expect(alert.threadName).toBe("Checkout recovery");
    expect(duplicate).toEqual(alert);
    store.close();

    const reopened = openStore();
    expect(reopened.getAlert(alert.id)?.threadName).toBe("Checkout recovery");
  });

  it.each(["", "x".repeat(513)])("rejects invalid stored title %j", (threadName) => {
    const store = openStore();
    expect(() => store.createAlert(FINGERPRINT, ROUTE, 61_000, threadName)).toThrow(
      "threadName",
    );
  });

  it("stores snapshot name without changing the stall fingerprint", () => {
    const store = openStore();
    const detector = new SessionGuardianDetector(store, () => ROUTE, {
      staleAfterMs: 0,
      confirmationsRequired: 1,
      clock: () => 61_000,
    });
    const first = snapshot("Checkout recovery");
    const renamed = snapshot("Renamed session");

    expect(fingerprintOf(first)).toEqual(fingerprintOf(renamed));
    const result = detector.observe(first);
    expect(result.kind).toBe("alert");
    expect(result.kind === "alert" ? result.alert.threadName : undefined)
      .toBe("Checkout recovery");
  });
});
