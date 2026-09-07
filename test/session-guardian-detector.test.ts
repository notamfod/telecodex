import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionGuardianDetector } from "../src/session-guardian-detector.js";
import { SessionGuardianStore } from "../src/session-guardian-store.js";
import type {
  GuardianRoute,
  GuardianThreadSnapshot,
} from "../src/session-guardian-types.js";

const THREAD_ID = "019ff4ea-8c36-7c5f-8f08-010101010101";
const OTHER_THREAD_ID = "019ff4ea-8c36-7c5f-8f08-020202020202";
const TURN_ID = "019ff4ea-8c36-7c5f-8f08-030303030303";
const ROUTE: GuardianRoute = { chatId: -1_001_234_567_890, messageThreadId: 42 };
const STALE_AFTER_MS = 10 * 60_000;

function snapshot(
  overrides: Partial<GuardianThreadSnapshot> = {},
): GuardianThreadSnapshot {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    threadStatus: "active",
    turnStatus: "inProgress",
    updatedAt: 1_723_000_000,
    itemCount: 2,
    lastItemType: "agentMessage",
    source: "cli",
    cwd: "/srv/projects/telecodex",
    name: "Guardian detector",
    canAcceptDirectInput: false,
    root: true,
    ...overrides,
  };
}

describe("SessionGuardianDetector", () => {
  let directory: string;
  let databasePath: string;
  let stores: SessionGuardianStore[];
  let now: number;
  let resolveRoute: ReturnType<typeof vi.fn<(threadId: string) => GuardianRoute>>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-guardian-detector-"));
    databasePath = path.join(directory, "guardian.sqlite");
    stores = [];
    now = 0;
    resolveRoute = vi.fn(() => ROUTE);
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function openStore(): SessionGuardianStore {
    const store = new SessionGuardianStore(databasePath);
    stores.push(store);
    return store;
  }

  function detector(store = openStore(), confirmationsRequired = 2): SessionGuardianDetector {
    return new SessionGuardianDetector(store, resolveRoute, {
      staleAfterMs: STALE_AFTER_MS,
      confirmationsRequired,
      clock: () => now,
    });
  }

  it("requires two stale observations after the fingerprint reaches the idle threshold", () => {
    const subject = detector();

    expect(subject.observe(snapshot())).toMatchObject({ kind: "observed", threadId: THREAD_ID });
    for (now = 60_000; now < STALE_AFTER_MS; now += 60_000) {
      expect(subject.observe(snapshot()).kind).toBe("observed");
    }
    now = STALE_AFTER_MS;
    expect(subject.observe(snapshot())).toEqual({
      kind: "suspected",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmations: 1,
    });
    now += 60_000;
    const result = subject.observe(snapshot());

    expect(result).toMatchObject({ kind: "alert", threadId: THREAD_ID, turnId: TURN_ID });
    expect(result.kind === "alert" ? result.alert.route : undefined).toEqual(ROUTE);
    expect(resolveRoute).toHaveBeenCalledOnce();
  });

  it("clears idle, completed, and subagent snapshots", () => {
    const subject = detector();
    const cases: GuardianThreadSnapshot[] = [
      snapshot({ threadStatus: "idle", turnStatus: "completed", canAcceptDirectInput: true }),
      snapshot({ turnStatus: "completed" }),
      snapshot({ root: false, source: { subAgent: { thread_spawn: {} } } }),
    ];

    for (const value of cases) {
      expect(subject.observe(value)).toEqual({
        kind: "cleared",
        threadId: THREAD_ID,
        turnId: value.turnId,
      });
    }
    expect(resolveRoute).not.toHaveBeenCalled();
  });

  it("observes contradictory active input-ready state through stale confirmation", () => {
    const subject = detector();
    const contradictory = snapshot({ canAcceptDirectInput: true });

    expect(subject.observe(contradictory).kind).toBe("observed");
    now = STALE_AFTER_MS;
    expect(subject.observe(contradictory)).toMatchObject({
      kind: "suspected",
      confirmations: 1,
    });
    now += 60_000;
    expect(subject.observe(contradictory).kind).toBe("alert");
  });

  it("resets both the durable age and confirmation sequence when the fingerprint changes", () => {
    const subject = detector();
    expect(subject.observe(snapshot()).kind).toBe("observed");
    now = STALE_AFTER_MS;
    expect(subject.observe(snapshot()).kind).toBe("suspected");

    now += 60_000;
    const changed = snapshot({ updatedAt: 1_723_000_001, itemCount: 3, lastItemType: "toolCall" });
    expect(subject.observe(changed).kind).toBe("observed");
    now += STALE_AFTER_MS;
    expect(subject.observe(changed)).toMatchObject({ kind: "suspected", confirmations: 1 });
    now += 60_000;
    expect(subject.observe(changed).kind).toBe("alert");
  });

  it("deduplicates an open alert after the daemon and store restart", () => {
    const firstStore = openStore();
    const first = detector(firstStore);
    first.observe(snapshot());
    now = STALE_AFTER_MS;
    first.observe(snapshot());
    now += 60_000;
    expect(first.observe(snapshot()).kind).toBe("alert");
    firstStore.close();

    const secondStore = openStore();
    const restarted = detector(secondStore);
    now += 60_000;
    expect(restarted.observe(snapshot())).toMatchObject({ kind: "observed", threadId: THREAD_ID });
    expect(secondStore.listOpenAlerts()).toHaveLength(1);
    expect(resolveRoute).toHaveBeenCalledOnce();
  });

  it("emits one alert when two detector caches miss the same persisted winner", () => {
    const firstStore = openStore();
    const secondStore = openStore();
    const first = detector(firstStore);
    const second = detector(secondStore);
    const firstList = vi.spyOn(firstStore, "listOpenAlerts").mockReturnValue([]);
    const secondList = vi.spyOn(secondStore, "listOpenAlerts").mockReturnValue([]);
    first.observe(snapshot());
    second.observe(snapshot());
    now = STALE_AFTER_MS;
    first.observe(snapshot());
    second.observe(snapshot());
    now += 60_000;

    expect([first.observe(snapshot()).kind, second.observe(snapshot()).kind].sort()).toEqual([
      "alert",
      "observed",
    ]);
    firstList.mockRestore();
    secondList.mockRestore();
    expect(firstStore.listOpenAlerts()).toHaveLength(1);
    expect(resolveRoute).toHaveBeenCalledTimes(2);
  });

  it("scans user-visible roots in deterministic identifier order and excludes subagents", () => {
    const subject = detector();
    const outcomes = subject.scan([
      snapshot({ threadId: OTHER_THREAD_ID }),
      snapshot({ root: false }),
      snapshot(),
    ]);

    expect(outcomes.map((outcome) => outcome.threadId)).toEqual([
      THREAD_ID,
      OTHER_THREAD_ID,
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["observed", "observed"]);
  });

  it("counts a duplicated root only once per scan", () => {
    const subject = detector();
    expect(subject.scan([snapshot(), snapshot()])).toHaveLength(1);
    now = STALE_AFTER_MS;

    expect(subject.scan([snapshot(), snapshot()])).toEqual([
      expect.objectContaining({ kind: "suspected", confirmations: 1 }),
    ]);
  });

  it("supports one configured stale confirmation", () => {
    const subject = detector(openStore(), 1);
    subject.observe(snapshot());
    now = STALE_AFTER_MS;

    expect(subject.observe(snapshot()).kind).toBe("alert");
  });

  it("rejects invalid configuration and clock values", () => {
    const store = openStore();
    expect(() => new SessionGuardianDetector(store, resolveRoute, {
      staleAfterMs: -1,
    })).toThrow("staleAfterMs");
    expect(() => new SessionGuardianDetector(store, resolveRoute, {
      staleAfterMs: 1,
      confirmationsRequired: 0,
    })).toThrow("confirmationsRequired");
    const subject = new SessionGuardianDetector(store, resolveRoute, {
      staleAfterMs: 1,
      clock: () => Number.NaN,
    });
    expect(() => subject.observe(snapshot())).toThrow("clock");
  });
});
