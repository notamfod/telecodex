import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { enqueueScheduledReviewFindings } from "../src/review-pipeline-enqueue.js";
import { ReviewPipelineProgressStore } from "../src/review-pipeline-progress-store.js";
import { ReviewPipelineStore } from "../src/review-pipeline-store.js";

it("registers one visible batch for fresh findings from a scheduled run and reuses it on retry", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-scheduled-batch-"));
  const previous = process.env.REVIEW_PIPELINE_DB;
  process.env.REVIEW_PIPELINE_DB = path.join(dir, "jobs.sqlite");
  const finding = { severity: "medium" as const, file: "src/a.ts", category: "race", description: "Late reply" };
  const entries = ["mir-back", "mir-survey"].map((project) => ({ source: { recipe: "daily-diff-review", project,
    cwd: `/repos/${project}`, headSha: "a".repeat(40) }, findings: [finding], baseSha: "b".repeat(40) }));
  try {
    enqueueScheduledReviewFindings(entries, { chatId: -1001, messageThreadId: 7 });
    enqueueScheduledReviewFindings(entries, { chatId: -1001, messageThreadId: 7 });
    const progress = new ReviewPipelineProgressStore(process.env.REVIEW_PIPELINE_DB + ".progress");
    const jobs = new ReviewPipelineStore(process.env.REVIEW_PIPELINE_DB);
    try {
      expect(progress.listBatches()).toHaveLength(1);
      const batch = progress.listBatches()[0]!;
      expect(batch.events).toHaveLength(2);
      for (const event of batch.events) {
        expect(event.projectPath).toMatch(/^recipes\/daily-diff-review\//);
        expect(progress.range(event)).toMatchObject({ phase: "reviewed", result: { findings: [finding] } });
        expect(jobs.listForSource(path.posix.basename(event.projectPath), event.after)).toHaveLength(1);
      }
    } finally { progress.close(); jobs.close(); }
  } finally {
    if (previous === undefined) delete process.env.REVIEW_PIPELINE_DB; else process.env.REVIEW_PIPELINE_DB = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
