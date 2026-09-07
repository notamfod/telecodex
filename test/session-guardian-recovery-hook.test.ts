import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionGuardianRecovery } from "../src/session-guardian-recovery.js";
import { SessionGuardianService } from "../src/session-guardian-service.js";
import { SessionGuardianStore } from "../src/session-guardian-store.js";
import { SessionGuardianTelegramNotifier } from "../src/session-guardian-telegram.js";
import { fingerprintOf, type GuardianThreadSnapshot } from "../src/session-guardian-types.js";

const THREAD_ID = "01a02451-2fc4-76c0-9f14-c75034c10017";
const TURN_ID = "01a02451-2fc4-76c0-9f14-c75034c10018";

function snapshot(status: "active" | "idle" = "active"): GuardianThreadSnapshot {
  return {
    threadId: THREAD_ID, turnId: TURN_ID, threadStatus: status,
    turnStatus: status === "active" ? "inProgress" : "interrupted",
    updatedAt: 100, itemCount: 2, lastItemType: "agentMessage", source: "cli",
    cwd: "/srv/project", name: null, canAcceptDirectInput: status === "idle", root: true,
  };
}

describe("SessionGuardianRecovery checking hook", () => {
  let directory = "";
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("awaits one checking hook after the durable claim and before mutation", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "guardian-recovery-hook-"));
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const alert = store.createAlert(fingerprintOf(snapshot())!, { chatId: -1001, messageThreadId: 2 }, 1);
    const events: string[] = [];
    const appServer = {
      readThread: vi.fn(async () => snapshot()),
      interrupt: vi.fn(async () => { events.push("interrupt"); }),
      waitForIdle: vi.fn(async () => snapshot("idle")),
      coldReload: vi.fn(async () => snapshot("idle")),
    };
    const recovery = new SessionGuardianRecovery(appServer, store, {
      clock: () => 10,
      onChecking: async (alertId) => {
        expect(alertId).toBe(alert.id);
        expect(store.getAlert(alert.id)?.state).toBe("checking");
        events.push("checking");
      },
    });

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true }))
      .resolves.toMatchObject({ outcome: "restored" });
    expect(events).toEqual(["checking", "interrupt"]);
    store.close();
  });

  it("does not invoke the checking hook when shutdown aborts immediately after the claim", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "guardian-recovery-claim-abort-"));
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const alert = store.createAlert(
      fingerprintOf(snapshot())!, { chatId: -1001, messageThreadId: 2 }, 1,
    );
    const controller = new AbortController();
    const onChecking = vi.fn(async () => undefined);
    const originalClaim = store.claimRepair.bind(store);
    vi.spyOn(store, "claimRepair").mockImplementation((...args) => {
      const claimed = originalClaim(...args);
      controller.abort();
      return claimed;
    });
    const appServer = {
      readThread: vi.fn(async () => snapshot()),
      interrupt: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => snapshot("idle")),
      coldReload: vi.fn(async () => snapshot("idle")),
    };
    const recovery = new SessionGuardianRecovery(appServer, store, {
      clock: () => 10,
      onChecking,
      signal: controller.signal,
    });

    await expect(recovery.recoverAlert(alert.id, { repairEnabled: true }))
      .rejects.toThrow("canceled");

    expect(onChecking).not.toHaveBeenCalled();
    expect(store.getAlert(alert.id)).toMatchObject({ state: "checking" });
    expect(appServer.interrupt).not.toHaveBeenCalled();
    store.close();
  });

  it("cancels an active read-only alert check on full service close without a terminal edit", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "guardian-recovery-check-close-"));
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const created = store.createAlert(
      fingerprintOf(snapshot())!, { chatId: -1001, messageThreadId: 2 }, 1,
    );
    store.recordDelivery(created.id, 321);
    let rejectRead!: (error: Error) => void;
    const appServer = {
      listRootThreads: vi.fn(async () => [snapshot()]),
      readThread: vi.fn(() => new Promise<GuardianThreadSnapshot>((_resolve, reject) => {
        rejectRead = reject;
      })),
      interrupt: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => snapshot("idle")),
      coldReload: vi.fn(async () => snapshot("idle")),
      close: vi.fn(() => rejectRead(new Error("app-server closed"))),
    };
    const editMessageText = vi.fn(async () => undefined);
    const notifier = new SessionGuardianTelegramNotifier({
      sendMessage: vi.fn(), editMessageText,
    });
    const service = new SessionGuardianService({
      createAppServer: () => appServer,
      createInspectionAppServer: () => appServer,
      createRecovery: (_gateway, hooks) => new SessionGuardianRecovery(appServer, store, {
        clock: () => 10, onChecking: hooks.onChecking, signal: hooks.signal,
      }),
      detector: { scan: vi.fn(() => []) }, store, notifier,
      scanIntervalMs: 60_000, recentWindowMs: 86_400_000,
      observationOnly: false, repairEnabled: true,
      clock: () => 10,
    });

    const checking = service.checkAlert(created.id);
    await vi.waitFor(() => expect(appServer.readThread).toHaveBeenCalledOnce());
    const checkingRejected = expect(checking).rejects.toThrow("canceled");
    await Promise.all([checkingRejected, service.close()]);

    expect(editMessageText).not.toHaveBeenCalled();
    expect(store.getAlert(created.id)).toMatchObject({ state: "open" });
    store.close();
  });

  it("cancels a claimed alert repair on full service close without failed finalization", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "guardian-recovery-repair-close-"));
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const created = store.createAlert(
      fingerprintOf(snapshot())!, { chatId: -1001, messageThreadId: 2 }, 1,
    );
    store.recordDelivery(created.id, 321);
    const finishRepair = vi.spyOn(store, "finishRepair");
    let rejectInterrupt!: (error: Error) => void;
    const appServer = {
      listRootThreads: vi.fn(async () => [snapshot()]),
      readThread: vi.fn(async () => snapshot()),
      interrupt: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectInterrupt = reject;
      })),
      waitForIdle: vi.fn(async () => snapshot("idle")),
      coldReload: vi.fn(async () => snapshot("idle")),
      close: vi.fn(() => rejectInterrupt(new Error("app-server closed"))),
    };
    const editMessageText = vi.fn(async () => undefined);
    const notifier = new SessionGuardianTelegramNotifier({
      sendMessage: vi.fn(), editMessageText,
    });
    const service = new SessionGuardianService({
      createAppServer: () => appServer,
      createInspectionAppServer: () => appServer,
      createRecovery: (_gateway, hooks) => new SessionGuardianRecovery(appServer, store, {
        clock: () => 10, onChecking: hooks.onChecking, signal: hooks.signal,
      }),
      detector: { scan: vi.fn(() => []) }, store, notifier,
      scanIntervalMs: 60_000, recentWindowMs: 86_400_000,
      observationOnly: false, repairEnabled: true,
      clock: () => 10,
    });

    const repair = service.repairAlert(created.id);
    await vi.waitFor(() => expect(appServer.interrupt).toHaveBeenCalledOnce());
    expect(editMessageText).toHaveBeenCalledOnce();
    const repairRejected = expect(repair).rejects.toThrow("canceled");
    await Promise.all([repairRejected, service.close()]);

    expect(finishRepair).not.toHaveBeenCalled();
    expect(store.getAlert(created.id)).toMatchObject({ state: "checking" });
    expect(editMessageText).toHaveBeenCalledOnce();
    store.close();
  });

  it("keeps a persisted checking alert actionable after restart until terminal edit", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "guardian-recovery-restart-"));
    const databasePath = path.join(directory, "guardian.sqlite");
    const owner = new SessionGuardianStore(databasePath, { repairClaimLeaseMs: 100 });
    const created = owner.createAlert(
      fingerprintOf(snapshot())!, { chatId: -1001, messageThreadId: 2 }, 1,
    );
    owner.recordDelivery(created.id, 321);
    expect(owner.claimRepair(created.id, 10)).toBe(true);
    owner.close();

    const store = new SessionGuardianStore(databasePath, { repairClaimLeaseMs: 100 });
    const editMessageText = vi.fn(async () => undefined);
    const notifier = new SessionGuardianTelegramNotifier({
      sendMessage: vi.fn(), editMessageText,
    });
    const appServer = {
      listRootThreads: vi.fn(async () => [snapshot()]),
      readThread: vi.fn(async () => snapshot()),
      interrupt: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => snapshot("idle")),
      coldReload: vi.fn(async () => snapshot("idle")),
      close: vi.fn(),
    };
    const service = new SessionGuardianService({
      createAppServer: () => appServer,
      createInspectionAppServer: () => appServer,
      createRecovery: (_gateway, hooks) => new SessionGuardianRecovery(appServer, store, {
        clock: () => 110, onChecking: hooks.onChecking,
      }),
      detector: { scan: vi.fn(() => []) }, store, notifier,
      scanIntervalMs: 60_000, recentWindowMs: 86_400_000,
      observationOnly: false, repairEnabled: true,
      clock: () => 110,
    });
    const checking = store.getAlert(created.id)!;
    const delivery = { alertId: created.id, chatId: -1001, messageThreadId: 2, messageId: 321 };

    await notifier.editStatus({ alert: checking, delivery, status: "checking" });
    expect(editMessageText.mock.calls[0]?.[3]).toMatchObject({
      reply_markup: { inline_keyboard: [[{
        text: "Restore", callback_data: `guardian_restore:${created.id}`,
      }]] },
    });
    await service.scan();
    expect(editMessageText).toHaveBeenCalledTimes(1);

    await expect(service.repairAlert(created.id)).resolves.toMatchObject({ outcome: "restored" });
    expect(editMessageText).toHaveBeenLastCalledWith(
      -1001, 321, expect.stringContaining("Restored"),
      expect.objectContaining({ reply_markup: { inline_keyboard: [] } }),
    );
    expect(store.getAlert(created.id)).toMatchObject({
      state: "restored", statusDeliveryState: "delivered",
    });
    await service.close();
    store.close();
  });
});
