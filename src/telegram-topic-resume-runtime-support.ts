import { createHash } from "node:crypto";

import type { TelegramWorkSource } from "./telegram-job-ingress.js";
import type { SqliteTelegramJobStore } from "./telegram-job-store.js";
import type { TelegramJob } from "./telegram-job-types.js";
import { telegramRetryAfterMs } from "./telegram-rate-limit.js";
import type { TelegramTopicResumeRecord } from "./telegram-topic-resume-ledger.js";
import type { TelegramTopicDestination } from "./telegram-topic-recovery.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_OPERATION_TIMEOUT_MS = 300_000;

export function destinationFromSource(value: unknown): TelegramTopicDestination {
  const source = value as Partial<TelegramWorkSource> | null;
  const target = source?.targetContext ?? source;
  if (!target || !Number.isSafeInteger(target.chatId) || target.chatId === 0
    || !Number.isSafeInteger(target.messageThreadId) || (target.messageThreadId as number) < 1) {
    throw new Error("Malformed Telegram topic resume source");
  }
  return { chatId: target.chatId!, messageThreadId: target.messageThreadId! };
}

export function requireJob(
  store: Pick<SqliteTelegramJobStore, "get">,
  jobId: string,
): TelegramJob {
  const job = store.get(jobId);
  if (!job) throw new Error("Unknown Telegram job");
  return job;
}

export function monotonicNow(
  now: () => number,
  job: TelegramJob,
  resume?: TelegramTopicResumeRecord,
): number {
  return Math.max(now(), job.updatedAt, resume?.updatedAt ?? 0);
}

export function boundedOperationTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error("Invalid Telegram topic resume timeout");
  }
  return timeout;
}

export function boundedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Invalid Telegram topic resume deadline");
  }
  return result;
}

export function eventId(createId: () => string, purpose: string): string {
  return `topic-resume:${purpose}:${createHash("sha256").update(createId()).digest("hex")}`;
}

export function isDefinitiveTelegram4xx(error: unknown): boolean {
  const code = record(error)?.error_code;
  return typeof code === "number" && Number.isFinite(code)
    && code >= 400 && code < 500 && code !== 429;
}

export function immediateTelegramRetryAfterMs(error: unknown): number | undefined {
  return record(error)?.error_code === 429 ? telegramRetryAfterMs(error) : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
