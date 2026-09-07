import { escapeHTML } from "./format.js";
import type { GuardianAlert } from "./session-guardian-store.js";
import type {
  GuardianAlertState,
  GuardianFingerprint,
  GuardianRepairOutcome,
  GuardianRepairResult,
  GuardianRoute,
  GuardianThreadSnapshot,
} from "./session-guardian-types.js";

const MAX_TELEGRAM_TEXT_LENGTH = 4_000;
const MAX_TELEGRAM_CHAT_ID = 2 ** 52 - 1;
const MAX_TELEGRAM_INT32_ID = 2_147_483_647;
const ALERT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPAIR_OUTCOMES = new Set<GuardianRepairOutcome>([
  "restored", "self-recovered", "observation-only", "repair-disabled", "expired", "failed",
]);
const ALERT_STATES = new Set<GuardianAlertState>([
  "open", "checking", ...REPAIR_OUTCOMES,
]);
const DELIVERY_STATES = new Set(["pending", "failed", "delivered"]);
const STATUS_DELIVERY_STATES = new Set(["none", "pending", "failed", "delivered"]);
const SAFE_DETAILS = new Set([
  "Alert not found", "Alert already closed", "Thread progressed or became idle",
  "Observation-only mode", "Repair is disabled", "Fresh state check failed",
  "Repair already in progress", "Interrupt failed", "Wait for idle failed",
  "Cold reload failed", "Final verification failed", "Thread restored",
  "Thread is not eligible", "Thread is not actively stuck",
]);

export interface GuardianTelegramApi {
  sendMessage(chatId: number, text: string,
    options: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string,
    options: Record<string, unknown>): Promise<unknown>;
}
export interface GuardianTelegramAlertInput {
  readonly alert: GuardianAlert;
  readonly snapshot: GuardianThreadSnapshot;
  readonly staleForMs: number;
}
export interface GuardianTelegramDelivery {
  readonly alertId: string;
  readonly chatId: number;
  readonly messageThreadId?: number;
  readonly messageId: number;
}
export type GuardianTelegramStatus =
  | "checking"
  | "no-longer-eligible"
  | GuardianRepairResult;
export interface GuardianTelegramStatusInput {
  readonly alert: GuardianAlert;
  readonly delivery: GuardianTelegramDelivery;
  readonly status: GuardianTelegramStatus;
}

interface CheckedAlertInput {
  readonly alert: GuardianAlert;
  readonly snapshot: GuardianThreadSnapshot;
  readonly staleForMs: number;
}
interface CheckedStatusInput {
  readonly alert: GuardianAlert;
  readonly delivery: GuardianTelegramDelivery;
  readonly status: GuardianTelegramStatus;
}

export class SessionGuardianTelegramNotifier {
  constructor(private readonly api: GuardianTelegramApi) {
    if (!api || typeof api.sendMessage !== "function"
      || typeof api.editMessageText !== "function") {
      throw new Error("Guardian Telegram API is invalid");
    }
  }

  async sendAlert(input: GuardianTelegramAlertInput): Promise<GuardianTelegramDelivery> {
    const checked = readAlertInput(input);
    const { alert } = checked;
    const callbackData = `guardian_restore:${alert.id}`;
    if (Buffer.byteLength(callbackData, "utf8") > 64) {
      throw new Error("Guardian callback data exceeds the Telegram limit");
    }
    const options: Record<string, unknown> = {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Restore", callback_data: callbackData }]] },
      ...(alert.route.messageThreadId === undefined
        ? {} : { message_thread_id: alert.route.messageThreadId }),
    };
    const response = await this.api.sendMessage(
      alert.route.chatId,
      renderAlert(checked),
      options,
    );
    const messageId = response?.message_id;
    assertTelegramInt32Id(messageId, "Telegram message_id");
    return Object.freeze({
      alertId: alert.id,
      chatId: alert.route.chatId,
      ...(alert.route.messageThreadId === undefined
        ? {} : { messageThreadId: alert.route.messageThreadId }),
      messageId,
    });
  }

  async editStatus(input: GuardianTelegramStatusInput): Promise<void> {
    const checked = readStatusInput(input);
    try {
      await this.api.editMessageText(
        checked.delivery.chatId,
        checked.delivery.messageId,
        renderStatus(checked.alert, checked.status),
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: statusKeyboard(checked.alert, checked.status),
        },
      );
    } catch (error) {
      if (!isMessageNotModified(error)) throw error;
    }
  }
}

function statusKeyboard(alert: GuardianAlert, status: GuardianTelegramStatus) {
  const preserve = status === "checking" || ((alert.state === "open" || alert.state === "checking")
    && typeof status === "object"
    && (status.outcome === "observation-only" || status.outcome === "repair-disabled"));
  return preserve ? { inline_keyboard: [[{
    text: "Restore", callback_data: `guardian_restore:${alert.id}`,
  }]] } : { inline_keyboard: [] };
}

function renderAlert(input: CheckedAlertInput): string {
  const { alert, snapshot, staleForMs } = input;
  const lines = [
    "⚠️ <b>Codex session may be stalled</b>",
    field("Title", alert.threadName ?? "Untitled", 160),
    field("Thread", alert.fingerprint.threadId, 36, true),
    field("Source", sourceLabel(snapshot.source), 64),
    field("Working directory", snapshot.cwd, 300),
    field("Unchanged for", formatDuration(staleForMs), 48),
    field("Last item", snapshot.lastItemType ?? "none", 80),
  ];
  return boundedMessage(lines.join("\n"));
}

function renderStatus(alert: GuardianAlert, status: GuardianTelegramStatus): string {
  const descriptor = statusDescriptor(status);
  const lines = [
    "<b>Codex Guardian</b>",
    field("Title", alert.threadName ?? "Untitled", 160),
    field("Thread", alert.fingerprint.threadId, 36, true),
    field("Status", descriptor.label, 64),
  ];
  if (descriptor.detail) lines.push(field("Detail", descriptor.detail, 120));
  return boundedMessage(lines.join("\n"));
}

function statusDescriptor(status: GuardianTelegramStatus): { label: string; detail?: string } {
  if (status === "checking") return { label: "Checking" };
  if (status === "no-longer-eligible") return { label: "No longer eligible" };
  const label = {
    restored: "Restored",
    "self-recovered": "Self-recovered",
    "observation-only": "Observation only",
    "repair-disabled": "Repair disabled",
    expired: "No longer eligible",
    failed: "Failed",
  }[status.outcome];
  return {
    label,
    detail: SAFE_DETAILS.has(status.detail) ? status.detail : fallbackDetail(status.outcome),
  };
}

function fallbackDetail(outcome: GuardianRepairOutcome): string {
  if (outcome === "failed") return "Operational check failed";
  if (outcome === "expired") return "Alert no longer available";
  if (outcome === "repair-disabled") return "Repair is disabled";
  if (outcome === "observation-only") return "Observation-only mode";
  if (outcome === "self-recovered") return "Thread no longer appears stalled";
  return "Thread restored";
}

function sourceLabel(source: unknown): string {
  if (source === "cli" || source === "vscode" || source === "exec") return "cli";
  if (source === "appServer") return "app-server";
  if (!isRecord(source)) return "unknown";
  const subAgent = ownDataProperty(source, "subAgent");
  if (subAgent.present && subAgent.value !== null && subAgent.value !== undefined) return "subagent";
  const custom = ownDataProperty(source, "custom");
  return custom.present && custom.value === "telecodex" ? "telecodex" : "unknown";
}

function ownDataProperty(value: object, key: string): { present: boolean; value?: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? { present: true, value: descriptor.value }
      : { present: false };
  } catch {
    return { present: false };
  }
}

function field(label: string, value: string, maxCodePoints: number, code = false): string {
  const safe = escapeHTML(truncateCodePoints(value, maxCodePoints));
  return `<b>${label}:</b> ${code ? `<code>${safe}</code>` : safe}`;
}
function truncateCodePoints(value: string, maxCodePoints: number): string {
  const wellFormed = toWellFormed(value);
  const points = Array.from(wellFormed);
  if (points.length <= maxCodePoints) return wellFormed;
  return `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}
function toWellFormed(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      } else result += "�";
    } else result += code >= 0xDC00 && code <= 0xDFFF ? "�" : value[index]!;
  }
  return result;
}
function formatDuration(milliseconds: number): string {
  let remaining = Math.floor(milliseconds / 1_000);
  if (remaining === 0) return "0s";
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400, "d"], [3_600, "h"], [60, "m"], [1, "s"],
  ];
  const parts: string[] = [];
  for (const [seconds, suffix] of units) {
    const value = Math.floor(remaining / seconds);
    if (value > 0) {
      parts.push(`${value}${suffix}`);
      remaining %= seconds;
    }
  }
  return parts.join(" ");
}

function readAlertInput(value: unknown): CheckedAlertInput {
  if (!isRecord(value)) throw new Error("Guardian alert notification input is invalid");
  const alert = readAlert(value.alert);
  const snapshot = readSnapshot(value.snapshot);
  const staleForMs = value.staleForMs;
  if (!Number.isSafeInteger(staleForMs) || (staleForMs as number) < 0) {
    throw new Error("staleForMs must be a non-negative safe integer");
  }
  if (alert.state !== "open" || !["pending", "failed"].includes(alert.deliveryState)) {
    throw new Error("Guardian alert is not eligible for Telegram notification");
  }
  if (!fingerprintsEqual(alert.fingerprint, snapshot)) {
    throw new Error("Guardian alert and snapshot fingerprints must match");
  }
  return Object.freeze({ alert, snapshot, staleForMs: staleForMs as number });
}

function readStatusInput(value: unknown): CheckedStatusInput {
  if (!isRecord(value)) throw new Error("Guardian Telegram status input is invalid");
  const alert = readAlert(value.alert);
  const delivery = readDelivery(value.delivery);
  const status = readStatus(value.status);
  if (delivery.alertId !== alert.id) throw new Error("Guardian delivery does not match the alert");
  if (!routesEqual(delivery, alert.route)) {
    throw new Error("Guardian delivery route does not match the alert route");
  }
  if (alert.deliveryState !== "delivered" || alert.messageId !== delivery.messageId) {
    throw new Error("Guardian alert delivery state does not match the message");
  }
  assertStatusMatchesAlert(alert.state, status);
  if (typeof status === "object" && status.threadId !== undefined
    && status.threadId !== alert.fingerprint.threadId) {
    throw new Error("Guardian repair result thread does not match the alert");
  }
  return Object.freeze({ alert, delivery, status });
}

function readAlert(value: unknown): GuardianAlert {
  if (!isRecord(value)) throw new Error("Guardian alert is invalid");
  const id = value.id;
  if (typeof id !== "string" || !ALERT_ID_PATTERN.test(id)) {
    throw new Error("Guardian alert ID is invalid");
  }
  const fingerprint = readFingerprint(value.fingerprint, "alert");
  const route = readRoute(value.route, "Guardian Telegram");
  const state = value.state;
  if (typeof state !== "string" || !ALERT_STATES.has(state as GuardianAlertState)) {
    throw new Error("Guardian alert state is invalid");
  }
  const deliveryState = value.deliveryState;
  if (typeof deliveryState !== "string" || !DELIVERY_STATES.has(deliveryState)) {
    throw new Error("Guardian alert delivery state is invalid");
  }
  const messageId = value.messageId;
  if (messageId !== undefined) assertTelegramInt32Id(messageId, "Guardian alert messageId");
  if ((deliveryState === "delivered") !== (messageId !== undefined)) {
    throw new Error("Guardian alert delivery coordinates are inconsistent");
  }
  const statusDeliveryState = value.statusDeliveryState;
  if (typeof statusDeliveryState !== "string"
    || !STATUS_DELIVERY_STATES.has(statusDeliveryState)) {
    throw new Error("Guardian alert status delivery state is invalid");
  }
  const detail = value.detail;
  if (detail !== undefined && typeof detail !== "string") {
    throw new Error("Guardian alert detail is invalid");
  }
  const createdAt = value.createdAt;
  const threadName = value.threadName;
  if (threadName !== undefined && (typeof threadName !== "string"
    || threadName.length === 0 || threadName.trim() !== threadName
    || Array.from(threadName).length > 512)) {
    throw new Error("Guardian alert threadName is invalid");
  }
  assertNonNegativeNumber(createdAt, "alert createdAt");
  return Object.freeze({ id, fingerprint, route, state: state as GuardianAlertState,
    deliveryState: deliveryState as GuardianAlert["deliveryState"],
    statusDeliveryState: statusDeliveryState as GuardianAlert["statusDeliveryState"],
    ...(threadName === undefined ? {} : { threadName }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(detail === undefined ? {} : { detail }), createdAt });
}

function readFingerprint(value: unknown, name: string): Readonly<GuardianFingerprint> {
  if (!isRecord(value)) throw new Error(`Guardian ${name} fingerprint is invalid`);
  const threadId = value.threadId;
  const turnId = value.turnId;
  assertUuid(threadId, `${name} threadId`);
  assertUuid(turnId, `${name} turnId`);
  const updatedAt = value.updatedAt;
  assertNonNegativeNumber(updatedAt, `${name} updatedAt`);
  const itemCount = value.itemCount;
  if (!Number.isSafeInteger(itemCount) || (itemCount as number) < 0) {
    throw new Error(`Guardian ${name} itemCount is invalid`);
  }
  const lastItemType = value.lastItemType;
  if (lastItemType !== null && typeof lastItemType !== "string") {
    throw new Error(`Guardian ${name} lastItemType is invalid`);
  }
  return Object.freeze({ threadId, turnId, updatedAt, itemCount: itemCount as number, lastItemType });
}

function readSnapshot(value: unknown): GuardianThreadSnapshot {
  if (!isRecord(value)) throw new Error("Guardian thread snapshot is invalid");
  const fingerprint = readFingerprint(value, "snapshot");
  const threadStatus = value.threadStatus;
  const turnStatus = value.turnStatus;
  const root = value.root;
  if (root !== true || threadStatus !== "active" || turnStatus !== "inProgress") {
    throw new Error("Guardian thread snapshot is not eligible for an alert");
  }
  const cwd = value.cwd;
  const name = value.name;
  if (typeof cwd !== "string" || (name !== null && typeof name !== "string")) {
    throw new Error("Guardian snapshot display metadata is invalid");
  }
  const canAcceptDirectInput = value.canAcceptDirectInput;
  if (typeof canAcceptDirectInput !== "boolean") {
    throw new Error("Guardian snapshot input state is invalid");
  }
  return Object.freeze({ ...fingerprint, threadStatus, turnStatus, source: value.source,
    cwd, name, canAcceptDirectInput, root });
}

function readDelivery(value: unknown): GuardianTelegramDelivery {
  if (!isRecord(value)) throw new Error("Guardian Telegram delivery is invalid");
  const alertId = value.alertId;
  if (typeof alertId !== "string" || !ALERT_ID_PATTERN.test(alertId)) {
    throw new Error("Guardian Telegram delivery alert ID is invalid");
  }
  const route = readRoute(value, "Guardian Telegram delivery");
  const messageId = value.messageId;
  assertTelegramInt32Id(messageId, "Guardian Telegram delivery messageId");
  return Object.freeze({ alertId, ...route, messageId });
}

function readRoute(value: unknown, name: string): Readonly<GuardianRoute> {
  if (!isRecord(value)) throw new Error(`${name} route is invalid`);
  const chatId = value.chatId;
  if (!Number.isSafeInteger(chatId) || chatId === 0
    || Math.abs(chatId as number) > MAX_TELEGRAM_CHAT_ID) {
    throw new Error(`${name} chatId is invalid`);
  }
  const messageThreadId = value.messageThreadId;
  if (messageThreadId !== undefined) {
    assertTelegramInt32Id(messageThreadId, `${name} messageThreadId`);
  }
  return Object.freeze({ chatId: chatId as number,
    ...(messageThreadId === undefined ? {} : { messageThreadId }) });
}

function readStatus(value: unknown): GuardianTelegramStatus {
  if (value === "checking" || value === "no-longer-eligible") return value;
  if (!isRecord(value)) throw new Error("Guardian Telegram status is invalid");
  const outcome = value.outcome;
  const detail = value.detail;
  if (typeof outcome !== "string" || !REPAIR_OUTCOMES.has(outcome as GuardianRepairOutcome)
    || typeof detail !== "string") {
    throw new Error("Guardian Telegram status must be a structured repair result");
  }
  const threadId = value.threadId;
  if (threadId !== undefined) assertUuid(threadId, "repair result threadId");
  return Object.freeze({ outcome: outcome as GuardianRepairOutcome,
    ...(threadId === undefined ? {} : { threadId }), detail });
}

function assertStatusMatchesAlert(state: GuardianAlertState, status: GuardianTelegramStatus): void {
  if (status === "checking") {
    if (state !== "checking") throw new Error("Guardian checking status contradicts alert state");
    return;
  }
  if (status === "no-longer-eligible") {
    if (state !== "expired" && state !== "self-recovered") {
      throw new Error("Guardian ineligible status contradicts alert state");
    }
    return;
  }
  if (status.outcome === "observation-only" || status.outcome === "repair-disabled") {
    if (state === "open" || state === "checking" || state === status.outcome) return;
  } else if (state === status.outcome) return;
  throw new Error("Guardian repair result contradicts alert state");
}

function assertTelegramInt32Id(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0
    || (value as number) > MAX_TELEGRAM_INT32_ID) {
    throw new Error(`${name} must be a positive signed 32-bit integer`);
  }
}
function assertUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
}
function assertNonNegativeNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}
function fingerprintsEqual(fingerprint: GuardianFingerprint,
  snapshot: GuardianThreadSnapshot): boolean {
  return fingerprint.threadId === snapshot.threadId
    && fingerprint.turnId === snapshot.turnId
    && fingerprint.updatedAt === snapshot.updatedAt
    && fingerprint.itemCount === snapshot.itemCount
    && fingerprint.lastItemType === snapshot.lastItemType;
}
function routesEqual(delivery: GuardianTelegramDelivery, route: GuardianRoute): boolean {
  return delivery.chatId === route.chatId
    && delivery.messageThreadId === route.messageThreadId;
}
function isMessageNotModified(error: unknown): boolean {
  const candidates: string[] = [];
  if (error instanceof Error) {
    const message = ownDataProperty(error, "message");
    if (message.present && typeof message.value === "string") candidates.push(message.value);
  }
  if (isRecord(error)) {
    for (const key of ["description", "message"]) {
      const candidate = ownDataProperty(error, key);
      if (candidate.present && typeof candidate.value === "string") candidates.push(candidate.value);
    }
  }
  return candidates.some((candidate) => candidate.toLowerCase().includes("message is not modified"));
}
function boundedMessage(text: string): string {
  if (text.length > MAX_TELEGRAM_TEXT_LENGTH) {
    throw new Error("Guardian Telegram message exceeds the Telegram limit");
  }
  return text;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
