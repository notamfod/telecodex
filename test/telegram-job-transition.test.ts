import {
  JobTransitionError,
  assertTransition,
  isDoneEligible,
  transitionJob,
  type JobPhase,
  type TelegramJob,
  type TelegramJobEvent,
} from "../src/telegram-job-transition.js";

const eventAt = 1_700_000_001_000;

function makeJob(overrides: Partial<TelegramJob> = {}): TelegramJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    version: 1,
    source: { botId: "telecodex-bot", updateId: 10 },
    attachments: [],
    phase: "accepted",
    health: "healthy",
    activity: "unknown",
    attention: { kind: "none" },
    outcome: null,
    dispatchId: null,
    threadId: null,
    turnId: null,
    responsePlan: undefined,
    deliveries: [],
    acceptedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
    ...overrides,
  };
}

function apply(previous: TelegramJob, event: TelegramJobEvent): TelegramJob {
  const result = transitionJob(previous, event);
  if (result.kind === "conflict") throw new Error(`Unexpected conflict: ${result.code}`);
  return result.job;
}

function phaseEvent(phase: JobPhase): TelegramJobEvent {
  switch (phase) {
    case "accepted":
      return { schemaVersion: 1, type: "update.accepted", eventAt };
    case "queued":
      return { schemaVersion: 1, type: "job.queued", eventAt };
    case "dispatching":
      return { schemaVersion: 1, type: "dispatch.written", eventAt };
    case "running":
      return { schemaVersion: 1, type: "turn.started", eventAt };
    case "delivering":
      return { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt };
    case "terminal":
      return { schemaVersion: 1, type: "job.terminal", outcome: "failed", eventAt };
  }
}

describe("telegram job transitions", () => {
  it("allows every edge in the durable phase graph", () => {
    const allowed: Readonly<Record<JobPhase, readonly JobPhase[]>> = {
      accepted: ["accepted", "queued", "terminal"],
      queued: ["queued", "dispatching", "terminal"],
      dispatching: ["dispatching", "queued", "running", "terminal"],
      running: ["running", "delivering", "terminal"],
      delivering: ["delivering", "terminal"],
      terminal: ["terminal"],
    };

    for (const [from, destinations] of Object.entries(allowed) as [JobPhase, JobPhase[]][]) {
      for (const to of destinations) {
        expect(apply(makeJob({ phase: from, outcome: from === "terminal" ? "failed" : null, terminalAt: from === "terminal" ? 1_700_000_000_000 : null }), phaseEvent(to)).phase)
          .toBe(to);
      }
    }
  });

  it("rejects every backward or skip phase edge", () => {
    const phases: readonly JobPhase[] = [
      "accepted", "queued", "dispatching", "running", "delivering", "terminal",
    ];
    const allowed: Readonly<Record<JobPhase, readonly JobPhase[]>> = {
      accepted: ["accepted", "queued", "terminal"],
      queued: ["queued", "dispatching", "terminal"],
      dispatching: ["dispatching", "queued", "running", "terminal"],
      running: ["running", "delivering", "terminal"],
      delivering: ["delivering", "terminal"],
      terminal: ["terminal"],
    };

    for (const from of phases) {
      for (const to of phases) {
        if (allowed[from].includes(to)) continue;
        expect(() => apply(makeJob({ phase: from, outcome: from === "terminal" ? "failed" : null, terminalAt: from === "terminal" ? 1_700_000_000_000 : null }), phaseEvent(to))).toThrowError(
          expect.objectContaining({ code: "INVALID_PHASE_TRANSITION" }),
        );
      }
    }
  });

  it("supports same-phase health, activity, attention, timestamp, and identifier updates", () => {
    const next = apply(makeJob(), {
      schemaVersion: 1,
      type: "activity.observed",
      health: "quiet",
      activity: "tool",
      attention: { kind: "required", code: "MODEL_INPUT_REQUIRED", actions: ["choose_model"] },
      identifiers: { dispatchId: "dispatch-1", threadId: "thread-1", turnId: "turn-1" },
      eventAt,
    });

    expect(next).toMatchObject({
      phase: "accepted",
      health: "quiet",
      activity: "tool",
      attention: { kind: "required", code: "MODEL_INPUT_REQUIRED", actions: ["choose_model"] },
      dispatchId: "dispatch-1",
      threadId: "thread-1",
      turnId: "turn-1",
      updatedAt: eventAt,
      version: 2,
    });
  });

  it("keeps terminal jobs immutable except deliveries, dismissal, retention, and update metadata", () => {
    const terminal = makeJob({
      phase: "terminal",
      outcome: "completed",
      responsePlan: [{ partId: "final", kind: "final" }],
      deliveries: [{ partId: "final", state: "pending", attempts: 0, messageId: null, deliveredAt: null }],
      terminalAt: 1_700_000_000_000,
    });

    const updated = apply(terminal, {
      schemaVersion: 1,
      type: "delivery.changed",
      deliveries: [{ partId: "final", state: "delivered", attempts: 1, messageId: 44, deliveredAt: eventAt }],
      dismissedAt: eventAt,
      retainUntil: eventAt + 10_000,
      eventAt,
    });
    expect(updated.deliveries[0]?.state).toBe("delivered");
    expect(updated.dismissedAt).toBe(eventAt);
    expect(updated.retainUntil).toBe(eventAt + 10_000);

    expect(() => apply(updated, {
      schemaVersion: 1,
      type: "guardian.observed",
      health: "stalled",
      eventAt: eventAt + 1,
    })).toThrowError(expect.objectContaining({ code: "TERMINAL_IMMUTABLE" }));
  });

  it("requires a response plan before completing a job", () => {
    expect(() => apply(makeJob(), {
      schemaVersion: 1,
      type: "job.terminal",
      outcome: "completed",
      eventAt,
    })).toThrowError(expect.objectContaining({ code: "COMPLETED_REQUIRES_RESPONSE_PLAN" }));
  });

  it("allows Done only after completion and successful delivery of every planned part", () => {
    const completed = makeJob({
      phase: "terminal",
      outcome: "completed",
      responsePlan: [{ partId: "final", kind: "final" }, { partId: "summary", kind: "summary" }],
      deliveries: [
        { partId: "final", state: "delivered", attempts: 1, messageId: 44, deliveredAt: eventAt },
        { partId: "summary", state: "delivered", attempts: 1, messageId: 45, deliveredAt: eventAt },
      ],
      terminalAt: eventAt,
      updatedAt: eventAt,
    });

    expect(isDoneEligible(completed)).toBe(true);
    expect(isDoneEligible(makeJob({
      ...completed,
      deliveries: [
        completed.deliveries[0]!,
        { partId: "summary", state: "uncertain", attempts: 1, messageId: null, deliveredAt: null },
      ],
    }))).toBe(false);
    expect(isDoneEligible(makeJob({ ...completed, outcome: "failed" }))).toBe(false);
  });

  it("returns a typed conflict for an optimistic-version mismatch", () => {
    const result = transitionJob(makeJob(), {
      schemaVersion: 1,
      type: "job.queued",
      expectedVersion: 2,
      eventAt,
    });

    expect(result).toEqual({
      kind: "conflict",
      code: "VERSION_MISMATCH",
      expectedVersion: 2,
      actualVersion: 1,
    });
  });

  it("rejects timestamps that move backward", () => {
    expect(() => apply(makeJob(), {
      schemaVersion: 1,
      type: "job.queued",
      eventAt: 1_699_999_999_999,
    })).toThrowError(expect.objectContaining({ code: "TIMESTAMP_REGRESSION" }));
  });

  it("exposes stable errors for invalid transitions", () => {
    expect(() => apply(makeJob({ phase: "dispatching" }), {
      schemaVersion: 1,
      type: "delivery.changed",
      eventAt,
    })).toThrowError(JobTransitionError);
  });

  it("uses the bot update as the durable Telegram deduplication identity", () => {
    expect(makeJob().source).toEqual({ botId: "telecodex-bot", updateId: 10 });
  });

  it("rejects an untrusted event with a phase that disagrees with its type", () => {
    const untrustedEvent = {
      schemaVersion: 1,
      type: "job.queued",
      phase: "accepted",
      eventAt,
    } as unknown as TelegramJobEvent;

    expect(() => apply(makeJob(), untrustedEvent)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT_PHASE" }),
    );
  });

  it("rejects unsupported job and event schema versions", () => {
    expect(() => apply(
      makeJob({ schemaVersion: 2 as 1 }),
      { schemaVersion: 1, type: "job.queued", eventAt },
    )).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_JOB_SCHEMA_VERSION" }));
    expect(() => apply(
      makeJob(),
      { schemaVersion: 2 as 1, type: "job.queued", eventAt },
    )).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EVENT_SCHEMA_VERSION" }));
  });

  it("rejects dismissed, retention, and delivery timestamps that move backward", () => {
    const terminal = makeJob({
      phase: "terminal",
      outcome: "failed",
      terminalAt: 1_700_000_000_000,
      dismissedAt: eventAt,
      retainUntil: eventAt + 10_000,
      deliveries: [{ partId: "final", state: "delivered", attempts: 1, messageId: 44, deliveredAt: eventAt }],
    });

    expect(() => apply(terminal, {
      schemaVersion: 1,
      type: "delivery.changed",
      dismissedAt: eventAt - 1,
      eventAt: eventAt + 100,
    })).toThrowError(expect.objectContaining({ code: "TIMESTAMP_REGRESSION" }));
    expect(() => apply(terminal, {
      schemaVersion: 1,
      type: "delivery.changed",
      retainUntil: eventAt + 9_999,
      eventAt: eventAt + 100,
    })).toThrowError(expect.objectContaining({ code: "TIMESTAMP_REGRESSION" }));
    expect(() => apply(terminal, {
      schemaVersion: 1,
      type: "delivery.changed",
      deliveries: [{ partId: "final", state: "delivered", attempts: 2, messageId: 44, deliveredAt: eventAt - 1 }],
      eventAt: eventAt + 100,
    })).toThrowError(expect.objectContaining({ code: "TIMESTAMP_REGRESSION" }));
    expect(() => apply(terminal, {
      schemaVersion: 1,
      type: "delivery.changed",
      deliveries: [],
      eventAt: eventAt + 100,
    })).toThrowError(expect.objectContaining({ code: "TIMESTAMP_REGRESSION" }));
  });

  it("rejects malformed persisted job and event shapes with stable errors", () => {
    expect(() => apply(null as unknown as TelegramJob, {
      schemaVersion: 1,
      type: "job.queued",
      eventAt,
    })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_SHAPE" }));
    expect(() => apply(makeJob({ phase: "unknown" as JobPhase }), {
      schemaVersion: 1,
      type: "job.queued",
      eventAt,
    })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_SHAPE" }));
    expect(() => apply(makeJob({ attention: { kind: "required", code: "A", actions: "not-an-array" } as never }), {
      schemaVersion: 1,
      type: "job.queued",
      eventAt,
    })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_SHAPE" }));
    expect(() => apply(makeJob({ source: { botId: "bot", updateId: -1 } }), {
      schemaVersion: 1,
      type: "job.queued",
      eventAt,
    })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_SHAPE" }));
    expect(() => apply(makeJob(), {
      schemaVersion: 1,
      type: "unknown.event",
      eventAt,
    } as unknown as TelegramJobEvent)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT_TYPE" }),
    );
    expect(() => apply(makeJob(), {
      schemaVersion: 1,
      type: "job.terminal",
      eventAt,
    } as unknown as TelegramJobEvent)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT_SHAPE" }),
    );
    expect(() => apply(makeJob({ phase: "running" }), {
      schemaVersion: 1,
      type: "delivery.changed",
      deliveries: [{ partId: "final", state: "unknown", attempts: 0, messageId: null, deliveredAt: null }],
      eventAt,
    } as unknown as TelegramJobEvent)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT_SHAPE" }),
    );
    expect(() => apply(makeJob(), {
      schemaVersion: 1,
      type: "job.queued",
      queueId: "ignored-legacy-field",
      eventAt,
    } as unknown as TelegramJobEvent)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT_SHAPE" }),
    );
  });

  it("rejects unsafe versions and increment overflow", () => {
    for (const version of [1.5, -1, Number.NaN, "1"] as const) {
      expect(() => apply(makeJob({ version: version as never }), {
        schemaVersion: 1,
        type: "job.queued",
        eventAt,
      })).toThrowError(expect.objectContaining({ code: "INVALID_VERSION" }));
    }
    for (const expectedVersion of [1.5, -1, Number.NaN, "1"] as const) {
      expect(() => apply(makeJob(), {
        schemaVersion: 1,
        type: "job.queued",
        expectedVersion: expectedVersion as never,
        eventAt,
      })).toThrowError(expect.objectContaining({ code: "INVALID_VERSION" }));
    }
    expect(() => apply(makeJob({ version: Number.MAX_SAFE_INTEGER }), {
      schemaVersion: 1,
      type: "job.queued",
      eventAt,
    })).toThrowError(expect.objectContaining({ code: "VERSION_OVERFLOW" }));
  });

  it("returns a job isolated from mutable previous and event values", () => {
    const previous = makeJob({
      phase: "running",
      source: { botId: "bot", updateId: 10 },
      attachments: [{ id: "a", kind: "document", telegramFileId: "file", name: "before" }],
      attention: { kind: "required", code: "OLD", actions: ["old"] },
      responsePlan: [{ partId: "old", kind: "notice" }],
      deliveries: [{ partId: "old", state: "pending", attempts: 0, messageId: null, deliveredAt: null }],
    });
    const event: TelegramJobEvent = {
      schemaVersion: 1,
      type: "delivery.changed",
      attention: { kind: "required", code: "NEW", actions: ["new"] },
      responsePlan: [{ partId: "final", kind: "final" }],
      deliveries: [{ partId: "final", state: "pending", attempts: 0, messageId: null, deliveredAt: null }],
      eventAt,
    };
    const next = apply(previous, event);

    (previous.source as { botId: string }).botId = "changed";
    (previous.attachments[0] as { name?: string }).name = "changed";
    ((previous.attention as { actions: string[] }).actions)[0] = "changed";
    (event.attention as { actions: string[] }).actions[0] = "changed";
    (event.responsePlan as { partId: string }[])[0]!.partId = "changed";
    (event.deliveries as { state: string }[])[0]!.state = "failed";

    expect(next.source.botId).toBe("bot");
    expect(next.attachments[0]?.name).toBe("before");
    expect(next.attention).toEqual({ kind: "required", code: "NEW", actions: ["new"] });
    expect(next.responsePlan).toEqual([{ partId: "final", kind: "final" }]);
    expect(next.deliveries[0]?.state).toBe("pending");
  });

  it("rejects malformed Done snapshots and ignores no unknown delivery parts", () => {
    const completed = makeJob({
      phase: "terminal",
      outcome: "completed",
      terminalAt: eventAt,
      updatedAt: eventAt,
      responsePlan: [{ partId: "final", kind: "final" }],
      deliveries: [
        { partId: "final", state: "delivered", attempts: 0, messageId: null, deliveredAt: null },
        { partId: "unknown", state: "delivered", attempts: 0, messageId: null, deliveredAt: null },
      ],
    });

    expect(isDoneEligible(completed)).toBe(false);
    expect(isDoneEligible(makeJob({ ...completed, deliveries: [{
      partId: "final", state: "invalid", attempts: 0, messageId: null, deliveredAt: null,
    }] as never }))).toBe(false);
    expect(isDoneEligible(makeJob({ ...completed, deliveries: [] }))).toBe(false);
    expect(isDoneEligible(makeJob({
      ...completed,
      deliveries: [completed.deliveries[0]!, completed.deliveries[0]!],
    }))).toBe(false);
  });

  it("accepts property-order-equivalent terminal values and JSON round trips", () => {
    const terminal = makeJob({
      phase: "terminal",
      outcome: "failed",
      terminalAt: eventAt,
      updatedAt: eventAt,
      source: { botId: "bot", updateId: 10 },
      attention: { kind: "required", code: "CHECK", actions: ["retry"] },
    });
    const reordered = {
      ...terminal,
      version: 2,
      updatedAt: eventAt + 1,
      source: { updateId: 10, botId: "bot" },
      attention: { actions: ["retry"], code: "CHECK", kind: "required" },
    } as TelegramJob;

    expect(() => assertTransition(terminal, reordered)).not.toThrow();
    const restored = JSON.parse(JSON.stringify(makeJob())) as TelegramJob;
    expect(apply(restored, {
      schemaVersion: 1,
      type: "activity.observed",
      activity: "waiting",
      eventAt,
    }).activity).toBe("waiting");
  });

  it("rejects invalid delivery counters, Telegram ids, lifecycle timestamps, and v1 fields", () => {
    const invalidJobs: readonly [TelegramJob, string][] = [
      [makeJob({ deliveries: [{ partId: "p", state: "pending", attempts: -1, messageId: null, deliveredAt: null }] }), "INVALID_JOB_SHAPE"],
      [makeJob({ deliveries: [{ partId: "p", state: "pending", attempts: 0, messageId: 0, deliveredAt: null }] }), "INVALID_JOB_SHAPE"],
      [JSON.parse(JSON.stringify(makeJob({ phase: "terminal", outcome: "failed" }))), "INVALID_JOB_LIFECYCLE"],
      [makeJob({ terminalAt: eventAt }), "INVALID_JOB_LIFECYCLE"],
      [makeJob({ acceptedAt: eventAt, updatedAt: eventAt - 1 }), "INVALID_JOB_LIFECYCLE"],
      [makeJob({ phase: "terminal", outcome: "failed", terminalAt: eventAt - 1 }), "INVALID_JOB_LIFECYCLE"],
      [makeJob({ phase: "terminal", outcome: "failed", terminalAt: eventAt + 1, updatedAt: eventAt }), "INVALID_JOB_LIFECYCLE"],
      [{ ...makeJob(), unknownV1Field: true } as TelegramJob, "INVALID_JOB_SHAPE"],
    ];
    for (const [job, code] of invalidJobs) {
      expect(() => apply(job, { schemaVersion: 1, type: "activity.observed", eventAt: eventAt + 10 })).toThrowError(
        expect.objectContaining({ code }),
      );
    }
    for (const delivery of [
      { partId: "p", state: "pending", attempts: -1, messageId: null, deliveredAt: null },
      { partId: "p", state: "pending", attempts: 0, messageId: 0, deliveredAt: null },
    ]) {
      expect(() => apply(makeJob({ phase: "running" }), {
        schemaVersion: 1, type: "delivery.changed", deliveries: [delivery], eventAt,
      } as unknown as TelegramJobEvent)).toThrowError(expect.objectContaining({ code: "INVALID_EVENT_SHAPE" }));
    }
    const completed = makeJob({
      phase: "terminal", outcome: "completed", terminalAt: eventAt,
      updatedAt: eventAt,
      responsePlan: [{ partId: "p", kind: "final" }],
      deliveries: [{ partId: "p", state: "delivered", attempts: -1, messageId: null, deliveredAt: null }],
    });
    expect(isDoneEligible(completed)).toBe(false);
  });

});
