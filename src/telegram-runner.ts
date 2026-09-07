import { run, type RunnerHandle } from "@grammyjs/runner";
import type { Bot, Context } from "grammy";

const RUNNER_UPDATE_CONCURRENCY = 100;
const RUNNER_MAX_RETRY_MS = 15 * 60 * 60 * 1000;

export function startTelegramRunner(bot: Bot<Context>): RunnerHandle {
  return run(bot, {
    runner: {
      maxRetryTime: RUNNER_MAX_RETRY_MS,
      retryInterval: "exponential",
    },
    sink: { concurrency: RUNNER_UPDATE_CONCURRENCY },
  });
}

type StartTelegramRunner = (bot: Bot<Context>) => RunnerHandle;

export function startTelegramRunnerAfterReconciliation(
  bot: Bot<Context>,
  reconcileUnfinishedJobs: () => Promise<void>,
  start?: StartTelegramRunner,
): Promise<RunnerHandle>;
export function startTelegramRunnerAfterReconciliation(
  bot: Bot<Context>,
  reconcileUnfinishedJobs: () => Promise<void>,
  start: StartTelegramRunner,
  shouldStart: () => boolean,
): Promise<RunnerHandle | undefined>;
export async function startTelegramRunnerAfterReconciliation(
  bot: Bot<Context>,
  reconcileUnfinishedJobs: () => Promise<void>,
  start: StartTelegramRunner = startTelegramRunner,
  shouldStart: () => boolean = () => true,
): Promise<RunnerHandle | undefined> {
  await reconcileUnfinishedJobs();
  if (!shouldStart()) return undefined;
  return start(bot);
}
