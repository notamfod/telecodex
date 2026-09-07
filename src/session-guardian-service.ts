import type { GuardianDetectionOutcome } from "./session-guardian-detector.js";
import type { GuardianRootThreadScope } from "./session-guardian-app-server.js";
import { assertGuardianThreadId, type GuardianDaemonStatus, type GuardianScanSummary,
  type GuardianObservationInspection, type GuardianSourceCategory,
  type GuardianThreadInspection } from "./session-guardian-ipc-client.js";
import type { GuardianAlert, GuardianObservation, GuardianThreadObservation }
  from "./session-guardian-store.js";
import type { GuardianTelegramDelivery, SessionGuardianTelegramNotifier }
  from "./session-guardian-telegram.js";
import { fingerprintOf, type GuardianRepairResult, type GuardianThreadSnapshot }
  from "./session-guardian-types.js";

const APP_SERVER_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000] as const;

interface ActiveScanRead {
  readonly appServer: GuardianServiceAppServer;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export interface GuardianServiceAppServer {
  listRootThreads(scope: GuardianRootThreadScope): Promise<GuardianThreadSnapshot[]>;
  readThread(threadId: string): Promise<GuardianThreadSnapshot>;
  close(): void;
}

export interface GuardianServiceRecovery {
  recoverAlert(alertId: string, options: { repairEnabled: boolean }): Promise<GuardianRepairResult>;
  repairThread(threadId: string, options: { repairEnabled: boolean }): Promise<GuardianRepairResult>;
}

interface GuardianServiceStore {
  listObservationThreadIds(): string[];
  listOpenAlerts(): GuardianAlert[];
  listAlertsNeedingStatusDelivery(): GuardianAlert[];
  getAlert(alertId: string): GuardianAlert | undefined;
  getObservation(threadId: string): GuardianObservation | undefined;
  inspectThreadObservation(threadId: string): GuardianThreadObservation | undefined;
  recordDelivery(alertId: string, messageId: number): GuardianAlert;
  markDeliveryFailed(alertId: string): GuardianAlert;
  recordStatusDelivery(alertId: string): GuardianAlert;
  markStatusDeliveryFailed(alertId: string): GuardianAlert;
  markOpenAlertSelfRecovered(alertId: string, detail: string): { alert: GuardianAlert; closed: boolean };
}

interface GuardianServiceDetector {
  scan(snapshots: readonly GuardianThreadSnapshot[], observedAt?: number): GuardianDetectionOutcome[];
}

type GuardianServiceNotifier = Pick<SessionGuardianTelegramNotifier, "sendAlert" | "editStatus">;
export type GuardianSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface SessionGuardianServiceOptions {
  readonly createAppServer: () => GuardianServiceAppServer | Promise<GuardianServiceAppServer>;
  readonly createInspectionAppServer: () =>
    GuardianServiceAppServer | Promise<GuardianServiceAppServer>;
  readonly createRecovery: (
    appServer: GuardianServiceAppServer,
    hooks: {
      readonly onChecking: (alertId: string) => Promise<void>;
      readonly signal: AbortSignal;
    },
  ) => GuardianServiceRecovery;
  readonly detector: GuardianServiceDetector;
  readonly store: GuardianServiceStore;
  readonly notifier: GuardianServiceNotifier;
  readonly scanIntervalMs: number;
  readonly recentWindowMs: number;
  readonly observationOnly: boolean;
  readonly repairEnabled: boolean;
  readonly clock?: () => number;
  readonly sleep?: GuardianSleep;
}

export class SessionGuardianService {
  private readonly clock: () => number;
  private readonly sleep: GuardianSleep;
  private operationTail: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private activeOperation: GuardianDaemonStatus["activeOperation"] = "idle";
  private scanPhase: GuardianDaemonStatus["scanPhase"] = "idle";
  private activeSince: number | undefined;
  private readonly alertRepairs = new Map<string, Promise<GuardianRepairResult>>();
  private readonly inspectionGateways = new Set<GuardianServiceAppServer>();
  private readonly inspectionTasks = new Set<Promise<GuardianThreadInspection>>();
  private readonly activeInspectionTasks = new Set<Promise<GuardianThreadInspection>>();
  private readonly shutdownAbort = new AbortController();
  private scanReadBarrier: Promise<void> | undefined;
  private activeScanRead: ActiveScanRead | undefined;
  private appServer: GuardianServiceAppServer | undefined;
  private recovery: GuardianServiceRecovery | undefined;
  private loopAbort: AbortController | undefined;
  private loopPromise: Promise<void> | undefined;
  private quiescePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private running = false;
  private scanningQuiesced = false;
  private closed = false;
  private backoffIndex = 0;
  private scanCount = 0;
  private lastScanAt: number | undefined;

  constructor(private readonly options: SessionGuardianServiceOptions) {
    if (!Number.isSafeInteger(options.scanIntervalMs) || options.scanIntervalMs <= 0) {
      throw new Error("scanIntervalMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.recentWindowMs) || options.recentWindowMs <= 0) {
      throw new Error("recentWindowMs must be a positive safe integer");
    }
    if (typeof options.observationOnly !== "boolean" || typeof options.repairEnabled !== "boolean") {
      throw new Error("guardian modes must be booleans");
    }
    if (options.observationOnly && options.repairEnabled) {
      throw new Error("repair cannot be enabled in observation-only mode");
    }
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
  }

  start(): void {
    if (this.running) return;
    if (this.scanningQuiesced || this.closed) {
      throw new Error("Session guardian service is stopped");
    }
    this.running = true;
    this.loopAbort = new AbortController();
    this.loopPromise = this.runLoop(this.loopAbort.signal);
  }

  stop(): Promise<void> {
    return this.close();
  }

  quiesceScanning(): Promise<void> {
    if (this.quiescePromise) return this.quiescePromise;
    this.scanningQuiesced = true;
    this.running = false;
    this.loopAbort?.abort();
    this.cancelActiveScanRead();
    this.quiescePromise = this.loopPromise?.catch(() => undefined) ?? Promise.resolve();
    return this.quiescePromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.shutdownAbort.abort();
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  scan(): Promise<GuardianScanSummary> {
    if (this.scanningQuiesced) {
      return Promise.reject(new Error("Session guardian scanning is quiesced"));
    }
    return this.enqueue("scan", () => this.scanInternal());
  }

  async inspectThread(threadId: string): Promise<GuardianThreadInspection> {
    assertGuardianThreadId(threadId);
    if (this.closed) return Promise.reject(new Error("Session guardian service is closed"));
    const pending = Promise.resolve().then(() => this.inspectThreadWhenAllowed(threadId));
    this.inspectionTasks.add(pending);
    void pending.then(
      () => this.inspectionTasks.delete(pending),
      () => this.inspectionTasks.delete(pending),
    );
    return pending;
  }

  checkAlert(alertId: string): Promise<GuardianRepairResult> {
    return this.enqueue("check", async () => {
      const recovery = await this.ensureRecovery();
      const result = await recovery.recoverAlert(alertId, { repairEnabled: false });
      this.assertServiceOpenAfterRecovery();
      if (isAppServerFailure(result)) this.resetRuntime();
      await this.editTerminalStatus(alertId, result);
      return result;
    });
  }

  repairAlert(alertId: string): Promise<GuardianRepairResult> {
    const current = this.alertRepairs.get(alertId);
    if (current) return current;
    const pending = this.enqueue("repair", async () => {
      const recovery = await this.ensureRecovery();
      const result = await recovery.recoverAlert(alertId, {
        repairEnabled: this.options.repairEnabled,
      });
      this.assertServiceOpenAfterRecovery();
      if (isAppServerFailure(result)) this.resetRuntime();
      await this.editTerminalStatus(alertId, result);
      return result;
    });
    this.alertRepairs.set(alertId, pending);
    void pending.finally(() => {
      if (this.alertRepairs.get(alertId) === pending) this.alertRepairs.delete(alertId);
    }).catch(() => undefined);
    return pending;
  }

  async repairThread(threadId: string): Promise<GuardianRepairResult> {
    assertGuardianThreadId(threadId);
    return await this.enqueue("repair", async () => {
      const result = await (await this.ensureRecovery()).repairThread(threadId, {
        repairEnabled: this.options.repairEnabled,
      });
      if (isAppServerFailure(result)) this.resetRuntime();
      return result;
    });
  }

  status(): GuardianDaemonStatus {
    const now = this.tryReadClock();
    const scanStale = this.lastScanAt === undefined
      || now === undefined
      || now < this.lastScanAt
      || now - this.lastScanAt > 2 * this.options.scanIntervalMs;
    return Object.freeze({
      running: this.running,
      observationOnly: this.options.observationOnly,
      repairEnabled: this.options.repairEnabled,
      appServerConnected: this.appServer !== undefined,
      scanStale,
      scans: this.scanCount,
      queueDepth: this.queueDepth,
      activeOperation: this.activeOperation,
      scanPhase: this.scanPhase,
      inspectionCount: this.inspectionTasks.size,
      ...(this.lastScanAt === undefined ? {} : { lastScanAt: this.lastScanAt }),
      ...(this.activeSince === undefined ? {} : { activeSince: this.activeSince }),
    });
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      let delay = this.options.scanIntervalMs;
      try {
        await this.scan();
      } catch {
        delay = APP_SERVER_BACKOFF_MS[Math.min(this.backoffIndex, APP_SERVER_BACKOFF_MS.length - 1)]!;
        this.backoffIndex += 1;
      }
      if (!this.running || signal.aborted) break;
      try { await this.sleep(delay, signal); } catch {
        if (!signal.aborted) throw new Error("Guardian scan wait failed");
      }
    }
  }

  private async closeInternal(): Promise<void> {
    const quiesced = this.quiesceScanning();
    for (const gateway of [...this.inspectionGateways]) this.closeInspectionGateway(gateway);
    this.resetRuntime();
    await Promise.all([
      quiesced,
      Promise.allSettled([...this.inspectionTasks]).then(() => undefined),
    ]);
    await this.operationTail.catch(() => undefined);
    this.resetRuntime();
  }

  private async inspectThreadInternal(threadId: string): Promise<GuardianThreadInspection> {
    let appServer: GuardianServiceAppServer | undefined;
    try {
      appServer = await this.options.createInspectionAppServer();
      this.inspectionGateways.add(appServer);
      if (this.closed) throw new Error("Session guardian service is closed");
      const snapshot = await appServer.readThread(threadId);
      const inspection = inspectionOf(snapshot);
      const liveFingerprint = fingerprintOf(snapshot);
      if (!snapshot.root || liveFingerprint === null) return inspection;
      const persisted = this.options.store.inspectThreadObservation(threadId);
      if (!persisted || !equalFingerprints(liveFingerprint, persisted.observation.fingerprint)) {
        return inspection;
      }
      return Object.freeze({ ...inspection,
        observation: observationInspectionOf(persisted, this.readClock()) });
    } finally {
      if (appServer) this.closeInspectionGateway(appServer);
    }
  }

  private closeInspectionGateway(appServer: GuardianServiceAppServer): void {
    if (!this.inspectionGateways.delete(appServer)) return;
    try { appServer.close(); } catch { /* Preserve the inspection or shutdown result. */ }
  }

  private async inspectThreadAfterActiveScanRead(
    threadId: string,
  ): Promise<GuardianThreadInspection> {
    const active = this.activeScanRead;
    if (active) await active.settled;
    if (this.closed) throw new Error("Session guardian service is closed");
    return await this.inspectThreadInternal(threadId);
  }

  private async inspectThreadWhenAllowed(threadId: string): Promise<GuardianThreadInspection> {
    while (this.scanReadBarrier) await this.scanReadBarrier;
    if (this.closed) throw new Error("Session guardian service is closed");
    const active = this.inspectThreadAfterActiveScanRead(threadId);
    this.activeInspectionTasks.add(active);
    try { return await active; }
    finally { this.activeInspectionTasks.delete(active); }
  }

  private cancelActiveScanRead(): void {
    const active = this.activeScanRead;
    if (!active) return;
    if (this.appServer === active.appServer) this.resetRuntime();
  }

  private async awaitInspectionDrain(): Promise<void> {
    while (this.activeInspectionTasks.size > 0) {
      await Promise.allSettled([...this.activeInspectionTasks]);
    }
  }

  private async scanInternal(): Promise<GuardianScanSummary> {
    this.scanPhase = "reconciliation";
    this.assertScanActive("before reconciliation");
    await this.reconcileTerminalStatuses();
    this.assertScanActive("after reconciliation");
    const trackedThreadIds = new Set(this.options.store.listObservationThreadIds());
    for (const alert of this.options.store.listOpenAlerts()) {
      trackedThreadIds.add(alert.fingerprint.threadId);
    }
    this.scanPhase = "inspection-drain";
    const { snapshots, observedAt } = await this.readScanSnapshots([...trackedThreadIds]);
    this.scanPhase = "detector";
    this.assertScanActive("before detector");
    const outcomes = this.options.detector.scan(snapshots, observedAt);
    const byThreadId = new Map(snapshots.map((snapshot) => [snapshot.threadId, snapshot]));
    let deliveredAlerts = 0;
    let failedDeliveries = 0;
    this.scanPhase = "delivery";
    for (const alert of this.options.store.listOpenAlerts()) {
      this.assertScanActive("during alert delivery");
      const current = byThreadId.get(alert.fingerprint.threadId);
      if (!current || !sameFingerprint(current, alert)) {
        if (alert.state === "open") await this.closeProgressedAlert(alert);
        continue;
      }
      if (alert.state !== "open" || alert.deliveryState === "delivered") continue;
      const observation = this.options.store.getObservation(alert.fingerprint.threadId);
      if (!observation || !sameObservation(observation, alert)) continue;
      let delivery: GuardianTelegramDelivery;
      try {
        delivery = await this.options.notifier.sendAlert({
          alert,
          snapshot: current,
          staleForMs: Math.max(0, observedAt - observation.firstObservedAt),
        });
      } catch {
        this.assertScanActive("after alert notification");
        failedDeliveries += 1;
        try { this.options.store.markDeliveryFailed(alert.id); } catch { /* Retry on next scan. */ }
        continue;
      }
      this.assertScanActive("after alert notification");
      try {
        // Telegram delivery and SQLite cannot share a transaction. A process crash
        // between these calls may leave one duplicate on the next retry.
        this.options.store.recordDelivery(alert.id, delivery.messageId);
        deliveredAlerts += 1;
      } catch {
        this.assertScanActive("before delivery failure persistence");
        failedDeliveries += 1;
        try { this.options.store.markDeliveryFailed(alert.id); } catch { /* Retry on next scan. */ }
      }
    }
    this.assertScanActive("before scan completion");
    this.scanCount += 1;
    this.lastScanAt = this.readClock();
    this.backoffIndex = 0;
    return Object.freeze({ scanned: snapshots.length,
      detectedAlerts: outcomes.filter((outcome) => outcome.kind === "alert").length,
      deliveredAlerts, failedDeliveries });
  }

  private async readScanSnapshots(
    trackedThreadIds: readonly string[],
  ): Promise<{ readonly snapshots: GuardianThreadSnapshot[]; readonly observedAt: number }> {
    const releaseIntent = this.beginScanReadIntent();
    try {
      while (true) {
        this.scanPhase = "inspection-drain";
        await this.awaitInspectionDrain();
        if (this.closed || this.scanningQuiesced) {
          throw new Error("Guardian scan stopped before app-server read");
        }
        const appServer = await this.ensureRuntime();
        if (this.closed || this.scanningQuiesced) {
          this.resetRuntime();
          throw new Error("Guardian scan stopped before app-server read");
        }
        if (this.activeInspectionTasks.size > 0) continue;
        const observedAt = this.readClock();
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => { settle = resolve; });
        const active: ActiveScanRead = { appServer, settled, settle };
        this.activeScanRead = active;
        this.scanPhase = "app-read";
        try {
          const snapshots = await appServer.listRootThreads({
            recentCutoffMs: Math.max(0, observedAt - this.options.recentWindowMs),
            trackedThreadIds,
          });
          return { snapshots, observedAt };
        } catch (error) {
          this.resetRuntime();
          throw error;
        } finally {
          if (this.activeScanRead === active) this.activeScanRead = undefined;
          active.settle();
        }
      }
    } finally {
      releaseIntent();
    }
  }

  private beginScanReadIntent(): () => void {
    if (this.scanReadBarrier) throw new Error("Guardian scan read intent already exists");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    this.scanReadBarrier = barrier;
    return () => {
      if (this.scanReadBarrier !== barrier) return;
      this.scanReadBarrier = undefined;
      release();
    };
  }

  private async closeProgressedAlert(alert: GuardianAlert): Promise<void> {
    this.assertScanActive("before progressed alert persistence");
    const closure = this.options.store.markOpenAlertSelfRecovered(
      alert.id,
      "Thread progressed or became idle",
    );
    if (!closure.closed || closure.alert.deliveryState !== "delivered") return;
    await this.editDurableTerminal({
      alert: closure.alert,
      delivery: deliveryOf(closure.alert),
      status: "no-longer-eligible",
    }, () => this.assertScanActive("during progressed alert delivery"));
  }

  private async editChecking(alertId: string): Promise<void> {
    if (this.closed) return;
    const alert = this.options.store.getAlert(alertId);
    if (!alert || alert.state !== "checking" || alert.deliveryState !== "delivered") return;
    await this.safeEdit({ alert, delivery: deliveryOf(alert), status: "checking" });
  }

  private async editTerminalStatus(alertId: string, result: GuardianRepairResult): Promise<void> {
    const alert = this.options.store.getAlert(alertId);
    if (!alert || alert.deliveryState !== "delivered") return;
    const input = { alert, delivery: deliveryOf(alert), status: result } as const;
    if (alert.statusDeliveryState === "pending" || alert.statusDeliveryState === "failed") {
      await this.editDurableTerminal(input);
    } else {
      await this.safeEdit(input);
    }
  }

  private async reconcileTerminalStatuses(): Promise<void> {
    for (const alert of this.options.store.listAlertsNeedingStatusDelivery()) {
      await this.editDurableTerminal(
        { alert, delivery: deliveryOf(alert), status: terminalStatusOf(alert) },
        () => this.assertScanActive("during terminal reconciliation"),
      );
    }
  }

  private async editDurableTerminal(
    input: Parameters<GuardianServiceNotifier["editStatus"]>[0],
    continuationGuard?: () => void,
  ): Promise<void> {
    try {
      continuationGuard?.();
      await this.options.notifier.editStatus(input);
      continuationGuard?.();
      this.options.store.recordStatusDelivery(input.alert.id);
    } catch {
      continuationGuard?.();
      try { this.options.store.markStatusDeliveryFailed(input.alert.id); }
      catch { /* A concurrent terminal delivery may already have completed. */ }
    }
  }

  private assertScanActive(stage: string): void {
    if (this.closed || this.scanningQuiesced) {
      throw new Error(`Guardian scan stopped ${stage}`);
    }
  }

  private async safeEdit(input: Parameters<GuardianServiceNotifier["editStatus"]>[0]): Promise<void> {
    if (this.closed) return;
    try { await this.options.notifier.editStatus(input); } catch { /* Telegram is independent. */ }
  }

  private async ensureRuntime(): Promise<GuardianServiceAppServer> {
    if (this.appServer) return this.appServer;
    if (this.closed) throw new Error("Session guardian service is closed");
    const appServer = await this.options.createAppServer();
    if (this.closed) {
      try { appServer.close(); } catch { /* Preserve the closed service result. */ }
      throw new Error("Session guardian service is closed");
    }
    let recovery: GuardianServiceRecovery;
    try {
      recovery = this.options.createRecovery(appServer, {
        onChecking: (alertId) => this.editChecking(alertId),
        signal: this.shutdownAbort.signal,
      });
    } catch (error) {
      try { appServer.close(); } catch { /* Preserve the factory failure. */ }
      throw error;
    }
    this.appServer = appServer;
    this.recovery = recovery;
    return appServer;
  }

  private async ensureRecovery(): Promise<GuardianServiceRecovery> {
    await this.ensureRuntime();
    return this.recovery!;
  }

  private resetRuntime(): void {
    const appServer = this.appServer;
    this.appServer = undefined;
    this.recovery = undefined;
    try { appServer?.close(); } catch { /* Preserve the primary lifecycle result. */ }
  }

  private assertServiceOpenAfterRecovery(): void {
    if (this.closed) throw new Error("Session guardian service is closed");
  }

  private enqueue<T>(
    kind: Exclude<GuardianDaemonStatus["activeOperation"], "idle">,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Session guardian service is closed"));
    this.queueDepth += 1;
    const pending = this.operationTail.catch(() => undefined).then(async () => {
      this.queueDepth -= 1;
      this.activeOperation = kind;
      this.activeSince = this.tryReadClock();
      try { return await operation(); }
      finally {
        this.activeOperation = "idle";
        this.activeSince = undefined;
        if (kind === "scan") this.scanPhase = "idle";
      }
    });
    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private readClock(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value < 0) throw new Error("clock must return a non-negative number");
    return value;
  }

  private tryReadClock(): number | undefined {
    try { return this.readClock(); }
    catch { return undefined; }
  }
}

function deliveryOf(alert: GuardianAlert): GuardianTelegramDelivery {
  if (alert.deliveryState !== "delivered" || alert.messageId === undefined) {
    throw new Error("Guardian alert has no Telegram delivery");
  }
  return Object.freeze({ alertId: alert.id, chatId: alert.route.chatId,
    ...(alert.route.messageThreadId === undefined ? {} : { messageThreadId: alert.route.messageThreadId }),
    messageId: alert.messageId });
}

function sameFingerprint(snapshot: GuardianThreadSnapshot, alert: GuardianAlert): boolean {
  const fingerprint = fingerprintOf(snapshot);
  return fingerprint !== null && equalFingerprints(fingerprint, alert.fingerprint);
}
function sameObservation(observation: GuardianObservation, alert: GuardianAlert): boolean {
  return equalFingerprints(observation.fingerprint, alert.fingerprint);
}
function equalFingerprints(
  left: GuardianAlert["fingerprint"],
  right: GuardianAlert["fingerprint"],
): boolean {
  return left.threadId === right.threadId && left.turnId === right.turnId
    && left.updatedAt === right.updatedAt && left.itemCount === right.itemCount
    && left.lastItemType === right.lastItemType;
}

function isAppServerFailure(result: GuardianRepairResult): boolean {
  return result.outcome === "failed" && [
    "Fresh state check failed", "Interrupt failed", "Wait for idle failed",
    "Cold reload failed", "Final verification failed",
  ].includes(result.detail);
}

function terminalStatusOf(alert: GuardianAlert): GuardianRepairResult {
  const details: Record<string, string> = {
    restored: "Thread restored",
    "self-recovered": "Thread progressed or became idle",
    "observation-only": "Observation-only mode",
    "repair-disabled": "Repair is disabled",
    expired: "Alert not found",
    failed: "Fresh state check failed",
  };
  if (alert.state === "open" || alert.state === "checking") {
    throw new Error("Guardian terminal status is not terminal");
  }
  const allowedDetail = [
    "Thread restored", "Thread progressed or became idle", "Observation-only mode",
    "Repair is disabled", "Alert not found", "Fresh state check failed", "Interrupt failed",
    "Wait for idle failed", "Cold reload failed", "Final verification failed",
  ].includes(alert.detail ?? "") ? alert.detail! : details[alert.state]!;
  return Object.freeze({ outcome: alert.state, detail: allowedDetail,
    threadId: alert.fingerprint.threadId });
}

function inspectionOf(snapshot: GuardianThreadSnapshot): GuardianThreadInspection {
  return Object.freeze({ threadId: snapshot.threadId, turnId: snapshot.turnId,
    threadStatus: snapshot.threadStatus, turnStatus: snapshot.turnStatus,
    updatedAt: snapshot.updatedAt, itemCount: snapshot.itemCount,
    lastItemType: snapshot.lastItemType, source: sourceCategory(snapshot.source),
    canAcceptDirectInput: snapshot.canAcceptDirectInput, root: snapshot.root });
}

function observationInspectionOf(
  persisted: GuardianThreadObservation,
  now: number,
): GuardianObservationInspection {
  const { alert, observation, repairOutcome } = persisted;
  const terminalOutcome = alert !== null && alert.state !== "open" && alert.state !== "checking"
    ? alert.state : null;
  if ((terminalOutcome === null && repairOutcome !== null)
    || (terminalOutcome !== null && repairOutcome !== null && repairOutcome !== terminalOutcome)) {
    throw new Error("Guardian repair observation is inconsistent");
  }
  const repairState = alert === null ? "none"
    : alert.state === "open" ? "eligible"
      : alert.state === "checking" ? "in_progress" : "terminal";
  const guardianHealth = alert?.state === "checking" ? "checking"
    : alert === null ? "healthy" : "stalled";
  return Object.freeze({
    guardianHealth,
    lastObservedAt: observation.lastObservedAt,
    unchangedSince: observation.firstObservedAt,
    staleForMs: Math.max(0, now - observation.firstObservedAt),
    alertId: alert?.id ?? null,
    repairState,
    repairOutcome: terminalOutcome,
  });
}

function sourceCategory(source: unknown): GuardianSourceCategory {
  if (source === "cli" || source === "vscode" || source === "exec") return "cli";
  if (source === "appServer") return "app-server";
  if (source === "remote" || source === "chatgpt") return "remote";
  if (!isRecord(source)) return "unknown";
  if (ownValue(source, "subAgent") !== undefined && ownValue(source, "subAgent") !== null) {
    return "subagent";
  }
  if (ownValue(source, "custom") === "telecodex") return "telecodex";
  if (ownValue(source, "type") === "remote") return "remote";
  return "unknown";
}

function ownValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
