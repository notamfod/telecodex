import { randomBytes } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { fingerprintFinding, type Finding } from "./recipes.js";
import { prepareReviewPipelineSqliteFile } from "./review-pipeline-sqlite-file.js";

export interface PipelineSource { recipe: string; project: string; cwd: string; headSha: string; finding: Finding; }
export interface PipelineDraft { summary: string; priority: "Highest" | "High" | "Medium" | "Low"; problem: string; fix: string; benefit: string; acceptance: string[]; }
export interface PipelineReport { verdict: "confirmed" | "disproved" | "uncertain"; reason: string; evidence: string[]; draft?: PipelineDraft; }
export interface PipelineJob {
  id: string; source: PipelineSource; status: "queued" | "working" | "awaiting" | "disproved" | "needs_context" | "creating" | "created" | "continuing";
  round: number; reports: PipelineReport[]; draft?: PipelineDraft; messageId?: number; chatId?: number; topicId?: number;
  issueKey?: string; issueUrl?: string; analysisTopicId?: number; nextAttemptAt: number;
}

type Row = { id: string; payload: string };
const statuses = new Set<PipelineJob["status"]>(["queued", "working", "awaiting", "disproved", "needs_context", "creating", "created", "continuing"]);
const verdicts = new Set<PipelineReport["verdict"]>(["confirmed", "disproved", "uncertain"]);
const priorities = new Set<PipelineDraft["priority"]>(["Highest", "High", "Medium", "Low"]);
const maxText = 1024;
const sourceRef = /^(?!\/|.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./@:+-]+:\d+$/;

function valid(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid review pipeline data"); }
function text(value: unknown, limit = maxText): asserts value is string { valid(typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)); }
function positive(value: unknown): asserts value is number { valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0); }
function timestamp(value: unknown): asserts value is number { valid(typeof value === "number" && Number.isSafeInteger(value) && value >= 0); }
function optionalPositive(value: unknown): void { valid(value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)); }
function keys(value: object, allowed: readonly string[], required: readonly string[]): void {
  const actual = Object.keys(value); valid(actual.every(key => allowed.includes(key)) && required.every(key => actual.includes(key)));
}
function validateFinding(finding: unknown): asserts finding is Finding {
  valid(finding !== null && typeof finding === "object" && !Array.isArray(finding));
  const item = finding as Record<string, unknown>;
  keys(item, ["severity", "priority", "aspect", "file", "line", "category", "description", "author", "commitSha", "commitUrl"], ["severity", "file", "category", "description"]);
  valid(["critical", "high", "medium", "low"].includes(item.severity as string));
  if (item.priority !== undefined) valid(["P0", "P1", "P2", "P3"].includes(item.priority as string));
  if (item.aspect !== undefined) valid(["performance", "cleanliness", "security", "architecture"].includes(item.aspect as string));
  text(item.file, 512); valid(!path.posix.isAbsolute(item.file) && !item.file.split("/").includes(".."));
  if (item.line !== undefined) positive(item.line);
  for (const field of ["category", "description", "author", "commitSha", "commitUrl"]) if (item[field] !== undefined) text(item[field], field === "description" ? 1024 : 512);
  if (item.commitSha !== undefined) valid(typeof item.commitSha === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(item.commitSha));
  if (item.commitUrl !== undefined) valid(typeof item.commitUrl === "string" && /^https:\/\//.test(item.commitUrl));
}
function validateSource(source: unknown): asserts source is PipelineSource {
  valid(source !== null && typeof source === "object" && !Array.isArray(source)); const item = source as Record<string, unknown>;
  keys(item, ["recipe", "project", "cwd", "headSha", "finding"], ["recipe", "project", "cwd", "headSha", "finding"]);
  text(item.recipe, 128); text(item.project, 256); text(item.cwd, 4096); valid(path.isAbsolute(item.cwd));
  valid(typeof item.headSha === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(item.headSha)); validateFinding(item.finding);
}
function validateDraft(draft: unknown): asserts draft is PipelineDraft {
  valid(draft !== null && typeof draft === "object" && !Array.isArray(draft)); const item = draft as Record<string, unknown>;
  keys(item, ["summary", "priority", "problem", "fix", "benefit", "acceptance"], ["summary", "priority", "problem", "fix", "benefit", "acceptance"]);
  text(item.summary, 180); for (const field of ["problem", "fix", "benefit"]) text(item[field], 512);
  valid(priorities.has(item.priority as PipelineDraft["priority"])); valid(Array.isArray(item.acceptance) && item.acceptance.length > 0 && item.acceptance.length <= 3);
  for (const criterion of item.acceptance) text(criterion, 512);
  const draftText = [item.summary, item.problem, item.fix, item.benefit, ...item.acceptance] as unknown as string[];
  valid(draftText.reduce((size, value) => size + value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").length, 0) <= 2600);
}
function validateReport(report: unknown): asserts report is PipelineReport {
  valid(report !== null && typeof report === "object" && !Array.isArray(report)); const item = report as Record<string, unknown>;
  keys(item, ["verdict", "reason", "evidence", "draft"], ["verdict", "reason", "evidence"]);
  valid(verdicts.has(item.verdict as PipelineReport["verdict"])); text(item.reason, 1000); valid(Array.isArray(item.evidence) && item.evidence.length <= 8 && (item.verdict === "uncertain" || item.evidence.length > 0));
  for (const evidence of item.evidence) valid(typeof evidence === "string" && evidence.length <= 512 && sourceRef.test(evidence)); if (item.draft !== undefined) validateDraft(item.draft);
  valid(item.verdict === "confirmed" ? item.draft !== undefined : item.draft === undefined);
}
function validateJob(job: unknown): asserts job is PipelineJob {
  valid(job !== null && typeof job === "object" && !Array.isArray(job)); const item = job as Record<string, unknown>;
  keys(item, ["id", "source", "status", "round", "reports", "draft", "messageId", "chatId", "topicId", "issueKey", "issueUrl", "analysisTopicId", "nextAttemptAt"], ["id", "source", "status", "round", "reports", "nextAttemptAt"]);
  valid(typeof item.id === "string" && /^[0-9a-f]{24}$/i.test(item.id)); validateSource(item.source); valid(statuses.has(item.status as PipelineJob["status"])); timestamp(item.round); timestamp(item.nextAttemptAt);
  valid(Array.isArray(item.reports) && item.reports.length <= 12); for (const report of item.reports) validateReport(report);
  if (item.draft !== undefined) validateDraft(item.draft); for (const field of ["messageId", "topicId", "analysisTopicId"]) optionalPositive(item[field]);
  if (item.chatId !== undefined) valid(typeof item.chatId === "number" && Number.isSafeInteger(item.chatId) && item.chatId !== 0); if (item.issueKey !== undefined) text(item.issueKey, 128); if (item.issueUrl !== undefined) { text(item.issueUrl, 2048); valid(/^https:\/\//.test(item.issueUrl)); }
  if (["awaiting", "creating", "continuing", "created"].includes(item.status as string)) validateDraft(item.draft);
  if (["creating", "continuing", "created"].includes(item.status as string)) { positive(item.messageId); positive(item.topicId); valid(typeof item.chatId === "number" && Number.isSafeInteger(item.chatId) && item.chatId !== 0); }
}
function decode(row: Row): PipelineJob { valid(typeof row.payload === "string" && row.payload.length <= 256 * 1024); const job: PipelineJob = JSON.parse(row.payload); validateJob(job); valid(job.id === row.id); return job; }
function fingerprint(source: PipelineSource): string { return fingerprintFinding(source.finding); }
function backoff(round: number): number { return Math.min(60_000 * 2 ** Math.min(round, 10), 3_600_000); }
function hasNewEvidence(prior: readonly PipelineReport[], current: readonly PipelineReport[]): boolean {
  const seen = new Set(prior.flatMap((report) => report.evidence));
  return current.some((report) => report.evidence.some((reference) => !seen.has(reference)));
}
function needsContext(reports: readonly PipelineReport[]): boolean {
  if (reports.length < 2) return false;
  const pair = reports.slice(-2); const [analyst, verifier] = pair;
  if (!analyst || !verifier || analyst.verdict === verifier.verdict && analyst.verdict !== "uncertain") return false;
  return analyst.verdict === "uncertain" && verifier.verdict === "uncertain" || !hasNewEvidence(reports.slice(0, -2), pair);
}

export class ReviewPipelineStore {
  private readonly database: Database.Database;
  constructor(databasePath: string) {
    valid(typeof databasePath === "string" && databasePath.length > 0 && databasePath !== ":memory:");
    prepareReviewPipelineSqliteFile(databasePath);
    this.database = new Database(databasePath);
    try { this.database.pragma("journal_mode = WAL"); this.database.pragma("busy_timeout = 1000"); this.database.transaction(() => {
      const version = this.database.pragma("user_version", { simple: true }); valid(version === 0 || version === 1 || version === 2);
      if (version === 0) { const tables = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(); valid(tables.length === 0); this.database.exec("CREATE TABLE review_pipeline_jobs (id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, fingerprint TEXT NOT NULL, head_sha TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at INTEGER NOT NULL, payload TEXT NOT NULL)"); this.database.exec("CREATE INDEX review_pipeline_jobs_claim ON review_pipeline_jobs(status, next_attempt_at)"); this.database.exec("CREATE INDEX review_pipeline_jobs_dedup ON review_pipeline_jobs(project, fingerprint, status)"); }
      const columns = this.database.pragma("table_info(review_pipeline_jobs)") as { name: string; type: string; notnull: number; pk: number }[];
      valid(columns.length === 7 && columns.every((column, index) => column.name === ["id", "project", "fingerprint", "head_sha", "status", "next_attempt_at", "payload"][index] && column.type === ["TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "INTEGER", "TEXT"][index] && column.notnull === 1 && column.pk === (index === 0 ? 1 : 0)));
      for (const row of this.database.prepare("SELECT id, payload FROM review_pipeline_jobs").all() as Row[]) decode(row);
      if (version !== 2) this.database.pragma("user_version = 2");
    }).immediate(); } catch (error) { this.database.close(); throw error; }
  }
  close(): void { if (this.database.open) this.database.close(); }
  get(id: string): PipelineJob | undefined { valid(typeof id === "string" && /^[0-9a-f]{24}$/i.test(id)); const row = this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE id = ?").get(id) as Row | undefined; return row && decode(row); }
  listForSource(project: string, headSha: string, findings?: readonly Finding[]): PipelineJob[] {
    text(project, 256); valid(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(headSha));
    if (!findings) return (this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE project = ? AND head_sha = ? ORDER BY rowid").all(project, headSha) as Row[]).map(decode);
    const jobs = new Map<string, PipelineJob>();
    for (const finding of findings) {
      validateFinding(finding);
      const key = fingerprintFinding(finding);
      const row = this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE project = ? AND fingerprint = ? AND status IN ('awaiting', 'creating', 'created', 'continuing') ORDER BY rowid DESC LIMIT 1").get(project, key) as Row | undefined
        ?? this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE project = ? AND fingerprint = ? AND head_sha = ? ORDER BY rowid DESC LIMIT 1").get(project, key, headSha) as Row | undefined;
      if (row) { const job = decode(row); jobs.set(job.id, job); }
    }
    return [...jobs.values()];
  }
  /** Explicit recovery after fixing an analyzer. Approved or externally acted-on drafts stay protected. */
  resumeSource(project: string, headSha: string): number {
    return this.database.transaction(() => {
      let resumed = 0;
      for (const job of this.listForSource(project, headSha)) {
        if (job.status !== "queued" && job.status !== "disproved" && job.status !== "needs_context") continue;
        const next = job.status === "needs_context" ? { ...job, status: "queued" as const, reports: [], nextAttemptAt: 0 } : { ...job, status: "queued" as const, nextAttemptAt: 0 };
        validateJob(next); if (this.update(job, next)) resumed++;
      }
      return resumed;
    }).immediate();
  }
  enqueue(source: PipelineSource): PipelineJob {
    validateSource(source); return this.database.transaction(() => {
      const same = this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE project = ? AND fingerprint = ? AND status IN ('awaiting', 'creating', 'created', 'continuing') ORDER BY rowid DESC LIMIT 1").get(source.project, fingerprint(source)) as Row | undefined;
      if (same) return decode(same);
      const existing = this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE project = ? AND fingerprint = ? AND head_sha = ? ORDER BY rowid DESC LIMIT 1").get(source.project, fingerprint(source), source.headSha) as Row | undefined;
      if (existing) return decode(existing);
      const job: PipelineJob = { id: randomBytes(12).toString("hex"), source, status: "queued", round: 0, reports: [], nextAttemptAt: 0 }; validateJob(job); this.insert(job); return job;
    }).immediate();
  }
  claim(now = Date.now()): PipelineJob | undefined { timestamp(now); return this.database.transaction(() => {
    const row = this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, rowid LIMIT 1").get(now) as Row | undefined; if (!row) return undefined;
    const job = decode(row); const next = { ...job, status: "working" as const, round: job.round + 1 }; validateJob(next);
    return this.update(job, next) ? next : undefined;
  }).immediate(); }
  finishRound(id: string, analyst: PipelineReport, verifier: PipelineReport, now = Date.now()): PipelineJob {
    validateReport(analyst); validateReport(verifier); timestamp(now); return this.database.transaction(() => {
      const job = this.requireWorking(id); const allReports = [...job.reports, analyst, verifier]; const reports = allReports.slice(-12); const park = needsContext(allReports); let next: PipelineJob;
      const selectedDraft = verifier.draft ?? analyst.draft;
      if (analyst.verdict === "confirmed" && verifier.verdict === "confirmed" && selectedDraft) next = { ...job, reports, draft: selectedDraft, status: "awaiting", nextAttemptAt: now };
      else if (analyst.verdict === "disproved" && verifier.verdict === "disproved") next = { ...job, reports, status: "disproved", nextAttemptAt: now };
      else next = { ...job, reports, status: park ? "needs_context" : "queued", nextAttemptAt: park ? now : now + backoff(job.round) };
      validateJob(next); valid(this.update(job, next)); return next;
    }).immediate();
  }
  failure(id: string, now = Date.now()): PipelineJob { timestamp(now); return this.database.transaction(() => { const job = this.requireWorking(id); const next = { ...job, status: "queued" as const, nextAttemptAt: now + backoff(job.round) }; validateJob(next); valid(this.update(job, next)); return next; }).immediate(); }
  awaitingDelivery(): PipelineJob[] { return (this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE status = 'awaiting' AND json_extract(payload, '$.messageId') IS NULL ORDER BY rowid").all() as Row[]).map(decode); }
  unfinishedDecisions(): PipelineJob[] { return (this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE status IN ('creating', 'continuing') ORDER BY rowid").all() as Row[]).map(decode); }
  markDelivered(id: string, chatId: number, topicId: number, messageId: number): PipelineJob { positive(topicId); positive(messageId); valid(Number.isSafeInteger(chatId) && chatId !== 0); return this.database.transaction(() => { const job = this.get(id); valid(job?.status === "awaiting" && job.messageId === undefined); const next = { ...job, chatId, topicId, messageId }; validateJob(next); valid(this.update(job, next)); return next; }).immediate(); }
  claimDecision(id: string, decision: "create" | "continue", chatId: number, topicId: number, messageId: number): PipelineJob | undefined { valid(decision === "create" || decision === "continue"); return this.database.transaction(() => { const job = this.get(id); if (!job || job.status !== "awaiting" || job.chatId !== chatId || job.topicId !== topicId || job.messageId !== messageId) return undefined; const next = { ...job, status: decision === "create" ? "creating" as const : "continuing" as const }; validateJob(next); return this.update(job, next) ? next : undefined; }).immediate(); }
  created(id: string, issueKey: string, issueUrl: string): PipelineJob { text(issueKey, 128); text(issueUrl, 2048); valid(/^https:\/\//.test(issueUrl)); return this.database.transaction(() => { const job = this.get(id); valid(job?.status === "creating"); const next = { ...job, status: "created" as const, issueKey, issueUrl }; validateJob(next); valid(this.update(job, next)); return next; }).immediate(); }
  analysisOpened(id: string, topicId: number): PipelineJob { positive(topicId); return this.database.transaction(() => { const job = this.get(id); valid(job?.status === "continuing"); const next = { ...job, analysisTopicId: topicId }; validateJob(next); valid(this.update(job, next)); return next; }).immediate(); }
  /** Call only after the caller has established that no external action was accepted. */
  releaseDecision(id: string): PipelineJob | undefined { return this.database.transaction(() => { const job = this.get(id); if (!job || job.status !== "creating" && job.status !== "continuing") return undefined; const next = { ...job, status: "awaiting" as const }; validateJob(next); return this.update(job, next) ? next : undefined; }).immediate(); }
  recover(): void { this.database.transaction(() => {
    const interrupted = this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE status = 'working'").all() as Row[];
    for (const row of interrupted) { const job = decode(row); const next = { ...job, status: "queued" as const, nextAttemptAt: 0 }; validateJob(next); valid(this.update(job, next)); }
    const legacy = this.database.prepare("SELECT id, payload FROM review_pipeline_jobs WHERE status = 'queued'").all() as Row[];
    for (const row of legacy) { const job = decode(row); if (!needsContext(job.reports)) continue; const next = { ...job, status: "needs_context" as const }; validateJob(next); valid(this.update(job, next)); }
  }).immediate(); }
  private requireWorking(id: string): PipelineJob { const job = this.get(id); valid(job?.status === "working"); return job; }
  private insert(job: PipelineJob): void { this.database.prepare("INSERT INTO review_pipeline_jobs(id, project, fingerprint, head_sha, status, next_attempt_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(job.id, job.source.project, fingerprint(job.source), job.source.headSha, job.status, job.nextAttemptAt, JSON.stringify(job)); }
  private update(previous: PipelineJob, next: PipelineJob): boolean { const result = this.database.prepare("UPDATE review_pipeline_jobs SET status = ?, next_attempt_at = ?, payload = ? WHERE id = ? AND status = ? AND payload = ?").run(next.status, next.nextAttemptAt, JSON.stringify(next), previous.id, previous.status, JSON.stringify(previous)); return result.changes === 1; }
}
