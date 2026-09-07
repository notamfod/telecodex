import { expect, it } from "vitest";

import { readSyntheticMigrationProof }
  from "../src/telegram-job-migration-provenance.js";

const checksum = "c".repeat(64);
const source = { botId: `legacy-json-v1:${checksum}`, updateId: 7 };
const proof = { version: "1", checksum, sourceIdentity: "synthetic", ordinal: 7 };

it("accepts only the exact synthetic migration proof bound to its source", () => {
  expect(readSyntheticMigrationProof({ migration: proof }, source)).toEqual(proof);
  for (const migration of [
    { ...proof, version: "" },
    { ...proof, checksum: "d".repeat(64) },
    { ...proof, sourceIdentity: "native" },
    { ...proof, ordinal: 8 },
    { ...proof, extra: true },
    null,
  ]) {
    expect(readSyntheticMigrationProof({ migration }, source)).toBeNull();
  }
  expect(readSyntheticMigrationProof({ migration: proof }, { botId: "legacy-json-v1:bad", updateId: 7 }))
    .toBeNull();
});
