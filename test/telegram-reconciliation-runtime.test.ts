import { vi } from "vitest";

import { createTelegramReconciliationRuntime } from "../src/telegram-reconciliation-runtime.js";
import { transitionJob } from "../src/telegram-job-transition.js";
import type { TelegramJob, TelegramJobEvent } from "../src/telegram-job-types.js";

const NOW = 1_700_000_400_000;
const THREAD = "11111111-1111-4111-8111-111111111111";
const TURN = "turn-exact";

describe("createTelegramReconciliationRuntime", () => {
  it("scans every page, persists all decisions, then applies production effects in order", async () => {
    const calls: string[] = [];
    const store = new FakeStore([
      job("accepted", { phase: "accepted" }),
      job("unknown", { phase: "dispatching", ...identity("in_flight") }),
      job("active", { phase: "running", ...identity("written") }),
      job("guardian", { phase: "running", ...identity("written", "thread-guardian", "turn-guardian") }),
      job("delivery", { phase: "delivering" }),
      job("terminal", { phase: "terminal", outcome: "failed", terminalAt: NOW }),
    ], calls, 2);
    const coordinator = {
      pump: vi.fn(async () => { calls.push("effect:pump"); }),
      recoverExactTurn: vi.fn(async (jobId: string) => {
        calls.push(`effect:recover:${jobId}`); return { scheduled: true };
      }),
    };
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator,
      materializer: { materialize: vi.fn(async (jobId: string) => {
        calls.push(`effect:materialize:${jobId}`);
        store.apply(jobId, {
          schemaVersion: 1, type: "materialization.succeeded", eventAt: NOW,
          materializedPrompt: { text: "prompt", attachments: [] },
        });
        return { text: "prompt", attachments: [] };
      }) },
      resumeDelivery: async (jobId) => { calls.push(`effect:delivery:${jobId}`); },
      refreshStatus: async (jobId) => { calls.push(`effect:status:${jobId}`); },
      exactTurnReader: { request: vi.fn(async (_method: string, params: unknown) => {
        const threadId = (params as { threadId: string }).threadId;
        return { thread: { id: threadId, turns: [{
          id: threadId === THREAD ? TURN : "other-turn",
          status: threadId === THREAD ? "inProgress" : "completed",
        }] } };
      }) },
      guardian: { inspectThread: vi.fn(async (threadId: string) => guardianInProgress(threadId)) },
      now: () => NOW,
      createId: (() => { let sequence = 0; return () => `runtime-event-${++sequence}`; })(),
      scanLimit: 2,
    });

    const result = await run();

    expect(store.scanCursors).toEqual([
      null,
      { acceptedAt: NOW, jobId: "active" },
      { acceptedAt: NOW, jobId: "guardian" },
      { acceptedAt: NOW, jobId: "unknown" },
    ]);
    const firstEffect = calls.findIndex((call) => call.startsWith("effect:"));
    expect(calls.slice(0, firstEffect)).toEqual([
      "transition:accepted:reconciliation.decided", "transition:active:reconciliation.decided",
      "transition:delivery:reconciliation.decided", "transition:guardian:reconciliation.decided",
      "transition:terminal:reconciliation.decided", "transition:unknown:reconciliation.decided",
    ]);
    expect(calls.slice(firstEffect)).toEqual([
      "effect:materialize:accepted", "transition:accepted:materialization.succeeded",
      "effect:pump",
      "transition:accepted:reconciliation.applied",
      "effect:recover:active",
      "transition:active:reconciliation.applied",
      "effect:delivery:delivery", "transition:delivery:reconciliation.applied",
      "transition:guardian:guardian.observed", "effect:status:guardian",
      "transition:guardian:reconciliation.applied",
      "effect:status:terminal", "transition:terminal:reconciliation.applied",
      "transition:unknown:guardian.observed", "effect:status:unknown",
      "transition:unknown:reconciliation.applied",
    ]);
    expect(store.get("unknown")).toMatchObject({
      health: "stalled",
      attention: { kind: "required", code: "dispatch_acceptance_unknown", actions: ["inspect"] },
    });
    expect(store.get("guardian")).toMatchObject({
      health: "checking",
      attention: { kind: "required", code: "guardian_repair_in_progress", actions: ["inspect"] },
    });
    expect(coordinator.recoverExactTurn).toHaveBeenCalledWith("active");
    expect(result).toMatchObject({ candidates: 6, decisionsPersisted: 6, effectsApplied: 6 });
  });

  it("accepts only matching durable winners after decision, effect, and applied CAS conflicts", async () => {
    const calls: string[] = [];
    const store = new FakeStore([
      job("queued", {
        phase: "dispatching", materializedPrompt: { text: "prompt", attachments: [] },
        dispatchId: "prepared-dispatch", threadId: THREAD, turnId: null,
        dispatch: {
          id: "prepared-dispatch", threadId: THREAD, previousTurnId: null, attempt: 1,
          startedAt: NOW, transportWriteState: "prepared", nextAttemptAt: null,
        },
      }),
    ], calls, 10);
    store.conflictAfterApply.add("reconciliation.decided");
    store.conflictAfterApply.add("job.queued");
    store.conflictAfterApply.add("reconciliation.applied");
    const pump = vi.fn(async () => { calls.push("effect:pump"); });
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator: { pump, recoverExactTurn: async () => ({ scheduled: false }) },
      materializer: { materialize: async () => ({ text: "prompt", attachments: [] }) },
      resumeDelivery: async () => {}, refreshStatus: async () => {},
      exactTurnReader: { request: async () => ({}) },
      guardian: { inspectThread: async () => { throw new Error("unused"); } },
      now: () => NOW,
      createId: (() => { let value = 0; return () => `conflict-event-${++value}`; })(),
      scanLimit: 10,
    });

    await expect(run()).resolves.toMatchObject({ decisionsPersisted: 1, effectsApplied: 1 });

    expect(store.get("queued")).toMatchObject({
      phase: "queued", reconciliation: { state: "applied" },
    });
    expect(pump).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call === "transition:queued:reconciliation.decided")).toHaveLength(1);
    expect(calls.filter((call) => call === "transition:queued:job.queued")).toHaveLength(1);
    expect(calls.filter((call) => call === "transition:queued:reconciliation.applied")).toHaveLength(1);
  });

  it("never pumps a queued job retaining ambiguous transport-write evidence", async () => {
    const calls: string[] = [];
    const store = new FakeStore([
      job("ambiguous-queued", { phase: "queued", ...identity("in_flight") }),
    ], calls, 10);
    const pump = vi.fn(async () => {});
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator: { pump, recoverExactTurn: async () => ({ scheduled: false }) },
      materializer: { materialize: async () => ({ text: "", attachments: [] }) },
      resumeDelivery: async () => {}, refreshStatus: async () => {},
      exactTurnReader: { request: async () => ({}) },
      guardian: { inspectThread: async () => { throw new Error("unused"); } },
      now: () => NOW,
    });

    await expect(run()).rejects.toThrow("Telegram job reconciliation failed");
    expect(pump).not.toHaveBeenCalled();
    expect(store.get("ambiguous-queued")).toMatchObject({
      phase: "queued", dispatch: { transportWriteState: "in_flight" },
      reconciliation: { state: "pending" },
    });
  });

  it.each(["returned_pending", "conflicted"] as const)(
    "does not replay effects when the matching winner is already applied (%s)",
    async (winnerMode) => {
      const calls: string[] = [];
      const store = new FakeStore([job("won", { phase: "queued" })], calls, 10);
      store.decisionWinnerMode = winnerMode;
      const pump = vi.fn(async () => {});
      const run = createTelegramReconciliationRuntime({
        store,
        coordinator: { pump, recoverExactTurn: async () => ({ scheduled: false }) },
        materializer: { materialize: async () => ({ text: "", attachments: [] }) },
        resumeDelivery: async () => {}, refreshStatus: async () => {},
        exactTurnReader: { request: async () => ({}) },
        guardian: { inspectThread: async () => { throw new Error("unused"); } },
        now: () => NOW,
      });

      await expect(run()).resolves.toMatchObject({
        decisionsPersisted: 1, effectsApplied: winnerMode === "returned_pending" ? 1 : 0,
      });
      expect(store.get("won")?.reconciliation?.state).toBe("applied");
      expect(pump).not.toHaveBeenCalled();
    },
  );

  it("persists recovery interruption before status refresh and is idempotent after a won conflict", async () => {
    const calls: string[] = [];
    const store = new FakeStore([
      job("restored", { phase: "running", ...identity("written") }),
    ], calls, 10);
    store.conflictAfterApply.add("job.terminal");
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator: { pump: async () => {}, recoverExactTurn: async () => ({ scheduled: false }) },
      materializer: { materialize: async () => ({ text: "", attachments: [] }) },
      resumeDelivery: async () => {},
      refreshStatus: async (jobId) => { calls.push(`effect:status:${jobId}`); },
      exactTurnReader: { request: async () => ({ thread: { id: THREAD, turns: [] } }) },
      guardian: { inspectThread: async () => guardianRestored(THREAD) },
      now: () => NOW, createId: (() => { let value = 0; return () => `event-${++value}`; })(),
    });

    await run();

    expect(store.get("restored")).toMatchObject({
      phase: "terminal", outcome: "recovery_interrupted",
      attention: { kind: "required", code: "guardian_restored_new_session", actions: ["retry"] },
      reconciliation: { state: "applied" },
    });
    expect(calls.indexOf("transition:restored:job.terminal"))
      .toBeLessThan(calls.indexOf("effect:status:restored"));
  });

  it("keeps decision timestamps monotonic when the local clock moved backwards", async () => {
    const calls: string[] = [];
    const store = new FakeStore([
      job("clock", { phase: "queued", updatedAt: NOW + 100 }),
    ], calls, 10);
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator: { pump: async () => {}, recoverExactTurn: async () => ({ scheduled: false }) },
      materializer: { materialize: async () => ({ text: "", attachments: [] }) },
      resumeDelivery: async () => {}, refreshStatus: async () => {},
      exactTurnReader: { request: async () => ({}) },
      guardian: { inspectThread: async () => { throw new Error("unused"); } },
      now: () => NOW, createId: (() => { let value = 0; return () => `clock-event-${++value}`; })(),
    });

    await expect(run()).resolves.toMatchObject({ effectsApplied: 1 });
    expect(store.get("clock")?.reconciliation).toMatchObject({
      state: "applied", decidedAt: NOW + 100,
    });
  });

  it("marks a pending enqueue intent applied when its effect already advanced the job before the audit write", async () => {
    const calls: string[] = [];
    const decision = {
      id: "lost-audit-enqueue",
      kind: "enqueue" as const,
      threadId: null,
      turnId: null,
      reasonCode: "restart_queued",
    };
    const store = new FakeStore([job("advanced", {
      phase: "running",
      ...identity("written"),
      reconciliation: {
        decision,
        state: "pending",
        decidedAt: NOW - 10,
        appliedAt: null,
      },
    })], calls, 10);
    const pump = vi.fn(async () => { throw new Error("must not replay an advanced enqueue"); });
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator: { pump, recoverExactTurn: async () => ({ scheduled: false }) },
      materializer: { materialize: async () => ({ text: "", attachments: [] }) },
      resumeDelivery: async () => {},
      refreshStatus: async () => {},
      exactTurnReader: { request: async () => ({}) },
      guardian: { inspectThread: async () => { throw new Error("unused"); } },
      now: () => NOW,
      createId: () => "lost-audit-applied",
    });

    await expect(run()).resolves.toMatchObject({ decisionsPersisted: 0, effectsApplied: 1 });

    expect(pump).not.toHaveBeenCalled();
    expect(store.get("advanced")?.reconciliation).toMatchObject({ state: "applied" });
  });

  it("safely requeues a pending enqueue interrupted before the transport write", async () => {
    const calls: string[] = [];
    const decision = {
      id: "lost-audit-prepared",
      kind: "enqueue" as const,
      threadId: THREAD,
      turnId: null,
      reasonCode: "restart_queued",
    };
    const store = new FakeStore([job("prepared", {
      phase: "dispatching",
      dispatchId: "dispatch-prepared",
      threadId: THREAD,
      dispatch: {
        id: "dispatch-prepared", threadId: THREAD, previousTurnId: null, attempt: 1,
        startedAt: NOW - 20, transportWriteState: "prepared", nextAttemptAt: null,
      },
      reconciliation: { decision, state: "pending", decidedAt: NOW - 10, appliedAt: null },
    })], calls, 10);
    const pump = vi.fn(async () => {});
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator: { pump, recoverExactTurn: async () => ({ scheduled: false }) },
      materializer: { materialize: async () => ({ text: "", attachments: [] }) },
      resumeDelivery: async () => {}, refreshStatus: async () => {},
      exactTurnReader: { request: async () => ({}) },
      guardian: { inspectThread: async () => { throw new Error("unused"); } },
      now: () => NOW,
      createId: (() => { let value = 0; return () => `prepared-event-${++value}`; })(),
    });

    await expect(run()).resolves.toMatchObject({ decisionsPersisted: 0, effectsApplied: 1 });

    expect(calls).toContain("transition:prepared:job.queued");
    expect(pump).toHaveBeenCalledOnce();
    expect(store.get("prepared")).toMatchObject({
      phase: "queued", reconciliation: { state: "applied" },
    });
  });

  it("does not let a hung Telegram status refresh block startup reconciliation", async () => {
    const calls: string[] = [];
    const store = new FakeStore([job("terminal-status", {
      phase: "terminal", outcome: "failed", terminalAt: NOW,
    })], calls, 10);
    const refreshStatus = vi.fn(() => new Promise<void>(() => {}));
    const run = createTelegramReconciliationRuntime({
      store,
      coordinator: { pump: async () => {}, recoverExactTurn: async () => ({ scheduled: false }) },
      materializer: { materialize: async () => ({ text: "", attachments: [] }) },
      resumeDelivery: async () => {}, refreshStatus,
      exactTurnReader: { request: async () => ({}) },
      guardian: { inspectThread: async () => { throw new Error("unused"); } },
      now: () => NOW,
      createId: (() => { let value = 0; return () => `status-event-${++value}`; })(),
    });

    await expect(run()).resolves.toMatchObject({ effectsApplied: 1 });

    expect(refreshStatus).toHaveBeenCalledWith("terminal-status");
    expect(store.get("terminal-status")?.reconciliation?.state).toBe("applied");
  });
});

class FakeStore {
  readonly jobs = new Map<string, TelegramJob>();
  readonly scanCursors: Array<{ acceptedAt: number; jobId: string } | null> = [];
  readonly conflictAfterApply = new Set<TelegramJobEvent["type"]>();
  readonly eventIds = new Map<string, Set<string>>();
  decisionWinnerMode: "returned_pending" | "conflicted" | null = null;

  constructor(jobs: readonly TelegramJob[], private readonly calls: string[], private readonly pageSize: number) {
    for (const value of jobs) this.jobs.set(value.id, structuredClone(value));
  }

  get(jobId: string): TelegramJob | null { return structuredClone(this.jobs.get(jobId) ?? null); }

  scanReconciliationCandidates(input: {
    limit: number; quarantinedAt: number; cursor?: { acceptedAt: number; jobId: string };
  }) {
    this.scanCursors.push(input.cursor ?? null);
    const ordered = [...this.jobs.values()].sort((left, right) => left.id.localeCompare(right.id));
    const start = input.cursor ? ordered.findIndex((value) => value.id === input.cursor!.jobId) + 1 : 0;
    const values = ordered.slice(start, start + Math.min(input.limit, this.pageSize));
    const last = values.at(-1);
    return {
      jobs: values, quarantined: [],
      nextCursor: values.length === Math.min(input.limit, this.pageSize) && last
        ? { acceptedAt: last.acceptedAt, jobId: last.id } : null,
    };
  }

  transition(input: { jobId: string; eventId: string; expectedVersion: number; event: Omit<TelegramJobEvent, "expectedVersion"> }): TelegramJob {
    this.calls.push(`transition:${input.jobId}:${input.event.type}`);
    const eventIds = this.eventIds.get(input.jobId) ?? new Set<string>();
    if (eventIds.has(input.eventId)) throw new Error("Duplicate Telegram job event id");
    eventIds.add(input.eventId);
    this.eventIds.set(input.jobId, eventIds);
    const current = this.jobs.get(input.jobId)!;
    const result = transitionJob(current, { ...input.event, expectedVersion: input.expectedVersion } as TelegramJobEvent);
    if (result.kind === "conflict") throw new Error("Telegram job version conflict");
    this.jobs.set(input.jobId, result.job);
    if (input.event.type === "reconciliation.decided" && this.decisionWinnerMode) {
      this.completeWinner(result.job, input.event.decision.id);
      if (this.decisionWinnerMode === "conflicted") throw new Error("Telegram job version conflict");
    }
    if (this.conflictAfterApply.delete(input.event.type)) throw new Error("Telegram job version conflict");
    return structuredClone(result.job);
  }

  apply(jobId: string, event: Omit<TelegramJobEvent, "expectedVersion">): TelegramJob {
    const current = this.jobs.get(jobId)!;
    return this.transition({ jobId, eventId: `fixture-${event.type}`, expectedVersion: current.version, event });
  }

  private completeWinner(pending: TelegramJob, decisionId: string): void {
    const queued = transitionJob(pending, {
      schemaVersion: 1, type: "job.queued", eventAt: pending.updatedAt, expectedVersion: pending.version,
    });
    if (queued.kind !== "applied") throw new Error("fixture queue conflict");
    const applied = transitionJob(queued.job, {
      schemaVersion: 1, type: "reconciliation.applied", eventAt: queued.job.updatedAt,
      expectedVersion: queued.job.version, decisionId,
    });
    if (applied.kind !== "applied") throw new Error("fixture applied conflict");
    this.jobs.set(pending.id, applied.job);
  }
}

function job(id: string, overrides: Partial<TelegramJob>): TelegramJob {
  return {
    schemaVersion: 1, id, version: 1, source: { botId: "bot", updateId: id.length }, attachments: [],
    phase: "queued", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, deliveries: [], acceptedAt: NOW, updatedAt: NOW,
    terminalAt: null, dismissedAt: null, retainUntil: null, ...overrides,
  };
}

function identity(
  transportWriteState: "in_flight" | "written",
  threadId = THREAD,
  turnId = TURN,
): Partial<TelegramJob> {
  return {
    dispatchId: "dispatch-id", threadId, turnId,
    dispatch: {
      id: "dispatch-id", threadId, previousTurnId: null, attempt: 1,
      startedAt: NOW, transportWriteState, nextAttemptAt: null,
    },
  };
}

function guardianInProgress(threadId: string) {
  return { outcome: "ok" as const, message: "ok", threadId, thread: {
    threadId, turnId: "turn-guardian", threadStatus: "active" as const, turnStatus: "inProgress",
    updatedAt: NOW, itemCount: 1, lastItemType: "agentMessage", source: "telecodex" as const,
    canAcceptDirectInput: true, root: true,
    observation: {
      guardianHealth: "stalled" as const, lastObservedAt: NOW, unchangedSince: NOW, staleForMs: 0,
      alertId: "AAAAAAAAAAAAAAAAAAAAAA", repairState: "in_progress" as const, repairOutcome: null,
    },
  } };
}

function guardianRestored(threadId: string) {
  const value = guardianInProgress(threadId);
  return { ...value, thread: { ...value.thread, observation: {
    ...value.thread.observation, repairState: "terminal" as const, repairOutcome: "restored" as const,
  } } };
}
