import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { AppServerClient, type AppServerClientTimeouts } from "./app-server-client.js";
import { SessionGuardianAppServer, type SessionGuardianAppServerClient,
  type SessionGuardianAppServerOptions } from "./session-guardian-app-server.js";
import { loadSessionGuardianEnvironment, parseSessionGuardianConfig }
  from "./session-guardian-config.js";
import { SessionGuardianDetector } from "./session-guardian-detector.js";
import type { GuardianDaemonStatus } from "./session-guardian-ipc-client.js";
import { SessionGuardianIpcServer, type GuardianIpcResponse } from "./session-guardian-ipc.js";
import { ensurePrivateParent } from "./session-guardian-ipc-lifecycle.js";
import { SessionGuardianRecovery } from "./session-guardian-recovery.js";
import { SessionGuardianRouter } from "./session-guardian-routing.js";
import { SessionGuardianService, type GuardianServiceAppServer }
  from "./session-guardian-service.js";
import { SessionGuardianStore } from "./session-guardian-store.js";
import { SessionGuardianTelegramNotifier } from "./session-guardian-telegram.js";
import { createGuardianTelegramApi, GUARDIAN_TELEGRAM_RETRY_OPTIONS }
  from "./session-guardian-telegram-api.js";

interface GuardianDaemonStore { close(): void }
export const GUARDIAN_INSPECTION_TOTAL_TIMEOUT_MS = 10_000;
export const GUARDIAN_SCAN_READ_TOTAL_TIMEOUT_MS = 4_000;
export interface GuardianInspectionAppServerFactoryDependencies {
  readonly createClient: (
    socketPath: string,
    timeouts: AppServerClientTimeouts,
  ) => SessionGuardianAppServerClient;
  readonly createAppServer: (
    client: SessionGuardianAppServerClient,
    options: SessionGuardianAppServerOptions,
  ) => GuardianServiceAppServer;
}
const DEFAULT_INSPECTION_APP_SERVER_FACTORY: GuardianInspectionAppServerFactoryDependencies = {
  createClient: (socketPath, timeouts) => new AppServerClient(socketPath, timeouts),
  createAppServer: (client, options) => new SessionGuardianAppServer(client, options),
};

export function createGuardianScanAppServer(
  socketPath: string,
  dependencies: GuardianInspectionAppServerFactoryDependencies =
    DEFAULT_INSPECTION_APP_SERVER_FACTORY,
): GuardianServiceAppServer {
  const client = dependencies.createClient(socketPath, {});
  return dependencies.createAppServer(client, {
    listRootThreadsTimeoutMs: GUARDIAN_SCAN_READ_TOTAL_TIMEOUT_MS,
  });
}

interface GuardianDaemonService {
  start(): void;
  quiesceScanning(): Promise<void>;
  close(): Promise<void>;
}
interface GuardianDaemonIpc { start(): Promise<void>; close(): Promise<void> }

interface GuardianDaemonComponents {
  readonly store: GuardianDaemonStore;
  readonly service: GuardianDaemonService;
  readonly ipc: GuardianDaemonIpc;
}

export interface GuardianDaemonLifecycleOptions {
  readonly setUmask: (mask: number) => unknown;
  readonly createComponents: () => GuardianDaemonComponents | Promise<GuardianDaemonComponents>;
  readonly retryDelay: () => Promise<void>;
}

export interface RunningGuardianDaemon {
  shutdown(): Promise<void>;
}

export function createGuardianInspectionAppServer(
  socketPath: string,
  dependencies: GuardianInspectionAppServerFactoryDependencies =
    DEFAULT_INSPECTION_APP_SERVER_FACTORY,
): GuardianServiceAppServer {
  const client = dependencies.createClient(socketPath, {
    requestMs: GUARDIAN_INSPECTION_TOTAL_TIMEOUT_MS,
  });
  return dependencies.createAppServer(client, {
    requestTimeoutMs: GUARDIAN_INSPECTION_TOTAL_TIMEOUT_MS,
  });
}

export function guardianOperationalStatusResponse(
  status: GuardianDaemonStatus,
): GuardianIpcResponse {
  const ready = status.running && status.appServerConnected && !status.scanStale;
  return { outcome: ready ? "ok" : "degraded",
    message: "Guardian operational status", status };
}

export async function startGuardianDaemonLifecycle(
  options: GuardianDaemonLifecycleOptions,
): Promise<RunningGuardianDaemon> {
  options.setUmask(0o077);
  let components: GuardianDaemonComponents;
  try { components = await options.createComponents(); }
  catch { throw new Error("Guardian daemon startup failed"); }
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= shutdownComponents(components, options.retryDelay);
    return shutdownPromise;
  };
  try {
    await components.ipc.start();
    components.service.start();
  } catch {
    await shutdown();
    throw new Error("Guardian daemon startup failed");
  }
  return Object.freeze({ shutdown });
}

async function shutdownComponents(
  components: GuardianDaemonComponents,
  retryDelay: () => Promise<void>,
): Promise<void> {
  const serviceClose = components.service.close();
  void serviceClose.catch(() => undefined);
  while (true) {
    try { await components.ipc.close(); break; }
    catch { await retryDelay(); }
  }
  try { await serviceClose; }
  finally { components.store.close(); }
}

export async function startSessionGuardianDaemon(): Promise<RunningGuardianDaemon> {
  return await startGuardianDaemonLifecycle({
    setUmask: (mask) => process.umask(mask),
    retryDelay: () => new Promise((resolve) => setTimeout(resolve, 250)),
    createComponents: createProductionComponents,
  });
}

async function createProductionComponents(): Promise<GuardianDaemonComponents> {
  const loaded = loadSessionGuardianEnvironment({ cwd: process.cwd(), env: process.env });
  const config = parseSessionGuardianConfig(loaded.env, {
    home: os.homedir(),
    workspace: loaded.workspace,
  });
  if (!config.fallbackRoute) {
    throw new Error("Guardian fallback Telegram chat and topic are required");
  }
  const telegramBotToken = loaded.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
  await ensurePrivateParent(path.dirname(config.databasePath));
  const store = new SessionGuardianStore(config.databasePath);
  try {
    const router = new SessionGuardianRouter(
      path.join(loaded.workspace, ".telecodex", "contexts.json"),
      config.fallbackRoute,
    );
    const detector = new SessionGuardianDetector(store, (threadId) => router.route(threadId), {
      staleAfterMs: config.staleAfterMs,
      confirmationsRequired: config.confirmationsRequired,
    });
    const bot = new Bot(telegramBotToken);
    bot.api.config.use(autoRetry(GUARDIAN_TELEGRAM_RETRY_OPTIONS));
    const notifier = new SessionGuardianTelegramNotifier(createGuardianTelegramApi({
      sendMessage: (chatId, text, options, signal) =>
        bot.api.sendMessage(chatId, text, options, signal as never),
      editMessageText: (chatId, messageId, text, options, signal) =>
        bot.api.editMessageText(chatId, messageId, text, options, signal as never),
    }));
    const service = new SessionGuardianService({
      createAppServer: () => createGuardianScanAppServer(config.appServerSocketPath),
      createInspectionAppServer: () => createGuardianInspectionAppServer(
        config.appServerSocketPath,
      ),
      createRecovery: (appServer, hooks) => new SessionGuardianRecovery(
        appServer as SessionGuardianAppServer,
        store,
        { observationOnly: config.observationOnly, onChecking: hooks.onChecking,
          signal: hooks.signal },
      ),
      detector,
      store,
      notifier,
      scanIntervalMs: config.scanIntervalMs,
      recentWindowMs: config.recentWindowMs,
      observationOnly: config.observationOnly,
      repairEnabled: config.repairEnabled,
    });
    const ipc = new SessionGuardianIpcServer({
      socketPath: config.socketPath,
      status: (): GuardianIpcResponse => guardianOperationalStatusResponse(service.status()),
      scan: () => service.scan(),
      inspectThread: (threadId) => service.inspectThread(threadId),
      repairThread: (threadId) => service.repairThread(threadId),
      checkAlert: (alertId) => service.checkAlert(alertId),
      repairAlert: (alertId) => service.repairAlert(alertId),
    });
    return { store, service, ipc };
  } catch (error) {
    store.close();
    throw error;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const runtime = await startSessionGuardianDaemon();
    console.log("Codex Session Guardian running");
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { await runtime.shutdown(); }
      catch { process.exitCode = 1; }
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch {
    console.error("Failed to start Codex Session Guardian");
    process.exitCode = 1;
  }
}
