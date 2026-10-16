import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GitlabReviewQueue,
  type GitlabReviewEvent,
} from "../src/gitlab-review-queue.js";

describe("GitLab review queue", () => {
  let directory: string;
  let statePath: string;
  let now: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-gitlab-review-"));
    statePath = path.join(directory, "queue.json");
    now = 1_000_000;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function event(id: string, after = "a".repeat(40)): GitlabReviewEvent {
    return {
      dedupId: id,
      projectId: 42,
      projectPath: "group/project",
      ref: "refs/heads/main",
      after,
      receivedAt: now,
    };
  }

  async function open(runReview = vi.fn(async () => undefined)) {
    return GitlabReviewQueue.open({
      statePath,
      runReview,
      now: () => now,
      debounceMs: 30_000,
      retryBaseMs: 1_000,
      retryMaxMs: 300_000,
      autoSchedule: false,
    });
  }

  it("durably accepts an event and coalesces rapid pushes from the first arrival", async () => {
    const runReview = vi.fn(async () => undefined);
    const queue = await open(runReview);

    await expect(queue.enqueue(event("one"))).resolves.toBe("accepted");
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(persisted.pending).toHaveLength(1);
    expect((await queue.status()).nextRunAt).toBe(now + 30_000);

    now += 20_000;
    await queue.enqueue(event("two", "b".repeat(40)));
    expect((await queue.status()).nextRunAt).toBe(1_030_000);
    expect(await queue.runDue()).toBe(false);

    now += 10_000;
    expect(await queue.runDue()).toBe(true);
    expect(runReview).toHaveBeenCalledOnce();
    expect(runReview.mock.calls[0]?.[0]).toHaveLength(2);
    expect(await queue.status()).toMatchObject({ pending: 0, inFlight: 0, completed: 2 });
  });

  it("retains reviewed SHAs and AI details after durable completion and restart", async () => {
    const result = { outcome: "reviewed" as const, findings: 1, freshFindings: 1, details: {
      baseSha: "a".repeat(40), headSha: "b".repeat(40), items: [
        { priority: "P1" as const, file: "x.ts", line: 7, description: "Missing validation" },
      ],
    } };
    const queue = await open(vi.fn(async () => ({ one: result })));
    await queue.enqueue({ ...event("one"), before: "c".repeat(40) });
    now += 30_000;
    await queue.runDue();
    await queue.close();
    const restarted = await open();
    expect(restarted.feedback("one")).toEqual({ phase: "completed", result });
    await restarted.close();
  });

  it("exposes durable queued, running, and per-event completion feedback", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runReview = vi.fn(async () => {
      await gate;
      return { one: { outcome: "reviewed" as const, findings: 0, freshFindings: 0 } };
    });
    const queue = await open(runReview);
    await queue.enqueue(event("one"));
    expect(queue.feedback("one")).toEqual({ phase: "queued" });
    now += 30_000;
    const running = queue.runDue();
    await vi.waitFor(() => expect(queue.feedback("one")).toEqual({ phase: "running" }));
    release();
    await running;
    expect(queue.feedback("one")).toEqual({
      phase: "completed",
      result: { outcome: "reviewed", findings: 0, freshFindings: 0 },
    });
    await queue.close();

    const restarted = await open();
    expect(restarted.feedback("one")).toEqual({
      phase: "completed",
      result: { outcome: "reviewed", findings: 0, freshFindings: 0 },
    });
  });

  it("deduplicates accepted events after restart", async () => {
    const first = await open();
    await first.enqueue(event("same"));
    await first.close();

    const second = await open();
    await expect(second.enqueue(event("same"))).resolves.toBe("duplicate");
    expect(await second.status()).toMatchObject({ pending: 1, inFlight: 0 });
  });

  it("allows only one writer for a state file", async () => {
    const first = await open();
    await expect(open()).rejects.toThrow("already has an active writer");
    await first.close();
    await expect(open()).resolves.toBeInstanceOf(GitlabReviewQueue);
  });

  it("retains failed work with bounded exponential retry delay", async () => {
    const runReview = vi.fn(async () => { throw new Error("runner secret"); });
    const queue = await open(runReview);
    await queue.enqueue(event("failed"));
    now += 30_000;

    expect(await queue.runDue()).toBe(true);
    expect(await queue.status()).toMatchObject({ pending: 1, inFlight: 0, retryAttempt: 1 });
    expect(queue.feedback("failed")).toEqual({ phase: "retrying" });
    expect((await queue.status()).nextRunAt).toBe(now + 1_000);
    expect(JSON.parse(readFileSync(statePath, "utf8")).pending).toHaveLength(1);

    expect(await queue.runDue()).toBe(false);
    now += 1_000;
    expect(await queue.runDue()).toBe(true);
    expect((await queue.status()).nextRunAt).toBe(now + 2_000);
  });

  it("backs off after preparation persistence fails instead of scheduling an immediate IO loop", async () => {
    const runReview = vi.fn(async () => undefined);
    const queue = await open(runReview);
    await queue.enqueue(event("io-failure"));
    const savedPath = `${statePath}.saved`;
    renameSync(statePath, savedPath);
    mkdirSync(statePath);
    now += 30_000;

    await expect(queue.runDue()).rejects.toThrow();
    expect(queue.status()).toMatchObject({ pending: 1, inFlight: 0, retryAttempt: 1 });
    expect(queue.status().nextRunAt).toBe(now + 1_000);
    expect(runReview).not.toHaveBeenCalled();

    rmSync(statePath, { recursive: true });
    renameSync(savedPath, statePath);
    now += 1_000;
    await expect(queue.runDue()).resolves.toBe(true);
    expect(runReview).toHaveBeenCalledOnce();
    await queue.close();
  });

  it("retries only completion persistence and retains the original machine result", async () => {
    const savedPath = `${statePath}.saved`;
    const runReview = vi.fn(async () => {
      renameSync(statePath, savedPath);
      mkdirSync(statePath);
      return { completion: { outcome: "reviewed" as const, findings: 2, freshFindings: 1 } };
    });
    const queue = await open(runReview);
    await queue.enqueue(event("completion"));
    now += 30_000;

    await expect(queue.runDue()).rejects.toThrow();
    expect(runReview).toHaveBeenCalledOnce();
    expect(queue.status()).toMatchObject({ pending: 0, inFlight: 1, completed: 0 });
    expect(queue.status().nextRunAt).toBe(now + 1_000);
    expect(queue.feedback("completion")).toEqual({ phase: "running" });

    rmSync(statePath, { recursive: true });
    renameSync(savedPath, statePath);
    now += 1_000;
    await expect(queue.runDue()).resolves.toBe(true);
    expect(runReview).toHaveBeenCalledOnce();
    expect(queue.feedback("completion")).toEqual({
      phase: "completed",
      result: { outcome: "reviewed", findings: 2, freshFindings: 1 },
    });
    expect(JSON.parse(readFileSync(statePath, "utf8")).completed[0].result)
      .toEqual({ outcome: "reviewed", findings: 2, freshFindings: 1 });
    await queue.close();
  });

  it("does not retry a completion write after a concurrent enqueue already made it durable", async () => {
    const savedPath = `${statePath}.saved`;
    const runReview = vi.fn(async () => {
      renameSync(statePath, savedPath);
      mkdirSync(statePath);
      return { completion: { outcome: "unchanged" as const } };
    });
    const queue = await open(runReview);
    await queue.enqueue(event("completion"));
    now += 30_000;
    await expect(queue.runDue()).rejects.toThrow();
    rmSync(statePath, { recursive: true });
    renameSync(savedPath, statePath);
    now += 1_000;

    const enqueued = queue.enqueue(event("later", "b".repeat(40)));
    const redundantRetry = queue.runDue();
    await expect(enqueued).resolves.toBe("accepted");
    await expect(redundantRetry).resolves.toBe(false);
    expect(runReview).toHaveBeenCalledOnce();
    expect(queue.feedback("completion")).toEqual({
      phase: "completed",
      result: { outcome: "unchanged" },
    });
    await queue.close();
  });

  it("keeps an arrival during an active run pending for a subsequent run", async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => { release = resolve; });
    const runReview = vi.fn()
      .mockImplementationOnce(async () => firstRun)
      .mockResolvedValue(undefined);
    const queue = await open(runReview);
    await queue.enqueue(event("first"));
    now += 30_000;

    const running = queue.runDue();
    await vi.waitFor(async () => expect((await queue.status()).inFlight).toBe(1));
    await queue.enqueue(event("second", "b".repeat(40)));
    release();
    await running;

    expect(await queue.status()).toMatchObject({ pending: 1, inFlight: 0, completed: 1 });
    now += 30_000;
    await queue.runDue();
    expect(runReview).toHaveBeenCalledTimes(2);
  });

  it("does not start a prepared batch after close and holds the writer lock through shutdown", async () => {
    let started = false;
    let abortedAtStart = false;
    const queue = await open(vi.fn(async (_events, signal) => {
      started = true;
      abortedAtStart = signal.aborted;
    }));
    await queue.enqueue(event("closing"));
    now += 30_000;

    const running = queue.runDue();
    await Promise.resolve();
    await queue.close();
    await running;

    expect({ started, abortedAtStart }).toEqual({ started: false, abortedAtStart: false });
    expect(queue.status()).toMatchObject({ pending: 1, inFlight: 0, running: false });
    const successor = await open();
    await successor.close();
  });

  it("recovers persisted in-flight events to pending on startup", async () => {
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      pending: [],
      inFlight: [event("recover")],
      completed: [],
      firstPendingAt: null,
      nextRunAt: null,
      retryAttempt: 0,
    }), { mode: 0o600 });

    const queue = await open();
    expect(await queue.status()).toMatchObject({ pending: 1, inFlight: 0 });
    expect((await queue.status()).nextRunAt).toBe(now);
  });

  it("fails closed when persisted state is corrupt or malformed", async () => {
    writeFileSync(statePath, "{", { mode: 0o600 });
    await expect(open()).rejects.toThrow("GitLab review queue state is invalid");

    writeFileSync(statePath, JSON.stringify({ version: 1, pending: new Array(501).fill(event("x")) }), {
      mode: 0o600,
    });
    await expect(open()).rejects.toThrow("GitLab review queue state is invalid");
  });
});
