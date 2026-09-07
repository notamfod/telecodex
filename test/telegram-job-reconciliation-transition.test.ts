import { JobTransitionError, transitionJob } from "../src/telegram-job-transition.js";
import type {
  TelegramJob,
  TelegramJobEvent,
  TelegramReconciliationDecision,
  TelegramReconciliationDecisionKind,
} from "../src/telegram-job-types.js";

const NOW = 1_700_000_000_000;
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";

describe("Telegram reconciliation transitions", () => {
  it("persists an exact pending decision before marking that same intent applied", () => {
    const running = job({ phase: "running", threadId: THREAD_ID, turnId: TURN_ID });
    const decision = exactDecision("recover_exact_turn");

    const decided = apply(running, {
      schemaVersion: 1, type: "reconciliation.decided", eventAt: NOW + 1, decision,
    });

    expect(decided.reconciliation).toEqual({
      decision, state: "pending", decidedAt: NOW + 1, appliedAt: null,
    });
    const applied = apply(decided, {
      schemaVersion: 1, type: "reconciliation.applied", eventAt: NOW + 2,
      decisionId: decision.id,
    });
    expect(applied.reconciliation).toEqual({
      decision, state: "applied", decidedAt: NOW + 1, appliedAt: NOW + 2,
    });
  });

  it.each([
    "restore_accepted", "enqueue", "requeue_not_sent", "hold_dispatch_unknown",
    "recover_exact_turn", "inspect_guardian", "await_guardian", "resume_delivery",
    "refresh_terminal", "terminate_recovery_interrupted", "require_attention",
  ] as const)("accepts the bounded %s matrix decision", (kind) => {
    const current = kind === "recover_exact_turn"
      ? job({ phase: "running", threadId: THREAD_ID, turnId: TURN_ID })
      : job();
    const decision = kind === "recover_exact_turn" ? exactDecision(kind) : decisionFor(kind);

    expect(apply(current, {
      schemaVersion: 1, type: "reconciliation.decided", eventAt: NOW + 1, decision,
    }).reconciliation?.decision.kind).toBe(kind);
  });

  it("rejects unknown, unbounded, or inexact decisions at the event boundary", () => {
    const running = job({ phase: "running", threadId: THREAD_ID, turnId: TURN_ID });
    const invalid = [
      { ...exactDecision("recover_exact_turn"), kind: "start_again" },
      { ...exactDecision("recover_exact_turn"), reasonCode: "x".repeat(129) },
      { ...exactDecision("recover_exact_turn"), turnId: "different-turn" },
      { ...decisionFor("inspect_guardian"), threadId: null, turnId: TURN_ID },
    ];
    for (const decision of invalid) {
      expect(() => apply(running, {
        schemaVersion: 1, type: "reconciliation.decided", eventAt: NOW + 1,
        decision: decision as never,
      })).toThrow(JobTransitionError);
    }
  });

  it("does not overwrite a pending effect or apply a different decision", () => {
    const first = decisionFor("enqueue");
    const pending = apply(job(), {
      schemaVersion: 1, type: "reconciliation.decided", eventAt: NOW + 1, decision: first,
    });
    expect(() => apply(pending, {
      schemaVersion: 1, type: "reconciliation.decided", eventAt: NOW + 2,
      decision: decisionFor("resume_delivery"),
    })).toThrow(JobTransitionError);
    expect(() => apply(pending, {
      schemaVersion: 1, type: "reconciliation.applied", eventAt: NOW + 2,
      decisionId: "different-decision",
    })).toThrow(JobTransitionError);
  });

  it("rejects mixed-effect reconciliation events and corrupt persisted identity", () => {
    expect(() => apply(job(), {
      schemaVersion: 1, type: "reconciliation.decided", eventAt: NOW + 1,
      decision: decisionFor("enqueue"), attention: { kind: "required", code: "mixed", actions: [] },
    })).toThrow(JobTransitionError);
    expect(() => apply({
      ...job({ phase: "running", threadId: THREAD_ID, turnId: TURN_ID }),
      reconciliation: {
        decision: { ...exactDecision("recover_exact_turn"), turnId: "different-turn" },
        state: "pending", decidedAt: NOW, appliedAt: null,
      },
    }, { schemaVersion: 1, type: "activity.observed", eventAt: NOW + 1 }))
      .toThrow(JobTransitionError);
  });

  it("keeps old jobs backward-compatible and permits only reconciliation audit progress on terminal jobs", () => {
    const legacy = apply(job(), {
      schemaVersion: 1, type: "activity.observed", eventAt: NOW + 1,
    });
    expect(legacy).not.toHaveProperty("reconciliation");

    const terminal = job({ phase: "terminal", outcome: "failed", terminalAt: NOW });
    const decision = decisionFor("refresh_terminal");
    const decided = apply(terminal, {
      schemaVersion: 1, type: "reconciliation.decided", eventAt: NOW + 1, decision,
    });
    const applied = apply(decided, {
      schemaVersion: 1, type: "reconciliation.applied", eventAt: NOW + 2,
      decisionId: decision.id,
    });
    expect(applied).toMatchObject({
      phase: "terminal", outcome: "failed", terminalAt: NOW,
      reconciliation: { state: "applied", appliedAt: NOW + 2 },
    });
  });
});

function job(overrides: Partial<TelegramJob> = {}): TelegramJob {
  return {
    schemaVersion: 1, id: "job-reconcile", version: 1,
    source: { botId: "bot", updateId: 1 }, attachments: [], phase: "queued",
    health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt: NOW, updatedAt: NOW, terminalAt: null, dismissedAt: null, retainUntil: null,
    ...overrides,
  };
}

function decisionFor(kind: TelegramReconciliationDecisionKind): TelegramReconciliationDecision {
  return { id: `decision-${kind}`, kind, threadId: null, turnId: null, reasonCode: null };
}

function exactDecision(kind: TelegramReconciliationDecisionKind): TelegramReconciliationDecision {
  return { ...decisionFor(kind), threadId: THREAD_ID, turnId: TURN_ID };
}

function apply(current: TelegramJob, event: TelegramJobEvent): TelegramJob {
  const result = transitionJob(current, event);
  if (result.kind !== "applied") throw new Error("unexpected conflict");
  return result.job;
}
