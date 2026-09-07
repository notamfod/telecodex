import { existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { atomicPrivateWrite, AtomicWriteFailure } from "./telegram-job-atomic-export.js";
import { TelegramJobMigrationError, type MigrationReason } from "./telegram-job-migration-contract.js";
import { SqliteTelegramJobStore } from "./telegram-job-ledger.js";
import { storagePathsAlias } from "./telegram-job-storage-path.js";
import { isDoneEligible } from "./telegram-job-transition.js";
import { TELEGRAM_STATUS_ANCHOR_PART_KEY, type TelegramJob } from "./telegram-job-types.js";

const MAX_REASONS = 1_000;
type LegacyState = "awaiting-model" | "waiting" | "active" | "delivering" | "completed" | "failed" | "aborted";

export function exportLegacyTelegramJobs(options: {
  readonly databasePath: string; readonly outputPath: string; readonly limit: number;
}): { readonly exportedCount: number; readonly outputPath: string } {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100_000) {
    throw new TelegramJobMigrationError("EXPORT_LIMIT_EXCEEDED");
  }
  const databasePath = path.resolve(options.databasePath); const outputPath = path.resolve(options.outputPath);
  if (!existsSync(databasePath)) throw new TelegramJobMigrationError("MIGRATION_FAILED");
  if (storagePathsAlias(outputPath, databasePath)) {
    throw new TelegramJobMigrationError("EXPORT_UNSAFE", [{ reasonCode: "PATH_CONFLICT" }]);
  }
  const store = openStore(options.databasePath);
  try {
    const count = store.countJobs();
    if (count > options.limit) throw new TelegramJobMigrationError("EXPORT_LIMIT_EXCEEDED");
    const jobs = count === 0 ? [] : [...store.listRecent(count)];
    jobs.sort((left, right) => left.source.updateId - right.source.updateId || left.id.localeCompare(right.id));
    const reasons: MigrationReason[] = []; const exported = jobs.map((job) => exportJob(store, job, reasons));
    if (reasons.length > 0) throw new TelegramJobMigrationError("EXPORT_UNSAFE", reasons.slice(0, MAX_REASONS));
    try { atomicPrivateWrite(options.outputPath, `${JSON.stringify(exported, null, 2)}\n`); }
    catch (error) {
      if (error instanceof AtomicWriteFailure) throw new TelegramJobMigrationError(
        error.phase === "write_failed" ? "EXPORT_WRITE_FAILED" : "EXPORT_DURABILITY_UNCERTAIN",
      );
      throw new TelegramJobMigrationError("EXPORT_WRITE_FAILED");
    }
    return { exportedCount: exported.length, outputPath: options.outputPath };
  } finally { store.close(); }
}

function exportJob(store: SqliteTelegramJobStore, job: TelegramJob, reasons: MigrationReason[]): Record<string, unknown> {
  const reason = unsafeExportReason(job);
  if (reason) { reasons.push(safeReason(job.id, reason)); return {}; }
  const expectedRows = job.deliveries.map((part, ordinal) => ({ partKey: part.partId, state: part.state,
    ordinal, kind: job.responsePlan?.[ordinal]?.kind }));
  const actualRows = store.listDeliveries(job.id)
    .filter((part) => part.partKey !== TELEGRAM_STATUS_ANCHOR_PART_KEY)
    .map((part) => ({ partKey: part.partKey, state: part.state,
      ordinal: part.ordinal, kind: part.kind }));
  if (!isDeepStrictEqual(expectedRows, actualRows)) { reasons.push(safeReason(job.id, "NORMALIZED_DELIVERY_MISMATCH")); return {}; }
  const storedSource = store.readSourcePayload(job.id); const payload = sourcePayload(storedSource);
  const legacy = payload?.legacy ?? nativeLegacyPayload(storedSource, job);
  if (!legacy) { reasons.push(safeReason(job.id, "SOURCE_NOT_LEGACY_COMPATIBLE")); return {}; }
  const state = legacyStateFor(job);
  if (!state) { reasons.push(safeReason(job.id, "UNREPRESENTABLE_PHASE")); return {}; }
  return { ...structuredClone(legacy), id: job.id, state, threadId: job.threadId, turnId: job.turnId ?? undefined,
    sentPartKeys: job.deliveries.filter((part) => part.state === "delivered").map((part) => part.partId),
    createdAt: job.acceptedAt, updatedAt: job.updatedAt };
}

function unsafeExportReason(job: TelegramJob): string | null {
  const awaitingModel = (job.phase === "accepted" || job.phase === "queued") && job.attention.kind === "required"
    && job.attention.code === "LEGACY_AWAITING_MODEL";
  if (job.attention.kind === "required" && !awaitingModel) return "ATTENTION_REQUIRED";
  if (job.deliveries.some((part) => part.state === "sending" || part.state === "uncertain" || part.state === "failed")) return "DELIVERY_AMBIGUOUS";
  if (job.phase === "terminal" && (job.outcome === "completed" ? !isDoneEligible(job)
    : job.responsePlan?.some((part) => !job.deliveries.some((delivery) => delivery.partId === part.partId && delivery.state === "delivered")))) return "INCOMPLETE_DELIVERY";
  if (job.phase === "dispatching") return "AMBIGUOUS_DISPATCH";
  if (job.outcome === "recovery_interrupted" || job.health === "checking" || job.health === "stalled" || job.health === "unavailable") return "RECOVERY_UNREPRESENTABLE";
  if (job.phase === "running" && !job.turnId) return "AMBIGUOUS_DISPATCH";
  return null;
}

function legacyStateFor(job: TelegramJob): LegacyState | null {
  if ((job.phase === "accepted" || job.phase === "queued") && job.attention.kind === "required"
    && job.attention.code === "LEGACY_AWAITING_MODEL") return "awaiting-model";
  if (job.phase === "queued") return "waiting";
  if (job.phase === "running") return "active";
  if (job.phase === "delivering") return "delivering";
  if (job.phase !== "terminal") return null;
  return job.outcome === "completed" || job.outcome === "failed" || job.outcome === "aborted" ? job.outcome : null;
}

function nativeLegacyPayload(value: unknown, job: TelegramJob): Record<string, unknown> | null {
  const raw = plainRecord(value); if (!raw || raw.botId !== job.source.botId || raw.updateId !== job.source.updateId) return null;
  const chatId = safeInteger(raw.chatId); const topic = raw.messageThreadId === null ? undefined : positiveInteger(raw.messageThreadId);
  if (chatId === null || (raw.messageThreadId !== null && topic === undefined) || positiveInteger(raw.messageId) === undefined
    || typeof raw.kind !== "string" || typeof raw.text !== "string" || raw.attachment !== null) return null;
  return { id: job.id, contextKey: `${chatId}${topic === undefined ? "" : `:${topic}`}`, chatId,
    ...(topic === undefined ? {} : { messageThreadId: topic }), threadId: job.threadId, input: raw.text,
    state: "waiting", sentPartKeys: [], createdAt: job.acceptedAt, updatedAt: job.updatedAt };
}
function sourcePayload(value: unknown): { legacy: Record<string, unknown> } | null {
  const raw = plainRecord(value); const legacy = plainRecord(raw?.legacy); return raw && legacy ? { legacy } : null;
}
function safeReason(jobId: string, reasonCode: string): MigrationReason { return { ...(safeJobId(jobId) ? { jobId } : {}), reasonCode }; }
function safeJobId(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null; }
function plainRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function safeInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) ? value : null; }
function positiveInteger(value: unknown): number | undefined { const result = safeInteger(value); return result !== null && result > 0 ? result : undefined; }
function openStore(databasePath: string): SqliteTelegramJobStore {
  try { return new SqliteTelegramJobStore(databasePath); } catch { throw new TelegramJobMigrationError("MIGRATION_FAILED"); }
}
