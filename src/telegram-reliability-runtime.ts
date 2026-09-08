import { createHash, randomUUID } from "node:crypto";

import type { DashboardReliabilitySnapshot } from "./dashboard-api.js";
import type { DashboardSessionStatus } from "./dashboard-api.js";
import type { GuardianIpcResponse } from "./session-guardian-ipc-client.js";

import {
  TelegramDeliveryOutbox,
  type TelegramDeliveryAdapter,
} from "./telegram-delivery-outbox.js";
import {
  TelegramDurableStatusService,
  type TelegramDurableStatusOptions,
  type TelegramStatusRefreshPriority,
} from "./telegram-durable-status.js";
import {
  TelegramJobCoordinator,
  type TelegramCoordinatorCodexAdapter,
} from "./telegram-job-coordinator.js";
import {
  TelegramJobIngress,
  type TelegramJobIngressOptions,
  type TelegramWorkSource,
  type TelegramWorkTargetContext,
} from "./telegram-job-ingress.js";
import type { TelegramCompletionProcessor } from "./telegram-inbox-completion.js";
import type { SqliteTelegramJobStore } from "./telegram-job-store.js";
import type { TelegramJob } from "./telegram-job-types.js";
import {
  createTelegramReconciliationRuntime,
} from "./telegram-reconciliation-runtime.js";
import {
  createTelegramSessionCodexAdapter,
  type TelegramSessionCodexAdapterOptions,
} from "./telegram-session-codex-adapter.js";
import {
  handleTelegramWork,
  type TelegramWorkHandlingResult,
} from "./telegram-work-handlers.js";
import type { TelegramExactTurnReader } from "./telegram-exact-turn-inspector.js";
import type { TelegramGuardianInspector } from "./telegram-guardian-reconciliation.js";
import {
  enrichTopicRecoveryAction,
  type TelegramStatusAction,
  type TelegramTopicRecoveryActionState,
} from "./telegram-status-projection.js";
import {
  planTelegramTopicRecovery,
  type TelegramTopicRecoveryCandidate,
} from "./telegram-topic-recovery.js";
import {
  createTelegramTopicRecoveryRuntime,
  type TelegramTopicRecoveryRuntimeOptions,
} from "./telegram-topic-recovery-runtime.js";
import type { TelegramTurnResult } from "./telegram-turn-result.js";

const DASHBOARD_JOB_LIMIT = 200;
const DASHBOARD_CONNECTIVITY_TIMEOUT_MS = 2_000;
const INTERNAL_DEPENDENCY_PROBE_TIMEOUT_MS = 1_500;

export function boundedReliabilityProbeTimeoutMs(configuredTimeoutMs: number): number {
  if (!Number.isSafeInteger(configuredTimeoutMs) || configuredTimeoutMs < 1) {
    throw new Error("Invalid reliability probe timeout");
  }
  return Math.min(configuredTimeoutMs, INTERNAL_DEPENDENCY_PROBE_TIMEOUT_MS);
}

type DashboardGuardian = TelegramGuardianInspector & {
  status?(): Promise<GuardianIpcResponse>;
  repairAlert?(alertId: string): Promise<GuardianIpcResponse>;
};

export interface TelegramCanonicalJobRef {
  readonly jobId: string;
  readonly version: number;
}

export interface TelegramCanonicalContext {
  readonly botId: string;
  readonly chatId: number;
  readonly messageThreadId: number | null;
}

export interface TelegramCanonicalControlSource extends TelegramCanonicalContext {
  readonly updateId: number;
  readonly messageId: number;
}

type Wakeup = (at: number, wake: () => void | Promise<void>) => void;

export type TelegramReliabilityRuntimeOperation =
  | "status_refresh"
  | "delivery"
  | "coordinator"
  | "reconciliation";

export interface TelegramReliabilityRuntimeErrorContext {
  readonly jobId: string | null;
  readonly operation: TelegramReliabilityRuntimeOperation;
  readonly error: unknown;
}

export interface TelegramReliabilityRuntimeOptions {
  readonly store: SqliteTelegramJobStore;
  readonly registry: TelegramSessionCodexAdapterOptions["registry"];
  readonly materializationRoot: string;
  readonly exactTurnReader: TelegramExactTurnReader;
  readonly guardian: DashboardGuardian;
  readonly checkAppServer?: (signal?: AbortSignal) => Promise<void>;
  readonly checkTelegram?: (signal?: AbortSignal) => Promise<void>;
  readonly downloadAttachment: TelegramJobIngressOptions["downloadAttachment"];
  readonly createForumTopic?: (input: {
    readonly chatId: number;
    readonly topicName: string;
    readonly signal: AbortSignal;
  }) => Promise<TelegramWorkTargetContext>;
  readonly targetProvisionTimeoutMs?: number;
  readonly transcribeAttachment?: TelegramJobIngressOptions["transcribeAttachment"];
  readonly materializationTimeoutMs?: number;
  readonly statusTransport: TelegramDurableStatusOptions["transport"];
  readonly classifyStatusTransportError: TelegramDurableStatusOptions["classifyTransportError"];
  readonly deliveryTransport: TelegramDeliveryAdapter;
  readonly attachmentRoot?: string;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly globalConcurrency?: number;
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
  readonly deliveryTimeoutMs?: number;
  readonly deliveryAttemptLimit?: number;
  readonly prepareCompletion?: TelegramCompletionProcessor;
  readonly scheduleCoordinatorWakeup?: Wakeup;
  readonly scheduleDeliveryWakeup?: Wakeup;
  readonly topicRecovery?: Omit<TelegramTopicRecoveryRuntimeOptions, "store" | "outboxPump">;
  readonly onRuntimeError?: (input: TelegramReliabilityRuntimeErrorContext) => void;
}

export interface TelegramReliabilityRuntime {
  handle(source: TelegramWorkSource): Promise<TelegramWorkHandlingResult>;
  handleWork(source: TelegramWorkSource): Promise<TelegramWorkTargetContext | null>;
  reconcile(): ReturnType<ReturnType<typeof createTelegramReconciliationRuntime>>;
  latestJob(context: TelegramCanonicalContext): Promise<TelegramCanonicalJobRef | null>;
  retry(input: {
    readonly source: TelegramCanonicalControlSource;
    readonly target: TelegramCanonicalJobRef;
  }): Promise<void>;
  abort(input: {
    readonly source: TelegramCanonicalControlSource;
    readonly target: TelegramCanonicalJobRef;
  }): Promise<void>;
  refresh(jobId: string): Promise<void>;
  loadDashboardReliability(limit?: number): Promise<DashboardReliabilitySnapshot>;
  loadDashboardSessionStatuses(): Promise<readonly DashboardSessionStatus[]>;
  runDashboardAction(action: TelegramStatusAction, context?: TelegramCanonicalContext): Promise<void>;
  dispose(): Promise<void>;
}

export function createTelegramReliabilityRuntime(
  options: TelegramReliabilityRuntimeOptions,
): TelegramReliabilityRuntime {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const store = options.store;
  const targetProvisionTimeoutMs = boundedTimeout(
    options.targetProvisionTimeoutMs ?? options.deliveryTimeoutMs ?? 15_000,
    "targetProvisionTimeoutMs",
  );
  const effects = new Map<string, Promise<void>>();
  const topicRecoveryEffects = new Set<Promise<void>>();
  const turns = new Map<string, Promise<void>>();
  const statusCutovers = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  const report = (
    jobId: string | null,
    operation: TelegramReliabilityRuntimeOperation,
    error: unknown,
  ) => {
    try {
      options.onRuntimeError?.({ jobId, operation, error });
    } catch {
      // Reporting must never replace or reject the runtime operation it observes.
    }
  };
  const schedule = (
    provided: Wakeup | undefined,
    operation: TelegramReliabilityRuntimeOperation,
  ): Wakeup => provided
    ? (at, wake) => provided(at, async () => {
        if (!disposed) await Promise.resolve(wake()).catch((error) => report(null, operation, error));
      })
    : (at, wake) => {
        const delay = Math.max(0, at - now());
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!disposed) {
            void Promise.resolve(wake()).catch((error) => report(null, operation, error));
          }
        }, delay);
        timers.add(timer);
      };

  const ingress = new TelegramJobIngress({
    store, materializationRoot: options.materializationRoot, now, createId,
    downloadAttachment: options.downloadAttachment,
    ...(options.materializationTimeoutMs === undefined
      ? {}
      : { materializationTimeoutMs: options.materializationTimeoutMs }),
    ...(options.transcribeAttachment ? { transcribeAttachment: options.transcribeAttachment } : {}),
  });
  const status = new TelegramDurableStatusService({
    store,
    guardian: {
      inspectThread: async (threadId) => {
        const response = await options.guardian.inspectThread(threadId);
        if (response.threadId !== threadId || response.thread?.threadId !== threadId) {
          throw new Error("Guardian thread identity changed");
        }
        return response.thread;
      },
    },
    transport: options.statusTransport,
    classifyTransportError: options.classifyStatusTransportError,
    onBackgroundError: (jobId, error) => report(jobId, "status_refresh", error),
    now,
  });
  const deliveryAttemptJobIds: string[] = [];
  const outbox = new TelegramDeliveryOutbox({
    store: trackDeliveryAttemptJobs(store, (jobId) => deliveryAttemptJobIds.push(jobId)),
    telegram: {
      deliver: async (payload, signal) => {
        const jobId = deliveryAttemptJobIds.shift() ?? null;
        try {
          return await options.deliveryTransport.deliver(payload, signal);
        } catch (error) {
          try {
            report(jobId, "delivery", error);
          } finally {
            throw error;
          }
        }
      },
    },
    now, createId,
    scheduleWakeup: schedule(options.scheduleDeliveryWakeup, "delivery"),
    timeoutMs: options.deliveryTimeoutMs,
    attemptLimit: options.deliveryAttemptLimit,
    attachmentRoot: options.attachmentRoot ?? options.materializationRoot,
    statusDestination: (jobId) => {
      const destination = responseDestination(store, requireJob(store, jobId));
      return { chatId: destination.chatId, messageThreadId: destination.messageThreadId };
    },
  });
  const trackTopicRecoveryEffect = (effect: Promise<void>): void => {
    const drain = effect.catch(() => undefined);
    topicRecoveryEffects.add(drain);
    void drain.finally(() => topicRecoveryEffects.delete(drain));
  };
  const topicRecovery = options.topicRecovery
    ? createTelegramTopicRecoveryRuntime({
        ...options.topicRecovery,
        store,
        outboxPump: () => outbox.pump(),
        trackEffect: trackTopicRecoveryEffect,
      })
    : undefined;
  const session = trackedAdapter(createTelegramSessionCodexAdapter({
    store, registry: options.registry, materializationRoot: options.materializationRoot,
  }), turns);

  let coordinator!: TelegramJobCoordinator;
  const enqueue = (
    jobId: string,
    operation: TelegramReliabilityRuntimeOperation,
    effect: () => Promise<void>,
  ): Promise<void> => {
    const previous = effects.get(jobId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (!disposed) await effect();
    });
    effects.set(jobId, next);
    void next.catch((error) => report(jobId, operation, error));
    void next.finally(() => {
      if (effects.get(jobId) === next) effects.delete(jobId);
    }).catch(() => {});
    return next;
  };
  const refreshNow = async (
    jobId: string,
    priority: TelegramStatusRefreshPriority,
  ): Promise<void> => {
    if (statusCutovers.has(jobId)) return;
    const job = requireJob(store, jobId);
    if (job.phase === "terminal" && job.outcome === "completed") {
      await status.disposeJob(jobId);
      return;
    }
    if (job.phase === "delivering" && job.responsePlan !== undefined) {
      await status.disposeJob(jobId);
      return;
    }
    const effectivePriority = job.phase === "terminal" && job.outcome !== "completed"
      ? "urgent"
      : priority;
    await status.refresh(jobId, effectivePriority);
  };
  const deliver = async (jobId: string): Promise<void> => {
    let job: TelegramJob;
    try {
      job = requireJob(store, jobId);
    } catch (error) {
      report(jobId, "coordinator", error);
      return;
    }
    if (job.phase !== "delivering" || !job.turnResult) return;
    if (job.responsePlan === undefined) {
      try {
        const destination = responseDestination(store, job);
        const source = durableSource(store, job);
        const prepared = source.completion === undefined
          ? undefined
          : await requireCompletionProcessor(options.prepareCompletion)({
              jobId: job.id,
              source,
              result: job.turnResult,
            });
        await status.disposeJob(jobId);
        job = outbox.installPlan(job.id, destination, undefined, {
          result: withoutCommentary(prepared?.result ?? job.turnResult),
          ...(prepared?.supplementalParts
            ? { supplementalParts: prepared.supplementalParts }
            : {}),
        });
        statusCutovers.delete(jobId);
      } catch (error) {
        statusCutovers.delete(jobId);
        report(job.id, "coordinator", error);
        try {
          const current = requireJob(store, job.id);
          if (current.phase === "delivering" && current.responsePlan === undefined) {
            store.transition({
              jobId: current.id,
              eventId: createId(),
              expectedVersion: current.version,
              event: {
                schemaVersion: 1,
                type: "job.terminal",
                eventAt: Math.max(now(), current.updatedAt),
                outcome: "failed",
                attention: {
                  kind: "required",
                  code: "completion_processing_failed",
                  actions: ["inspect", "retry"],
                },
              },
            });
          }
        } catch (coordinatorError) {
          report(job.id, "coordinator", coordinatorError);
          return;
        }
        try {
          await status.disposeJob(job.id);
          await refreshNow(job.id, "urgent");
        }
        catch (statusError) { report(job.id, "status_refresh", statusError); }
        return;
      }
    } else {
      try {
        await status.disposeJob(jobId);
        statusCutovers.delete(jobId);
      } catch (error) {
        statusCutovers.delete(jobId);
        report(job.id, "coordinator", error);
        return;
      }
    }
    if (job.phase === "delivering") await outbox.pump();
  };
  const afterTransition = (job: TelegramJob): void => {
    if (job.phase === "delivering" && job.turnResult) {
      statusCutovers.add(job.id);
      status.beginDisposeJob(job.id);
      void enqueue(job.id, "delivery", () => deliver(job.id));
      return;
    }
    void enqueue(job.id, "status_refresh", () => refreshNow(job.id, "ordinary"));
  };
  const coordinatorStore = {
    get: store.get.bind(store),
    listUnfinished: store.listUnfinished.bind(store),
    listDispatchable: store.listDispatchable.bind(store),
    readSourcePayload: store.readSourcePayload.bind(store),
    transition: (input: Parameters<SqliteTelegramJobStore["transition"]>[0]) => {
      const job = store.transition(input);
      afterTransition(job);
      return job;
    },
  };
  coordinator = new TelegramJobCoordinator({
    store: coordinatorStore, materializer: ingress, codex: session, now, createId,
    scheduleWakeup: schedule(options.scheduleCoordinatorWakeup, "coordinator"),
    ...(options.globalConcurrency === undefined ? {} : { globalConcurrency: options.globalConcurrency }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryBackoffMs === undefined ? {} : { retryBackoffMs: options.retryBackoffMs }),
  });
  const runReconciliation = createTelegramReconciliationRuntime({
    store, coordinator, materializer: ingress,
    resumeDelivery: (jobId) => enqueue(jobId, "delivery", () => deliver(jobId)),
    refreshStatus: (jobId) => enqueue(jobId, "status_refresh", () => refreshNow(jobId, "urgent")),
    exactTurnReader: options.exactTurnReader, guardian: options.guardian, now, createId,
  });

  const requireProvisionAttention = async (jobId: string): Promise<void> => {
    const current = requireJob(store, jobId);
    if (current.attention.kind === "required"
      && current.attention.code === "target_topic_provision_unknown"
      && current.health === "stalled") return;
    store.transition({
      jobId,
      eventId: createId(),
      expectedVersion: current.version,
      event: {
        schemaVersion: 1,
        type: "activity.observed",
        eventAt: Math.max(now(), current.updatedAt),
        health: "stalled",
        attention: {
          kind: "required",
          code: "target_topic_provision_unknown",
          actions: ["inspect", "retry"],
        },
      },
    });
    try { await refreshNow(jobId, "ordinary"); }
    catch (error) { report(jobId, "status_refresh", error); }
  };

  const ensureTarget = async (jobId: string): Promise<TelegramWorkTargetContext | null> => {
    const job = requireJob(store, jobId);
    const source = durableSource(store, job);
    if (source.targetContext) return structuredClone(source.targetContext);
    const provision = source.targetProvision;
    if (!provision) return null;
    if (provision.state === "in_flight") {
      await requireProvisionAttention(jobId);
      throw new Error("Telegram target topic provision is ambiguous");
    }
    if (provision.state !== "planned" || !options.createForumTopic) {
      await requireProvisionAttention(jobId);
      throw new Error("Telegram target topic provision is unavailable");
    }

    const inFlight: TelegramWorkSource = {
      ...source,
      targetProvision: { ...provision, state: "in_flight" },
    };
    store.replaceSourcePayload(job.id, job.source, inFlight);
    let target: TelegramWorkTargetContext;
    const controller = new AbortController();
    try {
      target = await withRuntimeTimeout(
        options.createForumTopic({
          chatId: source.chatId, topicName: provision.topicName, signal: controller.signal,
        }),
        targetProvisionTimeoutMs,
        () => controller.abort(new Error("Telegram target topic provision timed out")),
      );
    } catch (error) {
      await requireProvisionAttention(jobId);
      throw error;
    }
    if (target.chatId !== source.chatId || !Number.isSafeInteger(target.messageThreadId)
      || target.messageThreadId < 1) {
      await requireProvisionAttention(jobId);
      throw new Error("Telegram target topic identity changed");
    }
    const complete: TelegramWorkSource = {
      ...source,
      targetContext: structuredClone(target),
      targetProvision: { ...provision, state: "complete" },
    };
    store.replaceSourcePayload(job.id, job.source, complete);
    return structuredClone(target);
  };

  const reconcileTargetProvisions = async (): Promise<void> => {
    for (const job of store.listUnfinished(1_000)) {
      if (job.phase !== "accepted") continue;
      const source = durableSource(store, job);
      if (!source.targetProvision || source.targetContext) continue;
      try { await ensureTarget(job.id); }
      catch (error) { report(job.id, "reconciliation", error); }
    }
  };

  const scheduleWork = async (source: TelegramWorkSource): Promise<{
    readonly result: TelegramWorkHandlingResult;
    readonly target: TelegramWorkTargetContext | null;
  }> => {
    assertRunning(disposed);
    const accepted = ingress.accept(source);
    const target = await ensureTarget(accepted.job.id);
    const durable = durableSource(store, requireJob(store, accepted.job.id));
    const statusPriority: TelegramStatusRefreshPriority = accepted.created ? "urgent" : "ordinary";
    const result = await handleTelegramWork(durable, {
      ingress,
      status: {
        refresh: (jobId) => enqueue(
          jobId,
          "status_refresh",
          () => refreshNow(jobId, statusPriority),
        ),
      },
      coordinator,
    });
    return { result: { ...result, created: accepted.created }, target };
  };
  const releaseAmbiguousRetryParent = (childSource: TelegramWorkSource): void => {
    if (childSource.kind !== "retry" || childSource.retryOfJobId === null) return;
    const parent = store.get(childSource.retryOfJobId);
    if (!parent) return;
    const targetProvisionUnknown = parent.phase === "accepted"
      && parent.attention.kind === "required"
      && parent.attention.code === "target_topic_provision_unknown";
    if (!targetProvisionUnknown && (parent.phase !== "dispatching" || parent.turnId !== null)) return;
    const parentSource = durableSource(store, parent);
    if (!sameJobContext(parentSource, childSource)) throw new Error("Telegram retry parent source mismatch");
    store.transition({
      jobId: parent.id,
      eventId: createId(),
      expectedVersion: parent.version,
      event: {
        schemaVersion: 1,
        type: "job.terminal",
        eventAt: Math.max(now(), parent.updatedAt),
        outcome: "recovery_interrupted",
        attention: { kind: "none" },
      },
    });
    void enqueue(parent.id, "status_refresh", () => refreshNow(parent.id, "ordinary"));
  };
  const releasePersistedRetryParents = (): void => {
    for (const child of store.listUnfinished(1_000)) {
      const source = normalizeWorkSource(store.readSourcePayload(child.id));
      releaseAmbiguousRetryParent(source);
    }
  };
  const handle = async (source: TelegramWorkSource): Promise<TelegramWorkHandlingResult> => {
    const { result } = await scheduleWork(source);
    const turn = turns.get(result.job.id);
    if (turn) await turn.catch(() => undefined);
    await drain(result.job.id, effects);
    return { ...result, job: requireJob(store, result.job.id) };
  };

  return {
    handle,
    async handleWork(source) { return (await scheduleWork(source)).target; },
    async reconcile() {
      assertRunning(disposed);
      let result: Awaited<ReturnType<typeof runReconciliation>>;
      try {
        await topicRecovery?.reconcile();
        await reconcileTargetProvisions();
        releasePersistedRetryParents();
        result = await runReconciliation();
        await reconcileTargetProvisions();
      } catch (error) {
        report(null, "reconciliation", error);
        throw error;
      }
      try {
        await outbox.pump();
      } catch (error) {
        report(null, "delivery", error);
        throw error;
      }
      return result;
    },
    async latestJob(context) {
      assertRunning(disposed);
      const expected = normalizeContext(context);
      const job = store.findLatestByContext(expected);
      if (!job) return null;
      const source = durableSource(store, job);
      if (!sameJobContext(source, expected)) throw new Error("Telegram job source mismatch");
      return { jobId: job.id, version: job.version };
    },
    async retry({ source, target }) {
      assertRunning(disposed);
      const parent = exactJob(store, target);
      const durable = durableSource(store, parent);
      assertRetryNewTurnLegal(parent, durable);
      const control = normalizeControlSource(source);
      if (!sameJobContext(durable, control)) throw new Error("Telegram job source mismatch");
      const retrySource: TelegramWorkSource = {
        botId: control.botId, updateId: control.updateId, chatId: control.chatId,
        messageThreadId: control.messageThreadId, messageId: control.messageId,
        kind: "retry", text: durable.text,
        attachment: durable.attachment === null ? null : structuredClone(durable.attachment),
        retryOfJobId: parent.id,
        ...(durable.targetContext ? { targetContext: structuredClone(durable.targetContext) } : {}),
        ...(durable.targetProvision ? { targetProvision: retryTargetProvision(durable) } : {}),
        ...(durable.sessionDefaults ? { sessionDefaults: structuredClone(durable.sessionDefaults) } : {}),
        ...(durable.implementationHandoffProfileId
          ? { implementationHandoffProfileId: durable.implementationHandoffProfileId }
          : {}),
        ...(durable.completion ? { completion: structuredClone(durable.completion) } : {}),
      };
      ingress.acceptRetry(retrySource, target.version);
      releaseAmbiguousRetryParent(retrySource);
      await scheduleWork(retrySource);
    },
    async abort({ source, target }) {
      assertRunning(disposed);
      await enqueue(target.jobId, "coordinator", async () => {
        const job = exactJob(store, target);
        const durable = durableSource(store, job);
        const control = normalizeControlSource(source);
        if (!sameJobContext(durable, control)) throw new Error("Telegram job source mismatch");
        if (job.phase !== "accepted" && job.phase !== "queued" && job.phase !== "running") {
          throw new Error("Telegram job is not abortable");
        }
        await coordinator.abort(target.jobId);
      });
      await drain(target.jobId, effects);
    },
    async refresh(jobId) {
      assertRunning(disposed);
      await enqueue(jobId, "status_refresh", () => refreshNow(jobId, "urgent"));
    },
    async loadDashboardReliability(limit = DASHBOARD_JOB_LIMIT) {
      assertRunning(disposed);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Dashboard job limit");
      const jobLimit = Math.min(limit, DASHBOARD_JOB_LIMIT);
      const candidates = uniqueJobs([
        ...store.listStatusCandidates(jobLimit),
        ...store.listRecent(jobLimit),
      ]).slice(0, jobLimit);
      const aggregates = store.getDashboardAggregates(now());
      const [jobs, appServer, guardian, telegramAvailable] = await Promise.all([
        Promise.all(candidates.map(async (job) => {
          const projection = await status.readProjection(job.id);
          return {
            projection: topicRecovery
              ? enrichTopicRecoveryProjection(store, options.topicRecovery!, projection)
              : projection,
            events: store.listEventSummaries(job.id).slice(-50).map((event) => ({
              timestamp: event.eventAt,
              code: event.type,
            })),
          };
        })),
        available(options.checkAppServer),
        guardianDashboardStatus(options.guardian),
        available(options.checkTelegram),
      ]);
      const degraded = aggregates.counts.undelivered > 0;
      return {
        jobs,
        aggregates,
        appServer: appServer
          ? { connectivity: "connected", reasonCode: null }
          : { connectivity: "unavailable", reasonCode: "APP_SERVER_UNAVAILABLE" },
        guardian,
        telegram: !telegramAvailable
          ? { deliveryHealth: "unavailable", reasonCode: "TELEGRAM_UNAVAILABLE" }
          : degraded
            ? { deliveryHealth: "degraded", reasonCode: "DELIVERY_BACKLOG" }
            : { deliveryHealth: "healthy", reasonCode: null },
      };
    },
    async loadDashboardSessionStatuses() {
      assertRunning(disposed);
      return uniqueJobs([
        ...store.listStatusCandidates(DASHBOARD_JOB_LIMIT),
        ...store.listRecent(DASHBOARD_JOB_LIMIT),
      ]).slice(0, DASHBOARD_JOB_LIMIT).map((job) => ({
        threadId: job.threadId,
        health: job.health,
        attentionKind: job.attention.kind,
        updatedAt: job.updatedAt,
      }));
    },
    async runDashboardAction(action, context) {
      assertRunning(disposed);
      if (context) {
        const durable = durableSource(store, requireJob(store, action.jobId));
        if (!sameJobContext(durable, normalizeContext(context))) {
          throw new Error("Telegram job source mismatch");
        }
      }
      const rawProjection = await status.readProjection(action.jobId);
      const projection = topicRecovery
        ? enrichTopicRecoveryProjection(store, options.topicRecovery!, rawProjection)
        : rawProjection;
      const effectiveAction = action.kind === "guardian_restore" && !action.alertId
        ? projection.actions.find((candidate) => candidate.kind === "guardian_restore"
            && candidate.jobId === action.jobId
            && candidate.expectedVersion === action.expectedVersion)
        : action;
      if (!effectiveAction
        || !projection.actions.some((candidate) => sameStatusAction(candidate, effectiveAction))) {
        throw new Error("Dashboard action is no longer legal");
      }
      if (action.kind === "recover_missing_topic") {
        if (!topicRecovery) throw new Error("Dashboard action is no longer legal");
        await topicRecovery.recover(action);
        return;
      }
      if (action.kind === "details" || action.kind === "inspect") return;
      if (action.kind === "refresh") {
        await enqueue(action.jobId, "status_refresh", () => refreshNow(action.jobId, "urgent"));
        await drain(action.jobId, effects);
        return;
      }
      if (action.kind === "abort") {
        await enqueue(action.jobId, "coordinator", async () => {
          exactJob(store, { jobId: action.jobId, version: action.expectedVersion });
          await coordinator.abort(action.jobId);
        });
        await drain(action.jobId, effects);
        return;
      }
      if (effectiveAction.kind === "guardian_restore" && effectiveAction.alertId
        && options.guardian.repairAlert) {
        await options.guardian.repairAlert(effectiveAction.alertId);
        return;
      }
      if (action.kind === "send_again_warning" && action.partKey) {
        await outbox.sendAgainWithWarning(action.jobId, action.partKey);
        return;
      }
      if (action.kind === "retry_delivery" && action.partKey) {
        await outbox.retryFailed(action.jobId, action.partKey, {
          expectedJobVersion: action.expectedVersion,
        });
        return;
      }
      if (action.kind === "retry_new_turn") {
        const parent = exactJob(store, {
          jobId: action.jobId,
          version: action.expectedVersion,
        });
        const durable = durableSource(store, parent);
        assertRetryNewTurnLegal(parent, durable, "Dashboard action is no longer legal");
        const retrySource = dashboardRetrySource(store, durable, parent.id);
        ingress.acceptRetry(retrySource, action.expectedVersion);
        releaseAmbiguousRetryParent(retrySource);
        await scheduleWork(retrySource);
        return;
      }
      throw new Error("Dashboard action is not supported by this runtime");
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      topicRecovery?.dispose();
      coordinator.dispose();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...effects.values(), ...topicRecoveryEffects]);
      effects.clear();
      topicRecoveryEffects.clear();
      turns.clear();
      statusCutovers.clear();
      await status.dispose();
    },
  };
}

function enrichTopicRecoveryProjection(
  store: SqliteTelegramJobStore,
  options: NonNullable<TelegramReliabilityRuntimeOptions["topicRecovery"]>,
  projection: Awaited<ReturnType<TelegramDurableStatusService["readProjection"]>>,
) {
  const recovery = store.getTopicRecovery(projection.jobId);
  const activeState = recovery !== null && isActiveTopicRecoveryState(recovery.state)
    ? recovery.state
    : undefined;
  const candidate = recovery === null
    ? currentTopicRecoveryCandidate(store, options, projection.jobId)
    : null;
  return enrichTopicRecoveryAction(projection, candidate, activeState);
}

function currentTopicRecoveryCandidate(
  store: SqliteTelegramJobStore,
  options: NonNullable<TelegramReliabilityRuntimeOptions["topicRecovery"]>,
  jobId: string,
): TelegramTopicRecoveryCandidate | null {
  const job = store.get(jobId);
  if (!job?.threadId) return null;
  const thread = options.getThread(job.threadId);
  if (!thread) return null;
  const deliveries = store.listDeliveries(job.id);
  const anchors = deliveries.filter((part) => part.partKey === "status-anchor");
  if (anchors.length !== 1) return null;
  const anchor = anchors[0]!;
  const candidate = planTelegramTopicRecovery({
    job,
    source: store.readSourcePayload(job.id) as TelegramWorkSource,
    deliveries,
    anchorPlan: { payload: anchor.payload, contentHash: anchor.contentHash },
    thread,
  });
  return candidate
    && candidate.oldDestination.chatId === options.forumChatId
    && options.hasThreadTopicBinding(candidate.threadId, candidate.oldDestination)
    ? candidate
    : null;
}

function isActiveTopicRecoveryState(value: string): value is TelegramTopicRecoveryActionState {
  return value === "in_flight" || value === "retry_wait" || value === "unknown";
}

function withoutCommentary(result: TelegramTurnResult): TelegramTurnResult {
  return {
    schemaVersion: 1,
    content: result.content.filter(
      (content) => content.kind !== "text" || content.phase !== "commentary",
    ),
  };
}

function uniqueJobs(jobs: readonly TelegramJob[]): TelegramJob[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
}

function dashboardRetrySource(
  store: SqliteTelegramJobStore,
  durable: TelegramWorkSource,
  parentJobId: string,
): TelegramWorkSource {
  const parent = store.get(parentJobId);
  if (!parent) throw new Error("Unknown Telegram job");
  const digest = createHash("sha256")
    .update(`dashboard-retry:${durable.botId}:${parentJobId}:${parent.version}`)
    .digest("hex");
  const updateId = 4_000_000_000_000_000 + (Number.parseInt(digest.slice(0, 12), 16) % 500_000_000_000_000);
  const existing = store.getBySourceKey({ botId: durable.botId, updateId });
  if (existing) {
    const source = durableSource(store, existing);
    if (source.retryOfJobId !== parentJobId || source.kind !== "retry") {
      throw new Error("Dashboard retry identity conflict");
    }
  }
  return {
    botId: durable.botId,
    updateId,
    chatId: durable.chatId,
    messageThreadId: durable.messageThreadId,
    messageId: durable.messageId,
    kind: "retry",
    text: durable.text,
    attachment: durable.attachment === null ? null : structuredClone(durable.attachment),
    retryOfJobId: parentJobId,
    ...(durable.targetContext ? { targetContext: structuredClone(durable.targetContext) } : {}),
    ...(durable.targetProvision ? { targetProvision: retryTargetProvision(durable) } : {}),
    ...(durable.sessionDefaults ? { sessionDefaults: structuredClone(durable.sessionDefaults) } : {}),
    ...(durable.implementationHandoffProfileId
      ? { implementationHandoffProfileId: durable.implementationHandoffProfileId }
      : {}),
    ...(durable.completion ? { completion: structuredClone(durable.completion) } : {}),
  };
}

async function available(
  check: ((signal?: AbortSignal) => Promise<void>) | undefined,
): Promise<boolean> {
  if (!check) return false;
  const controller = new AbortController();
  try {
    await withRuntimeTimeout(
      check(controller.signal),
      DASHBOARD_CONNECTIVITY_TIMEOUT_MS,
      () => controller.abort(new Error("Runtime probe timed out")),
    );
    return true;
  } catch { return false; }
}

async function guardianDashboardStatus(
  guardian: DashboardGuardian,
): Promise<DashboardReliabilitySnapshot["guardian"]> {
  if (!guardian.status) {
    return { connectivity: "unavailable", mode: "unknown", lastScanAt: null,
      reasonCode: "GUARDIAN_UNAVAILABLE" };
  }
  try {
    const response = await withRuntimeTimeout(guardian.status(), DASHBOARD_CONNECTIVITY_TIMEOUT_MS);
    const value = response.status;
    if (!value?.running) throw new Error("Guardian unavailable");
    return {
      connectivity: "connected",
      mode: value.observationOnly ? "observe" : value.repairEnabled ? "repair" : "unknown",
      lastScanAt: value.lastScanAt ?? null,
      reasonCode: !value.appServerConnected
        ? "APP_SERVER_UNAVAILABLE"
        : value.scanStale || response.outcome === "degraded"
          ? "GUARDIAN_SCAN_STALE"
          : null,
    };
  } catch {
    return { connectivity: "unavailable", mode: "unknown", lastScanAt: null,
      reasonCode: "GUARDIAN_UNAVAILABLE" };
  }
}

function sameStatusAction(left: TelegramStatusAction, right: TelegramStatusAction): boolean {
  return left.kind === right.kind && left.jobId === right.jobId
    && left.expectedVersion === right.expectedVersion
    && (left.alertId ?? null) === (right.alertId ?? null)
    && (left.partKey ?? null) === (right.partKey ?? null);
}

function withRuntimeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Runtime probe timed out"));
      onTimeout?.();
    }, timeoutMs);
    void operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function trackedAdapter(
  delegate: TelegramCoordinatorCodexAdapter,
  turns: Map<string, Promise<void>>,
): TelegramCoordinatorCodexAdapter {
  const track = (jobId: string, operation: Promise<void>): Promise<void> => {
    const tracked = operation.finally(() => {
      if (turns.get(jobId) === tracked) turns.delete(jobId);
    });
    turns.set(jobId, tracked);
    return tracked;
  };
  return {
    resolveThread: (job) => delegate.resolveThread(job),
    startTurn: (request) => track(request.jobId, delegate.startTurn(request)),
    recoverTurn: (request, turnId) => track(request.jobId, delegate.recoverTurn(request, turnId)),
    abortTurn: (input) => delegate.abortTurn(input),
  };
}

async function drain(jobId: string, effects: Map<string, Promise<void>>): Promise<void> {
  while (true) {
    const pending = effects.get(jobId);
    if (!pending) return;
    await pending;
    if (effects.get(jobId) === pending) return;
  }
}

function responseDestination(store: SqliteTelegramJobStore, job: TelegramJob) {
  const source = durableSource(store, job);
  const anchors = store.listDeliveries(job.id).filter((row) => row.partKey === "status-anchor");
  if (anchors.length !== 1) throw new Error("Invalid Telegram status anchor");
  return {
    chatId: source.targetContext?.chatId ?? source.chatId,
    messageThreadId: source.targetContext?.messageThreadId ?? source.messageThreadId,
    anchorMessageId: anchors[0]!.telegramMessageId,
  };
}

function exactJob(store: SqliteTelegramJobStore, target: TelegramCanonicalJobRef): TelegramJob {
  if (!Number.isSafeInteger(target.version) || target.version < 1) throw new Error("Invalid Telegram job version");
  const job = requireJob(store, target.jobId);
  if (job.version !== target.version) throw new Error("Telegram job version conflict");
  return job;
}

function assertRetryNewTurnLegal(
  job: TelegramJob,
  source: TelegramWorkSource,
  message = "Telegram retry is no longer legal",
): void {
  const legal = job.phase === "terminal"
    || (job.phase === "dispatching" && job.turnId === null)
    || (job.phase === "accepted" && !source.targetContext
      && source.targetProvision?.state === "in_flight");
  if (!legal) throw new Error(message);
}

function requireJob(store: SqliteTelegramJobStore, jobId: string): TelegramJob {
  const job = store.get(jobId);
  if (!job) throw new Error("Unknown Telegram job");
  return job;
}

function durableSource(store: SqliteTelegramJobStore, job: TelegramJob): TelegramWorkSource {
  const source = normalizeWorkSource(store.readSourcePayload(job.id));
  if (source.botId !== job.source.botId || source.updateId !== job.source.updateId) {
    throw new Error("Telegram job source mismatch");
  }
  return source;
}

function normalizeWorkSource(value: unknown): TelegramWorkSource {
  if (!record(value)) throw new Error("Malformed Telegram work source");
  const source = value as Partial<TelegramWorkSource>;
  normalizeControlSource(source as TelegramCanonicalControlSource);
  if (!new Set(["text", "voice", "audio", "photo", "document", "command", "confirmation", "retry"])
    .has(source.kind ?? "") || !(source.text === null || typeof source.text === "string")
    || !(source.attachment === null || record(source.attachment))
    || !(source.retryOfJobId === null || typeof source.retryOfJobId === "string")) {
    throw new Error("Malformed Telegram work source");
  }
  if (source.targetContext !== undefined) {
    const target = source.targetContext;
    if (!record(target) || !Number.isSafeInteger(target.chatId) || target.chatId === 0
      || !Number.isSafeInteger(target.messageThreadId) || (target.messageThreadId as number) < 1) {
      throw new Error("Malformed Telegram work source");
    }
    if (target.chatId !== source.chatId) throw new Error("Malformed Telegram work source");
  }
  if (source.targetProvision !== undefined) {
    const provision = source.targetProvision;
    if (!record(provision) || provision.kind !== "forum_topic"
      || typeof provision.topicName !== "string" || provision.topicName.length < 1
      || provision.topicName.length > 128
      || !new Set(["planned", "in_flight", "complete"]).has(provision.state)
      || Object.keys(provision).some((key) => !["kind", "topicName", "state"].includes(key))) {
      throw new Error("Malformed Telegram work source");
    }
    if ((provision.state === "complete") !== (source.targetContext !== undefined)) {
      throw new Error("Malformed Telegram work source");
    }
  }
  if (source.completion !== undefined) {
    const completion = source.completion;
    if (!record(completion) || completion.kind !== "inbox_ticket"
      || !Number.isSafeInteger(completion.ticketId) || (completion.ticketId as number) < 1
      || Object.keys(completion).some((key) => !["kind", "ticketId"].includes(key))) {
      throw new Error("Malformed Telegram work source");
    }
  }
  return structuredClone(source as TelegramWorkSource);
}

function retryTargetProvision(source: TelegramWorkSource): NonNullable<TelegramWorkSource["targetProvision"]> {
  const provision = source.targetProvision;
  if (!provision) throw new Error("Telegram target provision is unavailable");
  return {
    ...structuredClone(provision),
    state: source.targetContext ? "complete" : "planned",
  };
}

function requireCompletionProcessor(
  processor: TelegramCompletionProcessor | undefined,
): TelegramCompletionProcessor {
  if (!processor) throw new Error("Telegram completion processor is not configured");
  return processor;
}

function normalizeControlSource(value: TelegramCanonicalControlSource): TelegramCanonicalControlSource {
  const context = normalizeContext(value);
  if (!Number.isSafeInteger(value.updateId) || value.updateId < 0
    || !Number.isSafeInteger(value.messageId) || value.messageId < 1) {
    throw new Error("Invalid Telegram control source");
  }
  return { ...context, updateId: value.updateId, messageId: value.messageId };
}

function normalizeContext(value: TelegramCanonicalContext): TelegramCanonicalContext {
  if (typeof value.botId !== "string" || value.botId.length === 0 || value.botId.length > 128
    || !Number.isSafeInteger(value.chatId) || value.chatId === 0
    || !(value.messageThreadId === null
      || (Number.isSafeInteger(value.messageThreadId) && value.messageThreadId > 0))) {
    throw new Error("Invalid Telegram context");
  }
  return { botId: value.botId, chatId: value.chatId, messageThreadId: value.messageThreadId };
}

function sameContext(left: TelegramCanonicalContext, right: TelegramCanonicalContext): boolean {
  return left.botId === right.botId && left.chatId === right.chatId
    && left.messageThreadId === right.messageThreadId;
}

function sameJobContext(source: TelegramWorkSource, right: TelegramCanonicalContext): boolean {
  return sameContext(source, right) || (source.targetContext !== undefined && sameContext({
    botId: source.botId,
    chatId: source.targetContext.chatId,
    messageThreadId: source.targetContext.messageThreadId,
  }, right));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trackDeliveryAttemptJobs(
  store: SqliteTelegramJobStore,
  onAttempt: (jobId: string) => void,
): SqliteTelegramJobStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "transitionDeliveryAndProject") {
        return (input: Parameters<SqliteTelegramJobStore["transitionDeliveryAndProject"]>[0]) => {
          const result = target.transitionDeliveryAndProject(input);
          if (input.state === "sending") onAttempt(input.jobId);
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function boundedTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function assertRunning(disposed: boolean): void {
  if (disposed) throw new Error("Telegram reliability runtime is disposed");
}
