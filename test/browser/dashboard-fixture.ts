import { type Page, type Route } from "@playwright/test";
import type { DashboardSession, DashboardView } from "../../web/src/model.js";

export function session(index: number, state: DashboardSession["state"] = "active"): DashboardSession {
  return {
    id: `thread-${index}`, label: `Задача ${index}`, workspace: "telecodex",
    state, timestamp: Date.now() - index * 60_000,
    codexUrl: `codex://threads/thread-${index}`,
    telegramUrl: `https://t.me/c/123/${index + 10}`, canCreateTopic: false,
  };
}

export async function dashboardFixture(page: Page, theme: "light" | "dark" = "dark") {
  const state = {
    rows: { active: [session(0)], recent: [] as DashboardSession[], attention: [] as DashboardSession[] },
    requests: [] as { view: string; offset: number; limit: number }[],
    topicRequests: 0,
    respondTopic: undefined as undefined | ((route: Route) => Promise<void>),
    respond: undefined as undefined | ((route: Route, query: { view: string; offset: number; limit: number }) => Promise<boolean>),
  };
  await page.route("**/telegram-web-app.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `window.__opened = []; window.__haptics = []; window.Telegram = { WebApp: {
      initData: "test-signed-data", colorScheme: "${theme}", ready(){}, expand(){},
      onEvent(){}, offEvent(){}, openTelegramLink(url){window.__opened.push(url)},
      HapticFeedback: {impactOccurred(){}, notificationOccurred(type){window.__haptics.push(type)}}
    }};`,
  }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/dashboard") {
      const query = {
        view: url.searchParams.get("view") ?? "active",
        offset: Number(url.searchParams.get("offset")),
        limit: Number(url.searchParams.get("limit")),
      };
      state.requests.push(query);
      if (await state.respond?.(route, query)) return;
      const rows = state.rows[query.view as DashboardView];
      await route.fulfill({ json: {
        generatedAt: Date.now(),
        counts: Object.fromEntries(Object.entries(state.rows).map(([key, value]) => [key, value.length])),
        page: { ...query, total: rows.length, hasMore: query.offset + query.limit < rows.length },
        sessions: rows.slice(query.offset, query.offset + query.limit),
        system: { codexAvailable: true },
      } });
    } else if (/\/api\/dashboard\/threads\/[^/]+\/topic$/.test(url.pathname)) {
      state.topicRequests++;
      if (state.respondTopic) { await state.respondTopic(route); return; }
      await route.fulfill({ json: { created: false, url: "https://t.me/c/123/10" } });
    } else await route.fulfill({ status: 404, json: { error: "Unexpected test API request" } });
  });
  return state;
}

export async function scrollToEnd(page: Page): Promise<void> {
  await page.locator(".session-list__viewport").evaluate((node) => { node.scrollTop = node.scrollHeight; });
}
