import type { DashboardPayload, DashboardQuery } from "./model.js";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface TopicResult {
  created: boolean;
  url: string;
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

export function loadDashboard(
  initData: string,
  query: DashboardQuery,
  fetcher: Fetcher = fetch,
): Promise<DashboardPayload> {
  const params = new URLSearchParams({
    view: query.view,
    offset: String(query.offset),
    limit: String(query.limit),
  });
  return requestJson<DashboardPayload>(`/api/dashboard?${params}`, {
    headers: { "x-telegram-init-data": initData },
  }, fetcher);
}

export function ensureThreadTopic(
  threadId: string,
  initData: string,
  fetcher: Fetcher = fetch,
): Promise<TopicResult> {
  return requestJson<TopicResult>(
    `/api/dashboard/threads/${encodeURIComponent(threadId)}/topic`,
    {
      method: "POST",
      headers: { "x-telegram-init-data": initData },
    },
    fetcher,
  );
}
