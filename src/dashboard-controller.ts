import type { DashboardTask } from "./dashboard-task-model.js";
import type { TopicTaskAction } from "./topic-task-actions.js";
import type { CodexThreadRecord } from "./codex-state.js";
import {
  buildDashboardPayload,
  type DashboardPayload,
  type DashboardQuery,
  type DashboardReliabilitySnapshot,
  type DashboardSessionStatus,
} from "./dashboard-api.js";
import type { EnsuredThreadTopic } from "./projects.js";
import type { StatusSnapshot } from "./status-board.js";
import type { TelegramStatusAction } from "./telegram-status-projection.js";

export interface DashboardController {
  readonly boardChatId?: number;
  loadDashboard(query?: DashboardQuery): Promise<DashboardPayload>;
  ensureTopic(threadId: string): Promise<{ created: boolean; url: string }>;
  runTaskAction?(action: TopicTaskAction): Promise<void>;
  runJobAction(action: TelegramStatusAction): Promise<void>;
}

export interface DashboardControllerOptions {
  loadTasks?(): Promise<readonly DashboardTask[]>;
  taskRowLinks?(task: DashboardTask): Promise<{ label: string; url: string }[]>;
  taskRowActions?(task: DashboardTask): Promise<{ action: TopicTaskAction; label: string }[]>;
  taskLinks?(threadId: string): Promise<{ label: string; url: string }[]>;
  taskActions?(threadId: string): Promise<{ action: TopicTaskAction; label: string }[]>;
  runTaskAction?(action: TopicTaskAction): Promise<void>;
  chatId: number;
  collect(): Promise<StatusSnapshot>;
  loadSessionStatuses?(): Promise<readonly DashboardSessionStatus[]>;
  loadReliability?(): Promise<DashboardReliabilitySnapshot>;
  loadReliabilityForAction?(): Promise<DashboardReliabilitySnapshot>;
  runJobAction?(action: TelegramStatusAction): Promise<void>;
  getThread(threadId: string): CodexThreadRecord | null | undefined;
  ensureThreadTopic(thread: CodexThreadRecord): Promise<EnsuredThreadTopic>;
}

export function createSharedAsyncLoader<T>(
  load: () => Promise<T>,
  options: { readonly now?: () => number; readonly ttlMs?: number } = {},
): () => Promise<T> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 250;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error("Invalid async loader TTL");
  let cached: { readonly value: T; readonly expiresAt: number } | undefined;
  let inFlight: Promise<T> | undefined;
  return () => {
    const currentTime = now();
    if (cached && currentTime <= cached.expiresAt) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const value = await load();
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}

export function createDashboardSnapshotCollector(
  collect: (options: {
    maxRecentThreads?: number;
    includeCanonicalReliability?: boolean;
    refreshHostThreads?: boolean;
  }) => Promise<StatusSnapshot>,
): () => Promise<StatusSnapshot> {
  return () => collect({
    maxRecentThreads: Number.MAX_SAFE_INTEGER,
    includeCanonicalReliability: false,
    refreshHostThreads: false,
  });
}

export function createDashboardController(
  options: DashboardControllerOptions,
): DashboardController {
  return {
    boardChatId: options.chatId,
    ...(options.runTaskAction ? { runTaskAction: options.runTaskAction } : {}),
    loadDashboard: async (query = { view: "active", offset: 0, limit: 30 }) => {
      const [snapshot, statuses, tasks] = await Promise.all([
        options.collect(),
        options.loadSessionStatuses?.() ?? [],
        options.loadTasks?.() ?? [],
      ]);
      const payload = buildDashboardPayload(snapshot, options.chatId, statuses, query, tasks);
      const byId = new Map(tasks.map(task => [`task:${task.taskId}`, task]));
      return { ...payload, sessions: await Promise.all(payload.sessions.map(async session => {
        const task = byId.get(session.id);
        const taskLinks = task ? await options.taskRowLinks?.(task)
          : session.threadId ? await options.taskLinks?.(session.threadId) : undefined;
        const taskActions = task ? await options.taskRowActions?.(task)
          : session.threadId ? await options.taskActions?.(session.threadId) : undefined;
        return { ...session, ...(taskLinks ? { taskLinks } : {}), ...(taskActions ? { taskActions } : {}) };
      })) };

    },
    ensureTopic: async (threadId) => {
      const thread = options.getThread(threadId);
      if (!thread) throw new Error("Thread is not available on this device");
      const result = await options.ensureThreadTopic(thread);
      return { created: result.created, url: result.url };
    },
    runJobAction: async (action) => {
      if (!options.runJobAction || !options.loadReliability) {
        throw unavailable("Dashboard job actions are unavailable");
      }
      const snapshot = await (options.loadReliabilityForAction ?? options.loadReliability)();
      const projection = snapshot.jobs.find(({ projection: candidate }) =>
        candidate.jobId === action.jobId)?.projection;
      if (!projection?.actions.some((candidate) => sameAction(candidate, action))) {
        throw unavailable("Dashboard action is no longer legal");
      }
      await options.runJobAction(action);
    },
  };
}

function sameAction(left: TelegramStatusAction, right: TelegramStatusAction): boolean {
  return left.kind === right.kind && left.jobId === right.jobId
    && left.expectedVersion === right.expectedVersion
    && (left.alertId ?? null) === (right.alertId ?? null)
    && (left.partKey ?? null) === (right.partKey ?? null);
}

function unavailable(message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 503;
  return error;
}
