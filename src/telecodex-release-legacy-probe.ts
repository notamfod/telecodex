import { existsSync, readFileSync, statSync } from "node:fs";

import type { DeliveryPart } from "./telegram-delivery-ledger.js";
import type { TelegramJob } from "./telegram-job-types.js";
import type { TeleCodexReleasePreflightStore } from "./telecodex-release-preflight.js";

const MAX_LEGACY_RELEASE_BYTES = 64 * 1024 * 1024;
const LEGACY_STATES = new Set([
  "awaiting-model", "waiting", "active", "delivering", "completed", "failed", "aborted",
]);

interface LegacyReleaseJob {
  readonly id: string;
  readonly state: string;
}

export function createLegacyReleasePreflightStore(filePath: string): TeleCodexReleasePreflightStore {
  let snapshot: readonly LegacyReleaseJob[] | undefined;
  const jobs = (): readonly LegacyReleaseJob[] => snapshot ??= readLegacyJobs(filePath);
  const preflightJobs = (): readonly TelegramJob[] => jobs()
    .filter((job) => job.state === "awaiting-model" || job.state === "waiting"
      || job.state === "active" || job.state === "delivering")
    .map((job) => ({
      id: job.id,
      phase: job.state === "active" ? "running"
        : job.state === "delivering" ? "delivering" : "queued",
      attention: { kind: "none" },
    }) as TelegramJob);
  const due = (): readonly DeliveryPart[] => jobs()
    .filter((job) => job.state === "delivering")
    .map((job) => ({ jobId: job.id, partKey: "legacy-delivery", state: "pending" }) as DeliveryPart);

  return {
    probeReleaseReadable: () => { void jobs(); },
    listUnfinished: () => preflightJobs(),
    listStatusCandidates: () => [],
    listDueDeliveries: () => due(),
    listDeliveries: (jobId) => due().filter((part) => part.jobId === jobId),
  };
}

function readLegacyJobs(filePath: string): readonly LegacyReleaseJob[] {
  if (!existsSync(filePath)) return [];
  const size = statSync(filePath).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LEGACY_RELEASE_BYTES) {
    throw new Error("Legacy Telegram job store exceeds release preflight limit");
  }
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Legacy Telegram job store must be an array");
  const ids = new Set<string>();
  return parsed.map((entry) => {
    if (!isLegacyReleaseJob(entry) || ids.has(entry.id)) {
      throw new Error("Legacy Telegram job store contains an invalid job");
    }
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, state: entry.state });
  });
}

function isLegacyReleaseJob(value: unknown): value is LegacyReleaseJob {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 128
    && typeof entry.state === "string" && LEGACY_STATES.has(entry.state);
}
