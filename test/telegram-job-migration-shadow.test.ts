import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { exportLegacyTelegramJobs, synchronizeLegacyTelegramJobsShadow } from "../src/telegram-job-migration.js";
import { SqliteTelegramJobStore, TelegramJobStore } from "../src/telegram-job-store.js";

const START = 1_700_000_000_000;
function legacy(state: "waiting" | "awaiting-model", updatedAt: number, extra: Record<string, unknown> = {}) {
  return { id: "choice", contextKey: "-100:7", chatId: -100, messageThreadId: 7,
    threadId: "thread-choice", input: "prompt", state, sentPartKeys: [], createdAt: START, updatedAt, ...extra };
}

it("keeps evolved awaiting-model queued but non-dispatchable and later clears attention", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "telecodex-shadow-awaiting-"));
  const sourcePath = path.join(directory, "jobs.json"); const databasePath = path.join(directory, "jobs.sqlite");
  try {
    writeFileSync(sourcePath, JSON.stringify([legacy("waiting", START + 10)]));
    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath }).sqliteEligible).toBe(true);
    writeFileSync(sourcePath, JSON.stringify([legacy("awaiting-model", START + 20, { selectionToken: "safe-token" })]));

    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath })).toMatchObject({
      sqliteEligible: true, parity: { matches: true }, failure: null,
    });
    let store = new SqliteTelegramJobStore(databasePath);
    try {
      expect(store.get("choice")).toMatchObject({ phase: "queued",
        attention: { kind: "required", code: "LEGACY_AWAITING_MODEL" } });
      expect(store.listDispatchable(10)).toEqual([]);
    } finally { store.close(); }
    const compatibilityPath = path.join(directory, "compat.json");
    exportLegacyTelegramJobs({ databasePath, outputPath: compatibilityPath, limit: 10 });
    expect(new TelegramJobStore(compatibilityPath).get("choice")).toMatchObject({ state: "awaiting-model" });

    writeFileSync(sourcePath, JSON.stringify([legacy("waiting", START + 30)]));
    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath }).sqliteEligible).toBe(true);
    store = new SqliteTelegramJobStore(databasePath);
    try {
      expect(store.get("choice")).toMatchObject({ phase: "queued", attention: { kind: "none" } });
      expect(store.listDispatchable(10).map((job) => job.id)).toEqual(["choice"]);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
