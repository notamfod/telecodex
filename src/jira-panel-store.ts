import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { JiraPanelLocation, JiraPanelStore } from "./jira-panel.js";

export function createJiraPanelStore(filePath: string): JiraPanelStore {
  let location = readLocation(filePath);
  return {
    read: () => {
      location = readLocation(filePath);
      return location;
    },
    write: (value) => {
      let temporaryPath: string | undefined;
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
        writeFileSync(temporaryPath, JSON.stringify({
          messageId: value.messageId ?? null,
          ...(value.cleanupMessageIds?.length
            ? { cleanupMessageIds: value.cleanupMessageIds }
            : {}),
        }), { encoding: "utf8", mode: 0o600 });
        renameSync(temporaryPath, filePath);
        location = value;
      } catch (error) {
        if (temporaryPath) {
          try {
            unlinkSync(temporaryPath);
          } catch {
            // The temporary file may not have been created.
          }
        }
        throw error;
      }
    },
    withLock: (action) => withFileLock(`${filePath}.lock`, action),
  };
}

function readLocation(filePath: string): JiraPanelLocation {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      messageId?: unknown;
      cleanupMessageIds?: unknown;
    };
    const messageId = typeof parsed.messageId === "number" ? parsed.messageId : undefined;
    const cleanupMessageIds = Array.isArray(parsed.cleanupMessageIds)
      ? [...new Set(parsed.cleanupMessageIds.filter(
        (value): value is number => typeof value === "number" && value !== messageId,
      ))]
      : [];
    return {
      ...(messageId !== undefined ? { messageId } : {}),
      ...(cleanupMessageIds.length ? { cleanupMessageIds } : {}),
    };
  } catch (error) {
    console.warn(
      "Failed to load Jira panel state:",
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 60_000;
const OWNER_WRITE_GRACE_MS = 10_000;

async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }), {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (abandonedLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Jira panel lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }

  try {
    return await action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function abandonedLock(lockPath: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
      pid?: unknown;
    };
    if (typeof owner.pid !== "number") return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return isNoSuchProcess(error);
    }
  } catch {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > OWNER_WRITE_GRACE_MS;
    } catch {
      return false;
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
