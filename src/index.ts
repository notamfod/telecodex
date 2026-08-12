import { createBot, registerCommands } from "./bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig } from "./config.js";
import { SessionRegistry } from "./session-registry.js";
import { startTelegramRunner } from "./telegram-runner.js";
import { TopicSynchronizer } from "./topic-sync.js";
import type { RunnerHandle } from "@grammyjs/runner";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let topicSynchronizer: TopicSynchronizer | undefined;
let runner: RunnerHandle | undefined;
let recoveryStarted = false;

try {
  const config = loadConfig();
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
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
  if (config.telegramForumChatId) {
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
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start TeleCodex: ${message}`);
  registry?.disposeAll();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down TeleCodex...`);
  topicSynchronizer?.stop();
  const stoppedCleanly = runner
    ? await Promise.race([
        runner.stop().then(() => true, () => false),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ])
    : true;
  if (stoppedCleanly) {
    registry?.disposeAll();
  } else {
    console.log("Active jobs remain persisted and will reconnect after restart.");
  }
  console.log("TeleCodex stopped.");
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    runner = startTelegramRunner(bot!);
    if (!recoveryStarted) {
      recoveryStarted = true;
      void bot!.recoverPendingJobs().catch((error) => {
        console.error("Telegram job recovery failed:", error instanceof Error ? error.message : String(error));
      });
    }
    await runner.task();
    restartAttempts = 0;
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();
