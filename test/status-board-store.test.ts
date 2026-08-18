import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createStatusBoardStore } from "../src/status-board-store.js";

describe("createStatusBoardStore", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-dashboard-"));
    filePath = path.join(directory, "status.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists the Dashboard location and pending General cleanup", () => {
    const store = createStatusBoardStore(filePath);
    store.write({ messageThreadId: 42, messageId: 777, legacyMessageId: 555 });

    expect(createStatusBoardStore(filePath).read()).toEqual({
      messageThreadId: 42,
      messageId: 777,
      legacyMessageId: 555,
    });
    expect(readdirSync(directory)).toEqual(["status.json"]);
  });

  it("loads the old General-only state for migration", () => {
    writeFileSync(filePath, JSON.stringify({ messageId: 555 }), "utf8");

    expect(createStatusBoardStore(filePath).read()).toEqual({ messageId: 555 });
  });
});
