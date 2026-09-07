import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compareLegacyTelegramJobs,
  exportLegacyTelegramJobs,
  importLegacyTelegramJobs,
} from "../src/telegram-job-migration.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";

describe("Telegram ingress status-anchor migration compatibility", () => {
  it("excludes the reserved anchor from legacy delivery parity and export", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-ingress-migration-"));
    const sourcePath = path.join(directory, "jobs.json");
    const databasePath = path.join(directory, "jobs.sqlite");
    const outputPath = path.join(directory, "export.json");
    const legacy = [{
      id: "waiting",
      contextKey: "-100123:42",
      chatId: -100123,
      messageThreadId: 42,
      threadId: "thread-waiting",
      input: "prompt",
      state: "waiting",
      sentPartKeys: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_010,
    }];
    writeFileSync(sourcePath, JSON.stringify(legacy));
    try {
      importLegacyTelegramJobs({ sourcePath, databasePath });
      const store = new SqliteTelegramJobStore(databasePath);
      store.insertDelivery({
        jobId: "waiting",
        partKey: "status-anchor",
        ordinal: 0,
        kind: "status-anchor",
        state: "pending",
        payload: { chatId: -100123, messageThreadId: 42, sourceMessageId: 1 },
        contentHash: "a".repeat(64),
        updatedAt: 1_700_000_000_010,
      });
      store.close();

      expect(compareLegacyTelegramJobs({ sourcePath, databasePath })).toMatchObject({
        matches: true,
        mismatches: [],
      });
      expect(exportLegacyTelegramJobs({ databasePath, outputPath, limit: 10 })).toMatchObject({
        exportedCount: 1,
      });
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(legacy);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
