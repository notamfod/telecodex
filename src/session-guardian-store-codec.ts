import type {
  GuardianAlertState,
  GuardianFingerprint,
  GuardianRepairOutcome,
  GuardianRoute,
  GuardianThreadSnapshot,
} from "./session-guardian-types.js";

const ALERT_STATES: readonly GuardianAlertState[] = ["open", "checking", "restored",
  "self-recovered", "observation-only", "repair-disabled", "expired", "failed"];
const REPAIR_OUTCOMES: readonly GuardianRepairOutcome[] = ["restored", "self-recovered",
  "observation-only", "repair-disabled", "expired", "failed"];
const TERMINAL_ALERT_STATES = new Set<GuardianAlertState>(REPAIR_OUTCOMES);
const DELIVERY_STATES = ["pending", "failed", "delivered"] as const;
const STATUS_DELIVERY_STATES = ["none", "pending", "failed", "delivered"] as const;
const MAX_TELEGRAM_CHAT_ID = 2 ** 52 - 1;
const MAX_TELEGRAM_INT32_ID = 2_147_483_647;
const MAX_THREAD_NAME_CODE_POINTS = 512;

export type GuardianDeliveryState = typeof DELIVERY_STATES[number];
export type GuardianStatusDeliveryState = typeof STATUS_DELIVERY_STATES[number];
export interface GuardianObservation {
  readonly fingerprint: Readonly<GuardianFingerprint>;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly unchangedCount: number;
}
export interface GuardianAlert {
  readonly id: string;
  readonly fingerprint: Readonly<GuardianFingerprint>;
  readonly route: Readonly<GuardianRoute>;
  readonly state: GuardianAlertState;
  readonly deliveryState: GuardianDeliveryState;
  readonly statusDeliveryState: GuardianStatusDeliveryState;
  readonly threadName?: string;
  readonly messageId?: number;
  readonly detail?: string;
  readonly createdAt: number;
}
export interface GuardianAlertCreation { readonly alert: GuardianAlert; readonly created: boolean; }
export interface GuardianSelfRecoveryClosure { readonly alert: GuardianAlert; readonly closed: boolean; }

export function observationFromRow(value: unknown): GuardianObservation {
  const row = requireRow(value, "observation");
  const fingerprint = fingerprintFromRow(row, "observation");
  const firstObservedAt = rowNumber(row, "first_observed_at", "observation", isTimestamp);
  const lastObservedAt = rowNumber(row, "last_observed_at", "observation", isTimestamp);
  const unchangedCount = rowNumber(row, "unchanged_count", "observation", isPositiveInteger);
  if (firstObservedAt > lastObservedAt) invalidRow("observation", "observation range");
  return Object.freeze({ fingerprint, firstObservedAt, lastObservedAt, unchangedCount });
}

export function alertFromRow(value: unknown): GuardianAlert {
  const row = requireRow(value, "alert");
  const id = rowString(row, "id", "alert");
  if (!isToken(id)) invalidRow("alert", "id");
  const routeChatId = rowNumber(row, "route_chat_id", "alert", isTelegramChatId);
  const messageThreadId = row.route_message_thread_id === null ? undefined
    : rowNumber(row, "route_message_thread_id", "alert", isTelegramInt32Id);
  const detail = row.detail === null ? undefined : rowString(row, "detail", "alert", true);
  const threadName = row.thread_name === null ? undefined
    : rowString(row, "thread_name", "alert");
  if (threadName !== undefined && !isNormalizedThreadName(threadName)) {
    invalidRow("alert", "thread_name");
  }
  const deliveryState = decodeDeliveryState(row.delivery_state);
  const statusDeliveryState = decodeStatusDeliveryState(row.status_delivery_state);
  const messageId = row.delivery_message_id === null ? undefined
    : rowNumber(row, "delivery_message_id", "alert", isTelegramInt32Id);
  if ((deliveryState === "delivered") !== (messageId !== undefined)) {
    invalidRow("alert", "delivery_message_id");
  }
  const state = decodeAlertState(row.state, "state");
  if (statusDeliveryState !== "none"
    && (deliveryState !== "delivered" || !isTerminalAlertState(state))) {
    invalidRow("alert", "status_delivery_state");
  }
  if (statusDeliveryState === "none" && deliveryState === "delivered"
    && isTerminalAlertState(state)) invalidRow("alert", "status_delivery_state");
  const route = Object.freeze({ chatId: routeChatId, ...(messageThreadId ? { messageThreadId } : {}) });
  return Object.freeze({ id, fingerprint: fingerprintFromRow(row, "alert"), route, state,
    deliveryState, statusDeliveryState,
    ...(threadName === undefined ? {} : { threadName }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(detail === undefined ? {} : { detail }),
    createdAt: rowNumber(row, "created_at", "alert", isTimestamp) });
}

export function decodeRepairAttempt(value: unknown): {
  claimToken: string; startedAt: number; finishedAt: number | null;
} {
  const row = requireRow(value, "repair attempt");
  const claimToken = rowString(row, "claim_token", "repair attempt");
  if (!isToken(claimToken)) invalidRow("repair attempt", "claim_token");
  const startedAt = rowNumber(row, "started_at", "repair attempt", isTimestamp);
  const finishedAt = row.finished_at === null ? null
    : rowNumber(row, "finished_at", "repair attempt", isTimestamp);
  return { claimToken, startedAt, finishedAt };
}

function fingerprintFromRow(row: Record<string, unknown>, kind: string): Readonly<GuardianFingerprint> {
  const lastItemType = row.last_item_type === null ? null : rowString(row, "last_item_type", kind);
  return Object.freeze({ threadId: rowString(row, "thread_id", kind),
    turnId: rowString(row, "turn_id", kind),
    updatedAt: rowNumber(row, "fingerprint_updated_at", kind, isTimestamp),
    itemCount: rowNumber(row, "item_count", kind, isNonNegativeInteger), lastItemType });
}

export function assertSnapshotMatchesFingerprint(snapshot: GuardianThreadSnapshot,
  fingerprint: GuardianFingerprint): void {
  if (snapshot.threadId !== fingerprint.threadId || snapshot.turnId !== fingerprint.turnId
    || snapshot.updatedAt !== fingerprint.updatedAt || snapshot.itemCount !== fingerprint.itemCount
    || snapshot.lastItemType !== fingerprint.lastItemType) {
    throw new Error("Guardian snapshot does not match fingerprint");
  }
}
export function assertFingerprint(value: GuardianFingerprint): void {
  assertNonEmptyString(value.threadId, "fingerprint.threadId");
  assertNonEmptyString(value.turnId, "fingerprint.turnId");
  assertTimestamp(value.updatedAt, "fingerprint.updatedAt");
  if (!isNonNegativeInteger(value.itemCount)) {
    throw new Error("fingerprint.itemCount must be a non-negative safe integer");
  }
  if (value.lastItemType !== null) assertNonEmptyString(value.lastItemType, "fingerprint.lastItemType");
}
export function assertRoute(route: GuardianRoute): void {
  if (!Number.isSafeInteger(route.chatId) || route.chatId === 0
    || Math.abs(route.chatId) > MAX_TELEGRAM_CHAT_ID) {
    throw new Error("route.chatId must be a non-zero 52-bit integer");
  }
  if (route.messageThreadId !== undefined && !isTelegramInt32Id(route.messageThreadId)) {
    throw new Error("route.messageThreadId must be a positive signed 32-bit integer");
  }
}
export function assertTelegramMessageId(value: number): void {
  if (!isTelegramInt32Id(value)) {
    throw new Error("messageId must be a positive signed 32-bit integer");
  }
}
export function assertAlertState(value: unknown): asserts value is GuardianAlertState {
  if (!ALERT_STATES.includes(value as GuardianAlertState)) throw new Error("Invalid guardian alert state");
}
export function assertRepairOutcome(value: unknown): asserts value is GuardianRepairOutcome {
  if (!REPAIR_OUTCOMES.includes(value as GuardianRepairOutcome)) {
    throw new Error("Invalid guardian repair outcome");
  }
}
export function decodeAlertState(value: unknown, field: string): GuardianAlertState {
  if (!ALERT_STATES.includes(value as GuardianAlertState)) invalidRow("alert", field);
  return value as GuardianAlertState;
}
export function isAllowedTransition(from: GuardianAlertState, to: GuardianAlertState): boolean {
  if (TERMINAL_ALERT_STATES.has(from)) return false;
  if (from === "checking" && to === "open") return false;
  return true;
}
export function isTerminalAlertState(state: GuardianAlertState): boolean {
  return TERMINAL_ALERT_STATES.has(state);
}
export function assertTimestamp(value: number, name: string): void {
  if (!isTimestamp(value)) throw new Error(`${name} must be a non-negative finite number`);
}
export function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
}
export function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`${name} must be a string`);
}
export function assertOptionalThreadName(value: unknown): asserts value is string | null | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !isNormalizedThreadName(value)) {
    throw new Error("threadName must be a non-empty normalized string of at most 512 code points");
  }
}
export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (!isNonEmptyString(value)) throw new Error(`${name} must be a non-empty string`);
}
function decodeDeliveryState(value: unknown): GuardianDeliveryState {
  if (typeof value !== "string" || !DELIVERY_STATES.includes(value as GuardianDeliveryState)) {
    invalidRow("alert", "delivery_state");
  }
  return value as GuardianDeliveryState;
}
function decodeStatusDeliveryState(value: unknown): GuardianStatusDeliveryState {
  if (typeof value !== "string"
    || !STATUS_DELIVERY_STATES.includes(value as GuardianStatusDeliveryState)) {
    invalidRow("alert", "status_delivery_state");
  }
  return value as GuardianStatusDeliveryState;
}
function requireRow(value: unknown, kind: string): Record<string, unknown> {
  if (!isRecord(value)) invalidRow(kind, "missing row");
  return value;
}
function rowString(row: Record<string, unknown>, key: string,
  kind: string, allowEmpty = false): string {
  const value = row[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) invalidRow(kind, key);
  return value;
}
function rowNumber(row: Record<string, unknown>, key: string,
  kind: string, predicate: (value: number) => boolean): number {
  const value = row[key];
  if (typeof value !== "number" || !predicate(value)) invalidRow(kind, key);
  return value;
}
function invalidRow(kind: string, field: string): never {
  throw new Error(`Invalid guardian ${kind} row: ${field}`);
}
function isToken(value: string): boolean { return /^[A-Za-z0-9_-]{22}$/.test(value); }
function isTimestamp(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function isNonNegativeInteger(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function isPositiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function isTelegramChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0 && Math.abs(value) <= MAX_TELEGRAM_CHAT_ID;
}
function isTelegramInt32Id(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TELEGRAM_INT32_ID;
}
function isNormalizedThreadName(value: string): boolean {
  return value.length > 0 && value.trim() === value
    && Array.from(value).length <= MAX_THREAD_NAME_CODE_POINTS;
}
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
