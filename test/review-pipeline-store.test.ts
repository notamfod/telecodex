import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getConfirmedAssessment, ReviewPipelineStore, type PipelineAssessment, type PipelineDraft, type PipelineReport, type PipelineSource } from "../src/review-pipeline-store.js";

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
const assessment: PipelineAssessment = { component: "Frontend", kind: "bug", basis: "The stale callback remains reachable.", labels: ["поиск"], trigger: "Choose an item while recording.", expected: "Selection stops recording.", actual: "Recording continues after selection." };
const confirmed = (overrides: Partial<PipelineReport> = {}): PipelineReport => ({ verdict: "confirmed", reason: "reproduced", evidence: ["src/voice.ts:336"], draft, assessment, ...overrides });
const disproved = (): PipelineReport => ({ verdict: "disproved", reason: "selection cancels recording", evidence: ["src/voice.ts:350"] });
const uncertain = (evidence: string[] = []): PipelineReport => ({ verdict: "uncertain", reason: "needs more context", evidence });
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

it("finds progress jobs at the exact revision and reuses approved findings from older revisions", () => {
  const store = open(); const first = source(); const job = store.enqueue(first);
  store.claim(); store.finishRound(job.id, confirmed(), confirmed());
  const newer = source("b".repeat(40));
  expect(store.listForSource(first.project, first.headSha).map(item => item.id)).toEqual([job.id]);
  expect(store.listForSource(newer.project, newer.headSha)).toEqual([]);
  expect(store.listForSource(newer.project, newer.headSha, [newer.finding]).map(item => item.id)).toEqual([job.id]);
});

it("resumes affected analysis after a prompt fix without reopening approved drafts", () => {
  const store = open(); const current = source(); const job = store.enqueue(current);
  store.claim(); store.finishRound(job.id, disproved(), disproved());
  expect(store.resumeSource(current.project, current.headSha)).toBe(1);
  expect(store.get(job.id)).toMatchObject({ status: "queued", nextAttemptAt: 0, round: 1 });
  expect(store.get(job.id)?.reports).toHaveLength(2);
  store.claim(); store.finishRound(job.id, confirmed(), confirmed());
  expect(store.resumeSource(current.project, current.headSha)).toBe(0);
  expect(store.get(job.id)?.status).toBe("awaiting");
});

it("keeps disagreement queued until both validators confirm", () => {
  const store = open(); const job = store.enqueue(source());
  store.claim(10);
  expect(store.finishRound(job.id, confirmed(), { ...disproved(), draft: undefined }, 20)).toMatchObject({ status: "queued", reports: [confirmed(), { ...disproved(), draft: undefined }] });
  expect(store.claim(20 + 120_000)?.round).toBe(2);
  expect(store.finishRound(job.id, confirmed(), confirmed(), 20 + 120_001)).toMatchObject({ status: "awaiting", draft });
});

it("parks mutually uncertain reports instead of claiming them again after restart", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(10);
  expect(store.finishRound(job.id, uncertain(), uncertain(), 20)).toMatchObject({ status: "needs_context" });
  expect(store.claim(1_000_000)).toBeUndefined();
  store.close();
  const restarted = open(); restarted.recover();
  expect(restarted.get(job.id)).toMatchObject({ status: "needs_context" });
  expect(restarted.claim(1_000_000)).toBeUndefined();
});

it("parks repeated disagreement without evidence that was not already reviewed", () => {
  const store = open(); const job = store.enqueue(source());
  store.claim(10); expect(store.finishRound(job.id, confirmed(), disproved(), 20)).toMatchObject({ status: "queued" });
  store.claim(20 + 120_000); expect(store.finishRound(job.id, confirmed(), disproved(), 20 + 120_001)).toMatchObject({ status: "needs_context" });
});

it("continues disagreement when the completed pair contributes new evidence", () => {
  const store = open(); const job = store.enqueue(source());
  store.claim(10); store.finishRound(job.id, confirmed(), disproved(), 20);
  store.claim(20 + 120_000);
  expect(store.finishRound(job.id, confirmed({ evidence: ["src/voice.ts:360"] }), disproved(), 20 + 120_001)).toMatchObject({ status: "queued" });
});

it("keeps a parked revision deduplicated but opens a fresh job for a new SHA", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, uncertain(), uncertain());
  expect(store.enqueue(source())).toMatchObject({ id: job.id, status: "needs_context" });
  expect(store.enqueue(source("b".repeat(40))).id).not.toBe(job.id);
});

it("explicitly resumes delivered needs-context jobs for a fresh result card", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, uncertain(), uncertain());
  store.markDelivered(job.id, -10012, 31, 41);
  store.claimDecision(job.id, "continue", -10012, 31, 41);
  store.analysisOpened(job.id, 99);
  store.releaseDecision(job.id);
  expect(store.resumeSource(job.source.project, job.source.headSha)).toBe(1);
  expect(store.get(job.id)).toMatchObject({ status: "queued", nextAttemptAt: 0, reports: [] });
  expect(store.get(job.id)).not.toHaveProperty("chatId");
  expect(store.get(job.id)).not.toHaveProperty("topicId");
  expect(store.get(job.id)).not.toHaveProperty("messageId");
  expect(store.get(job.id)).not.toHaveProperty("analysisTopicId");
  store.recover();
  expect(store.claim()).toMatchObject({ id: job.id, round: 2 });
  expect(store.finishRound(job.id, confirmed(), confirmed())).toMatchObject({ status: "awaiting" });
  expect(store.awaitingDelivery().map(item => item.id)).toEqual([job.id]);
});

it("migrates v1 jobs and parks legacy queued inconclusive reports while rejecting future schemas", () => {
  const legacy = new Database(databasePath);
  legacy.exec("CREATE TABLE review_pipeline_jobs (id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, fingerprint TEXT NOT NULL, head_sha TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX review_pipeline_jobs_claim ON review_pipeline_jobs(status, next_attempt_at); CREATE INDEX review_pipeline_jobs_dedup ON review_pipeline_jobs(project, fingerprint, status); PRAGMA user_version = 1");
  const legacyJob = { id: "f".repeat(24), source: source(), status: "queued", round: 71, reports: [uncertain(), uncertain()], nextAttemptAt: 0 };
  legacy.prepare("INSERT INTO review_pipeline_jobs VALUES (?, ?, ?, ?, ?, ?, ?)").run(legacyJob.id, legacyJob.source.project, "legacy", legacyJob.source.headSha, legacyJob.status, legacyJob.nextAttemptAt, JSON.stringify(legacyJob));
  legacy.close();
  const store = open(); store.recover();
  expect(store.get(legacyJob.id)).toMatchObject({ status: "needs_context", round: 71 });
  store.close();
  const migrated = new Database(databasePath); expect(migrated.pragma("user_version", { simple: true })).toBe(2); migrated.pragma("user_version = 3"); migrated.close();
  expect(() => open()).toThrow("Invalid review pipeline data");
});

it("requires a concise valid draft for every confirmed report", () => {
  const store = open(); const job = store.enqueue(source()); store.claim();
  expect(() => store.finishRound(job.id, confirmed(), confirmed({ draft: undefined }))).toThrow("Invalid review pipeline data");
  expect(() => store.finishRound(job.id, confirmed(), confirmed({ draft: { ...draft, summary: "x".repeat(181) } }))).toThrow("Invalid review pipeline data");
});

it("keeps legacy confirmed reports readable but never approves them without assessments", () => {
  const store = open(); const job = store.enqueue(source()); store.claim();
  const legacy = confirmed({ assessment: undefined });
  expect(store.finishRound(job.id, legacy, legacy)).toMatchObject({ status: "needs_context", draft: undefined });
  expect(getConfirmedAssessment({ reports: [legacy, legacy] })).toBeUndefined();
});

it("requires two matching independent classifications before awaiting delivery", () => {
  const store = open(); const job = store.enqueue(source()); store.claim();
  const verifier = confirmed({ assessment: { ...assessment, component: "Backend" } });
  expect(store.finishRound(job.id, confirmed(), verifier)).toMatchObject({ status: "needs_context", draft: undefined });
  expect(getConfirmedAssessment({ reports: [confirmed(), verifier] })).toBeUndefined();
  expect(getConfirmedAssessment({ reports: [confirmed(), { ...confirmed(), assessment: { component: "?", kind: "bug", basis: "x", trigger: "t", expected: "e", actual: "a" } }] } as unknown as { reports: PipelineReport[] })).toBeUndefined();
});

it("agrees labels as an unordered set and rejects legacy or mismatched sets", () => {
  const a = confirmed({ assessment: { ...assessment, labels: ["поиск", "Фасеты"] } });
  const b = confirmed({ assessment: { ...assessment, labels: ["Фасеты", "поиск"] } });
  expect(getConfirmedAssessment({ reports: [a, b] })).toMatchObject({ labels: ["Фасеты", "поиск"] });
  expect(getConfirmedAssessment({ reports: [a, confirmed({ assessment: { ...assessment, labels: ["поиск"] } })] })).toBeUndefined();
  expect(getConfirmedAssessment({ reports: [a, confirmed({ assessment: { ...assessment, labels: undefined } })] })).toBeUndefined();
});

it("reassesses only the current delivered awaiting draft and retains its message identity", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, confirmed(), confirmed());
  store.markDelivered(job.id, -10012, 31, 41);
  expect(store.reassessAwaiting(job.id, confirmed(), confirmed(), 42)).toBeUndefined();
  const refreshed = store.reassessAwaiting(job.id, confirmed(), confirmed({ draft: { ...draft, fix: "cancel it before selection" } }), 41, 99);
  expect(refreshed).toMatchObject({ status: "awaiting", chatId: -10012, topicId: 31, messageId: 41, nextAttemptAt: 99 });
  expect(store.claimDecision(job.id, "create", -10012, 31, 41)?.status).toBe("creating");
  expect(store.reassessAwaiting(job.id, confirmed(), confirmed(), 41)).toBeUndefined();
});

it("clears a delivered stale draft when re-review disproves or cannot classify it", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, confirmed(), confirmed());
  store.markDelivered(job.id, -10012, 31, 41);
  expect(store.reassessAwaiting(job.id, disproved(), disproved(), 41)).toMatchObject({ status: "disproved", draft: undefined, messageId: 41 });
});

it("allows only continuation from a delivered needs-context re-review", () => {
  const store = open(); const job = store.enqueue(source()); store.claim(); store.finishRound(job.id, confirmed(), confirmed());
  store.markDelivered(job.id, -10012, 31, 41);
  expect(store.reassessAwaiting(job.id, uncertain(), uncertain(), 41)).toMatchObject({ status: "needs_context", draft: undefined, messageId: 41 });
  expect(store.claimDecision(job.id, "create", -10012, 31, 41)).toBeUndefined();
  expect(store.claimDecision(job.id, "continue", -10012, 31, 42)).toBeUndefined();
  expect(store.claimDecision(job.id, "continue", -10012, 31, 41)).toMatchObject({ status: "continuing" });
  expect(store.analysisOpened(job.id, 99)).toMatchObject({ status: "continuing", analysisTopicId: 99 });
  expect(store.releaseDecision(job.id)).toMatchObject({ status: "needs_context", messageId: 41 });
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
  const uncertain: PipelineReport = { verdict: "uncertain", reason: "u".repeat(1000), evidence: [] };
  for (let round = 0; round < 6; round++) {
    const longReport = confirmed({ reason: "r".repeat(1000), evidence: [`src/${"a".repeat(500)}${round}.ts:1`] });
    expect(store.claim(10_000_000 + round * 10_000_000)?.id).toBe(job.id);
    expect(store.finishRound(job.id, longReport, uncertain, 10_000_001 + round * 10_000_000).reports).toHaveLength((round + 1) * 2);
  }
  store.close();
  expect(open().get(job.id)?.reports).toHaveLength(12);
  const oversized = `${"a".repeat(511)}:1`;
  const retry = open(); const next = retry.enqueue(source("b".repeat(40), "oversized evidence")); retry.claim(100_000_000);
  expect(() => retry.finishRound(next.id, confirmed({ evidence: [oversized] }), confirmed())).toThrow("Invalid review pipeline data");
});
