# TeleCodex Legacy Quarantine Repair Design

## Status

The design was approved section by section on 2026-09-01. This document is the review gate before implementation planning.

Approval of this document does not authorize implementation, a commit, a SQLite mutation, a service stop, or a restart. Those remain separate steps. The live TeleCodex service must not be restarted while the release preflight reports an unavailable store.

## Goal

Repair the known legacy-retention quarantine defect, prevent it from recurring, and unblock the read-only release preflight without weakening its fail-closed rules.

The repair must preserve archived events, completed deliveries, and all user data. It may change only records that match the exact defect signature defined below.

## Confirmed cause

The live ledger contained 446 quarantined jobs on 2026-09-01 and 494 on
2026-09-04. The increasing count is part of the same retention defect, so the
maintenance gate must use the complete stable audited set rather than a
hard-coded count. Every sampled and aggregated row has one identical history
shape:

- all inspected rows were imported as synthetic legacy jobs;
- all projections are terminal with outcome `completed`;
- every delivery is `delivered`; there are no `pending` or `sending` deliveries;
- archived history contains one `update.accepted` and one `job.terminal` per job;
- current history contains only one `reconciliation.decided` with decision `refresh_terminal`;
- every projection contains a pending reconciliation intent;
- every scrubbed source has `payloadPurged: true` and has lost its `migration` proof;
- imported response-plan parts have matching synthetic `final` delivery rows;
- these legacy imports have no status-anchor delivery rows.

Retention caused the defect by removing the non-secret `migration` proof from `source_json`. The reconciliation scan then stopped recognizing the rows as synthetic legacy terminals. It recorded `refresh_terminal` in the live event table after the original history had moved to `job_event_archive`.

The next scan tried to replay a live stream whose first and only event was `reconciliation.decided`. Replay failed with `Malformed Telegram job event stream`, and the scanner quarantined the row.

## Selected approach

Use a narrowly guarded repair with three parts:

1. preserve synthetic migration proof during future retention scrubbing;
2. audit the existing quarantine and produce a stable digest without writing;
3. during a maintenance window, back up SQLite and repair only the exact audited set in one transaction.

The rejected alternatives are:

- allowing the preflight to ignore quarantined rows, which could conceal an active or malformed job;
- rebuilding the entire ledger, which changes far more state than this defect requires.

## Scope

### Included

- a read-only quarantine auditor;
- a guarded repair command;
- preservation of non-secret synthetic migration proof during retention;
- a verified SQLite backup before repair;
- targeted source, projection, live-event, and quarantine corrections;
- post-repair integrity, preflight, service, and recurrence checks.

### Excluded

- generic repair of unknown quarantine patterns;
- deletion of archived events or deliveries;
- retries or re-delivery of historical Telegram messages;
- automatic repair while TeleCodex is running;
- changes to prompt, response, attachment, or credential data;
- cleanup of unrelated stalled or attention-required jobs.

## Components

### Quarantine repair module

Create `src/telegram-job-quarantine-repair.ts`. It owns classification, audit hashing, backup verification, and the repair transaction. It does not call systemd and does not decide when the service is safe to stop.

The module exposes separate read-only and write entry points:

```ts
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
```

Neither report contains source payloads, event payloads, absolute paths, tokens, prompts, responses, or individual job IDs.

### Release CLI

Extend `src/telecodex-release-cli.ts` with:

```text
quarantine diagnose --json
quarantine audit --json
quarantine repair --audit-hash <64 lowercase hex characters>
```

`diagnose` and `audit` open the canonical store read-only. `diagnose` reports
only bounded per-condition rejection counts and never emits job IDs, paths, or
payload data. Every candidate is assigned to its first failed condition, so
the rejection counts sum to `unknown`. Condition 15 is a global foreign-key
count; a dirty foreign-key check makes the audit unavailable rather than
misclassifying individual rows. `repair` first checks `systemctl is-active
telecodex.service` through a fixed-argument process call. It opens the store
writable only after the service is inactive and after the CLI has created and
verified a backup.

Exit codes remain bounded:

- `0`: operation completed;
- `1`: invalid invocation, unavailable store, failed backup, or failed repair;
- `2`: audit found unknown rows, critical deliveries, or a changed candidate set.

### Retention proof preservation

Modify `scrubSourcePayload()` in `src/telegram-job-ledger.ts` to retain a valid synthetic `migration` object. The object contains only version, checksum, source identity, and ordinal. Text and attachment fields remain purged.

The repair reconstructs the same proof for an existing candidate from its validated legacy bot ID, source update ID, and stored migration checksum. A mismatch makes the row unknown and blocks repair.

## Exact repair signature

A row is repairable only when every condition below holds in the same read transaction:

1. `job_quarantine.reason_code` is `malformed_persisted_job`.
2. The projection is valid JSON and passes the normal job-shape validator.
3. The projection phase is `terminal`, outcome is `completed`, attention is `none`, and `retainUntil` is present.
4. The projection contains one pending `refresh_terminal` reconciliation intent.
5. The projection version equals the live event's `expectedVersion + 1`.
6. The projection `updatedAt` equals the live event timestamp.
7. The source bot ID is `legacy-json-v1:<sha256>` and its update ID is a non-negative integer.
8. The scrubbed source has `payloadPurged: true`, null text and attachment, and no current migration proof.
9. The checksum in the bot ID matches the completed ledger migration marker.
10. Archived history contains exactly two ordered summaries: `update.accepted`, then `job.terminal`.
11. Live history contains exactly one `reconciliation.decided` event with decision `refresh_terminal`.
12. Every delivery is `delivered` and no delivery is `pending`, `sending`, `uncertain`, or `failed`.
13. Delivery rows map one-to-one to response-plan parts and contain no extra rows.
14. The synthetic legacy delivery contract has zero status-anchor rows. Every
    delivery is a `final` row with `delivered` status, a null Telegram message
    ID, zero attempts, no retry or error fields, JSON `null` payload, and an
    update timestamp equal to the terminal timestamp.
15. `PRAGMA foreign_key_check` returns no rows.

One failed condition classifies the row as unknown. The repair never changes an unknown row.

## Audit hash

The auditor sorts repairable job IDs by UTF-8 byte order. For each candidate it hashes a canonical record containing:

- job ID;
- projection version and updated timestamp;
- quarantine fingerprint and timestamp;
- live event ID and timestamp;
- source checksum and ordinal.

The final `auditHash` is SHA-256 over the length-prefixed canonical records. Payload content is never included.

`repair` repeats the audit inside its write transaction. It proceeds only when the recomputed hash equals the operator-supplied hash and `unknown === 0` and `criticalDeliveries === 0`.

## Repair transaction

For every audited candidate, the transaction performs these exact changes:

1. restore the validated non-secret `migration` proof in `inbox_updates.source_json`;
2. remove the pending reconciliation intent from `jobs.projection_json`;
3. restore the projection version to the live event's `expectedVersion`;
4. restore projection and row `updatedAt` to the archived terminal timestamp;
5. delete the single erroneous live `reconciliation.decided` event;
6. delete the matching quarantine row.

The transaction does not change archived events, delivery rows, terminal outcome, response plan, retention deadline, source routing identifiers, or migration metadata.

After all rows change, the transaction repeats candidate classification and foreign-key validation. Any mismatch rolls back the entire transaction.

Before starting TeleCodex, the operator records a private logical digest of every ledger table after the successful repair. The digest contains no row values. It is the rollback boundary used to detect any post-start runtime or user change.

## Backup and rollback

The CLI creates the backup only after TeleCodex stops. It uses SQLite's online backup API against the closed service database and writes into a private release-state directory with mode `0600`.

Before repair, the CLI verifies:

- the backup opens read-only;
- schema version matches the source;
- `quick_check` and `foreign_key_check` pass;
- source and backup logical row counts match for every ledger table;
- the backup file has a recorded SHA-256 digest.

The maintenance package also preserves the previous complete `dist` and `dist-web` trees.

If repair fails before TeleCodex starts, the operator restores the verified SQLite backup and previous build trees, starts the previous version, and repeats the original live checks. No partial repair is retained.

After TeleCodex has started, the operator must first recompute the logical ledger digest and compare it with the recorded post-repair boundary. The backup may be restored only when they match, proving that no newer accepted job, delivery transition, event, or other runtime state exists. If the digest changed, the operator must not overwrite SQLite. The service stays stopped with both databases preserved until an evidence-safe forward repair or state merge is separately approved.

## Deployment sequence

### Microstep 0.1a.1: read-only auditor

1. Add and test only the audit path.
2. Save the current complete `dist` and `dist-web` trees before building.
3. Build the external CLI into a private staging directory without overwriting the trees named by the live `ExecStart`.
4. Run the live audit read-only.
5. Require that every current quarantine row is repairable, `unknown: 0`, and
   `criticalDeliveries: 0`.
6. Record the audit hash for the maintenance step.

This step changes no live SQLite rows and does not activate new service code.

### Microstep 0.1a.2: prevention, repair, and activation

1. Save the complete 0.1a.1 build as the rollback version.
2. Add retention proof preservation and the guarded repair path.
3. Build the candidate and run focused and full verification before the maintenance window.
4. Prove read-only that exact app-server turns are inactive and no delivery is sending.
5. Stop only `telecodex.service`.
6. Repeat audit and require the recorded hash to match.
7. Create and verify the SQLite backup.
8. Run the repair transaction.
9. Verify that the already-built candidate still matches its pre-maintenance digest.
10. Install the complete staged `dist` and `dist-web` trees while the service is stopped, then start TeleCodex from that candidate. Do not build while the service is stopped.
11. Run integrity checks, quarantine audit, release preflight, Guardian status, service status, and targeted logs.
12. Observe for ten minutes before accepting the microrelease.

## Failure handling

The operation stops without mutation when:

- the store cannot be opened;
- the audit limit is exceeded;
- an unknown quarantine row exists;
- a critical delivery exists;
- the candidate count or audit hash changes between the two maintenance audits;
- the service is still running when repair begins;
- backup creation or verification fails;
- SQLite integrity or foreign-key checks fail.

A transaction error rolls back all row changes. A post-start failure triggers the guarded rollback evaluation; SQLite restoration remains forbidden when the logical ledger digest changed after start. Error output uses bounded codes and never includes raw SQLite rows or payloads.

## Testing

### Auditor tests

- an exact multi-row defect fixture is repairable without a hard-coded live count;
- every individual signature mismatch becomes unknown;
- pending or sending delivery blocks repair;
- ordering differences do not change the audit hash;
- projection or event changes do change the hash;
- dry-run leaves database bytes and metadata unchanged;
- output contains no payload, path, token, prompt, or response text.

### Repair tests

- expected hash repairs the exact set;
- changed hash or candidate count writes nothing;
- injected failure rolls back the complete transaction;
- repaired rows decode through the archived-history path;
- archived events and deliveries remain byte-for-byte equal;
- restored migration proof survives a retention sweep;
- a second repair is an idempotent zero-row audit;
- an unknown quarantine remains quarantined and keeps preflight fail-closed.

### Prevention tests

- retention preserves valid synthetic migration proof;
- retention still removes text and attachments;
- reconciliation skips a retained synthetic terminal with synthetic final
  delivery rows and no status anchor;
- status refresh skips that same row only when every planned final delivery is
  physically complete; no historical response is sent again;
- spoofed legacy prefixes without valid proof remain candidates and fail closed.

### Release tests

- backup verification detects truncated or mismatched databases;
- repair refuses to run while the service is active;
- post-repair `quick_check`, `foreign_key_check`, and release preflight pass;
- pre-start rollback restores the original quarantine count and previous build;
- post-start rollback refuses to overwrite newer user or runtime state.

## Acceptance criteria

Microstep 0.1a.1 is accepted when the live read-only audit reports that every
current quarantine row is repairable, with zero unknown rows, zero critical
deliveries, and a stable count and audit hash on two consecutive runs.

Microstep 0.1a.2 is accepted when:

- the verified backup exists before the first write;
- the repair changes exactly the audited rows in one transaction;
- quarantine count changes from the final audited count to 0;
- archived-event and delivery counts remain unchanged;
- the second audit reports zero repairable and zero unknown rows;
- release preflight no longer reports `STORE_UNAVAILABLE`;
- Guardian and `telecodex.service` are healthy;
- no matching quarantine reappears during the ten-minute observation;
- rollback has been exercised in tests and remains available until acceptance.
