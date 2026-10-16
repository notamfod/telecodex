import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ReviewPipelineJournalStore } from "../src/review-pipeline-journal-store.js";

let directory: string;
let file: string;
let stores: ReviewPipelineJournalStore[];
const batchId = "a".repeat(24);
const uuid = "01a144a8-f9be-7962-ae96-5e6af46f906a";
function open(): ReviewPipelineJournalStore { const store = new ReviewPipelineJournalStore(file); stores.push(store); return store; }

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "pipeline-journal-")); file = path.join(directory, "journal.sqlite"); stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });

it("keeps one durable session per batch across restart", () => {
  const store = open(); const first = store.ensureSession(batchId, "Review", "/repo");
  expect(store.ensureSession(batchId, "Changed", "/other")).toEqual(first);
  expect(store.claimSession(batchId)).toBe(true);
  store.attachSession(batchId, uuid); store.close();
  expect(open().sessions()).toEqual([expect.objectContaining({ batchId, threadId: uuid, title: "Review", cwd: "/repo" })]);
});

it("guards unknown session creation after restart but permits a definitive failure", () => {
  const store = open(); store.ensureSession(batchId, "Review", "/repo");
  expect(store.claimSession(batchId)).toBe(true);
  store.close(); const restored = open(); restored.recoverCreations();
  expect(restored.claimSession(batchId)).toBe(false);
  restored.failSession(batchId, true);
  expect(restored.claimSession(batchId)).toBe(true);
});

it("deduplicates journal events per batch and persists an atomic pending append", () => {
  const store = open(); store.ensureSession(batchId, "Review", "/repo");
  store.appendEvent(batchId, "review:one", "one"); store.appendEvent(batchId, "review:one", "duplicate");
  store.appendEvent(batchId, "review:two", "two");
  expect(store.hasEvent(batchId, "review:one")).toBe(true);
  expect(store.hasEvent(batchId, "missing")).toBe(false);
  expect(store.pendingEvents(batchId)).toEqual([
    { id: 1, key: "review:one", text: "one" }, { id: 2, key: "review:two", text: "two" },
  ]);
  store.prepareAppend(batchId, "append:1", [1, 2], "journal text"); store.markWritten(batchId); store.acknowledgeAppend(batchId);
  expect(store.pendingEvents(batchId)).toEqual([]);
  expect(store.sessions()).toEqual([expect.not.objectContaining({ pending: expect.anything() })]);
});

it("does not expose a pending append as delivered before acknowledgement", () => {
  const store = open(); store.ensureSession(batchId, "Review", "/repo"); store.appendEvent(batchId, "review:one", "one");
  store.prepareAppend(batchId, "append:1", [1], "journal text"); store.markWritten(batchId);
  expect(store.pendingEvents(batchId)).toEqual([{ id: 1, key: "review:one", text: "one" }]);
  expect(store.sessions()[0]).toEqual(expect.objectContaining({ pending: { key: "append:1", eventIds: [1], text: "journal text", state: "written" } }));
});

it("resets a definitively unsent append without deleting its queued events", () => {
  const store = open(); store.ensureSession(batchId, "Review", "/repo"); store.appendEvent(batchId, "review:one", "one");
  store.prepareAppend(batchId, "append:1", [1], "journal text"); store.markWritten(batchId); store.resetAppend(batchId);
  expect(store.sessions()[0]).toEqual(expect.objectContaining({ pending: { key: "append:1", eventIds: [1], text: "journal text", state: "prepared" } }));
  expect(store.pendingEvents(batchId)).toEqual([{ id: 1, key: "review:one", text: "one" }]);
});
