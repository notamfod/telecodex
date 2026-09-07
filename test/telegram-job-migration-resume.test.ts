import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { synchronizeLegacyTelegramJobsShadow } from "../src/telegram-job-migration.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";

const START = 1_700_000_000_000;

function legacy(id: string, state: "waiting" | "active", overrides: Record<string, unknown> = {}) {
  return { id, contextKey: "-100123:42", chatId: -100123, messageThreadId: 42,
    threadId: `thread-${id}`, input: `prompt-${id}`, state, sentPartKeys: [],
    createdAt: START, updatedAt: START + 10, ...overrides };
}

it("resumes shadow sync after canonical events commit before marker or source payload", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "telecodex-shadow-resume-"));
  const sourcePath = path.join(directory, "jobs.json"); const databasePath = path.join(directory, "jobs.sqlite");
  try {
    writeFileSync(sourcePath, JSON.stringify([legacy("partial", "waiting"), legacy("projected", "waiting")]));
    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath }).sqliteEligible).toBe(true);
    const evolved = [
      legacy("partial", "active", { threadId: "thread-partial-new", turnId: "turn-partial", updatedAt: START + 20 }),
      legacy("projected", "active", { threadId: "thread-projected-new", turnId: "turn-projected", updatedAt: START + 20 }),
    ];
    const source = JSON.stringify(evolved); const checksum = createHash("sha256").update(source).digest("hex");
    writeFileSync(sourcePath, source);
    const store = new SqliteTelegramJobStore(databasePath);
    const marker = store.getMetadata("legacy-json-migration") as Record<string, unknown>;
    store.setMetadata("legacy-json-migration", { ...marker, status: "in_progress", checksum, importedCount: 2 });
    store.transition({ jobId: "partial", eventId: `legacy-shadow:${checksum.slice(0, 16)}:0:dispatch.written`, expectedVersion: 2,
      event: { schemaVersion: 1, type: "dispatch.written", eventAt: START + 20 } });
    store.transition({ jobId: "projected", eventId: `legacy-shadow:${checksum.slice(0, 16)}:1:dispatch.written`, expectedVersion: 2,
      event: { schemaVersion: 1, type: "dispatch.written", eventAt: START + 20 } });
    store.transition({ jobId: "projected", eventId: `legacy-shadow:${checksum.slice(0, 16)}:1:turn.started`, expectedVersion: 3,
      event: { schemaVersion: 1, type: "turn.started", eventAt: START + 20,
        identifiers: { threadId: "thread-projected-new", turnId: "turn-projected" }, attention: { kind: "none" } } });
    store.close();

    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath })).toMatchObject({
      sqliteEligible: true, failure: null, parity: { matches: true },
    });
    const inspect = new SqliteTelegramJobStore(databasePath);
    try {
      expect(inspect.get("partial")).toMatchObject({ phase: "running", turnId: "turn-partial" });
      expect(inspect.get("projected")).toMatchObject({ phase: "running", turnId: "turn-projected" });
      expect(inspect.listEvents("partial")).toHaveLength(4);
      expect(inspect.listEvents("projected")).toHaveLength(4);
      expect(inspect.readSourcePayload("projected")).toMatchObject({ legacy: evolved[1] });
    } finally { inspect.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
