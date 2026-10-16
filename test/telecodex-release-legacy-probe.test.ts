import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLegacyReleasePreflightStore }
  from "../src/telecodex-release-legacy-probe.js";
import { inspectTeleCodexReleasePreflight }
  from "../src/telecodex-release-preflight.js";

const CHECKED_AT = 1_700_000_000_000;

function inspect(filePath: string) {
  return inspectTeleCodexReleasePreflight({
    checkedAt: () => CHECKED_AT,
    releaseId: () => null,
    store: createLegacyReleasePreflightStore(filePath),
  });
}

describe("createLegacyReleasePreflightStore", () => {
  it("treats an absent legacy store as an empty idle queue", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-release-legacy-"));
    try {
      await expect(inspect(path.join(directory, "jobs.json"))).resolves.toMatchObject({
        safeToRestart: true,
        reasons: [],
        jobs: { queued: 0, running: 0, delivering: 0, attention: 0 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks waiting, active, and delivering legacy work conservatively", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-release-legacy-"));
    try {
      const filePath = path.join(directory, "jobs.json");
      writeFileSync(filePath, JSON.stringify([
        { id: "waiting", state: "waiting" },
        { id: "awaiting", state: "awaiting-model" },
        { id: "active", state: "active" },
        { id: "delivery", state: "delivering" },
      ]));

      await expect(inspect(filePath)).resolves.toMatchObject({
        safeToRestart: false,
        reasons: ["ACTIVE_TURN", "DELIVERY_PENDING"],
        jobs: { queued: 2, running: 1, delivering: 1, attention: 0 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "not json",
    JSON.stringify({ id: "not-an-array" }),
    JSON.stringify([{ id: "unknown", state: "mystery" }]),
    JSON.stringify([{ id: "", state: "active" }]),
  ])("fails closed for an invalid legacy store", async (contents) => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-release-legacy-"));
    try {
      const filePath = path.join(directory, "jobs.json");
      writeFileSync(filePath, contents);

      await expect(inspect(filePath)).resolves.toMatchObject({
        safeToRestart: false,
        reasons: ["STORE_UNAVAILABLE"],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
