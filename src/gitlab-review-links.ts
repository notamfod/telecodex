import type { GitlabReviewDetails } from "./gitlab-review-details.js";

export interface GitlabReviewLinks {
  readonly gitlabUrl?: string;
  readonly miniAppLaunchUrl?: string;
}

interface ReviewRange {
  readonly projectPath: string;
  readonly before?: string;
  readonly after: string;
}

type ReviewButton = { text: string; url: string } | { text: string; callback_data: string };
export interface GitlabReviewKeyboard {
  [key: string]: unknown;
  inline_keyboard: ReviewButton[][];
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function gitlabReviewUrl(
  baseUrl: string,
  event: ReviewRange,
  details?: GitlabReviewDetails,
): string {
  const base = safeHttpsUrl(baseUrl);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(event.projectPath)
    || event.projectPath.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Invalid GitLab project path");
  }
  const head = details?.headSha ?? event.after;
  const before = details?.baseSha ?? event.before;
  if (!SHA.test(head) || before !== undefined && !SHA.test(before)) throw new Error("Invalid GitLab range");
  const project = `${base.origin}${base.pathname.replace(/\/+$/, "")}/${event.projectPath}`;
  return before && !/^0+$/.test(before)
    ? `${project}/-/compare/${before}...${head}?straight=true`
    : `${project}/-/commit/${head}`;
}

export function gitlabReviewKeyboard(
  event: ReviewRange,
  requestId: string,
  links: GitlabReviewLinks,
  launch: boolean,
  details?: GitlabReviewDetails,
): GitlabReviewKeyboard {
  if (!/^[a-f0-9]{32}$/.test(requestId)) throw new Error("Invalid GitLab review request id");
  const rows: ReviewButton[][] = launch
    ? [[{ text: "▶ Запустить ревью", callback_data: `greview:${requestId}` }]] : [];
  rows.push([
    { text: "☐ В подборку", callback_data: `gpselect:${requestId}` },
    { text: "▶ Запустить пайплайн", callback_data: `gpipeline:${requestId}` },
  ]);
  const navigation: ReviewButton[] = [];
  if (links.miniAppLaunchUrl) {
    const miniApp = safeHttpsUrl(links.miniAppLaunchUrl);
    if (miniApp.hostname === "t.me") miniApp.searchParams.set("startapp", `review_${requestId}`);
    else miniApp.pathname = `/review/${requestId}`;
    navigation.push({ text: "📄 Дифф", url: miniApp.toString() });
  }
  if (links.gitlabUrl) navigation.push({ text: "↗ GitLab", url: gitlabReviewUrl(links.gitlabUrl, event, details) });
  if (navigation.length) rows.push(navigation);
  return { inline_keyboard: rows };
}

function safeHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Review links must use a safe HTTPS URL");
  }
  return url;
}
