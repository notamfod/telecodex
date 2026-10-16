import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ReviewPipelineProgressStore, type ProgressEvent } from "../src/review-pipeline-progress-store.js";

let directory: string;
let file: string;
let stores: ReviewPipelineProgressStore[];
const first: ProgressEvent = { projectPath: "group/mir-back", before: "a".repeat(40), after: "b".repeat(40) };
const second: ProgressEvent = { projectPath: "group/mir-survey", after: "c".repeat(40) };
const target = { chatId: -100123, messageThreadId: 77 };
function open(): ReviewPipelineProgressStore { const store = new ReviewPipelineProgressStore(file); stores.push(store); return store; }

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "pipeline-progress-")); file = path.join(directory, "progress.sqlite"); stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });

it("uses a stable batch id for sorted event identities but preserves delivery order", () => {
  const store = open(); const initial = store.trackBatch([second, first], target);
  const resumed = store.trackBatch([first, second], target);
  expect(resumed.id).toBe(initial.id);
  expect(resumed.events).toEqual([second, first]);
  expect(store.trackBatch([first, second], { ...target, messageThreadId: 78 }).id).not.toBe(initial.id);
});

it("persists message delivery and agents across restart", () => {
  const store = open(); const batch = store.trackBatch([first], target);
  store.markMessage(batch.id, 91, "<b>Reviewing</b>", false);
  store.markAgent("a".repeat(24), "analyst"); store.markAgent("a".repeat(24), "verifier");
  store.close(); const restored = open();
  expect(restored.listBatches()).toEqual([expect.objectContaining({ id: batch.id, messageId: 91, deliveredText: "<b>Reviewing</b>", finished: false })]);
  expect(restored.agent("a".repeat(24))).toBe("verifier");
});

it("does not reclaim a message whose send outcome became unknown after restart", () => {
  const store = open(); const batch = store.trackBatch([first], target);
  expect(store.claimMessage(batch.id)).toBe(true);
  store.close(); const restored = open();
  restored.recoverMessages();
  expect(restored.listBatches()).toEqual([expect.objectContaining({ id: batch.id, sendState: "unknown" })]);
  expect(restored.claimMessage(batch.id)).toBe(false);
});

it("releases a definitively failed send and clears state after a known acknowledgement", () => {
  const store = open(); const batch = store.trackBatch([first], target);
  expect(store.claimMessage(batch.id)).toBe(true);
  store.failMessage(batch.id, true);
  expect(store.claimMessage(batch.id)).toBe(true);
  store.markMessage(batch.id, 91, "<b>Reviewing</b>", false);
  expect(store.listBatches()[0]).toMatchObject({ id: batch.id, messageId: 91 });
  expect(store.listBatches()[0]).not.toHaveProperty("sendState");
  expect(store.claimMessage(batch.id)).toBe(false);
});

it("keeps checkpoints distinct for the same head with different bases and caches reviewed results", () => {
  const store = open(); const alternate = { ...first, before: "d".repeat(40) };
  const result = { name: "mir-back", sourcePath: "/repos/mir-back", worktreePath: "/cache/mir-back", status: "reviewed" as const,
    baseSha: first.before, headSha: first.after, changedFiles: ["src/a.ts"], findings: [{ severity: "high" as const, file: "src/a.ts", line: 3, category: "state", description: "lost" }] };
  store.markRange(first, { phase: "reviewing", chunk: 1, totalChunks: 3 });
  expect(store.range(first)).toMatchObject({ phase: "reviewing", chunk: 1, totalChunks: 3 });
  store.markRange(first, { phase: "reviewed", result });
  store.markRange(alternate, { phase: "failed" });
  expect(store.range(first)).toEqual({ phase: "reviewed", result });
  expect(store.range(alternate)).toEqual({ phase: "failed" });
});

it("retains the original event range when review falls back to a different valid base", () => {
  const store = open(); const forced = { ...first, before: "0".repeat(40) };
  const result = { name: "mir-back", sourcePath: "/repos/mir-back", status: "reviewed" as const,
    baseSha: "d".repeat(40), headSha: first.after, findings: [] };
  store.markRange(forced, { phase: "reviewed", result });
  expect(store.range(forced)).toEqual({ phase: "reviewed", result });
});

it("rejects unreviewed cache results and unsafe identifiers", () => {
  const store = open();
  expect(() => store.trackBatch([{ ...first, projectPath: "../mir-back" }], target)).toThrow();
  expect(() => store.markRange(first, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repos/mir-back", status: "failed", headSha: first.after, findings: [] } })).toThrow();
  expect(() => store.markAgent("bad", "analyst")).toThrow();
});
