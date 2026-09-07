import { describe, expect, it, vi } from "vitest";

import {
  SessionGuardianService,
  type GuardianServiceAppServer,
  type GuardianServiceRecovery,
  type GuardianSleep,
} from "../src/session-guardian-service.js";
import type { GuardianAlert, GuardianObservation } from "../src/session-guardian-store.js";
import type { GuardianThreadSnapshot } from "../src/session-guardian-types.js";

const THREAD_ID = "01a02451-2fc4-76c0-9f14-c75034c10017";
const TURN_ID = "01a02451-2fc4-76c0-9f14-c75034c10018";
const ALERT_ID = "abcdefghijklmnopqrstuv";

function snapshot(overrides: Partial<GuardianThreadSnapshot> = {}): GuardianThreadSnapshot {
  return {
    threadId: THREAD_ID, turnId: TURN_ID, threadStatus: "active", turnStatus: "inProgress",
    updatedAt: 100, itemCount: 2, lastItemType: "agentMessage", source: { custom: "telecodex" },
    cwd: "/secret/project", name: "private title", canAcceptDirectInput: false, root: true,
    ...overrides,
  };
}

function alert(overrides: Partial<GuardianAlert> = {}): GuardianAlert {
  return {
    id: ALERT_ID,
    fingerprint: { threadId: THREAD_ID, turnId: TURN_ID, updatedAt: 100,
      itemCount: 2, lastItemType: "agentMessage" },
    route: { chatId: -1_001_234_567_890, messageThreadId: 42 },
    state: "open", deliveryState: "pending", createdAt: 1_000,
    statusDeliveryState: "none",
    ...overrides,
  };
}

function observation(): GuardianObservation {
  return {
    fingerprint: alert().fingerprint,
    firstObservedAt: 1_000,
    lastObservedAt: 5_000,
    unchangedCount: 2,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(overrides: Record<string, unknown> = {}) {
  let alerts = [alert()];
  const appServer: GuardianServiceAppServer = {
    listRootThreads: vi.fn(async () => [snapshot()]),
    readThread: vi.fn(async () => snapshot()),
    close: vi.fn(),
  };
  const inspectionAppServer: GuardianServiceAppServer = {
    listRootThreads: vi.fn(async () => { throw new Error("inspection must not list threads"); }),
    readThread: vi.fn(async () => snapshot()),
    close: vi.fn(),
  };
  const detector = { scan: vi.fn(() => [{ kind: "alert", threadId: THREAD_ID,
    turnId: TURN_ID, alert: alerts[0] }]) };
  const store = {
    listObservationThreadIds: vi.fn(() => [THREAD_ID]),
    listOpenAlerts: vi.fn(() => alerts),
    listAlertsNeedingStatusDelivery: vi.fn(() => alerts.filter((entry) =>
      entry.statusDeliveryState === "pending" || entry.statusDeliveryState === "failed")),
    getAlert: vi.fn((id: string) => alerts.find((entry) => entry.id === id)),
    getObservation: vi.fn(() => observation()),
    inspectThreadObservation: vi.fn(() => undefined),
    recordDelivery: vi.fn((id: string, messageId: number) => {
      alerts = alerts.map((entry) => entry.id === id
        ? alert({ ...entry, deliveryState: "delivered", messageId }) : entry);
      return alerts.find((entry) => entry.id === id)!;
    }),
    markDeliveryFailed: vi.fn((id: string) => {
      alerts = alerts.map((entry) => entry.id === id
        ? alert({ ...entry, deliveryState: "failed", messageId: undefined }) : entry);
      return alerts.find((entry) => entry.id === id)!;
    }),
    markOpenAlertSelfRecovered: vi.fn((id: string) => {
      alerts = alerts.map((entry) => entry.id === id
        ? alert({ ...entry, state: "self-recovered",
          statusDeliveryState: entry.deliveryState === "delivered" ? "pending" : "none" }) : entry);
      return { alert: alerts.find((entry) => entry.id === id)!, closed: true };
    }),
    recordStatusDelivery: vi.fn((id: string) => {
      alerts = alerts.map((entry) => entry.id === id
        ? alert({ ...entry, statusDeliveryState: "delivered" }) : entry);
      return alerts.find((entry) => entry.id === id)!;
    }),
    markStatusDeliveryFailed: vi.fn((id: string) => {
      alerts = alerts.map((entry) => entry.id === id
        ? alert({ ...entry, statusDeliveryState: "failed" }) : entry);
      return alerts.find((entry) => entry.id === id)!;
    }),
  };
  const notifier = {
    sendAlert: vi.fn(async () => ({ alertId: ALERT_ID, chatId: alert().route.chatId,
      messageThreadId: 42, messageId: 77 })),
    editStatus: vi.fn(async () => undefined),
  };
  const recovery: GuardianServiceRecovery = {
    recoverAlert: vi.fn(async () => ({ outcome: "observation-only" as const,
      threadId: THREAD_ID, detail: "Observation-only mode" })),
    repairThread: vi.fn(async () => ({ outcome: "restored" as const,
      threadId: THREAD_ID, detail: "Thread restored" })),
  };
  const createRecovery = vi.fn((_gateway: GuardianServiceAppServer,
    _hooks: { onChecking: (alertId: string) => Promise<void> }) => recovery);
  const createAppServer = vi.fn(() => appServer);
  const createInspectionAppServer = vi.fn(() => inspectionAppServer);
  const service = new SessionGuardianService({
    createAppServer, createInspectionAppServer, createRecovery, detector, store, notifier,
    scanIntervalMs: 60_000, recentWindowMs: 86_400_000,
    observationOnly: true, repairEnabled: false,
    clock: () => 11_000,
    ...overrides,
  } as never);
  return { service, appServer, inspectionAppServer, detector, store, notifier, recovery,
    createRecovery, createAppServer, createInspectionAppServer, getAlerts: () => alerts,
    setAlerts: (value: GuardianAlert[]) => { alerts = value; } };
}

describe("SessionGuardianService", () => {
  it("scans all roots and durably records an exact pending alert delivery", async () => {
    const subject = fixture();

    await expect(subject.service.scan()).resolves.toEqual({
      scanned: 1, detectedAlerts: 1, deliveredAlerts: 1, failedDeliveries: 0,
    });
    expect(subject.detector.scan).toHaveBeenCalledWith([snapshot()], 11_000);
    expect(subject.notifier.sendAlert).toHaveBeenCalledWith({
      alert: alert(), snapshot: snapshot(), staleForMs: 10_000,
    });
    expect(subject.store.recordDelivery).toHaveBeenCalledWith(ALERT_ID, 77);
  });

  it("does not resend delivered alerts and retries failed delivery after restart", async () => {
    const delivered = fixture();
    delivered.setAlerts([alert({ deliveryState: "delivered", messageId: 77 })]);
    await delivered.service.scan();
    expect(delivered.notifier.sendAlert).not.toHaveBeenCalled();

    const failed = fixture();
    failed.setAlerts([alert({ deliveryState: "failed" })]);
    await failed.service.scan();
    expect(failed.notifier.sendAlert).toHaveBeenCalledOnce();
    expect(failed.store.recordDelivery).toHaveBeenCalledWith(ALERT_ID, 77);
  });

  it("marks a send or record failure and continues the successful app-server scan", async () => {
    const sendFailure = fixture();
    sendFailure.notifier.sendAlert.mockRejectedValueOnce(new Error("telegram token secret"));
    await expect(sendFailure.service.scan()).resolves.toMatchObject({ failedDeliveries: 1 });
    expect(sendFailure.store.markDeliveryFailed).toHaveBeenCalledWith(ALERT_ID);

    const recordFailure = fixture();
    recordFailure.store.recordDelivery.mockImplementationOnce(() => { throw new Error("disk path"); });
    await expect(recordFailure.service.scan()).resolves.toMatchObject({ failedDeliveries: 1 });
    expect(recordFailure.store.markDeliveryFailed).toHaveBeenCalledWith(ALERT_ID);
  });

  it("closes progressed open alerts and edits an already delivered alert in place", async () => {
    const subject = fixture();
    subject.setAlerts([alert({ deliveryState: "delivered", messageId: 77 })]);
    subject.appServer.listRootThreads = vi.fn(async () => [snapshot({ updatedAt: 101 })]);

    await subject.service.scan();

    expect(subject.store.markOpenAlertSelfRecovered).toHaveBeenCalledWith(
      ALERT_ID, "Thread progressed or became idle",
    );
    expect(subject.notifier.editStatus).toHaveBeenCalledWith(expect.objectContaining({
      delivery: { alertId: ALERT_ID, chatId: alert().route.chatId,
        messageThreadId: 42, messageId: 77 },
      status: "no-longer-eligible",
    }));
  });

  it("passes persisted tracking scope so an old open alert is not falsely self-recovered", async () => {
    const subject = fixture();
    subject.appServer.listRootThreads = vi.fn(async (scope?: {
      recentCutoffMs: number;
      trackedThreadIds: readonly string[];
    }) => scope?.trackedThreadIds.includes(THREAD_ID) ? [snapshot()] : []);

    await subject.service.scan();

    expect(subject.appServer.listRootThreads).toHaveBeenCalledWith({
      recentCutoffMs: 0,
      trackedThreadIds: [THREAD_ID],
    });
    expect(subject.store.markOpenAlertSelfRecovered).not.toHaveBeenCalled();
  });

  it("serializes concurrent scans and repair operations", async () => {
    const gate = deferred<GuardianThreadSnapshot[]>();
    let active = 0;
    let maximum = 0;
    const subject = fixture();
    subject.appServer.listRootThreads = vi.fn(async () => {
      active += 1; maximum = Math.max(maximum, active);
      const value = await gate.promise;
      active -= 1;
      return value;
    });
    subject.recovery.repairThread = vi.fn(async () => {
      active += 1; maximum = Math.max(maximum, active); active -= 1;
      return { outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" };
    });

    const first = subject.service.scan();
    const second = subject.service.scan();
    const repair = subject.service.repairThread(THREAD_ID);
    await vi.waitFor(() => expect(subject.appServer.listRootThreads).toHaveBeenCalledOnce());
    expect(subject.recovery.repairThread).not.toHaveBeenCalled();
    gate.resolve([snapshot()]);
    await Promise.all([first, second, repair]);
    expect(maximum).toBe(1);
    expect(subject.appServer.listRootThreads).toHaveBeenCalledTimes(2);
  });

  it("reports the active scan phase, serialized queue depth, and clears them after failure", async () => {
    const gate = deferred<GuardianThreadSnapshot[]>();
    const subject = fixture({ clock: () => 123 });
    subject.appServer.listRootThreads = vi.fn(() => gate.promise);

    const active = subject.service.scan();
    await vi.waitFor(() => expect(subject.appServer.listRootThreads).toHaveBeenCalledOnce());
    const queued = subject.service.scan();

    expect(subject.service.status()).toMatchObject({
      activeOperation: "scan",
      activeSince: 123,
      queueDepth: 1,
      scanPhase: "app-read",
      inspectionCount: 0,
    });

    gate.reject(new Error("scan failed"));
    await expect(active).rejects.toThrow("scan failed");
    await expect(queued).rejects.toThrow("scan failed");
    expect(subject.service.status()).toMatchObject({
      activeOperation: "idle",
      queueDepth: 0,
      scanPhase: "idle",
      inspectionCount: 0,
    });
    expect(subject.service.status()).not.toHaveProperty("activeSince");
  });

  it("waits for an active scan read before starting exact inspection without closing primary", async () => {
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    const first = {
      listRootThreads: vi.fn(() => scanGate.promise),
      readThread: vi.fn(),
      close: vi.fn(() => scanGate.reject(new Error("scan read closed"))),
    };
    const second = {
      listRootThreads: vi.fn(async () => [snapshot()]),
      readThread: vi.fn(),
      close: vi.fn(),
    };
    const inspection = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(async () => snapshot()),
      close: vi.fn(),
    };
    const createAppServer = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const subject = fixture({
      createAppServer,
      createInspectionAppServer: vi.fn(() => inspection),
    });

    const scan = subject.service.scan();
    await vi.waitFor(() => expect(first.listRootThreads).toHaveBeenCalledOnce());
    const exact = subject.service.inspectThread(THREAD_ID);

    try {
      expect(first.close).not.toHaveBeenCalled();
      expect(inspection.readThread).not.toHaveBeenCalled();
    } finally {
      if (first.close.mock.calls.length === 0) scanGate.resolve([snapshot()]);
      await Promise.allSettled([scan, exact]);
    }

    await expect(exact).resolves.toMatchObject({
      threadId: THREAD_ID,
    });
    await expect(scan).resolves.toMatchObject({ scanned: 1 });

    expect(inspection.readThread).toHaveBeenCalledWith(THREAD_ID);
    expect(inspection.close).toHaveBeenCalledOnce();
    expect(createAppServer).toHaveBeenCalledOnce();
    expect(second.listRootThreads).not.toHaveBeenCalled();
    expect(subject.service.status()).toMatchObject({
      appServerConnected: true,
      scanStale: false,
      scans: 1,
    });
    expect(subject.detector.scan).toHaveBeenCalledOnce();
    expect(subject.notifier.sendAlert).toHaveBeenCalledOnce();
    expect(subject.recovery.recoverAlert).not.toHaveBeenCalled();
  });

  it("waits for an active exact inspection before starting the next scan read", async () => {
    const inspectionGate = deferred<GuardianThreadSnapshot>();
    const inspection = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(() => inspectionGate.promise),
      close: vi.fn(),
    };
    const subject = fixture({
      createInspectionAppServer: vi.fn(() => inspection),
    });

    const exact = subject.service.inspectThread(THREAD_ID);
    await vi.waitFor(() => expect(inspection.readThread).toHaveBeenCalledOnce());
    const scan = subject.service.scan();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(subject.createAppServer).not.toHaveBeenCalled();
    expect(subject.appServer.listRootThreads).not.toHaveBeenCalled();

    inspectionGate.resolve(snapshot());
    await expect(exact).resolves.toMatchObject({ threadId: THREAD_ID });
    await expect(scan).resolves.toMatchObject({ scanned: 1 });
    expect(subject.createAppServer).toHaveBeenCalledOnce();
    expect(subject.appServer.listRootThreads).toHaveBeenCalledOnce();
  });

  it("gives an intended scan read priority over continuously arriving exact inspections", async () => {
    const firstInspectionGate = deferred<GuardianThreadSnapshot>();
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    let scanReading = false;
    const firstInspection = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(() => firstInspectionGate.promise),
      close: vi.fn(),
    };
    const queuedInspection = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(async () => {
        if (scanReading) throw new Error("exact overlapped scan read");
        return snapshot();
      }),
      close: vi.fn(),
    };
    const primary = {
      listRootThreads: vi.fn(async () => {
        scanReading = true;
        try { return await scanGate.promise; }
        finally { scanReading = false; }
      }),
      readThread: vi.fn(),
      close: vi.fn(),
    };
    const createInspectionAppServer = vi.fn()
      .mockReturnValueOnce(firstInspection)
      .mockImplementation(() => queuedInspection);
    const subject = fixture({
      createAppServer: vi.fn(() => primary),
      createInspectionAppServer,
    });

    const activeExact = subject.service.inspectThread(THREAD_ID);
    await vi.waitFor(() => expect(firstInspection.readThread).toHaveBeenCalledOnce());
    const scan = subject.service.scan();
    await vi.waitFor(() => expect(subject.service.status()).toMatchObject({
      activeOperation: "scan",
      scanPhase: "inspection-drain",
    }));
    const queuedExacts = Array.from(
      { length: 20 },
      () => subject.service.inspectThread(THREAD_ID),
    );
    expect(subject.service.status()).toMatchObject({ inspectionCount: 21 });
    expect(createInspectionAppServer).toHaveBeenCalledOnce();

    firstInspectionGate.resolve(snapshot());
    await vi.waitFor(() => expect(primary.listRootThreads).toHaveBeenCalledOnce());
    expect(createInspectionAppServer).toHaveBeenCalledOnce();
    expect(queuedInspection.readThread).not.toHaveBeenCalled();

    scanGate.resolve([snapshot()]);
    await expect(scan).resolves.toMatchObject({ scanned: 1 });
    await expect(activeExact).resolves.toMatchObject({ threadId: THREAD_ID });
    await Promise.all(queuedExacts);
    expect(queuedInspection.readThread).toHaveBeenCalledTimes(20);
    expect(subject.service.status()).toMatchObject({ inspectionCount: 0 });
  });

  it("rejects active and scan-gated exact inspections during shutdown", async () => {
    const activeGate = deferred<GuardianThreadSnapshot>();
    const activeInspection = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(() => activeGate.promise),
      close: vi.fn(() => activeGate.reject(new Error("inspection closed"))),
    };
    const createInspectionAppServer = vi.fn(() => activeInspection);
    const subject = fixture({ createInspectionAppServer });

    const activeExact = subject.service.inspectThread(THREAD_ID);
    await vi.waitFor(() => expect(activeInspection.readThread).toHaveBeenCalledOnce());
    const scan = subject.service.scan();
    await vi.waitFor(() => expect(subject.service.status()).toMatchObject({
      scanPhase: "inspection-drain",
    }));
    const gatedExact = subject.service.inspectThread(THREAD_ID);
    expect(subject.service.status()).toMatchObject({ inspectionCount: 2 });

    const results = await Promise.allSettled([
      activeExact,
      scan,
      gatedExact,
      subject.service.close(),
    ]);

    expect(results.slice(0, 3).every((result) => result.status === "rejected")).toBe(true);
    expect(results[3]).toMatchObject({ status: "fulfilled" });
    expect(createInspectionAppServer).toHaveBeenCalledOnce();
    expect(subject.service.status()).toMatchObject({
      inspectionCount: 0,
      activeOperation: "idle",
      scanPhase: "idle",
    });
  });

  it("does not preempt an idle primary runtime when exact inspection starts", async () => {
    const subject = fixture();
    await subject.service.scan();

    await expect(subject.service.inspectThread(THREAD_ID)).resolves.toMatchObject({
      threadId: THREAD_ID,
    });

    expect(subject.appServer.close).not.toHaveBeenCalled();
    expect(subject.createAppServer).toHaveBeenCalledOnce();
  });

  it("does not preempt the primary runtime during serialized recovery mutation", async () => {
    const repairGate = deferred<{
      outcome: "restored";
      threadId: string;
      detail: string;
    }>();
    const subject = fixture();
    subject.recovery.repairThread = vi.fn(() => repairGate.promise);

    const repair = subject.service.repairThread(THREAD_ID);
    await vi.waitFor(() => expect(subject.recovery.repairThread).toHaveBeenCalledOnce());
    await expect(subject.service.inspectThread(THREAD_ID)).resolves.toMatchObject({
      threadId: THREAD_ID,
    });

    expect(subject.appServer.close).not.toHaveBeenCalled();
    repairGate.resolve({ outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" });
    await repair;
  });

  it("does not preempt after the scan read enters notification delivery", async () => {
    const deliveryGate = deferred<{
      alertId: string;
      chatId: number;
      messageThreadId: number;
      messageId: number;
    }>();
    const subject = fixture();
    subject.notifier.sendAlert = vi.fn(() => deliveryGate.promise);

    const scan = subject.service.scan();
    await vi.waitFor(() => expect(subject.notifier.sendAlert).toHaveBeenCalledOnce());
    await expect(subject.service.inspectThread(THREAD_ID)).resolves.toMatchObject({
      threadId: THREAD_ID,
    });

    expect(subject.appServer.close).not.toHaveBeenCalled();
    deliveryGate.resolve({
      alertId: ALERT_ID,
      chatId: alert().route.chatId,
      messageThreadId: 42,
      messageId: 77,
    });
    await scan;
  });

  it("runs multiple exact inspections independently", async () => {
    const firstGate = deferred<GuardianThreadSnapshot>();
    const first = { listRootThreads: vi.fn(), readThread: vi.fn(() => firstGate.promise),
      close: vi.fn() };
    const second = { listRootThreads: vi.fn(), readThread: vi.fn(async () => snapshot()),
      close: vi.fn() };
    const subject = fixture({
      createInspectionAppServer: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    });

    const pendingFirst = subject.service.inspectThread(THREAD_ID);
    await vi.waitFor(() => expect(first.readThread).toHaveBeenCalledOnce());
    expect(subject.service.status()).toMatchObject({ inspectionCount: 1 });
    await expect(subject.service.inspectThread(THREAD_ID)).resolves.toMatchObject({
      threadId: THREAD_ID,
    });
    expect(subject.service.status()).toMatchObject({ inspectionCount: 1 });
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.close).not.toHaveBeenCalled();

    firstGate.resolve(snapshot());
    await pendingFirst;
    expect(subject.service.status()).toMatchObject({ inspectionCount: 0 });
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("isolates inspection failure from the primary scan runtime", async () => {
    const subject = fixture();
    await subject.service.scan();
    subject.inspectionAppServer.readThread = vi.fn(async () => {
      throw new Error("inspection unavailable");
    });

    await expect(subject.service.inspectThread(THREAD_ID)).rejects.toThrow("inspection unavailable");

    expect(subject.inspectionAppServer.close).toHaveBeenCalledOnce();
    expect(subject.appServer.close).not.toHaveBeenCalled();
    await expect(subject.service.scan()).resolves.toMatchObject({ scanned: 1 });
    expect(subject.createAppServer).toHaveBeenCalledOnce();
  });

  it("closes and drains accepted inspections during shutdown and rejects new ones", async () => {
    const readGate = deferred<GuardianThreadSnapshot>();
    const inspection = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(() => readGate.promise),
      close: vi.fn(() => readGate.reject(new Error("inspection closed"))),
    };
    const createInspectionAppServer = vi.fn(() => inspection);
    const subject = fixture({ createInspectionAppServer });

    const accepted = subject.service.inspectThread(THREAD_ID);
    await vi.waitFor(() => expect(inspection.readThread).toHaveBeenCalledOnce());
    const closing = subject.service.close();
    await expect(accepted).rejects.toThrow("inspection closed");
    await closing;
    expect(inspection.close).toHaveBeenCalledOnce();
    await expect(subject.service.inspectThread(THREAD_ID)).rejects.toThrow("closed");
    expect(createInspectionAppServer).toHaveBeenCalledOnce();
  });

  it("cancels an active repair primary before waiting for serialized work on full close", async () => {
    const repairGate = deferred<{ outcome: "restored"; threadId: string; detail: string }>();
    const subject = fixture();
    subject.recovery.repairThread = vi.fn(() => repairGate.promise);
    subject.appServer.close = vi.fn(() => repairGate.reject(new Error("repair closed")));
    const repair = subject.service.repairThread(THREAD_ID);
    await vi.waitFor(() => expect(subject.recovery.repairThread).toHaveBeenCalledOnce());
    const repairRejected = expect(repair).rejects.toThrow("repair closed");
    const closing = subject.service.close();
    let canceled = false;
    try {
      await vi.waitFor(() => expect(subject.appServer.close).toHaveBeenCalledOnce(), {
        timeout: 250,
      });
      canceled = true;
    } finally {
      if (!canceled) repairGate.reject(new Error("test cleanup"));
      await Promise.all([repairRejected, closing]);
    }

    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();
  });

  it("does not start a delayed recovery checking edit after full close", async () => {
    const recoveryGate = deferred<void>();
    const subject = fixture();
    subject.setAlerts([alert({ state: "checking", deliveryState: "delivered", messageId: 77 })]);
    let onChecking!: (alertId: string) => Promise<void>;
    subject.createRecovery.mockImplementation((_gateway, hooks) => {
      onChecking = hooks.onChecking;
      return subject.recovery;
    });
    subject.recovery.recoverAlert = vi.fn(async () => {
      await recoveryGate.promise;
      await onChecking(ALERT_ID);
      return { outcome: "failed", threadId: THREAD_ID, detail: "Interrupt failed" };
    });

    const repair = subject.service.repairAlert(ALERT_ID);
    await vi.waitFor(() => expect(subject.recovery.recoverAlert).toHaveBeenCalledOnce());
    const repairRejected = expect(repair).rejects.toThrow("closed");
    const closing = subject.service.close();
    recoveryGate.resolve();
    await Promise.all([repairRejected, closing]);

    expect(subject.notifier.editStatus).not.toHaveBeenCalled();
    expect(subject.store.recordStatusDelivery).not.toHaveBeenCalled();
  });

  it("closes a repair primary factory that resolves after full close begins", async () => {
    const factoryGate = deferred<GuardianServiceAppServer>();
    const primary = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(),
      close: vi.fn(),
    };
    const createAppServer = vi.fn(() => factoryGate.promise);
    const subject = fixture({ createAppServer });
    const repair = subject.service.repairThread(THREAD_ID);
    await vi.waitFor(() => expect(createAppServer).toHaveBeenCalledOnce());
    const repairRejected = expect(repair).rejects.toThrow("service is closed");
    const closing = subject.service.close();

    factoryGate.resolve(primary);
    await Promise.all([repairRejected, closing]);

    expect(primary.close).toHaveBeenCalledOnce();
    expect(subject.createRecovery).not.toHaveBeenCalled();
    expect(subject.recovery.repairThread).not.toHaveBeenCalled();
  });

  it("cancels a hanging scan read before draining shutdown", async () => {
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    const primary = {
      listRootThreads: vi.fn(() => scanGate.promise),
      readThread: vi.fn(),
      close: vi.fn(() => scanGate.reject(new Error("scan closed for shutdown"))),
    };
    const subject = fixture({ createAppServer: vi.fn(() => primary) });
    subject.service.start();
    await vi.waitFor(() => expect(primary.listRootThreads).toHaveBeenCalledOnce());

    const closing = subject.service.close();
    let canceled = false;
    try {
      await vi.waitFor(() => expect(primary.close).toHaveBeenCalledOnce(), { timeout: 250 });
      canceled = true;
    } finally {
      if (!canceled) scanGate.reject(new Error("test cleanup"));
      await closing;
    }

    expect(subject.service.status()).toMatchObject({
      running: false,
      appServerConnected: false,
      scans: 0,
    });
    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();
  });

  it("drains a waiting exact inspection and queued scan after canceling the active read", async () => {
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    const primary = {
      listRootThreads: vi.fn(() => scanGate.promise),
      readThread: vi.fn(),
      close: vi.fn(() => scanGate.reject(new Error("active scan closed for shutdown"))),
    };
    const createAppServer = vi.fn(() => primary);
    const createInspectionAppServer = vi.fn(() => ({
      listRootThreads: vi.fn(),
      readThread: vi.fn(async () => snapshot()),
      close: vi.fn(),
    }));
    const subject = fixture({ createAppServer, createInspectionAppServer });
    const active = subject.service.scan();
    await vi.waitFor(() => expect(primary.listRootThreads).toHaveBeenCalledOnce());
    const exact = subject.service.inspectThread(THREAD_ID);
    const queued = subject.service.scan();
    const activeRejected = expect(active).rejects.toThrow("closed for shutdown");
    const exactRejected = expect(exact).rejects.toThrow("service is closed");
    const queuedRejected = expect(queued).rejects.toThrow("stopped");

    await Promise.all([
      subject.service.close(),
      activeRejected,
      exactRejected,
      queuedRejected,
    ]);

    expect(primary.close).toHaveBeenCalledOnce();
    expect(createAppServer).toHaveBeenCalledOnce();
    expect(createInspectionAppServer).not.toHaveBeenCalled();
    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();
  });

  it("rejects a queued scan before terminal reconciliation after shutdown begins", async () => {
    const repairGate = deferred<{ outcome: "restored"; threadId: string; detail: string }>();
    const subject = fixture();
    subject.setAlerts([alert({
      state: "failed",
      detail: "Wait for idle failed",
      deliveryState: "delivered",
      messageId: 77,
      statusDeliveryState: "pending",
    })]);
    subject.recovery.repairThread = vi.fn(() => repairGate.promise);
    const repair = subject.service.repairThread(THREAD_ID);
    await vi.waitFor(() => expect(subject.recovery.repairThread).toHaveBeenCalledOnce());
    const queued = subject.service.scan();
    const queuedRejected = expect(queued).rejects.toThrow("stopped");
    const closing = subject.service.close();

    repairGate.resolve({ outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" });
    await Promise.all([repair, queuedRejected, closing]);

    expect(subject.notifier.editStatus).not.toHaveBeenCalled();
    expect(subject.store.recordStatusDelivery).not.toHaveBeenCalled();
    expect(subject.appServer.listRootThreads).not.toHaveBeenCalled();
    expect(subject.detector.scan).not.toHaveBeenCalled();
  });

  it("stops terminal reconciliation after a pending notifier settles during full close", async () => {
    const notificationGate = deferred<void>();
    const subject = fixture();
    subject.setAlerts([
      alert({ state: "failed", detail: "Wait for idle failed",
        deliveryState: "delivered", messageId: 77, statusDeliveryState: "pending" }),
      alert({ id: "bcdefghijklmnopqrstuvw", state: "failed", detail: "Wait for idle failed",
        deliveryState: "delivered", messageId: 78, statusDeliveryState: "pending" }),
    ]);
    subject.notifier.editStatus = vi.fn()
      .mockImplementationOnce(() => notificationGate.promise)
      .mockResolvedValue(undefined);

    const scan = subject.service.scan();
    await vi.waitFor(() => expect(subject.notifier.editStatus).toHaveBeenCalledOnce());
    const scanRejected = expect(scan).rejects.toThrow("stopped");
    const closing = subject.service.close();
    notificationGate.resolve();
    await Promise.all([scanRejected, closing]);

    expect(subject.notifier.editStatus).toHaveBeenCalledOnce();
    expect(subject.store.recordStatusDelivery).not.toHaveBeenCalled();
    expect(subject.store.markStatusDeliveryFailed).not.toHaveBeenCalled();
    expect(subject.appServer.listRootThreads).not.toHaveBeenCalled();
    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.service.status()).toMatchObject({ scans: 0, scanStale: true });
  });

  it("stops alert delivery after a pending notifier settles during full close", async () => {
    const deliveryGate = deferred<{
      alertId: string;
      chatId: number;
      messageThreadId: number;
      messageId: number;
    }>();
    const subject = fixture();
    subject.setAlerts([
      alert(),
      alert({ id: "bcdefghijklmnopqrstuvw" }),
    ]);
    subject.notifier.sendAlert = vi.fn()
      .mockImplementationOnce(() => deliveryGate.promise)
      .mockResolvedValue({ alertId: "bcdefghijklmnopqrstuvw", chatId: alert().route.chatId,
        messageThreadId: 42, messageId: 78 });

    const scan = subject.service.scan();
    await vi.waitFor(() => expect(subject.notifier.sendAlert).toHaveBeenCalledOnce());
    const scanRejected = expect(scan).rejects.toThrow("stopped");
    const closing = subject.service.close();
    deliveryGate.resolve({ alertId: ALERT_ID, chatId: alert().route.chatId,
      messageThreadId: 42, messageId: 77 });
    await Promise.all([scanRejected, closing]);

    expect(subject.notifier.sendAlert).toHaveBeenCalledOnce();
    expect(subject.store.recordDelivery).not.toHaveBeenCalled();
    expect(subject.store.markDeliveryFailed).not.toHaveBeenCalled();
    expect(subject.service.status()).toMatchObject({ scans: 0, scanStale: true });
  });

  it("rejects an accepted queued scan without opening a gateway after shutdown begins", async () => {
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    const first = {
      listRootThreads: vi.fn(() => scanGate.promise),
      readThread: vi.fn(),
      close: vi.fn(() => scanGate.reject(new Error("active scan closed for shutdown"))),
    };
    const second = {
      listRootThreads: vi.fn(async () => []),
      readThread: vi.fn(),
      close: vi.fn(),
    };
    const createAppServer = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const subject = fixture({ createAppServer });
    subject.service.start();
    await vi.waitFor(() => expect(first.listRootThreads).toHaveBeenCalledOnce());
    const queued = subject.service.scan();

    await subject.service.close();

    await expect(queued).rejects.toThrow("stopped");
    expect(createAppServer).toHaveBeenCalledOnce();
    expect(second.listRootThreads).not.toHaveBeenCalled();
    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();
  });

  it("closes a primary factory that resolves after shutdown without starting a scan read", async () => {
    const factoryGate = deferred<GuardianServiceAppServer>();
    const primary = {
      listRootThreads: vi.fn(async () => []),
      readThread: vi.fn(),
      close: vi.fn(),
    };
    const createAppServer = vi.fn(() => factoryGate.promise);
    const subject = fixture({ createAppServer });
    subject.service.start();
    await vi.waitFor(() => expect(createAppServer).toHaveBeenCalledOnce());

    const closing = subject.service.close();
    factoryGate.resolve(primary);
    await closing;

    expect(primary.close).toHaveBeenCalledOnce();
    expect(primary.listRootThreads).not.toHaveBeenCalled();
    expect(subject.service.status()).toMatchObject({
      running: false,
      appServerConnected: false,
      scans: 0,
    });
    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();
  });

  it("rejects a fulfilled scan read when quiesce wins before detector continuation", async () => {
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    const subject = fixture();
    subject.appServer.listRootThreads = vi.fn(() => scanGate.promise);
    const scan = subject.service.scan();
    await vi.waitFor(() => expect(subject.appServer.listRootThreads).toHaveBeenCalledOnce());
    const scanRejected = expect(scan).rejects.toThrow("stopped");

    scanGate.resolve([snapshot()]);
    const quiesced = subject.service.quiesceScanning();
    try {
      await Promise.all([scanRejected, quiesced]);
    } finally {
      await subject.service.close();
    }

    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();
    expect(subject.service.status()).toMatchObject({ scans: 0, scanStale: true });
  });

  it("recreates a failed app-server and uses capped backoff that resets after success", async () => {
    const waits: Array<{ ms: number; gate: ReturnType<typeof deferred<void>> }> = [];
    const sleep: GuardianSleep = (ms, signal) => {
      const gate = deferred<void>();
      waits.push({ ms, gate });
      signal.addEventListener("abort", () => gate.resolve(), { once: true });
      return gate.promise;
    };
    const gateways = Array.from({ length: 8 }, (_, index) => ({
      listRootThreads: index === 6
        ? vi.fn().mockResolvedValueOnce([snapshot()])
          .mockRejectedValueOnce(new Error("app disconnected"))
        : vi.fn(async () => { throw new Error("app disconnected"); }),
      readThread: vi.fn(async () => snapshot()), close: vi.fn(),
    }));
    let index = 0;
    const subject = fixture({
      sleep,
      createAppServer: vi.fn(() => gateways[Math.min(index++, gateways.length - 1)]),
    });

    subject.service.start();
    const expectedWaits = [1_000, 2_000, 4_000, 8_000, 30_000, 30_000, 60_000];
    for (const [step, expected] of expectedWaits.entries()) {
      await vi.waitFor(() => expect(waits).toHaveLength(step + 1));
      expect(waits[step]!.ms).toBe(expected);
      waits[step]!.gate.resolve();
    }
    await vi.waitFor(() => expect(waits).toHaveLength(expectedWaits.length + 1));
    expect(waits.at(-1)?.ms).toBe(1_000);
    expect(gateways.slice(0, 6).every((gateway) => gateway.close.mock.calls.length === 1)).toBe(true);
    await subject.service.stop();
  });

  it("quiesces a hanging scan and recreates the primary for already accepted work", async () => {
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    const repairGate = deferred<{ outcome: "restored"; threadId: string; detail: string }>();
    const first = {
      listRootThreads: vi.fn(() => scanGate.promise),
      readThread: vi.fn(),
      close: vi.fn(() => scanGate.reject(new Error("scan closed for quiesce"))),
    };
    const second = {
      listRootThreads: vi.fn(),
      readThread: vi.fn(),
      close: vi.fn(),
    };
    const createAppServer = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const subject = fixture({ createAppServer });
    subject.recovery.repairThread = vi.fn(() => repairGate.promise);
    subject.service.start();
    await vi.waitFor(() => expect(first.listRootThreads).toHaveBeenCalledOnce());
    const acceptedRepair = subject.service.repairThread(THREAD_ID);
    const quiesced = subject.service.quiesceScanning();
    await quiesced;
    expect(first.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(subject.recovery.repairThread).toHaveBeenCalledOnce());
    expect(createAppServer).toHaveBeenCalledTimes(2);
    expect(second.close).not.toHaveBeenCalled();
    await expect(subject.service.scan()).rejects.toThrow("quiesced");
    repairGate.resolve({ outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" });
    await acceptedRepair;
    await subject.service.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("stops idempotently by canceling an active scan read and during backoff", async () => {
    const scanGate = deferred<GuardianThreadSnapshot[]>();
    const subject = fixture();
    subject.appServer.listRootThreads = vi.fn(() => scanGate.promise);
    subject.appServer.close = vi.fn(() => scanGate.reject(new Error("scan closed for shutdown")));
    subject.service.start();
    await vi.waitFor(() => expect(subject.appServer.listRootThreads).toHaveBeenCalledOnce());
    const stopped = subject.service.stop();
    await stopped;
    await subject.service.stop();
    expect(subject.appServer.close).toHaveBeenCalledOnce();
    expect(subject.detector.scan).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();

    const waitGate = deferred<void>();
    const sleeping = fixture({
      sleep: (_ms: number, signal: AbortSignal) => {
        signal.addEventListener("abort", () => waitGate.resolve(), { once: true });
        return waitGate.promise;
      },
    });
    sleeping.service.start();
    await vi.waitFor(() => expect(sleeping.notifier.sendAlert).toHaveBeenCalled());
    await sleeping.service.stop();
    expect(sleeping.appServer.close).toHaveBeenCalledOnce();
  });

  it("edits checking before repair completion and edits read-only checks in place", async () => {
    const subject = fixture();
    subject.setAlerts([alert({ deliveryState: "delivered", messageId: 77 })]);
    let checking!: (alertId: string) => Promise<void>;
    subject.createRecovery.mockImplementation((_gateway, hooks) => {
      checking = hooks.onChecking;
      return subject.recovery;
    });
    const repairGate = deferred<{ outcome: "restored"; threadId: string; detail: string }>();
    subject.recovery.recoverAlert = vi.fn(async () => {
      subject.setAlerts([alert({ state: "checking", deliveryState: "delivered", messageId: 77 })]);
      await checking(ALERT_ID);
      const result = await repairGate.promise;
      subject.setAlerts([alert({ state: "restored", deliveryState: "delivered", messageId: 77,
        statusDeliveryState: "pending" })]);
      return result;
    });

    const pending = subject.service.repairAlert(ALERT_ID);
    await vi.waitFor(() => expect(subject.notifier.editStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "checking" }),
    ));
    repairGate.resolve({ outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" });
    await pending;
    expect(subject.notifier.editStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: expect.objectContaining({ outcome: "restored" }) }),
    );

    subject.setAlerts([alert({ deliveryState: "delivered", messageId: 77 })]);
    subject.recovery.recoverAlert = vi.fn(async () => ({ outcome: "observation-only",
      threadId: THREAD_ID, detail: "Observation-only mode" }));
    await subject.service.checkAlert(ALERT_ID);
    expect(subject.notifier.editStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: expect.objectContaining({ outcome: "observation-only" }) }),
    );
  });

  it("shares concurrent callback repair work without duplicate status edits", async () => {
    const subject = fixture();
    subject.setAlerts([alert({ deliveryState: "delivered", messageId: 77 })]);
    const gate = deferred<void>();
    subject.recovery.recoverAlert = vi.fn(async () => {
      await gate.promise;
      return { outcome: "observation-only", threadId: THREAD_ID,
        detail: "Observation-only mode" };
    });

    const first = subject.service.repairAlert(ALERT_ID);
    const second = subject.service.repairAlert(ALERT_ID);
    await vi.waitFor(() => expect(subject.recovery.recoverAlert).toHaveBeenCalledOnce());
    gate.resolve();
    await Promise.all([first, second]);
    expect(subject.recovery.recoverAlert).toHaveBeenCalledOnce();
    expect(subject.notifier.editStatus).toHaveBeenCalledOnce();
  });

  it("returns safe status and exact inspection metadata without content or paths", async () => {
    const subject = fixture();
    expect(subject.service.status()).toMatchObject({ running: false, observationOnly: true,
      repairEnabled: false, appServerConnected: false, scanStale: true });
    const inspected = await subject.service.inspectThread(THREAD_ID);
    expect(inspected).toEqual({
      threadId: THREAD_ID, turnId: TURN_ID, threadStatus: "active", turnStatus: "inProgress",
      updatedAt: 100, itemCount: 2, lastItemType: "agentMessage", source: "telecodex",
      canAcceptDirectInput: false, root: true,
    });
    expect(JSON.stringify(inspected)).not.toContain("secret");
    expect(subject.inspectionAppServer.close).toHaveBeenCalledOnce();
    expect(subject.createAppServer).not.toHaveBeenCalled();
    expect(subject.createRecovery).not.toHaveBeenCalled();
    await expect(subject.service.inspectThread(`${THREAD_ID}?x=1`)).rejects.toThrow("UUID");
  });

  it("reports scan freshness independently from app-server connectivity", async () => {
    let now = 11_000;
    const subject = fixture({ clock: () => now });

    expect(subject.service.status()).toMatchObject({
      appServerConnected: false,
      scanStale: true,
      scans: 0,
    });
    await subject.service.scan();
    expect(subject.service.status()).toMatchObject({
      appServerConnected: true,
      scanStale: false,
      scans: 1,
      lastScanAt: 11_000,
    });

    now = 10_999;
    expect(subject.service.status()).toMatchObject({
      scanStale: true,
      lastScanAt: 11_000,
    });

    now = 131_001;
    expect(subject.service.status()).toMatchObject({
      appServerConnected: true,
      scanStale: true,
      lastScanAt: 11_000,
    });
  });

  it("keeps active operation status readable when the diagnostic clock is invalid", async () => {
    const subject = fixture({ clock: () => Number.NaN });
    const gate = deferred<{ outcome: "restored"; threadId: string; detail: string }>();
    subject.recovery.repairThread = vi.fn(() => gate.promise);
    const repair = subject.service.repairThread(THREAD_ID);
    await vi.waitFor(() => expect(subject.recovery.repairThread).toHaveBeenCalledOnce());

    expect(subject.service.status()).toMatchObject({
      scanStale: true,
      activeOperation: "repair",
      scanPhase: "idle",
      queueDepth: 0,
      inspectionCount: 0,
    });
    expect(subject.service.status()).not.toHaveProperty("activeSince");
    gate.resolve({ outcome: "restored", threadId: THREAD_ID, detail: "Thread restored" });
    await repair;
  });

  it("projects the current persisted guardian observation for the exact live fingerprint", async () => {
    const subject = fixture();
    subject.store.inspectThreadObservation.mockReturnValue({
      observation: observation(),
      alert: alert(),
      repairOutcome: null,
    });
    await expect(subject.service.inspectThread(THREAD_ID)).resolves.toMatchObject({
      observation: {
        guardianHealth: "stalled",
        lastObservedAt: 5_000,
        unchangedSince: 1_000,
        staleForMs: 10_000,
        alertId: ALERT_ID,
        repairState: "eligible",
        repairOutcome: null,
      },
    });
  });

  it("reports unavailable observation storage without recovery or runtime side effects", async () => {
    const subject = fixture();
    subject.store.inspectThreadObservation.mockImplementation(() => {
      throw new Error("guardian storage unavailable");
    });
    await expect(subject.service.inspectThread(THREAD_ID)).rejects.toThrow(
      "guardian storage unavailable",
    );
    expect(subject.appServer.close).not.toHaveBeenCalled();
    expect(subject.recovery.recoverAlert).not.toHaveBeenCalled();
    expect(subject.recovery.repairThread).not.toHaveBeenCalled();
    expect(subject.notifier.sendAlert).not.toHaveBeenCalled();
    expect(subject.notifier.editStatus).not.toHaveBeenCalled();
    expect(subject.detector.scan).not.toHaveBeenCalled();
  });

  it("does not classify an active child thread as stalled", async () => {
    const subject = fixture();
    subject.inspectionAppServer.readThread = vi.fn(async () => snapshot({
      root: false,
      source: { subAgent: { thread_spawn: { parent_thread_id: THREAD_ID } } },
    }));
    subject.store.inspectThreadObservation.mockReturnValue({
      observation: observation(),
      alert: alert(),
      repairOutcome: null,
    });
    const inspected = await subject.service.inspectThread(THREAD_ID);
    expect(inspected.root).toBe(false);
    expect(inspected.source).toBe("subagent");
    expect(inspected).not.toHaveProperty("observation");
    expect(subject.store.inspectThreadObservation).not.toHaveBeenCalled();
  });

  it("reports a terminal matching alert with a coherent terminal outcome", async () => {
    const subject = fixture();
    subject.store.inspectThreadObservation.mockReturnValue({
      observation: observation(),
      alert: alert({ state: "failed", detail: "Fresh state check failed" }),
      repairOutcome: null,
    });
    await expect(subject.service.inspectThread(THREAD_ID)).resolves.toMatchObject({
      observation: {
        guardianHealth: "stalled",
        alertId: ALERT_ID,
        repairState: "terminal",
        repairOutcome: "failed",
      },
    });
  });

  it("does not project an old stalled observation after live progress", async () => {
    const subject = fixture();
    subject.inspectionAppServer.readThread = vi.fn(async () => snapshot({
      updatedAt: 101,
      itemCount: 3,
      lastItemType: "subAgentActivity",
    }));
    subject.store.inspectThreadObservation.mockReturnValue({
      observation: observation(),
      alert: alert(),
      repairOutcome: null,
    });
    const inspected = await subject.service.inspectThread(THREAD_ID);
    expect(inspected.updatedAt).toBe(101);
    expect(inspected.lastItemType).toBe("subAgentActivity");
    expect(inspected).not.toHaveProperty("observation");
  });

  it("preserves unknown-thread failure without reading state or restarting the runtime", async () => {
    const subject = fixture();
    subject.inspectionAppServer.readThread = vi.fn(async () => {
      throw new Error("unknown thread");
    });
    await expect(subject.service.inspectThread(THREAD_ID)).rejects.toThrow("unknown thread");
    expect(subject.store.inspectThreadObservation).not.toHaveBeenCalled();
    expect(subject.inspectionAppServer.close).toHaveBeenCalledOnce();
    expect(subject.appServer.close).not.toHaveBeenCalled();
    expect(subject.recovery.recoverAlert).not.toHaveBeenCalled();
    expect(subject.recovery.repairThread).not.toHaveBeenCalled();
  });

  it("closes and recreates an app-server when recovery assembly fails", async () => {
    const first = { listRootThreads: vi.fn(), readThread: vi.fn(), close: vi.fn() };
    const second = { listRootThreads: vi.fn(async () => []), readThread: vi.fn(), close: vi.fn() };
    const createAppServer = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const createRecovery = vi.fn()
      .mockImplementationOnce(() => { throw new Error("recovery factory failed"); })
      .mockReturnValueOnce({ recoverAlert: vi.fn(), repairThread: vi.fn() });
    const subject = fixture({ createAppServer, createRecovery });

    await expect(subject.service.scan()).rejects.toThrow("recovery factory failed");
    expect(first.close).toHaveBeenCalledOnce();
    await expect(subject.service.scan()).resolves.toMatchObject({ scanned: 0 });
    expect(createAppServer).toHaveBeenCalledTimes(2);
  });

  it("durably retries terminal Telegram status across scans and does not duplicate success", async () => {
    const subject = fixture();
    subject.setAlerts([alert({ state: "failed", detail: "Wait for idle failed",
      deliveryState: "delivered", messageId: 77, statusDeliveryState: "pending" })]);
    subject.notifier.editStatus.mockRejectedValueOnce(new Error("telegram unavailable"));

    await subject.service.scan();
    expect(subject.store.markStatusDeliveryFailed).toHaveBeenCalledWith(ALERT_ID);
    expect(subject.appServer.close).not.toHaveBeenCalled();
    await subject.service.scan();
    expect(subject.store.recordStatusDelivery).toHaveBeenCalledWith(ALERT_ID);
    await subject.service.scan();
    expect(subject.notifier.editStatus).toHaveBeenCalledTimes(2);
  });

  it("reconciles a crash-equivalent terminal row before an unavailable app-server", async () => {
    const subject = fixture();
    subject.setAlerts([alert({ state: "restored", detail: "Thread restored",
      deliveryState: "delivered", messageId: 77, statusDeliveryState: "pending" })]);
    subject.appServer.listRootThreads = vi.fn(async () => { throw new Error("app unavailable"); });

    await expect(subject.service.scan()).rejects.toThrow("app unavailable");
    expect(subject.notifier.editStatus).toHaveBeenCalledOnce();
    expect(subject.store.recordStatusDelivery).toHaveBeenCalledWith(ALERT_ID);
  });
});
