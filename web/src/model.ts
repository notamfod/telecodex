export type WaitingOn = "approval" | "input";
export type DashboardView = "active" | "recent" | "attention";
export type DashboardSessionState = "active" | "recent" | "waiting" | "stalled";
export type ThreadSwipeAction = "codex" | "telegram";
export type ThreadGestureAxis = "horizontal" | "vertical";

export interface DashboardQuery {
  view: DashboardView;
  offset: number;
  limit: number;
}

export interface DashboardSession {
  id: string;
  label: string;
  workspace: string;
  source?: string;
  state: DashboardSessionState;
  waitingOn?: WaitingOn;
  timestamp: number;
  telegramUrl?: string;
  codexUrl: string;
  canCreateTopic: boolean;
}

export interface DashboardPayload {
  generatedAt: number;
  counts: Record<DashboardView, number>;
  page: DashboardQuery & { total: number; hasMore: boolean };
  sessions: readonly DashboardSession[];
  system: { codexAvailable: boolean };
}

export interface ThreadSwipeResolution {
  action: ThreadSwipeAction | null;
  commit: boolean;
  offset: number;
}

export const THREAD_SWIPE_ACTION_WIDTH = 88;

const THREAD_SWIPE_INTENT_PX = 12;
const THREAD_SWIPE_REVEAL_PX = 48;
const THREAD_SWIPE_COMMIT_PX = 144;
const THREAD_SWIPE_COMMIT_RATIO = 0.45;

export function mergeDashboardPage(
  current: readonly DashboardSession[],
  incoming: readonly DashboardSession[],
): DashboardSession[] {
  const byId = new Map(incoming.map((row) => [row.id, row]));
  const merged = current.map((row) => byId.get(row.id) ?? row);
  const seen = new Set(current.map((row) => row.id));
  for (const row of incoming) {
    if (!seen.has(row.id)) merged.push(row);
  }
  return merged;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "сейчас";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return `${Math.floor(hours / 24)} д`;
}

export function dashboardPollInterval(view: DashboardView): number {
  return view === "recent" ? 15_000 : 5_000;
}

export function threadSwipeIntent(
  deltaX: number,
  deltaY: number,
  canOpenCodex: boolean,
  canOpenTelegram: boolean,
): ThreadSwipeAction | null {
  if (Math.abs(deltaX) < THREAD_SWIPE_INTENT_PX || Math.abs(deltaX) <= Math.abs(deltaY)) {
    return null;
  }
  if (deltaX > 0) return canOpenCodex ? "codex" : null;
  return canOpenTelegram ? "telegram" : null;
}

export function threadGestureAxis(deltaX: number, deltaY: number): ThreadGestureAxis | null {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (Math.max(horizontalDistance, verticalDistance) < THREAD_SWIPE_INTENT_PX) return null;
  return horizontalDistance > verticalDistance ? "horizontal" : "vertical";
}

export function settleThreadSwipe(
  offset: number,
  width: number,
  canOpenCodex: boolean,
  canOpenTelegram: boolean,
): ThreadSwipeResolution {
  const action = offset > 0
    ? (canOpenCodex ? "codex" : null)
    : (offset < 0 && canOpenTelegram ? "telegram" : null);
  if (!action || Math.abs(offset) < THREAD_SWIPE_REVEAL_PX) {
    return { action: null, commit: false, offset: 0 };
  }
  const commit = Math.abs(offset) >= Math.max(
    THREAD_SWIPE_COMMIT_PX,
    width * THREAD_SWIPE_COMMIT_RATIO,
  );
  return {
    action,
    commit,
    offset: commit ? 0 : (action === "codex" ? THREAD_SWIPE_ACTION_WIDTH : -THREAD_SWIPE_ACTION_WIDTH),
  };
}
