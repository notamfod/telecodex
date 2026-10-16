import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { escapeHTML } from "./format.js";
import { gitlabReviewKeyboard, type GitlabReviewKeyboard, type GitlabReviewLinks } from "./gitlab-review-links.js";
import { acquireRecipeRunLock } from "./recipe-run-lock.js";
import {
  isValidGitlabReviewEvent,
  isValidGitlabReviewTarget,
  loadGitlabReviewLaunchState,
  MAX_LAUNCH_OFFERS,
  persistGitlabReviewLaunchState,
  type PersistedLaunchOffer,
  type PersistedLaunchState,
} from "./gitlab-review-launch-state.js";
import type {
  GitlabReviewEnqueueResult,
  GitlabReviewEvent,
} from "./gitlab-review-queue.js";

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface GitlabReviewSummary {
  readonly commitTitle?: string;
  readonly commitCount?: number;
  readonly author?: string;
}

export interface GitlabReviewLaunchCard {
  readonly html: string;
  readonly fallbackText: string;
  readonly buttonText: "▶ Запустить ревью";
  readonly callbackData: string;
  readonly replyMarkup: GitlabReviewKeyboard;
}

export interface GitlabReviewLaunchTarget {
  readonly chatId: number;
  readonly messageThreadId: number;
}

export interface GitlabReviewLaunchActivation extends GitlabReviewLaunchTarget {
  readonly requestId: string;
  readonly messageId: number;
}

export interface GitlabReviewFeedbackOffer {
  readonly requestId: string;
  readonly dedupId: string;
  readonly event: GitlabReviewEvent;
  readonly summary: GitlabReviewSummary;
  readonly target: GitlabReviewLaunchTarget;
  readonly messageId: number;
}

export interface GitlabReviewLaunchStoreOptions {
  readonly statePath: string;
  readonly target: GitlabReviewLaunchTarget;
  readonly sendCard: (
    card: GitlabReviewLaunchCard,
    target: GitlabReviewLaunchTarget,
    signal: AbortSignal,
  ) => Promise<number>;
  readonly enqueue: (event: GitlabReviewEvent) => Promise<GitlabReviewEnqueueResult>;
  readonly now?: () => number;
  readonly createRequestId?: () => string;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly autoSchedule?: boolean;
  readonly links?: GitlabReviewLinks;
}

export class GitlabReviewLaunchNotFoundError extends Error {}
export class GitlabReviewLaunchContextError extends Error {}
export class GitlabReviewLaunchNotReadyError extends Error {}

export class GitlabReviewLaunchStore {
  private readonly now: () => number;
  private readonly createRequestId: () => string;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private state: PersistedLaunchState;
  private mutation = Promise.resolve();
  private notificationRun: Promise<boolean> | undefined;
  private notificationAbort: AbortController | undefined;
  private readonly activationRequests = new Set<Promise<GitlabReviewEnqueueResult>>();
  private readonly activationRuns = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    private readonly options: GitlabReviewLaunchStoreOptions,
    state: PersistedLaunchState,
    private readonly releaseLock: () => void,
  ) {
    this.state = state;
    this.now = options.now ?? Date.now;
    this.createRequestId = options.createRequestId ?? (() => randomBytes(16).toString("hex"));
    this.retryBaseMs = boundedInteger(options.retryBaseMs ?? 30_000, 1, 300_000, "retryBaseMs");
    this.retryMaxMs = boundedInteger(options.retryMaxMs ?? 300_000, this.retryBaseMs, 300_000, "retryMaxMs");
  }

  static async open(options: GitlabReviewLaunchStoreOptions): Promise<GitlabReviewLaunchStore> {
    validateOptions(options);
    await mkdir(path.dirname(options.statePath), { recursive: true, mode: 0o700 });
    let release: () => void;
    try {
      release = acquireRecipeRunLock(`${options.statePath}.lock`, { nonBlocking: true });
    } catch (error) {
      if (error instanceof Error && error.message === "recipe lock is busy") {
        throw new Error("GitLab review launch store already has an active writer");
      }
      throw error;
    }
    try {
      const state = await loadGitlabReviewLaunchState(options.statePath);
      const store = new GitlabReviewLaunchStore(options, state, release);
      let recoveredNotification = false;
      for (const offer of state.offers) {
        if (offer.status === "notifying") {
          offer.status = "offered";
          offer.nextNotifyAt = store.now();
          recoveredNotification = true;
        }
      }
      if (recoveredNotification) await store.persist();
      for (const offer of state.offers.filter(({ status }) => status === "activating")) {
        await store.completeActivation(offer.requestId);
      }
      store.schedule();
      return store;
    } catch (error) {
      release();
      throw error;
    }
  }

  offer(
    event: GitlabReviewEvent,
    summary: GitlabReviewSummary = {},
  ): Promise<{ outcome: "accepted" | "duplicate"; requestId: string }> {
    if (!isValidGitlabReviewEvent(event)) return Promise.reject(new Error("GitLab review event is invalid"));
    const normalizedSummary = normalizeGitlabReviewSummary(summary);
    return this.mutate(async () => {
      this.assertOpen();
      const duplicate = this.state.offers.find((offer) => offer.dedupId === event.dedupId);
      if (duplicate) return { outcome: "duplicate", requestId: duplicate.requestId };
      const requestId = this.createRequestId();
      if (!REQUEST_ID_PATTERN.test(requestId)
        || this.state.offers.some((offer) => offer.requestId === requestId)) {
        throw new Error("GitLab review launch request id is invalid or duplicated");
      }
      const previous = structuredClone(this.state);
      this.makeRoom();
      this.state.offers.push({
        requestId,
        dedupId: event.dedupId,
        event: { ...event },
        summary: normalizedSummary,
        target: { ...this.options.target },
        status: "offered",
        createdAt: this.now(),
        nextNotifyAt: this.now(),
        notifyAttempt: 0,
        messageId: null,
        activationAt: null,
      });
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      this.schedule();
      return { outcome: "accepted", requestId };
    });
  }

  activate(input: GitlabReviewLaunchActivation): Promise<GitlabReviewEnqueueResult> {
    if (this.closed) return Promise.reject(new Error("GitLab review launch store is closed"));
    const operation = this.activateInternal(input);
    this.activationRequests.add(operation);
    void operation.finally(() => this.activationRequests.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async activateInternal(input: GitlabReviewLaunchActivation): Promise<GitlabReviewEnqueueResult> {
    validateActivation(input);
    const phase = await this.mutate(async () => {
      this.assertOpen();
      const offer = this.state.offers.find(({ requestId }) => requestId === input.requestId);
      if (!offer) throw new GitlabReviewLaunchNotFoundError("GitLab review launch was not found");
      if (offer.status === "offered" || offer.status === "notifying" || offer.messageId === null) {
        throw new GitlabReviewLaunchNotReadyError("GitLab review launch notification is not ready");
      }
      if (input.chatId !== offer.target.chatId
        || input.messageThreadId !== offer.target.messageThreadId
        || offer.messageId !== input.messageId) {
        throw new GitlabReviewLaunchContextError("GitLab review launch context does not match");
      }
      if (offer.status === "activated") return "duplicate" as const;
      if (offer.status === "activating") return "resume" as const;
      const previous = structuredClone(this.state);
      offer.status = "activating";
      offer.activationAt = this.now();
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return "accepted" as const;
    });
    if (phase === "duplicate") return "duplicate";
    await this.completeActivation(input.requestId);
    return phase === "accepted" ? "accepted" : "duplicate";
  }

  runDueNotifications(): Promise<boolean> {
    if (this.closed || this.notificationRun) return Promise.resolve(false);
    const controller = new AbortController();
    this.notificationAbort = controller;
    const lifecycle = this.runNotificationLifecycle(controller.signal);
    this.notificationRun = lifecycle;
    void lifecycle.finally(() => {
      if (this.notificationRun === lifecycle) {
        this.notificationRun = undefined;
        this.notificationAbort = undefined;
        this.schedule();
      }
    }).catch(() => undefined);
    return lifecycle;
  }

  status(): {
    total: number; offered: number; notified: number; activating: number;
    activated: number; nextNotifyAt: number | null;
  } {
    const count = (status: PersistedLaunchOffer["status"]) =>
      this.state.offers.filter((offer) => offer.status === status).length;
    const next = this.state.offers
      .flatMap((offer) => offer.status === "offered" && offer.nextNotifyAt !== null ? [offer.nextNotifyAt] : []);
    return {
      total: this.state.offers.length,
      offered: count("offered") + count("notifying"),
      notified: count("notified"),
      activating: count("activating"),
      activated: count("activated"),
      nextNotifyAt: next.length > 0 ? Math.min(...next) : null,
    };
  }

  feedbackOffers(): GitlabReviewFeedbackOffer[] {
    return this.state.offers.flatMap((offer) => offer.status === "activated" && offer.messageId !== null
      ? [{
        requestId: offer.requestId,
        dedupId: offer.dedupId,
        event: { ...offer.event },
        summary: { ...offer.summary },
        target: { ...offer.target },
        messageId: offer.messageId,
      }] : []);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.notificationAbort?.abort();
    try {
      await this.notificationRun?.catch(() => undefined);
      await Promise.allSettled(this.activationRequests);
      await Promise.allSettled(this.activationRuns.values());
      await this.mutation;
    } finally {
      this.releaseLock();
    }
  }

  private async runNotificationLifecycle(signal: AbortSignal): Promise<boolean> {
    let requestId: string | undefined;
    await this.mutate(async () => {
      if (this.closed) return;
      const due = this.state.offers
        .filter((offer) => offer.status === "offered"
          && offer.nextNotifyAt !== null && offer.nextNotifyAt <= this.now())
        .sort((left, right) => left.nextNotifyAt! - right.nextNotifyAt!)[0];
      if (!due) return;
      const previous = structuredClone(this.state);
      due.status = "notifying";
      due.nextNotifyAt = null;
      requestId = due.requestId;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        const restored = this.state.offers.find((offer) => offer.requestId === due.requestId)!;
        restored.notifyAttempt = Math.min(restored.notifyAttempt + 1, 31);
        restored.nextNotifyAt = this.now() + this.retryDelay(restored.notifyAttempt);
        requestId = undefined;
        throw error;
      }
    });
    if (!requestId) return false;
    const offer = this.state.offers.find((candidate) => candidate.requestId === requestId)!;
    if (this.closed || signal.aborted) {
      await this.restoreNotification(offer.requestId);
      return false;
    }
    try {
      const messageId = await this.options.sendCard(
        renderGitlabReviewLaunchCard(offer.event, offer.summary, offer.requestId, this.options.links),
        offer.target,
        signal,
      );
      if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error("Invalid Telegram message id");
      await this.mutate(async () => {
        const current = this.state.offers.find(({ requestId: id }) => id === offer.requestId)!;
        const previous = structuredClone(this.state);
        current.status = "notified";
        current.messageId = messageId;
        current.nextNotifyAt = null;
        try {
          await this.persist();
        } catch (error) {
          this.state = previous;
          throw error;
        }
      });
    } catch {
      await this.restoreNotification(offer.requestId);
    }
    return true;
  }

  private restoreNotification(requestId: string): Promise<void> {
    return this.mutate(async () => {
      const offer = this.state.offers.find((candidate) => candidate.requestId === requestId);
      if (!offer || offer.status !== "notifying") return;
      offer.status = "offered";
      offer.notifyAttempt = Math.min(offer.notifyAttempt + 1, 31);
      offer.nextNotifyAt = this.now() + this.retryDelay(offer.notifyAttempt);
      await this.persist();
    });
  }

  private completeActivation(requestId: string): Promise<void> {
    const existing = this.activationRuns.get(requestId);
    if (existing) return existing;
    const operation = this.completeActivationInternal(requestId);
    this.activationRuns.set(requestId, operation);
    void operation.finally(() => this.activationRuns.delete(requestId)).catch(() => undefined);
    return operation;
  }

  private async completeActivationInternal(requestId: string): Promise<void> {
    const offer = this.state.offers.find((candidate) => candidate.requestId === requestId);
    if (!offer || offer.status !== "activating" || offer.activationAt === null) return;
    await this.options.enqueue({ ...offer.event, receivedAt: offer.activationAt });
    await this.mutate(async () => {
      const current = this.state.offers.find((candidate) => candidate.requestId === requestId);
      if (!current || current.status !== "activating") return;
      const previous = structuredClone(this.state);
      current.status = "activated";
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
  }

  private makeRoom(): void {
    if (this.state.offers.length < MAX_LAUNCH_OFFERS) return;
    const oldest = this.state.offers
      .filter(({ status }) => status === "activated")
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldest) throw new Error("GitLab review launch store is full");
    this.state.offers = this.state.offers.filter(({ requestId }) => requestId !== oldest.requestId);
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
    if (this.closed || this.options.autoSchedule === false || this.notificationRun) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.status().nextNotifyAt;
    if (next === null) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDueNotifications().catch(() => undefined);
    }, Math.max(0, Math.min(2_147_483_647, next - this.now())));
    this.timer.unref();
  }

  private persist(): Promise<void> {
    return persistGitlabReviewLaunchState(this.options.statePath, this.state);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("GitLab review launch store is closed");
  }
}

export function normalizeGitlabReviewSummary(value: unknown): GitlabReviewSummary {
  if (!isRecord(value)) return {};
  const commitTitle = boundedLine(value.commitTitle, 100);
  const author = boundedLine(value.author, 50);
  const commitCount = Number.isSafeInteger(value.commitCount)
    && (value.commitCount as number) >= 0 && (value.commitCount as number) <= 100_000
    ? value.commitCount as number : undefined;
  return {
    ...(commitTitle ? { commitTitle } : {}),
    ...(author ? { author } : {}),
    ...(commitCount === undefined ? {} : { commitCount }),
  };
}

export function renderGitlabReviewLaunchCard(
  event: GitlabReviewEvent,
  summary: GitlabReviewSummary,
  requestId: string,
  links: GitlabReviewLinks = {},
): GitlabReviewLaunchCard {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Invalid GitLab review request id");
  const safe = normalizeGitlabReviewSummary(summary);
  const project = [...event.projectPath].slice(0, 100).join("");
  const lines = [
    `🔎 <b>Ревью</b> · <code>${escapeHTML(project)}</code>`,
    `Обновлён main · <code>${escapeHTML(event.after.slice(0, 8))}</code>`,
    safe.commitTitle ? escapeHTML(safe.commitTitle) : "",
    [safe.author ? `Автор: ${escapeHTML(safe.author)}` : "", safe.commitCount === undefined
      ? "" : `Коммитов: ${safe.commitCount}`].filter(Boolean).join(" · "),
  ].filter(Boolean);
  return {
    html: lines.join("\n"),
    fallbackText: `Ревью ${project} · main · ${event.after.slice(0, 8)}`,
    buttonText: "▶ Запустить ревью",
    callbackData: `greview:${requestId}`,
    replyMarkup: gitlabReviewKeyboard(event, requestId, links, true),
  };
}

function validateOptions(options: GitlabReviewLaunchStoreOptions): void {
  if (!path.isAbsolute(options.statePath)) throw new Error("GitLab review launch state path must be absolute");
  if (!isValidGitlabReviewTarget(options.target)) throw new Error("GitLab review launch target is invalid");
}

function validateActivation(input: GitlabReviewLaunchActivation): void {
  if (!REQUEST_ID_PATTERN.test(input.requestId) || !Number.isSafeInteger(input.chatId) || input.chatId === 0
    || !positiveInteger(input.messageThreadId) || !positiveInteger(input.messageId)) {
    throw new Error("GitLab review launch activation is invalid");
  }
}

function boundedLine(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? [...line].slice(0, maximum).join("") : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
