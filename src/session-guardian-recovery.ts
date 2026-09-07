import type { SessionGuardianAppServer } from "./session-guardian-app-server.js";
import type {
  GuardianAlert,
  GuardianSelfRecoveryClosure,
  SessionGuardianStore,
} from "./session-guardian-store.js";
import {
  fingerprintOf,
  type GuardianFingerprint,
  type GuardianRepairOutcome,
  type GuardianRepairResult,
  type GuardianThreadSnapshot,
} from "./session-guardian-types.js";

const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const FINALIZATION_ATTEMPTS = 2;
const STATE_UNAVAILABLE = "Guardian recovery state unavailable";
const FINALIZATION_FAILED = "Guardian repair finalization failed";
const ALERT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RecoveryAppServer = Pick<SessionGuardianAppServer,
  "readThread" | "interrupt" | "waitForIdle" | "coldReload">;

export interface SessionGuardianRecoveryOptions {
  idleTimeoutMs?: number;
  clock?: () => number;
  observationOnly?: boolean;
  onChecking?: (alertId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

interface PendingFinalization {
  readonly alertId: string;
  readonly startedAt: number;
  readonly outcome: GuardianRepairOutcome;
  readonly threadId: string;
  readonly detail: string;
}
type Eligibility = GuardianFingerprint | "read-failed" | "not-root" | "not-active";

export class SessionGuardianRecovery {
  private readonly idleTimeoutMs: number;
  private readonly clock: () => number;
  private readonly observationOnly: boolean;
  private readonly onChecking?: (alertId: string) => void | Promise<void>;
  private readonly signal?: AbortSignal;
  private readonly alertRequests = new Map<string, Promise<GuardianRepairResult>>();
  private readonly manualReadRequests = new Map<string, Promise<GuardianRepairResult>>();
  private readonly threadQueues = new Map<string, Promise<void>>();
  private readonly pendingFinalizations = new Map<string, PendingFinalization>();

  constructor(
    private readonly appServer: RecoveryAppServer,
    private readonly store: SessionGuardianStore,
    options: SessionGuardianRecoveryOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clock = options.clock ?? Date.now;
    this.observationOnly = options.observationOnly ?? false;
    this.onChecking = options.onChecking;
    this.signal = options.signal;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) {
      throw new Error("idleTimeoutMs must be a positive finite number");
    }
    if (typeof this.observationOnly !== "boolean") {
      throw new Error("observationOnly must be a boolean");
    }
    if (this.onChecking !== undefined && typeof this.onChecking !== "function") {
      throw new Error("onChecking must be a function");
    }
    if (this.signal !== undefined && !(this.signal instanceof AbortSignal)) {
      throw new Error("signal must be an AbortSignal");
    }
  }

  async recoverAlert(
    alertId: string,
    options: { repairEnabled: boolean },
  ): Promise<GuardianRepairResult> {
    assertAlertId(alertId);
    assertRepairOptions(options);
    this.throwIfCanceled();
    const pending = this.pendingFinalizations.get(alertId);
    if (pending) return this.finalizePending(pending);
    if (this.observationOnly || !options.repairEnabled) {
      return this.recoverAlertReadOnlyQueued(alertId);
    }
    return this.share(this.alertRequests, alertId, () => this.recoverAlertMutating(alertId));
  }

  async repairThread(
    threadId: string,
    options: { repairEnabled: boolean },
  ): Promise<GuardianRepairResult> {
    assertThreadId(threadId);
    assertRepairOptions(options);
    this.throwIfCanceled();
    if (this.observationOnly || !options.repairEnabled) {
      return this.share(
        this.manualReadRequests,
        threadId,
        () => this.repairThreadReadOnly(threadId),
      );
    }
    return this.withThreadLock(threadId, () => this.repairThreadLocked(threadId));
  }

  private async recoverAlertReadOnlyQueued(alertId: string): Promise<GuardianRepairResult> {
    const alert = this.readAlert(alertId);
    if (!alert) return result("expired", undefined, "Alert not found");
    if (alert.state !== "open" && alert.state !== "checking") {
      return result(alert.state, alert.fingerprint.threadId, "Alert already closed");
    }
    return this.withThreadLock(
      alert.fingerprint.threadId,
      () => this.recoverAlertReadOnly(alertId),
    );
  }

  private async recoverAlertReadOnly(alertId: string): Promise<GuardianRepairResult> {
    const alert = this.readAlert(alertId);
    if (!alert) return result("expired", undefined, "Alert not found");
    if (alert.state !== "open" && alert.state !== "checking") {
      return result(alert.state, alert.fingerprint.threadId, "Alert already closed");
    }
    const live = await this.safeRead(alert.fingerprint.threadId);
    if (!live) {
      return result("failed", alert.fingerprint.threadId, "Fresh state check failed");
    }
    if (!live.root || !fingerprintsEqual(fingerprintOf(live), alert.fingerprint)) {
      if (alert.state === "open") return this.closeSelfRecovered(alert);
      return result("self-recovered", alert.fingerprint.threadId, "Thread progressed or became idle");
    }
    const outcome = this.observationOnly ? "observation-only" : "repair-disabled";
    const detail = this.observationOnly ? "Observation-only mode" : "Repair is disabled";
    return result(outcome, alert.fingerprint.threadId, detail);
  }

  private async recoverAlertMutating(alertId: string): Promise<GuardianRepairResult> {
    const pending = this.pendingFinalizations.get(alertId);
    if (pending) return this.finalizePending(pending);
    const alert = this.readAlert(alertId);
    if (!alert) return result("expired", undefined, "Alert not found");
    if (alert.state !== "open" && alert.state !== "checking") {
      return result(alert.state, alert.fingerprint.threadId, "Alert already closed");
    }
    return this.withThreadLock(
      alert.fingerprint.threadId,
      () => this.recoverAlertLocked(alertId),
    );
  }

  private async recoverAlertLocked(alertId: string): Promise<GuardianRepairResult> {
    const pending = this.pendingFinalizations.get(alertId);
    if (pending) return this.finalizePending(pending);
    const alert = this.readAlert(alertId);
    if (!alert) return result("expired", undefined, "Alert not found");
    if (alert.state !== "open" && alert.state !== "checking") {
      return result(alert.state, alert.fingerprint.threadId, "Alert already closed");
    }
    if (alert.state === "open") {
      const live = await this.safeRead(alert.fingerprint.threadId);
      if (!live) return result("failed", alert.fingerprint.threadId, "Fresh state check failed");
      if (!live.root || !fingerprintsEqual(fingerprintOf(live), alert.fingerprint)) {
        return this.closeSelfRecovered(alert);
      }
    }
    const startedAt = this.readClock();
    if (!this.claimAlert(alert.id, startedAt)) {
      const current = this.readAlert(alert.id);
      if (current && current.state !== "open" && current.state !== "checking") {
        return result(current.state, current.fingerprint.threadId, "Alert already closed");
      }
      return result("failed", alert.fingerprint.threadId, "Repair already in progress");
    }
    this.throwIfCanceled();
    await this.onChecking?.(alert.id);
    this.throwIfCanceled();
    const live = await this.safeRead(alert.fingerprint.threadId);
    if (!live) {
      return this.finish(
        alert.id,
        startedAt,
        "failed",
        alert.fingerprint.threadId,
        "Fresh state check failed",
      );
    }
    if (!live.root || !fingerprintsEqual(fingerprintOf(live), alert.fingerprint)) {
      return this.finish(
        alert.id,
        startedAt,
        "self-recovered",
        alert.fingerprint.threadId,
        "Thread progressed or became idle",
      );
    }
    return this.mutateExact(alert.fingerprint, alert.id, startedAt);
  }

  private async repairThreadReadOnly(threadId: string): Promise<GuardianRepairResult> {
    const live = await this.safeRead(threadId);
    const fingerprint = eligibleFingerprint(live, threadId);
    if (typeof fingerprint === "string") return ineligibleResult(fingerprint, threadId);
    const outcome = this.observationOnly ? "observation-only" : "repair-disabled";
    const detail = this.observationOnly ? "Observation-only mode" : "Repair is disabled";
    return result(outcome, threadId, detail);
  }

  private async repairThreadLocked(threadId: string): Promise<GuardianRepairResult> {
    const live = await this.safeRead(threadId);
    const fingerprint = eligibleFingerprint(live, threadId);
    if (typeof fingerprint === "string") return ineligibleResult(fingerprint, threadId);
    const alert = matchingAlert(this.openAlerts(), fingerprint);
    if (alert) return this.recoverAlertLocked(alert.id);
    const rechecked = await this.safeRead(threadId);
    const secondFingerprint = eligibleFingerprint(rechecked, threadId);
    if (typeof secondFingerprint === "string") return ineligibleResult(secondFingerprint, threadId);
    if (!fingerprintsEqual(secondFingerprint, fingerprint)) {
      return result("self-recovered", threadId, "Thread progressed or became idle");
    }
    const racedAlert = matchingAlert(this.openAlerts(), fingerprint);
    if (racedAlert) return this.recoverAlertLocked(racedAlert.id);
    return this.mutateExact(fingerprint);
  }

  private async mutateExact(
    fingerprint: GuardianFingerprint,
    alertId?: string,
    startedAt?: number,
  ): Promise<GuardianRepairResult> {
    try {
      this.throwIfCanceled();
      await this.appServer.interrupt(fingerprint.threadId, fingerprint.turnId);
      this.throwIfCanceled();
    } catch {
      this.throwIfCanceled();
      return this.finish(alertId, startedAt, "failed", fingerprint.threadId, "Interrupt failed");
    }

    let idle: GuardianThreadSnapshot;
    try {
      this.throwIfCanceled();
      idle = await this.appServer.waitForIdle(fingerprint.threadId, this.idleTimeoutMs);
      this.throwIfCanceled();
    } catch {
      this.throwIfCanceled();
      return this.finish(alertId, startedAt, "failed", fingerprint.threadId, "Wait for idle failed");
    }
    if (!isExpectedIdle(idle, fingerprint)) {
      return this.finish(alertId, startedAt, "failed", fingerprint.threadId, "Wait for idle failed");
    }

    let reloaded: GuardianThreadSnapshot;
    try {
      this.throwIfCanceled();
      reloaded = await this.appServer.coldReload(fingerprint.threadId);
      this.throwIfCanceled();
    } catch {
      this.throwIfCanceled();
      return this.finish(alertId, startedAt, "failed", fingerprint.threadId, "Cold reload failed");
    }
    if (!isVerifiedRestoration(reloaded, fingerprint)) {
      return this.finish(alertId, startedAt, "failed", fingerprint.threadId, "Final verification failed");
    }
    return this.finish(alertId, startedAt, "restored", fingerprint.threadId, "Thread restored");
  }

  private finish(
    alertId: string | undefined,
    startedAt: number | undefined,
    outcome: GuardianRepairOutcome,
    threadId: string,
    detail: string,
  ): GuardianRepairResult {
    this.throwIfCanceled();
    if (alertId !== undefined) {
      if (startedAt === undefined) throw new Error("Guardian repair claim timestamp is missing");
      const pending = { alertId, startedAt, outcome, threadId, detail };
      this.pendingFinalizations.set(alertId, pending);
      return this.finalizePending(pending);
    }
    return result(outcome, threadId, detail);
  }

  private finalizePending(pending: PendingFinalization): GuardianRepairResult {
    this.throwIfCanceled();
    for (let attempt = 0; attempt < FINALIZATION_ATTEMPTS; attempt += 1) {
      try {
        const finishedAt = Math.max(pending.startedAt, this.readClock());
        this.store.finishRepair(
          pending.alertId,
          pending.outcome,
          pending.detail,
          finishedAt,
        );
        this.pendingFinalizations.delete(pending.alertId);
        return result(pending.outcome, pending.threadId, pending.detail);
      } catch {
        // Reconcile below after the bounded immediate retry budget is exhausted.
      }
    }
    const alert = this.readAlert(pending.alertId, FINALIZATION_FAILED);
    if (alert && alert.state !== "open" && alert.state !== "checking") {
      this.pendingFinalizations.delete(pending.alertId);
      return result(alert.state, alert.fingerprint.threadId, "Alert already closed");
    }
    throw new Error(FINALIZATION_FAILED);
  }

  private closeSelfRecovered(alert: GuardianAlert): GuardianRepairResult {
    let closure: GuardianSelfRecoveryClosure;
    try {
      closure = this.store.markOpenAlertSelfRecovered(
        alert.id,
        "Thread progressed or became idle",
      );
    } catch {
      throw new Error(STATE_UNAVAILABLE);
    }
    if (!closure.closed) {
      const current = closure.alert;
      if (current.state === "checking") {
        return result("failed", current.fingerprint.threadId, "Repair already in progress");
      }
      if (current.state !== "open") {
        return result(current.state, current.fingerprint.threadId, "Alert already closed");
      }
      throw new Error(STATE_UNAVAILABLE);
    }
    return result(
      "self-recovered",
      alert.fingerprint.threadId,
      "Thread progressed or became idle",
    );
  }

  private async safeRead(threadId: string): Promise<GuardianThreadSnapshot | undefined> {
    try {
      this.throwIfCanceled();
      const snapshot = await this.appServer.readThread(threadId);
      this.throwIfCanceled();
      return snapshot;
    } catch {
      this.throwIfCanceled();
      return undefined;
    }
  }

  private throwIfCanceled(): void {
    if (this.signal?.aborted) throw new Error("Guardian recovery canceled by shutdown");
  }

  private readAlert(alertId: string, failure = STATE_UNAVAILABLE): GuardianAlert | undefined {
    try { return this.store.getAlert(alertId); } catch { throw new Error(failure); }
  }

  private claimAlert(alertId: string, startedAt: number): boolean {
    try { return this.store.claimRepair(alertId, startedAt); } catch {
      throw new Error(STATE_UNAVAILABLE);
    }
  }

  private openAlerts(): GuardianAlert[] {
    try { return this.store.listOpenAlerts(); } catch { throw new Error(STATE_UNAVAILABLE); }
  }

  private readClock(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("clock result must be a non-negative finite number");
    }
    return value;
  }

  private async withThreadLock(
    threadId: string,
    run: () => Promise<GuardianRepairResult>,
  ): Promise<GuardianRepairResult> {
    const previous = this.threadQueues.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.threadQueues.set(threadId, tail);
    await previous.catch(() => undefined);
    this.throwIfCanceled();
    try {
      return await run();
    } finally {
      release();
      if (this.threadQueues.get(threadId) === tail) this.threadQueues.delete(threadId);
    }
  }

  private share(
    requests: Map<string, Promise<GuardianRepairResult>>,
    key: string,
    run: () => Promise<GuardianRepairResult>,
  ): Promise<GuardianRepairResult> {
    const current = requests.get(key);
    if (current) return current;
    const pending = run();
    requests.set(key, pending);
    void pending.finally(() => {
      if (requests.get(key) === pending) requests.delete(key);
    }).catch(() => undefined);
    return pending;
  }
}

function eligibleFingerprint(
  snapshot: GuardianThreadSnapshot | undefined,
  threadId: string,
): Eligibility {
  if (!snapshot || snapshot.threadId !== threadId) return "read-failed";
  if (!snapshot.root) return "not-root";
  return fingerprintOf(snapshot) ?? "not-active";
}

function ineligibleResult(failure: Exclude<Eligibility, GuardianFingerprint>, threadId: string) {
  if (failure === "read-failed") return result("failed", threadId, "Fresh state check failed");
  if (failure === "not-root") return result("self-recovered", threadId, "Thread is not eligible");
  return result("self-recovered", threadId, "Thread is not actively stuck");
}

function matchingAlert(
  alerts: readonly GuardianAlert[],
  fingerprint: GuardianFingerprint,
): GuardianAlert | undefined {
  return alerts.find((alert) => fingerprintsEqual(alert.fingerprint, fingerprint));
}

function isExpectedIdle(
  snapshot: GuardianThreadSnapshot,
  fingerprint: GuardianFingerprint,
): boolean {
  return snapshot.threadId === fingerprint.threadId
    && snapshot.turnId === fingerprint.turnId
    && snapshot.threadStatus === "idle"
    && snapshot.turnStatus !== "inProgress"
    && snapshot.root
    && snapshot.itemCount >= fingerprint.itemCount;
}

function isVerifiedRestoration(
  snapshot: GuardianThreadSnapshot,
  fingerprint: GuardianFingerprint,
): boolean {
  return snapshot.threadId === fingerprint.threadId
    && snapshot.turnId === fingerprint.turnId
    && snapshot.threadStatus === "idle"
    && snapshot.turnStatus !== "inProgress"
    && snapshot.canAcceptDirectInput
    && snapshot.root
    && snapshot.itemCount >= fingerprint.itemCount;
}

function fingerprintsEqual(
  left: GuardianFingerprint | null,
  right: GuardianFingerprint,
): boolean {
  return left !== null
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.updatedAt === right.updatedAt
    && left.itemCount === right.itemCount
    && left.lastItemType === right.lastItemType;
}

function result(
  outcome: GuardianRepairOutcome,
  threadId: string | undefined,
  detail: string,
): GuardianRepairResult {
  return Object.freeze({ outcome, ...(threadId === undefined ? {} : { threadId }), detail });
}

function assertAlertId(value: string): void {
  if (!ALERT_ID_PATTERN.test(value)) throw new Error("alertId must be a guardian alert ID");
}

function assertThreadId(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error("threadId must be a UUID");
}

function assertRepairOptions(value: { repairEnabled: boolean }): void {
  if (typeof value !== "object" || value === null || typeof value.repairEnabled !== "boolean") {
    throw new Error("options.repairEnabled must be a boolean");
  }
}
