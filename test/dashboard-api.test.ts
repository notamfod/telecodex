import { buildDashboardPayload } from "../src/dashboard-api.js";
import type { StatusSnapshot } from "../src/status-board.js";
import type { TelegramJobStatusProjection } from "../src/telegram-status-projection.js";

const CHAT_ID = -1001234567890;
const NOW = Date.UTC(2026, 7, 20, 7, 0, 0);
const ACTIVE_ID = "019fef85-92e7-7841-a26a-dbb311b50e31";
const WAITING_ID = "019fefa1-8411-76e2-89a8-f1262f63338f";
const CHILD_ID = "019fefa1-8411-76e2-89a8-f1262f633390";
const STALLED_ID = "019fefa1-8411-76e2-89a8-f1262f633391";
const RECENT_ID = "019fefa1-8411-76e2-89a8-f1262f633392";

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    limit: 10,
    telegramActive: 0,
    running: [],
    queued: [],
    recent: [],
    recentThreads: [],
    recentThreadCount: 0,
    codexAvailable: true,
    failedJobs24h: 0,
    now: NOW,
    ...overrides,
  };
}

describe("buildDashboardPayload", () => {
  it("returns one root session per row with exact view counters", () => {
    const payload = buildDashboardPayload(snapshot({
      running: [
        {
          threadId: ACTIVE_ID,
          label: "  Active   root  ",
          workspace: "/root/Documents/Codex/telecodex",
          source: "vscode",
          since: NOW - 60_000,
          messageThreadId: 42,
          children: [],
        },
        {
          threadId: WAITING_ID,
          label: "Waiting root",
          workspace: "/root/work/waiting",
          source: "telegram",
          since: NOW - 50_000,
          children: [{
            threadId: CHILD_ID,
            label: "child",
            since: NOW - 40_000,
            waitingOn: "input",
          }],
        },
      ],
      recentThreads: [{
        threadId: RECENT_ID,
        label: "Recent root",
        workspace: "/root/work/recent",
        source: "cli",
        updatedAt: NOW - 120_000,
      }],
      recentThreadCount: 1,
    }), CHAT_ID, statuses([]), { view: "active", offset: 0, limit: 30 });

    expect(payload.counts).toEqual({ active: 1, recent: 1, attention: 1, completed: 0 });
    expect(payload.page).toEqual({ view: "active", offset: 0, limit: 30, total: 1, hasMore: false });
    expect(payload.sessions).toEqual([expect.objectContaining({
      id: ACTIVE_ID,
      label: "Active root",
      workspace: "telecodex",
      state: "active",
      telegramUrl: "https://t.me/c/1234567890/42",
      codexUrl: `codex://threads/${ACTIVE_ID}`,
      canCreateTopic: false,
    })]);
  });

  it("promotes a stalled child to its root and gives stalled precedence over waiting", () => {
    const payload = buildDashboardPayload(snapshot({
      running: [{
        threadId: WAITING_ID,
        label: "Root",
        workspace: "/root/work/root",
        source: "telegram",
        since: NOW - 60_000,
        waitingOn: "approval",
        children: [{ threadId: CHILD_ID, label: "child", since: NOW - 30_000 }],
      }],
    }), CHAT_ID, statuses([
      projection({ threadId: CHILD_ID, health: "stalled", phase: "running", state: "running" }),
    ]), { view: "attention", offset: 0, limit: 30 });

    expect(payload.sessions).toEqual([expect.objectContaining({
      id: WAITING_ID,
      state: "stalled",
      waitingOn: "approval",
    })]);
    expect(payload.counts).toEqual({ active: 0, recent: 0, attention: 1, completed: 0 });
  });

  it("sorts recent sessions newest first and paginates after classification", () => {
    const recentThreads = [0, 1, 2].map((index) => ({
      threadId: `${index + 1}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
      label: `Recent ${index}`,
      workspace: "/root/work/recent",
      source: "cli",
      updatedAt: NOW - index * 1_000,
    }));
    const payload = buildDashboardPayload(snapshot({
      recentThreads,
      recentThreadCount: recentThreads.length,
    }), CHAT_ID, statuses([]), { view: "recent", offset: 1, limit: 1 });

    expect(payload.sessions.map((session) => session.label)).toEqual(["Recent 1"]);
    expect(payload.page).toEqual({ view: "recent", offset: 1, limit: 1, total: 3, hasMore: true });
  });

  it("bounds Unicode labels and never sends raw prompts, paths, or secret-like values", () => {
    const taintedProjection = {
      ...projection({ threadId: STALLED_ID, health: "stalled" }),
      prompt: "operator secret prompt",
    } as TelegramJobStatusProjection;
    const payload = buildDashboardPayload(snapshot({
      running: [{
        threadId: STALLED_ID,
        label: `  ${"😀".repeat(170)}  `,
        workspace: "/root/private/ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        source: "?",
        since: NOW,
        children: [],
      }],
    }), CHAT_ID, statuses([taintedProjection]), { view: "attention", offset: 0, limit: 30 });

    expect(Array.from(payload.sessions[0]!.label)).toHaveLength(160);
    expect(payload.sessions[0]!.workspace).toBe("Codex");
    expect(payload.sessions[0]).not.toHaveProperty("source");
    expect(JSON.stringify(payload)).not.toContain("operator secret prompt");
    expect(JSON.stringify(payload)).not.toContain("/root/private");
  });
});

function statuses(projections: TelegramJobStatusProjection[]) {
  return projections.map((value) => ({
    threadId: value.threadId,
    health: value.health,
    attentionKind: value.attention.kind,
    updatedAt: value.timestamps.updatedAt,
  }));
}

function projection(
  overrides: Partial<TelegramJobStatusProjection> = {},
): TelegramJobStatusProjection {
  return {
    schemaVersion: 1,
    jobId: "11111111-1111-4111-8111-111111111111",
    shortJobId: "11111111",
    expectedVersion: 1,
    threadId: null,
    turnId: null,
    phase: "queued",
    outcome: null,
    state: "queued",
    isDone: false,
    anchorKnownDelivered: false,
    health: "healthy",
    activity: null,
    queue: null,
    dispatch: null,
    guardian: {
      availability: "available",
      health: null,
      reasonCode: null,
      threadStatus: null,
      lastObservedAt: null,
      ageMs: null,
      unchangedSince: null,
      staleForMs: null,
      alertId: null,
      repairState: null,
      repairOutcome: null,
    },
    delivery: {
      total: 0,
      delivered: 0,
      pending: 0,
      sending: 0,
      uncertain: 0,
      failed: 0,
      anchorState: "pending",
      anchorMessageId: null,
      complete: false,
    },
    timestamps: {
      acceptedAt: NOW,
      updatedAt: NOW,
      terminalAt: null,
      lastEventAt: NOW,
      lastCodexEventAt: null,
      guardianLastObservedAt: null,
      dispatchStartedAt: null,
      nextAttemptAt: null,
      abortRequestedAt: null,
      latestDeliveryAt: null,
    },
    attention: { kind: "none" },
    reasonCodes: [],
    actions: [],
    ...overrides,
  };
}
