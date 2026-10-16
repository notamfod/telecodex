export type GitlabReviewStatus = "offered" | "queued" | "running" | "retrying" | "completed";

export interface GitlabReviewFinding {
  priority: "P0" | "P1" | "P2" | "P3";
  file: string;
  line?: number;
  description: string;
}

export interface GitlabReviewChange {
  oldPath: string;
  newPath: string;
  diff: string;
  truncated?: boolean;
}

export interface GitlabReviewResult {
  projectPath: string;
  status: GitlabReviewStatus;
  commitTitle?: string;
  baseSha?: string;
  headSha: string;
  gitlabUrl: string;
  reviewOutcome?: "reviewed" | "unchanged";
  findings?: number;
  items: GitlabReviewFinding[];
  changes: GitlabReviewChange[];
  truncated: boolean;
}

export type EmptyGitlabReviewSummary =
  | { kind: "no-findings"; text: string }
  | { kind: "unchanged"; text: string }
  | { kind: "report-unavailable"; text: string };

export function emptyGitlabReviewSummary(review: GitlabReviewResult): EmptyGitlabReviewSummary {
  if (review.reviewOutcome === "reviewed" && review.findings === 0) {
    return { kind: "no-findings", text: "ИИ не нашёл замечаний." };
  }
  if (review.reviewOutcome === "unchanged") {
    return { kind: "unchanged", text: "Этот коммит уже проверяли: новых изменений для ревью нет." };
  }
  if (review.reviewOutcome === "reviewed" && (review.findings ?? 0) > 0) {
    return {
      kind: "report-unavailable",
      text: `Ревью обнаружило ${review.findings} замеч., но подробный отчёт недоступен.`,
    };
  }
  return { kind: "report-unavailable", text: "Сводка ИИ для этого ревью недоступна." };
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function loadGitlabReview(
  requestId: string,
  initData: string,
  refresh = false,
  fetcher: Fetcher = fetch,
): Promise<GitlabReviewResult> {
  const response = await fetcher(`/api/gitlab-reviews/${encodeURIComponent(requestId)}`, {
    cache: refresh ? "no-store" : "default",
    headers: { "x-telegram-init-data": initData },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as GitlabReviewResult;
}

export function isSafeGitlabUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
