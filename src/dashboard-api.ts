import { topicUrl } from "./projects.js";
import type { StatusSnapshot, WaitingOn } from "./status-board.js";
import type { TelegramJobStatusProjection } from "./telegram-status-projection.js";
import { containsSecret } from "./topic-sync.js";

const MAX_LABEL_LENGTH = 160;

export type DashboardView = "active" | "recent" | "attention";
export type DashboardSessionState = "active" | "recent" | "waiting" | "stalled";

export interface DashboardQuery {
  readonly view: DashboardView;
  readonly offset: number;
  readonly limit: number;
}

export interface DashboardSession {
  readonly taskLinks?: readonly { label: string; url: string }[];
  readonly taskActions?: readonly { action: import("./topic-task-actions.js").TopicTaskAction; label: string }[];
  readonly id: string;
  readonly label: string;
  readonly workspace: string;
  readonly source?: string;
  readonly state: DashboardSessionState;
  readonly waitingOn?: WaitingOn;
  readonly timestamp: number;
  readonly telegramUrl?: string;
  readonly codexUrl: string;
  readonly canCreateTopic: boolean;
}

export interface DashboardPayload {
  readonly generatedAt: number;
  readonly counts: Record<DashboardView, number>;
  readonly page: DashboardQuery & { readonly total: number; readonly hasMore: boolean };
  readonly sessions: readonly DashboardSession[];
  readonly system: { readonly codexAvailable: boolean };
}

export interface DashboardSessionStatus {
  readonly threadId: string | null;
  readonly health: TelegramJobStatusProjection["health"];
  readonly attentionKind: TelegramJobStatusProjection["attention"]["kind"];
  readonly updatedAt: number;
}

export type DashboardConnectivity = "connected" | "unavailable";
export type DashboardGuardianMode = "observe" | "repair" | "unknown";
export type DashboardDeliveryHealth = "healthy" | "degraded" | "unavailable";

export interface DashboardCanonicalJobInput {
  readonly projection: TelegramJobStatusProjection;
  readonly events: readonly { readonly timestamp: number; readonly code: string }[];
}

/** Internal status input. Its raw jobs are classified server-side and never serialized. */
export interface DashboardReliabilitySnapshot {
  readonly jobs: readonly DashboardCanonicalJobInput[];
  readonly aggregates?: unknown;
  readonly appServer: {
    readonly connectivity: DashboardConnectivity;
    readonly reasonCode: string | null;
  };
  readonly guardian: {
    readonly connectivity: DashboardConnectivity;
    readonly mode: DashboardGuardianMode;
    readonly lastScanAt: number | null;
    readonly reasonCode: string | null;
  };
  readonly telegram: {
    readonly deliveryHealth: DashboardDeliveryHealth;
    readonly reasonCode: string | null;
  };
}

export function buildDashboardPayload(
  snapshot: StatusSnapshot,
  chatId: number,
  statuses: readonly DashboardSessionStatus[] = [],
  query: DashboardQuery = { view: "active", offset: 0, limit: 30 },
): DashboardPayload {
  const roots = new Map<string, DashboardSession>();
  const childToRoot = new Map<string, string>();
  const waitingRoots = new Map<string, WaitingOn>();

  for (const thread of snapshot.running) {
    if (!thread.threadId) continue;
    const rootId = thread.threadId;
    if (thread.waitingOn) waitingRoots.set(rootId, thread.waitingOn);
    for (const child of thread.children) {
      childToRoot.set(child.threadId, rootId);
      if (child.waitingOn && !waitingRoots.has(rootId)) waitingRoots.set(rootId, child.waitingOn);
    }
    roots.set(rootId, session({
      id: rootId,
      label: thread.label,
      workspace: thread.workspace,
      source: thread.source,
      state: "active",
      timestamp: thread.since,
      messageThreadId: thread.messageThreadId,
      chatId,
    }));
  }

  const recentIds = new Set<string>();
  for (const thread of snapshot.recentThreads) {
    if (roots.has(thread.threadId)) continue;
    recentIds.add(thread.threadId);
    roots.set(thread.threadId, session({
      id: thread.threadId,
      label: thread.label,
      workspace: thread.workspace,
      source: thread.source,
      state: "recent",
      timestamp: thread.updatedAt,
      messageThreadId: thread.messageThreadId,
      chatId,
    }));
  }

  const stalledRoots = new Set<string>();
  const requiredRoots = new Set<string>();
  const attentionUpdatedAt = new Map<string, number>();
  for (const status of statuses) {
    if (!status.threadId) continue;
    const rootId = childToRoot.get(status.threadId) ?? status.threadId;
    if (!roots.has(rootId)) continue;
    if (status.health === "stalled") stalledRoots.add(rootId);
    if (status.attentionKind === "required") requiredRoots.add(rootId);
    if (status.health === "stalled" || status.attentionKind === "required") {
      attentionUpdatedAt.set(
        rootId,
        Math.max(attentionUpdatedAt.get(rootId) ?? 0, status.updatedAt),
      );
    }
  }

  const active: DashboardSession[] = [];
  const recent: DashboardSession[] = [];
  const attention: DashboardSession[] = [];
  for (const [id, row] of roots) {
    const waitingOn = waitingRoots.get(id);
    if (stalledRoots.has(id)) {
      attention.push({
        ...row,
        state: "stalled",
        ...(waitingOn ? { waitingOn } : {}),
        timestamp: Math.max(row.timestamp, attentionUpdatedAt.get(id) ?? 0),
      });
    } else if (waitingOn || requiredRoots.has(id)) {
      attention.push({ ...row, state: "waiting", ...(waitingOn ? { waitingOn } : {}) });
    } else if (recentIds.has(id)) {
      recent.push(row);
    } else {
      active.push(row);
    }
  }

  active.sort(newestFirst);
  recent.sort(newestFirst);
  attention.sort((left, right) => stateRank(right.state) - stateRank(left.state)
    || newestFirst(left, right));
  const views = { active, recent, attention } satisfies Record<DashboardView, DashboardSession[]>;
  const selected = views[query.view];
  const end = Math.min(selected.length, query.offset + query.limit);

  return {
    generatedAt: snapshot.now,
    counts: {
      active: active.length,
      recent: recent.length,
      attention: attention.length,
    },
    page: {
      ...query,
      total: selected.length,
      hasMore: end < selected.length,
    },
    sessions: selected.slice(query.offset, end),
    system: { codexAvailable: snapshot.codexAvailable },
  };
}

function session(input: {
  id: string;
  label: string;
  workspace: string;
  source: string;
  state: DashboardSessionState;
  timestamp: number;
  messageThreadId?: number;
  chatId: number;
}): DashboardSession {
  const source = safeSource(input.source);
  return {
    id: input.id,
    label: safeLabel(input.label),
    workspace: safeWorkspace(input.workspace),
    ...(source ? { source } : {}),
    state: input.state,
    timestamp: input.timestamp,
    ...(input.messageThreadId === undefined
      ? {}
      : { telegramUrl: topicUrl(input.chatId, input.messageThreadId) }),
    codexUrl: `codex://threads/${input.id}`,
    canCreateTopic: input.messageThreadId === undefined,
  };
}

function newestFirst(left: DashboardSession, right: DashboardSession): number {
  return right.timestamp - left.timestamp || left.id.localeCompare(right.id);
}

function stateRank(state: DashboardSessionState): number {
  return state === "stalled" ? 2 : state === "waiting" ? 1 : 0;
}

function safeLabel(value: string): string {
  if (containsSecret(value)) return "(скрыто)";
  const normalized = value.replace(/\s+/gu, " ").trim() || "Без названия";
  return Array.from(normalized).slice(0, MAX_LABEL_LENGTH).join("");
}

function safeWorkspace(value: string): string {
  if (containsSecret(value)) return "Codex";
  const normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? "Codex";
}

function safeSource(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized === "?" || containsSecret(normalized)) return undefined;
  return Array.from(normalized).slice(0, 40).join("");
}
