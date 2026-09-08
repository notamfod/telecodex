import {
  enrichTopicResumeAction,
  enrichTopicRecoveryAction,
  projectTelegramJobStatus,
  type TelegramJobStatusProjection,
  type TelegramStatusActionKind,
  type TelegramStatusGuardianEvidence,
} from "../src/telegram-status-projection.js";
import type { TelegramTopicRecoveryCandidate } from "../src/telegram-topic-recovery.js";
import type { TelegramTopicResumeCandidate } from "../src/telegram-topic-resume.js";
import type { DeliveryPart } from "../src/telegram-job-store.js";
import type { GuardianThreadInspection } from "../src/session-guardian-ipc-client.js";
import type { TelegramJob, TelegramJobEvent } from "../src/telegram-job-types.js";

const NOW = 1_700_000_100_000;
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

describe("projectTelegramJobStatus", () => {
  it("projects exact queue position, queue age, and versioned actions", () => {
    const projection = project({
      job: job({ phase: "queued", version: 7, acceptedAt: NOW - 45_000 }),
      queue: { position: 3 },
    });

    expect(projection).toMatchObject({
      schemaVersion: 1, jobId: "job-123456789", shortJobId: "job-1234", expectedVersion: 7,
      phase: "queued", state: "queued", isDone: false,
      queue: { position: 3, ageMs: 45_000 },
    });
    expect(actions(projection)).toEqual(["abort", "refresh", "details"]);
    expect(projection.actions).toEqual([
      action("abort", 7), action("refresh", 7), action("details", 7),
    ]);
  });

  it.each([
    ["prepared", null, "not_sent", "dispatching_not_sent"],
    ["in_flight", null, "written_unknown", "dispatching_unknown"],
    ["written", null, "written_unknown", "dispatching_unknown"],
    ["written", "turn-current", "turn_identified", "running"],
  ] as const)("distinguishes %s dispatch with turn %s", (writeState, turnId, dispatchState, state) => {
    const projection = project({ job: job({
      phase: "dispatching", threadId: THREAD_ID, turnId,
      dispatch: {
        id: "dispatch-1", threadId: THREAD_ID, previousTurnId: "turn-previous", attempt: 2,
        startedAt: NOW - 4_000, transportWriteState: writeState, nextAttemptAt: null,
      },
    }) });

    expect(projection).toMatchObject({
      state, threadId: THREAD_ID, turnId, dispatch: {
        state: dispatchState, previousTurnId: "turn-previous", attempt: 2,
        startedAt: NOW - 4_000, ageMs: 4_000,
      },
    });
    expect(actions(projection)).toEqual(turnId
      ? ["abort", "refresh", "details"]
      : ["inspect", "retry_new_turn", "details"]);
  });

  it("ages running activity only from the persisted real Codex event", () => {
    const running = job({
      phase: "running", activity: "tool", lastCodexEventAt: NOW - 9_000,
      updatedAt: NOW - 1_000, threadId: THREAD_ID, turnId: "turn-current",
    });
    const timerEvent: TelegramJobEvent = {
      schemaVersion: 1, type: "guardian.observed", eventAt: NOW - 500,
    };

    const first = project({ job: running, latestEvent: timerEvent });
    const refreshed = project({ job: running, latestEvent: timerEvent, now: NOW + 5_000 });

    expect(first).toMatchObject({
      state: "running", threadId: THREAD_ID, turnId: "turn-current",
      activity: { kind: "tool", eventAt: NOW - 9_000, ageMs: 9_000 },
      timestamps: { lastCodexEventAt: NOW - 9_000, lastEventAt: NOW - 500 },
    });
    expect(refreshed.activity).toEqual({ kind: "tool", eventAt: NOW - 9_000, ageMs: 14_000 });
    expect(refreshed.timestamps.lastCodexEventAt).toBe(first.timestamps.lastCodexEventAt);
  });

  it("lets authoritative Guardian stalled health override optimistic local health", () => {
    const projection = project({
      job: job({ phase: "running", health: "healthy", threadId: THREAD_ID, turnId: "turn-current" }),
      guardian: available(inspection({
        guardianHealth: "stalled", repairState: "eligible", alertId: "abcdefghijklmnopqrstuv",
      })),
    });

    expect(projection).toMatchObject({
      state: "stalled", health: "stalled",
      guardian: {
        availability: "available", health: "stalled", threadStatus: "active",
        lastObservedAt: NOW - 2_000, ageMs: 2_000, staleForMs: 60_000,
        alertId: "abcdefghijklmnopqrstuv", repairState: "eligible", reasonCode: "GUARDIAN_STALLED",
      },
      reasonCodes: ["GUARDIAN_STALLED"],
    });
    expect(actions(projection)).toEqual(["guardian_restore", "details"]);
    expect(projection.actions).toEqual([
      action("guardian_restore", 4, { alertId: "abcdefghijklmnopqrstuv" }), action("details", 4),
    ]);
  });

  it("keeps Guardian unavailability visible while ordinary work remains actionable", () => {
    const projection = project({
      job: job({ phase: "running", health: "healthy", threadId: THREAD_ID, turnId: "turn-current" }),
      guardian: { availability: "unavailable", reasonCode: "GUARDIAN_UNAVAILABLE" },
    });

    expect(projection).toMatchObject({
      state: "running", health: "unavailable",
      guardian: { availability: "unavailable", health: "unavailable", reasonCode: "GUARDIAN_UNAVAILABLE" },
      reasonCodes: ["GUARDIAN_UNAVAILABLE"],
    });
    expect(actions(projection)).toEqual(["abort", "refresh", "details"]);
  });

  it("keeps ambiguous target provisioning stalled and explicitly retryable", () => {
    const projection = project({ job: job({
      phase: "accepted",
      health: "stalled",
      attention: {
        kind: "required",
        code: "target_topic_provision_unknown",
        actions: ["inspect", "retry"],
      },
    }) });

    expect(projection).toMatchObject({ state: "stalled", health: "stalled" });
    expect(actions(projection)).toEqual(["inspect", "retry_new_turn", "details"]);
  });

  it("shows physical delivery counts and prioritizes failed over uncertain", () => {
    const projection = project({
      job: job({
        phase: "delivering", responsePlan: [
          { partId: "final:0000", kind: "final" }, { partId: "attachment:0000", kind: "attachment" },
        ],
      }),
      deliveries: [
        delivery("status-anchor", "status-anchor", "delivered", { telegramMessageId: 501 }),
        delivery("final:0000", "final", "uncertain", { lastErrorCode: "telegram_send_uncertain" }),
        delivery("attachment:0000", "attachment", "failed", { lastErrorCode: "telegram_permanent" }),
      ],
    });

    expect(projection).toMatchObject({
      state: "delivery_failed", anchorKnownDelivered: true,
      delivery: {
        total: 3, delivered: 1, pending: 0, sending: 0, uncertain: 1, failed: 1,
        anchorState: "delivered", anchorMessageId: 501, complete: false,
      },
      reasonCodes: ["telegram_permanent", "telegram_send_uncertain"],
    });
    expect(actions(projection)).toEqual(["retry_delivery", "details"]);
    expect(projection.actions[0]).toEqual(action("retry_delivery", 4, { partKey: "attachment:0000" }));
  });

  it("offers warned resend for uncertain delivery when no part has failed", () => {
    const projection = project({
      job: job({ phase: "delivering", responsePlan: [] }),
      deliveries: [delivery("status-anchor", "status-anchor", "uncertain", {
        lastErrorCode: "telegram_send_uncertain",
      })],
    });

    expect(projection.state).toBe("delivery_uncertain");
    expect(actions(projection)).toEqual(["send_again_warning", "details"]);
    expect(projection.actions[0]).toEqual(action("send_again_warning", 4, { partKey: "status-anchor" }));
  });

  it("targets every failed part with a separate exact legal action", () => {
    const projection = project({
      job: job({ phase: "delivering", responsePlan: [
        { partId: "final:0000", kind: "final" },
        { partId: "final:0001", kind: "final" },
      ] }),
      deliveries: [
        delivery("status-anchor", "status-anchor", "delivered", { telegramMessageId: 501 }),
        delivery("final:0000", "final", "failed"),
        delivery("final:0001", "final", "failed"),
      ],
    });

    expect(projection.actions).toEqual([
      action("retry_delivery", 4, { partKey: "final:0000" }),
      action("retry_delivery", 4, { partKey: "final:0001" }),
      action("details", 4),
    ]);
  });

  it("enriches only a matching server-proven missing-topic candidate", () => {
    const projection = project({
      job: job({ phase: "delivering", version: 7 }),
      deliveries: [delivery("status-anchor", "status-anchor", "failed")],
    });
    const original = structuredClone(projection);

    expect(enrichTopicRecoveryAction(projection, recoveryCandidate()).actions[0]).toEqual({
      kind: "recover_missing_topic",
      jobId: projection.jobId,
      expectedVersion: projection.expectedVersion,
    });
    expect(enrichTopicRecoveryAction(projection, null)).toBe(projection);
    expect(projection).toEqual(original);
    expect(() => enrichTopicRecoveryAction(projection, recoveryCandidate({ expectedVersion: 8 })))
      .toThrow("Topic recovery candidate does not match status projection");
  });

  it.each(["in_flight", "retry_wait", "unknown"] as const)(
    "suppresses only the affected anchor retry while recovery is %s",
    (recoveryState) => {
      const projection = project({
        job: job({ phase: "delivering", version: 7, responsePlan: [
          { partId: "final:0000", kind: "final" },
        ] }),
        deliveries: [
          delivery("status-anchor", "status-anchor", "failed"),
          delivery("final:0000", "final", "failed"),
        ],
      });

      expect(enrichTopicRecoveryAction(projection, null, recoveryState).actions).toEqual([
        action("retry_delivery", 7, { partKey: "final:0000" }),
        action("details", 7),
      ]);
      expect(enrichTopicRecoveryAction(
        projection,
        recoveryCandidate(),
        recoveryState,
      ).actions).toEqual([
        action("retry_delivery", 7, { partKey: "final:0000" }),
        action("details", 7),
      ]);
    },
  );

  it("enriches only a matching server-proven existing-topic resume candidate", () => {
    const projection = project({
      job: job({ phase: "delivering", version: 541 }),
      deliveries: [delivery("status-anchor", "status-anchor", "failed")],
    });
    const original = structuredClone(projection);

    expect(enrichTopicResumeAction(projection, resumeCandidate()).actions[0]).toEqual({
      kind: "resume_existing_topic",
      jobId: projection.jobId,
      expectedVersion: projection.expectedVersion,
    });
    expect(enrichTopicResumeAction(projection, null)).toBe(projection);
    expect(projection).toEqual(original);
    expect(() => enrichTopicResumeAction(projection, resumeCandidate({ expectedVersion: 542 })))
      .toThrow("Topic resume candidate does not match status projection");
  });

  it.each([
    "probe_in_flight",
    "probe_retry_wait",
    "reopen_in_flight",
    "reopen_retry_wait",
    "reopen_unknown",
    "delivery_handoff",
  ] as const)("suppresses only the affected anchor retry while resume is %s", (resumeState) => {
    const projection = project({
      job: job({ phase: "delivering", version: 541, responsePlan: [
        { partId: "final:0000", kind: "final" },
      ] }),
      deliveries: [
        delivery("status-anchor", "status-anchor", "failed"),
        delivery("final:0000", "final", "failed"),
      ],
    });

    expect(enrichTopicResumeAction(projection, null, resumeState).actions).toEqual([
      action("retry_delivery", 541, { partKey: "final:0000" }),
      action("details", 541),
    ]);
    expect(enrichTopicResumeAction(projection, resumeCandidate(), resumeState).actions).toEqual([
      action("retry_delivery", 541, { partKey: "final:0000" }),
      action("details", 541),
    ]);
  });

  it("never renders completed as Done until the anchor identity and all planned parts are delivered", () => {
    const incomplete = project({
      job: job({
        phase: "terminal", outcome: "completed", terminalAt: NOW - 1_000,
        responsePlan: [{ partId: "final:0000", kind: "final" }],
      }),
      deliveries: [
        delivery("status-anchor", "status-anchor", "delivered"),
        delivery("final:0000", "final", "delivered", { telegramMessageId: 601 }),
      ],
    });
    const complete = project({
      job: job({ phase: "terminal", outcome: "completed", terminalAt: NOW - 1_000, responsePlan: [] }),
      deliveries: [delivery("status-anchor", "status-anchor", "delivered", { telegramMessageId: 501 })],
    });

    expect(incomplete).toMatchObject({ state: "terminal_incomplete", isDone: false, anchorKnownDelivered: false });
    expect(complete).toMatchObject({ state: "terminal_delivered", isDone: true, anchorKnownDelivered: true });
    expect(actions(complete)).toEqual(["details"]);
  });

  it("projects physical completion for failed terminals and does not let stale Guardian health override them", () => {
    const terminalJob = job({
      phase: "terminal", outcome: "failed", terminalAt: NOW - 1_000,
      threadId: THREAD_ID, turnId: "turn-current",
    });
    const guardian = available(inspection({ guardianHealth: "stalled" }));
    const complete = project({
      job: terminalJob,
      guardian,
      deliveries: [delivery("status-anchor", "status-anchor", "delivered", {
        telegramMessageId: 501,
      })],
    });
    const incomplete = project({
      job: terminalJob,
      guardian,
      deliveries: [
        delivery("status-anchor", "status-anchor", "delivered", { telegramMessageId: 501 }),
        delivery("failure:0000", "failure", "pending"),
      ],
    });

    expect(complete).toMatchObject({
      state: "terminal_failed", isDone: false, delivery: { complete: true },
      guardian: { health: "stalled" },
    });
    expect(incomplete).toMatchObject({
      state: "terminal_failed", isDone: false, delivery: { complete: false },
      guardian: { health: "stalled" },
    });
  });

  it("keeps completion processing failures inspectable and retryable", () => {
    const projection = project({
      job: job({
        phase: "terminal",
        outcome: "failed",
        terminalAt: NOW - 1_000,
        attention: {
          kind: "required",
          code: "completion_processing_failed",
          actions: ["inspect", "retry"],
        },
      }),
      deliveries: [delivery("status-anchor", "status-anchor", "delivered", {
        telegramMessageId: 501,
      })],
    });

    expect(projection).toMatchObject({
      state: "terminal_failed",
      attention: { kind: "required", code: "completion_processing_failed" },
    });
    expect(actions(projection)).toEqual(["inspect", "retry_new_turn", "details"]);
  });

  it("retains a durable terminal retry action and ignores unsupported duplicates", () => {
    const projection = project({
      job: job({
        phase: "terminal",
        outcome: "recovery_interrupted",
        terminalAt: NOW - 1_000,
        attention: {
          kind: "required",
          code: "guardian_restored_new_session",
          actions: ["unsupported", "retry", "retry"],
        },
      }),
    });

    expect(projection).toMatchObject({
      state: "terminal_recovery_interrupted",
      attention: {
        kind: "required",
        code: "guardian_restored_new_session",
        actions: ["unsupported", "retry", "retry"],
      },
      reasonCodes: ["guardian_restored_new_session"],
    });
    expect(actions(projection)).toEqual(["retry_new_turn", "details"]);
    expect(projection.actions).toEqual([
      action("retry_new_turn", 4),
      action("details", 4),
    ]);
  });

  it("retains exact timestamps, attention, and safe reason codes in one surface-neutral DTO", () => {
    const latestEvent: TelegramJobEvent = {
      schemaVersion: 1, type: "dispatch.in_flight", eventAt: NOW - 4_000,
      attention: { kind: "required", code: "DISPATCH_UNKNOWN", actions: ["inspect"] },
    };
    const projection = project({
      job: job({
        phase: "dispatching", health: "checking", updatedAt: NOW - 3_000,
        attention: { kind: "required", code: "DISPATCH_UNKNOWN", actions: ["inspect"] },
      }),
      latestEvent,
      deliveries: [delivery("status-anchor", "status-anchor", "pending", {
        lastErrorCode: "telegram_retry_after",
      })],
    });

    const telegramDto: TelegramJobStatusProjection = projection;
    const statusDto: TelegramJobStatusProjection = projection;
    const dashboardDto: TelegramJobStatusProjection = projection;
    expect([telegramDto, statusDto, dashboardDto]).toEqual([projection, projection, projection]);
    expect(projection).toMatchObject({
      attention: { kind: "required", code: "DISPATCH_UNKNOWN", actions: ["inspect"] },
      timestamps: {
        acceptedAt: NOW - 60_000, updatedAt: NOW - 3_000, terminalAt: null,
        lastEventAt: NOW - 4_000, lastCodexEventAt: null, guardianLastObservedAt: null,
      },
      reasonCodes: ["DISPATCH_UNKNOWN", "telegram_retry_after"],
    });
  });

  it("rejects cross-job delivery and cross-thread Guardian evidence", () => {
    expect(() => project({ deliveries: [delivery("status-anchor", "status-anchor", "pending", {
      jobId: "other-job",
    })] })).toThrow("Status delivery job mismatch");
    expect(() => project({
      job: job({ threadId: THREAD_ID }),
      guardian: available({ ...inspection(), threadId: "22222222-2222-4222-8222-222222222222" }),
    })).toThrow("Status Guardian thread mismatch");
  });
});

function project(overrides: Partial<Parameters<typeof projectTelegramJobStatus>[0]> = {}) {
  return projectTelegramJobStatus({
    job: job(), latestEvent: null, deliveries: [], guardian: available(null), queue: null, now: NOW,
    ...overrides,
  });
}

function job(overrides: Partial<TelegramJob> = {}): TelegramJob {
  return {
    schemaVersion: 1, id: "job-123456789", version: 4, source: { botId: "bot", updateId: 1 }, attachments: [],
    phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt: NOW - 60_000, updatedAt: NOW - 10_000, terminalAt: null,
    dismissedAt: null, retainUntil: null, ...overrides,
  };
}

function delivery(
  partKey: string,
  kind: string,
  state: DeliveryPart["state"],
  overrides: Partial<DeliveryPart> = {},
): DeliveryPart {
  return {
    jobId: "job-123456789", partKey, ordinal: 0, kind, state, payload: {}, contentHash: "a".repeat(64),
    telegramMessageId: null, attemptCount: 0, nextAttemptAt: null, lastErrorCode: null,
    updatedAt: NOW - 1_000, ...overrides,
  };
}

function available(inspectionValue: GuardianThreadInspection | null): TelegramStatusGuardianEvidence {
  return { availability: "available", inspection: inspectionValue };
}

function inspection(
  observationOverrides: Partial<NonNullable<GuardianThreadInspection["observation"]>> = {},
): GuardianThreadInspection {
  return {
    threadId: THREAD_ID, turnId: "turn-current", threadStatus: "active", turnStatus: "inProgress",
    updatedAt: NOW - 1_000, itemCount: 2, lastItemType: "agentMessage", source: "telecodex",
    canAcceptDirectInput: false, root: true,
    observation: {
      guardianHealth: "healthy", lastObservedAt: NOW - 2_000, unchangedSince: NOW - 60_000,
      staleForMs: 60_000, alertId: null, repairState: "none", repairOutcome: null,
      ...observationOverrides,
    },
  };
}

function action(
  kind: TelegramStatusActionKind,
  expectedVersion: number,
  target: { readonly alertId?: string; readonly partKey?: string } = {},
) {
  return { kind, jobId: "job-123456789", expectedVersion, ...target };
}

function actions(projection: TelegramJobStatusProjection): TelegramStatusActionKind[] {
  return projection.actions.map((value) => value.kind);
}

function recoveryCandidate(
  overrides: Partial<TelegramTopicRecoveryCandidate> = {},
): TelegramTopicRecoveryCandidate {
  return {
    jobId: "job-123456789",
    expectedVersion: 7,
    threadId: THREAD_ID,
    topicName: "Recovered topic",
    oldDestination: { chatId: -1001, messageThreadId: 7 },
    parts: [],
    anchorPlan: {
      partKey: "status-anchor",
      payload: {
        operation: "send_text",
        chatId: -1001,
        messageThreadId: 7,
        text: "Status",
      },
      contentHash: "a".repeat(64),
    },
    ...overrides,
  };
}

function resumeCandidate(
  overrides: Partial<TelegramTopicResumeCandidate> = {},
): TelegramTopicResumeCandidate {
  return {
    jobId: "job-123456789",
    expectedVersion: 541,
    threadId: THREAD_ID,
    destination: { chatId: -1001, messageThreadId: 7 },
    anchorPartKey: "status-anchor",
    anchorAttemptCount: 1,
    ...overrides,
  };
}
