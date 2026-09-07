import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionGuardianRecovery } from "../src/session-guardian-recovery.js";
import { SessionGuardianStore } from "../src/session-guardian-store.js";
import { fingerprintOf, type GuardianThreadSnapshot } from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const OTHER_TURN_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-030303030303";
const UNKNOWN_ALERT_ID = "abcdefghijklmnopqrstuv";
const ROUTE = { chatId: -1_001_234_567_890, messageThreadId: 42 };

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
    name: "Guardian recovery",
    canAcceptDirectInput: false,
    root: true,
    ...overrides,
  };
}

function idleSnapshot(
  overrides: Partial<GuardianThreadSnapshot> = {},
): GuardianThreadSnapshot {
  return snapshot({
    threadStatus: "idle",
    turnStatus: "interrupted",
    canAcceptDirectInput: true,
    ...overrides,
  });
}

function fakeAppServer() {
  return {
    readThread: vi.fn(async () => snapshot()),
    interrupt: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => idleSnapshot()),
    coldReload: vi.fn(async () => idleSnapshot()),
  };
}

describe("SessionGuardianRecovery", () => {
  let directory: string;
  let store: SessionGuardianStore;
  let now: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-recovery-"));
    store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    now = 10_000;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createAlert(value = snapshot()) {
    const fingerprint = fingerprintOf(value);
    if (!fingerprint) throw new Error("test snapshot must be active");
    return store.createAlert(fingerprint, ROUTE, 1_000);
  }

  function subject(appServer = fakeAppServer()) {
    return {
      appServer,
      recovery: new SessionGuardianRecovery(appServer, store, {
        idleTimeoutMs: 5_000,
        clock: () => now++,
      }),
    };
  }

  function observationOnlySubject(appServer = fakeAppServer()) {
    return {
      appServer,
      recovery: new SessionGuardianRecovery(appServer, store, {
        idleTimeoutMs: 5_000,
        clock: () => now++,
        observationOnly: true,
      }),
    };
  }

  it("rejects malformed alert IDs and returns expired for an unknown alert without RPCs", async () => {
    const { recovery, appServer } = subject();

    await expect(recovery.recoverAlert("not-an-alert", { repairEnabled: true }))
      .rejects.toThrow("alertId must be a guardian alert ID");
    await expect(recovery.recoverAlert(UNKNOWN_ALERT_ID, { repairEnabled: true })).resolves.toEqual({
      outcome: "expired",
      detail: "Alert not found",
    });
    expect(appServer.readThread).not.toHaveBeenCalled();
    expect(appServer.interrupt).not.toHaveBeenCalled();
  });

  it("returns a closed alert outcome without reading or mutating app-server state", async () => {
    const alert = createAlert();
    store.markAlert(alert.id, "self-recovered", "already idle");
    const { recovery, appServer } = subject();

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "self-recovered",
      threadId: THREAD_ID,
      detail: "Alert already closed",
    });
    expect(appServer.readThread).not.toHaveBeenCalled();
    expect(appServer.interrupt).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", idleSnapshot()],
    ["turn", snapshot({ turnId: OTHER_TURN_ID })],
    ["updatedAt", snapshot({ updatedAt: 1_723_000_001 })],
    ["itemCount", snapshot({ itemCount: 3 })],
    ["lastItemType", snapshot({ lastItemType: "toolCall" })],
  ])("marks %s progress as self-recovered using the full fingerprint", async (_field, live) => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.readThread.mockResolvedValue(live);
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "self-recovered",
      threadId: THREAD_ID,
      detail: "Thread progressed or became idle",
    });
    expect(store.getAlert(alert.id)?.state).toBe("self-recovered");
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(appServer.coldReload).not.toHaveBeenCalled();
  });

  it("rechecks but leaves a still-stuck alert open when repair is disabled", async () => {
    const alert = createAlert();
    const claim = vi.spyOn(store, "claimRepair");
    const { recovery, appServer } = subject();

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: false })).resolves.toEqual({
      outcome: "repair-disabled",
      threadId: THREAD_ID,
      detail: "Repair is disabled",
    });
    expect(appServer.readThread).toHaveBeenCalledWith(THREAD_ID);
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(appServer.coldReload).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(store.getAlert(alert.id)?.state).toBe("open");
  });

  it.each([true, false])("keeps a stuck open alert observation-only when repairEnabled is %s",
    async (repairEnabled) => {
      const alert = createAlert();
      const claim = vi.spyOn(store, "claimRepair");
      const { recovery, appServer } = observationOnlySubject();
      await expect(recovery.recoverAlert(alert.id, { repairEnabled })).resolves.toEqual({
        outcome: "observation-only",
        threadId: THREAD_ID,
        detail: "Observation-only mode",
      });
      expect(appServer.readThread).toHaveBeenCalledWith(THREAD_ID);
      expect(claim).not.toHaveBeenCalled();
      expect(appServer.interrupt).not.toHaveBeenCalled();
      expect(appServer.waitForIdle).not.toHaveBeenCalled();
      expect(appServer.coldReload).not.toHaveBeenCalled();
      expect(store.getAlert(alert.id)?.state).toBe("open");
    });

  it("fresh-checks but does not claim a checking alert in observation-only mode", async () => {
    const alert = createAlert();
    const owner = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    expect(owner.claimRepair(alert.id, now)).toBe(true);
    const claim = vi.spyOn(store, "claimRepair");
    const { recovery, appServer } = observationOnlySubject();
    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "observation-only",
      threadId: THREAD_ID,
      detail: "Observation-only mode",
    });
    expect(appServer.readThread).toHaveBeenCalledWith(THREAD_ID);
    expect(claim).not.toHaveBeenCalled();
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(store.getAlert(alert.id)?.state).toBe("checking");
    owner.close();
  });

  it("still closes an open progressed alert as self-recovered in observation-only mode", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.readThread.mockResolvedValue(idleSnapshot());
    const { recovery } = observationOnlySubject(appServer);
    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toMatchObject({
      outcome: "self-recovered",
      threadId: THREAD_ID,
    });
    expect(store.getAlert(alert.id)?.state).toBe("self-recovered");
    expect(appServer.interrupt).not.toHaveBeenCalled();
  });

  it("claims before exact interrupt, waits for idle, cold reloads, and verifies history", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    const events: string[] = [];
    const originalClaim = store.claimRepair.bind(store);
    vi.spyOn(store, "claimRepair").mockImplementation((...args) => {
      events.push("claim");
      return originalClaim(...args);
    });
    appServer.interrupt.mockImplementation(async () => { events.push("interrupt"); });
    appServer.waitForIdle.mockImplementation(async () => {
      events.push("waitForIdle");
      return idleSnapshot();
    });
    appServer.coldReload.mockImplementation(async () => {
      events.push("coldReload");
      return idleSnapshot({ itemCount: 3 });
    });
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "restored",
      threadId: THREAD_ID,
      detail: "Thread restored",
    });
    expect(events).toEqual(["claim", "interrupt", "waitForIdle", "coldReload"]);
    expect(appServer.interrupt).toHaveBeenCalledWith(THREAD_ID, TURN_ID);
    expect(appServer.waitForIdle).toHaveBeenCalledWith(THREAD_ID, 5_000);
    expect(appServer.coldReload).toHaveBeenCalledWith(THREAD_ID);
    expect(store.getAlert(alert.id)?.state).toBe("restored");
  });

  it("rechecks the full fingerprint after claiming and does not interrupt a progressed turn", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.readThread
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ itemCount: 3, lastItemType: "toolCall" }));
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "self-recovered",
      threadId: THREAD_ID,
      detail: "Thread progressed or became idle",
    });
    expect(appServer.readThread).toHaveBeenCalledTimes(2);
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(store.getAlert(alert.id)?.state).toBe("self-recovered");
  });

  it("does not close a checking alert owned by another store when live state changes", async () => {
    const alert = createAlert();
    const owner = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    expect(owner.claimRepair(alert.id, now)).toBe(true);
    const appServer = fakeAppServer();
    appServer.readThread.mockResolvedValue(idleSnapshot());
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "failed",
      threadId: THREAD_ID,
      detail: "Repair already in progress",
    });
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(store.getAlert(alert.id)?.state).toBe("checking");
    owner.close();
  });

  it.each([
    ["not idle", idleSnapshot({ threadStatus: "active" })],
    ["not input-ready", idleSnapshot({ canAcceptDirectInput: false })],
    ["still in-progress", idleSnapshot({ turnStatus: "inProgress" })],
    ["different thread", idleSnapshot({ threadId: "019ff4ea-8c36-7c5f-8f08-040404040404" })],
    ["different turn", idleSnapshot({ turnId: OTHER_TURN_ID })],
    ["lost items", idleSnapshot({ itemCount: 1 })],
  ])("fails final verification when the reloaded snapshot is %s", async (_case, finalSnapshot) => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.coldReload.mockResolvedValue(finalSnapshot);
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "failed",
      threadId: THREAD_ID,
      detail: "Final verification failed",
    });
    expect(store.getAlert(alert.id)?.state).toBe("failed");
  });

  it.each([
    ["interrupt", "interrupt"],
    ["wait", "waitForIdle"],
  ] as const)("does not cold reload after %s failure", async (_case, failingMethod) => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer[failingMethod].mockRejectedValue(new Error("unsafe upstream detail"));
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "failed",
      threadId: THREAD_ID,
      detail: failingMethod === "interrupt" ? "Interrupt failed" : "Wait for idle failed",
    });
    expect(appServer.coldReload).not.toHaveBeenCalled();
    expect(store.getAlert(alert.id)?.state).toBe("failed");
  });

  it("does not cold reload when waitForIdle returns a non-idle snapshot", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.waitForIdle.mockResolvedValue(snapshot());
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toMatchObject({
      outcome: "failed",
      detail: "Wait for idle failed",
    });
    expect(appServer.coldReload).not.toHaveBeenCalled();
  });

  it("records a cold reload failure without claiming restoration", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.coldReload.mockRejectedValue(new Error("resume failed after compensated archive"));
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "failed",
      threadId: THREAD_ID,
      detail: "Cold reload failed",
    });
    expect(appServer.coldReload).toHaveBeenCalledWith(THREAD_ID);
    expect(store.getAlert(alert.id)?.state).toBe("failed");
  });

  it("shares concurrent and repeated recovery requests through one claim and interrupt", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    let releaseInterrupt!: () => void;
    appServer.interrupt.mockImplementation(() => new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    }));
    const claim = vi.spyOn(store, "claimRepair");
    const { recovery } = subject(appServer);

    const first = recovery.recoverAlert(alert.id, { repairEnabled: true });
    const second = recovery.recoverAlert(alert.id, { repairEnabled: true });
    await vi.waitFor(() => expect(appServer.interrupt).toHaveBeenCalledOnce());
    releaseInterrupt();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: "restored" }),
      expect.objectContaining({ outcome: "restored" }),
    ]);
    expect(claim).toHaveBeenCalledOnce();
    expect(appServer.interrupt).toHaveBeenCalledOnce();
    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toMatchObject({
      outcome: "restored",
    });
    expect(appServer.interrupt).toHaveBeenCalledOnce();
  });

  it("finalizes a claimed attempt exactly once when an app-server mutation throws", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.interrupt.mockRejectedValue(new Error("untrusted conversation text"));
    const finish = vi.spyOn(store, "finishRepair");
    const { recovery } = subject(appServer);

    const result = await recovery.recoverAlert(alert.id, { repairEnabled: true });

    expect(result.detail).toBe("Interrupt failed");
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(alert.id, "failed", "Interrupt failed", expect.any(Number));
  });

  it("validates manual UUIDs and reads only the exact requested thread", async () => {
    const { recovery, appServer } = subject();

    await expect(recovery.repairThread("latest", { repairEnabled: true }))
      .rejects.toThrow("threadId must be a UUID");
    appServer.readThread.mockResolvedValue(idleSnapshot());
    await expect(recovery.repairThread(THREAD_ID, { repairEnabled: true })).resolves.toEqual({
      outcome: "self-recovered",
      threadId: THREAD_ID,
      detail: "Thread is not actively stuck",
    });
    expect(appServer.readThread).toHaveBeenCalledTimes(1);
    expect(appServer.readThread).toHaveBeenCalledWith(THREAD_ID);
    expect(appServer.interrupt).not.toHaveBeenCalled();
  });

  it("uses the same exact guarded path for a manual repair without creating an alert", async () => {
    const { recovery, appServer } = subject();

    await expect(recovery.repairThread(THREAD_ID, { repairEnabled: true })).resolves.toEqual({
      outcome: "restored",
      threadId: THREAD_ID,
      detail: "Thread restored",
    });
    expect(appServer.interrupt).toHaveBeenCalledWith(THREAD_ID, TURN_ID);
    expect(appServer.waitForIdle).toHaveBeenCalledWith(THREAD_ID, 5_000);
    expect(appServer.coldReload).toHaveBeenCalledWith(THREAD_ID);
    expect(store.listOpenAlerts()).toEqual([]);
  });

  it.each([true, false])("keeps a manual active thread observation-only when repairEnabled is %s",
    async (repairEnabled) => {
      const { recovery, appServer } = observationOnlySubject();
      await expect(recovery.repairThread(THREAD_ID, { repairEnabled })).resolves.toEqual({
        outcome: "observation-only",
        threadId: THREAD_ID,
        detail: "Observation-only mode",
      });
      expect(appServer.readThread).toHaveBeenCalledWith(THREAD_ID);
      expect(appServer.interrupt).not.toHaveBeenCalled();
      expect(appServer.waitForIdle).not.toHaveBeenCalled();
      expect(appServer.coldReload).not.toHaveBeenCalled();
    });

  it("rejects a subagent manual target before mutation", async () => {
    const appServer = fakeAppServer();
    appServer.readThread.mockResolvedValue(snapshot({ root: false }));
    const { recovery } = subject(appServer);
    await expect(recovery.repairThread(THREAD_ID, { repairEnabled: true })).resolves.toEqual({
      outcome: "self-recovered",
      threadId: THREAD_ID,
      detail: "Thread is not eligible",
    });
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(appServer.coldReload).not.toHaveBeenCalled();
  });

  it("does not interrupt when a manual root becomes a subagent on the second read", async () => {
    const appServer = fakeAppServer();
    appServer.readThread
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ root: false }));
    const { recovery } = subject(appServer);
    await expect(recovery.repairThread(THREAD_ID, { repairEnabled: true })).resolves.toEqual({
      outcome: "self-recovered",
      threadId: THREAD_ID,
      detail: "Thread is not eligible",
    });
    expect(appServer.readThread).toHaveBeenCalledTimes(2);
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(appServer.coldReload).not.toHaveBeenCalled();
  });

  it("rechecks a manual repair target and does not interrupt if its fingerprint progressed", async () => {
    const appServer = fakeAppServer();
    appServer.readThread
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ updatedAt: 1_723_000_001 }));
    const { recovery } = subject(appServer);

    await expect(recovery.repairThread(THREAD_ID, { repairEnabled: true })).resolves.toEqual({
      outcome: "self-recovered",
      threadId: THREAD_ID,
      detail: "Thread progressed or became idle",
    });
    expect(appServer.readThread).toHaveBeenCalledTimes(2);
    expect(appServer.interrupt).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent manual repairs and never mutates when repair is disabled", async () => {
    const appServer = fakeAppServer();
    let releaseRead!: () => void;
    appServer.readThread.mockImplementation(() => new Promise<GuardianThreadSnapshot>((resolve) => {
      releaseRead = () => resolve(snapshot());
    }));
    const { recovery } = subject(appServer);
    const first = recovery.repairThread(THREAD_ID, { repairEnabled: false });
    const second = recovery.repairThread(THREAD_ID, { repairEnabled: false });
    await vi.waitFor(() => expect(appServer.readThread).toHaveBeenCalledOnce());
    releaseRead();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: "repair-disabled" }),
      expect.objectContaining({ outcome: "repair-disabled" }),
    ]);
    expect(appServer.interrupt).not.toHaveBeenCalled();
    expect(appServer.coldReload).not.toHaveBeenCalled();
  });
});
