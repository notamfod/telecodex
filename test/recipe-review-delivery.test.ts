import { describe, expect, it, vi } from "vitest";

import { deliverReviewDigest } from "../src/recipe-review-delivery.js";
import type { MircliReviewRecipe } from "../src/recipe-config.js";
import type { Finding, Triage } from "../src/recipes.js";

const recipe: MircliReviewRecipe = {
  id: "daily-diff-review",
  kind: "mircli-review",
  cwd: "/projects/mircli",
  worktreeRoot: "/worktrees/mircli",
  promptFile: "/prompts/review.txt",
  deliver: { chatId: -100123, messageThreadId: 42 },
};

function findings(count: number): Finding[] {
  return Array.from({ length: count }, (_, index) => ({
    severity: "medium",
    priority: "P2",
    aspect: "architecture",
    file: `src/file-${index + 1}.ts`,
    line: index + 1,
    category: `finding-${index + 1}`,
    description: `Находка ${index + 1}`,
  }));
}

describe("review recipe delivery", () => {
  it("sends one project digest even when the review has many findings", async () => {
    const send = vi.fn(async () => undefined);
    const triage: Triage = {
      fresh: findings(12),
      repeated: findings(2),
      suppressed: findings(1),
      shouldDeliver: true,
    };

    await deliverReviewDigest(recipe, "mir-survey", 16, triage, send);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      recipe,
      expect.stringContaining("<b>mir-survey</b>"),
      expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    );
    expect(send.mock.calls[0]?.[1]).toContain("12 новых");
  });
});
