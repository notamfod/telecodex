import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  TelegramJobMigrationError, type MigrationReason, type MigrationReport, type ParityMismatch,
  type ParityReport, type QuarantineItem, type ShadowSyncReport,
} from "./telegram-job-migration-contract.js";
import { SqliteTelegramJobStore, type TransitionEvent } from "./telegram-job-ledger.js";
import { storagePathsAlias } from "./telegram-job-storage-path.js";
import { transitionJob } from "./telegram-job-transition.js";
import {
  TELEGRAM_STATUS_ANCHOR_PART_KEY,
  type TelegramDeliveryPart,
  type TelegramJob,
  type TelegramResponsePlanPart,
  type TelegramSourceKey,
} from "./telegram-job-types.js";
const MARKER_KEY = "legacy-json-migration";
const DEFAULT_VERSION = "1";
const MAX_QUARANTINE_ITEMS = 1_000;
const MAX_MISMATCHES = 1_000;
export { TelegramJobMigrationError } from "./telegram-job-migration-contract.js";
export type { MigrationErrorCode, MigrationReason, MigrationReport, ParityMismatch, ParityReport,
  QuarantineItem, ShadowSyncReport } from "./telegram-job-migration-contract.js";
export { exportLegacyTelegramJobs } from "./telegram-job-migration-export.js";
interface ImportOptions {
  readonly sourcePath: string; readonly databasePath: string; readonly migrationVersion?: string;
  readonly allowSourceChange?: boolean;
}
interface CompareOptions { readonly sourcePath: string; readonly databasePath: string; readonly expectedChecksum?: string; }
interface LegacyEntry {
  readonly raw: Record<string, unknown>; readonly ordinal: number; readonly id: string;
  readonly contextKey: string; readonly chatId: number; readonly messageThreadId?: number;
  readonly threadId: string | null; readonly turnId?: string; readonly state: LegacyState;
  readonly sentPartKeys: readonly string[]; readonly createdAt: number; readonly updatedAt: number;
}
type LegacyState = "awaiting-model" | "waiting" | "active" | "delivering" | "completed" | "failed" | "aborted";
interface Snapshot {
  readonly checksum: string; readonly entries: readonly LegacyEntry[];
  readonly quarantinedCount: number; readonly quarantined: readonly QuarantineItem[];
}
interface MigrationMarker {
  readonly status: "in_progress" | "complete"; readonly version: string; readonly checksum: string;
  readonly sourceIdentity: "synthetic"; readonly importedCount: number;
  readonly quarantinedCount: number; readonly quarantined: readonly QuarantineItem[];
}
interface ImportFlow {
  readonly initial: TelegramJob; readonly events: readonly TransitionEvent[];
  readonly legacy: Record<string, unknown>; readonly migrationVersion: string;
}
export function importLegacyTelegramJobs(options: ImportOptions): MigrationReport {
  assertSourcePath(options);
  const snapshot = readSnapshot(options.sourcePath);
  const version = migrationVersion(options.migrationVersion);
  const store = openStore(options.databasePath);
  try {
    const existing = migrationMarker(store.getMetadata(MARKER_KEY));
    const markerChanged = existing && (existing.checksum !== snapshot.checksum || existing.version !== version);
    const explicitOverride = options.allowSourceChange === true
      || (options.migrationVersion !== undefined && existing?.version !== version);
    if (markerChanged && !explicitOverride) {
      throw new TelegramJobMigrationError("SOURCE_CHECKSUM_MISMATCH");
    }
    if (existing?.status === "complete" && !markerChanged) return report(existing, "already_imported");
    const inProgress: MigrationMarker = {
      status: "in_progress", version, checksum: snapshot.checksum, sourceIdentity: "synthetic",
      importedCount: snapshot.entries.length, quarantinedCount: snapshot.quarantinedCount,
      quarantined: snapshot.quarantined,
    };
    store.setMetadata(MARKER_KEY, inProgress);
    for (const entry of snapshot.entries) {
      persistFlow(store, buildFlow(entry, snapshot.checksum, version), Boolean(markerChanged));
    }
    if (markerChanged && store.countJobs() > 0) {
      const ids = new Set(snapshot.entries.map((entry) => entry.id));
      if (store.listRecent(store.countJobs()).some((job) => !ids.has(job.id))) {
        throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [{ reasonCode: "REMOVED_JOB_CONFLICT" }]);
      }
    }
    const complete: MigrationMarker = { ...inProgress, status: "complete" };
    store.setMetadata(MARKER_KEY, complete);
    return report(complete, "imported");
  } catch (error) {
    if (error instanceof TelegramJobMigrationError) throw error;
    throw new TelegramJobMigrationError("MIGRATION_FAILED");
  } finally { store.close(); }
}
export function compareLegacyTelegramJobs(options: CompareOptions): ParityReport {
  assertSourcePath(options);
  const snapshot = readSnapshot(options.sourcePath);
  if (options.expectedChecksum && options.expectedChecksum !== snapshot.checksum) {
    throw new TelegramJobMigrationError("SOURCE_CHECKSUM_MISMATCH");
  }
  const store = openStore(options.databasePath);
  try {
    const mismatches: ParityMismatch[] = [];
    const sqliteCount = store.countJobs();
    if (snapshot.entries.length !== sqliteCount) mismatch(mismatches, { code: "COUNT_MISMATCH", field: "count" });
    const legacyIds = new Set(snapshot.entries.map((entry) => entry.id));
    for (const entry of snapshot.entries) {
      const actual = store.get(entry.id);
      if (!actual) { mismatch(mismatches, { code: "MISSING_JOB", jobId: entry.id, field: "id" }); continue; }
      const projected = finalProjection(buildFlow(entry, snapshot.checksum, DEFAULT_VERSION));
      const expected = entry.state === "awaiting-model" && actual.phase === "queued"
        ? { ...projected, phase: "queued" as const } : projected;
      compareField(mismatches, entry.id, "phase", expected.phase, actual.phase);
      compareField(mismatches, entry.id, "outcome", expected.outcome, actual.outcome);
      compareField(mismatches, entry.id, "threadId", expected.threadId, actual.threadId);
      compareField(mismatches, entry.id, "turnId", expected.turnId, actual.turnId);
      compareField(mismatches, entry.id, "attention", expected.attention, actual.attention);
      compareField(mismatches, entry.id, "responsePlan", expected.responsePlan, actual.responsePlan);
      compareField(mismatches, entry.id, "deliveries", expected.deliveries, actual.deliveries);
      const expectedRows = expected.deliveries.map((part, ordinal) => ({ partKey: part.partId, state: part.state, ordinal, kind: expected.responsePlan?.[ordinal]?.kind }));
      const actualRows = store.listDeliveries(entry.id)
        .filter((part) => part.partKey !== TELEGRAM_STATUS_ANCHOR_PART_KEY)
        .map((part) => ({ partKey: part.partKey, state: part.state, ordinal: part.ordinal, kind: part.kind }));
      compareField(mismatches, entry.id, "deliveryRows", expectedRows, actualRows);
      compareField(mismatches, entry.id, "acceptedAt", expected.acceptedAt, actual.acceptedAt);
      compareField(mismatches, entry.id, "updatedAt", expected.updatedAt, actual.updatedAt);
      const payload = sourcePayload(store.readSourcePayload(entry.id));
      const sourceChecksum = actual.source.botId.startsWith("legacy-json-v1:") ? actual.source.botId.slice(15) : null;
      if (payload?.migration?.sourceIdentity !== "synthetic" || payload.migration.checksum !== sourceChecksum
        || payload.migration.ordinal !== actual.source.updateId) {
        mismatch(mismatches, { code: "SOURCE_IDENTITY_MISMATCH", jobId: entry.id, field: "sourceIdentity" });
      }
      if (!payload || !isDeepStrictEqual(payload.legacy, entry.raw)) mismatch(mismatches, { code: "SOURCE_PAYLOAD_MISMATCH", jobId: entry.id, field: "sourcePayload" });
    }
    if (sqliteCount > 0) {
      for (const job of store.listRecent(Math.min(sqliteCount, MAX_MISMATCHES))) {
        if (!legacyIds.has(job.id)) mismatch(mismatches, { code: "EXTRA_JOB", jobId: job.id, field: "id" });
      }
    }
    return { matches: mismatches.length === 0, legacyCount: snapshot.entries.length, sqliteCount, mismatches };
  } finally { store.close(); }
}
export function synchronizeLegacyTelegramJobsShadow(options: ImportOptions): ShadowSyncReport {
  let snapshot: Snapshot | null = null;
  try {
    assertSourcePath(options);
    snapshot = readSnapshot(options.sourcePath);
    const migration = synchronizeSnapshot(options, snapshot);
    const parity = compareLegacyTelegramJobs({ ...options, expectedChecksum: migration.checksum });
    return { authority: "json", sqliteEligible: parity.matches, migration, parity, failure: null };
  } catch (error) {
    let parity: ParityReport | null = null;
    if (snapshot) { try { parity = compareLegacyTelegramJobs(options); } catch { parity = null; } }
    return {
      authority: "json", sqliteEligible: false, migration: null, parity,
      failure: { code: error instanceof TelegramJobMigrationError ? error.code : "MIGRATION_FAILED" },
    };
  }
}
export function prepareTelegramJobStoreMode(options: ImportOptions & {
  readonly mode: "json" | "shadow" | "sqlite";
}): ShadowSyncReport | {
  readonly authority: "sqlite"; readonly sqliteEligible: true;
  readonly migration: MigrationReport; readonly parity: null; readonly failure: null;
} {
  assertSourcePath(options);
  if (options.mode === "json") {
    return { authority: "json", sqliteEligible: false, migration: null, parity: null, failure: null };
  }
  if (options.mode === "shadow") return synchronizeLegacyTelegramJobsShadow(options);
  const version = migrationVersion(options.migrationVersion);
  const store = openStore(options.databasePath);
  let marker: MigrationMarker;
  try {
    const candidate = migrationMarker(store.getMetadata(MARKER_KEY));
    if (!candidate || candidate.status !== "complete" || candidate.version !== version) {
      throw new TelegramJobMigrationError("MIGRATION_FAILED");
    }
    marker = candidate;
  } finally { store.close(); }
  return { authority: "sqlite", sqliteEligible: true, migration: report(marker, "already_imported"), parity: null, failure: null };
}
function assertSourcePath(options: { readonly sourcePath: string; readonly databasePath: string }): void {
  if (storagePathsAlias(options.sourcePath, options.databasePath)) throw new TelegramJobMigrationError("SOURCE_PATH_CONFLICT");
}
function readSnapshot(sourcePath: string): Snapshot {
  let source: string;
  try { source = readFileSync(sourcePath, "utf8"); }
  catch { throw new TelegramJobMigrationError("SOURCE_READ_FAILED"); }
  const checksum = createHash("sha256").update(source).digest("hex");
  let root: unknown;
  try { root = JSON.parse(source); }
  catch { throw new TelegramJobMigrationError("INVALID_SOURCE_ROOT"); }
  if (!Array.isArray(root)) throw new TelegramJobMigrationError("INVALID_SOURCE_ROOT");
  const entries: LegacyEntry[] = [];
  const quarantined: QuarantineItem[] = [];
  const ids = new Set<string>();
  let quarantinedCount = 0;
  root.forEach((value, ordinal) => {
    const result = validateEntry(value, ordinal, ids);
    if ("entry" in result) { entries.push(result.entry); ids.add(result.entry.id); }
    else {
      quarantinedCount += 1;
      if (quarantined.length < MAX_QUARANTINE_ITEMS) quarantined.push(result.quarantine);
    }
  });
  return { checksum, entries, quarantinedCount, quarantined };
}
function validateEntry(
  value: unknown, ordinal: number, ids: ReadonlySet<string>,
): { entry: LegacyEntry } | { quarantine: QuarantineItem } {
  const raw = plainRecord(value);
  if (!raw) return invalid(ordinal, undefined, "INVALID_ENTRY");
  const safeId = safeJobId(raw.id);
  if (!safeId) return invalid(ordinal, undefined, "INVALID_JOB_ID");
  if (ids.has(safeId)) return invalid(ordinal, safeId, "DUPLICATE_JOB_ID");
  const chatId = safeInteger(raw.chatId);
  const messageThreadId = raw.messageThreadId === undefined ? undefined : positiveInteger(raw.messageThreadId);
  const expectedContext = chatId === null ? null : `${chatId}${messageThreadId === undefined ? "" : `:${messageThreadId}`}`;
  if (typeof raw.contextKey !== "string" || raw.contextKey !== expectedContext) return invalid(ordinal, safeId, "INVALID_CONTEXT_KEY");
  if (chatId === null) return invalid(ordinal, safeId, "INVALID_CHAT_ID");
  if (raw.messageThreadId !== undefined && messageThreadId === undefined) return invalid(ordinal, safeId, "INVALID_TOPIC_ID");
  const threadId = nullableIdentifier(raw.threadId);
  if (threadId === undefined) return invalid(ordinal, safeId, "INVALID_THREAD_ID");
  const turnId = raw.turnId === undefined ? undefined : identifier(raw.turnId);
  if (raw.turnId !== undefined && turnId === undefined) return invalid(ordinal, safeId, "INVALID_TURN_ID");
  if (!validInput(raw.input)) return invalid(ordinal, safeId, "INVALID_INPUT");
  if (!validOptionalIdentifier(raw.selectionToken) || !validOptionalIdentifier(raw.modelChoiceId)) return invalid(ordinal, safeId, "INVALID_MODEL_METADATA");
  if (!validCleanup(raw.cleanupInbox)) return invalid(ordinal, safeId, "INVALID_CLEANUP_METADATA");
  if (!legacyState(raw.state)) return invalid(ordinal, safeId, "INVALID_STATE");
  const sentPartKeys = stringList(raw.sentPartKeys, 256);
  if (!sentPartKeys || new Set(sentPartKeys).size !== sentPartKeys.length) return invalid(ordinal, safeId, "INVALID_SENT_PART_KEYS");
  const createdAt = nonNegativeInteger(raw.createdAt); const updatedAt = nonNegativeInteger(raw.updatedAt);
  if (createdAt === null || updatedAt === null || updatedAt < createdAt) return invalid(ordinal, safeId, "INVALID_TIMESTAMPS");
  return { entry: { raw, ordinal, id: safeId, contextKey: raw.contextKey, chatId, messageThreadId, threadId, turnId, state: raw.state, sentPartKeys, createdAt, updatedAt } };
}
function synchronizeSnapshot(options: ImportOptions, snapshot: Snapshot): MigrationReport {
  const version = migrationVersion(options.migrationVersion); const store = openStore(options.databasePath);
  try {
    const existing = migrationMarker(store.getMetadata(MARKER_KEY));
    if (existing?.status === "complete" && existing.checksum === snapshot.checksum && existing.version === version) return report(existing, "already_imported");
    if (existing && existing.version !== version) throw new TelegramJobMigrationError("SOURCE_CHECKSUM_MISMATCH");
    const marker: MigrationMarker = { status: "in_progress", version, checksum: snapshot.checksum, sourceIdentity: "synthetic",
      importedCount: snapshot.entries.length, quarantinedCount: snapshot.quarantinedCount, quarantined: snapshot.quarantined };
    store.setMetadata(MARKER_KEY, marker);
    for (const entry of snapshot.entries) {
      if (store.get(entry.id)) synchronizeEntry(store, entry, snapshot.checksum, version);
      else persistFlow(store, buildFlow(entry, snapshot.checksum, version));
    }
    const ids = new Set(snapshot.entries.map((entry) => entry.id));
    const count = store.countJobs();
    if (count > 0 && store.listRecent(count).some((job) => !ids.has(job.id))) {
      throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [{ reasonCode: "REMOVED_JOB_CONFLICT" }]);
    }
    const complete: MigrationMarker = { ...marker, status: "complete" }; store.setMetadata(MARKER_KEY, complete);
    return report(complete, "imported");
  } catch (error) {
    if (error instanceof TelegramJobMigrationError) throw error;
    throw new TelegramJobMigrationError("MIGRATION_FAILED");
  } finally { store.close(); }
}
function synchronizeEntry(store: SqliteTelegramJobStore, entry: LegacyEntry, checksum: string, version: string): void {
  let current = store.get(entry.id)!; const payload = sourcePayload(store.readSourcePayload(entry.id));
  const sourceChecksum = current.source.botId.startsWith("legacy-json-v1:") ? current.source.botId.slice(15) : null;
  if (!payload || payload.migration?.sourceIdentity !== "synthetic" || payload.migration.checksum !== sourceChecksum
    || payload.migration.ordinal !== current.source.updateId || current.acceptedAt !== entry.createdAt || entry.updatedAt < current.updatedAt) {
    throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [safeReason(entry.id, "SOURCE_CONFLICT")]);
  }
  const projected = finalProjection(buildFlow(entry, checksum, version));
  const target = entry.state === "awaiting-model" && current.phase === "queued"
    ? { ...projected, phase: "queued" as const } : projected;
  for (const event of projectionMatches(target, current) ? [] : forwardEvents(current, target)) {
    current = applyImportedTransition(store, { jobId: entry.id,
      eventId: `legacy-shadow:${checksum.slice(0, 16)}:${entry.ordinal}:${event.type}`,
      event, expectedVersion: current.version });
  }
  if (!projectionMatches(target, current)) throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [safeReason(entry.id, "PROJECTION_CONFLICT")]);
  store.replaceSourcePayload(entry.id, current.source, { migration: { version, checksum: sourceChecksum,
    sourceIdentity: "synthetic", ordinal: current.source.updateId }, legacy: entry.raw });
  syncImportedDeliveries(store, current);
}
function forwardEvents(current: TelegramJob, target: TelegramJob): TransitionEvent[] {
  if (current.phase === "terminal") {
    if (!projectionMatches(target, current)) throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [safeReason(current.id, "LIFECYCLE_REGRESSION")]);
    return [];
  }
  const order = ["accepted", "queued", "dispatching", "running", "delivering"] as const;
  if (target.phase === "terminal") return [{ schemaVersion: 1, type: "job.terminal", eventAt: target.updatedAt,
    identifiers: { threadId: target.threadId, turnId: target.turnId }, attention: target.attention,
    outcome: target.outcome!, responsePlan: target.responsePlan, deliveries: target.deliveries }];
  const from = order.indexOf(current.phase); const to = order.indexOf(target.phase);
  if (from < 0 || to < from) throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [safeReason(current.id, "LIFECYCLE_REGRESSION")]);
  const events: TransitionEvent[] = [];
  for (let index = from + 1; index <= to; index += 1) {
    const phase = order[index]!; const type = phase === "queued" ? "job.queued" : phase === "dispatching" ? "dispatch.written"
      : phase === "running" ? "turn.started" : "delivery.changed";
    events.push({ schemaVersion: 1, type, eventAt: target.updatedAt } as TransitionEvent);
  }
  const finalType = target.phase === "delivering" ? "delivery.changed" : "guardian.observed";
  const final = { schemaVersion: 1, type: finalType, eventAt: target.updatedAt,
    identifiers: { threadId: target.threadId, turnId: target.turnId }, attention: target.attention,
    ...(target.phase === "delivering" ? { responsePlan: target.responsePlan, deliveries: target.deliveries } : {}) } as TransitionEvent;
  if (events.length === 0) events.push(final); else events[events.length - 1] = { ...events.at(-1)!, ...final, type: events.at(-1)!.type } as TransitionEvent;
  return events;
}
function projectionMatches(target: TelegramJob, actual: TelegramJob): boolean {
  return target.phase === actual.phase && target.outcome === actual.outcome && target.acceptedAt === actual.acceptedAt
    && target.updatedAt === actual.updatedAt && target.threadId === actual.threadId && target.turnId === actual.turnId
    && isDeepStrictEqual(target.attention, actual.attention) && isDeepStrictEqual(target.responsePlan, actual.responsePlan)
    && isDeepStrictEqual(target.deliveries, actual.deliveries);
}
function buildFlow(entry: LegacyEntry, checksum: string, version: string): ImportFlow {
  const source: TelegramSourceKey = { botId: `legacy-json-v1:${checksum}`, updateId: entry.ordinal };
  const initial: TelegramJob = {
    schemaVersion: 1, id: entry.id, version: 1, source, attachments: [], phase: "accepted",
    health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: entry.threadId, turnId: entry.turnId ?? null, responsePlan: undefined,
    deliveries: [], acceptedAt: entry.createdAt, updatedAt: entry.createdAt, terminalAt: null,
    dismissedAt: null, retainUntil: null,
  };
  const at = entry.updatedAt;
  const attention = entry.state === "active" && !entry.turnId
    ? required("LEGACY_ACTIVE_WITHOUT_TURN")
    : entry.state === "awaiting-model" ? required("LEGACY_AWAITING_MODEL") : undefined;
  const deliveryAttention = !entry.turnId ? required("LEGACY_DELIVERY_WITHOUT_TURN") : undefined;
  const delivery = deliveryMetadata(entry.sentPartKeys, at);
  const base = (type: TransitionEvent["type"], eventAt = entry.createdAt): TransitionEvent => ({ schemaVersion: 1, type, eventAt } as TransitionEvent);
  let events: TransitionEvent[];
  switch (entry.state) {
    case "awaiting-model": events = [{ ...base("guardian.observed", at), attention }]; break;
    case "waiting": events = [base("job.queued", at)]; break;
    case "active": events = entry.turnId
      ? [base("job.queued"), base("dispatch.written"), base("turn.started", at)]
      : [base("job.queued"), { ...base("dispatch.written", at), attention }]; break;
    case "delivering": events = [base("job.queued"), base("dispatch.written"),
      { ...base("turn.started"), ...(deliveryAttention ? { attention: deliveryAttention } : {}) },
      { ...base("delivery.changed", at), ...delivery }]; break;
    case "completed": events = [{ schemaVersion: 1, type: "job.terminal", eventAt: at, outcome: "completed", ...delivery }]; break;
    case "failed": events = [{ schemaVersion: 1, type: "job.terminal", eventAt: at, outcome: "failed", ...delivery }]; break;
    case "aborted": events = [{ schemaVersion: 1, type: "job.terminal", eventAt: at, outcome: "aborted", ...delivery }]; break;
  }
  return { initial, events, legacy: entry.raw, migrationVersion: version };
}
function persistFlow(store: SqliteTelegramJobStore, requestedFlow: ImportFlow, allowExistingSource = false): void {
  let flow = requestedFlow;
  let current = store.get(flow.initial.id);
  if (current && !isDeepStrictEqual(current.source, flow.initial.source)) {
    const existingPayload = sourcePayload(store.readSourcePayload(flow.initial.id));
    if (!allowExistingSource || !existingPayload || !isDeepStrictEqual(existingPayload.legacy, flow.legacy)) {
      throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [safeReason(flow.initial.id, "SOURCE_CONFLICT")]);
    }
    flow = { ...flow, initial: { ...flow.initial, source: current.source } };
  }
  const payload = {
    migration: { version: flowVersion(flow), checksum: flow.initial.source.botId.slice("legacy-json-v1:".length), sourceIdentity: "synthetic", ordinal: flow.initial.source.updateId },
    legacy: flowLegacy(flow),
  };
  const states = projections(flow);
  if (!current) {
    const accepted = store.acceptUpdate({ job: flow.initial, sourcePayload: payload, eventId: eventId(flow, 0) });
    current = accepted.job;
  }
  const prefix = states.findIndex((state) => sameJson(state, current));
  if (prefix < 0) throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [safeReason(flow.initial.id, "PROJECTION_CONFLICT")]);
  for (let index = prefix; index < flow.events.length; index += 1) {
    current = applyImportedTransition(store, { jobId: flow.initial.id, eventId: eventId(flow, index + 1),
      event: flow.events[index]!, expectedVersion: current.version });
  }
  syncImportedDeliveries(store, current);
}
function applyImportedTransition(
  store: SqliteTelegramJobStore,
  input: Parameters<SqliteTelegramJobStore["transition"]>[0],
): TelegramJob {
  return input.event.type === "job.terminal" && input.event.outcome === "completed"
    ? store.transitionLegacyMigration(input)
    : store.transition(input);
}
function syncImportedDeliveries(store: SqliteTelegramJobStore, job: TelegramJob): void {
  const existing = new Map(store.listDeliveries(job.id).map((part) => [part.partKey, part]));
  for (const [ordinal, planned] of (job.responsePlan ?? []).entries()) {
    const projected = job.deliveries.find((part) => part.partId === planned.partId);
    if (!projected || projected.state !== "delivered") continue;
    const found = existing.get(planned.partId);
    if (found) {
      if (found.state !== "delivered" || found.kind !== planned.kind || found.ordinal !== ordinal) {
        throw new TelegramJobMigrationError("IMPORT_JOB_CONFLICT", [safeReason(job.id, "DELIVERY_CONFLICT")]);
      }
      continue;
    }
    const payload = { sourceIdentity: "synthetic", legacyPartKey: planned.partId };
    store.insertDelivery({ jobId: job.id, partKey: planned.partId, ordinal, kind: planned.kind,
      state: "delivered", payload, contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      updatedAt: projected.deliveredAt ?? job.updatedAt });
  }
}
function projections(flow: ImportFlow): TelegramJob[] {
  const states = [flow.initial];
  for (const event of flow.events) {
    const current = states.at(-1)!;
    const applied = transitionJob(current, { ...event, expectedVersion: current.version });
    if (applied.kind === "conflict") throw new TelegramJobMigrationError("MIGRATION_FAILED");
    states.push(applied.job);
  }
  return states;
}
function finalProjection(flow: ImportFlow): TelegramJob { return projections(flow).at(-1)!; }
function flowLegacy(flow: ImportFlow): Record<string, unknown> { return flow.legacy; }
function flowVersion(flow: ImportFlow): string { return flow.migrationVersion; }
function eventId(flow: ImportFlow, index: number): string {
  return `legacy:${flow.initial.source.botId.slice(-16)}:${flow.initial.source.updateId}:${index}`;
}
function deliveryMetadata(keys: readonly string[], at: number): {
  responsePlan: readonly TelegramResponsePlanPart[]; deliveries: readonly TelegramDeliveryPart[];
} {
  return {
    responsePlan: keys.map((partId) => ({ partId, kind: partKind(partId) })),
    deliveries: keys.map((partId) => ({ partId, state: "delivered", attempts: 0, messageId: null, deliveredAt: at })),
  };
}
function partKind(key: string): TelegramResponsePlanPart["kind"] {
  if (key.startsWith("attachment:")) return "attachment";
  if (key.startsWith("summary:")) return "summary";
  if (key.startsWith("notice:")) return "notice";
  return "final";
}
function required(code: string) { return { kind: "required" as const, code, actions: ["inspect", "abort"] as const }; }
function sourcePayload(value: unknown): { migration: Record<string, unknown> | null; legacy: Record<string, unknown> } | null {
  const raw = plainRecord(value); const migration = plainRecord(raw?.migration); const legacy = plainRecord(raw?.legacy);
  return raw && legacy ? { migration, legacy } : null;
}
function migrationMarker(value: unknown): MigrationMarker | null {
  if (value === null) return null;
  const raw = plainRecord(value);
  const allowed = ["status", "version", "checksum", "sourceIdentity", "importedCount", "quarantinedCount", "quarantined"];
  const quarantine = Array.isArray(raw?.quarantined) ? raw.quarantined : null;
  const validQuarantine = quarantine?.every((item) => {
    const entry = plainRecord(item);
    return Boolean(entry && Object.keys(entry).every((key) => ["index", "jobId", "reasonCode"].includes(key))
      && nonNegativeInteger(entry.index) !== null && (entry.jobId === undefined || safeJobId(entry.jobId))
      && typeof entry.reasonCode === "string" && /^[A-Z0-9_]{1,64}$/.test(entry.reasonCode));
  });
  if (!raw || Object.keys(raw).some((key) => !allowed.includes(key))
    || (raw.status !== "in_progress" && raw.status !== "complete") || !/^[A-Za-z0-9._-]{1,32}$/.test(String(raw.version))
    || !/^[0-9a-f]{64}$/.test(String(raw.checksum)) || raw.sourceIdentity !== "synthetic"
    || nonNegativeInteger(raw.importedCount) === null || nonNegativeInteger(raw.quarantinedCount) === null
    || !validQuarantine || (raw.quarantinedCount as number) < quarantine!.length) {
    throw new TelegramJobMigrationError("MIGRATION_FAILED");
  }
  return raw as unknown as MigrationMarker;
}
function report(marker: MigrationMarker, status: MigrationReport["status"]): MigrationReport {
  return { status, readyForSqlite: true, migrationVersion: marker.version, checksum: marker.checksum, sourceIdentity: "synthetic",
    importedCount: marker.importedCount, quarantinedCount: marker.quarantinedCount, quarantined: marker.quarantined };
}
function openStore(databasePath: string): SqliteTelegramJobStore {
  try { return new SqliteTelegramJobStore(databasePath); } catch { throw new TelegramJobMigrationError("MIGRATION_FAILED"); }
}
function migrationVersion(value: string | undefined): string {
  const version = value ?? DEFAULT_VERSION; if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) throw new TelegramJobMigrationError("MIGRATION_FAILED"); return version;
}
function mismatch(items: ParityMismatch[], item: ParityMismatch): void {
  if (items.length >= MAX_MISMATCHES) return; const { jobId, ...safe } = item;
  items.push(jobId && safeJobId(jobId) ? item : safe);
}
function compareField(items: ParityMismatch[], jobId: string, field: string, expected: unknown, actual: unknown): void {
  if (!isDeepStrictEqual(expected, actual)) mismatch(items, { code: `${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_MISMATCH`, jobId, field }); }
function sameJson(left: unknown, right: unknown): boolean { return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))); }
function invalid(index: number, jobId: string | undefined, reasonCode: string): { quarantine: QuarantineItem } { return { quarantine: { index, ...(jobId ? { jobId } : {}), reasonCode } }; }
function plainRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function safeReason(jobId: string, reasonCode: string): MigrationReason { const safe = safeJobId(jobId); return { ...(safe ? { jobId: safe } : {}), reasonCode }; }
function safeJobId(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null; }
function identifier(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 1_024 ? value : undefined; }
function nullableIdentifier(value: unknown): string | null | undefined { return value === null ? null : identifier(value); }
function validOptionalIdentifier(value: unknown): boolean { return value === undefined || identifier(value) !== undefined; }
function safeInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) ? value : null; }
function nonNegativeInteger(value: unknown): number | null { const result = safeInteger(value); return result !== null && result >= 0 ? result : null; }
function positiveInteger(value: unknown): number | undefined { const result = safeInteger(value); return result !== null && result > 0 ? result : undefined; }
function stringList(value: unknown, max: number): string[] | null { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= max) ? [...value] : null; }
function validInput(value: unknown): boolean {
  if (typeof value === "string") return true;
  const raw = plainRecord(value); if (!raw) return false;
  if (raw.text !== undefined && typeof raw.text !== "string") return false;
  if (raw.imagePaths !== undefined && !stringList(raw.imagePaths, 4_096)) return false;
  if (raw.stagedFileInstructions !== undefined && typeof raw.stagedFileInstructions !== "string") return false;
  return raw.text !== undefined || raw.imagePaths !== undefined || raw.stagedFileInstructions !== undefined;
}
function validCleanup(value: unknown): boolean {
  if (value === undefined) return true; const raw = plainRecord(value); return Boolean(raw && identifier(raw.workspace) && identifier(raw.turnId));
}
function legacyState(value: unknown): value is LegacyState {
  return value === "awaiting-model" || value === "waiting" || value === "active" || value === "delivering"
    || value === "completed" || value === "failed" || value === "aborted";
}
