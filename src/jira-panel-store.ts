import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JiraPanelLocation, JiraPanelStore } from "./jira-panel.js";

export function createJiraPanelStore(filePath: string): JiraPanelStore {
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
          messageId: value.messageId ?? null,
        }), { encoding: "utf8", mode: 0o600 });
        renameSync(temporaryPath, filePath);
      } catch (error) {
        if (temporaryPath) {
          try {
            unlinkSync(temporaryPath);
          } catch {
            // The temporary file may not have been created.
          }
        }
        console.warn(
          "Failed to persist Jira panel state:",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

function readLocation(filePath: string): JiraPanelLocation {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { messageId?: unknown };
    return typeof parsed.messageId === "number" ? { messageId: parsed.messageId } : {};
  } catch (error) {
    console.warn(
      "Failed to load Jira panel state:",
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}
