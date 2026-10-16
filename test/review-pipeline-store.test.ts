import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ReviewPipelineStore, type PipelineDraft, type PipelineReport, type PipelineSource } from "../src/review-pipeline-store.js";

let directory: string;
let databasePath: string;
let stores: ReviewPipelineStore[];

const source = (headSha = "a".repeat(40), description = "recording continues after stale selection"): PipelineSource => ({
  recipe: "review", project: "mir-survey", cwd: "/srv/mir-survey", headSha,
  finding: { severity: "medium", priority: "P2", aspect: "architecture", file: "src/voice.ts", line: 336, category: "recording-after-selection", description },
});
const draft: PipelineDraft = {
  summary: "stop stale recording after selection", priority: "Medium", problem: "stale selection keeps recording", fix: "cancel the recording before replacing choices", benefit: "prevents unintended uploads", acceptance: ["a stale selection stops recording"],
};
const confirmed = (overrides: Partial<PipelineReport> = {}): PipelineReport => ({ verdict: "confirmed", reason: "reproduced", evidence: ["src/voice.ts:336"], draft, ...overrides });
const disproved = (): PipelineReport => ({ verdict: "disproved", reason: "selection cancels recording", evidence: ["src/voice.ts:350"] });
function open(): ReviewPipelineStore { const store = new ReviewPipelineStore(databasePath); stores.push(store); return store; }

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "review-pipeline-")); databasePath = path.join(directory, "pipeline.sqlite"); stores = []; });
afterEach(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });

it("claims a queued job exactly once across connections and reopens working jobs", () => {
  const first = open(); const second = open(); const job = first.enqueue(source());
  expect(first.claim(100)?.id).toBe(job.id);
  expect(second.claim(100)).toBeUndefined();
  first.recover();
  expect(second.claim(100)?.id).toBe(job.id);
  expect(second.get(job.id)).toMatchObject({ status: "working", round: 2 });
});

it("keeps disagreement queued until both validators confirm", () => {
  const store = open(); const job = store.enqueue(source());
  store.claim(10);
  expect(store.finishRound(job.id, confirmed(), { ...disproved(), draft: undefined }, 20)).toMatchObject({ status: "queued", reports: [confirmed(), { ...disproved(), draft: undefined }] });
  expect(store.claim(20 + 120_000)?.round).toBe(2);
  expect(store.finishRound(job.id, confirmed(), confirmed(), 20 + 120_001)).toMatchObject({ status: "awaiting", draft });
});

it("requires a concise valid draft for every confirmed report", () => {
  const store = open(); const job = store.enqueue(source()); store.claim();
  expect(() => store.finishRound(job.id, confirmed(), confirmed({ draft: undefined }))).toThrow("Invalid review pipeline data");
  expect(() => store.finishRound(job.id, confirmed(), confirmed({ draft: { ...draft, summary: "x".repeat(181) } }))).toThrow("Invalid review pipeline data");
});

it("uses the verifier's corrected draft after both agents confirm", () => {
  const store = open(); const job = store.enqueue(source()); store.claim();
  const corrected = { ...draft, fix: "abort the active recording before replacing choices" };
  expect(store.finishRound(job.id, confirmed(), confirmed({ draft: corrected }))).toMatchObject({ status: "awaiting", draft: corrected });
});

it("deduplicates a current delivery globally but lets an older uncreated revision remain intact", () => {
  const store = open(); const earlier = store.enqueue(source("a".repeat(40)));
  const revised = store.enqueue(source("b".repeat(40)));
  expect(revised.id).not.toBe(earlier.id);
  store.claim(); store.finishRound(earlier.id, confirmed(), confirmed());
  expect(store.enqueue(source("c".repeat(40))).id).toBe(earlier.id);
  expect(store.get(revised.id)?.source.headSha).toBe("b".repeat(40));
});

it("preserves a terminal disproval for the same revision", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, disproved(), disproved());
  expect(store.enqueue(source())).toMatchObject({ id: job.id, status: "disproved" });
});

it("keeps creating after a crash and rejects decisions from a stale delivery context", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, confirmed(), confirmed());
  store.markDelivered(job.id, -10012, 31, 41);
  expect(store.claimDecision(job.id, "create", -10012, 31, 42)).toBeUndefined();
  expect(store.claimDecision(job.id, "create", -10012, 31, 41)).toMatchObject({ status: "creating" });
  store.recover();
  expect(store.get(job.id)?.status).toBe("creating");
  expect(store.releaseDecision(job.id)).toMatchObject({ status: "awaiting" });
  expect(store.claimDecision(job.id, "create", -10012, 31, 41)?.status).toBe("creating");
  expect(store.created(job.id, "MIR-1", "https://jira.example/MIR-1")).toMatchObject({ status: "created", issueKey: "MIR-1" });
});

it("opens continuation only from the delivered message and lists undelivered drafts", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, confirmed(), confirmed());
  expect(store.awaitingDelivery().map(item => item.id)).toEqual([job.id]);
  store.markDelivered(job.id, -10012, 31, 41);
  expect(store.awaitingDelivery()).toEqual([]);
  expect(store.claimDecision(job.id, "continue", -10012, 31, 41)?.status).toBe("continuing");
  expect(store.analysisOpened(job.id, 99)).toMatchObject({ status: "continuing", analysisTopicId: 99 });
  expect(store.unfinishedDecisions()).toMatchObject([{ id: job.id, status: "continuing", analysisTopicId: 99 }]);
});

it("rejects empty evidence and verbose acceptance criteria", () => {
  const store = open(); const job = store.enqueue(source()); store.claim();
  expect(() => store.finishRound(job.id, { ...confirmed(), evidence: [] }, confirmed())).toThrow("Invalid review pipeline data");
  expect(() => store.finishRound(job.id, confirmed({ draft: { ...draft, acceptance: ["one", "two", "three", "four"] } }), confirmed())).toThrow("Invalid review pipeline data");
  expect(() => store.finishRound(job.id, confirmed({ evidence: ["not a source reference"] }), confirmed())).toThrow("Invalid review pipeline data");
});

it("keeps a bounded maximum report history readable after repeated disagreement", () => {
  const store = open(); const job = store.enqueue(source());
  const evidence = `${"a".repeat(510)}:1`;
  const longReport = confirmed({ reason: "r".repeat(1000), evidence: [evidence] });
  const uncertain: PipelineReport = { verdict: "uncertain", reason: "u".repeat(1000), evidence: [] };
  for (let round = 0; round < 6; round++) {
    expect(store.claim(10_000_000 + round * 10_000_000)?.id).toBe(job.id);
    expect(store.finishRound(job.id, longReport, uncertain, 10_000_001 + round * 10_000_000).reports).toHaveLength((round + 1) * 2);
  }
  store.close();
  expect(open().get(job.id)?.reports).toHaveLength(12);
  const oversized = `${"a".repeat(511)}:1`;
  const retry = open(); const next = retry.enqueue(source("b".repeat(40), "oversized evidence")); retry.claim(100_000_000);
  expect(() => retry.finishRound(next.id, confirmed({ evidence: [oversized] }), confirmed())).toThrow("Invalid review pipeline data");
});
