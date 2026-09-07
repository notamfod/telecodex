export type MigrationErrorCode =
  | "SOURCE_READ_FAILED" | "SOURCE_PATH_CONFLICT" | "INVALID_SOURCE_ROOT" | "SOURCE_CHECKSUM_MISMATCH"
  | "IMPORT_JOB_CONFLICT" | "MIGRATION_FAILED" | "EXPORT_UNSAFE" | "EXPORT_LIMIT_EXCEEDED"
  | "EXPORT_WRITE_FAILED" | "EXPORT_DURABILITY_UNCERTAIN";

export interface MigrationReason { readonly jobId?: string; readonly reasonCode: string; }

export class TelegramJobMigrationError extends Error {
  constructor(readonly code: MigrationErrorCode, readonly reasons: readonly MigrationReason[] = []) {
    super(code);
    this.name = "TelegramJobMigrationError";
  }
}

export interface QuarantineItem { readonly index: number; readonly jobId?: string; readonly reasonCode: string; }
export interface MigrationReport {
  readonly status: "imported" | "already_imported";
  readonly readyForSqlite: true;
  readonly migrationVersion: string;
  readonly checksum: string;
  readonly sourceIdentity: "synthetic";
  readonly importedCount: number;
  readonly quarantinedCount: number;
  readonly quarantined: readonly QuarantineItem[];
}
export interface ParityMismatch { readonly code: string; readonly jobId?: string; readonly field?: string; }
export interface ParityReport {
  readonly matches: boolean; readonly legacyCount: number; readonly sqliteCount: number;
  readonly mismatches: readonly ParityMismatch[];
}
export interface ShadowSyncReport {
  readonly authority: "json"; readonly sqliteEligible: boolean;
  readonly migration: MigrationReport | null; readonly parity: ParityReport | null;
  readonly failure: { readonly code: string } | null;
}
