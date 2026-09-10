import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatTelegramErrorLog } from "./telegram-error-log.js";

export interface StatusBoardLocation {
  messageThreadId?: number;
  messageId?: number;
  legacyMessageId?: number;
}

export interface StatusBoardStore {
  read(): StatusBoardLocation;
  write(location: StatusBoardLocation): void;
}

/** Remembers the Dashboard topic and message so a restart reuses both. */
export function createStatusBoardStore(filePath: string): StatusBoardStore {
  let location = readLocation(filePath);
  return {
    read: () => location,
    write: (value) => {
      location = value;
      let temporaryPath: string | undefined;
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
        writeFileSync(temporaryPath, JSON.stringify({
          messageThreadId: value.messageThreadId ?? null,
          messageId: value.messageId ?? null,
          legacyMessageId: value.legacyMessageId ?? null,
        }), "utf8");
        renameSync(temporaryPath, filePath);
      } catch (error) {
        if (temporaryPath) {
          try {
            unlinkSync(temporaryPath);
          } catch {
            // Nothing useful to do if the temporary file was never created.
          }
        }
        console.warn(formatTelegramErrorLog("dashboard_store", error));
      }
    },
  };
}

function readLocation(filePath: string): StatusBoardLocation {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      messageThreadId?: unknown;
      messageId?: unknown;
      legacyMessageId?: unknown;
    };
    return {
      ...(typeof parsed.messageThreadId === "number"
        ? { messageThreadId: parsed.messageThreadId }
        : {}),
      ...(typeof parsed.messageId === "number" ? { messageId: parsed.messageId } : {}),
      ...(typeof parsed.legacyMessageId === "number"
        ? { legacyMessageId: parsed.legacyMessageId }
        : {}),
    };
  } catch (error) {
    console.warn(formatTelegramErrorLog("dashboard_store", error));
    return {};
  }
}
