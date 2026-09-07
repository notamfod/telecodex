import type {
  JiraBacklogPage,
  JiraIssueDetail,
  JiraView,
  JiraViewResult,
} from "./jira-model.js";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface JiraThreadResult {
  created: boolean;
  url: string;
}

interface JiraViewOptions {
  refresh?: boolean;
  filterId?: string;
}

interface JiraBacklogOptions {
  startAt: number;
  limit: number;
  refresh?: boolean;
}


async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(input, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export function loadJiraView(
  view: JiraView,
  initData: string,
  options: JiraViewOptions = {},
  fetcher: Fetcher = fetch,
): Promise<JiraViewResult> {
  const pathname = view === "filter"
    ? `/api/jira/filters/${encodeURIComponent(options.filterId ?? "")}`
    : `/api/jira/${view}`;
  const query = options.refresh ? "?refresh=1" : "";
  return requestJson<JiraViewResult>(`${pathname}${query}`, {
    headers: { "x-telegram-init-data": initData },
  }, fetcher);
}

export function loadJiraBacklog(
  initData: string,
  options: JiraBacklogOptions,
  fetcher: Fetcher = fetch,
): Promise<JiraBacklogPage> {
  const query = new URLSearchParams({
    startAt: String(options.startAt),
    limit: String(options.limit),
  });
  if (options.refresh) query.set("refresh", "1");
  return requestJson<JiraBacklogPage>(`/api/jira/backlog?${query.toString()}`, {
    headers: { "x-telegram-init-data": initData },
  }, fetcher);
}

export function loadJiraIssue(
  issueKey: string,
  initData: string,
  refresh = false,
  fetcher: Fetcher = fetch,
): Promise<JiraIssueDetail> {
  const query = refresh ? "?refresh=1" : "";
  return requestJson<JiraIssueDetail>(
    `/api/jira/issues/${encodeURIComponent(issueKey)}${query}`,
    { headers: { "x-telegram-init-data": initData } },
    fetcher,
  );
}


export function ensureJiraThread(
  issueKey: string,
  initData: string,
  fetcher: Fetcher = fetch,
): Promise<JiraThreadResult> {
  return requestJson<JiraThreadResult>(
    `/api/jira/issues/${encodeURIComponent(issueKey)}/thread`,
    {
      method: "POST",
      headers: { "x-telegram-init-data": initData },
    },
    fetcher,
  );
}

export async function openJiraIssueThread(
  issueKey: string,
  initData: string,
  open: (url: string) => void,
  fetcher: Fetcher = fetch,
  shouldOpen: () => boolean = () => true,
): Promise<JiraThreadResult> {
  const thread = await ensureJiraThread(issueKey, initData, fetcher);
  if (shouldOpen()) open(thread.url);
  return thread;
}
