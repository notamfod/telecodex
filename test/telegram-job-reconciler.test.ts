import { vi } from "vitest";

import {
  reconcileUnfinishedJobs,
  type TelegramExactTurnInspection,
  type TelegramGuardianReconciliationInspection,
  type TelegramJobReconcilerOptions,
} from "../src/telegram-job-reconciler.js";
import type {
  TelegramJob,
  TelegramReconciliationDecision,
  TelegramReconciliationIntent,
} from "../src/telegram-job-types.js";

const NOW = 1_700_000_200_000;
const THREAD = "11111111-1111-4111-8111-111111111111";
const TURN = "turn-exact";

describe("reconcileUnfinishedJobs", () => {
  it("persists the whole non-running restart matrix before performing any effect", async () => {
    const harness = createHarness([
      job("accepted", { phase: "accepted" }),
      job("queued", { phase: "queued" }),
      job("not-sent", { phase: "dispatching", dispatch: dispatch("prepared") }),
      job("unknown", { phase: "dispatching", dispatch: dispatch("in_flight") }),
      job("delivering", { phase: "delivering" }),
      job("terminal", { phase: "terminal", outcome: "completed", terminalAt: NOW - 1 }),
    ]);

    const result = await reconcileUnfinishedJobs(harness.options);

    expect(harness.recorded.map(({ decision }) => decision.kind)).toEqual([
      "restore_accepted", "enqueue", "requeue_not_sent", "hold_dispatch_unknown",
      "resume_delivery", "refresh_terminal",
    ]);
    const firstEffect = harness.calls.findIndex((call) => call.startsWith("effect:"));
    expect(harness.calls.slice(0, firstEffect)).toEqual([
      "record:accepted", "record:queued", "record:not-sent", "record:unknown",
      "record:delivering", "record:terminal",
    ]);
    expect(harness.effects).toEqual([
      "restore:accepted", "queue:queued", "queue:not-sent",
      "attention:unknown:dispatch_acceptance_unknown", "refresh:unknown",
      "delivery:delivering", "refresh:terminal",
    ]);
    expect(harness.inspectExactTurn).not.toHaveBeenCalled();
    expect(harness.inspectGuardian).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 6, decisionsPersisted: 6, effectsApplied: 6 });
  });

  it("classifies exact turns and Guardian outcomes without competing recovery", async () => {
    const jobs = ["active", "completed", "terminal-failed", "guardian-wait", "self-recovered", "restored", "failed", "unavailable"]
      .map((id) => job(id, { phase: "running", threadId: THREAD, turnId: TURN }));
    const exact = new Map<string, TelegramExactTurnInspection | TelegramExactTurnInspection[]>([
      ["active", { state: "active" }],
      ["completed", { state: "completed" }],
      ["terminal-failed", { state: "failed" }],
      ...["guardian-wait", "restored", "unavailable"]
        .map((id) => [id, { state: "absent" }] as const),
      ["self-recovered", [{ state: "absent" }, { state: "active" }]],
      ["failed", { state: "ambiguous" }],
    ]);
    const guardian = new Map<string, TelegramGuardianReconciliationInspection>([
      ["guardian-wait", { availability: "available", state: "in_progress" }],
      ["self-recovered", { availability: "available", state: "self_recovered",
        threadId: THREAD, turnId: TURN }],
      ["restored", { availability: "available", state: "restored" }],
      ["failed", { availability: "available", state: "failed", reasonCode: "guardian_repair_failed" }],
      ["unavailable", { availability: "unavailable", reasonCode: "guardian_unavailable" }],
    ]);
    const harness = createHarness(jobs, { exact, guardian });

    await reconcileUnfinishedJobs(harness.options);

    expect(kindsByJob(harness.recorded)).toEqual({
      active: "recover_exact_turn", completed: "recover_exact_turn",
      "terminal-failed": "recover_exact_turn",
      "guardian-wait": "await_guardian", "self-recovered": "recover_exact_turn",
      restored: "terminate_recovery_interrupted", failed: "require_attention",
      unavailable: "require_attention",
    });
    expect(harness.effects).toEqual([
      "recover:active", "recover:completed", "recover:terminal-failed",
      "attention:guardian-wait:guardian_repair_in_progress", "refresh:guardian-wait",
      "recover:self-recovered", "terminate:restored", "refresh:restored",
      "attention:failed:guardian_repair_failed", "refresh:failed",
      "attention:unavailable:guardian_unavailable", "refresh:unavailable",
    ]);
    expect(harness.inspectGuardian).toHaveBeenCalledTimes(5);
    expect(harness.inspectExactTurn).toHaveBeenCalledTimes(9);
  });

  it("never inspects or starts work for dispatch acceptance unknown", async () => {
    const harness = createHarness([
      job("unknown", { phase: "dispatching", dispatch: dispatch("written") }),
    ]);
    const forbidden = vi.fn(() => { throw new Error("forbidden"); });
    const options = { ...harness.options, originalPromptHandler: forbidden, startTurn: forbidden };

    await reconcileUnfinishedJobs(options);

    expect(harness.recorded[0]?.decision).toMatchObject({
      kind: "hold_dispatch_unknown", reasonCode: "dispatch_acceptance_unknown",
    });
    expect(harness.inspectExactTurn).not.toHaveBeenCalled();
    expect(harness.inspectGuardian).not.toHaveBeenCalled();
    expect(harness.effects).toEqual([
      "attention:unknown:dispatch_acceptance_unknown", "refresh:unknown",
    ]);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("replays pending intents and creates a fresh safe intent on a later restart", async () => {
    const pending = intent("pending-delivery", "resume_delivery", "pending");
    const harness = createHarness([
      job("queued", { phase: "queued" }),
      job("pending-delivery", { phase: "delivering", reconciliation: pending }),
      job("already-applied", { phase: "queued", reconciliation: intent("already-applied", "enqueue", "applied") }),
    ]);

    await reconcileUnfinishedJobs(harness.options);
    await reconcileUnfinishedJobs(harness.options);

    expect(harness.recorded).toHaveLength(5);
    expect(harness.effects).toEqual([
      "queue:queued", "delivery:pending-delivery", "queue:already-applied",
      "queue:queued", "delivery:pending-delivery", "queue:already-applied",
    ]);
    expect(harness.marked).toEqual([
      "queued", "pending-delivery", "already-applied",
      "queued", "pending-delivery", "already-applied",
    ]);
    expect(new Set(harness.recorded.map(({ decision }) => decision.id)).size).toBe(5);
  });

  it("treats queued as durably safe to enqueue even when an old dispatch write survives", async () => {
    const harness = createHarness([
      job("deferred", { phase: "queued", dispatch: dispatch("written") }),
    ]);

    await reconcileUnfinishedJobs(harness.options);

    expect(harness.recorded[0]?.decision.kind).toBe("enqueue");
    expect(harness.effects).toEqual(["queue:deferred"]);
    expect(harness.inspectExactTurn).not.toHaveBeenCalled();
    expect(harness.inspectGuardian).not.toHaveBeenCalled();
  });

  it("performs no effect if any candidate decision cannot be made durable", async () => {
    const harness = createHarness([
      job("first", { phase: "queued" }), job("second", { phase: "delivering" }),
    ], { failRecordFor: "second" });

    await expect(reconcileUnfinishedJobs(harness.options)).rejects.toThrow("record failed");

    expect(harness.recorded.map(({ jobId }) => jobId)).toEqual(["first"]);
    expect(harness.effects).toEqual([]);
    expect(harness.marked).toEqual([]);
  });

  it("rejects a conflicting durable intent before the effect phase", async () => {
    const harness = createHarness([job("queued", { phase: "queued" })]);
    const conflicting = intent("other", "resume_delivery", "pending");

    await expect(reconcileUnfinishedJobs({
      ...harness.options,
      recordDecision: async () => conflicting,
    })).rejects.toThrow("Durable reconciliation decision mismatch");

    expect(harness.effects).toEqual([]);
    expect(harness.marked).toEqual([]);
  });

  it("recovers persisted exact intents without routing from free-form reason text", async () => {
    const nullReason = intent("null-reason", "recover_exact_turn", "pending");
    const harness = createHarness([
      job("null-reason", { phase: "running", threadId: THREAD, turnId: TURN,
        reconciliation: { ...nullReason, decision: { ...nullReason.decision, threadId: THREAD, turnId: TURN } } }),
      job("unknown-reason", { phase: "running", threadId: THREAD, turnId: TURN,
        reconciliation: { ...intent("unknown-reason", "recover_exact_turn", "pending"),
          decision: { id: "decision-unknown", kind: "recover_exact_turn",
            threadId: THREAD, turnId: TURN, reasonCode: "future_exact_state" } } }),
    ]);

    await reconcileUnfinishedJobs(harness.options);

    expect(harness.effects).toEqual(["recover:null-reason", "recover:unknown-reason"]);
  });

  it("re-inspects the exact turn after Guardian self-recovery", async () => {
    const jobs = ["completed", "still-absent", "mismatch"]
      .map((id) => job(id, { phase: "running", threadId: THREAD, turnId: TURN }));
    const exact = new Map<string, TelegramExactTurnInspection | TelegramExactTurnInspection[]>([
      ["completed", [{ state: "absent" }, { state: "completed" }]],
      ["still-absent", [{ state: "absent" }, { state: "absent" }]],
      ["mismatch", { state: "absent" }],
    ]);
    const guardian = new Map<string, TelegramGuardianReconciliationInspection>([
      ["completed", { availability: "available", state: "self_recovered", threadId: THREAD, turnId: TURN }],
      ["still-absent", { availability: "available", state: "self_recovered", threadId: THREAD, turnId: TURN }],
      ["mismatch", { availability: "available", state: "self_recovered", threadId: "other", turnId: TURN }],
    ]);
    const harness = createHarness(jobs, { exact, guardian });

    await reconcileUnfinishedJobs(harness.options);

    expect(kindsByJob(harness.recorded)).toEqual({
      completed: "recover_exact_turn", "still-absent": "require_attention", mismatch: "require_attention",
    });
    expect(harness.effects).toEqual([
      "recover:completed",
      "attention:still-absent:guardian_self_recovered_turn_unavailable", "refresh:still-absent",
      "attention:mismatch:guardian_turn_mismatch", "refresh:mismatch",
    ]);
    expect(harness.inspectExactTurn).toHaveBeenCalledTimes(5);
  });

  it("surfaces quarantined candidates without hiding healthy work", async () => {
    const harness = createHarness([job("healthy", { phase: "queued" })], {
      quarantined: [{ jobId: "row-7", reasonCode: "malformed_job_projection" }],
    });

    const result = await reconcileUnfinishedJobs(harness.options);

    expect(result.quarantined).toEqual([
      { jobId: "row-7", reasonCode: "malformed_job_projection" },
    ]);
    expect(harness.effects).toEqual(["queue:healthy"]);
  });

  it("leaves a failed effect pending, continues later intents, then rejects startup", async () => {
    const harness = createHarness([
      job("fails", { phase: "queued" }), job("continues", { phase: "delivering" }),
    ], { failEffectFor: "fails" });

    await expect(reconcileUnfinishedJobs(harness.options)).rejects.toBeInstanceOf(AggregateError);

    expect(harness.effects).toEqual(["queue:fails", "delivery:continues"]);
    expect(harness.marked).toEqual(["continues"]);
  });

  it("retries a failed pending effect with the same durable decision id", async () => {
    const harness = createHarness([
      job("retry", { phase: "queued", reconciliation: intent("retry", "enqueue", "pending") }),
    ]);
    const attempts: string[] = [];
    harness.options.effects.queueSameJob = async ({ decisionId }) => {
      attempts.push(decisionId);
      if (attempts.length === 1) throw new Error("lost acknowledgement");
    };

    await expect(reconcileUnfinishedJobs(harness.options)).rejects.toBeInstanceOf(AggregateError);
    await reconcileUnfinishedJobs(harness.options);

    expect(attempts).toEqual(["decision-retry", "decision-retry"]);
    expect(harness.recorded).toEqual([]);
    expect(harness.marked).toEqual(["retry"]);
  });

  it("fails startup when recording the applied audit event fails", async () => {
    const harness = createHarness([
      job("audit-fails", { phase: "queued" }), job("must-not-run", { phase: "delivering" }),
    ], { failMarkFor: "audit-fails" });

    await expect(reconcileUnfinishedJobs(harness.options)).rejects.toBeInstanceOf(AggregateError);

    expect(harness.effects).toEqual(["queue:audit-fails", "delivery:must-not-run"]);
    expect(harness.marked).toEqual(["must-not-run"]);
  });
});

function createHarness(
  initialJobs: TelegramJob[],
  setup: {
    exact?: Map<string, TelegramExactTurnInspection | TelegramExactTurnInspection[]>;
    guardian?: Map<string, TelegramGuardianReconciliationInspection>;
    quarantined?: Array<{ jobId: string; reasonCode: string }>;
    failRecordFor?: string;
    failEffectFor?: string;
    failMarkFor?: string;
  } = {},
) {
  const jobs = new Map(initialJobs.map((value) => [value.id, structuredClone(value)]));
  const calls: string[] = [];
  const effects: string[] = [];
  const recorded: Array<{ jobId: string; decision: TelegramReconciliationDecision }> = [];
  const marked: string[] = [];
  const effect = (kind: string) => async ({ jobId }: { jobId: string }) => {
    calls.push(`effect:${kind}:${jobId}`);
    effects.push(`${kind}:${jobId}`);
    if (setup.failEffectFor === jobId) throw new Error("effect failed");
  };
  const inspectExactTurn = vi.fn(async ({ jobId }: { jobId: string }) => {
    const configured = setup.exact?.get(jobId);
    if (!Array.isArray(configured)) return configured ?? { state: "ambiguous" as const };
    return configured.shift() ?? { state: "ambiguous" as const };
  });
  const inspectGuardian = vi.fn(async ({ jobId }: { jobId: string }) =>
    setup.guardian?.get(jobId) ?? {
      availability: "available" as const, state: "failed" as const,
      reasonCode: "guardian_no_exact_turn",
    });
  const options: TelegramJobReconcilerOptions = {
    loadCandidates: async () => ({
      jobs: [...jobs.values()].map((value) => structuredClone(value)),
      quarantined: setup.quarantined ?? [],
    }),
    inspectExactTurn,
    inspectGuardian,
    recordDecision: async ({ jobId, decision, decidedAt }) => {
      calls.push(`record:${jobId}`);
      if (setup.failRecordFor === jobId) throw new Error("record failed");
      recorded.push({ jobId, decision });
      const value = jobs.get(jobId)!;
      const reconciliation: TelegramReconciliationIntent = {
        decision, state: "pending", decidedAt, appliedAt: null,
      };
      jobs.set(jobId, { ...value, reconciliation, version: value.version + 1 });
      return reconciliation;
    },
    markApplied: async ({ jobId, decisionId, appliedAt }) => {
      calls.push(`mark:${jobId}`);
      if (setup.failMarkFor === jobId) throw new Error("mark failed");
      marked.push(jobId);
      const value = jobs.get(jobId)!;
      if (value.reconciliation?.decision.id !== decisionId) throw new Error("decision mismatch");
      jobs.set(jobId, { ...value, reconciliation: {
        ...value.reconciliation, state: "applied", appliedAt,
      }, version: value.version + 1 });
    },
    effects: {
      restoreAccepted: effect("restore"), queueSameJob: effect("queue"),
      recoverExactTurn: effect("recover"),
      resumePendingDelivery: effect("delivery"), refreshStatus: effect("refresh"),
      requireAttention: async ({ jobId, reasonCode }) => {
        calls.push(`effect:attention:${jobId}`);
        effects.push(`attention:${jobId}:${reasonCode}`);
        if (setup.failEffectFor === jobId) throw new Error("effect failed");
      },
      terminateRecoveryInterrupted: effect("terminate"),
    },
    createDecisionId: (() => {
      let sequence = 0;
      return (value) => `decision-${value.id}-${++sequence}`;
    })(),
    now: () => NOW,
  };
  return { options, calls, effects, recorded, marked, inspectExactTurn, inspectGuardian };
}

function job(id: string, overrides: Partial<TelegramJob>): TelegramJob {
  return {
    schemaVersion: 1, id, version: 1, source: { botId: "bot", updateId: id.length }, attachments: [],
    phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt: NOW - 10_000, updatedAt: NOW - 1_000, terminalAt: null,
    dismissedAt: null, retainUntil: null, ...overrides,
  };
}

function dispatch(transportWriteState: "prepared" | "in_flight" | "written") {
  return {
    id: `dispatch-${transportWriteState}`, threadId: THREAD, previousTurnId: null,
    attempt: 1, startedAt: NOW - 2_000, transportWriteState, nextAttemptAt: null,
  } as const;
}

function intent(
  jobId: string,
  kind: TelegramReconciliationDecision["kind"],
  state: TelegramReconciliationIntent["state"],
): TelegramReconciliationIntent {
  return {
    decision: { id: `decision-${jobId}`, kind, threadId: null, turnId: null, reasonCode: null },
    state, decidedAt: NOW - 1_000, appliedAt: state === "applied" ? NOW - 500 : null,
  };
}

function kindsByJob(recorded: Array<{ jobId: string; decision: TelegramReconciliationDecision }>) {
  return Object.fromEntries(recorded.map(({ jobId, decision }) => [jobId, decision.kind]));
}
