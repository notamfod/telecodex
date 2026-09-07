import type { DashboardController } from "../src/dashboard-controller.js";
import type { MiniAppServerOptions } from "../src/mini-app-server.js";
import type { JiraMiniAppController } from "../src/jira-mini-app.js";
import {
  createModeAwareMiniAppProbeProvider,
  isGuardianReadyResponse,
  startConfiguredMiniApp,
} from "../src/mini-app-runtime.js";

describe("Mini App runtime", () => {
  it("maps application config and dashboard actions to the HTTP server", async () => {
    const dashboard: DashboardController = {
      loadDashboard: vi.fn(async () => ({ generatedAt: 1 } as never)),
      ensureTopic: vi.fn(async () => ({ created: true, url: "https://t.me/c/1/2" })),
      runJobAction: vi.fn(async () => undefined),
    };
    const jira = {
      getMySprint: vi.fn(),
      getSprint: vi.fn(),
      getKanban: vi.fn(),
      getFilters: vi.fn(),
      runFilter: vi.fn(),
      getIssue: vi.fn(),
      ensureThread: vi.fn(),
    } as unknown as JiraMiniAppController;
    let received: MiniAppServerOptions | undefined;
    const running = { url: "http://127.0.0.1:8787", close: vi.fn(async () => {}) };

    await expect(startConfiguredMiniApp({
      config: {
        launchUrl: "https://dashboard.example.test/",
        host: "127.0.0.1",
        port: 8787,
        authMaxAgeSeconds: 3600,
        staticDir: "/tmp/dist-web",
      },
      botToken: "token",
      allowedUserIds: new Set([42]),
      dashboard,
      jira,
    }, async (options) => {
      received = options;
      return running;
    })).resolves.toBe(running);

    expect(received).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      staticDir: "/tmp/dist-web",
      botToken: "token",
      authMaxAgeSeconds: 3600,
      jira,
    });
    await expect(received!.loadDashboard()).resolves.toEqual({ generatedAt: 1 });
    await expect(received!.ensureTopic("thread-id")).resolves.toEqual({
      created: true,
      url: "https://t.me/c/1/2",
    });
    await expect(received!.runJobAction!({
      kind: "inspect",
      jobId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 1,
    })).resolves.toBeUndefined();
  });

  it("treats a clean JSON-authoritative shadow as migration-complete and probes authority plus candidate", async () => {
    const legacy = storeProbe();
    const sqlite = storeProbe();
    const provider = createModeAwareMiniAppProbeProvider({
      mode: "shadow",
      storeMode: { authority: "json", sqliteEligible: true, failure: null },
      legacy,
      sqlite,
      reconciliationComplete: () => true,
      pollingOwned: () => true,
      dependencies: [],
    });

    await expect(provider.health()).resolves.toEqual({ ok: true, reasonCodes: [] });
    await expect(provider.readiness()).resolves.toEqual({ ok: true, reasonCodes: [] });
    expect(legacy.probeReadable).toHaveBeenCalledTimes(2);
    expect(legacy.probeWritable).toHaveBeenCalledOnce();
    expect(sqlite.probeReadable).toHaveBeenCalledOnce();
    expect(sqlite.probeWritable).toHaveBeenCalledOnce();
  });

  it("keeps shadow health green when only the candidate store becomes unavailable", async () => {
    const legacy = storeProbe();
    const sqlite = storeProbe();
    sqlite.probeReadable.mockImplementation(() => { throw new Error("candidate unavailable"); });
    const provider = createModeAwareMiniAppProbeProvider({
      mode: "shadow",
      storeMode: { authority: "json", sqliteEligible: true, failure: null },
      legacy,
      sqlite,
      reconciliationComplete: () => true,
      pollingOwned: () => true,
      dependencies: [],
    });

    await expect(provider.health()).resolves.toEqual({ ok: true, reasonCodes: [] });
    await expect(provider.readiness()).resolves.toEqual({
      ok: false,
      reasonCodes: ["STORE_UNAVAILABLE"],
    });
  });

  it("keeps legacy JSON operational without opening SQLite or reporting migration pending", async () => {
    const legacy = storeProbe();
    const provider = createModeAwareMiniAppProbeProvider({
      mode: "json",
      storeMode: { authority: "json", sqliteEligible: false, failure: null },
      legacy,
      reconciliationComplete: () => true,
      pollingOwned: () => true,
      dependencies: [],
    });

    await expect(provider.health()).resolves.toEqual({ ok: true, reasonCodes: [] });
    await expect(provider.readiness()).resolves.toEqual({ ok: true, reasonCodes: [] });
    expect(legacy.probeReadable).toHaveBeenCalledTimes(2);
    expect(legacy.probeWritable).toHaveBeenCalledOnce();
  });

  it("keeps a failed shadow unready without hiding readable candidate storage", async () => {
    const provider = createModeAwareMiniAppProbeProvider({
      mode: "shadow",
      storeMode: {
        authority: "json",
        sqliteEligible: false,
        failure: { code: "IMPORT_JOB_CONFLICT" },
      },
      legacy: storeProbe(),
      sqlite: storeProbe(),
      reconciliationComplete: () => true,
      pollingOwned: () => true,
      dependencies: [],
    });

    await expect(provider.health()).resolves.toEqual({ ok: true, reasonCodes: [] });
    await expect(provider.readiness()).resolves.toEqual({
      ok: false,
      reasonCodes: ["MIGRATION_PENDING"],
    });
  });

  it("probes the canonical SQLite store after cutover", async () => {
    const legacy = storeProbe();
    const sqlite = storeProbe();
    const provider = createModeAwareMiniAppProbeProvider({
      mode: "sqlite",
      storeMode: { authority: "sqlite", sqliteEligible: true, failure: null },
      legacy,
      sqlite,
      reconciliationComplete: () => true,
      pollingOwned: () => true,
      dependencies: [],
    });

    await expect(provider.readiness()).resolves.toEqual({ ok: true, reasonCodes: [] });
    expect(sqlite.probeReadable).toHaveBeenCalledOnce();
    expect(sqlite.probeWritable).toHaveBeenCalledOnce();
    expect(legacy.probeReadable).not.toHaveBeenCalled();
  });

  it("requires Guardian to be healthy and connected to its own app-server", () => {
    expect(isGuardianReadyResponse({
      outcome: "ok",
      status: { running: true, appServerConnected: true, scanStale: false },
    })).toBe(true);
    expect(isGuardianReadyResponse({
      outcome: "degraded",
      status: { running: true, appServerConnected: false, scanStale: false },
    })).toBe(false);
    expect(isGuardianReadyResponse({
      outcome: "ok",
      status: { running: true, appServerConnected: false, scanStale: false },
    })).toBe(false);
    expect(isGuardianReadyResponse({
      outcome: "ok",
      status: { running: true, appServerConnected: true, scanStale: true },
    })).toBe(false);
  });
});

function storeProbe() {
  return {
    probeReadable: vi.fn(() => undefined),
    probeWritable: vi.fn(() => undefined),
  };
}
