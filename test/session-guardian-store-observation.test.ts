import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionGuardianStore } from "../src/session-guardian-store.js";
import { fingerprintOf, type GuardianThreadSnapshot } from "../src/session-guardian-types.js";

const THREAD_ID = "01a02451-2fc4-76c0-9f14-c75034c10017";
const TURN_ID = "01a02451-2fc4-76c0-9f14-c75034c10018";
const OLD_TURN_ID = "01a02451-2fc4-76c0-9f14-c75034c10019";

describe("SessionGuardianStore observation reads", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("returns validated observation timing without conversation content", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guardian-observation-read-"));
    directories.push(directory);
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const snapshot: GuardianThreadSnapshot = {
      threadId: THREAD_ID, turnId: TURN_ID, threadStatus: "active", turnStatus: "inProgress",
      updatedAt: 100, itemCount: 2, lastItemType: "agentMessage", source: "cli",
      cwd: "/secret/project", name: "private prompt", canAcceptDirectInput: false, root: true,
    };
    const fingerprint = fingerprintOf(snapshot)!;
    store.upsertObservation(snapshot, fingerprint, 1_000);
    store.upsertObservation(snapshot, fingerprint, 2_000);

    expect(store.getObservation(THREAD_ID)).toEqual({
      fingerprint, firstObservedAt: 1_000, lastObservedAt: 2_000, unchangedCount: 2,
    });
    expect(JSON.stringify(store.getObservation(THREAD_ID))).not.toContain("private prompt");
    expect(store.getObservation("missing")).toBeUndefined();
    store.close();
  });

  it("lists unique tracked observation thread IDs", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guardian-observation-list-"));
    directories.push(directory);
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const anotherThreadId = "01a02451-2fc4-76c0-9f14-c75034c10020";
    const baseSnapshot: GuardianThreadSnapshot = {
      threadId: THREAD_ID, turnId: TURN_ID, threadStatus: "active", turnStatus: "inProgress",
      updatedAt: 100, itemCount: 2, lastItemType: "agentMessage", source: "cli",
      cwd: "/secret/project", name: null, canAcceptDirectInput: false, root: true,
    };
    store.upsertObservation(baseSnapshot, fingerprintOf(baseSnapshot)!, 1_000);
    store.upsertObservation(baseSnapshot, fingerprintOf(baseSnapshot)!, 2_000);
    const anotherSnapshot = { ...baseSnapshot, threadId: anotherThreadId };
    store.upsertObservation(anotherSnapshot, fingerprintOf(anotherSnapshot)!, 3_000);

    expect(store.listObservationThreadIds()).toEqual([THREAD_ID, anotherThreadId]);
    store.close();
  });

  it("selects only the alert and repair outcome matching the current observation", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guardian-observation-inspection-"));
    directories.push(directory);
    const store = new SessionGuardianStore(path.join(directory, "guardian.sqlite"));
    const current = {
      threadId: THREAD_ID, turnId: TURN_ID, updatedAt: 100,
      itemCount: 2, lastItemType: "agentMessage",
    };
    const old = { ...current, turnId: OLD_TURN_ID, updatedAt: 90, itemCount: 1 };
    store.createAlert(old, { chatId: -1_001_234_567_890 }, 500);
    store.upsertObservation({
      threadId: THREAD_ID, turnId: TURN_ID, threadStatus: "active", turnStatus: "inProgress",
      updatedAt: 100, itemCount: 2, lastItemType: "agentMessage", source: "cli",
      cwd: "/secret/project", name: "private prompt", canAcceptDirectInput: false, root: true,
    }, current, 1_000);
    const matching = store.createAlert(current, { chatId: -1_001_234_567_890 }, 2_000);
    expect(store.claimRepair(matching.id, 3_000)).toBe(true);
    store.finishRepair(matching.id, "failed", "Fresh state check failed", 4_000);

    expect(store.inspectThreadObservation(THREAD_ID)).toEqual({
      observation: {
        fingerprint: current,
        firstObservedAt: 1_000,
        lastObservedAt: 1_000,
        unchangedCount: 1,
      },
      alert: expect.objectContaining({ id: matching.id, state: "failed" }),
      repairOutcome: "failed",
    });
    store.close();
  });
});
