import { ReviewPipelineStore, type PipelineSource } from "./review-pipeline-store.js";
import { reviewPipelineDbPath, reviewPipelineProgressDbPath } from "./review-pipeline-path.js";
import type { Finding } from "./recipes.js";
import { ReviewPipelineProgressStore } from "./review-pipeline-progress-store.js";

export function enqueueReviewFindings(input: Omit<PipelineSource, "finding">, findings: readonly Finding[]): void {
  if (!findings.length) return;
  const store = new ReviewPipelineStore(reviewPipelineDbPath());
  try { for (const finding of findings) store.enqueue({ ...input, finding }); }
  finally { store.close(); }
}

/** Scheduled digests enter the same visible pipeline as explicitly selected notifications. */
export function enqueueScheduledReviewFindings(
  entries: readonly { source: Omit<PipelineSource, "finding">; findings: readonly Finding[]; baseSha?: string }[],
  target: { chatId: number; messageThreadId: number },
): void {
  const fresh = entries.filter((entry) => entry.findings.length > 0);
  if (!fresh.length) return;
  const progress = new ReviewPipelineProgressStore(reviewPipelineProgressDbPath());
  try {
    const events = fresh.map(({ source, baseSha, findings }) => {
      const event = { projectPath: `recipes/${source.recipe}/${source.project}`, after: source.headSha,
        ...(baseSha ? { before: baseSha } : {}) };
      progress.markRange(event, { phase: "reviewed", result: { name: source.project, sourcePath: source.cwd,
        worktreePath: source.cwd, headSha: source.headSha, ...(baseSha ? { baseSha } : {}), status: "reviewed",
        findings: [...findings] } });
      return event;
    });
    for (let offset = 0; offset < events.length; offset += 30) progress.trackBatch(events.slice(offset, offset + 30), target);
    for (const entry of fresh) enqueueReviewFindings(entry.source, entry.findings);
  } finally { progress.close(); }
}
