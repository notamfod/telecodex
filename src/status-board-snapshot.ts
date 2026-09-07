import type {
  TelegramJobStatusProjection,
  TelegramStatusActionKind,
} from "./telegram-status-projection.js";

const RECENT_WINDOW_MS = 30 * 60_000;
const MAX_RECENT = 3;
const THREAD_HISTORY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_RECENT_THREADS = 6;

export type WaitingOn = "approval" | "input";

export interface HostThreadView {
  id: string;
  label: string;
  workspace: string;
  source: string;
  active: boolean;
  waitingOn?: WaitingOn;
  parentThreadId?: string;
  agentNickname?: string;
  since: number;
  messageThreadId?: number;
}

export interface RunningChild {
  threadId: string;
  label: string;
  since: number;
  waitingOn?: WaitingOn;
}

export interface RunningTask {
  threadId?: string;
  label: string;
  workspace: string;
  source: string;
  since: number;
  waitingOn?: WaitingOn;
  messageThreadId?: number;
  children: RunningChild[];
}

export interface StatusRow {
  label: string;
  workspace: string;
  messageThreadId?: number;
  since: number;
}

export interface RecentRow {
  label: string;
  workspace: string;
  messageThreadId?: number;
  finishedAt: number;
  ok: boolean;
}

export interface RecentThreadView {
  threadId: string;
  label: string;
  workspace: string;
  source: string;
  updatedAt: number;
  messageThreadId?: number;
}

export interface ProjectedStatusJobView {
  readonly projection: TelegramJobStatusProjection;
  readonly label: string;
  readonly workspace: string;
  readonly messageThreadId?: number;
  /** Each token durably resolves to the exact action DTO, including alertId or partKey. */
  readonly actionResolverTokens?: Readonly<Partial<Record<TelegramStatusActionKind, string>>>;
}

export interface StatusSnapshot {
  limit: number;
  telegramActive: number;
  running: RunningTask[];
  queued: StatusRow[];
  recent: RecentRow[];
  recentThreads: RecentThreadView[];
  recentThreadCount: number;
  codexAvailable: boolean;
  failedJobs24h: number;
  now: number;
  /** Canonical DTOs are preserved by identity for Telegram, /status and Dashboard adapters. */
  jobs?: readonly ProjectedStatusJobView[];
}

export function groupRunningThreads(threads: HostThreadView[]): RunningTask[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rootOf = (thread: HostThreadView): HostThreadView | undefined => {
    const visited = new Set<string>();
    let current = thread;
    while (current.parentThreadId !== undefined) {
      if (visited.has(current.id)) return undefined;
      visited.add(current.id);
      const parent = byId.get(current.parentThreadId);
      if (!parent) return undefined;
      current = parent;
    }
    return current;
  };
  const descendantsOf = new Map<string, HostThreadView[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === undefined || !thread.active) continue;
    const root = rootOf(thread);
    if (!root) continue;
    const descendants = descendantsOf.get(root.id) ?? [];
    descendants.push(thread);
    descendantsOf.set(root.id, descendants);
  }
  return threads
    .filter((thread) => thread.parentThreadId === undefined)
    .map((root) => ({ root, children: descendantsOf.get(root.id) ?? [] }))
    .filter(({ root, children }) => root.active || children.length > 0)
    .sort((left, right) => left.root.since - right.root.since)
    .map(({ root, children }) => ({
      threadId: root.id, label: root.label, workspace: root.workspace, source: root.source,
      since: root.since, waitingOn: root.waitingOn, messageThreadId: root.messageThreadId,
      children: children.sort((left, right) => left.since - right.since).map((child) => ({
        threadId: child.id,
        label: child.agentNickname ? `${child.agentNickname} · ${child.label}` : child.label,
        since: child.since, waitingOn: child.waitingOn,
      })),
    }));
}

export type StatusJobState = "awaiting-model" | "waiting" | "active" | "delivering"
  | "completed" | "failed" | "aborted";

export interface StatusJobView {
  state: StatusJobState;
  label: string;
  workspace: string;
  messageThreadId?: number;
  createdAt: number;
  updatedAt: number;
  projection?: TelegramJobStatusProjection;
  /** Resolver tokens must bind the full action DTO, including alertId or partKey. */
  actionResolverTokens?: Readonly<Partial<Record<TelegramStatusActionKind, string>>>;
}

export function buildStatusSnapshot(
  jobs: StatusJobView[],
  hostThreads: HostThreadView[],
  options: {
    limit: number; now: number; recentWindowMs?: number; maxRecent?: number;
    recentThreads?: RecentThreadView[]; maxRecentThreads?: number; codexAvailable?: boolean;
  },
): StatusSnapshot {
  const recentWindowMs = options.recentWindowMs ?? RECENT_WINDOW_MS;
  const maxRecent = options.maxRecent ?? MAX_RECENT;
  const running = groupRunningThreads(hostThreads);
  const runningThreadIds = new Set(running.map((thread) => thread.threadId).filter(Boolean));
  const recentThreads = (options.recentThreads ?? [])
    .filter((thread) => options.now - thread.updatedAt <= THREAD_HISTORY_WINDOW_MS)
    .filter((thread) => !runningThreadIds.has(thread.threadId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const projected = jobs
    .filter((job) => job.projection !== undefined && !isSettledTerminal(job.projection))
    .map((job) => ({ projection: job.projection!, label: job.label, workspace: job.workspace,
      ...(job.actionResolverTokens === undefined ? {} : { actionResolverTokens: job.actionResolverTokens }),
      ...(job.messageThreadId === undefined ? {} : { messageThreadId: job.messageThreadId }) }));
  const legacyJobs = jobs.filter((job) => job.projection === undefined);
  const queuedJobs = [
    ...jobs.filter((job) => job.projection?.phase === "queued"),
    ...legacyJobs.filter((job) => job.state === "waiting" || job.state === "awaiting-model"),
  ].sort((left, right) => left.createdAt - right.createdAt);
  const settledProjected = jobs.filter((job) => job.projection !== undefined
    && isSettledTerminal(job.projection));
  return {
    limit: options.limit,
    telegramActive: legacyJobs.filter((job) => job.state === "active" || job.state === "delivering").length
      + projected.filter((job) => job.projection.phase === "running"
        || job.projection.phase === "delivering").length,
    running,
    queued: queuedJobs.map((job) => ({ label: job.label, workspace: job.workspace,
      messageThreadId: job.messageThreadId, since: job.createdAt })),
    recent: [...legacyJobs.filter((job) => isFinished(job.state)), ...settledProjected]
      .filter((job) => options.now - job.updatedAt <= recentWindowMs)
      .sort((left, right) => right.updatedAt - left.updatedAt).slice(0, maxRecent)
      .map((job) => ({ label: job.label, workspace: job.workspace,
        messageThreadId: job.messageThreadId, finishedAt: job.updatedAt,
        ok: job.projection?.isDone ?? job.state === "completed" })),
    recentThreads: recentThreads.slice(0, options.maxRecentThreads ?? MAX_RECENT_THREADS),
    recentThreadCount: recentThreads.length,
    codexAvailable: options.codexAvailable ?? true,
    failedJobs24h: jobs.filter((job) => job.state === "failed"
      && options.now - job.updatedAt <= THREAD_HISTORY_WINDOW_MS).length,
    now: options.now,
    jobs: projected,
  };
}

function isFinished(state: StatusJobState): boolean {
  return state === "completed" || state === "failed" || state === "aborted";
}

function isSettledTerminal(projection: TelegramJobStatusProjection): boolean {
  return projection.phase === "terminal" && projection.delivery.complete;
}
