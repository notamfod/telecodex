import { createHash } from "node:crypto";

export interface TelegramQuarantineAuditHashCandidate {
  readonly jobId: string;
  readonly projectionVersion: number;
  readonly projectionUpdatedAt: number;
  readonly quarantineFingerprint: string;
  readonly quarantinedAt: number;
  readonly liveEventId: string;
  readonly liveEventAt: number;
  readonly checksum: string;
  readonly ordinal: number;
}

export function hashTelegramQuarantineAuditCandidates(
  candidates: readonly TelegramQuarantineAuditHashCandidate[],
): string {
  const hash = createHash("sha256");
  const sorted = [...candidates].sort((left, right) =>
    Buffer.compare(Buffer.from(left.jobId, "utf8"), Buffer.from(right.jobId, "utf8")));
  for (const candidate of sorted) {
    for (const field of [candidate.jobId, canonicalInteger(candidate.projectionVersion),
      canonicalInteger(candidate.projectionUpdatedAt), candidate.quarantineFingerprint,
      canonicalInteger(candidate.quarantinedAt), candidate.liveEventId,
      canonicalInteger(candidate.liveEventAt), candidate.checksum, canonicalInteger(candidate.ordinal)]) {
      const encoded = Buffer.from(field, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(encoded.length));
      hash.update(length).update(encoded);
    }
  }
  return hash.digest("hex");
}

function canonicalInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid quarantine audit hash input");
  return String(value);
}
