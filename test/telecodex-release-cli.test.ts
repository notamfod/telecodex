import { vi } from "vitest";

import { runTeleCodexReleaseCli } from "../src/telecodex-release-cli.js";
import type { TeleCodexReleasePreflightReport } from "../src/telecodex-release-preflight.js";
import type {
  TelegramQuarantineAuditReport,
  TelegramQuarantineDiagnosisReport,
} from "../src/telegram-job-quarantine-repair.js";
import {
  TelegramQuarantineCandidateSetChangedError,
  type TelegramQuarantineRepairResult,
} from "../src/telegram-job-quarantine-maintenance.js";

function report(
  reasons: TeleCodexReleasePreflightReport["reasons"] = [],
): TeleCodexReleasePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: 1_700_000_000_000,
    safeToRestart: reasons.length === 0,
    reasons,
    jobs: { queued: 0, running: 0, delivering: 0, attention: 0 },
    deliveries: { pending: 0, sending: 0, uncertain: 0, failed: 0 },
    guardian: reasons.includes("GUARDIAN_UNAVAILABLE") ? "unavailable" : "ready",
    releaseId: null,
  };
}

function fixture(result: TeleCodexReleasePreflightReport = report()) {
  const output: string[] = [];
  const errors: string[] = [];
  const preflight = vi.fn(async () => result);
  const quarantineAudit = vi.fn(async () => quarantineReport());
  const quarantineDiagnosis = vi.fn(async () => quarantineDiagnosisReport());
  const quarantineRepair = vi.fn(async () => quarantineRepairResult());
  const run = (argv: readonly string[]) => runTeleCodexReleaseCli(argv, {
    preflight,
    quarantineAudit,
    quarantineDiagnosis,
    quarantineRepair,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  return { run, output, errors, preflight, quarantineAudit, quarantineDiagnosis, quarantineRepair };
}

function quarantineRepairResult(): TelegramQuarantineRepairResult {
  return {
    schemaVersion: 1, repaired: 3, auditHash: "a".repeat(64), backupSha256: "b".repeat(64),
  };
}

function quarantineDiagnosisReport(): TelegramQuarantineDiagnosisReport {
  return {
    schemaVersion: 1,
    checkedAt: 1_700_604_801_002,
    total: 3,
    repairable: 0,
    unknown: 3,
    criticalDeliveries: 0,
    rejections: {
      condition01_quarantine_reason: 0,
      condition02_projection_shape: 0,
      condition03_terminal_state: 0,
      condition04_reconciliation_intent: 0,
      condition05_projection_version: 0,
      condition06_projection_timestamp: 0,
      condition07_synthetic_source: 0,
      condition08_scrubbed_source: 0,
      condition09_migration_marker: 0,
      condition10_archived_history: 0,
      condition11_live_history: 0,
      condition12_delivery_state: 0,
      condition13_plan_mapping: 0,
      condition14_synthetic_deliveries: 3,
      condition15_foreign_keys: 0,
    },
  };
}

function quarantineReport(
  overrides: Partial<TelegramQuarantineAuditReport> = {},
): TelegramQuarantineAuditReport {
  return {
    schemaVersion: 1,
    checkedAt: 1_700_604_801_002,
    repairable: 3,
    unknown: 0,
    criticalDeliveries: 0,
    auditHash: "a".repeat(64),
    ...overrides,
  };
}

describe("TeleCodex release CLI", () => {
  it("prints one JSON report and exits zero when restart is safe", async () => {
    const subject = fixture();

    await expect(subject.run(["preflight", "--json"])).resolves.toBe(0);

    expect(subject.preflight).toHaveBeenCalledOnce();
    expect(subject.output).toHaveLength(1);
    expect(JSON.parse(subject.output[0]!)).toEqual(report());
    expect(subject.errors).toEqual([]);
  });

  it("exits two with the bounded report when work makes restart unsafe", async () => {
    const unsafe = report(["ACTIVE_TURN", "DELIVERY_SENDING"]);
    const subject = fixture(unsafe);

    await expect(subject.run(["preflight", "--json"])).resolves.toBe(2);

    expect(JSON.parse(subject.output[0]!)).toEqual(unsafe);
    expect(subject.errors).toEqual([]);
  });

  it("exits one when the canonical store is unavailable", async () => {
    const unavailable = report(["STORE_UNAVAILABLE"]);
    const subject = fixture(unavailable);

    await expect(subject.run(["preflight", "--json"])).resolves.toBe(1);

    expect(JSON.parse(subject.output[0]!)).toEqual(unavailable);
  });

  it.each([
    { argv: [] },
    { argv: ["preflight"] },
    { argv: ["preflight", "--text"] },
    { argv: ["unknown", "--json"] },
  ])(
    "rejects invalid invocation %j without inspecting live state",
    async ({ argv }) => {
      const subject = fixture();

      await expect(subject.run(argv)).resolves.toBe(1);

      expect(subject.preflight).not.toHaveBeenCalled();
      expect(subject.quarantineAudit).not.toHaveBeenCalled();
      expect(subject.output).toEqual([]);
      expect(subject.errors).toEqual([JSON.stringify({
        outcome: "failed",
        code: "INVALID_INVOCATION",
      })]);
    },
  );

  it("redacts unexpected dependency errors", async () => {
    const subject = fixture();
    subject.preflight.mockRejectedValueOnce(new Error("token=secret path=/root/private"));

    await expect(subject.run(["preflight", "--json"])).resolves.toBe(1);

    expect(subject.output).toEqual([]);
    expect(subject.errors).toEqual([JSON.stringify({ outcome: "failed", code: "PREFLIGHT_UNAVAILABLE" })]);
    expect(subject.errors[0]).not.toMatch(/secret|private|token/i);
  });

  it("prints exactly one bounded audit report and exits zero when it is safe", async () => {
    const subject = fixture();
    const safe = quarantineReport({ repairable: 7 });
    subject.quarantineAudit.mockResolvedValueOnce(safe);

    await expect(subject.run(["quarantine", "audit", "--json"])).resolves.toBe(0);

    expect(subject.quarantineAudit).toHaveBeenCalledOnce();
    expect(subject.preflight).not.toHaveBeenCalled();
    expect(subject.output).toEqual([JSON.stringify(safe)]);
    expect(subject.errors).toEqual([]);
    const parsed = JSON.parse(subject.output[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion", "checkedAt", "repairable", "unknown", "criticalDeliveries", "auditHash",
    ]);
    expect(subject.output[0]).not.toMatch(/(?:job|delivery|message|thread|event|path|payload|prompt|response|token)Ids?\b/i);
    expect(subject.output[0]).not.toMatch(/(?:databasePath|payload|prompt|response|tokens?)/i);
  });

  it("exits two for unknown quarantine rows without special-casing repairable rows", async () => {
    const subject = fixture();
    subject.quarantineAudit.mockResolvedValueOnce(quarantineReport({ repairable: 5, unknown: 1 }));

    await expect(subject.run(["quarantine", "audit", "--json"])).resolves.toBe(2);

    expect(subject.output).toHaveLength(1);
    expect(subject.errors).toEqual([]);
  });

  it("exits two for critical deliveries", async () => {
    const subject = fixture();
    subject.quarantineAudit.mockResolvedValueOnce(quarantineReport({ criticalDeliveries: 1 }));

    await expect(subject.run(["quarantine", "audit", "--json"])).resolves.toBe(2);

    expect(subject.output).toHaveLength(1);
    expect(subject.errors).toEqual([]);
  });

  it("exits two when unknown rows and critical deliveries are both present", async () => {
    const subject = fixture();
    subject.quarantineAudit.mockResolvedValueOnce(quarantineReport({ unknown: 2, criticalDeliveries: 3 }));

    await expect(subject.run(["quarantine", "audit", "--json"])).resolves.toBe(2);

    expect(subject.output).toHaveLength(1);
    expect(subject.errors).toEqual([]);
  });

  it.each([
    { argv: ["quarantine"] },
    { argv: ["quarantine", "audit"] },
    { argv: ["quarantine", "audit", "--text"] },
    { argv: ["quarantine", "audit", "--json", "--verbose"] },
    { argv: ["quarantine", "audit", "--json", "/root/private/jobs.sqlite"] },
    { argv: ["quarantine", "audit", "/root/private/jobs.sqlite", "--json"] },
    { argv: ["quarantine", "repair", "--json"] },
  ])("rejects invalid quarantine invocation $argv without auditing", async ({ argv }) => {
    const subject = fixture();

    await expect(subject.run(argv)).resolves.toBe(1);

    expect(subject.quarantineAudit).not.toHaveBeenCalled();
    expect(subject.preflight).not.toHaveBeenCalled();
    expect(subject.output).toEqual([]);
    expect(subject.errors).toEqual([JSON.stringify({
      outcome: "failed",
      code: "INVALID_INVOCATION",
    })]);
  });

  it("redacts unexpected quarantine audit errors", async () => {
    const subject = fixture();
    subject.quarantineAudit.mockRejectedValueOnce(new Error(
      "token=secret path=/root/private job=job-123 payload=raw prompt=hidden response=private",
    ));

    await expect(subject.run(["quarantine", "audit", "--json"])).resolves.toBe(1);

    expect(subject.preflight).not.toHaveBeenCalled();
    expect(subject.output).toEqual([]);
    expect(subject.errors).toEqual([JSON.stringify({
      outcome: "failed",
      code: "QUARANTINE_AUDIT_UNAVAILABLE",
    })]);
    expect(subject.errors[0]).not.toMatch(/secret|private|job-123|raw|hidden|token|path|payload|prompt|response/i);
  });

  it("prints one safe quarantine diagnosis report", async () => {
    const subject = fixture();

    await expect(subject.run(["quarantine", "diagnose", "--json"])).resolves.toBe(2);

    expect(subject.quarantineDiagnosis).toHaveBeenCalledOnce();
    expect(subject.quarantineAudit).not.toHaveBeenCalled();
    expect(subject.preflight).not.toHaveBeenCalled();
    expect(subject.output).toEqual([JSON.stringify(quarantineDiagnosisReport())]);
    expect(subject.errors).toEqual([]);
    expect(subject.output[0]).not.toMatch(
      /databasePath|payload|prompt|response|attachment|threadId|turnId|eventId|jobId/,
    );
  });

  it("runs repair only for one exact lowercase audit hash", async () => {
    const subject = fixture();
    const hash = "a".repeat(64);

    await expect(subject.run(["quarantine", "repair", "--audit-hash", hash])).resolves.toBe(0);

    expect(subject.quarantineRepair).toHaveBeenCalledWith(hash);
    expect(subject.output).toEqual([JSON.stringify(quarantineRepairResult())]);
    expect(subject.errors).toEqual([]);
  });

  it("returns two when the repair candidate set changed", async () => {
    const subject = fixture();
    subject.quarantineRepair.mockRejectedValueOnce(new TelegramQuarantineCandidateSetChangedError());

    await expect(subject.run([
      "quarantine", "repair", "--audit-hash", "a".repeat(64),
    ])).resolves.toBe(2);

    expect(subject.output).toEqual([]);
    expect(subject.errors).toEqual([JSON.stringify({
      outcome: "failed", code: "QUARANTINE_CANDIDATE_SET_CHANGED",
    })]);
  });
});
