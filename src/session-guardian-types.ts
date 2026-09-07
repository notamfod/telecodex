export interface GuardianThreadSnapshot {
  threadId: string;
  turnId: string | null;
  threadStatus: "active" | "idle" | "notLoaded" | "systemError";
  turnStatus: string | null;
  updatedAt: number;
  itemCount: number;
  lastItemType: string | null;
  source: unknown;
  cwd: string;
  name: string | null;
  canAcceptDirectInput: boolean;
  root: boolean;
}

export interface GuardianFingerprint {
  threadId: string;
  turnId: string;
  updatedAt: number;
  itemCount: number;
  lastItemType: string | null;
}

export interface GuardianRoute {
  chatId: number;
  messageThreadId?: number;
}

export type GuardianRepairOutcome =
  | "restored"
  | "self-recovered"
  | "observation-only"
  | "repair-disabled"
  | "expired"
  | "failed";

export type GuardianAlertState = "open" | "checking" | GuardianRepairOutcome;

export interface GuardianRepairResult {
  readonly outcome: GuardianRepairOutcome;
  readonly threadId?: string;
  readonly detail: string;
}

export function fingerprintOf(
  snapshot: GuardianThreadSnapshot,
): GuardianFingerprint | null {
  if (
    snapshot.threadStatus !== "active"
    || snapshot.turnStatus !== "inProgress"
    || !snapshot.turnId
  ) {
    return null;
  }

  return {
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    updatedAt: snapshot.updatedAt,
    itemCount: snapshot.itemCount,
    lastItemType: snapshot.lastItemType,
  };
}
