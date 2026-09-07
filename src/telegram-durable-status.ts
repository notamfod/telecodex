import type { GuardianThreadInspection } from "./session-guardian-ipc-client.js";
import type {
  DeliveryPart,
  FinishStatusAnchorRevisionInput,
  PrepareStatusAnchorRevisionInput,
  PrepareStatusAnchorRevisionResult,
  SqliteTelegramJobStore,
} from "./telegram-job-store.js";
import {
  projectTelegramJobStatus,
  type TelegramJobStatusProjection,
  type TelegramStatusAction,
  type TelegramStatusGuardianEvidence,
} from "./telegram-status-projection.js";
import {
  TurnProgressPresenter,
  type ProgressMessage,
  type TurnProgressAnchorFinish,
  type TurnProgressAnchorPersistence,
  type TurnProgressAnchorPreparation,
  type TurnProgressTransportClassification,
} from "./turn-progress.js";

const REFRESH_INTERVAL_MS = 10_000;
const GUARDIAN_INSPECTION_TIMEOUT_MS = 4_000;
const STATUS_ANCHOR_KEY = "status-anchor";

type DurableStatusStore = Pick<SqliteTelegramJobStore,
  "get" | "listEventSummaries" | "getDispatchableQueuePosition" | "listDeliveries" | "readSourcePayload"
  | "prepareStatusAnchorRevision" | "finishStatusAnchorRevision" | "replaceMissingStatusAnchorEdit">;

export type TelegramStatusRefreshPriority = "ordinary" | "urgent";

export interface TelegramDurableStatusMessage {
  readonly chatId: number;
  readonly messageThreadId?: number | null;
  readonly messageId?: number;
  readonly priority: TelegramStatusRefreshPriority;
  readonly admissionSignal?: AbortSignal;
  readonly html: string;
  readonly plain: string;
  readonly projection: TelegramJobStatusProjection;
  readonly actions: readonly TelegramStatusAction[];
}

export interface TelegramDurableStatusOptions {
  readonly store: DurableStatusStore;
  readonly guardian: { inspectThread(threadId: string): Promise<GuardianThreadInspection> };
  readonly transport: {
    send(message: TelegramDurableStatusMessage): Promise<number>;
    edit(message: TelegramDurableStatusMessage): Promise<void>;
  };
  readonly classifyTransportError: (
    operation: "send" | "edit",
    error: unknown,
  ) => TurnProgressTransportClassification;
  readonly onBackgroundError?: (jobId: string, error: unknown) => void;
  readonly now?: () => number;
}

interface StatusDestination { readonly chatId: number; readonly messageThreadId: number | null }
interface StatusEntry {
  readonly presenter: TurnProgressPresenter;
  readonly admission: AbortController;
  started: boolean;
  lastProjection: TelegramJobStatusProjection | null;
  running: Promise<void> | null;
  requested: TelegramStatusRefreshPriority | null;
  lastRefreshAt: number | null;
  timer?: NodeJS.Timeout;
  activePriority: TelegramStatusRefreshPriority;
  cuttingOver: boolean;
}

interface StatusRevision extends Readonly<Record<string, unknown>> {
  readonly jobId: string;
  readonly expectedAttemptCount: number;
  readonly expectedContentHash: string;
  readonly expectedLeaseUntil: number;
  readonly expectedMessageId: number | null;
}

export class TelegramDurableStatusService {
  private readonly now: () => number;
  private readonly presenters = new Map<string, StatusEntry>();
  private disposed = false;

  constructor(private readonly options: TelegramDurableStatusOptions) {
    if (typeof options.classifyTransportError !== "function") {
      throw new Error("Durable status requires a transport classifier");
    }
    this.now = options.now ?? Date.now;
  }

  get activePresenterCount(): number { return this.presenters.size; }

  async readProjection(jobId: string): Promise<TelegramJobStatusProjection> {
    if (this.disposed) throw new Error("Telegram durable status is disposed");
    const current = this.options.store.get(jobId);
    if (!current) throw new Error("Unknown Telegram job");
    const guardian: TelegramStatusGuardianEvidence = current.phase === "terminal"
      ? { availability: "available", inspection: null }
      : await this.guardianEvidence(current.threadId);
    const events = this.options.store.listEventSummaries(jobId);
    const position = current.phase === "queued"
      ? this.options.store.getDispatchableQueuePosition(current.id) : null;
    return projectTelegramJobStatus({
      job: current,
      latestEvent: events.at(-1) ?? null,
      deliveries: this.options.store.listDeliveries(jobId),
      guardian,
      queue: position === null ? null : { position },
      now: this.now(),
    });
  }

  refresh(
    jobId: string,
    priority: TelegramStatusRefreshPriority = "ordinary",
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Telegram durable status is disposed"));
    const activeEntry = this.presenters.get(jobId);
    if (activeEntry?.cuttingOver) return activeEntry.running ?? Promise.resolve();
    try {
      if (!this.options.store.get(jobId)) throw new Error("Unknown Telegram job");
      let entry = activeEntry;
      if (isPersistedAnchorBlocked(statusAnchor(this.options.store.listDeliveries(jobId)))) {
        if (!entry) return Promise.resolve();
        this.presenters.delete(jobId);
        entry.admission.abort();
        this.cancelTimer(entry);
        entry.requested = null;
        return entry.presenter.dispose();
      }
      if (!entry) {
        entry = this.createEntry(jobId);
        this.presenters.set(jobId, entry);
        priority = "urgent";
      }
      entry.requested = mergePriority(entry.requested, priority);
      if (entry.running) return entry.running;
      return this.schedule(jobId, entry);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async disposeJob(jobId: string): Promise<void> {
    const entry = this.presenters.get(jobId);
    if (!entry) return;
    this.beginDisposeJob(jobId);
    this.presenters.delete(jobId);
    this.cancelTimer(entry);
    entry.requested = null;
    await entry.presenter.dispose();
  }

  beginDisposeJob(jobId: string): void {
    const entry = this.presenters.get(jobId);
    if (!entry) return;
    entry.cuttingOver = true;
    entry.admission.abort();
    this.cancelTimer(entry);
    entry.requested = null;
  }

  async dispose(): Promise<void> {
    if (this.disposed && this.presenters.size === 0) return;
    this.disposed = true;
    const entries = [...this.presenters.values()];
    this.presenters.clear();
    for (const entry of entries) {
      entry.admission.abort();
      this.cancelTimer(entry);
      entry.requested = null;
    }
    await Promise.all(entries.map((entry) => entry.presenter.dispose()));
  }

  private schedule(jobId: string, entry: StatusEntry): Promise<void> {
    if (!this.isActive(jobId, entry) || entry.requested === null) return Promise.resolve();
    if (entry.running) return entry.running;
    const requested = entry.requested;
    const currentTime = this.now();
    const cadenceAt = entry.lastRefreshAt === null
      ? currentTime
      : entry.lastRefreshAt + REFRESH_INTERVAL_MS;
    const priorityAt = requested === "urgent" ? currentTime : cadenceAt;
    const dueAt = Math.max(priorityAt, this.pendingAnchorAt(jobId) ?? priorityAt);
    if (dueAt <= currentTime) return this.startRun(jobId, entry, requested);
    this.cancelTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!this.isActive(jobId, entry)) return;
      this.runDetached(jobId, () => this.schedule(jobId, entry));
    }, dueAt - currentTime);
    return Promise.resolve();
  }

  private startRun(
    jobId: string,
    entry: StatusEntry,
    priority: TelegramStatusRefreshPriority,
  ): Promise<void> {
    if (!this.isActive(jobId, entry)) return Promise.resolve();
    this.cancelTimer(entry);
    entry.requested = null;
    entry.activePriority = priority;
    entry.lastRefreshAt = this.now();
    const running = (async () => {
      let failed = false;
      let failure: unknown;
      try {
        if (entry.started) await entry.presenter.refreshStatus();
        else {
          entry.started = true;
          await entry.presenter.start();
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      entry.running = null;
      if (!this.isActive(jobId, entry)) return;
      if (entry.presenter.isTransportBlocked) {
        this.presenters.delete(jobId);
        entry.admission.abort();
        this.cancelTimer(entry);
        entry.requested = null;
        await entry.presenter.dispose();
      } else if (entry.lastProjection && isSettled(entry.lastProjection)
        && statusAnchor(this.options.store.listDeliveries(jobId)).state === "delivered") {
        this.presenters.delete(jobId);
        this.cancelTimer(entry);
        entry.requested = null;
        await entry.presenter.dispose();
      } else {
        entry.requested = mergePriority(entry.requested, "ordinary");
        this.runDetached(jobId, () => this.schedule(jobId, entry));
      }
      if (failed) throw failure;
    })();
    entry.running = running;
    return running;
  }

  private pendingAnchorAt(jobId: string): number | null {
    const anchor = statusAnchor(this.options.store.listDeliveries(jobId));
    return anchor.state === "pending" ? anchor.nextAttemptAt : null;
  }

  private isActive(jobId: string, entry: StatusEntry): boolean {
    return !this.disposed && !entry.cuttingOver && this.presenters.get(jobId) === entry;
  }

  private cancelTimer(entry: StatusEntry): void {
    if (!entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private runDetached(jobId: string, operation: () => Promise<void>): void {
    let running: Promise<void>;
    try {
      running = operation();
    } catch (error) {
      this.reportBackgroundError(jobId, error);
      return;
    }
    void running.catch((error) => this.reportBackgroundError(jobId, error));
  }

  private reportBackgroundError(jobId: string, error: unknown): void {
    try {
      this.options.onBackgroundError?.(jobId, error);
    } catch {
      // Background reporting must never create an unhandled rejection.
    }
  }

  private createEntry(jobId: string): StatusEntry {
    const job = this.options.store.get(jobId);
    if (!job) throw new Error("Unknown Telegram job");
    const destination = destinationFromSource(this.options.store.readSourcePayload(jobId), job.source);
    const entry = {} as StatusEntry;
    const admission = new AbortController();
    const projection = async () => {
      const value = await this.readProjection(jobId);
      entry.lastProjection = value;
      return value;
    };
    const anchor = statusAnchorPersistence(this.options.store, jobId, destination);
    const presenter = new TurnProgressPresenter({
      heartbeatMs: REFRESH_INTERVAL_MS,
      now: this.now,
      projection,
      anchor,
      classifyTransportError: this.options.classifyTransportError,
      send: (message) => this.options.transport.send(
        transportMessage(destination, message, "urgent", admission.signal),
      ),
      edit: (messageId, message) => this.options.transport.edit({
        ...transportMessage(
          destination,
          message,
          message.projection?.phase === "terminal" ? "urgent" : entry.activePriority,
          admission.signal,
        ),
        messageId,
      }),
    });
    Object.assign(entry, {
      presenter,
      admission,
      started: false,
      lastProjection: null,
      running: null,
      requested: null,
      lastRefreshAt: null,
      activePriority: "urgent",
      cuttingOver: false,
    });
    return entry;
  }

  private async guardianEvidence(threadId: string | null): Promise<TelegramStatusGuardianEvidence> {
    if (threadId === null) return { availability: "available", inspection: null };
    try {
      const inspection = await withTimeout(
        this.options.guardian.inspectThread(threadId),
        GUARDIAN_INSPECTION_TIMEOUT_MS,
      );
      return { availability: "available", inspection };
    } catch {
      return { availability: "unavailable", reasonCode: "GUARDIAN_UNAVAILABLE" };
    }
  }
}

function mergePriority(
  current: TelegramStatusRefreshPriority | null,
  requested: TelegramStatusRefreshPriority,
): TelegramStatusRefreshPriority {
  return current === "urgent" || requested === "urgent" ? "urgent" : "ordinary";
}

function statusAnchorPersistence(
  store: DurableStatusStore,
  jobId: string,
  destination: StatusDestination,
): TurnProgressAnchorPersistence {
  return {
    prepare: async ({ projection, message, nextAttemptAt, updatedAt }) => {
      if (projection.jobId !== jobId) throw new Error("Telegram status projection mismatch");
      const current = statusAnchor(store.listDeliveries(jobId));
      assertAutomaticPreparation(current, updatedAt);
      const input: PrepareStatusAnchorRevisionInput = {
        jobId,
        expectedJobVersion: projection.expectedVersion,
        expectedAttemptCount: current.attemptCount,
        expectedState: preparationState(current),
        payload: {
          operation: "send_text", chatId: destination.chatId,
          messageThreadId: destination.messageThreadId, text: message.html,
        },
        nextAttemptAt,
        updatedAt,
      };
      try {
        return preparedRevision(store.prepareStatusAnchorRevision(input), jobId);
      } catch (error) {
        const latest = store.get(jobId);
        if (latest && latest.version !== projection.expectedVersion) return { kind: "stale" };
        throw error;
      }
    },
    replaceMissingEdit: async ({ revision: raw, projection, message, updatedAt }) => {
      const revision = parseRevision(raw, jobId);
      if (projection.jobId !== jobId) throw new Error("Telegram status projection mismatch");
      if (revision.expectedMessageId === null) {
        throw new Error("Telegram status anchor message target changed");
      }
      store.replaceMissingStatusAnchorEdit({
        jobId,
        expectedAttemptCount: revision.expectedAttemptCount,
        expectedContentHash: revision.expectedContentHash,
        expectedLeaseUntil: revision.expectedLeaseUntil,
        expectedMessageId: revision.expectedMessageId,
        replacementPayload: {
          operation: "send_text",
          chatId: destination.chatId,
          messageThreadId: destination.messageThreadId,
          text: message.html,
        },
        updatedAt,
      });
    },
    finish: async (input) => {
      const revision = parseRevision(input.revision, jobId);
      if (statusAnchor(store.listDeliveries(jobId)).telegramMessageId !== revision.expectedMessageId) {
        throw new Error("Telegram status anchor message target changed");
      }
      store.finishStatusAnchorRevision(finishInput(input, revision));
    },
  };
}

function preparedRevision(
  result: PrepareStatusAnchorRevisionResult,
  jobId: string,
): TurnProgressAnchorPreparation {
  if (result.kind === "unchanged") {
    if (result.delivery.telegramMessageId === null) throw new Error("Telegram status anchor is blocked");
    return { kind: "unchanged", messageId: result.delivery.telegramMessageId };
  }
  const row = result.delivery;
  if (row.state !== "sending" || row.nextAttemptAt === null) throw new Error("Invalid Telegram status lease");
  const revision: StatusRevision = {
    jobId,
    expectedAttemptCount: row.attemptCount,
    expectedContentHash: row.contentHash,
    expectedLeaseUntil: row.nextAttemptAt,
    expectedMessageId: row.telegramMessageId,
  };
  const attempt = row.attemptCount + 1;
  if (row.telegramMessageId === null) return { kind: "prepared", revision, operation: "send", attempt };
  return {
    kind: "prepared", revision, operation: "edit", attempt, messageId: row.telegramMessageId,
  };
}

function finishInput(input: TurnProgressAnchorFinish, revision: StatusRevision): FinishStatusAnchorRevisionInput {
  return {
    jobId: revision.jobId,
    expectedAttemptCount: revision.expectedAttemptCount,
    expectedContentHash: revision.expectedContentHash,
    expectedLeaseUntil: revision.expectedLeaseUntil,
    state: input.state,
    attemptCount: revision.expectedAttemptCount + 1,
    ...(input.state === "delivered" ? { telegramMessageId: input.messageId } : {}),
    ...(input.state === "pending" ? { nextAttemptAt: input.nextAttemptAt } : {}),
    ...(input.state === "delivered" ? {} : { lastErrorCode: input.errorCode }),
    updatedAt: input.updatedAt,
  };
}

function parseRevision(value: Readonly<Record<string, unknown>>, jobId: string): StatusRevision {
  const keys = Object.keys(value);
  if (keys.length !== 5 || !["jobId", "expectedAttemptCount", "expectedContentHash", "expectedLeaseUntil",
    "expectedMessageId"]
    .every((key) => keys.includes(key)) || value.jobId !== jobId
    || !nonNegative(value.expectedAttemptCount) || !nonNegative(value.expectedLeaseUntil)
    || !(value.expectedMessageId === null || positiveInteger(value.expectedMessageId))
    || typeof value.expectedContentHash !== "string" || !/^[0-9a-f]{64}$/.test(value.expectedContentHash)) {
    throw new Error("Invalid Telegram status revision");
  }
  return value as unknown as StatusRevision;
}

function statusAnchor(rows: readonly DeliveryPart[]): DeliveryPart {
  const matches = rows.filter((row) => row.partKey === STATUS_ANCHOR_KEY);
  if (matches.length !== 1) throw new Error("Invalid Telegram status anchor");
  return matches[0]!;
}

function assertAutomaticPreparation(row: DeliveryPart, now: number): void {
  if (row.state === "uncertain" || row.state === "failed"
    || (row.state === "delivered" && row.telegramMessageId === null)
    || (row.state === "sending" && row.telegramMessageId === null)) {
    throw new Error("Telegram status anchor is blocked");
  }
  if (row.state === "pending" && row.nextAttemptAt !== null && row.nextAttemptAt > now) {
    throw new Error("Telegram status anchor retry is deferred");
  }
}

function preparationState(row: DeliveryPart): "pending" | "delivered" | "sending" {
  if (row.state === "pending" || row.state === "delivered" || row.state === "sending") return row.state;
  throw new Error("Telegram status anchor is blocked");
}

function transportMessage(
  destination: StatusDestination,
  message: ProgressMessage,
  priority: TelegramStatusRefreshPriority,
  admissionSignal: AbortSignal,
): TelegramDurableStatusMessage {
  if (!message.projection) throw new Error("Telegram status projection is missing");
  return {
    chatId: destination.chatId,
    messageThreadId: destination.messageThreadId,
    priority,
    admissionSignal,
    html: message.html,
    plain: message.plain,
    projection: message.projection,
    actions: message.actions ?? [],
  };
}

function destinationFromSource(value: unknown, expected: { botId: string; updateId: number }): StatusDestination {
  if (!plainRecord(value) || value.botId !== expected.botId || value.updateId !== expected.updateId
    || !nonzeroInteger(value.chatId)
    || !(value.messageThreadId === null || positiveInteger(value.messageThreadId))) {
    throw new Error("Invalid Telegram durable status destination");
  }
  const target = value.targetContext;
  if (target === undefined) return { chatId: value.chatId, messageThreadId: value.messageThreadId };
  if (!plainRecord(target) || !nonzeroInteger(target.chatId) || !positiveInteger(target.messageThreadId)) {
    throw new Error("Invalid Telegram durable status destination");
  }
  if (target.chatId !== value.chatId) throw new Error("Invalid Telegram durable status destination");
  return { chatId: target.chatId, messageThreadId: target.messageThreadId };
}

function isSettled(projection: TelegramJobStatusProjection): boolean {
  return projection.phase === "terminal" && projection.delivery.complete;
}

function isPersistedAnchorBlocked(row: DeliveryPart): boolean {
  return row.state === "uncertain" || row.state === "failed"
    || (row.state === "sending" && row.telegramMessageId === null);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Guardian inspection timed out")), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number { return nonNegative(value) && value > 0; }
function nonzeroInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
}
