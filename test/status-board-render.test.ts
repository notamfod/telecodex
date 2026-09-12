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

function projectedJob(
  jobId: string,
  overrides: Record<string, unknown> = {},
  viewOverrides: Record<string, unknown> = {},
) {
  return {
    projection: projection({
      jobId,
      shortJobId: jobId.slice(0, 8),
      attention: { kind: "required", code: "OPERATOR_REQUIRED", actions: ["retry"] },
      actions: [
        { kind: "details", jobId, expectedVersion: 7 },
        { kind: "inspect", jobId, expectedVersion: 7 },
        { kind: "retry_new_turn", jobId, expectedVersion: 7 },
      ],
      ...overrides,
    }),
    label: `Attention ${jobId}`,
    workspace: "/srv/telecodex",
    ...viewOverrides,
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
  it("keeps canonical projection detail in the Mini App and out of the topic", () => {
    const value = projection();
    const { body, buttons } = renderStatusBoard(snapshot([{
      projection: value, label: "Не потерять ответ", workspace: "/srv/telecodex",
      messageThreadId: 42,
    }]), CHAT_ID, "https://example.test/dashboard");

    expect(body).not.toContain("Не потерять ответ");
    expect(body).not.toContain("healthy");
    expect(body).not.toContain("0/1");
    expect(buttons).toEqual([{
      text: "Открыть Dashboard",
      url: "https://example.test/dashboard",
    }]);
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
    expect(renderStatusBoard(result, CHAT_ID).body).not.toContain("terminal_incomplete");
  });

  it("renders a required callback without a Mini App URL", () => {
    const value = projection({ attention: {
      kind: "required", code: "OPERATOR_REQUIRED", actions: ["abort"],
    } });

    expect(renderStatusBoard(snapshot([{
      projection: value, label: "Attention", workspace: "/srv/telecodex",
    }]), CHAT_ID).buttons).toEqual([{
      text: "1. Abort",
      callbackData: "tcj:a:job-123456789:7",
    }]);
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

  it("renders projected jobs deterministically without topic diagnostics or callbacks", () => {
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

    expect(rendered.body.length).toBeLessThanOrEqual(4096);
    expect(rendered.body).not.toContain("Job 0");
    expect(rendered.body).not.toContain("reason_0_0");
    expect(rendered.buttons).toEqual([]);
    expect(renderStatusBoard(snapshot(jobs), CHAT_ID)).toEqual(rendered);
  });

  it("keeps the launcher as the only button for healthy queued and running jobs", () => {
    const jobs = [
      projectedJob("queued-healthy", {
        attention: { kind: "none" },
        actions: [
          { kind: "abort", jobId: "queued-healthy", expectedVersion: 7 },
          { kind: "refresh", jobId: "queued-healthy", expectedVersion: 7 },
        ],
      }),
      projectedJob("running-healthy", {
        phase: "running",
        state: "running",
        queue: null,
        attention: { kind: "none" },
        actions: [
          { kind: "abort", jobId: "running-healthy", expectedVersion: 7 },
          { kind: "refresh", jobId: "running-healthy", expectedVersion: 7 },
        ],
      }),
    ];

    expect(renderStatusBoard(snapshot(jobs), CHAT_ID, "https://example.test/dashboard").buttons)
      .toEqual([{ text: "Открыть Dashboard", url: "https://example.test/dashboard" }]);
  });

  it("numbers one first non-informational action from the same visible attention row", () => {
    const action = {
      kind: "retry_delivery", jobId: "delivery-failed", expectedVersion: 7,
      partKey: "final:0000",
    };
    const value = projectedJob("delivery-failed", {
      actions: [
        { kind: "details", jobId: "delivery-failed", expectedVersion: 7 },
        { kind: "inspect", jobId: "delivery-failed", expectedVersion: 7 },
        action,
        { kind: "refresh", jobId: "delivery-failed", expectedVersion: 7 },
      ],
    });

    const rendered = renderStatusBoard(snapshot([value]), CHAT_ID, "https://example.test/dashboard");

    expect(rendered.body).toContain("<b>Требуют внимания</b>\n1. telecodex · Attention delivery-failed");
    expect(rendered.buttons).toEqual([
      { text: "Открыть Dashboard", url: "https://example.test/dashboard" },
      { text: "1. Retry delivery", callbackData: "tcj:y:delivery-failed:7:final:0000" },
    ]);
    expect(value.projection.actions[2]).toBe(action);
  });

  it("numbers projected and waiting attention once and suppresses duplicate thread rows", () => {
    const required = projectedJob("needs-action", {}, {
      messageThreadId: 42,
    });
    const waiting = {
      threadId: "host-thread", label: "Waiting reply", workspace: "/srv/telecodex",
      source: "telegram", since: NOW - 60_000, waitingOn: "input" as const,
      messageThreadId: 42, children: [],
    };
    const distinctWaiting = { ...waiting, threadId: "other-thread", messageThreadId: 43 };

    const rendered = renderStatusBoard({
      ...snapshot([required]),
      running: [waiting, distinctWaiting],
    }, CHAT_ID, "https://example.test/dashboard");

    expect(rendered.body).toContain("1. telecodex · Attention needs-action");
    expect(rendered.body).toContain("2. telecodex · Waiting reply · ждёт ответа");
    expect(rendered.body.match(/Waiting reply · ждёт ответа/g)).toHaveLength(1);
    expect(rendered.buttons[1]).toEqual({
      text: "1. Retry as new turn",
      callbackData: "tcj:r:needs-action:7",
    });
  });

  it("keeps distinct required jobs that share one thread and topic", () => {
    const first = projectedJob("shared-first", { threadId: "shared-thread" }, {
      messageThreadId: 42,
    });
    const second = projectedJob("shared-second", { threadId: "shared-thread" }, {
      messageThreadId: 42,
    });

    const rendered = renderStatusBoard(
      snapshot([first, second]), CHAT_ID, "https://example.test/dashboard",
    );

    expect(rendered.body).toContain("1. telecodex · Attention shared-first");
    expect(rendered.body).toContain("2. telecodex · Attention shared-second");
    expect(rendered.buttons.slice(1)).toEqual([
      { text: "1. Retry as new turn", callbackData: "tcj:r:shared-first:7" },
      { text: "2. Retry as new turn", callbackData: "tcj:r:shared-second:7" },
    ]);
  });

  it.each([
    ["job id", { kind: "abort", jobId: "wrong-job", expectedVersion: 7 }],
    ["version", { kind: "abort", jobId: "exact-job", expectedVersion: 8 }],
  ])("rejects a selected action with a mismatched %s", (_field, action) => {
    const job = projectedJob("exact-job", { actions: [action] });

    expect(() => renderStatusBoard(
      snapshot([job]), CHAT_ID, "https://example.test/dashboard",
    ))
      .toThrow("Status action does not match its projection");
  });

  it("omits an oversized callback while keeping its attention row visible", () => {
    const jobId = "x".repeat(40);
    const job = projectedJob(jobId, {
      expectedVersion: 9_999_999_999_999_999,
      actions: [{
        kind: "retry_delivery", jobId, expectedVersion: 9_999_999_999_999_999,
        partKey: "y".repeat(24),
      }],
    });

    const rendered = renderStatusBoard(snapshot([job]), CHAT_ID, "https://example.test/dashboard");

    expect(rendered.body).toContain(`Attention ${jobId.slice(0, 20)}`);
    expect(rendered.buttons).toEqual([
      { text: "Открыть Dashboard", url: "https://example.test/dashboard" },
    ]);
  });

  it("keeps a parser-incompatible job visible without emitting a dead callback", () => {
    const job = projectedJob("legacy.job", {
      actions: [{ kind: "abort", jobId: "legacy.job", expectedVersion: 7 }],
    });

    const rendered = renderStatusBoard(snapshot([job]), CHAT_ID, "https://example.test/dashboard");

    expect(rendered.body).toContain("Attention legacy.job");
    expect(rendered.buttons).toEqual([
      { text: "Открыть Dashboard", url: "https://example.test/dashboard" },
    ]);
  });

  it("keeps a parser-incompatible part key visible without emitting a dead callback", () => {
    const job = projectedJob("valid-job", {
      actions: [{
        kind: "retry_delivery", jobId: "valid-job", expectedVersion: 7,
        partKey: "invalid part",
      }],
    });

    const rendered = renderStatusBoard(snapshot([job]), CHAT_ID, "https://example.test/dashboard");

    expect(rendered.body).toContain("Attention valid-job");
    expect(rendered.buttons).toEqual([
      { text: "Открыть Dashboard", url: "https://example.test/dashboard" },
    ]);
  });

  it("uses all eight attention rows and buttons when no launcher is configured", () => {
    const jobs = Array.from({ length: 10 }, (_, index) => projectedJob(`no-launcher-${index}`));

    const rendered = renderStatusBoard(snapshot(jobs), CHAT_ID);

    expect(rendered.body).toContain("8. telecodex · Attention no-launcher-7");
    expect(rendered.body).not.toContain("Attention no-launcher-8");
    expect(rendered.body).toContain("… ещё 2");
    expect(rendered.buttons).toHaveLength(8);
    expect(rendered.buttons.map((button) => button.text)).toEqual([
      "1. Retry as new turn", "2. Retry as new turn", "3. Retry as new turn",
      "4. Retry as new turn", "5. Retry as new turn", "6. Retry as new turn",
      "7. Retry as new turn", "8. Retry as new turn",
    ]);
  });

  it("keeps eight hostile HTML attention rows within the Telegram body limit", () => {
    const hostile = "&".repeat(40);
    const jobs = Array.from({ length: 8 }, (_, index) => projectedJob(`hostile-${index}`, {}, {
      label: hostile,
      workspace: `/srv/${hostile}`,
    }));

    const rendered = renderStatusBoard(snapshot(jobs), CHAT_ID);

    expect(rendered.body).toContain("8. ");
    expect(rendered.body.length).toBeLessThanOrEqual(4096);
    expect(rendered.body).toContain("&amp;");
    expect(rendered.body.replaceAll("&amp;", "")).not.toContain("&");
    expect(rendered.buttons).toHaveLength(8);
  });

  it("bounds many required rows and their matching buttons deterministically", () => {
    const jobs = Array.from({ length: 12 }, (_, index) => projectedJob(`required-${index}`));

    const rendered = renderStatusBoard(snapshot(jobs), CHAT_ID, "https://example.test/dashboard");

    expect(rendered.body).toContain("7. telecodex · Attention required-6");
    expect(rendered.body).not.toContain("Attention required-7");
    expect(rendered.body).toContain("… ещё 5");
    expect(rendered.body.length).toBeLessThanOrEqual(4096);
    expect(rendered.buttons).toHaveLength(8);
    expect(rendered.buttons.slice(1).map((button) => button.text)).toEqual([
      "1. Retry as new turn", "2. Retry as new turn", "3. Retry as new turn",
      "4. Retry as new turn", "5. Retry as new turn", "6. Retry as new turn",
      "7. Retry as new turn",
    ]);
    expect(renderStatusBoard(snapshot(jobs), CHAT_ID, "https://example.test/dashboard"))
      .toEqual(rendered);
  });
});
