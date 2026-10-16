import { readFile } from "node:fs/promises";

import { isValidGitlabReviewDetails, type GitlabReviewDetails } from "./gitlab-review-details.js";
import { loadGitlabReviewLaunchState, type PersistedLaunchOffer } from "./gitlab-review-launch-state.js";
import { gitlabReviewUrl } from "./gitlab-review-links.js";
import { isValidResult, type GitlabReviewResult } from "./gitlab-review-queue.js";

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 40;
const MAX_DIFF_BYTES = 24 * 1024;
const MAX_TOTAL_DIFF_BYTES = 160 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export type GitlabReviewMiniAppStatus = "offered" | "queued" | "running" | "retrying" | "completed";

export interface ReviewDetailItem {
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly file: string;
  readonly line?: number;
  readonly description: string;
}

export interface GitlabReviewMiniAppChange {
  readonly oldPath: string;
  readonly newPath: string;
  readonly diff: string;
  readonly truncated?: boolean;
}

export interface GitlabReviewMiniAppPayload {
  readonly projectPath: string;
  readonly status: GitlabReviewMiniAppStatus;
  readonly commitTitle?: string;
  readonly baseSha?: string;
  readonly headSha: string;
  readonly gitlabUrl: string;
  readonly reviewOutcome?: "reviewed" | "unchanged";
  readonly findings?: number;
  readonly items: readonly ReviewDetailItem[];
  readonly changes: readonly GitlabReviewMiniAppChange[];
  readonly truncated: boolean;
}

export interface GitlabReviewMiniAppControllerOptions {
  readonly statePath: string;
  readonly gitlabUrl?: string;
  readonly gitlabToken?: string;
  readonly projectIds?: Readonly<Record<string, number>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export class GitlabReviewMiniAppNotFoundError extends Error {}
export class GitlabReviewMiniAppUnavailableError extends Error {}
export class GitlabReviewMiniAppUpstreamError extends Error {}

export class GitlabReviewMiniAppController {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly apiBase: URL | undefined;

  constructor(private readonly options: GitlabReviewMiniAppControllerOptions) {
    if (!options.statePath.startsWith("/")) throw new Error("GitLab review state path must be absolute");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.apiBase = parseGitlabUrl(options.gitlabUrl);
  }

  async getReview(requestId: string): Promise<GitlabReviewMiniAppPayload> {
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new GitlabReviewMiniAppNotFoundError();
    if (!this.apiBase || !this.options.gitlabToken) throw new GitlabReviewMiniAppUnavailableError();
    const launch = await loadGitlabReviewLaunchState(`${this.options.statePath}.launches.json`)
      .catch(() => { throw new GitlabReviewMiniAppUnavailableError(); });
    const offer = launch.offers.find((candidate) => candidate.requestId === requestId);
    if (!offer || !allowlisted(offer, this.options.projectIds)) throw new GitlabReviewMiniAppNotFoundError();
    const queue = await loadQueueState(this.options.statePath)
      .catch(() => { throw new GitlabReviewMiniAppUnavailableError(); });
    const located = findQueueEvent(queue, offer.dedupId);
    const result = located?.result === undefined ? undefined : extractReviewResult(located.result);
    const details = result?.details;
    const baseSha = details?.baseSha ?? eventBefore(offer);
    const headSha = details?.headSha ?? offer.event.after;
    const changes = await this.fetchChanges(offer.event.projectId, baseSha, headSha);
    return {
      projectPath: offer.event.projectPath,
      status: queueStatus(offer, located, queue.retryAttempt),
      ...(offer.summary.commitTitle ? { commitTitle: offer.summary.commitTitle } : {}),
      ...(baseSha && !zeroSha(baseSha) ? { baseSha } : {}),
      headSha,
      gitlabUrl: gitlabReviewUrl(this.options.gitlabUrl!, offer.event, details),
      ...(result ? { reviewOutcome: result.outcome, ...(result.outcome === "reviewed" ? { findings: result.findings } : {}) } : {}),
      items: details?.items ?? [],
      changes: changes.items,
      truncated: changes.truncated,
    };
  }

  private async fetchChanges(projectId: number, baseSha: string | undefined, headSha: string): Promise<{
    items: GitlabReviewMiniAppChange[];
    truncated: boolean;
  }> {
    const endpoint = new URL(`api/v4/projects/${projectId}/repository/${baseSha && !zeroSha(baseSha) ? "compare" : `commits/${headSha}/diff`}`, this.apiBase);
    if (baseSha && !zeroSha(baseSha)) {
      endpoint.searchParams.set("from", baseSha);
      endpoint.searchParams.set("to", headSha);
      endpoint.searchParams.set("straight", "true");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(endpoint, {
        headers: { "private-token": this.options.gitlabToken! },
        signal: controller.signal,
      });
      if (!response.ok) throw new GitlabReviewMiniAppUpstreamError();
      const payload = await readBoundedJson(response);
      const rawChanges = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.diffs) ? payload.diffs : undefined;
      if (!rawChanges) throw new GitlabReviewMiniAppUpstreamError();
      const total = parsePositiveHeader(response.headers.get("x-total"));
      return normalizeChanges(rawChanges, Boolean(response.headers.get("x-next-page"))
        || total !== undefined && total > rawChanges.length);
    } catch (error) {
      if (error instanceof GitlabReviewMiniAppUpstreamError) throw error;
      throw new GitlabReviewMiniAppUpstreamError();
    } finally {
      clearTimeout(timer);
    }
  }
}

type QueueLocation = { phase: "pending" | "inFlight" | "completed"; result?: unknown } | undefined;
type QueueState = { pending: unknown[]; inFlight: unknown[]; completed: unknown[]; retryAttempt: number };

async function loadQueueState(statePath: string): Promise<QueueState> {
  let value: unknown;
  try { value = JSON.parse(await readFile(statePath, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { pending: [], inFlight: [], completed: [], retryAttempt: 0 };
    }
    throw new Error("invalid queue state");
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.pending)
    || !Array.isArray(value.inFlight) || !Array.isArray(value.completed)
    || value.pending.length > 500 || value.inFlight.length > 500 || value.completed.length > 500
    || value.pending.length + value.inFlight.length > 500
    || !value.pending.every(validQueueEvent) || !value.inFlight.every(validQueueEvent)
    || !value.completed.every(validCompletedEvent)
    || !Number.isInteger(value.retryAttempt) || Number(value.retryAttempt) < 0 || Number(value.retryAttempt) > 31) throw new Error("invalid queue state");
  return value as QueueState;
}

function findQueueEvent(state: QueueState, dedupId: string): QueueLocation {
  for (const [phase, events] of [["pending", state.pending], ["inFlight", state.inFlight], ["completed", state.completed]] as const) {
    const event = events.find((candidate) => isRecord(candidate) && candidate.dedupId === dedupId);
    if (event) {
      const record = event as Record<string, unknown>;
      return { phase, ...(phase === "completed" ? { result: record.result } : {}) };
    }
  }
  return undefined;
}

function queueStatus(offer: PersistedLaunchOffer, located: QueueLocation, retryAttempt: number): GitlabReviewMiniAppStatus {
  if (!located) return "offered";
  if (located.phase === "completed") return "completed";
  if (located.phase === "inFlight") return "running";
  return retryAttempt > 0 ? "retrying" : "queued";
}

function allowlisted(offer: PersistedLaunchOffer, projectIds: Readonly<Record<string, number>> | undefined): boolean {
  return projectIds === undefined || projectIds[offer.event.projectPath] === offer.event.projectId;
}

function eventBefore(offer: PersistedLaunchOffer): string | undefined {
  const value = (offer.event as { before?: unknown }).before;
  return typeof value === "string" && SHA_PATTERN.test(value) ? value : undefined;
}

function extractReviewResult(value: unknown): { outcome: "reviewed" | "unchanged"; findings?: number; details?: GitlabReviewDetails } | undefined {
  if (!isValidResult(value)) return undefined;
  const result = value as GitlabReviewResult;
  if (result.outcome === "unchanged") return { outcome: "unchanged" };
  return { outcome: "reviewed", findings: result.findings,
    ...(isValidGitlabReviewDetails(result.details) ? { details: result.details } : {}) };
}

function validQueueEvent(value: unknown): boolean {
  return isRecord(value) && typeof value.dedupId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value.dedupId)
    && Number.isInteger(value.projectId) && Number(value.projectId) > 0
    && typeof value.projectPath === "string" && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value.projectPath)
    && value.ref === "refs/heads/main" && typeof value.after === "string" && SHA_PATTERN.test(value.after)
    && (value.before === undefined || typeof value.before === "string" && SHA_PATTERN.test(value.before))
    && Number.isSafeInteger(value.receivedAt) && Number(value.receivedAt) >= 0;
}

function validCompletedEvent(value: unknown): boolean {
  return isRecord(value) && typeof value.dedupId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value.dedupId)
    && Number.isSafeInteger(value.completedAt) && Number(value.completedAt) >= 0
    && (value.result === undefined || isValidResult(value.result));
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GitlabReviewMiniAppUpstreamError();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new GitlabReviewMiniAppUpstreamError();
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof GitlabReviewMiniAppUpstreamError) throw error;
    throw new GitlabReviewMiniAppUpstreamError();
  } finally {
    reader.releaseLock();
  }
}

function normalizeChanges(raw: unknown[], upstreamTruncated: boolean): { items: GitlabReviewMiniAppChange[]; truncated: boolean } {
  const items: GitlabReviewMiniAppChange[] = [];
  let remaining = MAX_TOTAL_DIFF_BYTES;
  let truncated = upstreamTruncated || raw.length > MAX_FILES;
  for (const rawChange of raw.slice(0, MAX_FILES)) {
    if (!isRecord(rawChange) || !safeText(rawChange.old_path, 500) || !safeText(rawChange.new_path, 500)
      || typeof rawChange.diff !== "string"
      || !optionalBoolean(rawChange.too_large) || !optionalBoolean(rawChange.collapsed)
      || !optionalBoolean(rawChange.compare_timeout)) throw new GitlabReviewMiniAppUpstreamError();
    const source = rawChange.diff;
    const permitted = Math.min(MAX_DIFF_BYTES, remaining);
    const diff = truncateUtf8(source, permitted);
    const wasTruncated = Buffer.byteLength(diff) < Buffer.byteLength(source);
    if (wasTruncated || rawChange.too_large === true || rawChange.collapsed === true || rawChange.compare_timeout === true) truncated = true;
    remaining -= Buffer.byteLength(diff);
    items.push({ oldPath: rawChange.old_path, newPath: rawChange.new_path, diff,
      ...(wasTruncated ? { truncated: true } : {}) });
  }
  return { items, truncated };
}

function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value) <= maximum) return value;
  let end = Math.min(value.length, maximum);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maximum) end -= 1;
  return value.slice(0, end);
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000]/.test(value);
}

function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === "boolean"; }
function parsePositiveHeader(value: string | null): number | undefined {
  return value !== null && /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

function zeroSha(value: string): boolean { return /^0+$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) throw new Error("GitLab review timeout is invalid");
  return value;
}
function parseGitlabUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error();
    parsed.search = "";
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    return parsed;
  } catch { return undefined; }
}
