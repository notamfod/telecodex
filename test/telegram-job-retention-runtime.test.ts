import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TelegramJobRetentionRuntime,
  type TelegramJobRetentionRuntimeEvent,
} from "../src/telegram-job-retention-runtime.js";

const DAY = 24 * 60 * 60 * 1_000;

describe("TelegramJobRetentionRuntime", () => {
  let directory: string;
  let materializationRoot: string;

  beforeEach(() => {
    vi.useFakeTimers();
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-retention-runtime-"));
    materializationRoot = path.join(directory, "materialized");
    mkdirSync(materializationRoot, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("runs after start, drains batches, and removes only returned orphaned files", async () => {
    const released = path.join(materializationRoot, "job", "released.txt");
    const retained = path.join(materializationRoot, "job", "retained.txt");
    mkdirSync(path.dirname(released), { recursive: true });
    writeFileSync(released, "released");
    writeFileSync(retained, "retained");
    const runRetention = vi.fn()
      .mockReturnValueOnce({
        payloadsPurged: 1,
        jobsDeleted: 0,
        orphanedMaterializedPaths: ["job/released.txt"],
      })
      .mockReturnValue({
        payloadsPurged: 0,
        jobsDeleted: 0,
        orphanedMaterializedPaths: [],
      });
    const runtime = new TelegramJobRetentionRuntime({
      store: {
        runRetention,
        retentionFileCleanupIsOrphaned: () => true,
        acknowledgeRetentionFileCleanup: vi.fn(),
      },
      materializationRoot,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      intervalMs: 60_000,
      batchSize: 1,
      now: () => 1_700_000_000_000,
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await runtime.runNow();

    expect(runRetention).toHaveBeenCalledTimes(2);
    expect(runRetention).toHaveBeenNthCalledWith(1, {
      now: 1_700_000_000_000,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      batchSize: 1,
    });
    expect(() => readFileSync(released)).toThrow();
    expect(readFileSync(retained, "utf8")).toBe("retained");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runRetention).toHaveBeenCalledTimes(3);
    await runtime.dispose();
  });

  it("delays the first automatic sweep for a bounded rollback grace window", async () => {
    const runRetention = vi.fn(() => ({
      payloadsPurged: 0,
      jobsDeleted: 0,
      orphanedMaterializedPaths: [],
    }));
    const runtime = new TelegramJobRetentionRuntime({
      store: {
        runRetention,
        retentionFileCleanupIsOrphaned: () => true,
        acknowledgeRetentionFileCleanup: vi.fn(),
      },
      materializationRoot,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      initialDelayMs: DAY,
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(runRetention).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runRetention).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("keeps the grace schedule when runNow is called manually", async () => {
    const runRetention = vi.fn(() => ({
      payloadsPurged: 0,
      jobsDeleted: 0,
      orphanedMaterializedPaths: [],
    }));
    const runtime = new TelegramJobRetentionRuntime({
      store: {
        runRetention,
        retentionFileCleanupIsOrphaned: () => true,
        acknowledgeRetentionFileCleanup: vi.fn(),
      },
      materializationRoot,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      initialDelayMs: DAY,
      intervalMs: 60_000,
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(DAY / 2);
    await runtime.runNow();
    expect(runRetention).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(DAY / 2);
    expect(runRetention).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runRetention).toHaveBeenCalledTimes(3);
    await runtime.dispose();
  });

  it("refuses traversal, parent symlinks, final symlinks, and directories", async () => {
    const outside = path.join(directory, "outside.txt");
    const linkedDirectory = path.join(directory, "linked-directory");
    const safeFile = path.join(materializationRoot, "safe.txt");
    const directoryPath = path.join(materializationRoot, "directory");
    writeFileSync(outside, "outside");
    mkdirSync(linkedDirectory);
    writeFileSync(path.join(linkedDirectory, "linked.txt"), "linked");
    writeFileSync(safeFile, "safe");
    mkdirSync(directoryPath);
    symlinkSync(outside, path.join(materializationRoot, "file-link"));
    symlinkSync(linkedDirectory, path.join(materializationRoot, "parent-link"));
    const events: TelegramJobRetentionRuntimeEvent[] = [];
    const runtime = new TelegramJobRetentionRuntime({
      store: {
        runRetention: () => ({
          payloadsPurged: 1,
          jobsDeleted: 0,
          orphanedMaterializedPaths: [
            "safe.txt",
            "../outside.txt",
            "file-link",
            "parent-link/linked.txt",
            "directory",
          ],
        }),
        retentionFileCleanupIsOrphaned: () => true,
        acknowledgeRetentionFileCleanup: vi.fn(),
      },
      materializationRoot,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      batchSize: 100,
      intervalMs: 60_000,
      onEvent: (event) => events.push(event),
    });

    await runtime.runNow();

    expect(() => readFileSync(safeFile)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readFileSync(path.join(linkedDirectory, "linked.txt"), "utf8")).toBe("linked");
    expect(events.filter((event) => event.code === "ORPHAN_PATH_SKIPPED")).toHaveLength(4);
    await runtime.dispose();
  });

  it("does not overlap sweeps and clears the next run during shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runRetention = vi.fn(() => ({
      payloadsPurged: 0,
      jobsDeleted: 0,
      orphanedMaterializedPaths: [],
    }));
    const runtime = new TelegramJobRetentionRuntime({
      store: {
        runRetention,
        retentionFileCleanupIsOrphaned: () => true,
        acknowledgeRetentionFileCleanup: vi.fn(),
      },
      materializationRoot,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      intervalMs: 60_000,
      batchSize: 100,
      beforeSweep: () => gate,
    });

    runtime.start();
    const firstTick = vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    const concurrent = runtime.runNow();
    const shutdown = runtime.dispose();
    expect(runRetention).not.toHaveBeenCalled();

    release();
    await firstTick;
    await concurrent;
    await shutdown;
    expect(runRetention).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(runRetention).toHaveBeenCalledTimes(1);
  });

  it("keeps transient deletion failures pending and acknowledges only a later success", async () => {
    const target = path.join(materializationRoot, "retry.txt");
    writeFileSync(target, "retry");
    const acknowledge = vi.fn();
    const unlinkFile = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
      .mockImplementationOnce(async (filePath: string) => { rmSync(filePath); });
    const runtime = new TelegramJobRetentionRuntime({
      store: {
        runRetention: () => ({
          payloadsPurged: 0, jobsDeleted: 0, orphanedMaterializedPaths: ["retry.txt"],
        }),
        retentionFileCleanupIsOrphaned: () => true,
        acknowledgeRetentionFileCleanup: acknowledge,
      },
      materializationRoot,
      payloadRetentionMs: 7 * DAY,
      metadataRetentionMs: 90 * DAY,
      unlinkFile,
    });

    await runtime.runNow();
    expect(readFileSync(target, "utf8")).toBe("retry");
    expect(acknowledge).not.toHaveBeenCalled();

    await runtime.runNow();
    expect(() => readFileSync(target)).toThrow();
    expect(acknowledge).toHaveBeenCalledWith("retry.txt");
    await runtime.dispose();
  });
});
