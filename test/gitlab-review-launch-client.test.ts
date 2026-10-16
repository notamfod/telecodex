import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import { activateGitlabReview, loadGitlabReviewLaunchSecret } from "../src/gitlab-review-launch-client.js";

const request = { requestId: "a".repeat(32), chatId: -100123, messageThreadId: 3861, messageId: 91 };

describe("GitLab review launch client", () => {
  it("sends the exact request to loopback with separate authentication and a timeout", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ outcome: "accepted" }), { status: 202 }));
    expect(await activateGitlabReview(request, { fetch: fetcher, secret: "s".repeat(64) })).toBe("accepted");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8790/internal/gitlab/review-launch", expect.objectContaining({
      method: "POST", body: JSON.stringify(request), signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", "x-telecodex-review-token": "s".repeat(64) },
    }));
  });

  it.each([
    new Response(JSON.stringify({ outcome: "failed", secret: "do not expose" }), { status: 403 }),
    new Response(JSON.stringify({ outcome: "unknown" }), { status: 202 }),
  ])("rejects invalid activation responses without exposing their body", async (response) => {
    const fetcher = vi.fn(async () => response);
    await expect(activateGitlabReview(request, { fetch: fetcher, secret: "s".repeat(64) }))
      .rejects.toThrow("GitLab review launch failed");
  });

  it("rejects malformed coordinates before making a request", async () => {
    const fetcher = vi.fn();
    await expect(activateGitlabReview({ ...request, messageId: 0 }, { fetch: fetcher, secret: "s".repeat(64) }))
      .rejects.toThrow("Invalid GitLab review launch request");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads a protected secret file and rejects missing or weak configuration", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "telecodex-review-secret-"));
    const file = path.join(dir, "launch.secret");
    try {
      await writeFile(file, `${"s".repeat(64)}\n`, { mode: 0o600 });
      expect(loadGitlabReviewLaunchSecret({ GITLAB_REVIEW_LAUNCH_SECRET_FILE: file })).toBe("s".repeat(64));
      await writeFile(file, "weak\n");
      expect(() => loadGitlabReviewLaunchSecret({ GITLAB_REVIEW_LAUNCH_SECRET_FILE: file })).toThrow("launch secret");
      expect(() => loadGitlabReviewLaunchSecret({ GITLAB_REVIEW_LAUNCH_SECRET_FILE: "relative.secret" })).toThrow("launch secret");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
