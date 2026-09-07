import {
  type GuardianAlert,
  SessionGuardianStore,
} from "./session-guardian-store.js";
import {
  fingerprintOf,
  type GuardianFingerprint,
  type GuardianRoute,
  type GuardianThreadSnapshot,
} from "./session-guardian-types.js";

const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_CONFIRMATIONS_REQUIRED = 2;

export interface SessionGuardianDetectorOptions {
  staleAfterMs?: number;
  confirmationsRequired?: number;
  clock?: () => number;
}

export type GuardianDetectionOutcome =
  | {
    readonly kind: "observed";
    readonly threadId: string;
    readonly turnId: string;
  }
  | {
    readonly kind: "suspected";
    readonly threadId: string;
    readonly turnId: string;
    readonly confirmations: number;
  }
  | {
    readonly kind: "alert";
    readonly threadId: string;
    readonly turnId: string;
    readonly alert: GuardianAlert;
  }
  | {
    readonly kind: "cleared";
    readonly threadId: string;
    readonly turnId: string | null;
  };

interface ConfirmationState {
  readonly fingerprint: string;
  readonly count: number;
}

export class SessionGuardianDetector {
  private readonly staleAfterMs: number;
  private readonly confirmationsRequired: number;
  private readonly clock: () => number;
  private readonly confirmations = new Map<string, ConfirmationState>();
  private readonly openAlertPairs: Set<string>;

  constructor(
    private readonly store: SessionGuardianStore,
    private readonly resolveRoute: (threadId: string) => GuardianRoute,
    options: SessionGuardianDetectorOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.confirmationsRequired = options.confirmationsRequired
      ?? DEFAULT_CONFIRMATIONS_REQUIRED;
    this.clock = options.clock ?? Date.now;
    assertNonNegativeFinite(this.staleAfterMs, "staleAfterMs");
    if (!Number.isSafeInteger(this.confirmationsRequired)
      || this.confirmationsRequired < 1) {
      throw new Error("confirmationsRequired must be a positive safe integer");
    }
    this.openAlertPairs = new Set(
      this.store.listOpenAlerts().map((alert) => pairKey(alert.fingerprint)),
    );
  }

  scan(
    snapshots: readonly GuardianThreadSnapshot[],
    observedAt = this.readClock(),
  ): GuardianDetectionOutcome[] {
    assertTimestamp(observedAt, "observedAt");
    const rootsByThreadId = new Map<string, GuardianThreadSnapshot>();
    for (const snapshot of snapshots) {
      if (snapshot.root) rootsByThreadId.set(snapshot.threadId, snapshot);
    }
    return [...rootsByThreadId.values()]
      .sort(compareSnapshots)
      .map((snapshot) => this.observe(snapshot, observedAt));
  }

  observe(
    snapshot: GuardianThreadSnapshot,
    observedAt = this.readClock(),
  ): GuardianDetectionOutcome {
    assertTimestamp(observedAt, "observedAt");
    const fingerprint = candidateFingerprint(snapshot);
    if (!fingerprint) {
      this.confirmations.delete(snapshot.threadId);
      this.store.clearObservation(snapshot.threadId);
      return {
        kind: "cleared",
        threadId: snapshot.threadId,
        turnId: snapshot.turnId,
      };
    }

    const observation = this.store.upsertObservation(snapshot, fingerprint, observedAt);
    const key = fingerprintKey(fingerprint);
    if (observedAt - observation.firstObservedAt < this.staleAfterMs) {
      this.confirmations.delete(snapshot.threadId);
      return observed(fingerprint);
    }

    const pair = pairKey(fingerprint);
    if (this.openAlertPairs.has(pair)) return observed(fingerprint);

    const previous = this.confirmations.get(snapshot.threadId);
    const count = previous?.fingerprint === key ? previous.count + 1 : 1;
    this.confirmations.set(snapshot.threadId, { fingerprint: key, count });
    if (count < this.confirmationsRequired) {
      return {
        kind: "suspected",
        threadId: fingerprint.threadId,
        turnId: fingerprint.turnId,
        confirmations: count,
      };
    }

    const creation = this.store.createAlertIfAbsent(
      fingerprint,
      this.resolveRoute(fingerprint.threadId),
      observedAt,
      snapshot.name,
    );
    this.openAlertPairs.add(pair);
    this.confirmations.delete(snapshot.threadId);
    if (!creation.created) return observed(fingerprint);
    return {
      kind: "alert",
      threadId: fingerprint.threadId,
      turnId: fingerprint.turnId,
      alert: creation.alert,
    };
  }

  private readClock(): number {
    const value = this.clock();
    assertTimestamp(value, "clock result");
    return value;
  }
}

function candidateFingerprint(
  snapshot: GuardianThreadSnapshot,
): GuardianFingerprint | null {
  if (!snapshot.root) return null;
  return fingerprintOf(snapshot);
}

function observed(fingerprint: GuardianFingerprint): GuardianDetectionOutcome {
  return {
    kind: "observed",
    threadId: fingerprint.threadId,
    turnId: fingerprint.turnId,
  };
}

function pairKey(fingerprint: GuardianFingerprint): string {
  return `${fingerprint.threadId}\u0000${fingerprint.turnId}`;
}

function fingerprintKey(fingerprint: GuardianFingerprint): string {
  return JSON.stringify([
    fingerprint.threadId,
    fingerprint.turnId,
    fingerprint.updatedAt,
    fingerprint.itemCount,
    fingerprint.lastItemType,
  ]);
}

function compareSnapshots(
  left: GuardianThreadSnapshot,
  right: GuardianThreadSnapshot,
): number {
  const byId = left.threadId < right.threadId
    ? -1
    : left.threadId > right.threadId
      ? 1
      : 0;
  if (byId !== 0) return byId;
  return Number(right.root) - Number(left.root);
}

function assertTimestamp(value: number, name: string): void {
  assertNonNegativeFinite(value, name);
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}
