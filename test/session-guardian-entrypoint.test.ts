import { describe, expect, it, vi } from "vitest";

import {
  createGuardianScanAppServer,
  createGuardianInspectionAppServer,
  GUARDIAN_INSPECTION_TOTAL_TIMEOUT_MS,
  GUARDIAN_SCAN_READ_TOTAL_TIMEOUT_MS,
  guardianOperationalStatusResponse,
  startGuardianDaemonLifecycle,
} from "../src/session-guardian.js";

describe("session guardian daemon lifecycle", () => {
  it("bounds the production scan read phase at four seconds", () => {
    const client = { request: vi.fn(), close: vi.fn() };
    const gateway = { readThread: vi.fn(), close: vi.fn() };
    const createClient = vi.fn(() => client);
    const createAppServer = vi.fn(() => gateway);

    expect(createGuardianScanAppServer("/run/codex-app-server.sock", {
      createClient,
      createAppServer,
    })).toBe(gateway);

    expect(GUARDIAN_SCAN_READ_TOTAL_TIMEOUT_MS).toBe(4_000);
    expect(createClient).toHaveBeenCalledWith("/run/codex-app-server.sock", {});
    expect(createAppServer).toHaveBeenCalledWith(client, {
      listRootThreadsTimeoutMs: 4_000,
    });
  });

  it("bounds the dedicated inspection app-server total budget at ten seconds", () => {
    const client = { request: vi.fn(), close: vi.fn() };
    const gateway = { readThread: vi.fn(), close: vi.fn() };
    const createClient = vi.fn(() => client);
    const createAppServer = vi.fn(() => gateway);

    expect(createGuardianInspectionAppServer("/run/codex-app-server.sock", {
      createClient,
      createAppServer,
    })).toBe(gateway);

    expect(GUARDIAN_INSPECTION_TOTAL_TIMEOUT_MS).toBe(10_000);
    expect(createClient).toHaveBeenCalledWith("/run/codex-app-server.sock", {
      requestMs: 10_000,
    });
    expect(createAppServer).toHaveBeenCalledWith(client, {
      requestTimeoutMs: 10_000,
    });
  });

  it("reports ready only for a running, connected, fresh scanner", () => {
    const base = {
      running: true,
      observationOnly: true,
      repairEnabled: false,
      appServerConnected: true,
      scanStale: false,
      scans: 1,
      lastScanAt: 10,
      queueDepth: 0,
      activeOperation: "idle",
      scanPhase: "idle",
      inspectionCount: 0,
    } as const;

    expect(guardianOperationalStatusResponse(base)).toMatchObject({ outcome: "ok" });
    expect(guardianOperationalStatusResponse({ ...base, running: false }))
      .toMatchObject({ outcome: "degraded" });
    expect(guardianOperationalStatusResponse({ ...base, appServerConnected: false }))
      .toMatchObject({ outcome: "degraded" });
    expect(guardianOperationalStatusResponse({ ...base, scanStale: true }))
      .toMatchObject({ outcome: "degraded" });
  });

  it("sets a private umask before creating state or socket components", async () => {
    const events: string[] = [];
    const components = {
      store: { close: vi.fn(() => events.push("store.close")) },
      service: { start: vi.fn(() => events.push("service.start")),
        quiesceScanning: vi.fn(async () => { events.push("service.quiesce"); }),
        close: vi.fn(async () => { events.push("service.close"); }) },
      ipc: { start: vi.fn(async () => { events.push("ipc.start"); }),
        close: vi.fn(async () => { events.push("ipc.close"); }) },
    };
    const runtime = await startGuardianDaemonLifecycle({
      setUmask: (mask) => { expect(mask).toBe(0o077); events.push("umask"); },
      createComponents: () => { events.push("create"); return components; },
      retryDelay: async () => undefined,
    });

    expect(events).toEqual(["umask", "create", "ipc.start", "service.start"]);
    await runtime.shutdown();
    expect(events.slice(4)).toEqual([
      "service.close", "ipc.close", "store.close",
    ]);
  });

  it("keeps the store until IPC drain retry succeeds after starting service cancellation", async () => {
    const events: string[] = [];
    let closes = 0;
    const runtime = await startGuardianDaemonLifecycle({
      setUmask: () => undefined,
      createComponents: () => ({
        store: { close: () => events.push("store.close") },
        service: { start: () => undefined,
          quiesceScanning: async () => { events.push("service.quiesce"); },
          close: async () => { events.push("service.close"); } },
        ipc: { start: async () => undefined, close: async () => {
          closes += 1;
          events.push(`ipc.close.${closes}`);
          if (closes === 1) throw new Error("Guardian IPC handlers did not drain");
        } },
      }),
      retryDelay: async () => { events.push("retry"); },
    });

    await runtime.shutdown();

    expect(events).toEqual([
      "service.close", "ipc.close.1", "retry", "ipc.close.2", "store.close",
    ]);
  });

  it("cleans partial startup in reverse order without exposing the primary detail", async () => {
    const events: string[] = [];
    await expect(startGuardianDaemonLifecycle({
      setUmask: () => undefined,
      createComponents: () => ({
        store: { close: () => events.push("store.close") },
        service: { start: () => { throw new Error("start secret"); },
          quiesceScanning: async () => { events.push("service.quiesce"); },
          close: async () => { events.push("service.close"); } },
        ipc: { start: async () => { events.push("ipc.start"); },
          close: async () => { events.push("ipc.close"); } },
      }),
      retryDelay: async () => undefined,
    })).rejects.toThrow("Guardian daemon startup failed");
    expect(events).toEqual([
      "ipc.start", "service.close", "ipc.close", "store.close",
    ]);
  });

  it("starts full service close without waiting for quiesce or IPC callback drain", async () => {
    const events: string[] = [];
    let releaseQuiesce!: () => void;
    const quiesced = new Promise<void>((resolve) => { releaseQuiesce = resolve; });
    let releaseDrain!: () => void;
    const drained = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const runtime = await startGuardianDaemonLifecycle({
      setUmask: () => undefined,
      createComponents: () => ({
        store: { close: () => events.push("store.close") },
        service: { start: () => undefined,
          quiesceScanning: async () => { events.push("service.quiesce"); await quiesced; },
          close: async () => {
            events.push("service.close");
            releaseQuiesce();
            releaseDrain();
          } },
        ipc: { start: async () => undefined, close: async () => {
          events.push("ipc.drain.start");
          await drained;
          events.push("ipc.drain.done");
        } },
      }),
      retryDelay: async () => undefined,
    });
    const shutdown = runtime.shutdown();
    const outcome = await Promise.race([
      shutdown.then(() => "closed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    if (outcome === "blocked") {
      releaseQuiesce();
      await shutdown;
    }

    expect(outcome).toBe("closed");
    expect(events).toEqual([
      "service.close", "ipc.drain.start", "ipc.drain.done", "store.close",
    ]);
  });
});
