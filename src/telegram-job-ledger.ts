import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

import { TelegramDeliveryLedger, validateDelivery } from "./telegram-delivery-ledger.js";
import type {
  ReplanRichDeliveryInput,
  ReplanRichDeliveryResult,
} from "./telegram-delivery-replan.js";
import type {
  DeliveryCompletionScanInput, DeliveryCompletionScanResult, DeliveryPart, DeliveryTransitionInput,
  InstallDeliveryPlanInput, InstallLiveCommentaryInput, NewDeliveryPart,
  FinalizeDeliveredPlanInput, FinishStatusAnchorRevisionInput, PrepareStatusAnchorRevisionInput, PrepareStatusAnchorRevisionResult,
  ReplaceMissingStatusAnchorEditInput,
  ProjectedDeliveryTransitionInput, ProjectedDeliveryTransitionResult,
  TelegramDeliverySummary,
} from "./telegram-delivery-ledger.js";
import { transitionJob } from "./telegram-job-transition.js";
import { initializeTelegramJobSchema, validateTelegramJobSchema } from "./telegram-job-ledger-schema.js";
import {
  readSyntheticMigrationProof, SYNTHETIC_MIGRATION_PROOF_WHERE,
} from "./telegram-job-migration-provenance.js";
import {
  listTelegramJobQuarantine, scanTelegramReconciliationCandidates,
} from "./telegram-job-reconciliation-scan.js";
import type {
  TelegramJobQuarantine, TelegramReconciliationScanCursor, TelegramReconciliationScanInput,
  TelegramReconciliationScanResult,
} from "./telegram-job-reconciliation-scan.js";
import { STATUS_CANDIDATE_WHERE } from "./telegram-status-anchor-ledger.js";
import type {
  TelegramJob, TelegramJobEvent, TelegramSourceKey, UpdateAcceptedEvent,
} from "./telegram-job-types.js";
import { TelegramTopicRecoveryLedger } from "./telegram-topic-recovery-ledger.js";
import type {
  CompleteTopicRecoveryInput, DeferTopicRecoveryInput, ReserveTopicRecoveryInput, ResumeTopicRecoveryInput,
  TelegramTopicRecoveryCompletion, TelegramTopicRecoveryRecord, TelegramTopicRecoveryResult,
  TelegramTopicRecoveryState, TopicRecoveryOutcomeInput,
} from "./telegram-topic-recovery-ledger.js";

export type {
  DeliveryCompletionCandidate, DeliveryCompletionScanCursor, DeliveryCompletionScanInput,
  DeliveryCompletionScanResult, DeliveryPart, DeliveryTransitionInput, InstallDeliveryPlanInput,
  InstallLiveCommentaryInput, NewDeliveryPart,
  FinalizeDeliveredPlanInput, FinishStatusAnchorRevisionInput, PrepareStatusAnchorRevisionInput, PrepareStatusAnchorRevisionResult,
  ReplaceMissingStatusAnchorEditInput,
  ProjectedDeliveryTransitionInput, ProjectedDeliveryTransitionResult,
  TelegramDeliverySummary,
} from "./telegram-delivery-ledger.js";
export type { ReplanRichDeliveryInput, ReplanRichDeliveryResult } from "./telegram-delivery-replan.js";
export type {
  CompleteTopicRecoveryInput, DeferTopicRecoveryInput, ReserveTopicRecoveryInput, ResumeTopicRecoveryInput,
  TelegramTopicRecoveryCompletion, TelegramTopicRecoveryRecord, TelegramTopicRecoveryResult,
  TelegramTopicRecoveryState, TopicRecoveryOutcomeInput,
} from "./telegram-topic-recovery-ledger.js";

const BUSY_TIMEOUT_MS = 5_000;
const JOB_ID_MAX_LENGTH = 128;
const EVENT_ID_MAX_LENGTH = 128;
const BOT_ID_MAX_LENGTH = 128;
const METADATA_KEY_MAX_LENGTH = 128;
const METADATA_VALUE_MAX_LENGTH = 256 * 1024;
const JOB_WITH_INBOX = `SELECT jobs.*, inbox_updates.bot_id AS inbox_bot_id, inbox_updates.update_id AS inbox_update_id,
  inbox_updates.accepted_at_ms AS inbox_accepted_at_ms, inbox_updates.job_id AS inbox_job_id,
  inbox_updates.source_json AS inbox_source_json
  FROM jobs LEFT JOIN inbox_updates ON inbox_updates.job_id = jobs.id`;
const STATUS_CANDIDATE_ORDER = `CASE
    WHEN json_extract(projection_json, '$.attention.kind') = 'required' THEN 0
    WHEN json_extract(projection_json, '$.health') = 'stalled' THEN 1
    WHEN json_extract(projection_json, '$.phase') = 'terminal'
      OR EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id
        AND deliveries.state IN ('uncertain', 'failed')) THEN 2
    ELSE 3 END ASC,
  CASE WHEN json_extract(projection_json, '$.attention.kind') = 'required'
      OR json_extract(projection_json, '$.health') = 'stalled'
      OR json_extract(projection_json, '$.phase') = 'terminal'
      OR EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id
        AND deliveries.state IN ('uncertain', 'failed'))
    THEN updated_at_ms END DESC,
  accepted_at_ms ASC, id ASC`;
type WithoutExpectedVersion<T> = T extends unknown ? Omit<T, "expectedVersion"> : never;
export type TransitionEvent = WithoutExpectedVersion<TelegramJobEvent>;
export interface AcceptUpdateInput {
  readonly job: TelegramJob;
  readonly sourcePayload: unknown;
  readonly eventId: string;
  readonly initialDeliveries?: readonly NewDeliveryPart[];
}
export interface AcceptUpdateResult { readonly created: boolean; readonly job: TelegramJob; }
export interface AcceptRetryUpdateInput extends AcceptUpdateInput {
  readonly parentJobId: string;
  readonly expectedParentVersion: number;
}
export interface TelegramDashboardAggregates {
  readonly oldestQueueAgeMs: number | null;
  readonly counts: {
    readonly inProgress: number;
    readonly needsAttention: number;
    readonly recent: number;
    readonly ambiguous: number;
    readonly stalled: number;
    readonly undelivered: number;
  };
}
export interface TransitionInput { readonly jobId: string; readonly eventId: string; readonly event: TransitionEvent; }
export interface StoredAcceptedTelegramJobEvent { readonly jobId: string; readonly event: UpdateAcceptedEvent; readonly initialJob: TelegramJob; }
export interface StoredTransitionTelegramJobEvent { readonly jobId: string; readonly event: TelegramJobEvent; }
export type StoredTelegramJobEvent = StoredAcceptedTelegramJobEvent | StoredTransitionTelegramJobEvent;
export interface StoredTelegramJobEventSummary {
  readonly sequence: number;
  readonly eventId: string;
  readonly type: TelegramJobEvent["type"];
  readonly eventAt: number;
}
export interface TelegramJobRetentionInput {
  readonly now: number;
  readonly payloadRetentionMs: number;
  readonly metadataRetentionMs: number;
  readonly batchSize: number;
}
export interface TelegramJobRetentionResult {
  readonly payloadsPurged: number;
  readonly jobsDeleted: number;
  readonly orphanedMaterializedPaths: readonly string[];
}
export type {
  TelegramJobQuarantine, TelegramReconciliationScanCursor, TelegramReconciliationScanInput,
  TelegramReconciliationScanResult,
} from "./telegram-job-reconciliation-scan.js";
export interface SqliteTelegramJobStoreOptions {
  readonly hardenFile?: (filePath: string) => void;
  /** Optional local SQLite storage cap in pages; default is SQLite's unlimited default. */
  readonly maxPageCount?: number;
  /** Open an existing current-schema ledger without migrations or persistent writes. */
  readonly readOnly?: boolean;
}

/** Canonical SQLite ledger. TelegramJobStore remains the legacy JSON adapter until Task 12. */
export class SqliteTelegramJobStore {
  private readonly database: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly deliveryLedger: TelegramDeliveryLedger;
  private readonly topicRecoveryLedger: TelegramTopicRecoveryLedger;
  private closed = false;

  constructor(private readonly databasePath: string, options: SqliteTelegramJobStoreOptions = {}) {
    if (options.readOnly) {
      try { this.database = new Database(databasePath, { readonly: true, fileMustExist: true }); }
      catch { throw new Error("Unable to open Telegram SQLite job ledger"); }
    } else {
      prepareFile(databasePath);
      this.database = new Database(databasePath);
    }
    this.deliveryLedger = new TelegramDeliveryLedger({
      database: this.database,
      statement: (sql) => this.statement(sql),
      getJob: (jobId) => this.get(jobId),
      readSourcePayload: (jobId) => this.readSourcePayload(jobId),
      applyTransition: (input) => this.applyTransition(input),
    });
    this.topicRecoveryLedger = new TelegramTopicRecoveryLedger({
      database: this.database,
      statement: (sql) => this.statement(sql),
      getJob: (jobId) => this.get(jobId),
      readSourcePayload: (jobId) => this.readSourcePayload(jobId),
      listDeliveries: (jobId) => this.listDeliveries(jobId),
      applyTransition: (input) => this.applyTransition(input),
    });
    try {
      this.database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.database.pragma("foreign_keys = ON");
      if (options.readOnly) {
        validateTelegramJobSchema(this.database);
      } else {
        this.database.pragma("journal_mode = WAL");
        initializeTelegramJobSchema(this.database);
        if (options.maxPageCount !== undefined) {
          assertPositiveInteger(options.maxPageCount, "maxPageCount");
          this.database.pragma(`max_page_count = ${options.maxPageCount}`);
        }
        hardenFiles(databasePath, options.hardenFile);
      }
    } catch (error) {
      this.closed = true;
      try { this.database.close(); } catch { /* Preserve a safe error. */ }
      if (error instanceof Error && (error.message === "Malformed telegram job schema" || error.message === "Unsupported telegram job schema version")) throw error;
      throw new Error("Unable to open Telegram SQLite job ledger");
    }
  }

  acceptUpdate(input: AcceptUpdateInput): AcceptUpdateResult {
    this.assertOpen();
    validateInitialJob(input.job);
    bounded(input.eventId, "eventId", EVENT_ID_MAX_LENGTH);
    const sourcePayload = stringify(input.sourcePayload, "sourcePayload");
    const initialDeliveries = (input.initialDeliveries ?? []).map((delivery) => {
      validateDelivery(delivery);
      if (delivery.jobId !== input.job.id) throw new Error("Initial delivery job mismatch");
      return { delivery, payload: stringify(delivery.payload, "delivery payload") };
    });
    const accept = this.database.transaction(() => {
      const existing = this.bySource(input.job.source);
      if (existing) return { created: false, job: this.decodeCurrentRow(existing).job };
      this.statement(`INSERT INTO jobs (id, version, projection_json, updated_at_ms)
        VALUES (?, ?, ?, ?)`).run(input.job.id, input.job.version, stringify(input.job, "job"), input.job.updatedAt);
      this.statement(`INSERT INTO inbox_updates
        (bot_id, update_id, accepted_at_ms, source_json, job_id) VALUES (?, ?, ?, ?, ?)`).run(
        input.job.source.botId, input.job.source.updateId, input.job.acceptedAt, sourcePayload, input.job.id,
      );
      const event: UpdateAcceptedEvent = { schemaVersion: 1, type: "update.accepted", eventAt: input.job.acceptedAt };
      const stored: StoredAcceptedTelegramJobEvent = { jobId: input.job.id, event, initialJob: clone(input.job) };
      this.statement(`INSERT INTO job_events
        (job_id, event_id, event_type, event_at_ms, payload_json) VALUES (?, ?, ?, ?, ?)`).run(
        input.job.id, input.eventId, event.type, event.eventAt, stringify(stored, "event"),
      );
      for (const { delivery, payload } of initialDeliveries) {
        this.statement(`INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json,
          content_hash, telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          delivery.jobId, delivery.partKey, delivery.ordinal, delivery.kind, delivery.state, payload,
          delivery.contentHash, delivery.telegramMessageId ?? null, delivery.attemptCount ?? 0,
          delivery.nextAttemptAt ?? null, delivery.lastErrorCode ?? null, delivery.updatedAt,
        );
      }
      return { created: true, job: clone(input.job) };
    });
    return accept.immediate();
  }

  acceptRetryUpdate(input: AcceptRetryUpdateInput): AcceptUpdateResult {
    this.assertOpen();
    bounded(input.parentJobId, "parentJobId", JOB_ID_MAX_LENGTH);
    assertNonNegativeInteger(input.expectedParentVersion, "expectedParentVersion");
    return this.database.transaction(() => {
      const existingChild = this.bySource(input.job.source);
      if (existingChild) {
        const child = this.decodeCurrentRow(existingChild).job;
        const reservation = this.statement(`SELECT child_job_id FROM job_retry_reservations
          WHERE parent_job_id = ?`).get(input.parentJobId) as { child_job_id?: unknown } | undefined;
        if (reservation && reservation.child_job_id === child.id) return { created: false, job: child };
        throw new Error("Telegram retry reservation conflict");
      }
      const reserved = this.statement(`SELECT child_job_id FROM job_retry_reservations
        WHERE parent_job_id = ?`).get(input.parentJobId);
      if (reserved) throw new Error("Telegram retry already reserved");
      const parent = this.get(input.parentJobId);
      if (!parent) throw new Error("Unknown Telegram retry parent");
      if (parent.version !== input.expectedParentVersion) throw new Error("Telegram job version conflict");
      const accepted = this.acceptUpdate(input);
      if (!accepted.created) throw new Error("Telegram retry reservation conflict");
      this.statement(`INSERT INTO job_retry_reservations
        (parent_job_id, parent_version, child_job_id, reserved_at_ms) VALUES (?, ?, ?, ?)`).run(
        input.parentJobId, input.expectedParentVersion, accepted.job.id, accepted.job.acceptedAt,
      );
      return accepted;
    }).immediate();
  }

  get(jobId: string): TelegramJob | null {
    this.assertOpen();
    if (!nonEmpty(jobId)) return null;
    const row = this.statement(`${JOB_WITH_INBOX} WHERE jobs.id = ?`).get(jobId) as Record<string, unknown> | undefined;
    return row ? this.decodeCurrentRow(row).job : null;
  }

  getBySourceKey(key: TelegramSourceKey): TelegramJob | null {
    this.assertOpen();
    assertSource(key);
    const row = this.bySource(key);
    return row ? this.decodeCurrentRow(row).job : null;
  }

  transition(input: TransitionInput & { readonly expectedVersion: number }): TelegramJob {
    this.assertOpen();
    bounded(input.jobId, "jobId", JOB_ID_MAX_LENGTH); bounded(input.eventId, "eventId", EVENT_ID_MAX_LENGTH);
    assertNonNegativeInteger(input.expectedVersion, "expectedVersion");
    if (Object.hasOwn(input.event, "expectedVersion")) throw new Error("Telegram job event must not include expectedVersion");
    if (input.event.type === "delivery.replanned") throw new Error("Unsupported Telegram job event");
    const transition = this.database.transaction(() => {
      if (input.event.type === "job.terminal" && input.event.outcome === "completed") {
        const current = this.get(input.jobId);
        if (!current) throw new Error("Unknown Telegram job");
        this.deliveryLedger.assertCompletion(current, input.event.responsePlan, input.event.deliveries);
      }
      return this.applyTransition(input);
    });
    return transition.immediate();
  }

  /** Trusted compatibility seam for synthetic legacy imports only. */
  transitionLegacyMigration(input: TransitionInput & { readonly expectedVersion: number }): TelegramJob {
    this.assertOpen();
    bounded(input.jobId, "jobId", JOB_ID_MAX_LENGTH); bounded(input.eventId, "eventId", EVENT_ID_MAX_LENGTH);
    assertNonNegativeInteger(input.expectedVersion, "expectedVersion");
    if (Object.hasOwn(input.event, "expectedVersion") || input.event.type !== "job.terminal"
      || input.event.outcome !== "completed") throw new Error("Invalid legacy migration transition");
    return this.database.transaction(() => {
      const current = this.get(input.jobId);
      const payload = record(this.readSourcePayload(input.jobId));
      const migration = record(payload?.migration);
      const checksum = current?.source.botId.startsWith("legacy-json-v1:")
        ? current.source.botId.slice("legacy-json-v1:".length) : null;
      if (!current || checksum === null || migration?.sourceIdentity !== "synthetic"
        || migration.checksum !== checksum || migration.ordinal !== current.source.updateId) {
        throw new Error("Invalid legacy migration transition");
      }
      return this.applyTransition(input);
    }).immediate();
  }

  listEvents(jobId: string): readonly StoredTelegramJobEvent[] {
    this.assertOpen();
    if (!nonEmpty(jobId)) return [];
    const row = this.statement(`${JOB_WITH_INBOX} WHERE jobs.id = ?`).get(jobId) as Record<string, unknown> | undefined;
    if (!row) return [];
    return clone(this.decodeCurrentRow(row).events);
  }

  listEventSummaries(jobId: string): readonly StoredTelegramJobEventSummary[] {
    this.assertOpen();
    if (!nonEmpty(jobId)) return [];
    const row = this.statement(`${JOB_WITH_INBOX} WHERE jobs.id = ?`).get(jobId) as Record<string, unknown> | undefined;
    if (!row) return [];
    this.decodeCurrentRow(row);
    return this.rawEventSummaries(jobId);
  }

  runRetention(input: TelegramJobRetentionInput): TelegramJobRetentionResult {
    this.assertOpen();
    validateRetentionInput(input);
    const candidates = this.retentionCandidates(input);
    const releasedPaths = new Set<string>();
    let payloadsPurged = 0;
    let jobsDeleted = 0;
    let orphanedMaterializedPaths: string[] = [];
    this.database.transaction(() => {
      for (const candidate of candidates) {
        const current = this.get(candidate.id);
        if (!current || !retentionSafe(current, this.listDeliveries(current.id))) continue;
        const currentPaths = referencedMaterializedPaths(current, this.listDeliveries(current.id));
        if (candidate.action === "delete") {
          for (const candidatePath of currentPaths) releasedPaths.add(candidatePath);
          this.deleteRetainedJob(current.id);
          jobsDeleted += 1;
          continue;
        }
        const retainUntil = retentionDeadline(current, input.metadataRetentionMs);
        for (const candidatePath of currentPaths) releasedPaths.add(candidatePath);
        this.archiveAndScrub(current, retainUntil);
        payloadsPurged += 1;
      }
      for (const candidatePath of releasedPaths) {
        if (this.materializedPathIsReferenced(candidatePath)) continue;
        this.statement(`INSERT INTO retention_file_cleanup (relative_path, created_at_ms)
          VALUES (?, ?) ON CONFLICT(relative_path) DO NOTHING`).run(candidatePath, input.now);
      }
      orphanedMaterializedPaths = (this.statement(`SELECT relative_path FROM retention_file_cleanup
        ORDER BY created_at_ms, relative_path LIMIT ?`).all(input.batchSize) as Record<string, unknown>[])
        .map((row) => bounded(row.relative_path, "materialized path", 1_024));
    }).immediate();
    return { payloadsPurged, jobsDeleted, orphanedMaterializedPaths };
  }

  retentionFileCleanupIsOrphaned(relativePath: string): boolean {
    this.assertOpen();
    const candidate = bounded(relativePath, "materialized path", 1_024);
    return this.database.transaction(() => {
      const pending = this.statement("SELECT 1 FROM retention_file_cleanup WHERE relative_path = ?")
        .get(candidate);
      if (!pending) return false;
      if (!this.materializedPathIsReferenced(candidate)) return true;
      this.statement("DELETE FROM retention_file_cleanup WHERE relative_path = ?").run(candidate);
      return false;
    }).immediate();
  }

  acknowledgeRetentionFileCleanup(relativePath: string): void {
    this.assertOpen();
    const candidate = bounded(relativePath, "materialized path", 1_024);
    this.statement("DELETE FROM retention_file_cleanup WHERE relative_path = ?").run(candidate);
  }

  listDispatchable(limit: number): readonly TelegramJob[] {
    return this.listBy(`json_extract(projection_json, '$.phase') = 'queued'
      AND json_extract(projection_json, '$.attention.kind') = 'none'`, limit, "accepted_at_ms ASC, id ASC");
  }

  getDispatchableQueuePosition(jobId: string): number | null {
    this.assertOpen();
    if (!nonEmpty(jobId)) return null;
    const row = this.statement(`SELECT CASE WHEN json_valid(target.projection_json)
        AND json_extract(target.projection_json, '$.phase') = 'queued'
        AND json_extract(target.projection_json, '$.attention.kind') = 'none'
        AND NOT EXISTS (SELECT 1 FROM job_quarantine
          WHERE job_quarantine.job_id = target.id)
      THEN (SELECT count(*) FROM jobs AS prior
        JOIN inbox_updates AS prior_inbox ON prior_inbox.job_id = prior.id
        WHERE json_valid(prior.projection_json)
          AND json_extract(prior.projection_json, '$.phase') = 'queued'
          AND json_extract(prior.projection_json, '$.attention.kind') = 'none'
          AND NOT EXISTS (SELECT 1 FROM job_quarantine
            WHERE job_quarantine.job_id = prior.id)
          AND (prior_inbox.accepted_at_ms < target_inbox.accepted_at_ms
            OR (prior_inbox.accepted_at_ms = target_inbox.accepted_at_ms
              AND prior.id <= target.id)))
      ELSE NULL END AS position
      FROM jobs AS target
      JOIN inbox_updates AS target_inbox ON target_inbox.job_id = target.id
      WHERE target.id = ?`).get(jobId) as { position?: unknown } | undefined;
    if (!row || row.position === null) return null;
    const position = integer(row.position, "queue position");
    if (position < 1) throw new Error("Invalid queue position");
    return position;
  }

  listUnfinished(limit = 100): readonly TelegramJob[] {
    return this.listBy("json_extract(projection_json, '$.phase') != 'terminal'", limit, "accepted_at_ms ASC, id ASC");
  }

  scanReconciliationCandidates(input: TelegramReconciliationScanInput): TelegramReconciliationScanResult {
    this.assertOpen();
    return scanTelegramReconciliationCandidates({
      statement: (sql) => this.statement(sql),
      decode: (row) => this.decodeCurrentRow(row).job,
    }, input);
  }

  listQuarantined(limit = 100): readonly TelegramJobQuarantine[] {
    this.assertOpen();
    return listTelegramJobQuarantine({ statement: (sql) => this.statement(sql) }, limit);
  }

  listStatusCandidates(limit = 100): readonly TelegramJob[] {
    const completedSyntheticMigration = `json_extract(jobs.projection_json, '$.phase') = 'terminal'
      AND ${SYNTHETIC_MIGRATION_PROOF_WHERE}
      AND NOT EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id
        AND deliveries.state != 'delivered')
      AND (SELECT count(*) FROM deliveries WHERE deliveries.job_id = jobs.id
        AND deliveries.part_key != 'status-anchor')
        = COALESCE(json_array_length(json_extract(jobs.projection_json, '$.responsePlan')), 0)`;
    return this.listBy(
      `(${STATUS_CANDIDATE_WHERE}) AND NOT (${completedSyntheticMigration})`,
      limit,
      STATUS_CANDIDATE_ORDER,
    );
  }

  listRecent(limit: number): readonly TelegramJob[] {
    return this.listBy("1 = 1", limit, "updated_at_ms DESC, id ASC");
  }
  findLatestByContext(input: { readonly botId: string; readonly chatId: number; readonly messageThreadId: number | null }): TelegramJob | null {
    this.assertOpen();
    bounded(input.botId, "botId", BOT_ID_MAX_LENGTH);
    if (!Number.isSafeInteger(input.chatId) || input.chatId === 0 || !(input.messageThreadId === null
      || (Number.isSafeInteger(input.messageThreadId) && input.messageThreadId > 0))) {
      throw new Error("Invalid Telegram context");
    }
    const row = this.statement(`${JOB_WITH_INBOX}
      WHERE inbox_updates.bot_id = ? AND json_valid(inbox_updates.source_json)
      AND ((json_extract(inbox_updates.source_json, '$.chatId') = ?
        AND ((? IS NULL AND json_type(inbox_updates.source_json, '$.messageThreadId') = 'null')
          OR (? IS NOT NULL AND json_extract(inbox_updates.source_json, '$.messageThreadId') = ?)))
        OR (json_extract(inbox_updates.source_json, '$.targetContext.chatId') = ?
          AND ? IS NOT NULL
          AND json_extract(inbox_updates.source_json, '$.targetContext.messageThreadId') = ?))
      AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)
      ORDER BY jobs.updated_at_ms DESC, jobs.id ASC LIMIT 1`).get(
        input.botId,
        input.chatId, input.messageThreadId, input.messageThreadId, input.messageThreadId,
        input.chatId, input.messageThreadId, input.messageThreadId,
      ) as Record<string, unknown> | undefined;
    return row ? this.decodeCurrentRow(row).job : null;
  }

  countJobs(): number {
    this.assertOpen();
    const row = this.statement("SELECT count(*) AS count FROM jobs").get() as { count?: unknown };
    return integer(row.count, "job count");
  }

  getDashboardAggregates(now: number): TelegramDashboardAggregates {
    this.assertOpen();
    assertNonNegativeInteger(now, "Dashboard aggregate time");
    const row = this.statement(`SELECT
      MIN(CASE WHEN json_extract(projection_json, '$.phase') = 'queued'
        THEN json_extract(projection_json, '$.acceptedAt') END) AS oldest_queued_at,
      SUM(CASE WHEN json_extract(projection_json, '$.attention.kind') != 'required'
        AND json_extract(projection_json, '$.phase') != 'terminal' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN json_extract(projection_json, '$.attention.kind') = 'required'
        THEN 1 ELSE 0 END) AS needs_attention,
      SUM(CASE WHEN json_extract(projection_json, '$.attention.kind') != 'required'
        AND json_extract(projection_json, '$.phase') = 'terminal' THEN 1 ELSE 0 END) AS recent,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM deliveries
          WHERE deliveries.job_id = jobs.id AND deliveries.state = 'uncertain')
        OR (json_extract(projection_json, '$.phase') = 'dispatching'
          AND json_type(projection_json, '$.turnId') = 'null'
          AND COALESCE(json_extract(projection_json, '$.dispatch.transportWriteState'), '') != 'prepared')
        THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN json_extract(projection_json, '$.health') = 'stalled'
        THEN 1 ELSE 0 END) AS stalled,
      SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM deliveries
          WHERE deliveries.job_id = jobs.id AND deliveries.part_key = 'status-anchor'
            AND deliveries.state = 'delivered' AND deliveries.telegram_message_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM deliveries
          WHERE deliveries.job_id = jobs.id AND deliveries.state != 'delivered')
        THEN 1 ELSE 0 END) AS undelivered
      FROM jobs
      WHERE json_valid(projection_json)
        AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)`)
      .get() as Record<string, unknown>;
    const oldest = row.oldest_queued_at === null ? null : integer(row.oldest_queued_at, "oldest queued time");
    return {
      oldestQueueAgeMs: oldest === null ? null : Math.max(0, now - oldest),
      counts: {
        inProgress: aggregateCount(row.in_progress, "in-progress count"),
        needsAttention: aggregateCount(row.needs_attention, "attention count"),
        recent: aggregateCount(row.recent, "recent count"),
        ambiguous: aggregateCount(row.ambiguous, "ambiguous count"),
        stalled: aggregateCount(row.stalled, "stalled count"),
        undelivered: aggregateCount(row.undelivered, "undelivered count"),
      },
    };
  }

  probeReadable(timeoutMs = 250): void {
    this.assertOpen();
    assertProbeTimeout(timeoutMs);
    const previousTimeout = this.database.pragma("busy_timeout", { simple: true });
    if (typeof previousTimeout !== "number") throw new Error("Invalid SQLite busy timeout");
    this.database.pragma(`busy_timeout = ${timeoutMs}`);
    try {
      this.statement("SELECT count(*) AS count FROM jobs").get();
    } finally {
      this.database.pragma(`busy_timeout = ${previousTimeout}`);
    }
  }

  probeReleaseReadable(limit = 10_000): void {
    this.assertOpen();
    assertPositiveLimit(limit);
    if (this.statement("PRAGMA foreign_key_check").get()) {
      throw new Error("Malformed Telegram release ledger");
    }
    const malformed = this.statement(`SELECT 1 FROM jobs
      LEFT JOIN inbox_updates ON inbox_updates.job_id = jobs.id
      WHERE NOT json_valid(jobs.projection_json)
        OR json_type(jobs.projection_json, '$.phase') IS NOT 'text'
        OR inbox_updates.job_id IS NULL
      LIMIT 1`).get();
    const quarantined = this.statement("SELECT 1 FROM job_quarantine LIMIT 1").get();
    if (malformed || quarantined) throw new Error("Malformed Telegram release ledger");
    const terminalRows = this.statement(`${JOB_WITH_INBOX}
      WHERE json_valid(jobs.projection_json)
        AND json_extract(jobs.projection_json, '$.phase') = 'terminal'
        AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)
      ORDER BY jobs.id LIMIT ?`).all(limit + 1) as Record<string, unknown>[];
    if (terminalRows.length > limit) throw new Error("Telegram release ledger inspection limit exceeded");
    for (const row of terminalRows) this.decodeCurrentRow(row);
  }

  probeWritable(timeoutMs = 250): void {
    this.assertOpen();
    assertProbeTimeout(timeoutMs);
    const previousTimeout = this.database.pragma("busy_timeout", { simple: true });
    if (typeof previousTimeout !== "number") throw new Error("Invalid SQLite busy timeout");
    this.database.pragma(`busy_timeout = ${timeoutMs}`);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.statement(`INSERT INTO metadata (key, value) VALUES ('telecodex.readiness-probe', 'null')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    } finally {
      try {
        if (this.database.inTransaction) this.database.exec("ROLLBACK");
      } finally {
        this.database.pragma(`busy_timeout = ${previousTimeout}`);
      }
    }
  }

  getMetadata(key: string): unknown | null {
    this.assertOpen();
    bounded(key, "metadata key", METADATA_KEY_MAX_LENGTH);
    const row = this.statement("SELECT value FROM metadata WHERE key = ?").get(key) as { value?: unknown } | undefined;
    if (!row) return null;
    try { return clone(JSON.parse(string(row.value, "metadata value"))); }
    catch { throw new Error("Malformed Telegram job metadata"); }
  }

  setMetadata(key: string, value: unknown): void {
    this.assertOpen();
    bounded(key, "metadata key", METADATA_KEY_MAX_LENGTH);
    const encoded = stringify(value, "metadata value");
    if (encoded.length > METADATA_VALUE_MAX_LENGTH) throw new Error("Invalid metadata value");
    this.statement(`INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, encoded);
  }

  readSourcePayload(jobId: string): unknown | null {
    this.assertOpen();
    if (!nonEmpty(jobId)) return null;
    const row = this.statement(`${JOB_WITH_INBOX} WHERE jobs.id = ?`).get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.decodeCurrentRow(row);
    try { return clone(JSON.parse(string(row.inbox_source_json, "source_json"))); }
    catch { throw new Error("Malformed Telegram job source payload"); }
  }

  replaceSourcePayload(jobId: string, source: TelegramSourceKey, value: unknown): void {
    this.assertOpen(); bounded(jobId, "jobId", JOB_ID_MAX_LENGTH); assertSource(source);
    const encoded = stringify(value, "source payload");
    const result = this.statement(`UPDATE inbox_updates SET source_json = ?
      WHERE job_id = ? AND bot_id = ? AND update_id = ?`).run(encoded, jobId, source.botId, source.updateId);
    if (result.changes !== 1) throw new Error("Telegram job source mismatch");
  }

  insertDelivery(input: NewDeliveryPart): DeliveryPart {
    this.assertOpen(); return this.deliveryLedger.insert(input);
  }

  transitionDelivery(input: DeliveryTransitionInput): DeliveryPart {
    this.assertOpen(); return this.deliveryLedger.transition(input);
  }

  prepareStatusAnchorRevision(input: PrepareStatusAnchorRevisionInput): PrepareStatusAnchorRevisionResult {
    this.assertOpen(); return this.deliveryLedger.prepareStatusAnchorRevision(input); }

  finishStatusAnchorRevision(input: FinishStatusAnchorRevisionInput): DeliveryPart {
    this.assertOpen(); return this.deliveryLedger.finishStatusAnchorRevision(input); }

  replaceMissingStatusAnchorEdit(input: ReplaceMissingStatusAnchorEditInput): DeliveryPart {
    this.assertOpen(); return this.deliveryLedger.replaceMissingStatusAnchorEdit(input);
  }

  installDeliveryPlan(input: InstallDeliveryPlanInput): TelegramJob {
    this.assertOpen(); return this.deliveryLedger.installPlan(input);
  }

  installLiveCommentary(input: InstallLiveCommentaryInput): TelegramJob {
    this.assertOpen(); return this.deliveryLedger.installLiveCommentary(input);
  }

  finalizeDeliveredPlan(input: FinalizeDeliveredPlanInput): TelegramJob | null {
    this.assertOpen(); return this.deliveryLedger.finalizeDeliveredPlan(input);
  }

  scanDeliveryCompletionCandidates(input: DeliveryCompletionScanInput): DeliveryCompletionScanResult {
    this.assertOpen(); return this.deliveryLedger.scanCompletionCandidates(input);
  }

  transitionDeliveryAndProject(input: ProjectedDeliveryTransitionInput): ProjectedDeliveryTransitionResult {
    this.assertOpen(); return this.deliveryLedger.transitionAndProject(input);
  }

  replaceRejectedRichDelivery(input: ReplanRichDeliveryInput): ReplanRichDeliveryResult {
    this.assertOpen(); return this.deliveryLedger.replaceRejectedRichDelivery(input);
  }

  listDueDeliveries(now: number, limit: number): readonly DeliveryPart[] {
    this.assertOpen(); return this.deliveryLedger.listDue(now, limit);
  }

  listSendingDeliveries(now: number, limit: number): readonly DeliveryPart[] {
    this.assertOpen(); return this.deliveryLedger.listSending(now, limit);
  }

  nextDeliveryWakeupAt(): number | null {
    this.assertOpen(); return this.deliveryLedger.nextWakeupAt();
  }

  listDeliveries(jobId: string): readonly DeliveryPart[] {
    this.assertOpen(); return this.deliveryLedger.list(jobId);
  }

  getDeliverySummary(jobId: string): TelegramDeliverySummary {
    this.assertOpen(); return this.deliveryLedger.summary(jobId);
  }

  reserveTopicRecovery(input: ReserveTopicRecoveryInput): TelegramTopicRecoveryResult {
    this.assertOpen(); return this.topicRecoveryLedger.reserve(input);
  }

  deferTopicRecovery(input: DeferTopicRecoveryInput): TelegramTopicRecoveryRecord {
    this.assertOpen(); return this.topicRecoveryLedger.defer(input);
  }

  resumeTopicRecovery(input: ResumeTopicRecoveryInput): TelegramTopicRecoveryResult {
    this.assertOpen(); return this.topicRecoveryLedger.resume(input);
  }

  markTopicRecoveryUnknown(input: TopicRecoveryOutcomeInput): TelegramTopicRecoveryRecord {
    this.assertOpen(); return this.topicRecoveryLedger.markUnknown(input);
  }

  failTopicRecovery(input: TopicRecoveryOutcomeInput): TelegramTopicRecoveryRecord {
    this.assertOpen(); return this.topicRecoveryLedger.fail(input);
  }

  completeTopicRecovery(input: CompleteTopicRecoveryInput): TelegramTopicRecoveryCompletion {
    this.assertOpen(); return this.topicRecoveryLedger.complete(input);
  }

  getTopicRecovery(jobId: string): TelegramTopicRecoveryRecord | null {
    this.assertOpen(); return this.topicRecoveryLedger.get(jobId);
  }

  listTopicRecoveries(
    states: readonly TelegramTopicRecoveryState[],
    limit?: number,
  ): readonly TelegramTopicRecoveryRecord[] {
    this.assertOpen(); return this.topicRecoveryLedger.list(states, limit);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private listBy(where: string, limit: number, order: string): readonly TelegramJob[] {
    this.assertOpen();
    assertPositiveLimit(limit);
    return this.statement(`${JOB_WITH_INBOX} WHERE CASE WHEN json_valid(jobs.projection_json)
      THEN (${where}) ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)
      ORDER BY ${order} LIMIT ?`).all(limit)
      .map((row) => this.decodeCurrentRow(row as Record<string, unknown>).job);
  }

  private retentionCandidates(input: TelegramJobRetentionInput): readonly {
    readonly id: string;
    readonly action: "purge" | "delete";
  }[] {
    const payloadThreshold = input.now - input.payloadRetentionMs;
    const metadataThreshold = input.now - input.metadataRetentionMs;
    const rows = this.statement(`SELECT jobs.id,
      CASE WHEN (
        (EXISTS (SELECT 1 FROM job_event_archive WHERE job_event_archive.job_id = jobs.id)
          AND json_type(jobs.projection_json, '$.retainUntil') = 'integer'
          AND json_extract(jobs.projection_json, '$.retainUntil') <= @now)
        OR (NOT EXISTS (SELECT 1 FROM job_event_archive WHERE job_event_archive.job_id = jobs.id)
          AND json_extract(jobs.projection_json, '$.terminalAt') <= @metadataThreshold)
      ) THEN 'delete' ELSE 'purge' END AS action
      FROM jobs
      WHERE json_valid(jobs.projection_json)
      AND json_extract(jobs.projection_json, '$.phase') = 'terminal'
      AND json_extract(jobs.projection_json, '$.attention.kind') = 'none'
      AND json_extract(jobs.projection_json, '$.health') != 'stalled'
      AND json_type(jobs.projection_json, '$.terminalAt') = 'integer'
      AND json_extract(jobs.projection_json, '$.terminalAt') <= @payloadThreshold
      AND ((NOT EXISTS (SELECT 1 FROM job_event_archive WHERE job_event_archive.job_id = jobs.id))
        OR (json_type(jobs.projection_json, '$.retainUntil') = 'integer'
          AND json_extract(jobs.projection_json, '$.retainUntil') <= @now))
      AND (json_extract(jobs.projection_json, '$.outcome') = 'completed'
        OR json_type(jobs.projection_json, '$.dismissedAt') = 'integer')
      AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE job_quarantine.job_id = jobs.id)
      AND NOT EXISTS (SELECT 1 FROM deliveries
        WHERE deliveries.job_id = jobs.id AND deliveries.state != 'delivered')
      ORDER BY json_extract(jobs.projection_json, '$.terminalAt'), jobs.id
      LIMIT @batchSize`).all({
      now: input.now,
      payloadThreshold,
      metadataThreshold,
      batchSize: input.batchSize,
    }) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: bounded(row.id, "jobId", JOB_ID_MAX_LENGTH),
      action: row.action === "delete" ? "delete" : "purge",
    }));
  }

  private archiveAndScrub(job: TelegramJob, retainUntil: number): void {
    const events = this.statement(`SELECT sequence, job_id, event_id, event_type, event_at_ms
      FROM job_events WHERE job_id = ? ORDER BY sequence`).all(job.id) as Record<string, unknown>[];
    if (events.length === 0) return;
    for (const event of events) {
      this.statement(`INSERT INTO job_event_archive
        (job_id, sequence, event_id, event_type, event_at_ms) VALUES (?, ?, ?, ?, ?)`).run(
        job.id,
        integer(event.sequence, "event sequence"),
        bounded(event.event_id, "eventId", EVENT_ID_MAX_LENGTH),
        eventType(event.event_type),
        integer(event.event_at_ms, "event timestamp"),
      );
    }
    const source = parseRecord(this.statement("SELECT source_json FROM inbox_updates WHERE job_id = ?")
      .get(job.id) as Record<string, unknown> | undefined, "source_json", "Malformed Telegram job source payload");
    const { materializedPrompt: _materializedPrompt, turnResult: _turnResult, ...rest } = job;
    const scrubbed: TelegramJob = {
      ...rest,
      attachments: [],
      retainUntil: job.retainUntil === null ? retainUntil : Math.max(job.retainUntil, retainUntil),
    };
    this.statement("UPDATE jobs SET projection_json = ? WHERE id = ?").run(
      stringify(scrubbed, "job"), job.id,
    );
    this.statement("UPDATE inbox_updates SET source_json = ? WHERE job_id = ?").run(
      stringify(scrubSourcePayload(source, job.source), "source payload"), job.id,
    );
    this.statement("UPDATE deliveries SET payload_json = 'null' WHERE job_id = ?").run(job.id);
    this.statement("DELETE FROM status_anchor_plans WHERE job_id = ?").run(job.id);
    this.statement("DELETE FROM status_anchor_plan_bootstrap_eligibility WHERE job_id = ?").run(job.id);
    this.statement("DELETE FROM job_events WHERE job_id = ?").run(job.id);
  }

  private deleteRetainedJob(jobId: string): void {
    this.statement(`DELETE FROM job_retry_reservations
      WHERE parent_job_id = ? OR child_job_id = ?`).run(jobId, jobId);
    this.statement("DELETE FROM job_quarantine WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM status_anchor_plans WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM status_anchor_plan_bootstrap_eligibility WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM topic_recoveries WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM deliveries WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM job_events WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM job_event_archive WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM inbox_updates WHERE job_id = ?").run(jobId);
    this.statement("DELETE FROM jobs WHERE id = ?").run(jobId);
  }

  private materializedPathIsReferenced(candidatePath: string): boolean {
    const projection = this.statement(`SELECT 1 FROM jobs
      WHERE (EXISTS (SELECT 1 FROM json_each(
        CASE WHEN json_valid(jobs.projection_json) THEN jobs.projection_json ELSE '{}' END,
        '$.materializedPrompt.attachments')
        WHERE json_extract(value, '$.relativePath') = ?)
      OR EXISTS (SELECT 1 FROM json_each(
        CASE WHEN json_valid(jobs.projection_json) THEN jobs.projection_json ELSE '{}' END,
        '$.turnResult.content')
        WHERE json_extract(value, '$.attachment.path') = ?)) LIMIT 1`).get(candidatePath, candidatePath);
    if (projection) return true;
    return this.statement(`SELECT 1 FROM deliveries
      WHERE json_valid(payload_json) AND json_extract(payload_json, '$.path') = ? LIMIT 1`).get(candidatePath) !== undefined;
  }


  private bySource(key: TelegramSourceKey): Record<string, unknown> | undefined {
    const rows = this.statement(`${JOB_WITH_INBOX} WHERE (inbox_updates.bot_id = ? AND inbox_updates.update_id = ?)
      OR (json_extract(jobs.projection_json, '$.source.botId') = ? AND json_extract(jobs.projection_json, '$.source.updateId') = ?)`)
      .all(key.botId, key.updateId, key.botId, key.updateId) as Record<string, unknown>[];
    if (rows.length > 1) throw new Error("Malformed Telegram job inbox");
    return rows[0];
  }

  private applyTransition(input: TransitionInput & { readonly expectedVersion: number }): TelegramJob {
    const current = this.get(input.jobId);
    if (!current) throw new Error("Unknown Telegram job");
    const event = { ...input.event, expectedVersion: input.expectedVersion } as TelegramJobEvent;
    const applied = transitionJob(current, event);
    if (applied.kind === "conflict") throw new Error("Telegram job version conflict");
    const update = this.statement(`UPDATE jobs SET version = ?, projection_json = ?, updated_at_ms = ?
      WHERE id = ? AND version = ?`).run(
      applied.job.version, stringify(applied.job, "job"), applied.job.updatedAt, input.jobId, input.expectedVersion,
    );
    if (update.changes !== 1) throw new Error("Telegram job version conflict");
    const stored: StoredTransitionTelegramJobEvent = { jobId: input.jobId, event };
    this.statement(`INSERT INTO job_events
      (job_id, event_id, event_type, event_at_ms, payload_json) VALUES (?, ?, ?, ?, ?)`).run(
      input.jobId, input.eventId, event.type, event.eventAt, stringify(stored, "event"),
    );
    return clone(applied.job);
  }

  private assertOpen(): void { if (this.closed) throw new Error("Telegram SQLite job ledger is closed"); }
  private decodeCurrentRow(row: Record<string, unknown>): { job: TelegramJob; events: readonly StoredTelegramJobEvent[] } {
    const job = decodeJob(row.projection_json);
    if (row.id !== job.id || row.version !== job.version || row.updated_at_ms !== job.updatedAt) throw new Error("Malformed Telegram job row");
    if (row.inbox_job_id !== job.id || row.inbox_bot_id !== job.source.botId || row.inbox_update_id !== job.source.updateId
      || row.inbox_accepted_at_ms !== job.acceptedAt) throw new Error("Malformed Telegram job inbox");
    const events = this.rawEvents(job.id);
    if (events.length === 0) {
      const summaries = this.rawEventSummaries(job.id);
      const source = parseRecord(row, "inbox_source_json", "Malformed Telegram job source payload");
      if (summaries.length === 0 || summaries[0]?.type !== "update.accepted"
        || job.phase !== "terminal" || job.retainUntil === null || source.payloadPurged !== true) {
        throw new Error("Malformed Telegram job projection");
      }
      return { job, events: [] };
    }
    if (!same(replayTelegramJobEvents(events), job)) throw new Error("Malformed Telegram job projection");
    return { job, events };
  }
  private rawEvents(jobId: string): readonly StoredTelegramJobEvent[] {
    return this.statement("SELECT job_id, event_id, event_type, event_at_ms, payload_json FROM job_events WHERE job_id = ? ORDER BY sequence").all(jobId)
      .map((row) => this.decodeEventRow(row as Record<string, unknown>));
  }
  private rawEventSummaries(jobId: string): readonly StoredTelegramJobEventSummary[] {
    const archived = this.statement(`SELECT sequence, event_id, event_type, event_at_ms
      FROM job_event_archive WHERE job_id = ? ORDER BY sequence`).all(jobId) as Record<string, unknown>[];
    const rows = archived.length > 0 ? archived : this.statement(`SELECT sequence, event_id, event_type, event_at_ms
      FROM job_events WHERE job_id = ? ORDER BY sequence`).all(jobId) as Record<string, unknown>[];
    return rows.map((row) => ({
      sequence: integer(row.sequence, "event sequence"),
      eventId: bounded(row.event_id, "eventId", EVENT_ID_MAX_LENGTH),
      type: eventType(row.event_type),
      eventAt: integer(row.event_at_ms, "event timestamp"),
    }));
  }
  private decodeEventRow(row: Record<string, unknown>): StoredTelegramJobEvent {
    try {
      const stored = decodeStoredEvent(row.payload_json);
      bounded(row.event_id, "eventId", EVENT_ID_MAX_LENGTH);
      if (row.job_id !== stored.jobId || row.event_type !== stored.event.type || row.event_at_ms !== stored.event.eventAt) throw new Error();
      return stored;
    } catch { throw new Error("Malformed Telegram job event"); }
  }
  private statement(sql: string): Database.Statement {
    const statement = this.statements.get(sql) ?? this.database.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }
}

export function replayTelegramJobEvents(events: readonly StoredTelegramJobEvent[]): TelegramJob {
  const [initial, ...transitions] = events;
  if (!initial || !("initialJob" in initial)) throw new Error("Malformed Telegram job event stream");
  validateInitialJob(initial.initialJob);
  if (initial.jobId !== initial.initialJob.id || initial.event.type !== "update.accepted"
    || Object.hasOwn(initial.event, "expectedVersion") || initial.event.eventAt !== initial.initialJob.acceptedAt) {
    throw new Error("Malformed Telegram job event stream");
  }
  const accepted = transitionJob(initial.initialJob, initial.event);
  if (accepted.kind === "conflict") throw new Error("Malformed Telegram job event stream");
  let projection: TelegramJob = { ...clone(initial.initialJob), responsePlan: initial.initialJob.responsePlan };
  for (const stored of transitions) {
    if ("initialJob" in stored || stored.jobId !== initial.jobId || stored.event.type === "update.accepted"
      || !Object.hasOwn(stored.event, "expectedVersion")) throw new Error("Malformed Telegram job event stream");
    const applied = transitionJob(projection, stored.event);
    if (applied.kind === "conflict") throw new Error("Malformed Telegram job event stream");
    projection = applied.job;
  }
  return clone(projection);
}

function prepareFile(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    try { closeSync(openSync(filePath, "wx", 0o600)); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
  }
  hardenFiles(filePath);
}
function hardenFiles(filePath: string, hardenFile: (filePath: string) => void = (candidate) => chmodSync(candidate, 0o600)): void {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${filePath}${suffix}`)) hardenFile(`${filePath}${suffix}`);
}
function validateInitialJob(job: TelegramJob): void {
  assertSource(job.source);
  bounded(job.id, "jobId", JOB_ID_MAX_LENGTH);
  if (job.phase !== "accepted" || job.version !== 1 || job.acceptedAt !== job.updatedAt
    || job.materializedPrompt !== undefined) throw new Error("Invalid accepted Telegram job");
  const validated = transitionJob(job, { schemaVersion: 1, type: "activity.observed", eventAt: job.updatedAt });
  if (validated.kind === "conflict") throw new Error("Invalid accepted Telegram job");
}
function decodeJob(value: unknown): TelegramJob {
  try {
    const job = JSON.parse(string(value, "projection_json")) as TelegramJob;
    validateInitialOrCurrentJob(job);
    return clone(job);
  } catch { throw new Error("Malformed Telegram job projection"); }
}
export function decodeTelegramJobProjection(value: unknown): TelegramJob {
  return decodeJob(value);
}
function validateInitialOrCurrentJob(job: TelegramJob): void {
  const validated = transitionJob(job, { schemaVersion: 1, type: "activity.observed", eventAt: job.updatedAt });
  if (validated.kind === "conflict") throw new Error("Invalid Telegram job");
}
function decodeStoredEvent(value: unknown): StoredTelegramJobEvent {
  try {
    const raw = record(JSON.parse(string(value, "payload_json")));
    if (!raw) throw new Error();
    const event = eventValue(raw.event);
    if (Object.hasOwn(raw, "initialJob")) {
      onlyKeys(raw, ["jobId", "event", "initialJob"]);
      if (event.type !== "update.accepted" || Object.hasOwn(event, "expectedVersion")) throw new Error();
      const initialJob = jobValue(raw.initialJob);
      validateInitialJob(initialJob);
      if (event.eventAt !== initialJob.acceptedAt) throw new Error();
      const accepted = transitionJob(initialJob, event);
      if (accepted.kind === "conflict") throw new Error();
      const jobId = bounded(raw.jobId, "jobId", JOB_ID_MAX_LENGTH);
      if (jobId !== initialJob.id) throw new Error();
      return { jobId, event: event as UpdateAcceptedEvent, initialJob };
    }
    onlyKeys(raw, ["jobId", "event"]);
    return { jobId: bounded(raw.jobId, "jobId", JOB_ID_MAX_LENGTH), event };
  } catch { throw new Error("Malformed Telegram job event"); }
}
function eventValue(value: unknown): TelegramJobEvent {
  if (!record(value)) throw new Error();
  return clone(value) as TelegramJobEvent;
}
function jobValue(value: unknown): TelegramJob {
  if (!record(value)) throw new Error();
  return clone(value) as TelegramJob;
}
function assertSource(source: TelegramSourceKey): void { bounded(source.botId, "botId", BOT_ID_MAX_LENGTH); assertNonNegativeInteger(source.updateId, "updateId"); }
function assertText(value: unknown, name: string): asserts value is string { if (!nonEmpty(value)) throw new Error(`Invalid ${name}`); }
function bounded(value: unknown, name: string, maximum: number): string { assertText(value, name); if (value.length > maximum) throw new Error(`Invalid ${name}`); return value; }
function assertPositiveLimit(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid list limit"); }
function assertProbeTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000) {
    throw new Error("Invalid SQLite probe timeout");
  }
}
const EVENT_TYPES = new Set<TelegramJobEvent["type"]>([
  "update.accepted",
  "job.queued",
  "dispatch.started",
  "dispatch.in_flight",
  "dispatch.written",
  "job.deferred",
  "turn.started",
  "activity.observed",
  "abort.requested",
  "turn.completed",
  "guardian.observed",
  "reconciliation.decided",
  "reconciliation.applied",
  "materialization.succeeded",
  "materialization.failed",
  "delivery.changed",
  "delivery.replanned",
  "job.terminal",
]);
function eventType(value: unknown): TelegramJobEvent["type"] {
  if (typeof value !== "string" || !EVENT_TYPES.has(value as TelegramJobEvent["type"])) {
    throw new Error("Malformed Telegram job event metadata");
  }
  return value as TelegramJobEvent["type"];
}
function validateRetentionInput(input: TelegramJobRetentionInput): void {
  assertNonNegativeInteger(input.now, "retention now");
  assertPositiveInteger(input.payloadRetentionMs, "payloadRetentionMs");
  assertPositiveInteger(input.metadataRetentionMs, "metadataRetentionMs");
  assertPositiveInteger(input.batchSize, "batchSize");
  if (input.metadataRetentionMs < input.payloadRetentionMs) {
    throw new Error("Invalid Telegram job retention window");
  }
}
function retentionDeadline(job: TelegramJob, metadataRetentionMs: number): number {
  if (job.terminalAt === null) throw new Error("Invalid Telegram job retention candidate");
  const deadline = job.terminalAt + metadataRetentionMs;
  if (!Number.isSafeInteger(deadline)) throw new Error("Invalid Telegram job retention deadline");
  return deadline;
}
function retentionSafe(job: TelegramJob, deliveries: readonly DeliveryPart[]): boolean {
  return job.phase === "terminal"
    && job.terminalAt !== null
    && job.attention.kind === "none"
    && job.health !== "stalled"
    && (job.outcome === "completed" || job.dismissedAt !== null)
    && deliveries.every((delivery) => delivery.state === "delivered");
}
function referencedMaterializedPaths(
  job: TelegramJob,
  deliveries: readonly DeliveryPart[],
): readonly string[] {
  const paths = new Set<string>();
  for (const attachment of job.materializedPrompt?.attachments ?? []) paths.add(attachment.relativePath);
  for (const content of job.turnResult?.content ?? []) {
    if (content.kind === "attachment") paths.add(content.attachment.path);
  }
  for (const delivery of deliveries) {
    const payload = record(delivery.payload);
    if (typeof payload?.path === "string" && payload.path.length > 0) paths.add(payload.path);
  }
  return [...paths];
}
function scrubSourcePayload(
  source: Record<string, unknown>,
  key: TelegramSourceKey,
): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const key of [
    "botId",
    "updateId",
    "chatId",
    "messageThreadId",
    "messageId",
    "kind",
  ]) {
    if (Object.hasOwn(source, key)) scrubbed[key] = source[key];
  }
  scrubbed.text = null;
  scrubbed.attachment = null;
  const migration = readSyntheticMigrationProof(source, key);
  if (migration) scrubbed.migration = migration;
  if (Object.hasOwn(source, "retryOfJobId")) scrubbed.retryOfJobId = source.retryOfJobId;
  scrubbed.payloadPurged = true;
  return scrubbed;
}
function parseRecord(
  row: Record<string, unknown> | undefined,
  column: string,
  errorMessage: string,
): Record<string, unknown> {
  try {
    if (!row) throw new Error();
    const parsed = record(JSON.parse(string(row[column], column)));
    if (!parsed) throw new Error();
    return parsed;
  } catch {
    throw new Error(errorMessage);
  }
}
function assertNonNegativeInteger(value: unknown, name: string): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`); }
function assertPositiveInteger(value: unknown, name: string): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function integer(value: unknown, name: string): number { assertNonNegativeInteger(value, name); return value; }
function aggregateCount(value: unknown, name: string): number {
  return value === null ? 0 : integer(value, name);
}
function string(value: unknown, name: string): string { if (typeof value !== "string") throw new Error(`Invalid ${name}`); return value; }
function stringify(value: unknown, name: string): string { try { const result = JSON.stringify(value); if (result === undefined) throw new Error(); return result; } catch { throw new Error(`Invalid ${name}`); } }
function record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(); }
function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}
