import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

/**
 * Create a private SQLite inode if absent without opening an existing database.
 * Closing any descriptor for an existing inode can release process-wide fcntl locks.
 */
export function prepareReviewPipelineSqliteFile(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      closeSync(descriptor);
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    try {
      chmodSync(file, 0o600);
      return;
    } catch (error) {
      if (!isMissing(error) || attempt === 2) throw error;
    }
  }
}

function isExists(error: unknown): boolean { return isCode(error, "EEXIST"); }
function isMissing(error: unknown): boolean { return isCode(error, "ENOENT"); }
function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
