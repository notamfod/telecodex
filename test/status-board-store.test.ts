import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createStatusBoardStore } from "../src/status-board-store.js";

const SYNTHETIC_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
const PRIVATE_MARKERS = /123456789:|private\/telecodex|message=77|PRIVATE/;

describe("createStatusBoardStore", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-dashboard-"));
    filePath = path.join(directory, "status.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("sanitizes Dashboard load failures as one console argument", () => {
    writeFileSync(
      filePath,
      `https://api.telegram.org/bot${SYNTHETIC_TOKEN}/getUpdates /private/telecodex/status.json message=77 payload=PRIVATE`,
      "utf8",
    );
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(createStatusBoardStore(filePath).read()).toEqual({});

    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]).toHaveLength(1);
    expect(logged.mock.calls[0]![0]).toMatch(/^telegram event=dashboard_store category=/);
    expect(String(logged.mock.calls[0]![0])).not.toMatch(PRIVATE_MARKERS);
    expect(String(logged.mock.calls[0]![0])).not.toContain(directory);
  });

  it("sanitizes Dashboard persist failures as one console argument", () => {
    const blocker = path.join(
      directory,
      SYNTHETIC_TOKEN,
    );
    writeFileSync(blocker, "not a directory", "utf8");
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const privatePath = path.join(blocker, "private", "telecodex", "message=77", "payload=PRIVATE", "status.json");
    const store = createStatusBoardStore(privatePath);

    store.write({ messageThreadId: 42, messageId: 777 });

    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]).toHaveLength(1);
    expect(logged.mock.calls[0]![0]).toMatch(/^telegram event=dashboard_store category=/);
    expect(String(logged.mock.calls[0]![0])).not.toMatch(PRIVATE_MARKERS);
    expect(String(logged.mock.calls[0]![0])).not.toContain(directory);
  });
});
