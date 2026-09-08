import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import { validateDelivery, type DeliveryPart, type ProjectedDeliveryTransitionInput }
  from "./telegram-delivery-ledger.js";
import type { TelegramJob } from "./telegram-job-types.js";
import type { ReplanRichDeliveryInput, ReplanRichDeliveryResult } from "./telegram-delivery-replan.js";
import type {
  TelegramTopicResumeExternalEligibilitySnapshot,
  TelegramTopicResumeLedger,
  TelegramTopicResumeRecord,
} from "./telegram-topic-resume-ledger.js";
import { hashTelegramTopicResumeTopology, isTelegramTopicResumeContinuationValid } from "./telegram-topic-resume.js";

export interface TelegramTopicResumeDeliveryAuthorization {
  readonly job: TelegramJob;
  readonly resume: TelegramTopicResumeRecord;
  readonly part: DeliveryPart;
  readonly external: TelegramTopicResumeExternalEligibilitySnapshot;
  readonly authorizedAt: number;
}

export interface TelegramTopicResumeDeliveryFence {
  readonly actionToken: string;
  readonly jobVersion: number;
  readonly part: DeliveryPart;
  readonly job: TelegramJob;
}

interface GuardHost {
  readonly database: Database.Database;
  readonly statement: (sql: string) => Database.Statement;
  readonly getJob: (jobId: string) => TelegramJob | null;
  readonly resume: TelegramTopicResumeLedger;
}

interface Evidence {
  readonly job: TelegramJob;
  readonly resume: TelegramTopicResumeRecord;
  readonly rows: readonly DeliveryPart[];
  readonly selected: DeliveryPart | undefined;
}

/** Every authorization is reloaded inside the transaction that writes sending. */
export class TelegramTopicResumeDeliveryGuard {
  constructor(private readonly host: GuardHost) {}

  hasResume(jobId: string): boolean {
    return this.host.statement("SELECT 1 FROM topic_resume_attempts WHERE job_id = ?").get(jobId) !== undefined;
  }

  beforeReplan(input: ReplanRichDeliveryInput): TelegramTopicResumeRecord | null | false {
    if (!this.hasResume(input.jobId)) return input.topicResumeReplan ? false : null;
    const authorization = input.topicResumeReplan;
    if (!authorization) return false;
    const evidence = this.inspect(input.jobId, input.eventAt, authorization.external);
    if (!evidence) return false;
    const part = evidence.selected;
    const fence = authorization.fence;
    if (authorization.quarantined !== false || !part || part.partKey === "status-anchor"
      || part.partKey !== input.partKey || part.state !== input.expectedState
      || part.attemptCount !== input.expectedAttemptCount || part.contentHash !== input.expectedContentHash
      || evidence.job.version !== input.expectedJobVersion
      || (part.state === "sending" ? !fence || fence.actionToken !== evidence.resume.actionToken
        || fence.jobVersion !== evidence.job.version || !isDeepStrictEqual(fence.part, part)
        || !isDeepStrictEqual(fence.job, evidence.job)
        : input.reasonCode !== "rich_method_unavailable" || fence !== undefined
          || !sendable(part, evidence.resume, input.eventAt))
      || input.reasonCode === "rich_local_fallback") {
      this.stale(evidence.resume, input.eventAt);
      return false;
    }
    return evidence.resume;
  }

  advanceReplan(resume: TelegramTopicResumeRecord, result: ReplanRichDeliveryResult): void {
    if (!orderedDeliveryEvidence(result.job, resume, result.deliveries)) throw new Error("Telegram delivery conflict");
    const hash = hashTelegramTopicResumeTopology(result.job, result.deliveries);
    const changed = this.host.statement(`UPDATE topic_resume_attempts
      SET delivery_topology_hash = ?, current_job_version = ?, updated_at_ms = ?
      WHERE job_id = ? AND action_token = ? AND state = 'delivery_handoff'
        AND delivery_topology_hash = ? AND current_job_version = ?
        AND next_attempt_at_ms IS NULL AND reason_code IS NULL`).run(hash, result.job.version,
      result.job.updatedAt, resume.jobId, resume.actionToken, resume.deliveryTopologyHash, resume.currentJobVersion);
    if (changed.changes !== 1) throw new Error("Telegram topic resume conflict");
  }

  rejectReplan(resume: TelegramTopicResumeRecord, now: number): void {
    this.quarantine(resume.jobId, now);
  }

  contain(now: number, readExternal?: (jobId: string) => TelegramTopicResumeExternalEligibilitySnapshot): void {
    const rows = this.host.statement(`SELECT job_id FROM topic_resume_attempts
      WHERE NOT EXISTS (SELECT 1 FROM job_quarantine
        WHERE job_quarantine.job_id = topic_resume_attempts.job_id)`).all() as { job_id: string }[];
    for (const row of rows) this.host.database.transaction(() => {
      let resume: TelegramTopicResumeRecord | null;
      try { resume = this.host.resume.get(row.job_id); }
      catch { this.quarantine(row.job_id, now); return; }
      if (!resume || resume.state === "failed" || resume.state === "complete") return;
      let external: TelegramTopicResumeExternalEligibilitySnapshot | undefined;
      try { external = readExternal?.(row.job_id); }
      catch { this.quarantine(row.job_id, now); return; }
      this.inspect(row.job_id, now, external, true);
    }).immediate();
  }

  authorize(job: TelegramJob, part: DeliveryPart, now: number,
    external?: TelegramTopicResumeExternalEligibilitySnapshot): TelegramTopicResumeDeliveryAuthorization | null {
    return this.host.database.transaction(() => {
      const evidence = this.inspect(job.id, now, external);
      if (!evidence || !external) return null;
      if (!isDeepStrictEqual(evidence.job, job) || !isDeepStrictEqual(evidence.selected, part)) {
        this.stale(evidence.resume, now);
        return null;
      }
      if (!sendable(part, evidence.resume, now)) return null;
      return structuredClone({ job, part, resume: evidence.resume, external, authorizedAt: now });
    }).immediate();
  }

  beforeTransition(input: ProjectedDeliveryTransitionInput): TelegramTopicResumeRecord | null | false {
    if (input.state === "sending" && input.topicResumeAuthorization) {
      const auth = input.topicResumeAuthorization;
      if (auth.job.id !== input.jobId || auth.part.partKey !== input.partKey) return false;
      let current: TelegramTopicResumeRecord | null = null;
      try { current = this.host.resume.get(input.jobId); }
      catch { /* Malformed replacement is also a loss of the captured ownership. */ }
      if (!isDeepStrictEqual(current, auth.resume)) {
        // Denial must remain durable if the captured owner disappears or is
        // replaced before sending CAS. Do not settle a replacement owner's row.
        this.quarantine(input.jobId, input.updatedAt, false);
        return false;
      }
    }
    if (!this.hasResume(input.jobId)) {
      if (input.topicResumeAuthorization || (input.state === "sending" && input.topicResumeFence)) return false;
      // The successful sending CAS already proved ownership. Losing its ledger row
      // cannot turn the observed outcome into permission for ordinary continuation.
      if (input.topicResumeFence) this.quarantine(input.jobId, input.updatedAt);
      return null;
    }
    if (input.state === "sending") {
      const auth = input.topicResumeAuthorization;
      // Untrusted direct calls cannot mutate even malformed ownership.
      if (!auth || auth.job.id !== input.jobId || auth.part.partKey !== input.partKey) return false;
      const evidence = this.inspect(input.jobId, input.updatedAt, auth.external);
      if (!evidence) return false;
      if (!isDeepStrictEqual(evidence.resume, auth.resume)
        || !isDeepStrictEqual(evidence.job, auth.job)
        || !isDeepStrictEqual(evidence.selected, auth.part)
        || input.expectedJobVersion !== auth.job.version
        || input.expectedState !== auth.part.state || input.expectedAttemptCount !== auth.part.attemptCount
        || input.attemptCount !== auth.part.attemptCount
        || input.expectedContentHash !== auth.part.contentHash
        || input.telegramMessageId != null || input.lastErrorCode !== null
        || input.nextAttemptAt == null || input.nextAttemptAt <= input.updatedAt
        || !sendable(auth.part, evidence.resume, input.updatedAt)) {
        this.stale(evidence.resume, input.updatedAt);
        return false;
      }
      return evidence.resume;
    }
    let resume: TelegramTopicResumeRecord | null;
    try { resume = this.host.resume.get(input.jobId); }
    catch { this.quarantine(input.jobId, input.updatedAt); return null; }
    const fence = input.topicResumeFence;
    if (!resume || (resume.state !== "delivery_handoff"
      && !(resume.state === "failed" && resume.reasonCode === "TOPIC_RESUME_EVIDENCE_STALE" && fence))) return null;
    if (resume.currentJobVersion !== input.expectedJobVersion
      || (fence && (fence.actionToken !== resume.actionToken || fence.jobVersion !== input.expectedJobVersion))) {
      this.stale(resume, input.updatedAt);
      return null;
    }
    try {
      const job = this.host.getJob(input.jobId);
      const rows = this.deliveryRows(input.jobId);
      if (!job || !orderedDeliveryEvidence(job, resume, rows)
        || hashTelegramTopicResumeTopology(job, rows) !== resume.deliveryTopologyHash) {
        this.quarantine(input.jobId, input.updatedAt);
        return null;
      }
    } catch { this.quarantine(input.jobId, input.updatedAt); return null; }
    return resume;
  }

  advance(resume: TelegramTopicResumeRecord | null, job: TelegramJob, part?: DeliveryPart): void {
    if (!resume) return;
    const result = this.host.statement(`UPDATE topic_resume_attempts
      SET current_job_version = ?, updated_at_ms = ?
      WHERE job_id = ? AND action_token = ? AND state = ?
        AND current_job_version = ? AND reason_code IS ? AND next_attempt_at_ms IS NULL`).run(
      job.version, job.updatedAt, job.id, resume.actionToken, resume.state, resume.currentJobVersion, resume.reasonCode,
    );
    if (result.changes !== 1) throw new Error("Telegram topic resume conflict");
    if (resume.state === "delivery_handoff"
      && (part?.state === "failed" || part?.state === "uncertain" || job.phase === "terminal")) {
      try {
        this.host.resume.settleDelivery({ jobId: job.id, expectedVersion: job.version,
          actionToken: resume.actionToken, updatedAt: job.updatedAt });
      } catch { this.quarantine(job.id, job.updatedAt); }
    }
  }

  recordOutcomeAfterCorruption(input: ProjectedDeliveryTransitionInput) {
    const fence = input.topicResumeFence;
    if (!fence || input.state === "sending" || fence.part.state !== "sending"
      || fence.part.jobId !== input.jobId || fence.part.partKey !== input.partKey
      || input.expectedState !== "sending" || input.expectedAttemptCount !== fence.part.attemptCount
      || input.expectedContentHash !== fence.part.contentHash
      || input.attemptCount < fence.part.attemptCount || input.attemptCount > fence.part.attemptCount + 1
      || input.updatedAt < fence.part.updatedAt) return null;
    const delivery: DeliveryPart = { ...fence.part, state: input.state, attemptCount: input.attemptCount,
      telegramMessageId: input.telegramMessageId ?? null, nextAttemptAt: input.nextAttemptAt ?? null,
      lastErrorCode: input.lastErrorCode ?? null, updatedAt: input.updatedAt };
    validateDelivery(delivery);
    return this.host.database.transaction(() => {
      // This fence was captured by the successful sending CAS. Recording its actual
      // outcome authorizes no effect and must survive corruption of that same row.
      // Preserve existing damaged payload/topology for audit; if deleted, restore
      // only the already-authorized tuple. Quarantine blocks all later effects.
      this.quarantine(input.jobId, input.updatedAt);
      const saved = this.host.statement(`INSERT INTO deliveries
        (job_id, part_key, ordinal, kind, payload_json, content_hash, state, telegram_message_id,
          attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, part_key) DO UPDATE SET state = excluded.state,
          telegram_message_id = excluded.telegram_message_id, attempt_count = excluded.attempt_count,
          next_attempt_at_ms = excluded.next_attempt_at_ms, last_error_code = excluded.last_error_code,
          updated_at_ms = excluded.updated_at_ms`).run(
        delivery.jobId, delivery.partKey, delivery.ordinal, delivery.kind,
        JSON.stringify(delivery.payload), delivery.contentHash, delivery.state, delivery.telegramMessageId,
        delivery.attemptCount, delivery.nextAttemptAt, delivery.lastErrorCode, delivery.updatedAt,
      );
      if (saved.changes !== 1) return null;
      return { delivery, job: fence.job };
    }).immediate();
  }

  beforeFinalization(jobId: string, now: number): TelegramTopicResumeRecord | null | false {
    if (!this.hasResume(jobId)) return null;
    try {
      const resume = this.host.resume.get(jobId);
      const job = this.host.getJob(jobId);
      if (!resume || resume.state !== "delivery_handoff" || !job
        || resume.currentJobVersion !== job.version || this.host.resume.hasJobQuarantine(jobId)) return false;
      // Finalization performs no Telegram effect, but still requires exact delivered tuples.
      const rows = this.deliveryRows(jobId);
      if (!orderedDeliveryEvidence(job, resume, rows) || rows.some((row) => row.state !== "delivered")
        || hashTelegramTopicResumeTopology(job, rows) !== resume.deliveryTopologyHash) {
        this.quarantine(jobId, now);
        return false;
      }
      return resume;
    } catch { this.quarantine(jobId, now); return false; }
  }

  private inspect(jobId: string, now: number,
    external?: TelegramTopicResumeExternalEligibilitySnapshot, allowPreDelivery = false): Evidence | null {
    if (this.host.resume.hasJobQuarantine(jobId)) return null;
    if (external !== undefined && (!external || typeof external !== "object"
      || typeof external.hasThreadTopicBinding !== "boolean"
      || !Number.isSafeInteger(external.forumChatId) || external.forumChatId === 0
      || (external.thread !== null && (typeof external.thread !== "object" || Array.isArray(external.thread))))) {
      this.quarantine(jobId, now);
      return null;
    }
    let resume: TelegramTopicResumeRecord | null;
    let job: TelegramJob | null;
    try { resume = this.host.resume.get(jobId); job = this.host.getJob(jobId); }
    catch { this.quarantine(jobId, now); return null; }
    if (!resume || resume.state === "failed" || resume.state === "complete"
      || (!allowPreDelivery && resume.state !== "delivery_handoff")) return null;
    if (!job) { this.quarantine(jobId, now); return null; }
    if (job.version !== resume.currentJobVersion) { this.stale(resume, now); return null; }
    let evidence: ReturnType<TelegramTopicResumeLedger["deliveryEligibilityInput"]>;
    try {
      evidence = this.host.resume.deliveryEligibilityInput(job,
        external ?? { thread: null, forumChatId: resume.destination.chatId, hasThreadTopicBinding: false }, true);
    } catch { this.quarantine(jobId, now); return null; }
    if (!evidence || !orderedDeliveryEvidence(job, resume, evidence.deliveries)) {
      this.quarantine(jobId, now);
      return null;
    }
    const rows = evidence.deliveries;
    if (resume.state !== "delivery_handoff" && !isTelegramTopicResumeContinuationValid({
      ...evidence, ...resume, hasExistingAttempt: true,
    })) {
      this.stale(resume, now);
      return null;
    }
    // Restore only mutable delivery progress to the reservation baseline. The canonical
    // source, recovery, plan, binding and topology still come from fresh persisted evidence.
    const baseline = rows.map((row) => ({ ...row,
      state: row.partKey === "status-anchor" ? "failed" as const : "pending" as const,
      attemptCount: row.partKey === "status-anchor" ? resume.anchorAttemptBaseline : 0,
      telegramMessageId: null, nextAttemptAt: null,
      lastErrorCode: row.partKey === "status-anchor" ? "telegram_permanent" : null,
    }));
    const baselineJob: TelegramJob = { ...job, phase: "delivering", deliveries: job.responsePlan!.map((part) => ({
      partId: part.partId, state: "pending", attempts: 0, messageId: null, deliveredAt: null,
    })) };
    if (!isTelegramTopicResumeContinuationValid({ ...evidence, job: baselineJob, deliveries: baseline,
      ...resume, hasExistingAttempt: true,
    }) || !isDeepStrictEqual(evidence.recovery?.oldDestination, resume.destination)) {
      this.stale(resume, now);
      return null;
    }
    const ordered = [rows.find((row) => row.partKey === "status-anchor")!,
      ...job.responsePlan!.map((part) => rows.find((row) => row.partKey === part.partId)!)];
    return { job, resume, rows, selected: ordered.find((row) => row.state !== "delivered") };
  }

  private deliveryRows(jobId: string): readonly DeliveryPart[] {
    const job = this.host.getJob(jobId)!;
    return this.host.resume.deliveryEligibilityInput(job, {
      thread: null, forumChatId: 1, hasThreadTopicBinding: false,
    }, true)?.deliveries ?? [];
  }

  private stale(resume: TelegramTopicResumeRecord, now: number): void {
    this.host.statement(`UPDATE topic_resume_attempts SET state = 'failed',
      reason_code = 'TOPIC_RESUME_EVIDENCE_STALE', next_attempt_at_ms = NULL, updated_at_ms = ?
      WHERE job_id = ? AND action_token = ? AND state = ? AND current_job_version = ?`).run(
      Math.max(now, resume.updatedAt), resume.jobId, resume.actionToken, resume.state, resume.currentJobVersion,
    );
  }

  private quarantine(jobId: string, now: number, settleAttempt = true): void {
    const raw = this.host.statement("SELECT * FROM topic_resume_attempts WHERE job_id = ?").get(jobId);
    const fingerprint = createHash("sha256").update(jobId).update("\0")
      .update(JSON.stringify(raw ?? null)).digest("hex");
    this.host.statement(`INSERT INTO job_quarantine (job_id, reason_code, fingerprint, quarantined_at_ms)
      VALUES (?, 'malformed_topic_resume_evidence', ?, ?) ON CONFLICT(job_id) DO NOTHING`).run(jobId, fingerprint, now);
    if (!settleAttempt) return;
    let resume: TelegramTopicResumeRecord | null;
    try { resume = this.host.resume.get(jobId); }
    catch { return; }
    if (resume && resume.state !== "failed" && resume.state !== "complete") this.stale(resume, now);
  }
}

export function orderedDeliveryEvidence(job: TelegramJob, resume: TelegramTopicResumeRecord,
  rows: readonly DeliveryPart[]): boolean {
  if (!job.responsePlan || rows.length !== job.responsePlan.length + 1) return false;
  const anchor = rows.filter((row) => row.partKey === "status-anchor");
  if (anchor.length !== 1) return false;
  const ordered = [anchor[0]!, ...job.responsePlan.flatMap((planned) => rows.filter((row) => row.partKey === planned.partId))];
  if (ordered.length !== rows.length || new Set(ordered.map((row) => row.partKey)).size !== rows.length) return false;
  const projection = ordered.slice(1).map((row) => ({ partId: row.partKey, state: row.state,
    attempts: row.attemptCount, messageId: row.telegramMessageId,
    deliveredAt: row.state === "delivered" ? row.updatedAt : null }));
  if (!isDeepStrictEqual(job.deliveries, projection)) return false;
  let selected = false;
  for (const [index, row] of ordered.entries()) {
    const baseline = index === 0 ? resume.anchorAttemptBaseline : 0;
    if (!selected && row.state === "delivered") {
      if (row.attemptCount !== baseline + 1 || row.telegramMessageId === null
        || row.telegramMessageId < 1 || row.nextAttemptAt !== null || row.lastErrorCode !== null) return false;
    } else if (selected) {
      if (!pristine(row)) return false;
    } else {
      selected = true;
      if (row.telegramMessageId !== null || row.attemptCount !== baseline) return false;
      if (row.state === "sending") {
        if (row.nextAttemptAt === null || row.lastErrorCode !== null) return false;
      } else if (!(index === 0 && row.state === "failed" && row.lastErrorCode === "telegram_permanent"
          && row.nextAttemptAt === null)
        && !(row.state === "pending" && ((index > 0 && pristine(row)) || safeRetry(row)))) return false;
    }
  }
  return job.phase === "delivering" || (!selected && job.phase === "terminal" && job.outcome === "completed");
}

function pristine(row: DeliveryPart): boolean {
  return row.state === "pending" && row.attemptCount === 0 && row.telegramMessageId === null
    && row.nextAttemptAt === null && row.lastErrorCode === null;
}
function safeRetry(row: DeliveryPart): boolean {
  return row.nextAttemptAt !== null
    && (row.lastErrorCode === "telegram_retry_after" || row.lastErrorCode === "telegram_not_sent");
}
function sendable(part: DeliveryPart, resume: TelegramTopicResumeRecord, now: number): boolean {
  return part.state !== "sending" && (part.nextAttemptAt === null || part.nextAttemptAt <= now)
    && (part.partKey !== "status-anchor" || part.attemptCount === resume.anchorAttemptBaseline);
}
