import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  alertFromRow, assertAlertState, assertFingerprint, assertNonEmptyString,
  assertOptionalString, assertOptionalThreadName, assertPositiveFinite, assertRepairOutcome, assertRoute,
  assertSnapshotMatchesFingerprint, assertTelegramMessageId, assertTimestamp,
  decodeAlertState, decodeRepairAttempt, isAllowedTransition, isNonEmptyString,
  isRecord, isTerminalAlertState, observationFromRow,
} from "./session-guardian-store-codec.js";
import { initializeAndValidateGuardianSchema } from "./session-guardian-store-schema.js";
import type {
  GuardianAlertState,
  GuardianFingerprint,
  GuardianRepairOutcome,
  GuardianRoute,
  GuardianThreadSnapshot,
} from "./session-guardian-types.js";
const BUSY_TIMEOUT_MS = 5_000;
/** An abandoned repair claim may be taken over after five minutes. */
export const REPAIR_CLAIM_LEASE_MS = 5 * 60_000;
const OPEN_ALERT_STATES: readonly GuardianAlertState[] = ["open", "checking"];
export type { GuardianAlert, GuardianAlertCreation, GuardianDeliveryState,
  GuardianObservation, GuardianSelfRecoveryClosure, GuardianStatusDeliveryState }
  from "./session-guardian-store-codec.js";
import type { GuardianAlert, GuardianAlertCreation, GuardianObservation,
  GuardianSelfRecoveryClosure } from "./session-guardian-store-codec.js";
export interface SessionGuardianStoreOptions {
  repairClaimLeaseMs?: number;
  hardenFile?: (filePath: string) => void;
}
export interface GuardianThreadObservation {
  readonly observation: GuardianObservation;
  readonly alert: GuardianAlert | null;
  readonly repairOutcome: GuardianRepairOutcome | null;
}
export class SessionGuardianStore {
  private readonly database: Database.Database;
  private readonly repairClaimLeaseMs: number;
  private readonly hardenFile: (filePath: string) => void;
  private readonly ownedClaims = new Map<string, string>();
  private closed = false;
  constructor(
    private readonly databasePath: string,
    options: SessionGuardianStoreOptions = {},
  ) {
    this.repairClaimLeaseMs = options.repairClaimLeaseMs ?? REPAIR_CLAIM_LEASE_MS;
    assertPositiveFinite(this.repairClaimLeaseMs, "repairClaimLeaseMs");
    this.hardenFile = options.hardenFile ?? ((filePath) => chmodSync(filePath, 0o600));
    prepareDatabaseFile(databasePath);
    this.database = new Database(databasePath);
    try {
      this.database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("foreign_keys = ON");
      initializeAndValidateGuardianSchema(this.database);
      this.hardenDatabaseFiles(true);
    } catch (error) {
      this.closed = true;
      try { this.database.close(); } catch { /* Preserve the constructor error. */ }
      throw error;
    }
  }
  upsertObservation(
    snapshot: GuardianThreadSnapshot,
    fingerprint: GuardianFingerprint,
    observedAt: number,
  ): GuardianObservation {
    this.assertOpen();
    assertSnapshotMatchesFingerprint(snapshot, fingerprint);
    assertFingerprint(fingerprint);
    assertTimestamp(observedAt, "observedAt");
    const row = this.database.prepare(`
      INSERT INTO observations (
        thread_id, turn_id, fingerprint_updated_at, item_count, last_item_type,
        first_observed_at, last_observed_at, unchanged_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(thread_id) DO UPDATE SET
        first_observed_at = CASE WHEN
          observations.turn_id = excluded.turn_id
          AND observations.fingerprint_updated_at = excluded.fingerprint_updated_at
          AND observations.item_count = excluded.item_count
          AND observations.last_item_type IS excluded.last_item_type
        THEN observations.first_observed_at ELSE excluded.first_observed_at END,
        unchanged_count = CASE WHEN
          observations.turn_id = excluded.turn_id
          AND observations.fingerprint_updated_at = excluded.fingerprint_updated_at
          AND observations.item_count = excluded.item_count
          AND observations.last_item_type IS excluded.last_item_type
        THEN observations.unchanged_count + 1 ELSE 1 END,
        turn_id = excluded.turn_id,
        fingerprint_updated_at = excluded.fingerprint_updated_at,
        item_count = excluded.item_count,
        last_item_type = excluded.last_item_type,
        last_observed_at = excluded.last_observed_at
      WHERE excluded.last_observed_at >= observations.last_observed_at
      RETURNING *
    `).get(
      fingerprint.threadId, fingerprint.turnId, fingerprint.updatedAt, fingerprint.itemCount,
      fingerprint.lastItemType, observedAt, observedAt,
    );
    this.hardenDatabaseFiles(false);
    if (row === undefined) throw new Error("Observation time cannot move backwards");
    return observationFromRow(row);
  }
  clearObservation(threadId: string): void {
    this.assertOpen();
    assertNonEmptyString(threadId, "threadId");
    this.database.prepare("DELETE FROM observations WHERE thread_id = ?").run(threadId);
    this.hardenDatabaseFiles(false);
  }
  getObservation(threadId: string): GuardianObservation | undefined {
    this.assertOpen();
    if (!isNonEmptyString(threadId)) return undefined;
    const row = this.database.prepare(
      "SELECT * FROM observations WHERE thread_id = ?",
    ).get(threadId);
    return row === undefined ? undefined : observationFromRow(row);
  }
  listObservationThreadIds(): string[] {
    this.assertOpen();
    return this.database.prepare(
      "SELECT DISTINCT thread_id FROM observations ORDER BY thread_id",
    ).all().map((row) => {
      if (!isRecord(row) || !isNonEmptyString(row.thread_id)) {
        throw new Error("Invalid guardian observation row: thread_id");
      }
      return row.thread_id;
    });
  }
  inspectThreadObservation(threadId: string): GuardianThreadObservation | undefined {
    this.assertOpen();
    if (!isNonEmptyString(threadId)) return undefined;
    const inspect = this.database.transaction(() => {
      const observationRow = this.database.prepare(
        "SELECT * FROM observations WHERE thread_id = ? LIMIT 1",
      ).get(threadId);
      if (observationRow === undefined) return undefined;
      const observation = observationFromRow(observationRow);
      const fingerprint = observation.fingerprint;
      const alertRow = this.database.prepare(`
        SELECT * FROM alerts
        WHERE thread_id = ? AND turn_id = ? AND fingerprint_updated_at = ?
          AND item_count = ? AND last_item_type IS ?
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(fingerprint.threadId, fingerprint.turnId, fingerprint.updatedAt,
        fingerprint.itemCount, fingerprint.lastItemType);
      if (alertRow === undefined) {
        return Object.freeze({ observation, alert: null, repairOutcome: null });
      }
      const alert = alertFromRow(alertRow);
      const attemptRow = this.database.prepare(
        "SELECT outcome FROM repair_attempts WHERE alert_id = ? LIMIT 1",
      ).get(alert.id);
      let repairOutcome: GuardianRepairOutcome | null = null;
      if (attemptRow !== undefined) {
        if (!isRecord(attemptRow) || attemptRow.outcome === undefined) {
          throw new Error("Invalid guardian repair attempt row: outcome");
        }
        if (attemptRow.outcome !== null) {
          assertRepairOutcome(attemptRow.outcome);
          repairOutcome = attemptRow.outcome;
        }
      }
      return Object.freeze({ observation, alert, repairOutcome });
    });
    return inspect.deferred();
  }
  createAlert(
    fingerprint: GuardianFingerprint,
    route: GuardianRoute,
    createdAt: number,
    threadName?: string | null,
  ): GuardianAlert {
    return this.createAlertIfAbsent(fingerprint, route, createdAt, threadName).alert;
  }
  createAlertIfAbsent(
    fingerprint: GuardianFingerprint,
    route: GuardianRoute,
    createdAt: number,
    threadName?: string | null,
  ): GuardianAlertCreation {
    this.assertOpen();
    assertFingerprint(fingerprint);
    assertRoute(route);
    assertTimestamp(createdAt, "createdAt");
    assertOptionalThreadName(threadName);
    const inserted = this.database.prepare(`
      INSERT INTO alerts (
        id, thread_id, turn_id, fingerprint_updated_at, item_count, last_item_type,
        route_chat_id, route_message_thread_id, state, created_at, thread_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(thread_id, turn_id) DO NOTHING
      RETURNING *
    `).get(
      randomToken(), fingerprint.threadId, fingerprint.turnId, fingerprint.updatedAt,
      fingerprint.itemCount, fingerprint.lastItemType, route.chatId,
      route.messageThreadId ?? null, createdAt, threadName ?? null,
    );
    this.hardenDatabaseFiles(false);
    if (inserted !== undefined) return { alert: alertFromRow(inserted), created: true };
    const row = this.database.prepare(
      "SELECT * FROM alerts WHERE thread_id = ? AND turn_id = ?",
    ).get(fingerprint.threadId, fingerprint.turnId);
    return { alert: alertFromRow(row), created: false };
  }
  getAlert(alertId: string): GuardianAlert | undefined {
    this.assertOpen();
    if (!isNonEmptyString(alertId)) return undefined;
    const row = this.database.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId);
    return row === undefined ? undefined : alertFromRow(row);
  }
  markAlert(alertId: string, state: GuardianAlertState, detail?: string): void {
    this.assertOpen();
    assertAlertState(state);
    assertOptionalString(detail, "detail");
    const mark = this.database.transaction(() => {
      const current = this.database.prepare("SELECT state FROM alerts WHERE id = ?").get(alertId);
      if (!isRecord(current)) throw new Error("Unknown guardian alert");
      const currentState = decodeAlertState(current.state, "state");
      if (!isAllowedTransition(currentState, state)) {
        throw new Error(`Invalid guardian alert transition: ${currentState} -> ${state}`);
      }
      const result = this.database.prepare(`UPDATE alerts SET state = ?, detail = ?,
        status_delivery_state = CASE
          WHEN delivery_state = 'delivered' AND ? = 1 THEN 'pending'
          ELSE status_delivery_state END
        WHERE id = ? AND state = ?`).run(
        state, detail ?? null, isTerminalAlertState(state) ? 1 : 0, alertId, currentState,
      );
      if (result.changes !== 1) throw new Error("Guardian alert changed concurrently");
    });
    mark.immediate();
    this.hardenDatabaseFiles(false);
  }
  markOpenAlertSelfRecovered(alertId: string, detail: string): GuardianSelfRecoveryClosure {
    this.assertOpen();
    assertNonEmptyString(alertId, "alertId");
    assertNonEmptyString(detail, "detail");
    const close = this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE alerts SET state = 'self-recovered', detail = ?,
          status_delivery_state = CASE WHEN delivery_state = 'delivered'
            THEN 'pending' ELSE 'none' END
        WHERE id = ? AND state = 'open' RETURNING *
      `).get(detail, alertId);
      if (updated !== undefined) return { alert: alertFromRow(updated), closed: true };
      const current = this.database.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId);
      if (current === undefined) throw new Error("Unknown guardian alert");
      return { alert: alertFromRow(current), closed: false };
    });
    try { return close.immediate(); } finally { this.hardenDatabaseFiles(false); }
  }
  recordDelivery(alertId: string, messageId: number): GuardianAlert {
    this.assertOpen();
    assertNonEmptyString(alertId, "alertId");
    assertTelegramMessageId(messageId);
    const record = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId);
      if (row === undefined) throw new Error("Unknown guardian alert");
      const current = alertFromRow(row);
      if (current.deliveryState === "delivered") {
        if (current.messageId === messageId) return current;
        throw new Error("Guardian alert delivery message conflicts"); }
      const updated = this.database.prepare(`UPDATE alerts
        SET delivery_state = 'delivered', delivery_message_id = ?,
          status_delivery_state = CASE WHEN state IN
            ('restored','self-recovered','observation-only','repair-disabled','expired','failed')
            THEN 'pending' ELSE 'none' END
        WHERE id = ? AND delivery_state IN ('pending','failed') RETURNING *`).get(
        messageId, alertId,
      );
      if (updated === undefined) throw new Error("Guardian alert delivery changed concurrently");
      return alertFromRow(updated);
    });
    try { return record.immediate(); } finally { this.hardenDatabaseFiles(false); }
  }
  markDeliveryFailed(alertId: string): GuardianAlert {
    this.assertOpen();
    assertNonEmptyString(alertId, "alertId");
    const mark = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId);
      if (row === undefined) throw new Error("Unknown guardian alert");
      const current = alertFromRow(row);
      if (current.deliveryState === "delivered" || current.deliveryState === "failed") return current;
      const updated = this.database.prepare(`UPDATE alerts
        SET delivery_state = 'failed', delivery_message_id = NULL
        WHERE id = ? AND delivery_state = 'pending' RETURNING *`).get(alertId);
      if (updated === undefined) throw new Error("Guardian alert delivery changed concurrently");
      return alertFromRow(updated);
    });
    try { return mark.immediate(); } finally { this.hardenDatabaseFiles(false); }
  }
  listAlertsNeedingStatusDelivery(): GuardianAlert[] {
    this.assertOpen();
    return this.database.prepare(`SELECT * FROM alerts
      WHERE status_delivery_state IN ('pending','failed') ORDER BY created_at, id`)
      .all().map(alertFromRow);
  }
  recordStatusDelivery(alertId: string): GuardianAlert {
    return this.updateStatusDelivery(alertId, "delivered");
  }
  markStatusDeliveryFailed(alertId: string): GuardianAlert {
    return this.updateStatusDelivery(alertId, "failed");
  }
  claimRepair(alertId: string, startedAt: number): boolean {
    this.assertOpen();
    if (!isNonEmptyString(alertId)) return false;
    assertTimestamp(startedAt, "startedAt");
    if (this.ownedClaims.has(alertId)) return false;
    const token = randomToken();
    const claim = this.database.transaction(() => {
      const row = this.database.prepare(`
        INSERT INTO repair_attempts (alert_id, claim_token, started_at)
        SELECT id, ?, ? FROM alerts WHERE id = ? AND state IN ('open', 'checking')
        ON CONFLICT(alert_id) DO UPDATE SET
          claim_token = excluded.claim_token,
          started_at = excluded.started_at,
          outcome = NULL,
          detail = NULL,
          finished_at = NULL
        WHERE repair_attempts.finished_at IS NULL
          AND repair_attempts.started_at <= ?
        RETURNING alert_id
      `).get(token, startedAt, alertId, startedAt - this.repairClaimLeaseMs);
      if (row === undefined) return false;
      const result = this.database.prepare(`
        UPDATE alerts SET state = 'checking', detail = NULL
        WHERE id = ? AND state IN ('open', 'checking')
      `).run(alertId);
      if (result.changes !== 1) throw new Error("Guardian alert changed concurrently");
      return true;
    });
    const claimed = claim.immediate();
    if (claimed) this.ownedClaims.set(alertId, token);
    this.hardenDatabaseFiles(false);
    return claimed;
  }
  finishRepair(alertId: string, outcome: GuardianRepairOutcome,
    detail: string, finishedAt: number): void {
    this.assertOpen();
    assertRepairOutcome(outcome);
    assertNonEmptyString(detail, "detail");
    assertTimestamp(finishedAt, "finishedAt");
    const token = this.ownedClaims.get(alertId);
    if (!token) throw new Error("Unknown guardian repair attempt");
    const finish = this.database.transaction(() => {
      const row = this.database.prepare(
        "SELECT claim_token, started_at, finished_at FROM repair_attempts WHERE alert_id = ?",
      ).get(alertId);
      const attempt = decodeRepairAttempt(row);
      if (attempt.claimToken !== token || attempt.finishedAt !== null) {
        throw new Error("Guardian repair claim is not owned by this store");
      }
      if (finishedAt < attempt.startedAt) {
        throw new Error("Repair finish time cannot precede its claim");
      }
      const alert = this.database.prepare(`UPDATE alerts SET state = ?, detail = ?,
        status_delivery_state = CASE WHEN delivery_state = 'delivered'
          THEN 'pending' ELSE 'none' END
        WHERE id = ? AND state = 'checking'`).run(outcome, detail, alertId);
      if (alert.changes !== 1) throw new Error("Guardian alert is no longer repairable");
      const attemptResult = this.database.prepare(`
        UPDATE repair_attempts SET outcome = ?, detail = ?, finished_at = ?
        WHERE alert_id = ? AND claim_token = ? AND finished_at IS NULL
      `).run(outcome, detail, finishedAt, alertId, token);
      if (attemptResult.changes !== 1) {
        throw new Error("Guardian repair claim is not owned by this store");
      }
    });
    try {
      finish.immediate();
      this.ownedClaims.delete(alertId);
    } catch (error) {
      if (error instanceof Error
        && (error.message.includes("not owned") || error.message.includes("no longer repairable"))) {
        this.ownedClaims.delete(alertId);
      }
      throw error;
    } finally {
      this.hardenDatabaseFiles(false);
    }
  }
  listOpenAlerts(): GuardianAlert[] {
    this.assertOpen();
    const rows = this.database.prepare("SELECT * FROM alerts ORDER BY created_at, id").all();
    return rows.map(alertFromRow).filter((alert) => OPEN_ALERT_STATES.includes(alert.state));
  }
  private updateStatusDelivery(alertId: string, target: "failed" | "delivered"): GuardianAlert {
    this.assertOpen();
    assertNonEmptyString(alertId, "alertId");
    const update = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId);
      if (row === undefined) throw new Error("Unknown guardian alert");
      const current = alertFromRow(row);
      if (current.statusDeliveryState === "delivered") return current;
      if (target === "failed" && current.statusDeliveryState === "failed") return current;
      if (!isTerminalAlertState(current.state) || current.deliveryState !== "delivered"
        || current.statusDeliveryState === "none") {
        throw new Error("Guardian alert status delivery is not eligible");
      }
      const changed = this.database.prepare(`UPDATE alerts SET status_delivery_state = ?
        WHERE id = ? AND status_delivery_state IN ('pending','failed') RETURNING *`)
        .get(target, alertId);
      if (changed === undefined) throw new Error("Guardian alert status delivery changed concurrently");
      return alertFromRow(changed);
    });
    try { return update.immediate(); } finally { this.hardenDatabaseFiles(false); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.hardenDatabaseFiles(false); } finally {
      this.ownedClaims.clear();
      this.database.close();
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("SessionGuardianStore is closed");
  }
  private hardenDatabaseFiles(strict: boolean): void {
    for (const filePath of databaseFiles(this.databasePath)) {
      if (!existsSync(filePath)) continue;
      try { this.hardenFile(filePath); } catch (error) { if (strict) throw error; }
    }
  }
}

function prepareDatabaseFile(databasePath: string): void {
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const descriptor = openSync(databasePath, "a", 0o600);
  try { chmodSync(databasePath, 0o600); } finally { closeSync(descriptor); }
}
function databaseFiles(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]; }
function randomToken(): string { return randomBytes(16).toString("base64url"); }
