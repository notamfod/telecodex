import { randomUUID } from "node:crypto";

import type {
  TelegramJob,
  TelegramReconciliationDecision,
  TelegramReconciliationDecisionKind,
  TelegramReconciliationIntent,
} from "./telegram-job-types.js";

export type TelegramExactTurnInspection =
  | { readonly state: "active" | "completed" | "failed" | "absent" | "ambiguous" }
  | { readonly state: "unavailable"; readonly reasonCode: string };

export type TelegramGuardianReconciliationInspection =
  | { readonly availability: "unavailable"; readonly reasonCode: string }
  | {
      readonly availability: "available";
      readonly state: "in_progress" | "restored" | "failed" | "none";
      readonly reasonCode?: string;
    }
  | {
      readonly availability: "available";
      readonly state: "self_recovered";
      readonly threadId: string;
      readonly turnId: string;
    };

export interface TelegramQuarantinedReconciliationCandidate {
  readonly jobId: string;
  readonly reasonCode: string;
}

export interface TelegramReconciliationCandidateBatch {
  readonly jobs: readonly TelegramJob[];
  readonly quarantined: readonly TelegramQuarantinedReconciliationCandidate[];
}

export interface TelegramReconciliationEffectInput {
  readonly jobId: string;
  readonly decisionId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
}

export interface TelegramJobReconciliationEffects {
  restoreAccepted(input: TelegramReconciliationEffectInput): Promise<void>;
  queueSameJob(input: TelegramReconciliationEffectInput): Promise<void>;
  recoverExactTurn(input: TelegramReconciliationEffectInput): Promise<void>;
  resumePendingDelivery(input: TelegramReconciliationEffectInput): Promise<void>;
  requireAttention(input: TelegramReconciliationEffectInput & { readonly reasonCode: string }): Promise<void>;
  refreshStatus(input: TelegramReconciliationEffectInput): Promise<void>;
  terminateRecoveryInterrupted(input: TelegramReconciliationEffectInput): Promise<void>;
}

export interface TelegramJobReconcilerOptions {
  readonly loadCandidates: () => Promise<TelegramReconciliationCandidateBatch>;
  readonly inspectExactTurn: (input: {
    readonly jobId: string; readonly threadId: string; readonly turnId: string;
  }) => Promise<TelegramExactTurnInspection>;
  readonly inspectGuardian: (input: {
    readonly jobId: string; readonly threadId: string; readonly turnId: string;
  }) => Promise<TelegramGuardianReconciliationInspection>;
  readonly recordDecision: (input: {
    readonly jobId: string;
    readonly expectedVersion: number;
    readonly decision: TelegramReconciliationDecision;
    readonly decidedAt: number;
  }) => Promise<TelegramReconciliationIntent>;
  readonly markApplied: (input: {
    readonly jobId: string; readonly decisionId: string; readonly appliedAt: number;
  }) => Promise<void>;
  readonly effects: TelegramJobReconciliationEffects;
  readonly now?: () => number;
  readonly createDecisionId?: (job: TelegramJob) => string;
}

export interface TelegramReconciliationRunResult {
  readonly candidates: number;
  readonly decisionsPersisted: number;
  readonly effectsApplied: number;
  readonly effectsFailed: number;
  readonly quarantined: readonly TelegramQuarantinedReconciliationCandidate[];
}

interface PendingWork { readonly job: TelegramJob; readonly intent: TelegramReconciliationIntent }

export async function reconcileUnfinishedJobs(
  options: TelegramJobReconcilerOptions,
): Promise<TelegramReconciliationRunResult> {
  const now = options.now ?? Date.now;
  const createDecisionId = options.createDecisionId ?? (() => randomUUID());
  const batch = await options.loadCandidates();
  const work: PendingWork[] = [];
  let decisionsPersisted = 0;

  // Deliberately finish this phase for every candidate before the first effect.
  for (const job of batch.jobs) {
    if (job.reconciliation?.state === "pending") {
      work.push({ job, intent: job.reconciliation });
      continue;
    }
    const decision = await classify(job, options, createDecisionId(job));
    const intent = await options.recordDecision({
      jobId: job.id, expectedVersion: job.version, decision, decidedAt: now(),
    });
    if (!sameDecision(intent.decision, decision)) {
      throw new Error("Durable reconciliation decision mismatch");
    }
    decisionsPersisted += 1;
    if (intent.state === "pending") work.push({ job, intent });
  }

  let effectsApplied = 0;
  let effectsFailed = 0;
  const failures: unknown[] = [];
  for (const pending of work) {
    try {
      await applyIntent(pending, options.effects);
      await options.markApplied({
        jobId: pending.job.id,
        decisionId: pending.intent.decision.id,
        appliedAt: now(),
      });
      effectsApplied += 1;
    } catch (error) {
      effectsFailed += 1;
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Telegram job reconciliation failed");
  return {
    candidates: batch.jobs.length,
    decisionsPersisted,
    effectsApplied,
    effectsFailed,
    quarantined: batch.quarantined.map((candidate) => ({ ...candidate })),
  };
}

function sameDecision(
  left: TelegramReconciliationDecision,
  right: TelegramReconciliationDecision,
): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.reasonCode === right.reasonCode;
}

async function classify(
  job: TelegramJob,
  options: TelegramJobReconcilerOptions,
  decisionId: string,
): Promise<TelegramReconciliationDecision> {
  if (job.phase === "accepted") return decision(job, decisionId, "restore_accepted", "restart_accepted");
  if (job.phase === "queued") {
    const provenNotSent = job.dispatch?.transportWriteState === "prepared";
    return decision(job, decisionId, provenNotSent ? "requeue_not_sent" : "enqueue",
      provenNotSent ? "dispatch_proven_not_sent" : "restart_queued");
  }
  if (job.phase === "dispatching") {
    return decision(job, decisionId,
      job.dispatch?.transportWriteState === "prepared" ? "requeue_not_sent" : "hold_dispatch_unknown",
      job.dispatch?.transportWriteState === "prepared"
        ? "dispatch_proven_not_sent" : "dispatch_acceptance_unknown");
  }
  if (job.phase === "delivering") return decision(job, decisionId, "resume_delivery", "restart_delivery");
  if (job.phase === "terminal") return decision(job, decisionId, "refresh_terminal", "restart_terminal");
  return classifyRunning(job, options, decisionId);
}

async function classifyRunning(
  job: TelegramJob,
  options: TelegramJobReconcilerOptions,
  decisionId: string,
): Promise<TelegramReconciliationDecision> {
  if (job.threadId === null || job.turnId === null) {
    return decision(job, decisionId, "require_attention", "running_identity_missing");
  }
  const exactInput = { jobId: job.id, threadId: job.threadId, turnId: job.turnId };
  const exact = await inspectExact(exactInput, options);
  if (exact.state === "active" || exact.state === "completed" || exact.state === "failed") {
    return exactDecision(job, decisionId, exact.state, "exact_turn");
  }

  let guardian: TelegramGuardianReconciliationInspection;
  try {
    guardian = await options.inspectGuardian({ jobId: job.id, threadId: job.threadId, turnId: job.turnId });
  } catch {
    guardian = { availability: "unavailable", reasonCode: "guardian_unavailable" };
  }
  if (guardian.availability === "unavailable") {
    return decision(job, decisionId, "require_attention", "guardian_unavailable");
  }
  if (guardian.state === "in_progress") {
    return decision(job, decisionId, "await_guardian", "guardian_repair_in_progress");
  }
  if (guardian.state === "restored") {
    return decision(job, decisionId, "terminate_recovery_interrupted", "guardian_restored_new_session");
  }
  if (guardian.state === "self_recovered") {
    if (guardian.threadId === job.threadId && guardian.turnId === job.turnId) {
      const recovered = await inspectExact(exactInput, options);
      if (recovered.state === "active" || recovered.state === "completed" || recovered.state === "failed") {
        return exactDecision(job, decisionId, recovered.state, "guardian_self_recovered");
      }
      return decision(job, decisionId, "require_attention", "guardian_self_recovered_turn_unavailable");
    }
    return decision(job, decisionId, "require_attention", "guardian_turn_mismatch");
  }
  return decision(job, decisionId, "require_attention",
    guardian.state === "failed" ? "guardian_repair_failed" : "turn_absent_or_ambiguous");
}

async function inspectExact(
  input: { readonly jobId: string; readonly threadId: string; readonly turnId: string },
  options: TelegramJobReconcilerOptions,
): Promise<TelegramExactTurnInspection> {
  try {
    return await options.inspectExactTurn(input);
  } catch {
    return { state: "unavailable", reasonCode: "app_server_unavailable" };
  }
}

function exactDecision(
  job: TelegramJob,
  decisionId: string,
  state: "active" | "completed" | "failed",
  source: "exact_turn" | "guardian_self_recovered",
): TelegramReconciliationDecision {
  return decision(job, decisionId, "recover_exact_turn", `${source}_${state}`);
}

function decision(
  job: TelegramJob,
  id: string,
  kind: TelegramReconciliationDecisionKind,
  reasonCode: string,
): TelegramReconciliationDecision {
  return { id, kind, threadId: job.threadId, turnId: job.turnId, reasonCode };
}

function isAcceptanceUnknown(job: TelegramJob): boolean {
  return job.dispatch?.transportWriteState === "in_flight"
    || job.dispatch?.transportWriteState === "written";
}

async function applyIntent(
  pending: PendingWork,
  effects: TelegramJobReconciliationEffects,
): Promise<void> {
  const value = pending.intent.decision;
  const input: TelegramReconciliationEffectInput = {
    jobId: pending.job.id,
    decisionId: value.id,
    threadId: value.threadId,
    turnId: value.turnId,
  };
  switch (value.kind) {
    case "restore_accepted":
      await effects.restoreAccepted(input);
      return;
    case "enqueue": case "requeue_not_sent": await effects.queueSameJob(input); return;
    case "recover_exact_turn": await effects.recoverExactTurn(input); return;
    case "resume_delivery": await effects.resumePendingDelivery(input); return;
    case "terminate_recovery_interrupted":
      await effects.terminateRecoveryInterrupted(input);
      await effects.refreshStatus(input);
      return;
    case "hold_dispatch_unknown": case "await_guardian": case "require_attention":
      await effects.requireAttention({
        ...input, reasonCode: value.reasonCode ?? "reconciliation_attention_required",
      });
      await effects.refreshStatus(input);
      return;
    case "inspect_guardian": case "refresh_terminal":
      await effects.refreshStatus(input);
  }
}
