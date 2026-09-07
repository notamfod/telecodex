import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import type {
  TelegramJobRetentionInput,
  TelegramJobRetentionResult,
} from "./telegram-job-store.js";

export const DEFAULT_TELEGRAM_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_TELEGRAM_RETENTION_BATCH_SIZE = 100;

interface TelegramJobRetentionStore {
  runRetention(input: TelegramJobRetentionInput): TelegramJobRetentionResult;
  retentionFileCleanupIsOrphaned(relativePath: string): boolean;
  acknowledgeRetentionFileCleanup(relativePath: string): void;
}

export interface TelegramJobRetentionRuntimeEvent {
  readonly code:
    | "SWEEP_COMPLETED"
    | "SWEEP_FAILED"
    | "ORPHAN_PATH_SKIPPED"
    | "ORPHAN_DELETE_FAILED";
  readonly payloadsPurged?: number;
  readonly jobsDeleted?: number;
  readonly filesDeleted?: number;
}

export interface TelegramJobRetentionRuntimeOptions {
  readonly store: TelegramJobRetentionStore;
  readonly materializationRoot: string;
  readonly payloadRetentionMs: number;
  readonly metadataRetentionMs: number;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
  readonly batchSize?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: TelegramJobRetentionRuntimeEvent) => void;
  /** Test seam for proving that shutdown waits for an in-flight sweep. */
  readonly beforeSweep?: () => Promise<void>;
  readonly unlinkFile?: (filePath: string) => Promise<void>;
}

export interface TelegramJobRetentionSweepResult {
  readonly payloadsPurged: number;
  readonly jobsDeleted: number;
  readonly filesDeleted: number;
}

export class TelegramJobRetentionRuntime {
  private readonly materializationRoot: string;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<TelegramJobRetentionSweepResult> | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly options: TelegramJobRetentionRuntimeOptions) {
    if (!path.isAbsolute(options.materializationRoot)
      || options.materializationRoot === path.parse(options.materializationRoot).root
      || options.materializationRoot.includes("\0")) {
      throw new Error("Invalid Telegram retention materialization root");
    }
    this.materializationRoot = path.resolve(options.materializationRoot);
    this.intervalMs = positiveInteger(
      options.intervalMs ?? DEFAULT_TELEGRAM_RETENTION_INTERVAL_MS,
      "Telegram retention interval",
    );
    this.initialDelayMs = nonNegativeInteger(
      options.initialDelayMs ?? 0,
      "Telegram retention initial delay",
    );
    this.batchSize = positiveInteger(
      options.batchSize ?? DEFAULT_TELEGRAM_RETENTION_BATCH_SIZE,
      "Telegram retention batch size",
    );
    positiveInteger(options.payloadRetentionMs, "Telegram payload retention");
    positiveInteger(options.metadataRetentionMs, "Telegram metadata retention");
    if (options.metadataRetentionMs < options.payloadRetentionMs) {
      throw new Error("Invalid Telegram retention window");
    }
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.disposed) throw new Error("Telegram retention runtime is disposed");
    if (this.started) return;
    this.started = true;
    this.schedule(this.initialDelayMs);
  }

  runNow(): Promise<TelegramJobRetentionSweepResult> {
    if (this.disposed) return Promise.reject(new Error("Telegram retention runtime is disposed"));
    if (this.inFlight) return this.inFlight;
    const sweep = this.sweep();
    this.inFlight = sweep;
    sweep.then(
      () => { if (this.inFlight === sweep) this.inFlight = undefined; },
      () => { if (this.inFlight === sweep) this.inFlight = undefined; },
    );
    return sweep;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      return this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runNow();
    } catch {
      this.emit({ code: "SWEEP_FAILED" });
    } finally {
      this.schedule(this.intervalMs);
    }
  }

  private async sweep(): Promise<TelegramJobRetentionSweepResult> {
    await this.options.beforeSweep?.();
    let payloadsPurged = 0;
    let jobsDeleted = 0;
    let filesDeleted = 0;
    let changed: number;
    do {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid Telegram retention clock");
      const result = this.options.store.runRetention({
        now,
        payloadRetentionMs: this.options.payloadRetentionMs,
        metadataRetentionMs: this.options.metadataRetentionMs,
        batchSize: this.batchSize,
      });
      payloadsPurged += result.payloadsPurged;
      jobsDeleted += result.jobsDeleted;
      for (const relativePath of result.orphanedMaterializedPaths) {
        if (!this.options.store.retentionFileCleanupIsOrphaned(relativePath)) continue;
        const outcome = await this.removeOrphanedFile(relativePath);
        if (outcome === "deleted") filesDeleted += 1;
        if (outcome !== "retry") {
          this.options.store.acknowledgeRetentionFileCleanup(relativePath);
        }
      }
      changed = result.payloadsPurged + result.jobsDeleted;
    } while (!this.disposed && changed >= this.batchSize);
    const summary = { payloadsPurged, jobsDeleted, filesDeleted };
    this.emit({ code: "SWEEP_COMPLETED", ...summary });
    return summary;
  }

  private async removeOrphanedFile(
    relativePath: string,
  ): Promise<"deleted" | "missing" | "discarded" | "retry"> {
    if (!safeRelativePath(relativePath)) {
      this.emit({ code: "ORPHAN_PATH_SKIPPED" });
      return "discarded";
    }
    const target = path.resolve(this.materializationRoot, relativePath);
    if (!within(this.materializationRoot, target)) {
      this.emit({ code: "ORPHAN_PATH_SKIPPED" });
      return "discarded";
    }
    try {
      const [root, parent, targetStat] = await Promise.all([
        realpath(this.materializationRoot),
        realpath(path.dirname(target)),
        lstat(target),
      ]);
      if (!within(root, parent) || !targetStat.isFile()) {
        this.emit({ code: "ORPHAN_PATH_SKIPPED" });
        return "discarded";
      }
      await (this.options.unlinkFile ?? unlink)(target);
      return "deleted";
    } catch (error) {
      if (isMissing(error)) return "missing";
      this.emit({ code: "ORPHAN_DELETE_FAILED" });
      return "retry";
    }
  }

  private emit(event: TelegramJobRetentionRuntimeEvent): void {
    try { this.options.onEvent?.(event); } catch { /* Retention must not fail on logging. */ }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
