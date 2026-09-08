import { buildStatusSnapshot, renderStatusBoard, type StatusSnapshot }
  from "../src/status-board.js";

const CHAT_ID = -1001234567890;
const NOW = 1_700_000_100_000;

function projection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, jobId: "job-123456789", shortJobId: "job-1234", expectedVersion: 7,
    phase: "queued", outcome: null, state: "queued", isDone: false,
    anchorKnownDelivered: false, health: "healthy", activity: null,
    queue: { position: 2, ageMs: 45_000 }, dispatch: null,
    guardian: { availability: "available", health: "healthy", reasonCode: null,
      threadStatus: null, lastObservedAt: null, ageMs: null, unchangedSince: null,
      staleForMs: null, alertId: null, repairState: null, repairOutcome: null },
    delivery: { total: 1, delivered: 0, pending: 1, sending: 0, uncertain: 0, failed: 0,
      anchorState: "pending", anchorMessageId: null, complete: false },
    timestamps: { acceptedAt: NOW - 45_000, updatedAt: NOW - 5_000, terminalAt: null,
      lastEventAt: NOW - 5_000, lastCodexEventAt: null, guardianLastObservedAt: null },
    attention: { kind: "none" }, reasonCodes: [],
    actions: [
      { kind: "abort", jobId: "job-123456789", expectedVersion: 7 },
      { kind: "refresh", jobId: "job-123456789", expectedVersion: 7 },
      { kind: "details", jobId: "job-123456789", expectedVersion: 7 },
    ],
    ...overrides,
  };
}

function snapshot(jobs: unknown[]): StatusSnapshot {
  return {
    limit: 8, telegramActive: 0, running: [], queued: [], recent: [], recentThreads: [],
    recentThreadCount: 0, codexAvailable: true, failedJobs24h: 0, now: NOW, jobs,
  } as never;
}

function buildProjected(values: unknown[], state = "active") {
  return buildStatusSnapshot(values.map((value, index) => ({
    state, label: `job-${index}`, workspace: "/srv/telecodex",
    createdAt: NOW - 10_000 + index, updatedAt: NOW - 1_000, projection: value,
  })) as never, [], { limit: 8, now: NOW });
}

describe("unified status board rendering", () => {
  it("renders one projection with age, health, delivery and versioned actions", () => {
    const value = projection();
    const { body, buttons } = renderStatusBoard(snapshot([{
      projection: value, label: "Не потерять ответ", workspace: "/srv/telecodex",
      messageThreadId: 42,
    }]), CHAT_ID);

    expect(body).toContain("Не потерять ответ");
    expect(body).toMatch(/очеред.*2/i);
    expect(body).toContain("45с");
    expect(body).toContain("healthy");
    expect(body).toContain("0/1");
    expect(buttons).toEqual([
      { text: "Abort", callbackData: "tcj:a:job-123456789:7" },
      { text: "Refresh", callbackData: "tcj:f:job-123456789:7" },
      { text: "Details", callbackData: "tcj:d:job-123456789:7" },
    ]);
    expect(buttons.every((button) => !button.callbackData
      || Buffer.byteLength(button.callbackData) <= 64)).toBe(true);
  });

  it("keeps terminal work visible until its anchor is delivered and preserves the DTO", () => {
    const value = projection({ phase: "terminal", outcome: "completed",
      state: "terminal_incomplete", queue: null });
    const result = buildStatusSnapshot([{
      state: "completed", label: "Ответ готов", workspace: "/srv/telecodex",
      createdAt: NOW - 60_000, updatedAt: NOW - 1_000, projection: value,
    } as never], [], { limit: 8, now: NOW });

    expect((result as never as { jobs: Array<{ projection: unknown }> }).jobs[0]!.projection)
      .toBe(value);
    expect(result.recent).toEqual([]);
    expect(renderStatusBoard(result, CHAT_ID).body).toContain("terminal_incomplete");
  });

  it("shows Guardian and delivery problems with their bounded reason codes", () => {
    const value = projection({
      phase: "delivering", state: "delivery_uncertain", health: "unavailable",
      guardian: { availability: "unavailable", health: "unavailable",
        reasonCode: "GUARDIAN_UNAVAILABLE", threadStatus: null, lastObservedAt: null,
        ageMs: null, unchangedSince: null, staleForMs: null, alertId: null,
        repairState: null, repairOutcome: null },
      delivery: { total: 2, delivered: 1, pending: 0, sending: 0, uncertain: 1, failed: 0,
        anchorState: "delivered", anchorMessageId: 51, complete: false },
      reasonCodes: ["GUARDIAN_UNAVAILABLE", "telegram_send_uncertain"],
      actions: [{ kind: "send_again_warning", jobId: "job-123456789", expectedVersion: 9 }],
      expectedVersion: 9,
    });
    const rendered = renderStatusBoard(snapshot([{
      projection: value, label: "Ответ", workspace: "/srv/telecodex",
    }]), CHAT_ID);

    expect(rendered.body).toContain("GUARDIAN_UNAVAILABLE");
    expect(rendered.body).toContain("telegram_send_uncertain");
    expect(rendered.body).toContain("1/2");
    expect(rendered.buttons).toEqual([
      { text: "Send again with warning", callbackData: "tcj:s:job-123456789:9" },
      { text: "Details", callbackData: "tcj:d:job-123456789:9" },
    ]);
  });

  it("omits an action that cannot fit Telegram callback data without hiding the job", () => {
    const longId = `sameprefix-${"x".repeat(80)}`;
    const value = projection({ jobId: longId, shortJobId: "samepref",
      actions: [{ kind: "details", jobId: longId, expectedVersion: 7 }] });

    const rendered = renderStatusBoard(snapshot([{
      projection: value, label: "Long", workspace: "/srv/telecodex",
      actionResolverTokens: { details: "tok_A1" },
    }]), CHAT_ID);

    expect(rendered.body).toContain("Long");
    expect(rendered.buttons).toEqual([]);
  });

  it("binds Guardian restore buttons to the exact canonical job envelope", () => {
    const first = projection({ state: "stalled", actions: [{
      kind: "guardian_restore", jobId: "job-123456789", expectedVersion: 7,
      alertId: "alert-old",
    }] });
    const second = projection({ state: "stalled", actions: [{
      kind: "guardian_restore", jobId: "job-123456789", expectedVersion: 7,
      alertId: "alert-new",
    }] });

    expect(renderStatusBoard(snapshot([{
      projection: first, label: "First", workspace: "/srv/telecodex",
    }]), CHAT_ID).buttons[0]).toEqual({
      text: "Guardian Restore", callbackData: "tcj:g:job-123456789:7",
    });
    expect(renderStatusBoard(snapshot([{
      projection: second, label: "Second", workspace: "/srv/telecodex",
    }]), CHAT_ID).buttons[0]).toEqual({
      text: "Guardian Restore", callbackData: "tcj:g:job-123456789:7",
    });
  });

  it("renders the bounded missing-topic recovery action", () => {
    const value = projection({ actions: [{
      kind: "recover_missing_topic",
      jobId: "job-123456789",
      expectedVersion: 541,
    }], expectedVersion: 541 });

    expect(renderStatusBoard(snapshot([{
      projection: value, label: "Missing topic", workspace: "/srv/telecodex",
    }]), CHAT_ID).buttons[0]).toEqual({
      text: "Recover topic",
      callbackData: "tcj:o:job-123456789:541",
    });
  });

  it.each([
    ["resume_existing_topic", "u", "Resume topic"],
    ["resume_existing_topic_warning", "w", "Resume topic (may resend status)"],
  ] as const)("renders the bounded %s action", (kind, code, label) => {
    const value = projection({ actions: [{
      kind,
      jobId: "job-123456789",
      expectedVersion: 541,
    }], expectedVersion: 541 });

    expect(renderStatusBoard(snapshot([{
      projection: value, label: "Existing topic", workspace: "/srv/telecodex",
    }]), CHAT_ID).buttons[0]).toEqual({
      text: label,
      callbackData: `tcj:${code}:job-123456789:541`,
    });
  });

  it("counts only projected running or delivering work against Telegram slots", () => {
    expect(buildProjected([
      projection({ phase: "accepted", state: "accepted" }),
      projection({ phase: "queued", state: "queued" }),
      projection({ phase: "dispatching", state: "dispatching_unknown" }),
    ]).telegramActive).toBe(0);
    expect(buildProjected([
      projection({ phase: "running", state: "running" }),
      projection({ phase: "running", state: "stalled" }),
      projection({ phase: "delivering", state: "delivery_uncertain" }),
    ]).telegramActive).toBe(3);
  });

  it("preserves canonical candidate priority instead of re-sorting jobs by age", () => {
    const attention = projection({
      jobId: "attention-new", shortJobId: "attention", state: "stalled",
      health: "stalled", attention: {
        kind: "required", code: "OPERATOR_REQUIRED", actions: ["inspect"],
      },
    });
    const ordinary = projection({
      jobId: "ordinary-old", shortJobId: "ordinary", state: "running",
      phase: "running", queue: null,
    });
    const result = buildStatusSnapshot([
      {
        state: "active", label: "Attention", workspace: "/srv/telecodex",
        createdAt: NOW - 1_000, updatedAt: NOW - 500, projection: attention,
      },
      {
        state: "active", label: "Ordinary", workspace: "/srv/telecodex",
        createdAt: NOW - 60_000, updatedAt: NOW - 500, projection: ordinary,
      },
    ] as never, [], { limit: 8, now: NOW });

    expect(result.jobs?.map(({ projection: value }) => value.jobId)).toEqual([
      "attention-new",
      "ordinary-old",
    ]);
  });

  it("includes canonical queued jobs in the shared queue exactly once", () => {
    const canonical = projection({ jobId: "canonical-queued", shortJobId: "canonical" });
    const result = buildStatusSnapshot([
      {
        state: "waiting", label: "Canonical", workspace: "/srv/telecodex",
        createdAt: NOW - 45_000, updatedAt: NOW - 5_000, projection: canonical,
      },
      {
        state: "waiting", label: "Legacy", workspace: "/srv/telecodex",
        createdAt: NOW - 30_000, updatedAt: NOW - 5_000,
      },
    ] as never, [], { limit: 8, now: NOW });

    expect(result.queued.map(({ label }) => label)).toEqual(["Canonical", "Legacy"]);
    expect(result.queued.filter(({ label }) => label === "Canonical")).toHaveLength(1);
  });

  it.each(["terminal_failed", "terminal_aborted", "terminal_recovery_interrupted"])(
    "moves physically settled %s projection to recent even if the legacy state is stale",
    (state) => {
      const result = buildProjected([projection({
        phase: "terminal", state, anchorKnownDelivered: true, isDone: false,
        delivery: { ...projection().delivery, complete: true },
      })]);

      expect(result.jobs).toEqual([]);
      expect(result.recent).toEqual([expect.objectContaining({ ok: false })]);
    },
  );

  it.each(["delivery_failed", "delivery_uncertain"])(
    "keeps terminal completed work with %s ordinary delivery active",
    (state) => {
      const result = buildProjected([projection({
        phase: "terminal", outcome: "completed", state,
        anchorKnownDelivered: true, isDone: false,
        delivery: { ...projection().delivery, complete: false },
      })], "completed");

      expect(result.jobs).toHaveLength(1);
      expect(result.recent).toEqual([]);
    },
  );

  it("keeps terminal failed work active while an ordinary delivery is pending", () => {
    const result = buildProjected([projection({
      phase: "terminal", outcome: "failed", state: "delivery_failed",
      anchorKnownDelivered: true, isDone: false,
      delivery: { ...projection().delivery, complete: false },
    })], "failed");

    expect(result.jobs).toHaveLength(1);
    expect(result.recent).toEqual([]);
  });

  it("bounds the complete board by Telegram UTF-16 units with an exact omitted-job summary", () => {
    const jobs = Array.from({ length: 8 }, (_, index) => {
      const jobId = `job-${index}`;
      return {
        projection: projection({
          jobId,
          shortJobId: jobId,
          reasonCodes: Array.from(
            { length: 6 },
            (_, reason) => `reason_${index}_${reason}_${"😀".repeat(50)}`,
          ),
          actions: [{ kind: "details", jobId, expectedVersion: 7 }],
        }),
        label: `Job ${index}`,
        workspace: "/srv/telecodex",
      };
    });

    const rendered = renderStatusBoard(snapshot(jobs), CHAT_ID);
    const omitted = jobs.length - rendered.buttons.length;

    expect(rendered.body.length).toBeLessThanOrEqual(4096);
    expect(omitted).toBeGreaterThan(0);
    expect(rendered.body).toContain(`… ещё задач: ${omitted}`);
    expect(renderStatusBoard(snapshot(jobs), CHAT_ID)).toEqual(rendered);
    for (const button of rendered.buttons) {
      expect(button.text).toBe("Details");
      const index = button.callbackData?.match(/^tcj:d:job-(\d+):7$/)?.[1];
      expect(index).toBeDefined();
      expect(rendered.body).toContain(`Job ${index}`);
    }
  });

  it("reserves Details for every displayed job before optional action buttons", () => {
    const jobs = Array.from({ length: 4 }, (_, index) => {
      const jobId = `job-${index}`;
      return {
        projection: projection({
          jobId,
          shortJobId: jobId,
          actions: [
            { kind: "abort", jobId, expectedVersion: 7 },
            { kind: "refresh", jobId, expectedVersion: 7 },
            { kind: "details", jobId, expectedVersion: 7 },
          ],
        }),
        label: `Job ${index}`,
        workspace: "/srv/telecodex",
      };
    });

    const rendered = renderStatusBoard(snapshot(jobs), CHAT_ID);

    expect(rendered.buttons).toHaveLength(8);
    for (let index = 0; index < jobs.length; index += 1) {
      expect(rendered.body).toContain(`Job ${index}`);
      expect(rendered.buttons).toContainEqual({
        text: "Details",
        callbackData: `tcj:d:job-${index}:7`,
      });
    }
  });
});
