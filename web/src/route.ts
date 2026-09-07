export type MiniAppRoute = "dashboard" | "jira";

export function resolveMiniAppRoute(
  pathname: string,
  search: string,
  telegramStartParam?: string,
): MiniAppRoute {
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
