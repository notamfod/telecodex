import { vi } from "vitest";

import {
  createTelegramGuardianRuntimeFacade,
  inspectTelegramGuardian,
} from "../src/telegram-guardian-reconciliation.js";
import { GuardianIpcTimeoutError } from "../src/session-guardian-ipc-client.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const TURN = "turn-exact";

describe("inspectTelegramGuardian", () => {
  it("routes exact inspection and repair through the operational client, not the probe client", async () => {
    const operational = {
      inspectThread: vi.fn(async () => response()),
      repairAlert: vi.fn(async () => ({
        outcome: "restored" as const,
        message: "Session restored",
        threadId: THREAD,
      })),
    };
    const probe = {
      status: vi.fn(async () => ({ outcome: "ok" as const, message: "Guardian is ready" })),
      inspectThread: vi.fn(),
    };
    const guardian = createTelegramGuardianRuntimeFacade({ operational, probe });

    await guardian.inspectThread(THREAD);
    await guardian.status();
    await guardian.repairAlert("abcdefghijklmnopqrstuv");

    expect(operational.inspectThread).toHaveBeenCalledWith(THREAD);
    expect(operational.repairAlert).toHaveBeenCalledWith("abcdefghijklmnopqrstuv");
    expect(probe.status).toHaveBeenCalledOnce();
    expect(probe.inspectThread).not.toHaveBeenCalled();
  });

  it.each([
    [{ repairState: "in_progress", repairOutcome: null }, { availability: "available", state: "in_progress" }],
    [{ repairState: "terminal", repairOutcome: "restored" }, { availability: "available", state: "restored" }],
    [{ repairState: "terminal", repairOutcome: "failed" }, { availability: "available", state: "failed", reasonCode: "guardian_repair_failed" }],
    [{ repairState: "none", repairOutcome: null }, { availability: "available", state: "none" }],
  ] as const)("maps Guardian observation %o without mutation", async (observation, expected) => {
    const inspectThread = vi.fn(async () => response({ observation: fullObservation(observation) }));
    const repairThread = vi.fn();

    await expect(inspectTelegramGuardian({ inspectThread, repairThread }, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual(expected);
    expect(inspectThread).toHaveBeenCalledWith(THREAD);
    expect(repairThread).not.toHaveBeenCalled();
  });

  it.each([
    ["inProgress", "active"],
    ["completed", "completed"],
  ] as const)("keeps exact identity for a self-recovered %s turn", async (turnStatus, _exactTurnState) => {
    const inspectThread = vi.fn(async () => response({ turnStatus, observation: fullObservation({
      repairState: "terminal", repairOutcome: "self-recovered",
    }) }));

    await expect(inspectTelegramGuardian({ inspectThread }, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual({
        availability: "available", state: "self_recovered",
        threadId: THREAD, turnId: TURN,
      });
  });

  it("returns bounded unavailable evidence for IPC failures", async () => {
    const timedOut = { inspectThread: vi.fn(async () => { throw new GuardianIpcTimeoutError(); }) };
    const down = { inspectThread: vi.fn(async () => { throw new Error("socket secret /root/.env"); }) };

    await expect(inspectTelegramGuardian(timedOut, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual({ availability: "unavailable", reasonCode: "guardian_timeout" });
    await expect(inspectTelegramGuardian(down, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual({ availability: "unavailable", reasonCode: "guardian_unavailable" });
  });
});

function response(overrides: Record<string, unknown> = {}) {
  return { outcome: "ok", message: "ok", threadId: THREAD, thread: {
    threadId: THREAD, turnId: TURN, threadStatus: "active", turnStatus: "inProgress",
    updatedAt: 1, itemCount: 1, lastItemType: "agentMessage", source: "telecodex",
    canAcceptDirectInput: true, root: true, ...overrides,
  } };
}

function fullObservation(overrides: Record<string, unknown>) {
  return {
    guardianHealth: "stalled", lastObservedAt: 1, unchangedSince: 1, staleForMs: 1,
    alertId: "AAAAAAAAAAAAAAAAAAAAAA", repairState: "none", repairOutcome: null, ...overrides,
  };
}
