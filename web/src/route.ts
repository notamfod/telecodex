export type MiniAppRoute = "dashboard" | "jira" | "review";

const REVIEW_START_PARAM = /^review_([a-f0-9]{32})$/;
const REVIEW_PATH = /^\/review\/([a-f0-9]{32})\/?$/;

export function resolveGitlabReviewRequestId(
  pathname: string,
  search: string,
  telegramStartParam?: string,
): string | undefined {
  const signedMatch = telegramStartParam?.match(REVIEW_START_PARAM);
  if (signedMatch) return signedMatch[1];

  const queryStartParam = new URLSearchParams(search).get("tgWebAppStartParam");
  const queryMatch = queryStartParam?.match(REVIEW_START_PARAM);
  if (queryMatch) return queryMatch[1];

  return pathname.match(REVIEW_PATH)?.[1];
}

export function resolveMiniAppRoute(
  pathname: string,
  search: string,
  telegramStartParam?: string,
): MiniAppRoute {
  if (resolveGitlabReviewRequestId(pathname, search, telegramStartParam)) return "review";

  const queryStartParam = new URLSearchParams(search).get("tgWebAppStartParam");
  if (
    pathname === "/jira"
    || pathname.startsWith("/jira/")
    || telegramStartParam === "jira"
    || queryStartParam === "jira"
  ) {
    return "jira";
  }
  return "dashboard";
}
