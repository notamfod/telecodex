import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { GitlabReviewEvent } from "./gitlab-review-queue.js";

const STATE_VERSION = 1;
export const MAX_LAUNCH_OFFERS = 500;
const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface PersistedLaunchOffer {
  requestId: string;
  dedupId: string;
  event: GitlabReviewEvent;
  summary: { commitTitle?: string; commitCount?: number; author?: string };
  target: { chatId: number; messageThreadId: number };
  status: "offered" | "notifying" | "notified" | "activating" | "activated";
  createdAt: number;
  nextNotifyAt: number | null;
  notifyAttempt: number;
  messageId: number | null;
  activationAt: number | null;
  pipelineStatus?: "activating" | "activated";
  pipelineAt?: number;
}

export interface PersistedLaunchState {
  version: 1;
  offers: PersistedLaunchOffer[];
}

export async function loadGitlabReviewLaunchState(statePath: string): Promise<PersistedLaunchState> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isValidState(value)) throw new Error("invalid shape");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: STATE_VERSION, offers: [] };
    throw new Error("GitLab review launch state is invalid", { cause: error });
  }
}

export async function persistGitlabReviewLaunchState(
  statePath: string,
  state: PersistedLaunchState,
): Promise<void> {
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
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function isValidGitlabReviewEvent(value: unknown): value is GitlabReviewEvent {
  if (!isRecord(value)) return false;
  return (value.pipeline === undefined || value.pipeline === true)
    && typeof value.dedupId === "string" && value.dedupId.length > 0 && value.dedupId.length <= 200
    && positiveInteger(value.projectId)
    && typeof value.projectPath === "string" && value.projectPath.length > 2 && value.projectPath.length <= 300
    && value.ref === "refs/heads/main"
    && typeof value.after === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.after)
    && (value.before === undefined || typeof value.before === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.before))
    && timestamp(value.receivedAt);
}

export function isValidGitlabReviewTarget(
  value: unknown,
): value is { chatId: number; messageThreadId: number } {
  return isRecord(value) && Object.keys(value).length === 2
    && Number.isSafeInteger(value.chatId) && value.chatId !== 0
    && positiveInteger(value.messageThreadId);
}

function isValidState(value: unknown): value is PersistedLaunchState {
  if (!isRecord(value) || value.version !== STATE_VERSION
    || !Array.isArray(value.offers) || value.offers.length > MAX_LAUNCH_OFFERS) return false;
  if (!value.offers.every(isValidOffer)) return false;
  const requestIds = value.offers.map((offer) => offer.requestId);
  const dedupIds = value.offers.map((offer) => offer.dedupId);
  return new Set(requestIds).size === requestIds.length && new Set(dedupIds).size === dedupIds.length;
}

function isValidOffer(value: unknown): value is PersistedLaunchOffer {
  if (!isRecord(value) || !REQUEST_ID_PATTERN.test(String(value.requestId ?? ""))
    || typeof value.dedupId !== "string" || value.dedupId.length < 1 || value.dedupId.length > 200
    || !isValidGitlabReviewEvent(value.event) || !isValidSummary(value.summary)
    || !isValidGitlabReviewTarget(value.target)
    || !["offered", "notifying", "notified", "activating", "activated"].includes(String(value.status))) return false;
  if (!timestamp(value.createdAt) || !nullableTimestamp(value.nextNotifyAt)
    || !Number.isInteger(value.notifyAttempt) || (value.notifyAttempt as number) < 0 || (value.notifyAttempt as number) > 31
    || !(value.messageId === null || positiveInteger(value.messageId))
    || !nullableTimestamp(value.activationAt)) return false;
  const status = value.status as PersistedLaunchOffer["status"];
  if ((status === "notified" || status === "activating" || status === "activated")
    && !positiveInteger(value.messageId)) return false;
  if ((status === "activating" || status === "activated") && !timestamp(value.activationAt)) return false;
  if (value.pipelineStatus !== undefined
    && (!["activating", "activated"].includes(String(value.pipelineStatus)) || !timestamp(value.pipelineAt)
      || !positiveInteger(value.messageId))) return false;
  return status === "offered" ? timestamp(value.nextNotifyAt) : value.nextNotifyAt === null;
}

function isValidSummary(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !["commitTitle", "commitCount", "author"].includes(key))) {
    return false;
  }
  return (value.commitTitle === undefined || boundedLine(value.commitTitle, 100) === value.commitTitle)
    && (value.author === undefined || boundedLine(value.author, 50) === value.author)
    && (value.commitCount === undefined || (Number.isSafeInteger(value.commitCount)
      && (value.commitCount as number) >= 0 && (value.commitCount as number) <= 100_000));
}

function boundedLine(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? [...line].slice(0, maximum).join("") : undefined;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableTimestamp(value: unknown): value is number | null {
  return value === null || timestamp(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
