import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

describe("SessionGuardianStore alert creation", () => {
  let directory: string;
  let stores: SessionGuardianStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-alert-"));
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function openStore(): SessionGuardianStore {
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    stores.push(store);
    return store;
  }

  it("atomically reports one winner across independent store instances", () => {
    const firstStore = openStore();
    const secondStore = openStore();

    const first = firstStore.createAlertIfAbsent(FINGERPRINT, ROUTE, 61_000);
    const second = secondStore.createAlertIfAbsent(FINGERPRINT, ROUTE, 62_000);

    expect(first.created).toBe(true);
    expect(second).toEqual({ alert: first.alert, created: false });
    expect(firstStore.createAlert(FINGERPRINT, ROUTE, 63_000)).toEqual(first.alert);
  });

  it("atomically closes only an open alert as self-recovered", () => {
    const store = openStore();
    const alert = store.createAlert(FINGERPRINT, ROUTE, 61_000);

    expect(store.markOpenAlertSelfRecovered(alert.id, "fresh check progressed")).toEqual({
      closed: true,
      alert: expect.objectContaining({ id: alert.id, state: "self-recovered" }),
    });
  });

  it("never overwrites a checking alert owned by a repair", () => {
    const owner = openStore();
    const observer = openStore();
    const alert = owner.createAlert(FINGERPRINT, ROUTE, 61_000);
    expect(owner.claimRepair(alert.id, 62_000)).toBe(true);

    expect(observer.markOpenAlertSelfRecovered(alert.id, "delayed read became idle")).toEqual({
      closed: false,
      alert: expect.objectContaining({ id: alert.id, state: "checking" }),
    });
    owner.finishRepair(alert.id, "restored", "verified", 63_000);
    expect(observer.getAlert(alert.id)?.state).toBe("restored");
  });
});
