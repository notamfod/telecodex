import { createHash, randomUUID } from "node:crypto";

import { inspectTelegramExactTurn, type TelegramExactTurnReader } from "./telegram-exact-turn-inspector.js";
import { inspectTelegramGuardian, type TelegramGuardianInspector } from "./telegram-guardian-reconciliation.js";
import type { TelegramJobCoordinator } from "./telegram-job-coordinator.js";
import type { TelegramJobIngress } from "./telegram-job-ingress.js";
import {
  reconcileUnfinishedJobs,
  type TelegramJobReconciliationEffects,
  type TelegramReconciliationEffectInput,
  type TelegramReconciliationRunResult,
} from "./telegram-job-reconciler.js";
import type { SqliteTelegramJobStore, TransitionEvent } from "./telegram-job-store.js";
import type {
  JobHealth, TelegramJob, TelegramReconciliationDecision,
  TelegramReconciliationIntent,
} from "./telegram-job-types.js";

const DEFAULT_SCAN_LIMIT = 100;
const MAX_CAS_RETRIES = 16;
type RuntimeStore = Pick<SqliteTelegramJobStore, "get" | "transition" | "scanReconciliationCandidates">;

export interface TelegramReconciliationRuntimeOptions {
  readonly store: RuntimeStore;
  readonly coordinator: Pick<TelegramJobCoordinator, "pump" | "recoverExactTurn">;
  readonly materializer: Pick<TelegramJobIngress, "materialize">;
  readonly resumeDelivery: (jobId: string) => Promise<void>;
  readonly refreshStatus: (jobId: string) => Promise<void>;
  readonly exactTurnReader: TelegramExactTurnReader;
  readonly guardian: TelegramGuardianInspector;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly scanLimit?: number;
}

export function createTelegramReconciliationRuntime(
  options: TelegramReconciliationRuntimeOptions,
): () => Promise<TelegramReconciliationRunResult> {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const scanLimit = positiveInteger(options.scanLimit ?? DEFAULT_SCAN_LIMIT, "scanLimit");
  const effects = createEffects(options, now, createId);
  return () => reconcileUnfinishedJobs({
    loadCandidates: async () => loadAllCandidates(options.store, scanLimit, now()),
    inspectExactTurn: (input) => inspectTelegramExactTurn(options.exactTurnReader, input),
    inspectGuardian: (input) => inspectTelegramGuardian(options.guardian, input),
    recordDecision: (input) => recordDecision(options.store, createId, input),
    markApplied: (input) => markApplied(options.store, createId, input),
    effects, now,
    createDecisionId: (job) => decisionId(job),
  });
}

async function loadAllCandidates(store: RuntimeStore, limit: number, quarantinedAt: number) {
  const jobs: TelegramJob[] = [];
  const quarantined: Array<{ jobId: string; reasonCode: string }> = [];
  let cursor: { acceptedAt: number; jobId: string } | undefined;
  do {
    const page = store.scanReconciliationCandidates({ limit, quarantinedAt, ...(cursor ? { cursor } : {}) });
    jobs.push(...page.jobs);
    quarantined.push(...page.quarantined.map(({ jobId, reasonCode }) => ({ jobId, reasonCode })));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { jobs, quarantined };
}

function createEffects(
  options: TelegramReconciliationRuntimeOptions,
  now: () => number,
  createId: () => string,
): TelegramJobReconciliationEffects {
  return {
    restoreAccepted: async (input) => {
      const current = pendingIntentJob(options.store, input);
      if (!current || current.phase !== "accepted") return;
      void options.materializer.materialize(input.jobId)
        .then(() => options.coordinator.pump())
        .catch(() => undefined);
    },
    queueSameJob: async (input) => {
      const before = pendingIntentJob(options.store, input);
      if (!before || enqueueEffectAdvanced(before)) return;
      await transitionEffect(options.store, createId, input, (current) => {
        if ((current.phase === "queued" && !isSafelyQueued(current))
          || (current.phase !== "accepted" && current.phase !== "queued"
          && !(current.phase === "dispatching" && current.dispatch?.transportWriteState === "prepared"))) {
          throw new Error("Telegram job cannot be safely queued");
        }
        return {
          schemaVersion: 1, type: "job.queued", eventAt: monotonic(now, current),
          attention: { kind: "none" },
        };
      }, isSafelyQueued);
      if (!pendingIntentJob(options.store, input)) return;
      await options.coordinator.pump();
    },
    recoverExactTurn: async (input) => {
      const current = pendingIntentJob(options.store, input);
      if (!current) return;
      if ((current.phase === "delivering" || current.phase === "terminal")
        && current.threadId === input.threadId && current.turnId === input.turnId) return;
      if (current.phase !== "running" || current.threadId !== input.threadId || current.turnId !== input.turnId) {
        throw new Error("Telegram recovery identity changed");
      }
      await options.coordinator.recoverExactTurn(current.id);
    },
    resumePendingDelivery: async (input) => {
      const current = pendingIntentJob(options.store, input);
      if (!current || current.phase === "terminal") return;
      if (current.phase !== "delivering") throw new Error("Telegram delivery recovery state changed");
      await options.resumeDelivery(input.jobId);
    },
    requireAttention: async (input) => {
      const reasonCode = bounded(input.reasonCode, "reasonCode");
      const health = attentionHealth(reasonCode);
      await transitionEffect(options.store, createId, input, (current) => ({
        schemaVersion: 1, type: "guardian.observed", eventAt: monotonic(now, current), health,
        attention: { kind: "required", code: reasonCode, actions: ["inspect"] },
      }), (current) => current.health === health && current.attention.kind === "required"
        && current.attention.code === reasonCode);
    },
    refreshStatus: async (input) => {
      if (!pendingIntentJob(options.store, input)) return;
      void options.refreshStatus(input.jobId).catch(() => undefined);
    },
    terminateRecoveryInterrupted: async (input) => {
      await transitionEffect(options.store, createId, input, (current) => {
        if (current.phase !== "running" || current.threadId !== input.threadId || current.turnId !== input.turnId) {
          throw new Error("Telegram recovery identity changed");
        }
        return {
          schemaVersion: 1, type: "job.terminal", eventAt: monotonic(now, current),
          outcome: "recovery_interrupted",
          attention: { kind: "required", code: "guardian_restored_new_session", actions: ["retry"] },
        };
      }, (current) => current.phase === "terminal" && current.outcome === "recovery_interrupted");
    },
  };
}

async function transitionEffect(
  store: RuntimeStore,
  createId: () => string,
  input: TelegramReconciliationEffectInput,
  build: (current: TelegramJob) => TransitionEvent,
  applied: (current: TelegramJob) => boolean,
): Promise<void> {
  const current = pendingIntentJob(store, input);
  if (!current) return;
  if (applied(current)) return;
  try {
    store.transition({
      jobId: current.id, eventId: bounded(createId(), "eventId"), expectedVersion: current.version,
      event: build(current),
    });
  } catch (error) {
    if (!isVersionConflict(error)) throw error;
    const winner = intentJob(store, input);
    if (winner.reconciliation?.state !== "applied" && !applied(winner)) throw error;
  }
}

async function recordDecision(
  store: RuntimeStore,
  createId: () => string,
  input: {
    jobId: string; expectedVersion: number; decision: TelegramReconciliationDecision; decidedAt: number;
  },
): Promise<TelegramReconciliationIntent> {
  try {
    const current = store.get(input.jobId);
    if (!current) throw new Error("Unknown Telegram job");
    const stored = store.transition({
      jobId: input.jobId, eventId: bounded(createId(), "eventId"), expectedVersion: input.expectedVersion,
      event: {
        schemaVersion: 1, type: "reconciliation.decided",
        eventAt: Math.max(input.decidedAt, current.updatedAt),
        decision: input.decision,
      },
    });
    return requiredIntent(stored, input.decision.id);
  } catch (error) {
    if (!isVersionConflict(error)) throw error;
    const winner = store.get(input.jobId);
    const intent = winner?.reconciliation;
    if (!intent || !sameDecision(intent.decision, input.decision)) throw error;
    return intent;
  }
}

async function markApplied(
  store: RuntimeStore,
  createId: () => string,
  input: { jobId: string; decisionId: string; appliedAt: number },
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const current = store.get(input.jobId);
    if (!current) throw new Error("Unknown Telegram job");
    if (current.reconciliation?.state === "applied"
      && current.reconciliation.decision.id === input.decisionId) return;
    if (current.reconciliation?.state !== "pending"
      || current.reconciliation.decision.id !== input.decisionId) {
      throw new Error("Telegram reconciliation intent changed");
    }
    try {
      store.transition({
        jobId: current.id, eventId: bounded(createId(), "eventId"), expectedVersion: current.version,
        event: {
          schemaVersion: 1, type: "reconciliation.applied",
          eventAt: Math.max(input.appliedAt, current.updatedAt), decisionId: input.decisionId,
        },
      });
      return;
    } catch (error) { if (!isVersionConflict(error)) throw error; }
  }
  throw new Error("Telegram reconciliation transition conflict");
}

function intentJob(store: RuntimeStore, input: TelegramReconciliationEffectInput): TelegramJob {
  const current = store.get(bounded(input.jobId, "jobId"));
  const decision = current?.reconciliation?.decision;
  if (!current || !current.reconciliation || decision?.id !== input.decisionId
    || decision.threadId !== input.threadId || decision.turnId !== input.turnId) {
    throw new Error("Telegram reconciliation intent changed");
  }
  return current;
}

function pendingIntentJob(store: RuntimeStore, input: TelegramReconciliationEffectInput): TelegramJob | null {
  const current = intentJob(store, input);
  return current.reconciliation?.state === "applied" ? null : current;
}

function isSafelyQueued(job: TelegramJob): boolean {
  return job.phase === "queued" && (job.dispatch === undefined || job.dispatch.transportWriteState === "prepared");
}

function enqueueEffectAdvanced(job: TelegramJob): boolean {
  if (job.phase === "running" || job.phase === "delivering" || job.phase === "terminal") return true;
  if (job.phase !== "dispatching") return false;
  const kind = job.reconciliation?.decision.kind;
  return (kind === "enqueue" || kind === "requeue_not_sent")
    && job.dispatch?.transportWriteState !== "prepared";
}

function requiredIntent(job: TelegramJob, decisionId: string): TelegramReconciliationIntent {
  if (job.reconciliation?.state !== "pending" || job.reconciliation.decision.id !== decisionId) {
    throw new Error("Telegram reconciliation intent was not persisted");
  }
  return job.reconciliation;
}

function decisionId(job: TelegramJob): string {
  const digest = createHash("sha256").update(job.id).update("\0").update(String(job.version)).digest("hex");
  return `reconcile-${digest}`;
}

function sameDecision(left: TelegramReconciliationDecision, right: TelegramReconciliationDecision): boolean {
  return left.id === right.id && left.kind === right.kind && left.threadId === right.threadId
    && left.turnId === right.turnId && left.reasonCode === right.reasonCode;
}

function attentionHealth(reasonCode: string): JobHealth {
  if (reasonCode === "guardian_repair_in_progress") return "checking";
  if (reasonCode === "guardian_timeout" || reasonCode === "guardian_unavailable") return "unavailable";
  return "stalled";
}

function monotonic(now: () => number, current: TelegramJob): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid reconciliation timestamp");
  return Math.max(value, current.updatedAt);
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function bounded(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "Telegram job version conflict";
}
