import * as reviewApi from "../web/src/gitlab-review-api.js";
import { resolveGitlabReviewRequestId, resolveMiniAppRoute } from "../web/src/route.js";

describe("GitLab review Mini App", () => {
  const id = "a".repeat(32);

  it("uses the signed review parameter before a navigation path", () => {
    expect(resolveGitlabReviewRequestId(`/review/${"b".repeat(32)}`, "", `review_${id}`)).toBe(id);
    expect(resolveMiniAppRoute(`/review/${id}`, "", undefined)).toBe("review");
    expect(resolveGitlabReviewRequestId("/review/not-an-id", "", "review_not-an-id")).toBeUndefined();
  });

  it("loads the review with Telegram authentication and no-store refresh", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "completed" }), { status: 200 }));
    await reviewApi.loadGitlabReview(id, "signed-init-data", true, fetcher);
    expect(fetcher).toHaveBeenCalledWith(`/api/gitlab-reviews/${id}`, {
      cache: "no-store",
      headers: { "x-telegram-init-data": "signed-init-data" },
    });
  });

  it("returns the server error and accepts only HTTPS GitLab links", async () => {
    await expect(reviewApi.loadGitlabReview(id, "init", false, async () => new Response(JSON.stringify({ error: "expired" }), { status: 401 }))).rejects.toThrow("expired");
    expect(reviewApi.isSafeGitlabUrl("https://gitlab.example.com/group/project/-/commit/abc")).toBe(true);
    expect(reviewApi.isSafeGitlabUrl("javascript:alert(1)")).toBe(false);
  });

  it("only reports no findings when the completed response proves a reviewed zero", () => {
    const base = {
      projectPath: "group/project", status: "completed" as const, headSha: "a".repeat(40),
      gitlabUrl: "https://gitlab.example.com/group/project", items: [], changes: [], truncated: false,
    };
    expect(reviewApi.emptyGitlabReviewSummary({ ...base, reviewOutcome: "reviewed", findings: 0 }))
      .toMatchObject({ kind: "no-findings" });
    expect(reviewApi.emptyGitlabReviewSummary({ ...base, reviewOutcome: "unchanged", findings: 0 }))
      .toMatchObject({ kind: "unchanged" });
    expect(reviewApi.emptyGitlabReviewSummary({ ...base, reviewOutcome: "reviewed", findings: 2 }))
      .toMatchObject({ kind: "report-unavailable", text: expect.stringContaining("2") });
    expect(reviewApi.emptyGitlabReviewSummary(base)).toMatchObject({ kind: "report-unavailable" });
  });
});
