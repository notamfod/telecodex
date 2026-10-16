import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GitlabReviewMiniAppController,
  GitlabReviewMiniAppNotFoundError,
  GitlabReviewMiniAppUpstreamError,
  GitlabReviewMiniAppUnavailableError,
} from "../src/gitlab-review-mini-app.js";

const REQUEST_ID = "a".repeat(32);
const BEFORE = "b".repeat(40);
const AFTER = "c".repeat(40);

describe("GitLab review Mini App controller", () => {
  let directory: string;
  let statePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-gitlab-review-mini-"));
    statePath = path.join(directory, "queue.json");
    writeState();
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("reads the authenticated offer's queue result and fetches the pinned comparison", async () => {
    writeState({ result: { outcome: "reviewed", findings: 1, freshFindings: 1, details: {
      baseSha: "d".repeat(40), headSha: AFTER, items: [{ priority: "P1", file: "src/a.ts", line: 4, description: "missing check" }],
    } } });
    const fetch = vi.fn(async (url: URL) => new Response(JSON.stringify({ diffs: [{
      old_path: "src/a.ts", new_path: "src/a.ts", diff: "+safe",
    }] }), { status: 200 }));
    const controller = configured(fetch);

    await expect(controller.getReview(REQUEST_ID)).resolves.toEqual({
      projectPath: "mircli/mir-frontend", status: "completed", commitTitle: "feat: add safety",
      baseSha: "d".repeat(40), headSha: AFTER,
      gitlabUrl: `https://gitlab.example.test/group/mircli/mir-frontend/-/compare/${"d".repeat(40)}...${AFTER}?straight=true`,
      reviewOutcome: "reviewed", findings: 1,
      items: [{ priority: "P1", file: "src/a.ts", line: 4, description: "missing check" }],
      changes: [{ oldPath: "src/a.ts", newPath: "src/a.ts", diff: "+safe" }], truncated: false,
    });
    expect(fetch.mock.calls[0]![0].toString()).toContain(`/compare?from=${"d".repeat(40)}&to=${AFTER}&straight=true`);
  });

  it("uses the push range and reports queued or retrying state before completion", async () => {
    writeState({ phase: "pending", retryAttempt: 1 });
    const controller = configured(async () => new Response(JSON.stringify([]), { status: 200 }));
    const result = await controller.getReview(REQUEST_ID);
    expect(result).toMatchObject({ status: "retrying", baseSha: BEFORE, headSha: AFTER, items: [] });
  });

  it("falls back to the commit diff when the push has no usable base SHA", async () => {
    writeState({ before: "0".repeat(40) });
    const fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const result = await configured(fetch).getReview(REQUEST_ID);
    expect(result).toMatchObject({ headSha: AFTER });
    expect(result).not.toHaveProperty("baseSha");
    expect(fetch.mock.calls[0]![0].toString()).toContain(`/commits/${AFTER}/diff`);
  });

  it("does not disclose offers outside the configured project map or malformed request IDs", async () => {
    await expect(configured(async () => new Response("[]"), { "other/project": 1 }).getReview(REQUEST_ID))
      .rejects.toBeInstanceOf(GitlabReviewMiniAppNotFoundError);
    await expect(configured(async () => new Response("[]")).getReview("not-an-id"))
      .rejects.toBeInstanceOf(GitlabReviewMiniAppNotFoundError);
    await expect(configured(async () => new Response("[]"), {}).getReview(REQUEST_ID))
      .rejects.toBeInstanceOf(GitlabReviewMiniAppNotFoundError);
  });

  it("returns not found for an unknown request before requiring a queue snapshot", async () => {
    rmSync(statePath);
    await expect(configured(async () => new Response("[]")).getReview("d".repeat(32)))
      .rejects.toBeInstanceOf(GitlabReviewMiniAppNotFoundError);
  });

  it("returns unavailable without server-only GitLab configuration", async () => {
    const controller = new GitlabReviewMiniAppController({ statePath });
    await expect(controller.getReview(REQUEST_ID)).rejects.toBeInstanceOf(GitlabReviewMiniAppUnavailableError);
  });

  it("rejects malformed GitLab payloads and bounds diff text", async () => {
    await expect(configured(async () => new Response(JSON.stringify([{ old_path: "a", new_path: "b", diff: 3 }]))).getReview(REQUEST_ID))
      .rejects.toBeInstanceOf(GitlabReviewMiniAppUpstreamError);
    const long = await configured(async () => new Response(JSON.stringify([
      { old_path: "old", new_path: "new", diff: "x".repeat(30_000) },
    ]))).getReview(REQUEST_ID);
    expect(long.changes[0]).toMatchObject({ truncated: true });
    const result = await configured(async () => new Response(JSON.stringify(Array.from({ length: 41 }, (_, index) => ({
      old_path: `old-${index}`, new_path: `new-${index}`, diff: "x".repeat(15_000),
    }))))).getReview(REQUEST_ID);
    expect(result.changes).toHaveLength(40);
    expect(result.truncated).toBe(true);
    await expect(configured(async () => new Response(JSON.stringify([
      { old_path: "old", new_path: "new", diff: "x".repeat(4 * 1024 * 1024) },
    ]))).getReview(REQUEST_ID)).rejects.toBeInstanceOf(GitlabReviewMiniAppUpstreamError);
  });

  it("marks pagination and GitLab's incomplete-diff flags as truncated", async () => {
    const paginated = await configured(async () => new Response(JSON.stringify([
      { old_path: "a", new_path: "a", diff: "", compare_timeout: true },
    ]), { headers: { "x-next-page": "2", "x-total": "2" } })).getReview(REQUEST_ID);
    expect(paginated.truncated).toBe(true);
  });

  it("exposes an actual completed outcome without treating legacy results as zero findings", async () => {
    writeState({ result: { outcome: "reviewed", findings: 3, freshFindings: 2 } });
    const result = await configured(async () => new Response("[]")).getReview(REQUEST_ID);
    expect(result).toMatchObject({ reviewOutcome: "reviewed", findings: 3, items: [] });
    writeState({ result: { outcome: "unchanged" } });
    await expect(configured(async () => new Response("[]")).getReview(REQUEST_ID)).resolves.toMatchObject({ reviewOutcome: "unchanged" });
  });

  function configured(fetch: typeof globalThis.fetch, projectIds?: Readonly<Record<string, number>>) {
    return new GitlabReviewMiniAppController({
      statePath, gitlabUrl: "https://gitlab.example.test/group", gitlabToken: "server-token", fetch, projectIds,
    });
  }

  function writeState(options: { phase?: "pending" | "inFlight" | "completed"; retryAttempt?: number; before?: string; result?: unknown } = {}) {
    const event = { dedupId: "push:1", projectId: 42, projectPath: "mircli/mir-frontend", ref: "refs/heads/main", after: AFTER,
      ...(options.before === undefined ? { before: BEFORE } : { before: options.before }), receivedAt: 1 };
    const phase = options.phase ?? "completed";
    writeFileSync(statePath, JSON.stringify({ version: 1, pending: phase === "pending" ? [event] : [], inFlight: phase === "inFlight" ? [event] : [],
      completed: phase === "completed" ? [{ dedupId: event.dedupId, completedAt: 2, ...(options.result === undefined ? {} : { result: options.result }) }] : [],
      firstPendingAt: phase === "pending" ? 1 : null, nextRunAt: phase === "pending" ? 2 : null, retryAttempt: options.retryAttempt ?? 0 }));
    writeFileSync(`${statePath}.launches.json`, JSON.stringify({ version: 1, offers: [{ requestId: REQUEST_ID, dedupId: event.dedupId, event,
      summary: { commitTitle: "feat: add safety" }, target: { chatId: -1001, messageThreadId: 7 }, status: "activated", createdAt: 1,
      nextNotifyAt: null, notifyAttempt: 0, messageId: 9, activationAt: 2 }] }));
  }
});
