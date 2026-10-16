import { ReviewPipelineStore, type PipelineSource } from "./review-pipeline-store.js";
import { reviewPipelineDbPath } from "./review-pipeline-path.js";
import type { Finding } from "./recipes.js";

export function enqueueReviewFindings(input: Omit<PipelineSource, "finding">, findings: readonly Finding[]): void {
  if (!findings.length) return;
  const store = new ReviewPipelineStore(reviewPipelineDbPath());
  try { for (const finding of findings) store.enqueue({ ...input, finding }); }
  finally { store.close(); }
}
