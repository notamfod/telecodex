import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type { DeliveryPart } from "./telegram-delivery-ledger.js";
import type { TelegramTopicResumeDeliveryFence } from "./telegram-topic-resume-delivery-guard.js";
import type { TelegramTopicResumeExternalEligibilitySnapshot } from "./telegram-topic-resume-ledger.js";
import type { TransitionEvent } from "./telegram-job-ledger.js";
import type {
  DeliveryReplanReasonCode,
  TelegramDeliveryPart,
  TelegramJob,
  TelegramResponsePlanPart,
} from "./telegram-job-types.js";
import { TELEGRAM_RESPONSE_PLAN_MAX_PARTS } from "./telegram-job-types.js";
import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
  type TelegramFallbackPart,
  type TelegramLegacyDeliveryPayload,
} from "./telegram-response-plan.js";

const JOB_ID_MAX_LENGTH = 128;
const EVENT_ID_MAX_LENGTH = 128;
const PART_KEY_MAX_LENGTH = 256;
const DELIVERY_TEXT_MAX_LENGTH = 128;
const REPLAN_REASONS: readonly DeliveryReplanReasonCode[] = [
  "rich_format_rejected", "rich_method_unavailable", "rich_local_fallback",
];

export interface ReplanRichDeliveryInput {
  readonly topicResumeReplan?: {
    readonly external: TelegramTopicResumeExternalEligibilitySnapshot;
    readonly quarantined: boolean;
    readonly fence?: TelegramTopicResumeDeliveryFence;
  };
  readonly jobId: string;
  readonly partKey: string;
  readonly expectedJobVersion: number;
  readonly expectedState: "pending" | "sending";
  readonly expectedAttemptCount: number;
  readonly expectedContentHash: string;
  readonly eventId: string;
  readonly eventAt: number;
  readonly reasonCode: DeliveryReplanReasonCode;
}

export interface ReplanRichDeliveryResult {
  readonly job: TelegramJob;
  readonly deliveries: readonly DeliveryPart[];
}

interface ReplanHost {
  readonly database: Database.Database;
  readonly statement: (sql: string) => Database.Statement;
  readonly getJob: (jobId: string) => TelegramJob | null;
  readonly applyReplanTransition: (input: {
    readonly jobId: string;
    readonly eventId: string;
    readonly expectedVersion: number;
    readonly event: TransitionEvent;
  }) => TelegramJob;
}

interface NormalizedDelivery extends DeliveryPart {
  readonly payload: TelegramDeliveryPayload;
}

export class TelegramDeliveryReplan {
  constructor(private readonly host: ReplanHost) {}

  replace(input: ReplanRichDeliveryInput): ReplanRichDeliveryResult {
    validateInput(input);
    return this.host.database.transaction(() => {
      const job = this.host.getJob(input.jobId);
      if (!job || job.version !== input.expectedJobVersion || job.phase !== "delivering"
        || job.responsePlan === undefined) conflict("Telegram job version conflict");
      if (job.responsePlan.length > TELEGRAM_RESPONSE_PLAN_MAX_PARTS) conflict("Telegram response plan conflict");
      if (input.eventAt < job.updatedAt) conflict("Telegram delivery cannot move backwards");
      const rows = this.readRows(input.jobId);
      let current: NormalizedDelivery | undefined;
      for (const row of rows) {
        if (row.partKey !== input.partKey) continue;
        if (current) conflict("Telegram delivery conflict");
        current = row;
      }
      if (!current) conflict("Telegram delivery conflict");
      if ((current.state !== "pending" && current.state !== "sending") || current.state !== input.expectedState
        || current.attemptCount !== input.expectedAttemptCount
        || current.contentHash !== input.expectedContentHash) conflict("Telegram delivery conflict");
      if (input.eventAt < current.updatedAt) conflict("Telegram delivery cannot move backwards");
      if (hashTelegramDeliveryPayload(current.payload) !== current.contentHash) malformed();

      const projected = input.partKey === "status-anchor"
        ? this.replaceAnchor(input, job, rows, current)
        : this.replaceOrdinary(input, job, rows, current);
      const event: TransitionEvent = {
        schemaVersion: 1,
        type: "delivery.replanned",
        phase: "delivering",
        eventAt: input.eventAt,
        reasonCode: input.reasonCode,
        responsePlan: projected.responsePlan,
        deliveries: projected.deliveries,
      };
      const next = this.host.applyReplanTransition({
        jobId: input.jobId,
        eventId: input.eventId,
        expectedVersion: job.version,
        event,
      });
      return { job: next, deliveries: this.readRows(input.jobId) };
    }).immediate();
  }

  private replaceOrdinary(
    input: ReplanRichDeliveryInput,
    job: TelegramJob,
    rows: readonly NormalizedDelivery[],
    primary: NormalizedDelivery,
  ): { readonly responsePlan: readonly TelegramResponsePlanPart[]; readonly deliveries: readonly TelegramDeliveryPart[] } {
    if (primary.payload.operation !== "send_rich" || primary.telegramMessageId !== null) malformed();
    this.assertProjection(job, rows);
    const planIndex = job.responsePlan!.findIndex((part) => part.partId === input.partKey);
    if (planIndex < 0 || primary.ordinal !== planIndex
      || !same(projectDelivery(primary), job.deliveries[planIndex])) {
      conflict("Telegram response plan conflict");
    }
    const fallback = primary.payload.fallbackParts;
    this.assertFallbackKeys(input.partKey, fallback, rows, true);
    const responsePlan = [
      ...job.responsePlan!.slice(0, planIndex),
      ...fallback.map(({ partKey, kind }) => ({ partId: partKey, kind })),
      ...job.responsePlan!.slice(planIndex + 1),
    ];
    if (responsePlan.length > TELEGRAM_RESPONSE_PLAN_MAX_PARTS) {
      throw new Error("Telegram response plan exceeds delivery budget");
    }
    const removed = this.host.statement(`DELETE FROM deliveries
      WHERE job_id = ? AND part_key = ? AND state = ? AND attempt_count = ? AND content_hash = ?`).run(
      input.jobId, input.partKey, input.expectedState, input.expectedAttemptCount, input.expectedContentHash,
    );
    if (removed.changes !== 1) conflict("Telegram delivery conflict");
    const shift = fallback.length - 1;
    if (shift !== 0) {
      this.host.statement(`UPDATE deliveries SET ordinal = ordinal + ?
        WHERE job_id = ? AND part_key != 'status-anchor' AND ordinal > ?`).run(
        shift, input.jobId, primary.ordinal,
      );
    }
    for (const [index, part] of fallback.entries()) {
      this.insertFallback(input, primary.ordinal + index, part);
    }
    const nextRows = this.readRows(input.jobId);
    const nextByKey = new Map(nextRows.map((row) => [row.partKey, row]));
    if (nextByKey.size !== nextRows.length) conflict("Telegram response plan conflict");
    const deliveries = responsePlan.map((part, ordinal) => {
      const row = nextByKey.get(part.partId);
      if (!row || row.ordinal !== ordinal || row.kind !== part.kind) {
        conflict("Telegram response plan conflict");
      }
      return projectDelivery(row);
    });
    return { responsePlan, deliveries };
  }

  private replaceAnchor(
    input: ReplanRichDeliveryInput,
    job: TelegramJob,
    rows: readonly NormalizedDelivery[],
    primary: NormalizedDelivery,
  ): { readonly responsePlan: readonly TelegramResponsePlanPart[]; readonly deliveries: readonly TelegramDeliveryPart[] } {
    if (primary.kind !== "status-anchor" || primary.ordinal !== 0
      || (primary.payload.operation !== "edit_rich" && primary.payload.operation !== "send_rich")) malformed();
    if (primary.payload.operation === "edit_rich"
      ? primary.telegramMessageId === null || primary.payload.messageId !== primary.telegramMessageId
      : primary.telegramMessageId !== null) malformed();
    this.assertProjection(job, rows);
    const fallback = primary.payload.fallbackParts;
    if (fallback.length !== 1 || fallback[0]!.kind !== "final"
      || fallback[0]!.payload.chatId !== primary.payload.chatId) malformed();
    if (primary.payload.operation === "edit_rich"
      ? fallback[0]!.payload.operation !== "edit_text"
        || fallback[0]!.payload.messageId !== primary.payload.messageId
      : fallback[0]!.payload.operation !== "send_text"
        || fallback[0]!.payload.messageThreadId !== primary.payload.messageThreadId) malformed();
    this.assertFallbackKeys(input.partKey, fallback, rows, false);
    const plan = this.readStatusPlan(input.jobId);
    if (plan.contentHash !== primary.contentHash || !same(plan.payload, primary.payload)) malformed();
    const replacement = normalizeLegacy(fallback[0]!.payload);
    const contentHash = hashTelegramDeliveryPayload(replacement);
    const updated = this.host.statement(`UPDATE deliveries SET state = 'pending', payload_json = ?, content_hash = ?,
      attempt_count = 0, next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
      WHERE job_id = ? AND part_key = 'status-anchor' AND state = ?
        AND attempt_count = ? AND content_hash = ? AND telegram_message_id IS ?`).run(
      stringify(replacement), contentHash, input.eventAt, input.jobId,
      input.expectedState, input.expectedAttemptCount, input.expectedContentHash, primary.telegramMessageId,
    );
    if (updated.changes !== 1) conflict("Telegram delivery conflict");
    const planUpdated = this.host.statement(`UPDATE status_anchor_plans SET payload_json = ?, content_hash = ?
      WHERE job_id = ? AND content_hash = ?`).run(
      stringify(replacement), contentHash, input.jobId, input.expectedContentHash,
    );
    if (planUpdated.changes !== 1) conflict("Telegram status anchor plan conflict");
    return { responsePlan: job.responsePlan!, deliveries: job.deliveries };
  }

  private assertProjection(job: TelegramJob, rows: readonly NormalizedDelivery[]): void {
    let anchor: NormalizedDelivery | undefined;
    const ordinary = new Map<string, NormalizedDelivery>();
    for (const row of rows) {
      if (row.partKey === "status-anchor") {
        if (anchor) conflict("Telegram response plan conflict");
        anchor = row;
      } else {
        if (ordinary.has(row.partKey)) conflict("Telegram response plan conflict");
        ordinary.set(row.partKey, row);
      }
    }
    if (!anchor || anchor.kind !== "status-anchor" || anchor.ordinal !== 0
      || ordinary.size !== job.responsePlan!.length || job.deliveries.length !== job.responsePlan!.length) {
      conflict("Telegram response plan conflict");
    }
    for (const [ordinal, planned] of job.responsePlan!.entries()) {
      const row = ordinary.get(planned.partId);
      const delivery = job.deliveries[ordinal];
      if (!row || delivery?.partId !== planned.partId || row.ordinal !== ordinal
        || row.kind !== planned.kind || !same(projectDelivery(row), delivery)) {
        conflict("Telegram response plan conflict");
      }
    }
  }

  private assertFallbackKeys(
    primaryKey: string,
    fallback: readonly TelegramFallbackPart[],
    rows: readonly NormalizedDelivery[],
    bindToPrimary: boolean,
  ): void {
    const reserved = new Set<string>();
    for (const row of rows) {
      if (row.partKey !== primaryKey && reserved.has(row.partKey)) conflict("Telegram response plan conflict");
      if (row.partKey !== primaryKey) reserved.add(row.partKey);
      if (row.partKey === primaryKey || (row.payload.operation !== "send_rich"
        && row.payload.operation !== "edit_rich")) continue;
      for (const part of row.payload.fallbackParts) {
        if (reserved.has(part.partKey)) conflict("Telegram response plan conflict");
        reserved.add(part.partKey);
      }
    }
    for (const [index, part] of fallback.entries()) {
      const expected = `${primaryKey}:fallback:${String(index).padStart(4, "0")}`;
      if ((bindToPrimary && part.partKey !== expected) || reserved.has(part.partKey)) {
        conflict("Telegram response plan conflict");
      }
      reserved.add(part.partKey);
    }
  }

  private insertFallback(input: ReplanRichDeliveryInput, ordinal: number, part: TelegramFallbackPart): void {
    const payload = normalizeLegacy(part.payload);
    this.host.statement(`INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json,
      content_hash, telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, 0, NULL, NULL, ?)`).run(
      input.jobId, part.partKey, ordinal, part.kind, stringify(payload),
      hashTelegramDeliveryPayload(payload), input.eventAt,
    );
  }

  private readRows(jobId: string): readonly NormalizedDelivery[] {
    const rows = this.host.statement("SELECT * FROM deliveries WHERE job_id = ? ORDER BY ordinal, part_key LIMIT ?")
      .all(jobId, TELEGRAM_RESPONSE_PLAN_MAX_PARTS + 2) as Record<string, unknown>[];
    if (rows.length > TELEGRAM_RESPONSE_PLAN_MAX_PARTS + 1) conflict("Telegram response plan conflict");
    return rows.map((row) => decodeDelivery(row));
  }

  private readStatusPlan(jobId: string): { readonly payload: TelegramDeliveryPayload; readonly contentHash: string } {
    const row = this.host.statement(`SELECT payload_json, content_hash, installed_at_ms
      FROM status_anchor_plans WHERE job_id = ?`).get(jobId) as Record<string, unknown> | undefined;
    try {
      if (!row) throw new Error();
      const raw = JSON.parse(text(row.payload_json));
      const payload = normalizeTelegramDeliveryPayload(raw);
      const contentHash = hash(row.content_hash);
      integer(row.installed_at_ms);
      if (!same(raw, payload) || hashTelegramDeliveryPayload(payload) !== contentHash) throw new Error();
      return { payload, contentHash };
    } catch { throw new Error("Malformed Telegram status anchor plan"); }
  }
}

function validateInput(value: ReplanRichDeliveryInput): void {
  const raw = plainRecord(value);
  exactKeys(raw, [
    "jobId", "partKey", "expectedJobVersion", "expectedState", "expectedAttemptCount",
    "expectedContentHash", "eventId", "eventAt", "reasonCode",
    ...(Object.hasOwn(raw, "topicResumeReplan") ? ["topicResumeReplan"] : []),
  ]);
  bounded(value.jobId, JOB_ID_MAX_LENGTH);
  bounded(value.partKey, PART_KEY_MAX_LENGTH);
  bounded(value.eventId, EVENT_ID_MAX_LENGTH);
  integer(value.expectedJobVersion);
  integer(value.expectedAttemptCount);
  integer(value.eventAt);
  hash(value.expectedContentHash);
  if ((value.expectedState !== "pending" && value.expectedState !== "sending")
    || !REPLAN_REASONS.includes(value.reasonCode)) invalidInput();
}

function decodeDelivery(row: Record<string, unknown>): NormalizedDelivery {
  try {
    const rawPayload = JSON.parse(text(row.payload_json));
    const payload = normalizeTelegramDeliveryPayload(rawPayload);
    const delivery: NormalizedDelivery = {
      jobId: bounded(row.job_id, JOB_ID_MAX_LENGTH),
      partKey: bounded(row.part_key, PART_KEY_MAX_LENGTH),
      ordinal: integer(row.ordinal),
      kind: bounded(row.kind, DELIVERY_TEXT_MAX_LENGTH),
      state: deliveryState(row.state),
      payload,
      contentHash: hash(row.content_hash),
      telegramMessageId: nullablePositive(row.telegram_message_id),
      attemptCount: integer(row.attempt_count),
      nextAttemptAt: nullableInteger(row.next_attempt_at_ms),
      lastErrorCode: row.last_error_code === null ? null : bounded(row.last_error_code, DELIVERY_TEXT_MAX_LENGTH),
      updatedAt: integer(row.updated_at_ms),
    };
    if (!same(rawPayload, payload) || hashTelegramDeliveryPayload(payload) !== delivery.contentHash) throw new Error();
    return structuredClone(delivery);
  } catch { throw new Error("Malformed Telegram delivery part"); }
}

function normalizeLegacy(value: unknown): TelegramLegacyDeliveryPayload {
  const payload = normalizeTelegramDeliveryPayload(value);
  if (payload.operation === "send_rich" || payload.operation === "edit_rich") malformed();
  return payload;
}

function projectDelivery(value: DeliveryPart): TelegramDeliveryPart {
  return {
    partId: value.partKey,
    state: value.state,
    attempts: value.attemptCount,
    messageId: value.telegramMessageId,
    deliveredAt: value.state === "delivered" ? value.updatedAt : null,
  };
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidInput();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidInput();
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || !descriptor.enumerable) invalidInput();
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))) invalidInput();
}
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) invalidInput();
  return value;
}
function text(value: unknown): string { if (typeof value !== "string") invalidInput(); return value; }
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidInput();
  return value;
}
function nullableInteger(value: unknown): number | null { return value === null ? null : integer(value); }
function nullablePositive(value: unknown): number | null {
  const result = nullableInteger(value);
  if (result !== null && result < 1) invalidInput();
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalidInput();
  return value;
}
function deliveryState(value: unknown): DeliveryPart["state"] {
  if (value === "pending" || value === "sending" || value === "delivered"
    || value === "uncertain" || value === "failed") return value;
  return invalidInput();
}
function stringify(value: unknown): string { return JSON.stringify(value); }
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function invalidInput(): never { throw new Error("Invalid Telegram delivery replan input"); }
function malformed(): never { throw new Error("Malformed Telegram rich delivery"); }
function conflict(message: string): never { throw new Error(message); }
