import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionGuardianRecovery } from "../src/session-guardian-recovery.js";
import { SessionGuardianStore } from "../src/session-guardian-store.js";
import { fingerprintOf, type GuardianThreadSnapshot } from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-030303030303";
const OTHER_TURN_ID = "019ff4ea-8c36-7c5f-8f08-040404040404";
const ROUTE = { chatId: -1_001_234_567_890, messageThreadId: 42 };

function snapshot(overrides: Partial<GuardianThreadSnapshot> = {}): GuardianThreadSnapshot {
  return {
    threadId: THREAD_ID, turnId: TURN_ID, threadStatus: "active", turnStatus: "inProgress",
    updatedAt: 1_723_000_000, itemCount: 2, lastItemType: "agentMessage", source: "cli",
    cwd: "/srv/projects/telecodex", name: "Guardian safety", canAcceptDirectInput: false,
    root: true, ...overrides,
  };
}

function idle(overrides: Partial<GuardianThreadSnapshot> = {}): GuardianThreadSnapshot {
  return snapshot({
    threadStatus: "idle", turnStatus: "interrupted", canAcceptDirectInput: true, ...overrides,
  });
}

function fakeAppServer() {
  return {
    readThread: vi.fn(async () => snapshot()),
    interrupt: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => idle()),
    coldReload: vi.fn(async () => idle()),
  };
}

describe("SessionGuardianRecovery safety", () => {
  let directory: string;
  let store: SessionGuardianStore;
  let now: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-recovery-safety-"));
    store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    now = 10_000;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createAlert() {
    const fingerprint = fingerprintOf(snapshot());
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

  it("retries pending restored finalization without repeating app-server mutation", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    const realFinish = store.finishRepair.bind(store);
    let failures = 2;
    const finish = vi.spyOn(store, "finishRepair").mockImplementation((...args) => {
      if (failures-- > 0) throw new Error("transient sqlite failure");
      realFinish(...args);
    });
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true }))
      .rejects.toThrow("Guardian repair finalization failed");
    expect(store.getAlert(alert.id)?.state).toBe("checking");
    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "restored", threadId: THREAD_ID, detail: "Thread restored",
    });
    expect(finish).toHaveBeenCalledTimes(3);
    expect(appServer.interrupt).toHaveBeenCalledOnce();
    expect(appServer.coldReload).toHaveBeenCalledOnce();
    expect(store.getAlert(alert.id)?.state).toBe("restored");
  });

  it("keeps a permanently failed finalization retryable and non-mutating", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    const finish = vi.spyOn(store, "finishRepair").mockImplementation(() => {
      throw new Error("persistent sqlite failure");
    });
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).rejects.toThrow(
      "Guardian repair finalization failed",
    );
    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).rejects.toThrow(
      "Guardian repair finalization failed",
    );
    expect(finish).toHaveBeenCalledTimes(4);
    expect(appServer.interrupt).toHaveBeenCalledOnce();
    expect(appServer.coldReload).toHaveBeenCalledOnce();
    expect(store.getAlert(alert.id)?.state).toBe("checking");
  });

  it.each([
    ["different turn", idle({ turnId: OTHER_TURN_ID })],
    ["subagent", idle({ root: false })],
    ["item regression", idle({ itemCount: 1 })],
  ])("does not cold reload after an idle snapshot reports %s", async (_case, idleSnapshot) => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.waitForIdle.mockResolvedValue(idleSnapshot);
    const { recovery } = subject(appServer);

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true })).resolves.toEqual({
      outcome: "failed", threadId: THREAD_ID, detail: "Wait for idle failed",
    });
    expect(appServer.coldReload).not.toHaveBeenCalled();
    expect(store.getAlert(alert.id)?.state).toBe("failed");
  });

  it("queues disabled then enabled intent without sharing either result", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    let releaseRead!: () => void;
    appServer.readThread.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRead = () => resolve(snapshot());
    }));
    const { recovery } = subject(appServer);

    const disabled = recovery.recoverAlert(alert.id, { repairEnabled: false });
    await vi.waitFor(() => expect(appServer.readThread).toHaveBeenCalledOnce());
    const enabled = recovery.recoverAlert(alert.id, { repairEnabled: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(appServer.interrupt).not.toHaveBeenCalled();
    releaseRead();
    await expect(disabled).resolves.toMatchObject({ outcome: "repair-disabled" });
    await expect(enabled).resolves.toMatchObject({ outcome: "restored" });
    expect(appServer.interrupt).toHaveBeenCalledOnce();
  });

  it("queues a disabled request behind enabled work and reloads terminal state", async () => {
    const alert = createAlert();
    const appServer = fakeAppServer();
    let releaseInterrupt!: () => void;
    appServer.interrupt.mockImplementation(() => new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    }));
    const { recovery } = subject(appServer);

    const enabled = recovery.recoverAlert(alert.id, { repairEnabled: true });
    await vi.waitFor(() => expect(appServer.interrupt).toHaveBeenCalledOnce());
    const disabled = recovery.recoverAlert(alert.id, { repairEnabled: false });
    let disabledSettled = false;
    void disabled.finally(() => { disabledSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disabledSettled).toBe(false);
    releaseInterrupt();
    await expect(enabled).resolves.toMatchObject({ outcome: "restored" });
    await expect(disabled).resolves.toMatchObject({ outcome: "restored" });
  });

  it("queues manual and alert recovery on one thread and performs one durable repair", async () => {
    const appServer = fakeAppServer();
    let alertId: string | undefined;
    let reads = 0;
    appServer.readThread.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) alertId = createAlert().id;
      return snapshot();
    });
    let releaseInterrupt!: () => void;
    appServer.interrupt.mockImplementation(() => new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    }));
    const { recovery } = subject(appServer);

    const manual = recovery.repairThread(THREAD_ID, { repairEnabled: true });
    await vi.waitFor(() => expect(alertId).toBeDefined());
    await vi.waitFor(() => expect(appServer.interrupt).toHaveBeenCalledOnce());
    const fromAlert = recovery.recoverAlert(alertId!, { repairEnabled: true });
    releaseInterrupt();

    await expect(manual).resolves.toMatchObject({ outcome: "restored" });
    await expect(fromAlert).resolves.toMatchObject({ outcome: "restored" });
    expect(appServer.interrupt).toHaveBeenCalledOnce();
    expect(appServer.coldReload).toHaveBeenCalledOnce();
    expect(store.getAlert(alertId!)?.state).toBe("restored");
  });

  it("cannot overwrite a restored alert from a delayed cross-process read-only check", async () => {
    const alert = createAlert();
    const observerStore = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const observerApp = fakeAppServer();
    let releaseRead!: () => void;
    observerApp.readThread.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRead = () => resolve(idle());
    }));
    const observer = new SessionGuardianRecovery(observerApp, observerStore);
    const mutatorApp = fakeAppServer();
    let releaseInterrupt!: () => void;
    mutatorApp.interrupt.mockImplementation(() => new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    }));
    const mutator = new SessionGuardianRecovery(mutatorApp, store);

    const delayed = observer.recoverAlert(alert.id, { repairEnabled: false });
    await vi.waitFor(() => expect(observerApp.readThread).toHaveBeenCalledOnce());
    const mutation = mutator.recoverAlert(alert.id, { repairEnabled: true });
    await vi.waitFor(() => expect(mutatorApp.interrupt).toHaveBeenCalledOnce());
    expect(store.getAlert(alert.id)?.state).toBe("checking");
    releaseRead();
    await expect(delayed).resolves.toMatchObject({ outcome: "failed" });
    releaseInterrupt();
    await expect(mutation).resolves.toMatchObject({ outcome: "restored" });
    expect(store.getAlert(alert.id)?.state).toBe("restored");
    expect(mutatorApp.interrupt).toHaveBeenCalledOnce();
    expect(mutatorApp.coldReload).toHaveBeenCalledOnce();
    observerStore.close();
  });

  it("sanitizes initial and claimed store failures", async () => {
    const alert = createAlert();
    const { recovery } = subject();
    vi.spyOn(store, "getAlert").mockImplementationOnce(() => {
      throw new Error("secret sqlite path initial");
    });
    const initial = recovery.recoverAlert(alert.id, { repairEnabled: true });
    await expect(initial).rejects.toThrow(
      "Guardian recovery state unavailable",
    );
    await expect(initial).rejects.not.toThrow("secret sqlite path initial");

    vi.restoreAllMocks();
    vi.spyOn(store, "claimRepair").mockImplementationOnce(() => {
      throw new Error("secret sqlite claim");
    });
    const claimed = subject().recovery.recoverAlert(alert.id, { repairEnabled: true });
    await expect(claimed).rejects.toThrow(
      "Guardian recovery state unavailable",
    );
    await expect(claimed).rejects.not.toThrow("secret sqlite claim");
  });

  it("sanitizes manual alert lookup and self-recovery closure failures", async () => {
    vi.spyOn(store, "listOpenAlerts").mockImplementationOnce(() => {
      throw new Error("secret sqlite list");
    });
    const listed = subject().recovery.repairThread(THREAD_ID, { repairEnabled: true });
    await expect(listed).rejects.toThrow(
      "Guardian recovery state unavailable",
    );
    await expect(listed).rejects.not.toThrow("secret sqlite list");

    vi.restoreAllMocks();
    const alert = createAlert();
    const appServer = fakeAppServer();
    appServer.readThread.mockResolvedValue(idle());
    vi.spyOn(store, "markOpenAlertSelfRecovered").mockImplementationOnce(() => {
      throw new Error("secret sqlite close");
    });
    const closed = subject(appServer).recovery.recoverAlert(alert.id, { repairEnabled: false });
    await expect(closed).rejects.toThrow("Guardian recovery state unavailable");
    await expect(closed).rejects.not.toThrow("secret sqlite close");
  });

  it("sanitizes store failure during pending finalization reconciliation", async () => {
    const alert = createAlert();
    const realGet = store.getAlert.bind(store);
    let gets = 0;
    vi.spyOn(store, "finishRepair").mockImplementation(() => {
      throw new Error("secret sqlite finish");
    });
    vi.spyOn(store, "getAlert").mockImplementation((alertId) => {
      gets += 1;
      if (gets > 2) throw new Error("secret sqlite reconcile");
      return realGet(alertId);
    });

    const call = subject().recovery.recoverAlert(alert.id, { repairEnabled: true });
    await expect(call).rejects.toThrow("Guardian repair finalization failed");
    await expect(call).rejects.not.toThrow("secret sqlite reconcile");
  });
});
