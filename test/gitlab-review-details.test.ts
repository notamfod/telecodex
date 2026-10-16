import { describe, expect, it } from "vitest";
import { isValidGitlabReviewDetails, reviewDetails } from "../src/gitlab-review-details.js";
import { markerProject } from "../src/gitlab-review-result-marker.js";

describe("bounded AI review details", () => {
  it("keeps the actual reviewed range and puts the most urgent findings first", () => {
    const details = reviewDetails("a".repeat(40), "b".repeat(40), [
      { severity: "low", file: "x.ts", description: "low", category: "error" },
      { severity: "high", priority: "P1", file: "src/a.ts", line: 7,
        description: "User <input> is not checked", category: "auth" },
    ]);
    expect(details?.items[0]).toEqual({ priority: "P1", file: "src/a.ts", line: 7,
      description: "User <input> is not checked" });
    expect(isValidGitlabReviewDetails(details)).toBe(true);
    const marker = markerProject({ name: "app", sourcePath: "/repo", status: "reviewed",
      baseSha: "a".repeat(40), headSha: "b".repeat(40), findings: [] }, 0);
    expect(marker).toHaveProperty("details.baseSha", "a".repeat(40));
  });

  it("bounds untrusted agent text and rejects invalid range, count, and shape", () => {
    const details = reviewDetails("a".repeat(40), "b".repeat(40), Array.from({ length: 30 }, () => ({
      severity: "medium" as const, file: "x".repeat(500), description: "d".repeat(600), category: "bug",
    })))!;
    expect(details.items).toHaveLength(10);
    expect(details.items[0].file.length).toBeLessThanOrEqual(200);
    expect(details.items[0].description.length).toBeLessThanOrEqual(220);
    expect(reviewDetails("main", "b".repeat(40), [])).toBeUndefined();
    expect(isValidGitlabReviewDetails({ ...details, secret: "bad" })).toBe(false);
    expect(isValidGitlabReviewDetails({ ...details, items: [{ ...details.items[0], line: -1 }] })).toBe(false);
    expect(isValidGitlabReviewDetails({ ...details, items: Array(11).fill(details.items[0]) })).toBe(false);
  });
});
