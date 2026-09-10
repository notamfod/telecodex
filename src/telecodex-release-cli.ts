import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { parseTelegramJobConfig } from "./config.js";
import { loadSessionGuardianEnvironment, parseSessionGuardianConfig }
  from "./session-guardian-config.js";
import { SessionGuardianIpcClient } from "./session-guardian-ipc-client.js";
import { SqliteTelegramJobStore } from "./telegram-job-ledger.js";
import {
  auditTelegramLegacyQuarantine,
  diagnoseTelegramLegacyQuarantine,
  type TelegramQuarantineAuditReport,
  type TelegramQuarantineDiagnosisReport,
} from "./telegram-job-quarantine-repair.js";
import {
  createVerifiedTelegramJobBackup,
  repairTelegramLegacyQuarantine,
  TelegramQuarantineCandidateSetChangedError,
  type TelegramQuarantineRepairResult,
} from "./telegram-job-quarantine-maintenance.js";
import {
  inspectTeleCodexReleasePreflight,
  type TeleCodexReleasePreflightReport,
  type TeleCodexReleasePreflightStore,
} from "./telecodex-release-preflight.js";

export interface TeleCodexReleaseCliDependencies {
  readonly preflight?: () => Promise<TeleCodexReleasePreflightReport>;
  readonly quarantineAudit?: () => TelegramQuarantineAuditReport
    | Promise<TelegramQuarantineAuditReport>;
  readonly quarantineDiagnosis?: () => TelegramQuarantineDiagnosisReport
    | Promise<TelegramQuarantineDiagnosisReport>;
  readonly quarantineRepair?: (expectedAuditHash: string) => TelegramQuarantineRepairResult
    | Promise<TelegramQuarantineRepairResult>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export async function runTeleCodexReleaseCli(
  argv: readonly string[],
  dependencies: TeleCodexReleaseCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  if (isPreflightInvocation(argv)) {
    try {
      const report = await (dependencies.preflight ?? inspectCurrentReleaseState)();
      stdout(JSON.stringify(report));
      if (report.reasons.includes("STORE_UNAVAILABLE")) return 1;
      return report.safeToRestart ? 0 : 2;
    } catch {
      stderr(failure("PREFLIGHT_UNAVAILABLE"));
      return 1;
    }
  }
  if (isQuarantineAuditInvocation(argv)) {
    try {
      const report = await (dependencies.quarantineAudit ?? auditCurrentQuarantine)();
      stdout(JSON.stringify(report));
      return report.unknown === 0 && report.criticalDeliveries === 0 ? 0 : 2;
    } catch {
      stderr(failure("QUARANTINE_AUDIT_UNAVAILABLE"));
      return 1;
    }
  }
  if (isQuarantineDiagnosisInvocation(argv)) {
    try {
      const report = await (dependencies.quarantineDiagnosis ?? diagnoseCurrentQuarantine)();
      stdout(JSON.stringify(report));
      return report.unknown === 0 && report.criticalDeliveries === 0 ? 0 : 2;
    } catch {
      stderr(failure("QUARANTINE_DIAGNOSIS_UNAVAILABLE"));
      return 1;
    }
  }
  if (isQuarantineRepairInvocation(argv)) {
    const expectedAuditHash = argv[3]!;
    try {
      const report = await (dependencies.quarantineRepair ?? repairCurrentQuarantine)(expectedAuditHash);
      stdout(JSON.stringify(report));
      return 0;
    } catch (error) {
      if (error instanceof TelegramQuarantineCandidateSetChangedError) {
        stderr(failure("QUARANTINE_CANDIDATE_SET_CHANGED"));
        return 2;
      }
      stderr(failure("QUARANTINE_REPAIR_FAILED"));
      return 1;
    }
  }
  stderr(failure("INVALID_INVOCATION"));
  return 1;
}

function isPreflightInvocation(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === "preflight" && argv[1] === "--json";
}

function isQuarantineAuditInvocation(argv: readonly string[]): boolean {
  return argv.length === 3 && argv[0] === "quarantine"
    && argv[1] === "audit" && argv[2] === "--json";
}

function isQuarantineDiagnosisInvocation(argv: readonly string[]): boolean {
  return argv.length === 3 && argv[0] === "quarantine"
    && argv[1] === "diagnose" && argv[2] === "--json";
}

function isQuarantineRepairInvocation(argv: readonly string[]): boolean {
  return argv.length === 4 && argv[0] === "quarantine" && argv[1] === "repair"
    && argv[2] === "--audit-hash" && /^[0-9a-f]{64}$/.test(argv[3] ?? "");
}

function auditCurrentQuarantine(): TelegramQuarantineAuditReport {
  const loaded = loadSessionGuardianEnvironment({ cwd: process.cwd(), env: process.env });
  const telegramJobs = parseTelegramJobConfig(loaded.workspace, loaded.env);
  return auditTelegramLegacyQuarantine({
    databasePath: telegramJobs.databasePath,
    checkedAt: Date.now(),
  });
}

function diagnoseCurrentQuarantine(): TelegramQuarantineDiagnosisReport {
  const loaded = loadSessionGuardianEnvironment({ cwd: process.cwd(), env: process.env });
  const telegramJobs = parseTelegramJobConfig(loaded.workspace, loaded.env);
  return diagnoseTelegramLegacyQuarantine({
    databasePath: telegramJobs.databasePath,
    checkedAt: Date.now(),
  });
}

async function repairCurrentQuarantine(expectedAuditHash: string): Promise<TelegramQuarantineRepairResult> {
  const loaded = loadSessionGuardianEnvironment({ cwd: process.cwd(), env: process.env });
  const telegramJobs = parseTelegramJobConfig(loaded.workspace, loaded.env);
  assertTeleCodexInactive();
  const checkedAt = Date.now();
  const audit = auditTelegramLegacyQuarantine({
    databasePath: telegramJobs.databasePath,
    checkedAt,
  });
  if (audit.auditHash !== expectedAuditHash || audit.unknown !== 0 || audit.criticalDeliveries !== 0) {
    throw new TelegramQuarantineCandidateSetChangedError();
  }
  const backup = await createVerifiedTelegramJobBackup({
    databasePath: telegramJobs.databasePath,
    destinationPath: path.join(
      loaded.workspace,
      ".telecodex",
      "release-state",
      "quarantine-repair",
      `jobs-backup-${checkedAt}-${process.pid}.sqlite`,
    ),
  });
  return repairTelegramLegacyQuarantine({
    databasePath: telegramJobs.databasePath,
    expectedAuditHash,
    backupSha256: backup.backupSha256,
    checkedAt: Date.now(),
  });
}

function assertTeleCodexInactive(): void {
  const result = spawnSync("systemctl", ["is-active", "telecodex.service"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error || result.signal || result.stdout.trim() !== "inactive") {
    throw new Error("TeleCodex service is not proven inactive");
  }
}

async function inspectCurrentReleaseState(): Promise<TeleCodexReleasePreflightReport> {
  const loaded = loadSessionGuardianEnvironment({ cwd: process.cwd(), env: process.env });
  let store: SqliteTelegramJobStore | null = null;
  let preflightStore: TeleCodexReleasePreflightStore;
  try {
    const telegramJobs = parseTelegramJobConfig(loaded.workspace, loaded.env);
    store = new SqliteTelegramJobStore(telegramJobs.databasePath, { readOnly: true });
    preflightStore = store;
  } catch {
    preflightStore = unavailableStore();
  }

  try {
    return await inspectTeleCodexReleasePreflight({
      checkedAt: Date.now,
      releaseId: () => null,
      store: preflightStore,
      guardianStatus: async () => {
        const guardian = parseSessionGuardianConfig(loaded.env, {
          home: os.homedir(),
          workspace: loaded.workspace,
        });
        const response = await new SessionGuardianIpcClient(guardian.socketPath).status();
        return { running: response.outcome !== "failed" && response.status?.running === true };
      },
    });
  } finally {
    store?.close();
  }
}

function unavailableStore(): TeleCodexReleasePreflightStore {
  const unavailable = (): never => { throw new Error("Telegram job store unavailable"); };
  return {
    probeReleaseReadable: unavailable,
    listUnfinished: unavailable,
    listStatusCandidates: unavailable,
    listDueDeliveries: unavailable,
    listDeliveries: unavailable,
  };
}

function failure(
  code: "INVALID_INVOCATION" | "PREFLIGHT_UNAVAILABLE" | "QUARANTINE_AUDIT_UNAVAILABLE"
    | "QUARANTINE_DIAGNOSIS_UNAVAILABLE" | "QUARANTINE_CANDIDATE_SET_CHANGED"
    | "QUARANTINE_REPAIR_FAILED",
): string {
  return JSON.stringify({ outcome: "failed", code });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exitCode = await runTeleCodexReleaseCli(process.argv.slice(2));
}
