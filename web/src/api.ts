import type { DashboardPayload, DashboardQuery, DashboardSession, DashboardView } from "./model.js";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface TopicResult {
  created: boolean;
  url: string;
}

export class DashboardRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(input, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new DashboardRequestError(body.error ?? `Request failed (${response.status})`, response.status);
  return body as T;
}

export function loadDashboard(
  initData: string,
  query: DashboardQuery,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<DashboardPayload> {
  const params = new URLSearchParams({
    view: query.view,
    offset: String(query.offset),
    limit: String(query.limit),
  });
  return requestJson<DashboardPayload>(`/api/dashboard?${params}`, {
    headers: { "x-telegram-init-data": initData },
    ...(signal ? { signal } : {}),
  }, fetcher);
}

/** Fetch the entire displayed window before replacing any visible rows. */
export async function loadDashboardWindow(
  initData: string,
  view: DashboardView,
  count: number,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<{ payload: DashboardPayload; nextOffset: number }> {
  const size = Math.max(30, count);
  const rows = new Map<string, DashboardSession>();
  let offset = 0;
  let payload: DashboardPayload;
  do {
    payload = await loadDashboard(initData, {
      view, offset, limit: Math.min(100, size - offset),
    }, fetcher, signal);
    for (const row of payload.sessions) rows.set(row.id, row);
    offset += payload.sessions.length;
    if (payload.sessions.length === 0) break;
  } while (payload.page.hasMore && offset < size);
  return { payload: { ...payload, sessions: [...rows.values()] }, nextOffset: offset };
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

export function runTaskAction(action: Record<string, unknown>, initData: string, fetcher: Fetcher = fetch): Promise<{ ok: boolean }> {
  return requestJson("/api/dashboard/tasks/action", { method: "POST", headers: {
    "x-telegram-init-data": initData, "content-type": "application/json",
  }, body: JSON.stringify(action) }, fetcher);
}
