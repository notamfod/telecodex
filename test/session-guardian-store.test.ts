import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionGuardianStore } from "../src/session-guardian-store.js";
import type { SessionGuardianStoreOptions } from "../src/session-guardian-store.js";
import type {
  GuardianFingerprint,
  GuardianRoute,
  GuardianThreadSnapshot,
} from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";
const OTHER_TURN_ID = "019ff4ea-8c36-7c5f-8f08-030303030303";

const route: GuardianRoute = {
  chatId: -1_001_234_567_890,
  messageThreadId: 42,
};

function snapshot(
  overrides: Partial<GuardianThreadSnapshot> = {},
): GuardianThreadSnapshot {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    threadStatus: "active",
    turnStatus: "inProgress",
    updatedAt: 1_723_000_000,
    itemCount: 2,
    lastItemType: "agentMessage",
    source: "cli",
    cwd: "/srv/projects/telecodex",
    name: "Guardian store",
    canAcceptDirectInput: false,
    root: true,
    ...overrides,
  };
}

function fingerprint(
  overrides: Partial<GuardianFingerprint> = {},
): GuardianFingerprint {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    updatedAt: 1_723_000_000,
    itemCount: 2,
    lastItemType: "agentMessage",
    ...overrides,
  };
}

function mode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe("SessionGuardianStore", () => {
  let directory: string;
  let databasePath: string;
  let stores: SessionGuardianStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-store-"));
    databasePath = path.join(directory, "guardian.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function openStore(options: SessionGuardianStoreOptions = {}): SessionGuardianStore {
    const store = new SessionGuardianStore(databasePath, options);
    stores.push(store);
    return store;
  }

  it("initializes the durable schema securely and reopens it", () => {
    const first = openStore();
    first.upsertObservation(snapshot(), fingerprint(), 1_000);
    first.close();

    expect(mode(databasePath)).toBe(0o600);

    const reopened = openStore();
    reopened.upsertObservation(snapshot(), fingerprint(), 2_000);
    const db = new Database(databasePath, { readonly: true });
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).pluck().all();
      const uniqueIndex = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).pluck().get("alerts_thread_turn_unique");

      expect(tables).toEqual(["alerts", "observations", "repair_attempts"]);
      expect(uniqueIndex).toContain("thread_id, turn_id");
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
    }

    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${databasePath}${suffix}`;
      expect(existsSync(sidecarPath)).toBe(true);
      expect(mode(sidecarPath)).toBe(0o600);
    }
    expect(reopened.upsertObservation(snapshot(), fingerprint(), 3_000).unchangedCount).toBe(3);
  });

  it("counts unchanged fingerprints and resets when any fingerprint field changes", () => {
    const store = openStore();

    const first = store.upsertObservation(snapshot(), fingerprint(), 1_000);
    const second = store.upsertObservation(snapshot(), fingerprint(), 61_000);
    const changedFingerprint = fingerprint({ itemCount: 3, lastItemType: "toolCall" });
    const changed = store.upsertObservation(
      snapshot({ itemCount: 3, lastItemType: "toolCall" }),
      changedFingerprint,
      62_000,
    );

    expect(first).toEqual({
      fingerprint: fingerprint(),
      firstObservedAt: 1_000,
      lastObservedAt: 1_000,
      unchangedCount: 1,
    });
    expect(second).toEqual({
      fingerprint: fingerprint(),
      firstObservedAt: 1_000,
      lastObservedAt: 61_000,
      unchangedCount: 2,
    });
    expect(changed).toEqual({
      fingerprint: changedFingerprint,
      firstObservedAt: 62_000,
      lastObservedAt: 62_000,
      unchangedCount: 1,
    });
  });

  it("clears one thread observation without affecting another", () => {
    const store = openStore();
    const otherThreadId = "019ff4ea-8c36-7c5f-8f08-040404040404";
    store.upsertObservation(snapshot(), fingerprint(), 1_000);
    store.upsertObservation(
      snapshot({ threadId: otherThreadId }),
      fingerprint({ threadId: otherThreadId }),
      1_000,
    );

    store.clearObservation(THREAD_ID);

    expect(store.upsertObservation(snapshot(), fingerprint(), 2_000).unchangedCount).toBe(1);
    expect(store.upsertObservation(
      snapshot({ threadId: otherThreadId }),
      fingerprint({ threadId: otherThreadId }),
      2_000,
    ).unchangedCount).toBe(2);
  });

  it("creates one immutable alert per thread and turn and preserves it across reopen", () => {
    const store = openStore();
    const alert = store.createAlert(fingerprint(), route, 61_000);
    const duplicate = store.createAlert(
      fingerprint({ updatedAt: 1_723_000_999, itemCount: 99 }),
      { chatId: -999, messageThreadId: 9 },
      62_000,
    );
    const otherTurn = store.createAlert(
      fingerprint({ turnId: OTHER_TURN_ID }),
      route,
      63_000,
    );

    expect(alert.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(duplicate).toEqual(alert);
    expect(otherTurn.id).not.toBe(alert.id);
    expect(Object.isFrozen(alert)).toBe(true);
    expect(Object.isFrozen(alert.fingerprint)).toBe(true);
    expect(Object.isFrozen(alert.route)).toBe(true);
    expect(() => {
      (alert.route as { chatId: number }).chatId = 1;
    }).toThrow();

    store.close();
    const reopened = openStore();
    expect(reopened.getAlert(alert.id)).toEqual(alert);
    expect(reopened.listOpenAlerts()).toEqual([alert, otherTurn]);
    expect(reopened.getAlert(alert.id)).not.toBe(alert);
  });

  it("keeps one operation-bound claim per store even after its lease age", () => {
    const first = openStore({ repairClaimLeaseMs: 100 });
    const alert = first.createAlert(fingerprint(), route, 61_000);
    expect(first.claimRepair(alert.id, 63_000)).toBe(true);
    expect(first.claimRepair(alert.id, 63_100)).toBe(false);
    first.finishRepair(alert.id, "restored", "original owner finished", 63_101);
    expect(first.getAlert(alert.id)).toEqual(expect.objectContaining({
      state: "restored",
      detail: "original owner finished",
    }));
  });

  it("leases repair ownership and prevents a stale owner from finishing a reclaimed attempt", () => {
    const leaseMs = 100;
    const owner = openStore({ repairClaimLeaseMs: leaseMs });
    const alert = owner.createAlert(fingerprint(), route, 1_000);
    expect(owner.claimRepair(alert.id, 2_000)).toBe(true);
    expect(owner.getAlert(alert.id)?.state).toBe("checking");
    const contender = openStore({ repairClaimLeaseMs: leaseMs });
    expect(contender.claimRepair(alert.id, 2_099)).toBe(false);
    expect(contender.claimRepair(alert.id, 2_100)).toBe(true);
    expect(() => owner.finishRepair(alert.id, "failed", "late owner", 2_101)).toThrow(
      "Guardian repair claim is not owned by this store",
    );
    expect(owner.getAlert(alert.id)).toEqual(expect.objectContaining({ state: "checking" }));
    expect(owner.getAlert(alert.id)).not.toHaveProperty("detail");
    contender.finishRepair(alert.id, "restored", "new owner finished", 2_102);
    expect(owner.getAlert(alert.id)).toEqual(expect.objectContaining({
      state: "restored",
      detail: "new owner finished",
    }));
  });

  it("keeps observations monotonic and returns the caller's atomic competing write", () => {
    const first = openStore();
    const second = openStore();
    const changed = fingerprint({ itemCount: 3, lastItemType: "toolCall" });

    first.upsertObservation(snapshot(), fingerprint(), 1_000);
    const competing = second.upsertObservation(
      snapshot({ itemCount: 3, lastItemType: "toolCall" }),
      changed,
      2_000,
    );

    expect(competing).toEqual({
      fingerprint: changed,
      firstObservedAt: 2_000,
      lastObservedAt: 2_000,
      unchangedCount: 1,
    });
    expect(() => first.upsertObservation(snapshot(), fingerprint(), 1_999)).toThrow(
      "Observation time cannot move backwards",
    );
    expect(second.upsertObservation(
      snapshot({ itemCount: 3, lastItemType: "toolCall" }),
      changed,
      2_001,
    ).unchangedCount).toBe(2);
  });

  it("persists terminal alert and repair outcomes and lists only open alerts", () => {
    const store = openStore();
    const restored = store.createAlert(fingerprint(), route, 61_000);
    const expired = store.createAlert(
      fingerprint({ turnId: OTHER_TURN_ID }),
      route,
      62_000,
    );

    expect(store.claimRepair(restored.id, 63_000)).toBe(true);
    store.markAlert(restored.id, "checking", "fresh fingerprint confirmed");
    store.finishRepair(restored.id, "restored", "cold reload verified", 64_000);
    store.markAlert(expired.id, "expired", "turn is no longer active");

    expect(store.getAlert(restored.id)).toEqual(expect.objectContaining({
      state: "restored",
      detail: "cold reload verified",
    }));
    expect(store.getAlert(expired.id)).toEqual(expect.objectContaining({
      state: "expired",
      detail: "turn is no longer active",
    }));
    expect(store.listOpenAlerts()).toEqual([]);

    store.close();
    const reopened = openStore();
    expect(reopened.getAlert(restored.id)?.state).toBe("restored");
    expect(reopened.claimRepair(restored.id, 65_000)).toBe(false);
  });

  it("handles malformed and unknown alert IDs deterministically", () => {
    const store = openStore();
    const unknown = "not-an-alert' OR 1=1 --";

    expect(store.getAlert(unknown)).toBeUndefined();
    expect(store.claimRepair(unknown, 1_000)).toBe(false);
    expect(() => store.markAlert(unknown, "failed", "ignored")).toThrow(
      "Unknown guardian alert",
    );
    expect(() => store.finishRepair(unknown, "failed", "ignored", 2_000)).toThrow(
      "Unknown guardian repair attempt",
    );
    expect(store.listOpenAlerts()).toEqual([]);
  });

  it("rejects invalid states, invalid outcomes, backward finishes, and terminal rewrites", () => {
    const store = openStore();
    const alert = store.createAlert(fingerprint(), route, 1_000);

    expect(() => store.markAlert(
      alert.id,
      "invalid" as never,
      "must not persist",
    )).toThrow("Invalid guardian alert state");
    expect(store.claimRepair(alert.id, 2_000)).toBe(true);
    expect(() => store.finishRepair(
      alert.id,
      "invalid" as never,
      "must not persist",
      2_001,
    )).toThrow("Invalid guardian repair outcome");
    expect(() => store.finishRepair(alert.id, "restored", "too early", 1_999)).toThrow(
      "Repair finish time cannot precede its claim",
    );
    store.finishRepair(alert.id, "restored", "verified", 2_001);
    expect(() => store.markAlert(alert.id, "failed", "late rewrite")).toThrow(
      "Invalid guardian alert transition: restored -> failed",
    );
    expect(store.getAlert(alert.id)?.state).toBe("restored");
  });

  it("forgets a local claim after learning that its alert became terminal", () => {
    const owner = openStore();
    const alert = owner.createAlert(fingerprint(), route, 1_000);
    expect(owner.claimRepair(alert.id, 2_000)).toBe(true);
    const other = openStore();
    other.markAlert(alert.id, "expired", "thread ended elsewhere");
    expect(() => owner.finishRepair(alert.id, "restored", "too late", 2_001)).toThrow(
      "Guardian alert is no longer repairable",
    );
    expect(() => owner.finishRepair(alert.id, "restored", "still too late", 2_002)).toThrow(
      "Unknown guardian repair attempt",
    );
  });

  it("enforces timestamp, state, and repair consistency constraints in SQLite", () => {
    const store = openStore();
    store.upsertObservation(snapshot(), fingerprint(), 1_000);
    const alert = store.createAlert(fingerprint(), route, 1_000);
    expect(store.claimRepair(alert.id, 2_000)).toBe(true);

    const db = new Database(databasePath);
    try {
      expect(() => db.prepare(
        "UPDATE observations SET last_observed_at = -1 WHERE thread_id = ?",
      ).run(THREAD_ID)).toThrow();
      expect(() => db.prepare(
        "UPDATE alerts SET state = 'invalid' WHERE id = ?",
      ).run(alert.id)).toThrow();
      expect(() => db.prepare(`
        UPDATE repair_attempts
        SET outcome = 'restored', finished_at = NULL
        WHERE alert_id = ?
      `).run(alert.id)).toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects corrupt decoded rows even if SQLite checks were bypassed", () => {
    const store = openStore();
    const alert = store.createAlert(fingerprint(), route, 1_000);
    const db = new Database(databasePath);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare("UPDATE alerts SET state = 'corrupt' WHERE id = ?").run(alert.id);
    } finally {
      db.close();
    }
    expect(() => store.listOpenAlerts()).toThrow("Invalid guardian alert row: state");
    expect(() => store.getAlert(alert.id)).toThrow("Invalid guardian alert row: state");
  });

  it("rejects partial unversioned and unsupported guardian schemas", () => {
    const partial = new Database(databasePath);
    partial.exec("CREATE TABLE observations (thread_id TEXT PRIMARY KEY)");
    partial.close();

    expect(() => {
      const store = new SessionGuardianStore(databasePath);
      store.close();
    }).toThrow("Malformed guardian schema: unversioned database is not empty");

    rmSync(databasePath, { force: true });
    const unsupported = new Database(databasePath);
    unsupported.pragma("user_version = 3");
    unsupported.close();

    expect(() => {
      const store = new SessionGuardianStore(databasePath);
      store.close();
    }).toThrow("Unsupported guardian schema version: 3");
  });

  it("rejects a versioned schema whose columns or constraints do not match", () => {
    const malformed = new Database(databasePath);
    malformed.exec(`
      CREATE TABLE observations (thread_id TEXT PRIMARY KEY);
      CREATE TABLE alerts (id TEXT PRIMARY KEY);
      CREATE TABLE repair_attempts (alert_id TEXT PRIMARY KEY);
      PRAGMA user_version = 1;
    `);
    malformed.close();

    expect(() => {
      const store = new SessionGuardianStore(databasePath);
      store.close();
    }).toThrow("Malformed guardian schema: observations definition does not match version 1");
  });

  it("closes after constructor hardening failure and treats post-write hardening as best effort", () => {
    const closeSpy = vi.spyOn(Database.prototype, "close");
    expect(() => new SessionGuardianStore(databasePath, {
      hardenFile: () => {
        throw new Error("chmod denied");
      },
    })).toThrow("chmod denied");
    expect(closeSpy).toHaveBeenCalledTimes(1);

    let hardeningFails = false;
    const store = openStore({
      hardenFile: (filePath) => {
        if (hardeningFails) throw new Error("chmod denied after write");
        chmodSync(filePath, 0o600);
      },
    });
    hardeningFails = true;

    expect(store.upsertObservation(snapshot(), fingerprint(), 1_000)).toEqual(
      expect.objectContaining({ unchangedCount: 1 }),
    );
    expect(() => store.close()).not.toThrow();
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(() => store.listOpenAlerts()).toThrow("SessionGuardianStore is closed");
  });

  it("never stores conversation content and returns only immutable domain records", () => {
    const store = openStore();
    const secret = "SENSITIVE-CONVERSATION-CONTENT-4a4a9b";
    const unsafeSnapshot = {
      ...snapshot(),
      prompt: secret,
      response: secret,
      toolOutput: secret,
    } as GuardianThreadSnapshot;

    const observation = store.upsertObservation(unsafeSnapshot, fingerprint(), 1_000);
    const alert = store.createAlert(fingerprint(), route, 2_000);
    expect(observation).not.toHaveProperty("prompt");
    expect(observation).not.toHaveProperty("response");
    expect(alert).not.toHaveProperty("toolOutput");

    const db = new Database(databasePath);
    try {
      const columns = ["observations", "alerts", "repair_attempts"].flatMap((table) =>
        db.pragma(`table_info(${table})`) as Array<{ name: string }>,
      );
      expect(columns.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(["prompt", "response", "tool_output", "content"]),
      );
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }

    const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter(existsSync);
    expect(databaseFiles.every((filePath) => !readFileSync(filePath).includes(secret))).toBe(true);
  });

  it("makes close idempotent and terminal", () => {
    const store = openStore();
    store.close();
    store.close();

    expect(() => store.getAlert("anything")).toThrow("SessionGuardianStore is closed");
    expect(() => store.clearObservation(THREAD_ID)).toThrow("SessionGuardianStore is closed");
    expect(() => store.inspectThreadObservation(THREAD_ID))
      .toThrow("SessionGuardianStore is closed");
    expect(() => store.listOpenAlerts()).toThrow("SessionGuardianStore is closed");
  });
});
