import type { DeliveryPart, TelegramJob } from "../src/telegram-job-store.js";
import {
  inspectTeleCodexReleasePreflight,
  type TeleCodexReleasePreflightDependencies,
} from "../src/telecodex-release-preflight.js";

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
): TeleCodexReleasePreflightDependencies {
  return {
    checkedAt: () => CHECKED_AT,
    releaseId: () => null,
    store: {
      probeReleaseReadable: () => undefined,
      listUnfinished: () => jobs,
      listStatusCandidates: () => jobs,
      listDeliveries: (jobId) => deliveries[jobId] ?? [],
    },
    guardianStatus: async () => ({ running: true }),
  };
}

describe("inspectTeleCodexReleasePreflight", () => {
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

  it("blocks active turns, sending deliveries, and due pending delivery work", async () => {
    const active = job("active", "running");
    const delivering = job("delivering", "delivering", true);
    const report = await inspectTeleCodexReleasePreflight(dependencies(
      [active, delivering],
      { delivering: [delivery("delivering", "sending"), delivery("delivering", "pending", CHECKED_AT)] },
    ));

    expect(report.safeToRestart).toBe(false);
    expect(report.reasons).toEqual(["ACTIVE_TURN", "DELIVERY_SENDING", "DELIVERY_PENDING"]);
    expect(report.jobs).toEqual({ queued: 0, running: 1, delivering: 1, attention: 1 });
    expect(report.deliveries).toEqual({ pending: 1, sending: 1, uncertain: 0, failed: 0 });
  });

  it("blocks due pending and sending deliveries whose parent is already terminal", async () => {
    const terminal = { ...job("terminal", "terminal"), outcome: "failed" as const, terminalAt: CHECKED_AT - 1 };
    const deps = dependencies([], {
      terminal: [delivery("terminal", "pending", CHECKED_AT), delivery("terminal", "sending")],
    });
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
