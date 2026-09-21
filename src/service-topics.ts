import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Extra service destinations, including recipes running from other worktrees. */
export function loadServiceTopicKeys(workspace: string): Set<string> {
  const file = path.join(workspace, ".telecodex", "service-topics.json");
  if (!existsSync(file)) return new Set();
  const keys: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || !/^-?[1-9]\d*:[1-9]\d*$/u.test(key))) {
    throw new Error("Invalid service topic exclusions");
  }
  return new Set(keys);
}
