import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteHooks {
  readonly rename?: (source: string, target: string) => void;
  readonly syncDirectory?: (descriptor: number) => void;
}

export class AtomicWriteFailure extends Error {
  constructor(readonly phase: "write_failed" | "durability_uncertain") {
    super(phase === "write_failed" ? "ATOMIC_WRITE_FAILED" : "ATOMIC_WRITE_DURABILITY_UNCERTAIN");
    this.name = "AtomicWriteFailure";
  }
}

export function atomicPrivateWrite(filePath: string, content: string, hooks: AtomicWriteHooks = {}): void {
  const directory = path.dirname(filePath); const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null; let renamed = false;
  try {
    mkdirSync(directory, { recursive: true }); descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8"); fsyncSync(descriptor); closeSync(descriptor); descriptor = null;
    (hooks.rename ?? renameSync)(temporaryPath, filePath); renamed = true;
    const directoryDescriptor = openSync(directory, "r");
    try { (hooks.syncDirectory ?? fsyncSync)(directoryDescriptor); } finally { closeQuietly(directoryDescriptor); }
  } catch {
    if (descriptor !== null) closeQuietly(descriptor);
    if (!renamed && existsSync(temporaryPath)) { try { unlinkSync(temporaryPath); } catch { /* stable error wins */ } }
    throw new AtomicWriteFailure(renamed ? "durability_uncertain" : "write_failed");
  }
}

function closeQuietly(descriptor: number): void { try { closeSync(descriptor); } catch { /* preserve primary result */ } }
