import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DeliveryPart, TelegramJob } from "../src/telegram-job-store.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import {
  inspectTeleCodexReleasePreflight,
  type TeleCodexReleasePreflightDependencies,
} from "../src/telecodex-release-preflight.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";

const CHECKED_AT = 1_700_000_000_000;

function job(id: string, phase: TelegramJob["phase"], attention = false): TelegramJob {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    source: { botId: "bot", updateId: id.length },
    attachments: [],
    phase,
    health: "healthy",
    activity: "unknown",
    attention: attention ? { kind: "required", code: "CHECK", actions: [] } : { kind: "none" },
    outcome: null,
    dispatchId: null,
    threadId: null,
    turnId: null,
    responsePlan: undefined,
    deliveries: [],
    acceptedAt: CHECKED_AT - 1_000,
    updatedAt: CHECKED_AT - 500,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
}

function delivery(jobId: string, state: DeliveryPart["state"], nextAttemptAt: number | null = null): DeliveryPart {
  return {
    jobId,
    partKey: `${jobId}-${state}`,
    ordinal: 0,
    kind: "final",
    state,
    payload: { text: "must never enter the report" },
    contentHash: "a".repeat(64),
    telegramMessageId: null,
    attemptCount: 0,
    nextAttemptAt,
    lastErrorCode: null,
    updatedAt: CHECKED_AT - 100,
  };
}

function dependencies(
  jobs: readonly TelegramJob[],
  deliveries: Readonly<Record<string, readonly DeliveryPart[]>> = {},
  dueDeliveries: readonly DeliveryPart[] | ((now: number, limit: number) => readonly DeliveryPart[]) = [],
): TeleCodexReleasePreflightDependencies {
  const store = {
    probeReleaseReadable: () => undefined,
    listUnfinished: () => jobs,
    listStatusCandidates: () => jobs,
    listDueDeliveries: (now: number, limit: number) => typeof dueDeliveries === "function"
      ? dueDeliveries(now, limit) : dueDeliveries,
    listDeliveries: (jobId: string) => deliveries[jobId] ?? [],
  };
  return {
    checkedAt: () => CHECKED_AT,
    releaseId: () => null,
    store,
    guardianStatus: async () => ({ running: true }),
  };
}

function seedBlockedFollowers(store: SqliteTelegramJobStore): string {
  const jobId = "blocked-delivery";
  let current = { ...job(jobId, "accepted"), updatedAt: CHECKED_AT - 1_000 };
  store.acceptUpdate({
    job: current,
    sourcePayload: {
      botId: "bot",
      updateId: current.source.updateId,
      chatId: -1001,
      messageThreadId: 7,
      messageId: 1,
      kind: "text",
      text: "request",
      attachment: null,
      retryOfJobId: null,
    },
    eventId: `${jobId}:accepted`,
  });
  const transition = (event: Parameters<SqliteTelegramJobStore["transition"]>[0]["event"]) => {
    current = store.transition({
      jobId,
      expectedVersion: current.version,
      eventId: `${jobId}:${current.version}`,
      event,
    });
  };
  transition({ schemaVersion: 1, type: "job.queued", eventAt: CHECKED_AT - 90 });
  transition({
    schemaVersion: 1,
    type: "dispatch.started",
    eventAt: CHECKED_AT - 80,
    dispatch: {
      id: `${jobId}:dispatch`,
      threadId: "thread",
      previousTurnId: null,
      attempt: 1,
      startedAt: CHECKED_AT - 80,
      transportWriteState: "written",
      nextAttemptAt: null,
    },
  });
  transition({
    schemaVersion: 1,
    type: "turn.started",
    eventAt: CHECKED_AT - 70,
    identifiers: { turnId: `${jobId}:turn` },
    codexEventAt: CHECKED_AT - 70,
  });
  transition({
    schemaVersion: 1,
    type: "turn.completed",
    eventAt: CHECKED_AT - 60,
    codexEventAt: CHECKED_AT - 60,
    turnResult: { schemaVersion: 1, content: [] },
  });
  const anchorPayload = { operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: "status" };
  const finalPayload = { operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: "result" };
  const noticePayload = { operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: "notice" };
  current = store.installDeliveryPlan({
    jobId,
    expectedVersion: current.version,
    eventId: `${jobId}:plan`,
    eventAt: CHECKED_AT - 50,
    responsePlan: [{ partId: "final:0000", kind: "final" }, { partId: "notice:0001", kind: "notice" }],
    parts: [
      { jobId, partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "pending",
        payload: anchorPayload, contentHash: hashTelegramDeliveryPayload(anchorPayload), updatedAt: CHECKED_AT - 50 },
      { jobId, partKey: "final:0000", ordinal: 0, kind: "final", state: "pending",
        payload: finalPayload, contentHash: hashTelegramDeliveryPayload(finalPayload), updatedAt: CHECKED_AT - 50 },
      { jobId, partKey: "notice:0001", ordinal: 1, kind: "notice", state: "pending",
        payload: noticePayload, contentHash: hashTelegramDeliveryPayload(noticePayload), updatedAt: CHECKED_AT - 50 },
    ],
  });
  current = store.transitionDeliveryAndProject({
    jobId,
    partKey: "status-anchor",
    expectedJobVersion: current.version,
    expectedState: "pending",
    expectedAttemptCount: 0,
    state: "sending",
    attemptCount: 0,
    eventId: `${jobId}:anchor-sending`,
    updatedAt: CHECKED_AT - 40,
  }).job;
  store.transitionDeliveryAndProject({
    jobId,
    partKey: "status-anchor",
    expectedJobVersion: current.version,
    expectedState: "sending",
    expectedAttemptCount: 0,
    state: "failed",
    attemptCount: 1,
    lastErrorCode: "telegram_permanent",
    attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
    eventId: `${jobId}:anchor-failed`,
    updatedAt: CHECKED_AT - 30,
  });
  return jobId;
}

describe("inspectTeleCodexReleasePreflight", () => {
  it("keeps followers behind a failed status anchor safe when the scheduler has no due work", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-release-preflight-"));
    const store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    try {
      const jobId = seedBlockedFollowers(store);
      const current = store.get(jobId)!;
      const rawDeliveries = store.listDeliveries(jobId);
      expect(current).toMatchObject({
        phase: "delivering",
        outcome: null,
        attention: { kind: "required", code: "telegram_delivery_failed" },
      });
      expect(rawDeliveries.map((part) => ({
        partKey: part.partKey,
        state: part.state,
        attemptCount: part.attemptCount,
        nextAttemptAt: part.nextAttemptAt,
        lastErrorCode: part.lastErrorCode,
      }))).toEqual([
        { partKey: "final:0000", state: "pending", attemptCount: 0,
          nextAttemptAt: null, lastErrorCode: null },
        { partKey: "status-anchor", state: "failed", attemptCount: 1,
          nextAttemptAt: null, lastErrorCode: "telegram_permanent" },
        { partKey: "notice:0001", state: "pending", attemptCount: 0,
          nextAttemptAt: null, lastErrorCode: null },
      ]);
      expect(store.listDueDeliveries(CHECKED_AT, 10_001)).toEqual([]);

      const report = await inspectTeleCodexReleasePreflight({
        checkedAt: () => CHECKED_AT,
        releaseId: () => null,
        store,
        guardianStatus: async () => ({ running: true }),
      });

      expect(report.safeToRestart).toBe(true);
      expect(report.reasons).toEqual([]);
      expect(report.jobs).toEqual({ queued: 0, running: 0, delivering: 1, attention: 1 });
      expect(report.deliveries).toEqual({ pending: 2, sending: 0, uncertain: 0, failed: 1 });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports queued and future delivery work as safe without serializing payloads", async () => {
    const queued = job("queued", "queued");
    const report = await inspectTeleCodexReleasePreflight(dependencies(
      [queued],
      { queued: [delivery("queued", "pending", CHECKED_AT + 60_000)] },
    ));

    expect(report).toEqual({
      schemaVersion: 1,
      checkedAt: CHECKED_AT,
      safeToRestart: true,
      reasons: [],
      jobs: { queued: 1, running: 0, delivering: 0, attention: 0 },
      deliveries: { pending: 1, sending: 0, uncertain: 0, failed: 0 },
      guardian: "ready",
      releaseId: null,
    });
    expect(JSON.stringify(report)).not.toContain("must never enter the report");
  });

  it("blocks genuinely schedulable due delivery work", async () => {
    const delivering = job("due", "delivering");
    const pending = delivery("due", "pending", CHECKED_AT);
    let dueRequest: readonly number[] | null = null;
    const report = await inspectTeleCodexReleasePreflight(dependencies(
      [delivering],
      { due: [pending] },
      (now, limit) => {
        dueRequest = [now, limit];
        return [pending];
      },
    ));

    expect(dueRequest).toEqual([CHECKED_AT, 10_001]);
    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["DELIVERY_PENDING"]);
    expect(report.jobs).toEqual({ queued: 0, running: 0, delivering: 1, attention: 0 });
    expect(report.deliveries).toEqual({ pending: 1, sending: 0, uncertain: 0, failed: 0 });
  });

  it("blocks active turns, sending deliveries, and due pending delivery work", async () => {
    const active = job("active", "running");
    const delivering = job("delivering", "delivering", true);
    const pending = delivery("delivering", "pending", CHECKED_AT);
    const report = await inspectTeleCodexReleasePreflight(dependencies(
      [active, delivering],
      { delivering: [delivery("delivering", "sending"), pending] },
      [pending],
    ));

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["ACTIVE_TURN", "DELIVERY_SENDING", "DELIVERY_PENDING"]);
    expect(report.jobs).toEqual({ queued: 0, running: 1, delivering: 1, attention: 1 });
    expect(report.deliveries).toEqual({ pending: 1, sending: 1, uncertain: 0, failed: 0 });
  });

  it("blocks due pending and sending deliveries whose parent is already terminal", async () => {
    const terminal = { ...job("terminal", "terminal"), outcome: "failed" as const, terminalAt: CHECKED_AT - 1 };
    const pending = delivery("terminal", "pending", CHECKED_AT);
    const deps = dependencies([], {
      terminal: [pending, delivery("terminal", "sending")],
    }, [pending]);
    deps.store.listStatusCandidates = () => [terminal];

    const report = await inspectTeleCodexReleasePreflight(deps);

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["DELIVERY_SENDING", "DELIVERY_PENDING"]);
    expect(report.jobs).toEqual({ queued: 0, running: 0, delivering: 0, attention: 0 });
    expect(report.deliveries).toEqual({ pending: 1, sending: 1, uncertain: 0, failed: 0 });
  });

  it("turns a Guardian timeout into one bounded unavailable reason", async () => {
    const deps = dependencies([]);
    deps.guardianStatus = async () => { throw new Error("timeout at /secret/socket token=abc"); };

    const report = await inspectTeleCodexReleasePreflight(deps);

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["GUARDIAN_UNAVAILABLE"]);
    expect(report.guardian).toBe("unavailable");
    expect(JSON.stringify(report)).not.toMatch(/secret|token|timeout/i);
  });

  it("fails closed when a malformed ledger row aborts inspection", async () => {
    const deps = dependencies([]);
    deps.store.listUnfinished = () => { throw new Error("malformed prompt=/private/value"); };

    const report = await inspectTeleCodexReleasePreflight(deps);

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["STORE_UNAVAILABLE"]);
    expect(report.jobs).toEqual({ queued: 0, running: 0, delivering: 0, attention: 0 });
    expect(JSON.stringify(report)).not.toMatch(/private|prompt|malformed/i);
  });

  it("fails closed when the scheduler due scan is unavailable", async () => {
    const deps = dependencies([], {}, () => { throw new Error("due payload=/private/value"); });

    const report = await inspectTeleCodexReleasePreflight(deps);

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["STORE_UNAVAILABLE"]);
    expect(report.jobs).toEqual({ queued: 0, running: 0, delivering: 0, attention: 0 });
    expect(report.deliveries).toEqual({ pending: 0, sending: 0, uncertain: 0, failed: 0 });
    expect(JSON.stringify(report)).not.toMatch(/private|payload|due/i);
  });

  it("fails closed when the scheduler due scan exceeds its bounded limit", async () => {
    const pending = delivery("overflow", "pending", CHECKED_AT);
    const deps = dependencies([], {}, Array(10_001).fill(pending));

    const report = await inspectTeleCodexReleasePreflight(deps);

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["STORE_UNAVAILABLE"]);
    expect(report.jobs).toEqual({ queued: 0, running: 0, delivering: 0, attention: 0 });
    expect(report.deliveries).toEqual({ pending: 0, sending: 0, uncertain: 0, failed: 0 });
  });

  it("fails closed when the ledger release probe detects quarantine", async () => {
    const deps = dependencies([]);
    deps.store.probeReleaseReadable = () => { throw new Error("quarantined payload=/private/value"); };

    const report = await inspectTeleCodexReleasePreflight(deps);

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["STORE_UNAVAILABLE"]);
    expect(JSON.stringify(report)).not.toMatch(/private|payload|quarantined/i);
  });

  it("fails closed when Guardian reports that its daemon is unavailable", async () => {
    const deps = dependencies([]);
    deps.guardianStatus = async () => ({ running: false });

    const report = await inspectTeleCodexReleasePreflight(deps);

    expect(report).toMatchObject({
      safeToRestart: false,
      reasons: ["GUARDIAN_UNAVAILABLE"],
      guardian: "unavailable",
    });
  });
});
