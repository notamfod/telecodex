import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compareLegacyTelegramJobs, exportLegacyTelegramJobs, importLegacyTelegramJobs,
  prepareTelegramJobStoreMode, synchronizeLegacyTelegramJobsShadow,
} from "../src/telegram-job-migration.js";
import { parseTelegramJobConfig } from "../src/config.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";

const START = 1_700_000_000_000;
const source = JSON.stringify([{ id: "safe", contextKey: "-100", chatId: -100, threadId: null,
  input: "prompt", state: "waiting", sentPartKeys: [], createdAt: START, updatedAt: START }]);

describe("Telegram migration storage path preflight", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "telecodex-migration-paths-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("rejects lexical source overlap with SQLite, WAL, and SHM before reading or writing", () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const databasePath = path.join(directory, `lexical-${suffix || "db"}.sqlite`);
      const sourcePath = `${databasePath}${suffix}`;
      writeFileSync(sourcePath, source); const before = readFileSync(sourcePath);
      expect(() => importLegacyTelegramJobs({ sourcePath, databasePath })).toThrowError(
        expect.objectContaining({ code: "SOURCE_PATH_CONFLICT" }),
      );
      expect(readFileSync(sourcePath)).toEqual(before);
    }
    const databasePath = path.join(directory, "shared.sqlite");
    expect(() => compareLegacyTelegramJobs({ sourcePath: `${databasePath}-wal`, databasePath })).toThrowError(
      expect.objectContaining({ code: "SOURCE_PATH_CONFLICT" }),
    );
    expect(synchronizeLegacyTelegramJobsShadow({ sourcePath: `${databasePath}-shm`, databasePath })).toMatchObject({
      sqliteEligible: false, failure: { code: "SOURCE_PATH_CONFLICT" }, parity: null,
    });
  });

  it("rejects existing symlink and hardlink aliases without changing source bytes", () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const sourcePath = path.join(directory, `${kind}.json`); const databasePath = path.join(directory, `${kind}.sqlite`);
      writeFileSync(sourcePath, source); const before = readFileSync(sourcePath);
      if (kind === "symlink") symlinkSync(sourcePath, databasePath); else linkSync(sourcePath, databasePath);
      expect(() => importLegacyTelegramJobs({ sourcePath, databasePath })).toThrowError(
        expect.objectContaining({ code: "SOURCE_PATH_CONFLICT" }),
      );
      expect(readFileSync(sourcePath)).toEqual(before);
    }
  });

  it("refuses export through symlink or hardlink aliases of SQLite and keeps the ledger readable", () => {
    const databasePath = path.join(directory, "jobs.sqlite"); new SqliteTelegramJobStore(databasePath).close();
    for (const kind of ["symlink", "hardlink"] as const) {
      const outputPath = path.join(directory, `${kind}.json`);
      if (kind === "symlink") symlinkSync(databasePath, outputPath); else linkSync(databasePath, outputPath);
      expect(() => exportLegacyTelegramJobs({ databasePath, outputPath, limit: 10 })).toThrowError(
        expect.objectContaining({ code: "EXPORT_UNSAFE", reasons: [{ reasonCode: "PATH_CONFLICT" }] }),
      );
      const inspect = new SqliteTelegramJobStore(databasePath);
      try { expect(inspect.countJobs()).toBe(0); } finally { inspect.close(); }
    }
  });

  it("includes sidecars beside the real SQLite target when the configured database path is a symlink", () => {
    const realDatabase = path.join(directory, "real.sqlite"); new SqliteTelegramJobStore(realDatabase).close();
    const databasePath = path.join(directory, "configured.sqlite"); symlinkSync(realDatabase, databasePath);
    const realWal = `${realDatabase}-wal`;
    expect(() => compareLegacyTelegramJobs({ sourcePath: realWal, databasePath })).toThrowError(
      expect.objectContaining({ code: "SOURCE_PATH_CONFLICT" }),
    );
    expect(() => exportLegacyTelegramJobs({ databasePath, outputPath: realWal, limit: 10 })).toThrowError(
      expect.objectContaining({ code: "EXPORT_UNSAFE", reasons: [{ reasonCode: "PATH_CONFLICT" }] }),
    );
  });

  it("wraps raw pre-rename filesystem failures without paths or temporary artifacts", () => {
    const databasePath = path.join(directory, "write.sqlite"); new SqliteTelegramJobStore(databasePath).close();
    const outputPath = path.join(directory, "target-directory"); mkdirSync(outputPath);
    let error: unknown;
    try { exportLegacyTelegramJobs({ databasePath, outputPath, limit: 10 }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "EXPORT_WRITE_FAILED", message: "EXPORT_WRITE_FAILED", reasons: [] });
    expect(String(error)).not.toContain(outputPath);
    expect(readdirSync(directory).filter((name) => name.startsWith("target-directory.tmp-"))).toEqual([]);
  });

  it.each(["config", "import", "compare", "shadow"] as const)(
    "rejects planned real WAL overlap through a dangling DB symlink in %s",
    (operation) => {
      const realDatabase = path.join(directory, `${operation}-real.sqlite`);
      const databasePath = path.join(directory, `${operation}-configured.sqlite`); symlinkSync(realDatabase, databasePath);
      const sourcePath = `${realDatabase}-wal`; writeFileSync(sourcePath, source); const before = readFileSync(sourcePath);
      if (operation === "config") expect(() => parseTelegramJobConfig(directory, {
        TELEGRAM_JOB_DB_PATH: databasePath, TELEGRAM_JOB_LEGACY_JSON_PATH: sourcePath,
      })).toThrow();
      else if (operation === "shadow") expect(synchronizeLegacyTelegramJobsShadow({ sourcePath, databasePath })).toMatchObject({
        sqliteEligible: false, failure: { code: "SOURCE_PATH_CONFLICT" }, parity: null,
      });
      else expect(() => (operation === "import" ? importLegacyTelegramJobs({ sourcePath, databasePath })
        : compareLegacyTelegramJobs({ sourcePath, databasePath }))).toThrowError(
        expect.objectContaining({ code: "SOURCE_PATH_CONFLICT" }),
      );
      expect(readFileSync(sourcePath)).toEqual(before); expect(existsSync(realDatabase)).toBe(false);
    },
  );

  it.each(["json", "shadow", "sqlite"] as const)("preflights paths before preparing %s authority", (mode) => {
    const databasePath = path.join(directory, `${mode}.sqlite`); const sourcePath = `${databasePath}-wal`;
    writeFileSync(sourcePath, source); const before = readFileSync(sourcePath);
    expect(() => prepareTelegramJobStoreMode({ mode, sourcePath, databasePath })).toThrowError(
      expect.objectContaining({ code: "SOURCE_PATH_CONFLICT" }),
    );
    expect(readFileSync(sourcePath)).toEqual(before); expect(existsSync(databasePath)).toBe(false);
  });
});
