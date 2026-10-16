import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { GitlabReviewSelection } from "../src/gitlab-review-selection.js";

it("persists multiple selected messages separately for each user and topic", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-select-"));
  try {
    const file = path.join(dir, "selection.sqlite");
    const first = new GitlabReviewSelection(file);
    const message = { requestId: "a".repeat(32), chatId: -1001, messageThreadId: 7, messageId: 10 };
    expect(first.toggle(42, message)).toBe(true);
    first.toggle(42, { ...message, requestId: "b".repeat(32), messageId: 11 });
    first.close();
    const next = new GitlabReviewSelection(file);
    expect(next.list(42, -1001, 7).map((item) => item.messageId)).toEqual([10, 11]);
    expect(next.list(43, -1001, 7)).toEqual([]);
    expect(next.list(42, -1001, 8)).toEqual([]);
    next.remove(42, message);
    expect(next.list(42, -1001, 7).map((item) => item.messageId)).toEqual([11]);
    expect(next.toggle(42, { ...message, requestId: "b".repeat(32), messageId: 11 })).toBe(false);
    next.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
