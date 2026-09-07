# TeleCodex Legacy Quarantine Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan one task at a time. Every task follows RED, GREEN, review, verification, and only then its named live action.

**Goal:** Restore the complete stable audited set of synthetic legacy terminal
jobs from false quarantine, preserve their migration proof during future
retention, and make release preflight readable again without hiding unknown
corruption.

**2026-09-04 correction:** Live evidence invalidated the original status-anchor
assumption and the fixed count of 446. The authoritative execution sequence is
now [`2026-09-04-telecodex-combined-reliability-maintenance.md`](2026-09-04-telecodex-combined-reliability-maintenance.md).

**Architecture:** A standalone SQLite maintenance module classifies quarantined rows against one exact defect signature. The read-only auditor produces only bounded counts and a stable SHA-256 set digest. The repair CLI requires that exact digest, an inactive TeleCodex service, and a verified private SQLite backup before one all-or-nothing transaction. Retention then preserves only validated non-secret migration provenance.

**Tech stack:** TypeScript, Node.js, `better-sqlite3`, Vitest, systemd.

**Approved design:** [`../specs/2026-09-01-telecodex-quarantine-repair-design.md`](../specs/2026-09-01-telecodex-quarantine-repair-design.md)

---

## Authority and boundaries

- This work is an unblocker between Block 0 tasks 0.1 and 0.2. Task 0.1 code exists, but live preflight remains fail-closed while the store contains quarantine rows.
- Work only in the current `telecodex-improvements` checkout because the required ledger and release-preflight code is uncommitted WIP here.
- Preserve unrelated modified, deleted, and untracked files.
- Do not commit, push, merge, remove user files, or clean the worktree.
- Plan approval authorizes neither implementation nor runtime mutation. Implement 0.1a.1 first; wait for acceptance before 0.1a.2.
- Microstep 0.1a.1 may build the external CLI and read the live SQLite store. It must not restart a service or write SQLite.
- All 0.1a.1 builds go to a private staging directory. Do not overwrite the live `dist/` or `dist-web/` trees, because an unrelated service crash could otherwise activate unaccepted code.
- Microstep 0.1a.2 is the only write step. It requires a separately accepted maintenance execution, an inactive `telecodex.service`, and a verified backup.
- Never print job IDs, database or backup paths, payloads, prompts, responses, attachments, tokens, or raw SQLite rows from the CLI.
- Never retry or redeliver historical Telegram messages.
- Actual build output is `dist/` plus `dist-web/`.

## Fixed contracts

Create `src/telegram-job-quarantine-repair.ts` with these public values and types:

```ts
export const TELEGRAM_QUARANTINE_AUDIT_LIMIT = 1_000;

export interface TelegramQuarantineAuditReport {
  readonly schemaVersion: 1;
  readonly checkedAt: number;
  readonly repairable: number;
  readonly unknown: number;
  readonly criticalDeliveries: number;
  readonly auditHash: string;
}

export interface TelegramQuarantineRepairResult {
  readonly schemaVersion: 1;
  readonly repaired: number;
  readonly auditHash: string;
  readonly backupSha256: string;
}

export interface TelegramQuarantineAuditInput {
  readonly databasePath: string;
  readonly checkedAt: number;
  readonly limit?: number;
}

export interface TelegramQuarantineRepairInput {
  readonly databasePath: string;
  readonly expectedAuditHash: string;
  readonly backupSha256: string;
}

export interface TelegramJobBackupResult {
  readonly backupPath: string;
  readonly backupSha256: string;
}

export interface TelegramLogicalLedgerDigest {
  readonly schemaVersion: 1;
  readonly userVersion: number;
  readonly tables: readonly { readonly name: string; readonly rows: number }[];
  readonly sha256: string;
}

export function auditTelegramLegacyQuarantine(
  input: TelegramQuarantineAuditInput,
): TelegramQuarantineAuditReport;

export function repairTelegramLegacyQuarantine(
  input: TelegramQuarantineRepairInput,
): TelegramQuarantineRepairResult;

export function createVerifiedTelegramJobBackup(input: {
  readonly databasePath: string;
  readonly destinationPath: string;
}): Promise<TelegramJobBackupResult>;

export function digestTelegramLogicalLedger(
  databasePath: string,
): TelegramLogicalLedgerDigest;
```

The CLI surface is exact:

```text
node dist/telecodex-release-cli.js quarantine audit --json
node dist/telecodex-release-cli.js quarantine repair --audit-hash <64 lowercase hex>
```

Exit `0` means completed. Exit `1` means invalid invocation, unavailable store, backup failure, service-state failure, or transaction failure. Exit `2` means unknown row, critical delivery, changed candidate set, or audit-hash mismatch.

The stable audit hash sorts candidate job IDs by UTF-8 byte order. Every field is encoded as an 8-byte unsigned big-endian byte length followed by UTF-8 bytes. Each record contains job ID, projection version, projection update time, quarantine fingerprint and time, live event ID and time, migration checksum, and source ordinal, in that order.

The empty repairable set hashes the empty byte stream: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

---

## Microstep 0.1a.1: read-only auditor

### Task 1: Build one exact defect fixture

**Files:**

- Create: `test/telegram-job-quarantine-repair-fixtures.ts`
- Create: `test/telegram-job-quarantine-repair.test.ts`
- Read for reuse: `test/telegram-job-retention.test.ts`
- Read for reuse: `test/telegram-job-reconciliation-scan.test.ts`
- Read for reuse: `src/telegram-job-migration.ts`

- [ ] Add `seedLegacyQuarantineDefect(databasePath, overrides?)`. Use public store operations to seed a synthetic completed terminal job and final response-part deliveries with no status anchor, run retention, and record a `refresh_terminal` decision. Use direct SQL only for the final known scanner/quarantine shape that public decoding can no longer produce.
- [ ] Expose safe expected metadata only to tests: job ID, checksum, ordinal, archived terminal time, event ID and time, projection version, quarantine time, and pre-repair table snapshots.
- [ ] Assert the fixture has exactly two archived summaries (`update.accepted`, `job.terminal`), one live `reconciliation.decided`, a pending `refresh_terminal` intent, completed outcome, all final deliveries delivered, and zero status anchors.
- [ ] Add a bounded multi-row fixture test. The implementation must remain generic with no branch for a live observed count.

Run RED:

```bash
npm test -- --run test/telegram-job-quarantine-repair.test.ts
```

Expected: FAIL because the repair module does not exist.

### Task 2: Implement strict read-only classification

**Files:**

- Create: `src/telegram-job-quarantine-repair.ts`
- Modify: `src/telegram-job-ledger.ts`
- Modify: `test/telegram-job-quarantine-repair.test.ts`

- [ ] Export one bounded projection decoder from `src/telegram-job-ledger.ts` by routing through existing `decodeJob()` logic. Do not duplicate job-shape validation.
- [ ] Open with `{ readonly: true, fileMustExist: true }`, set a bounded busy timeout, enable foreign keys, and call `validateTelegramJobSchema()` before querying.
- [ ] Query at most `limit + 1` quarantine rows, ordered by quarantine time and job ID. Reject an invalid limit, overflow, malformed schema/metadata, or dirty foreign keys.
- [ ] Parse metadata key `legacy-json-migration` as a completed synthetic marker. Require a valid bounded version and lowercase 64-hex checksum.
- [ ] For each quarantine row, read `jobs`, `inbox_updates`, `job_events`, `job_event_archive`, and `deliveries` inside the same deferred read transaction.
- [ ] Apply all 15 approved signature conditions. A candidate-level mismatch is unknown; a database/schema failure makes the audit unavailable.
- [ ] Count `criticalDeliveries` as delivery rows in `pending`, `sending`, `uncertain`, or `failed` state among inspected quarantine jobs. Their jobs are also unknown.
- [ ] Require zero status anchors. Require `responsePlan.length` to equal the final delivery-row count, match part keys/kinds by ordinal, and satisfy the exact synthetic delivery invariants in the approved design.
- [ ] Decode the stored live event payload and require row/payload identity. Require its `expectedVersion + 1` to equal both the row and projection versions.
- [ ] Do not call `SqliteTelegramJobStore.get()` for a defect candidate because its live stream is intentionally unreplayable before repair.
- [ ] Add table-driven tests for every signature condition plus malformed JSON, any anchor, extra archive/live event, wrong marker, invalid ordinal, response-plan mismatch, and foreign-key corruption.

Run GREEN:

```bash
npm test -- --run test/telegram-job-quarantine-repair.test.ts test/telegram-job-store-sqlite.test.ts
```

Expected: the exact fixture is repairable and every individual mismatch is unknown.

### Task 3: Implement canonical hashing and prove read-only behavior

**Files:**

- Modify: `src/telegram-job-quarantine-repair.ts`
- Modify: `test/telegram-job-quarantine-repair.test.ts`

- [ ] Keep internal candidates private. Build the public report only from timestamp, three counts, and digest.
- [ ] Add length-prefix helpers that reject negative, unsafe, or non-integer numeric fields.
- [ ] Prove database row order and insertion order do not change the digest; prove every hashed field does.
- [ ] Prove payload text, delivery payload, and absolute database path never occur in report or bounded failure output.
- [ ] Record database SHA-256, size, mtime, SQLite `data_version`, and table counts before and after two audits in one process. Assert no changes.
- [ ] Test empty, one exact row, a bounded multi-row set, mixed exact/unknown, and `limit + 1` rows.

Verify:

```bash
npm test -- --run test/telegram-job-quarantine-repair.test.ts
```

### Task 4: Add the audit CLI without adding repair

**Files:**

- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telecodex-release-cli.test.ts`
- Modify: `package.json`

- [ ] Extend CLI dependencies with only an injected `quarantineAudit` dependency for this microstep.
- [ ] Parse exactly `quarantine audit --json`. Preserve exact `preflight --json` behavior.
- [ ] Resolve the canonical database through existing config parsing. Do not accept a path in CLI arguments.
- [ ] Print one JSON report. Return `2` for unknown or critical delivery counts, otherwise `0`.
- [ ] Return a bounded stderr code for invocation/audit failures. Never interpolate exception text.
- [ ] Add `release:quarantine:audit` as `node dist/telecodex-release-cli.js quarantine audit --json`.
- [ ] Test success, unknowns, critical delivery, extra flags, exception redaction, existing preflight behavior, and absence of IDs, paths, payloads, prompts, responses, and tokens.
- [ ] Before the first build command, record live service PID/restart count and copy complete current `dist/` and `dist-web/` trees to a new private `.telecodex/release-state/quarantine-repair/0.1a.1-before/` snapshot. Never overwrite an existing snapshot.
- [ ] Create a new private task-specific `TELECODEX_AUDITOR_STAGE` directory under the same release-state root. It must not be `dist/`, `dist-web/`, or an existing directory.

Focused verification:

```bash
npm test -- --run test/telegram-job-quarantine-repair.test.ts test/telecodex-release-cli.test.ts test/telecodex-release-preflight.test.ts
npx --no-install tsc --outDir "$TELECODEX_AUDITOR_STAGE/dist"
```

Expected: PASS and the compiled release CLI contains the audit command.

### Task 5: Review, full verification, and live read-only audit

**Files changed in 0.1a.1:**

- `src/telegram-job-quarantine-repair.ts`
- `src/telegram-job-ledger.ts`
- `src/telecodex-release-cli.ts`
- `test/telegram-job-quarantine-repair-fixtures.ts`
- `test/telegram-job-quarantine-repair.test.ts`
- `test/telecodex-release-cli.test.ts`
- `package.json`

- [ ] Run `requesting-code-review`. Resolve every Critical or Important finding and rerun impacted tests.
- [ ] Run the complete repository gate sequentially:

```bash
npm test
npm run check:web
npx --no-install tsc --outDir "$TELECODEX_AUDITOR_STAGE/dist"
npx --no-install vite build --config web/vite.config.ts --outDir "$TELECODEX_AUDITOR_STAGE/dist-web"
git diff --check
```

Expected: all tests pass, Svelte reports zero errors/warnings, builds exit zero, and diff check reports no whitespace errors.

- [ ] Record `MainPID`, `NRestarts`, `ExecStart`, and `FragmentPath` from `systemctl show` before the final build.
- [ ] Verify staged file digests, then run `node "$TELECODEX_AUDITOR_STAGE/dist/telecodex-release-cli.js" quarantine audit --json` twice against the live canonical store.
- [ ] Accept only if both cover the complete current quarantine set, report `unknown: 0`, `criticalDeliveries: 0`, and the same count and hash.
- [ ] Re-run `systemctl show` and prove PID and restart count did not change.

If count or hash differs, keep preflight fail-closed, make no SQLite change, and return to Task 2 with the new read-only evidence.

---

## Microstep 0.1a.2: prevention, verified backup, repair, and activation

### Task 6: Preserve valid migration proof during retention

**Files:**

- Modify: `src/telegram-job-ledger.ts`
- Modify: `test/telegram-job-retention.test.ts`
- Modify: `test/telegram-job-reconciliation-scan.test.ts`

- [ ] Add a validator for `source.migration` with exactly `version`, `checksum`, `sourceIdentity`, and `ordinal`. Require bounded non-empty version, lowercase 64-hex checksum, `synthetic` identity, non-negative safe ordinal, matching `legacy-json-v1:<checksum>` bot ID, and matching source update ID.
- [ ] Preserve only valid migration proof in `scrubSourcePayload()`. Keep text/attachment null and `payloadPurged: true`; do not preserve the legacy source body.
- [ ] Add a retention test for this exact retained object:

```ts
expect(store.readSourcePayload(jobId)).toMatchObject({
  migration: { version: "1", checksum, sourceIdentity: "synthetic", ordinal },
  text: null,
  attachment: null,
  payloadPurged: true,
});
```

- [ ] Add spoof tests for wrong checksum, identity, ordinal, version, extra keys, and malformed value. Invalid proof is dropped, not normalized.
- [ ] Add a recurrence test: retain a synthetic completed terminal with final delivery rows and no status anchor, scan twice, and assert no candidate, reconciliation event, or quarantine row appears.

Run RED, then GREEN:

```bash
npm test -- --run test/telegram-job-retention.test.ts test/telegram-job-reconciliation-scan.test.ts
```

Expected RED: valid proof is removed. Expected GREEN: proof survives and recurrence stays empty.

### Task 7: Implement the guarded repair transaction

**Files:**

- Modify: `src/telegram-job-quarantine-repair.ts`
- Modify: `test/telegram-job-quarantine-repair.test.ts`

- [ ] Open writable SQLite only in `repairTelegramLegacyQuarantine()`. Enable foreign keys, validate current schema, and start one immediate transaction.
- [ ] Recompute the audit inside the transaction. Require a lowercase 64-hex expected hash, exact equality, zero unknown rows, and zero critical deliveries before the first update.
- [ ] Reconstruct migration proof from the validated completed marker: `{ version, checksum, sourceIdentity: "synthetic", ordinal }`.
- [ ] Update `inbox_updates.source_json` with that proof while preserving scrubbed routing fields and null payload fields.
- [ ] Remove only `reconciliation` from projection JSON. Restore projection and row version to the event's `expectedVersion`; restore projection and row update time to archived terminal time.
- [ ] Delete exactly one live `reconciliation.decided` row and one quarantine row per candidate. Check every update/delete change count.
- [ ] Before transaction commit, verify each target decodes through archived history, has zero live events, keeps exactly two archived summaries, and preserves deliveries, response plan, outcome, retention, source routing, and metadata. Require clean foreign keys.
- [ ] Any mismatch or injected failure throws and rolls back the whole transaction.
- [ ] Return only schema version, repaired count, expected hash, and caller-supplied verified backup digest.

Tests cover exact repair, stale hash, changed count, drift after audit, unknown row, critical delivery, injected failure after the first row, empty second repair, and writer lock. Compare archive and delivery rows byte-for-byte.

Run RED, then GREEN:

```bash
npm test -- --run test/telegram-job-quarantine-repair.test.ts test/telegram-job-store-sqlite.test.ts
```

Expected: every failure path preserves pre-repair state.

### Task 8: Add verified backup and service-inactive guard

**Files:**

- Modify: `src/telegram-job-quarantine-repair.ts`
- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telegram-job-quarantine-repair.test.ts`
- Modify: `test/telecodex-release-cli.test.ts`

- [ ] Add `createVerifiedTelegramJobBackup()` with `better-sqlite3` `database.backup(destination)`. Create parent mode `0700`, require a new destination, and chmod backup to `0600`.
- [ ] Open source/backup read-only. Validate schema, equal `user_version`, `quick_check = ok`, empty foreign-key checks, identical sorted logical table names, and equal counts for every non-SQLite table.
- [ ] Close backup, hash its file bytes with SHA-256, and return the digest. A failed backup remains private evidence but never permits repair.
- [ ] Inject a process dependency and call only `systemctl is-active telecodex.service` via `execFile` with fixed arguments. Continue only for the exact proven state `inactive`; reject active, failed, transitional, timeout, spawn failure, and unexpected output.
- [ ] Repeat the read-only audit after inactive proof and before backup. Require the operator hash before backup creation.
- [ ] Store backups under `.telecodex/release-state/quarantine-repair/` with an internally generated timestamped basename. Do not accept path input.
- [ ] Call repair only after backup verification and pass the verified digest into the result.
- [ ] Add `digestTelegramLogicalLedger()`: validate schema, sort tables/columns/rows canonically by primary key, length-prefix SQLite value types, hash values internally, and return only table names/counts plus the final digest. Reject a table without a deterministic primary-key order.

Tests detect truncated/mismatched backup, foreign-key corruption, unsafe mode, existing destination, every unsafe service state, timeout, hash drift, backup failure, and repair failure. Prove logical digest stability and sensitivity to every table. Assert guard failures never open source writable.

Focused verification:

```bash
npm test -- --run test/telegram-job-quarantine-repair.test.ts test/telecodex-release-cli.test.ts
```

### Task 9: Complete the repair CLI and pre-maintenance gate

**Files:**

- Modify: `src/telecodex-release-cli.ts`
- Modify: `test/telecodex-release-cli.test.ts`

- [ ] Parse exactly `quarantine repair --audit-hash <64 lowercase hex>`.
- [ ] Keep the actual repair as a direct Node CLI invocation. Do not put a fixed or placeholder audit hash in a runnable package script.
- [ ] Emit one bounded JSON result. Map set/hash drift, unknowns, and critical deliveries to exit `2`; map invocation, service, backup, and transaction failure to exit `1`.
- [ ] Preserve existing preflight and audit behavior exactly.
- [ ] Prove redaction for thrown errors containing a token, prompt, response, job ID, and path.
- [ ] Preserve the accepted staged 0.1a.1 `dist/` and `dist-web/` trees as a private rollback package and record all file digests.
- [ ] Create a separate new private `TELECODEX_REPAIR_STAGE` directory for the 0.1a.2 candidate. Never build into the accepted 0.1a.1 package or live trees.

Run focused and complete gates:

```bash
npm test -- --run test/telegram-job-quarantine-repair.test.ts test/telegram-job-retention.test.ts test/telegram-job-reconciliation-scan.test.ts test/telecodex-release-cli.test.ts test/telecodex-release-preflight.test.ts test/telegram-job-store-sqlite.test.ts
npm test
npm run check:web
npx --no-install tsc --outDir "$TELECODEX_REPAIR_STAGE/dist"
npx --no-install vite build --config web/vite.config.ts --outDir "$TELECODEX_REPAIR_STAGE/dist-web"
git diff --check
```

- [ ] Run `requesting-code-review`, resolve Critical and Important findings, then repeat impacted and full commands.
- [ ] Record SHA-256 for every candidate file in `dist/` and `dist-web/`. Do not rebuild during maintenance.

### Task 10: Execute the bounded maintenance window

This task begins only after separate user approval of 0.1a.2 runtime execution.

- [ ] Re-resolve `FragmentPath`, `ExecStart`, `WorkingDirectory`, canonical SQLite path, `MainPID`, `NRestarts`, and current time. Do not trust planning values.
- [ ] Run two live audits. Require the complete stable candidate count, `unknown: 0`, `criticalDeliveries: 0`, and the same approved hash.
- [ ] Inspect non-quarantined projections read-only. Require zero `dispatching` or `running` jobs and zero `sending` deliveries. If an active exact turn exists, wait for its natural boundary; do not interrupt it.
- [ ] Verify Guardian status read-only and capture pre-stop service state.
- [ ] Stop only `telecodex.service`. Prove inactive. Do not stop Guardian or app-server.
- [ ] Audit again and require the exact approved hash.
- [ ] Copy that exact digest into the task-specific `TELECODEX_APPROVED_AUDIT_HASH` shell variable and validate it against `^[0-9a-f]{64}$` before invocation.
- [ ] Invoke the already-built CLI:

```bash
node "$TELECODEX_REPAIR_STAGE/dist/telecodex-release-cli.js" quarantine repair --audit-hash "$TELECODEX_APPROVED_AUDIT_HASH"
```

- [ ] Require exit `0`, `repaired` equal to the final audited count, matching hash, and 64-hex backup digest. Confirm backup mode `0600` and independently recompute its SHA-256.
- [ ] Recompute candidate build digests and require exact Task 9 match.
- [ ] While stopped, require `quick_check = ok`, empty foreign-key check, quarantine count `0`, zero repaired-row live reconciliation events, and unchanged archive/delivery counts.
- [ ] Audit again. Require `repairable: 0`, `unknown: 0`, `criticalDeliveries: 0`, and empty-set hash.
- [ ] Record the post-repair logical ledger digest in a new private mode-`0600` release-state manifest. This is the only automatic database-restore boundary after start.
- [ ] Replace the stopped service's complete `dist/` and `dist-web/` trees with the staged candidate using same-filesystem directory renames. Keep the previous complete trees private and recoverable. Recheck installed digests before start.
- [ ] Start only `telecodex.service` from the already-built candidate.
- [ ] Run:

```bash
systemctl show telecodex.service -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecStart -p FragmentPath
systemctl is-active telecodex.service
npm run release:preflight
npm run guardian:cli -- status
```

- [ ] Resolve the configured Mini App port, then require `/healthz` and `/readyz` within three seconds. Inspect bounded logs since start time.
- [ ] Let the service complete its normal initial reconciliation cycle, then query the repaired set read-only. No repaired row may regain a live `refresh_terminal` event or quarantine. Retention prevention is accepted from Task 6 tests, not by forcing a live retention sweep.
- [ ] Observe for ten minutes. Accept only with stable PID/restart count, readable preflight, no recurrence, no redelivery, and no new unknown or uncertain state.

## Rollback procedure

Rollback is mandatory on a repair failure after write, candidate digest mismatch, start/readiness failure, recurrence, or unexplained integrity difference.

1. Stop only `telecodex.service` if running and prove it inactive.
2. Preserve the failed post-repair database as private evidence. Never overwrite the verified backup.
3. If the candidate never started, restore the verified SQLite backup with mode `0600`, restore 0.1a.1 `dist/` and `dist-web/`, then start and verify the previous build.
4. If the candidate started, recompute the logical ledger digest and compare it with the private post-repair boundary recorded before start.
5. Restore the backup only when the digests match, proving there is no newer runtime or user state. Then restore previous build trees, start, and require the original final-audit count with zero unknown and critical deliveries; preflight should return `STORE_UNAVAILABLE` again.
6. If newer state exists, do not restore SQLite and do not automatically restart. Keep both databases and build trees, report only bounded table-count and digest differences, and require a separately approved forward repair or merge.
7. Repeat integrity, audit, Guardian, service, health, readiness, and bounded-log checks for the selected safe rollback path.

Do not retry jobs, deliveries, topic creation, or Telegram writes during rollback.

## Completion gate

0.1a is complete only when both microsteps are separately accepted, full verification is fresh, live candidate digest matches the reviewed build, repair changed exactly the audited set, backup remains available, archive/delivery evidence is unchanged, preflight is readable, and the ten-minute observation finishes without recurrence.

After acceptance, return to Block 0 Task 0.2. Do not begin 0.2 in the same maintenance window.
