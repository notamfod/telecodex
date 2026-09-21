import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadServiceTopicKeys } from "../src/service-topics.js";

it("protects explicitly registered service topics and rejects malformed exclusions", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "service-topics-"));
  try {
    expect(loadServiceTopicKeys(workspace).size).toBe(0);
    mkdirSync(path.join(workspace, ".telecodex"));
    const file = path.join(workspace, ".telecodex", "service-topics.json");
    writeFileSync(file, JSON.stringify(["-1001:3373", "-1001:5414"]));
    expect([...loadServiceTopicKeys(workspace)]).toEqual(["-1001:3373", "-1001:5414"]);
    writeFileSync(file, JSON.stringify(["invalid"]));
    expect(() => loadServiceTopicKeys(workspace)).toThrow();
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
