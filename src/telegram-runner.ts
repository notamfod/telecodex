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
