import path from "node:path";

export function reviewPipelineDbPath(): string {
  const configured = process.env.REVIEW_PIPELINE_DB?.trim();
  if (configured && (!path.isAbsolute(configured) || path.normalize(configured) !== configured)) {
    throw new Error("REVIEW_PIPELINE_DB must be an absolute normalized path");
  }
  return configured || path.resolve(".telecodex/review-pipeline.sqlite");
}

export function reviewPipelineProgressDbPath(): string {
  return `${reviewPipelineDbPath()}.progress`;
}
