import path from "node:path";

import { createBot, registerCommands } from "./bot.js";
import type { TelegramBotReliability } from "./bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig } from "./config.js";
import {
  createTeleCodexLifecycle,
  runTeleCodexShutdownSafely,
} from "./lifecycle.js";
import {
  createModeAwareMiniAppProbeProvider,
  isGuardianReadyResponse,
  startConfiguredMiniApp,
} from "./mini-app-runtime.js";
import {
  checkTelegramApiAvailability,
  type RunningMiniAppServer,
} from "./mini-app-server.js";
import { restartPollingAfterDelay } from "./polling-lifecycle.js";
import { SessionGuardianIpcClient } from "./session-guardian-ipc-client.js";
import { SessionRegistry } from "./session-registry.js";
import { TelegramBackgroundWriteGate } from "./telegram-background-write-gate.js";
import {
  formatTelegramErrorLog,
  isTelegramPollingConflict,
  type TelegramLogOperation,
} from "./telegram-error-log.js";
import {
  classifyTelegramStatusError,
  createTelegramAttachmentDownloader,
  createTelegramDeliveryTransport,
  createTelegramStatusTransport,
} from "./telegram-grammy-transport.js";
import { prepareTelegramJobStoreMode } from "./telegram-job-migration.js";
import { TelegramJobRetentionRuntime } from "./telegram-job-retention-runtime.js";
import {
  LegacyTelegramJobStoreProbe,
  SqliteTelegramJobStore,
} from "./telegram-job-store.js";
import {
  boundedReliabilityProbeTimeoutMs,
  createTelegramReliabilityRuntime,
  type TelegramReliabilityRuntime,
  type TelegramReliabilityRuntimeOperation,
} from "./telegram-reliability-runtime.js";
import { createTelegramTopicRecoveryAdapter } from "./telegram-topic-recovery-adapter.js";
import { createTelegramTopicResumeAdapter } from "./telegram-topic-resume-adapter.js";
import { createTelegramGuardianRuntimeFacade }
  from "./telegram-guardian-reconciliation.js";
import type { TelegramCompletionProcessor } from "./telegram-inbox-completion.js";
import {
  startTelegramRunner,
  startTelegramRunnerAfterReconciliation,
} from "./telegram-runner.js";
import { TopicSynchronizer } from "./topic-sync.js";
import { transcribeAudio } from "./voice.js";
import type { RunnerHandle } from "@grammyjs/runner";

const RUNTIME_LOG_OPERATION = {
  status_refresh: "status_edit",
  delivery: "reliability",
  coordinator: "reliability",
  reconciliation: "reliability",
} satisfies Record<TelegramReliabilityRuntimeOperation, TelegramLogOperation>;

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let topicSynchronizer: TopicSynchronizer | undefined;
let runner: RunnerHandle | undefined;
let miniAppServer: RunningMiniAppServer | undefined;
let reliabilityRuntime: TelegramReliabilityRuntime | undefined;
let retentionRuntime: TelegramJobRetentionRuntime | undefined;
let sqliteJobStore: SqliteTelegramJobStore | undefined;
let guardianClient: SessionGuardianIpcClient | undefined;
let guardianProbeClient: SessionGuardianIpcClient | undefined;
let backgroundWriteGate: TelegramBackgroundWriteGate | undefined;
let recoveryStarted = false;
let reconciliationComplete = false;
let pollingOwned = false;
let shuttingDown = false;

const lifecycle = createTeleCodexLifecycle({
  onBegin: () => {
    shuttingDown = true;
    pollingOwned = false;
  },
  resources: () => ({
    topicSynchronizer,
    statusBoard: bot?.statusBoard,
    miniAppServer,
    runner,
    retentionRuntime,
    reliabilityRuntime,
    backgroundWriteGate,
    sqliteJobStore,
    registry,
  }),
  onCleanupError: (step, error) => {
    if (step === "mini-app") {
      console.warn(formatTelegramErrorLog("cleanup", error));
    } else if (step === "retention-runtime") {
      console.warn("Failed to stop Telegram retention runtime cleanly");
    } else if (step === "reliability-runtime") {
      console.warn("Failed to stop Telegram reliability runtime cleanly");
    } else {
      console.warn(formatTelegramErrorLog("cleanup", error));
    }
  },
  onRunnerStopIncomplete: () => {
    console.log("Active jobs remain persisted and will reconnect after restart.");
  },
  exit: (code) => {
    if (code === 0) console.log("TeleCodex stopped.");
    process.exit(code);
  },
});

try {
  const config = loadConfig();
  registry = new SessionRegistry(config);
  const storeMode = prepareTelegramJobStoreMode({
    mode: config.telegramJobs.storeMode,
    sourcePath: config.telegramJobs.legacyJsonPath,
    databasePath: config.telegramJobs.databasePath,
  });
  if (storeMode.authority === "json" && storeMode.failure) {
    console.warn(`Telegram job shadow unavailable: ${storeMode.failure.code}`);
  }
  const canonical = storeMode.authority === "sqlite";
  const legacyJobStoreProbe = new LegacyTelegramJobStoreProbe(config.telegramJobs.legacyJsonPath);
  if (config.telegramJobs.storeMode !== "json") {
    sqliteJobStore = new SqliteTelegramJobStore(config.telegramJobs.databasePath);
  }
  const dependencyProbeTimeoutMs = boundedReliabilityProbeTimeoutMs(
    config.reliabilityTimeouts.appServerConnectMs,
  );
  guardianProbeClient = config.telegramJobs.storeMode !== "json" && config.sessionGuardianSocketPath
    ? new SessionGuardianIpcClient(config.sessionGuardianSocketPath, {
        requestTimeoutMs: dependencyProbeTimeoutMs,
      })
    : undefined;
  let completionProcessor: TelegramCompletionProcessor | undefined;
  const reliabilityFacade: TelegramBotReliability | undefined = canonical ? {
    handleWork: (source) => requireReliabilityRuntime().handleWork(source),
    registerCompletionProcessor: (processor) => { completionProcessor = processor; },
    latestJob: (context) => requireReliabilityRuntime().latestJob(context),
    retry: (input) => requireReliabilityRuntime().retry(input),
    abort: (input) => requireReliabilityRuntime().abort(input),
    loadDashboardReliability: (limit) => requireReliabilityRuntime().loadDashboardReliability(limit),
    loadDashboardSessionStatuses: () => requireReliabilityRuntime().loadDashboardSessionStatuses(),
    runDashboardAction: (action, context) => requireReliabilityRuntime().runDashboardAction(action, context),
  } : undefined;
  backgroundWriteGate = new TelegramBackgroundWriteGate({
    maxPerWindow: 12,
    windowMs: 60_000,
    burst: 3,
  });
  bot = createBot(config, registry, reliabilityFacade, { backgroundWriteGate });
  if (canonical) {
    const canonicalJobStore = requireSqliteJobStore();
    const materializationRoot = path.join(config.workspace, ".telecodex", "materialized");
    guardianClient = config.sessionGuardianSocketPath
      ? new SessionGuardianIpcClient(config.sessionGuardianSocketPath, {
          requestTimeoutMs: config.reliabilityTimeouts.appServerRequestMs,
        })
      : undefined;
    const guardian = guardianClient && guardianProbeClient
      ? createTelegramGuardianRuntimeFacade({
          operational: guardianClient,
          probe: guardianProbeClient,
      })
      : { inspectThread: async (_threadId: string) => { throw new Error("Guardian unavailable"); } };
    const topicRecovery = createTelegramTopicRecoveryAdapter({
      enabled: config.telegramTopicRecoveryEnabled,
      forumChatId: config.telegramForumChatId,
      creationTimeoutMs: config.reliabilityTimeouts.telegramDeliveryMs,
      api: bot.api,
      registry,
      reportReason: ({ reasonCode }) => {
        console.warn(`Telegram topic recovery: ${reasonCode}`);
      },
    });
    const topicResume = config.telegramForumChatId !== undefined
      ? createTelegramTopicResumeAdapter({
          token: config.telegramBotToken,
          forumChatId: config.telegramForumChatId ?? 0,
          registry,
        })
      : undefined;
    reliabilityRuntime = createTelegramReliabilityRuntime({
      store: canonicalJobStore,
      registry,
      materializationRoot,
      exactTurnReader: registry.getAppServerClient(),
      checkAppServer: () => registry!.checkAppServerConnectivity(
        dependencyProbeTimeoutMs,
      ),
      checkTelegram: async (signal) => {
        if (!await checkTelegramApiAvailability(bot!.api, signal)) {
          throw new Error("Telegram API unavailable");
        }
      },
      guardian,
      createForumTopic: async ({ chatId, topicName, signal }) => {
        const topic = await bot!.api.createForumTopic(chatId, topicName, {}, signal as never);
        return { chatId, messageThreadId: topic.message_thread_id };
      },
      targetProvisionTimeoutMs: config.reliabilityTimeouts.telegramDeliveryMs,
      downloadAttachment: createTelegramAttachmentDownloader({
        api: bot.api,
        botToken: config.telegramBotToken,
        maxBytes: config.maxFileSize,
        timeoutMs: config.reliabilityTimeouts.telegramDeliveryMs,
      }),
      transcribeAttachment: async ({ absolutePath }) => (await transcribeAudio(absolutePath)).text,
      statusTransport: createTelegramStatusTransport(
        bot.api,
        config.reliabilityTimeouts.telegramDeliveryMs,
        backgroundWriteGate,
      ),
      classifyStatusTransportError: classifyTelegramStatusError,
      deliveryTransport: createTelegramDeliveryTransport(bot.api, materializationRoot),
      attachmentRoot: materializationRoot,
      materializationTimeoutMs: config.reliabilityTimeouts.appServerRequestMs,
      deliveryTimeoutMs: config.reliabilityTimeouts.telegramDeliveryMs,
      maxAttempts: config.telegramJobs.maxAttempts,
      ...(topicRecovery ? { topicRecovery } : {}),
      ...(topicResume ? {
        topicResume: {
          ...topicResume,
          allowedModes: new Set([
            ...(config.telegramTopicResumeEnabled ? ["standard" as const] : []),
            ...(config.telegramTopicWarningReplayEnabled ? ["warning_replay" as const] : []),
          ]),
          operationTimeoutMs: config.reliabilityTimeouts.telegramDeliveryMs,
        },
      } : {}),
      prepareCompletion: async (input) => {
        if (!completionProcessor) throw new Error("Telegram completion processor is unavailable");
        return completionProcessor(input);
      },
      onRuntimeError: ({ operation, error }) => {
        console.error(formatTelegramErrorLog(RUNTIME_LOG_OPERATION[operation], error));
      },
    });
    retentionRuntime = new TelegramJobRetentionRuntime({
      store: canonicalJobStore,
      materializationRoot,
      payloadRetentionMs: config.telegramJobs.payloadRetentionDays * 24 * 60 * 60 * 1_000,
      metadataRetentionMs: config.telegramJobs.metadataRetentionDays * 24 * 60 * 60 * 1_000,
      initialDelayMs: config.telegramJobs.retentionInitialDelaySeconds * 1_000,
      onEvent: (event) => {
        if (event.code === "SWEEP_COMPLETED") {
          if (event.payloadsPurged || event.jobsDeleted || event.filesDeleted) {
            console.log(
              `Telegram retention: purged=${event.payloadsPurged ?? 0}, deleted=${event.jobsDeleted ?? 0}, files=${event.filesDeleted ?? 0}`,
            );
          }
          return;
        }
        console.warn(`Telegram retention: ${event.code}`);
      },
    });
  }
  await registerCommands(bot);

  console.log("TeleCodex running");
  const authStatus = await checkAuthStatus(config.codexApiKey);
  console.log(`Auth: ${authStatus.authenticated ? "authenticated" : "not authenticated"} (${authStatus.method})`);
  if (!authStatus.authenticated) {
    console.warn("Warning: Codex is not authenticated. Use /login or set CODEX_API_KEY.");
  }
  console.log(`Workspace: ${config.workspace}`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  console.log(
    `Model choices: ${config.modelChoices
      .map((choice) => `${choice.id}=${choice.provider}/${choice.model}`)
      .join(", ") || "legacy-openai"}`,
  );
  console.log(`Default model choice: ${config.defaultModelChoiceId ?? "legacy-openai"}`);
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per Telegram context");
  if (config.telegramForumChatId && config.topicSyncEnabled) {
    topicSynchronizer = new TopicSynchronizer({
      chatId: config.telegramForumChatId,
      intervalMs: config.topicSyncIntervalMs ?? 30_000,
      registry,
      createForumTopic: (chatId, name) => bot!.api.createForumTopic(chatId, name),
    });
    topicSynchronizer.start();
    console.log(
      `Topic sync: enabled for ${config.telegramForumChatId} every ${(config.topicSyncIntervalMs ?? 30_000) / 1000}s`,
    );
  }

  if (bot.statusBoard) {
    bot.statusBoard.start();
    console.log(`Status board: closed Dashboard topic in ${config.telegramForumChatId}, every ${config.statusBoardIntervalMs / 1000}s`);
  }

  if (bot.jiraPanel && config.jiraPanel) {
    console.log(`Jira panel: configured for ${config.jiraPanel.chatId}:${config.jiraPanel.topicId}`);
  }

  if (config.miniApp) {
    if (!bot.dashboard) {
      throw new Error("Mini App dashboard controller is unavailable");
    }
    miniAppServer = await startConfiguredMiniApp({
      config: config.miniApp,
      botToken: config.telegramBotToken,
      allowedUserIds: config.telegramAllowedUserIdSet,
      dashboard: bot.dashboard,
      probes: createModeAwareMiniAppProbeProvider({
        mode: config.telegramJobs.storeMode,
        storeMode,
        legacy: legacyJobStoreProbe,
        ...(sqliteJobStore ? { sqlite: sqliteJobStore } : {}),
        reconciliationComplete: () => reconciliationComplete,
        pollingOwned: () => pollingOwned,
        dependencies: [
          {
            unavailableCode: "APP_SERVER_UNAVAILABLE",
            check: async () => {
              try {
                await registry!.checkAppServerConnectivity(
                  boundedReliabilityProbeTimeoutMs(
                    config.reliabilityTimeouts.appServerConnectMs,
                  ),
                );
                return true;
              } catch { return false; }
            },
          },
          ...(guardianProbeClient ? [{
            unavailableCode: "GUARDIAN_UNAVAILABLE" as const,
            check: async () => {
              try {
                const response = await guardianProbeClient!.status();
                return isGuardianReadyResponse(response);
              } catch { return false; }
            },
          }] : []),
          {
            unavailableCode: "TELEGRAM_UNAVAILABLE",
            check: (signal) => checkTelegramApiAvailability(bot!.api, signal),
          },
        ],
      }),
      jira: bot.jiraMiniApp,
    });
    console.log(`Mini App launcher: ${config.miniApp.launchUrl}`);
  }

} catch (error) {
  console.error(formatTelegramErrorLog("startup", error));
  await lifecycle.terminate({ exitCode: 1, runner: "inactive" });
}

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (!shuttingDown) {
    console.log(`Received ${signal}, shutting down TeleCodex...`);
  }
  await lifecycle.terminate({ exitCode: 0, runner: "stop" });
};

const reportShutdownFailure = (error: unknown): void => {
  console.error(formatTelegramErrorLog("cleanup", error));
};
process.once("SIGINT", () => {
  runTeleCodexShutdownSafely(() => shutdown("SIGINT"), reportShutdownFailure);
});
process.once("SIGTERM", () => {
  runTeleCodexShutdownSafely(() => shutdown("SIGTERM"), reportShutdownFailure);
});

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    if (!recoveryStarted) {
      const reconciledRunner = await startTelegramRunnerAfterReconciliation(
        bot!,
        reliabilityRuntime
            ? async () => {
              await reliabilityRuntime!.reconcile();
            }
          : async () => {
              await bot!.recoverPendingJobs();
            },
        startTelegramRunner,
        () => !shuttingDown,
      );
      if (!reconciledRunner) return;
      runner = reconciledRunner;
      recoveryStarted = true;
      reconciliationComplete = true;
      retentionRuntime?.start();
    } else {
      runner = startTelegramRunner(bot!);
    }
    pollingOwned = true;
    await runner.task();
    pollingOwned = false;
    restartAttempts = 0;
  } catch (error) {
    pollingOwned = false;
    if (shuttingDown) {
      return;
    }

    if (isTelegramPollingConflict(error) && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(formatTelegramErrorLog("polling", error));
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      return restartPollingAfterDelay({
        delayMs: RESTART_DELAY_MS,
        isShuttingDown: () => shuttingDown,
        restart: startPolling,
      });
    }

    console.error(formatTelegramErrorLog("polling", error));
    await lifecycle.terminate({ exitCode: 1, runner: "inactive" });
  }
}

await startPolling();

function requireReliabilityRuntime(): TelegramReliabilityRuntime {
  if (!reliabilityRuntime) throw new Error("Telegram reliability runtime is not initialized");
  return reliabilityRuntime;
}

function requireSqliteJobStore(): SqliteTelegramJobStore {
  if (!sqliteJobStore) throw new Error("Telegram SQLite job store is not initialized");
  return sqliteJobStore;
}
