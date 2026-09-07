import { fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { atomicPrivateWrite, AtomicWriteFailure } from "../src/telegram-job-atomic-export.js";

describe("atomic Telegram compatibility writes", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "telecodex-atomic-export-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("fsyncs the parent directory after atomically installing a private file", () => {
    const target = path.join(directory, "jobs.json"); let directorySyncs = 0;
    atomicPrivateWrite(target, "[]\n", { syncDirectory: (descriptor) => { fsyncSync(descriptor); directorySyncs += 1; } });
    expect(directorySyncs).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("[]\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("keeps the old target on pre-rename failure and returns only a stable safe error", () => {
    const target = path.join(directory, "jobs.json"); writeFileSync(target, "old");
    let error: unknown;
    try { atomicPrivateWrite(target, "new", { rename: () => { throw new Error(`secret ${target}`); } }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AtomicWriteFailure);
    expect(error).toMatchObject({ phase: "write_failed", message: "ATOMIC_WRITE_FAILED" });
    expect(String(error)).not.toContain(target);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("reports durability uncertainty without claiming rollback after directory fsync fails", () => {
    const target = path.join(directory, "jobs.json"); writeFileSync(target, "old");
    let error: unknown;
    try { atomicPrivateWrite(target, "new", { syncDirectory: () => { throw new Error(`secret ${target}`); } }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ phase: "durability_uncertain", message: "ATOMIC_WRITE_DURABILITY_UNCERTAIN" });
    expect(String(error)).not.toContain(target);
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});
