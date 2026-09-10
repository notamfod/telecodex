import type { DeliveryPart } from "./telegram-delivery-ledger.js";
import type { TelegramJob } from "./telegram-job-types.js";

const MAX_UNFINISHED_JOBS = 10_000;
const RELEASE_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$/;
const REASON_ORDER = [
  "ACTIVE_TURN",
  "DELIVERY_SENDING",
  "DELIVERY_PENDING",
  "STORE_UNAVAILABLE",
  "GUARDIAN_UNAVAILABLE",
] as const;

export type TeleCodexReleasePreflightReason = typeof REASON_ORDER[number];

export interface TeleCodexReleasePreflightReport {
  readonly schemaVersion: 1;
  readonly checkedAt: number;
  readonly safeToRestart: boolean;
  readonly reasons: readonly TeleCodexReleasePreflightReason[];
  readonly jobs: {
    readonly queued: number;
    readonly running: number;
    readonly delivering: number;
    readonly attention: number;
  };
  readonly deliveries: {
    readonly pending: number;
    readonly sending: number;
    readonly uncertain: number;
    readonly failed: number;
  };
  readonly guardian: "ready" | "unavailable";
  readonly releaseId: string | null;
}

export interface TeleCodexReleasePreflightStore {
  probeReleaseReadable(limit?: number): void;
  listUnfinished(limit?: number): readonly TelegramJob[];
  listStatusCandidates(limit?: number): readonly TelegramJob[];
  listDueDeliveries(now: number, limit: number): readonly DeliveryPart[];
  listDeliveries(jobId: string): readonly DeliveryPart[];
}

export interface TeleCodexReleasePreflightDependencies {
  checkedAt: () => number;
  releaseId: () => string | null;
  store: TeleCodexReleasePreflightStore;
  guardianStatus: () => Promise<{ readonly running: boolean }>;
}

interface MutableCounts {
  queued: number;
  running: number;
  delivering: number;
  attention: number;
}

interface MutableDeliveryCounts {
  pending: number;
  sending: number;
  uncertain: number;
  failed: number;
}

export async function inspectTeleCodexReleasePreflight(
  dependencies: TeleCodexReleasePreflightDependencies,
): Promise<TeleCodexReleasePreflightReport> {
  const checkedAt = dependencies.checkedAt();
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    throw new Error("Invalid release preflight timestamp");
  }
  const reasons = new Set<TeleCodexReleasePreflightReason>();
  let jobs = emptyJobCounts();
  let deliveries = emptyDeliveryCounts();
  const guardianPromise = inspectGuardian(dependencies.guardianStatus);

  try {
    dependencies.store.probeReleaseReadable(MAX_UNFINISHED_JOBS);
    const unfinished = dependencies.store.listUnfinished(MAX_UNFINISHED_JOBS + 1);
    const statusCandidates = dependencies.store.listStatusCandidates(MAX_UNFINISHED_JOBS + 1);
    const dueDeliveries = dependencies.store.listDueDeliveries(checkedAt, MAX_UNFINISHED_JOBS + 1);
    if (unfinished.length > MAX_UNFINISHED_JOBS || statusCandidates.length > MAX_UNFINISHED_JOBS
      || dueDeliveries.length > MAX_UNFINISHED_JOBS) {
      throw new Error("Release preflight job limit exceeded");
    }
    if (dueDeliveries.length > 0) reasons.add("DELIVERY_PENDING");
    const candidates = new Map(unfinished.map((job) => [job.id, job]));
    for (const job of statusCandidates) candidates.set(job.id, job);
    for (const job of candidates.values()) {
      countJob(job, jobs, reasons);
      for (const part of dependencies.store.listDeliveries(job.id)) {
        countDelivery(job, part, deliveries);
      }
    }
    if (deliveries.sending > 0) reasons.add("DELIVERY_SENDING");
  } catch {
    jobs = emptyJobCounts();
    deliveries = emptyDeliveryCounts();
    reasons.clear();
    reasons.add("STORE_UNAVAILABLE");
  }

  const guardian = await guardianPromise;
  if (guardian === "unavailable") reasons.add("GUARDIAN_UNAVAILABLE");
  const orderedReasons = REASON_ORDER.filter((reason) => reasons.has(reason));
  return Object.freeze({
    schemaVersion: 1,
    checkedAt,
    safeToRestart: orderedReasons.length === 0,
    reasons: Object.freeze(orderedReasons),
    jobs: Object.freeze(jobs),
    deliveries: Object.freeze(deliveries),
    guardian,
    releaseId: safeReleaseId(dependencies.releaseId),
  });
}

function countJob(
  job: TelegramJob,
  counts: MutableCounts,
  reasons: Set<TeleCodexReleasePreflightReason>,
): void {
  if (job.phase === "accepted" || job.phase === "queued") counts.queued += 1;
  if (job.phase === "dispatching" || job.phase === "running") {
    counts.running += 1;
    reasons.add("ACTIVE_TURN");
  }
  if (job.phase === "delivering") counts.delivering += 1;
  if (job.attention.kind === "required") counts.attention += 1;
}

function countDelivery(
  job: TelegramJob,
  part: DeliveryPart,
  counts: MutableDeliveryCounts,
): void {
  if (part.jobId !== job.id) throw new Error("Release preflight delivery mismatch");
  if (part.state === "pending") counts.pending += 1;
  else if (part.state === "sending") counts.sending += 1;
  else if (part.state === "uncertain") counts.uncertain += 1;
  else if (part.state === "failed") counts.failed += 1;
}

async function inspectGuardian(
  status: TeleCodexReleasePreflightDependencies["guardianStatus"],
): Promise<"ready" | "unavailable"> {
  try { return (await status()).running ? "ready" : "unavailable"; }
  catch { return "unavailable"; }
}

function safeReleaseId(read: () => string | null): string | null {
  try {
    const value = read();
    return value !== null && RELEASE_ID_PATTERN.test(value) ? value : null;
  } catch { return null; }
}

function emptyJobCounts(): MutableCounts {
  return { queued: 0, running: 0, delivering: 0, attention: 0 };
}

function emptyDeliveryCounts(): MutableDeliveryCounts {
  return { pending: 0, sending: 0, uncertain: 0, failed: 0 };
}
