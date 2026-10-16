import type { PortfolioProjectResult } from "./review-portfolio.js";
import { reviewDetails, type GitlabReviewDetails } from "./gitlab-review-details.js";

export type GitlabReviewMarkerProject =
  | { readonly name: string; readonly status: "unchanged" }
  | {
    readonly name: string;
    readonly status: "reviewed";
    readonly findings: number;
    readonly freshFindings: number;
    readonly details?: GitlabReviewDetails;
  };

export function markerProject(
  project: PortfolioProjectResult,
  freshFindings: number,
): GitlabReviewMarkerProject {
  const details = reviewDetails(project.baseSha, project.headSha, project.findings);
  return project.status === "unchanged"
    ? { name: project.name, status: "unchanged" }
    : {
      name: project.name,
      status: "reviewed",
      findings: project.findings.length,
      freshFindings,
      ...(details ? { details } : {}),
    };
}

export function renderGitlabReviewResultMarker(
  projects: readonly GitlabReviewMarkerProject[],
): string {
  return `TELECODEX_GITLAB_REVIEW_RESULT=${JSON.stringify({ projects })}`;
}
