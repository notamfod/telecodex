import type { MiniAppConfig, TelegramJobStoreMode } from "./config.js";
import type { DashboardController } from "./dashboard-controller.js";
import type { JiraMiniAppController } from "./jira-mini-app.js";
import {
  createMiniAppProbeProvider,
  startMiniAppServer,
  type MiniAppDependencyReasonCode,
  type MiniAppProbeProvider,
  type MiniAppServerOptions,
  type RunningMiniAppServer,
} from "./mini-app-server.js";

export interface MiniAppRuntimeOptions {
  config: MiniAppConfig;
  botToken: string;
  allowedUserIds: ReadonlySet<number>;
  dashboard: DashboardController;
  probes?: MiniAppProbeProvider;
  probeTimeoutMs?: number;
  jira?: JiraMiniAppController;
}

type MiniAppStarter = (
  options: MiniAppServerOptions,
) => Promise<RunningMiniAppServer>;

interface MiniAppStoreProbe {
  probeReadable(timeoutMs?: number): void | Promise<void>;
  probeWritable(timeoutMs?: number): void | Promise<void>;
}

interface MiniAppStoreModeResult {
  readonly authority: "json" | "sqlite";
  readonly sqliteEligible: boolean;
  readonly failure: { readonly code: string } | null;
}

export interface ModeAwareMiniAppProbeOptions {
  mode: TelegramJobStoreMode;
  storeMode: MiniAppStoreModeResult;
  legacy: MiniAppStoreProbe;
  sqlite?: MiniAppStoreProbe;
  migrationComplete?: () => boolean;
  reconciliationComplete(): boolean;
  pollingOwned(): boolean;
  dependencies: ReadonlyArray<{
    readonly unavailableCode: MiniAppDependencyReasonCode;
    check(signal?: AbortSignal): Promise<boolean>;
  }>;
}

export function createModeAwareMiniAppProbeProvider(
  options: ModeAwareMiniAppProbeOptions,
): MiniAppProbeProvider {
  const candidate = options.sqlite ?? unavailableStoreProbe;
  const healthStore = options.mode === "shadow" ? options.legacy
    : options.mode === "json" ? options.legacy : candidate;
  const readStore = options.mode === "shadow"
    ? async () => { await options.legacy.probeReadable(250); await candidate.probeReadable(250); }
    : async () => { await healthStore.probeReadable(250); };
  const writeStore = options.mode === "shadow"
    ? async () => { await options.legacy.probeWritable(250); await candidate.probeWritable(250); }
    : async () => { await healthStore.probeWritable(250); };
  const migrationComplete = options.migrationComplete ?? (() => options.mode === "json" || (
    options.storeMode.sqliteEligible && options.storeMode.failure === null
  ));
  return createMiniAppProbeProvider({
    healthReadStore: async () => { await healthStore.probeReadable(250); },
    readStore,
    writeStore,
    migrationComplete,
    reconciliationComplete: options.reconciliationComplete,
    pollingOwned: options.pollingOwned,
    dependencies: options.dependencies,
  });
}

export function isGuardianReadyResponse(response: {
  readonly outcome?: unknown;
  readonly status?: {
    readonly running?: unknown;
    readonly appServerConnected?: unknown;
    readonly scanStale?: unknown;
  };
}): boolean {
  return response.outcome === "ok"
    && response.status?.running === true
    && response.status.appServerConnected === true
    && response.status.scanStale === false;
}

const unavailableStoreProbe: MiniAppStoreProbe = {
  probeReadable: () => { throw new Error("Store probe is unavailable"); },
  probeWritable: () => { throw new Error("Store probe is unavailable"); },
};

export function startConfiguredMiniApp(
  options: MiniAppRuntimeOptions,
  start: MiniAppStarter = startMiniAppServer,
): Promise<RunningMiniAppServer> {
  return start({
    host: options.config.host,
    port: options.config.port,
    staticDir: options.config.staticDir,
    botToken: options.botToken,
    allowedUserIds: options.allowedUserIds,
    authMaxAgeSeconds: options.config.authMaxAgeSeconds,
    loadDashboard: (query) => options.dashboard.loadDashboard(query),
    ensureTopic: (threadId) => options.dashboard.ensureTopic(threadId),
    ...(options.dashboard.runJobAction
      ? { runJobAction: (action) => options.dashboard.runJobAction(action) }
      : {}),
    ...(options.probes ? { probes: options.probes } : {}),
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    jira: options.jira,
  });
}
