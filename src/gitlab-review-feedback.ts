import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { acquireRecipeRunLock } from "./recipe-run-lock.js";
import {
  renderGitlabReviewLaunchCard,
  type GitlabReviewFeedbackOffer,
} from "./gitlab-review-launch.js";
import type { GitlabReviewFeedback } from "./gitlab-review-queue.js";
import { escapeHTML } from "./format.js";

const STATE_VERSION = 1;
const MAX_ENTRIES = 500;

interface FeedbackEntry {
  requestId: string;
  desired: string;
  delivered: string | null;
  status: "pending" | "editing" | "idle";
  nextAttemptAt: number | null;
  attempt: number;
  updatedAt: number;
  summary?: string;
}

interface FeedbackState {
  version: 1;
  entries: FeedbackEntry[];
}

export interface GitlabReviewFeedbackStoreOptions {
  readonly statePath: string;
  readonly listOffers: () => readonly GitlabReviewFeedbackOffer[];
  readonly feedbackFor: (dedupId: string) => GitlabReviewFeedback | undefined;
  readonly editCard: (
    offer: GitlabReviewFeedbackOffer,
    html: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly now?: () => number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly pollMs?: number;
  readonly autoSchedule?: boolean;
}

export class GitlabReviewFeedbackStore {
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly pollMs: number;
  private mutation = Promise.resolve();
  private activeRun: Promise<boolean> | undefined;
  private abortController: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    private readonly options: GitlabReviewFeedbackStoreOptions,
    private state: FeedbackState,
    private readonly releaseLock: () => void,
  ) {
    this.now = options.now ?? Date.now;
    this.retryBaseMs = boundedInteger(options.retryBaseMs ?? 5_000, 1, 300_000, "retryBaseMs");
    this.retryMaxMs = boundedInteger(options.retryMaxMs ?? 300_000, this.retryBaseMs, 300_000, "retryMaxMs");
    this.pollMs = boundedInteger(options.pollMs ?? 1_000, 100, 60_000, "pollMs");
  }

  static async open(options: GitlabReviewFeedbackStoreOptions): Promise<GitlabReviewFeedbackStore> {
    if (!path.isAbsolute(options.statePath)) throw new Error("GitLab review feedback state path must be absolute");
    await mkdir(path.dirname(options.statePath), { recursive: true, mode: 0o700 });
    let release: () => void;
    try {
      release = acquireRecipeRunLock(`${options.statePath}.lock`, { nonBlocking: true });
    } catch (error) {
      if (error instanceof Error && error.message === "recipe lock is busy") {
        throw new Error("GitLab review feedback store already has an active writer");
      }
      throw error;
    }
    try {
      const state = await loadState(options.statePath);
      const store = new GitlabReviewFeedbackStore(options, state, release);
      let recovered = false;
      for (const entry of state.entries) {
        if (entry.status === "editing") {
          entry.status = "pending";
          entry.nextAttemptAt = store.now();
          recovered = true;
        }
      }
      if (recovered) await store.persist();
      store.schedule();
      return store;
    } catch (error) {
      release();
      throw error;
    }
  }

  runDue(): Promise<boolean> {
    if (this.closed || this.activeRun) return Promise.resolve(false);
    const controller = new AbortController();
    this.abortController = controller;
    const lifecycle = this.runLifecycle(controller.signal);
    this.activeRun = lifecycle;
    void lifecycle.finally(() => {
      if (this.activeRun === lifecycle) {
        this.activeRun = undefined;
        this.abortController = undefined;
        this.schedule();
      }
    }).catch(() => undefined);
    return lifecycle;
  }

  status(): { pending: number; nextAttemptAt: number | null } {
    const pending = this.state.entries.filter(({ status }) => status !== "idle");
    const next = pending.flatMap(({ nextAttemptAt }) => nextAttemptAt === null ? [] : [nextAttemptAt]);
    return { pending: pending.length, nextAttemptAt: next.length > 0 ? Math.min(...next) : null };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    try {
      await this.activeRun?.catch(() => undefined);
      await this.mutation;
    } finally {
      this.releaseLock();
    }
  }

  private async runLifecycle(signal: AbortSignal): Promise<boolean> {
    const offers = this.options.listOffers();
    await this.reconcile(offers);
    let selected: FeedbackEntry | undefined;
    await this.mutate(async () => {
      selected = this.state.entries
        .filter((entry) => entry.status === "pending"
          && entry.nextAttemptAt !== null && entry.nextAttemptAt <= this.now())
        .sort((left, right) => left.nextAttemptAt! - right.nextAttemptAt!)[0];
      if (!selected) return;
      const previous = structuredClone(this.state);
      selected.status = "editing";
      selected.nextAttemptAt = null;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        const restored = this.state.entries.find(({ requestId }) => requestId === selected!.requestId)!;
        restored.attempt = Math.min(restored.attempt + 1, 31);
        restored.nextAttemptAt = this.now() + this.retryDelay(restored.attempt);
        throw error;
      }
    });
    if (!selected) return false;
    const offer = offers.find(({ requestId }) => requestId === selected!.requestId);
    if (!offer || signal.aborted || this.closed) {
      await this.restore(selected.requestId);
      return false;
    }
    try {
      await this.options.editCard(offer, renderFeedback(offer, selected.desired, selected.summary), signal);
      await this.mutate(async () => {
        const current = this.state.entries.find(({ requestId }) => requestId === selected!.requestId);
        if (!current) return;
        const previous = structuredClone(this.state);
        current.delivered = selected!.desired;
        current.status = current.desired === selected!.desired ? "idle" : "pending";
        current.nextAttemptAt = current.status === "pending" ? this.now() : null;
        current.attempt = 0;
        current.updatedAt = this.now();
        try {
          await this.persist();
        } catch (error) {
          this.state = previous;
          throw error;
        }
      });
    } catch {
      await this.restore(selected.requestId);
    }
    return true;
  }

  private reconcile(offers: readonly GitlabReviewFeedbackOffer[]): Promise<void> {
    return this.mutate(async () => {
      const previous = structuredClone(this.state);
      const live = new Set(offers.map(({ requestId }) => requestId));
      const retained = this.state.entries.filter(({ requestId }) => live.has(requestId));
      let changed = retained.length !== this.state.entries.length;
      this.state.entries = retained;
      for (const offer of offers) {
        const feedback = this.options.feedbackFor(offer.dedupId);
        if (!feedback) continue;
        const desired = feedbackKey(feedback);
        const summary = feedbackSummary(feedback);
        let entry = this.state.entries.find(({ requestId }) => requestId === offer.requestId);
        if (!entry) {
          this.makeRoom();
          entry = {
            requestId: offer.requestId,
            desired,
            delivered: null,
            status: "pending",
            nextAttemptAt: this.now(),
            attempt: 0,
            updatedAt: this.now(),
            ...(summary ? { summary } : {}),
          };
          this.state.entries.push(entry);
          changed = true;
        } else if (entry.desired !== desired) {
          entry.desired = desired;
          entry.summary = summary;
          entry.status = "pending";
          entry.nextAttemptAt = this.now();
          entry.attempt = 0;
          entry.updatedAt = this.now();
          changed = true;
        }
      }
      if (!changed) return;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
  }

  private restore(requestId: string): Promise<void> {
    return this.mutate(async () => {
      const entry = this.state.entries.find((candidate) => candidate.requestId === requestId);
      if (!entry || entry.status !== "editing") return;
      entry.status = "pending";
      entry.attempt = Math.min(entry.attempt + 1, 31);
      entry.nextAttemptAt = this.now() + this.retryDelay(entry.attempt);
      entry.updatedAt = this.now();
      await this.persist();
    });
  }

  private makeRoom(): void {
    if (this.state.entries.length < MAX_ENTRIES) return;
    const oldest = this.state.entries
      .filter(({ status }) => status === "idle")
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    if (!oldest) throw new Error("GitLab review feedback store is full");
    this.state.entries = this.state.entries.filter(({ requestId }) => requestId !== oldest.requestId);
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.max(0, attempt - 1)));
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private schedule(): void {
    if (this.closed || this.options.autoSchedule === false || this.activeRun) return;
    if (this.timer) clearTimeout(this.timer);
    const next = this.status().nextAttemptAt;
    const delay = next === null ? this.pollMs : Math.min(this.pollMs, Math.max(0, next - this.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDue().catch(() => undefined);
    }, delay);
    this.timer.unref();
  }

  private persist(): Promise<void> {
    return persistState(this.options.statePath, this.state);
  }
}

function feedbackKey(feedback: GitlabReviewFeedback): string {
  if (feedback.phase !== "completed") return feedback.phase;
  if (!feedback.result) return "completed";
  if (feedback.result.outcome === "unchanged") return "completed:unchanged";
  const key = `completed:reviewed:${feedback.result.findings}:${feedback.result.freshFindings}`;
  const summary = feedbackSummary(feedback);
  return summary ? `${key}:${createHash("sha256").update(summary).digest("hex")}` : key;
}

function feedbackSummary(feedback: GitlabReviewFeedback): string | undefined {
  if (feedback.phase !== "completed" || feedback.result?.outcome !== "reviewed"
    || !feedback.result.freshFindings) return undefined;
  const lines = feedback.result.details?.items.slice(0, 2).map((item) =>
    `• [${item.priority}] ${[...item.file].slice(0, 65).join("")}${item.line ? `:${item.line}` : ""} — ${[...item.description].slice(0, 150).join("")}`);
  if (!lines?.length) return undefined;
  let summary = "";
  for (const character of lines.join("\n")) {
    if (summary.length + character.length > 649) return `${summary}…`;
    summary += character;
  }
  return summary;
}

function renderFeedback(offer: GitlabReviewFeedbackOffer, key: string, summary?: string): string {
  const status = key === "queued" ? "⏳ Ревью поставлено в очередь."
    : key === "running" ? "🔄 Ревью выполняется."
      : key === "retrying" ? "⚠️ Запуск не завершён, повтор запланирован."
        : key === "completed:unchanged" ? "✅ Уже проверено: новых изменений нет."
          : key === "completed" ? "✅ Ревью завершено."
            : renderReviewed(key);
  return `${renderGitlabReviewLaunchCard(offer.event, offer.summary, offer.requestId).html}\n\n${status}${summary ? `\n${escapeHTML(summary)}` : ""}`;
}

function renderReviewed(key: string): string {
  const match = /^completed:reviewed:(\d+):(\d+)(?::[a-f0-9]{64})?$/.exec(key);
  if (!match) return "✅ Ревью завершено.";
  const findings = Number(match[1]);
  const fresh = Number(match[2]);
  if (findings === 0) return "✅ Ревью завершено: проблем не найдено.";
  if (fresh === 0) return "✅ Ревью завершено: новых замечаний нет.";
  return `✅ Ревью завершено: новых замечаний: ${fresh}.`;
}

async function loadState(statePath: string): Promise<FeedbackState> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isValidState(value)) throw new Error("invalid shape");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: STATE_VERSION, entries: [] };
    throw new Error("GitLab review feedback state is invalid", { cause: error });
  }
}

async function persistState(statePath: string, state: FeedbackState): Promise<void> {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, statePath);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isValidState(value: unknown): value is FeedbackState {
  if (!isRecord(value) || value.version !== STATE_VERSION
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
    || !value.entries.every(isValidEntry)) return false;
  return new Set(value.entries.map((entry) => entry.requestId)).size === value.entries.length;
}

function isValidEntry(value: unknown): value is FeedbackEntry {
  if (!isRecord(value) || !/^[a-f0-9]{32}$/.test(String(value.requestId ?? ""))
    || !isFeedbackKey(value.desired)
    || !(value.delivered === null || isFeedbackKey(value.delivered))
    || !["pending", "editing", "idle"].includes(String(value.status))) return false;
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 0 || (value.attempt as number) > 31
    || !timestamp(value.updatedAt)) return false;
  if (value.summary !== undefined && (typeof value.summary !== "string" || value.summary.length > 700)) return false;
  return value.status === "pending" ? timestamp(value.nextAttemptAt)
    : value.nextAttemptAt === null && (value.status !== "idle" || value.delivered === value.desired);
}

function isFeedbackKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (["queued", "running", "retrying", "completed", "completed:unchanged"].includes(value)) return true;
  const match = /^completed:reviewed:(\d{1,5}):(\d{1,5})(?::[a-f0-9]{64})?$/.exec(value);
  if (!match) return false;
  const findings = Number(match[1]);
  const fresh = Number(match[2]);
  return findings <= 10_000 && fresh <= findings;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
