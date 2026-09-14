import { expect, test } from "@playwright/test";
import { dashboardFixture, session } from "./dashboard-fixture.js";

test("search finds a task beyond the first page and project changes reach the server", async ({ page }) => {
  const state = await dashboardFixture(page);
  state.rows.active = Array.from({ length: 205 }, (_, i) => ({ ...session(i), projectId: i % 2 ? "one" : "two", workspace: i % 2 ? "Проект один" : "Проект два" }));
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Поиск задач" }).fill("Задача 204");
  await expect(page.getByRole("button", { name: "Открыть топик: Задача 204", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Проект" }).selectOption("one");
  await expect.poll(() => state.requests.at(-1)?.project).toBe("one");
  await expect(page.getByText("В этом разделе нет сессий")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить" }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.getByRole("combobox")).toHaveValue("");
});

test("completed task without host opens its topic without creating a Codex topic", async ({ page }) => {
  const state = await dashboardFixture(page);
  state.rows.completed = [{ ...session(9, "completed"), id: "task:complete", threadId: null, codexUrl: undefined,
    taskContext: { stateLabel: "Завершена", confirmedAt: Date.now(), resultStatus: "pending", resultUrl: "https://t.me/c/123/99" },
    taskLinks: [{ label: "Последний подтверждённый результат", url: "https://t.me/c/123/99" }] }];
  await page.goto("/");
  await page.getByRole("button", { name: "Завершённые: 1" }).click();
  await expect(page.getByText(/Новый результат пока не подтверждён/)).toBeVisible();
  await page.getByRole("button", { name: "Последний подтверждённый результат" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual(["https://t.me/c/123/99"]);
  expect(state.topicRequests).toBe(0);
  await expect(page.getByRole("button", { name: "ChatGPT", exact: true })).toBeDisabled();
});

test("restores saved filters only for the authenticated namespace", async ({ page }) => {
  const state = await dashboardFixture(page);
  state.rows.completed = [{ ...session(4, "completed"), label: "Готовый тикет", projectId: "one" }];
  await page.goto("/");
  await page.getByRole("button", { name: "Завершённые: 1" }).click();
  await page.getByRole("searchbox").fill("Готовый");
  await expect(page.getByRole("button", { name: "Открыть топик: Готовый тикет" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("searchbox")).toHaveValue("Готовый");
  await expect(page.getByRole("button", { name: "Открыть топик: Готовый тикет" })).toBeVisible();
  state.namespace = "telecodex:tasks:v1:2:123";
  await page.reload();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Открыть топик: Задача 0", exact: true })).toBeVisible();
});

test("restores the visible task after reloading a long list", async ({ page }) => {
  const state = await dashboardFixture(page);
  state.rows.active = Array.from({ length: 100 }, (_, i) => session(i));
  await page.goto("/");
  const viewport = page.locator(".session-list__viewport");
  await viewport.evaluate(node => { node.scrollTop = 2200; });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("telecodex:tasks:v1:1:123") ?? "{}").anchor?.ids[0])).toBeTruthy();
  const anchor = await page.evaluate(() => JSON.parse(localStorage.getItem("telecodex:tasks:v1:1:123")!).anchor.ids[0]);
  await page.reload();
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(1500);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("telecodex:tasks:v1:1:123") ?? "{}").anchor?.ids[0])).toBe(anchor);
});

test("fresh input wins over saved preferences while authentication response is pending", async ({ page }) => {
  const state = await dashboardFixture(page);
  await page.addInitScript(() => localStorage.setItem("telecodex:tasks:v1:1:123",
    JSON.stringify({ view: "active", search: "old", project: "", count: 30 })));
  state.rows.active = [{ ...session(0), label: "new" }];
  state.respond = async (route, query) => {
    if (!query.search) { await new Promise(resolve => setTimeout(resolve, 700)); }
    return false;
  };
  await page.goto("/");
  await page.getByRole("searchbox").fill("new");
  await expect(page.getByRole("button", { name: "Открыть топик: new", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("new");
});

test("failed restoration survives reopening and retries the entire saved window", async ({ page }) => {
  const state = await dashboardFixture(page);
  state.rows.active = Array.from({ length: 200 }, (_, i) => session(i));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Открыть топик: Задача 0", exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("telecodex:tasks:v1:1:123",
    JSON.stringify({ view: "active", search: "", project: "", count: 180, anchor: { ids: ["thread-150"], index: 150, offset: 0 } })));
  // pagehide would normally save the current window; a new page supplies the saved state below.
  await page.addInitScript(() => localStorage.setItem("telecodex:tasks:v1:1:123",
    JSON.stringify({ view: "active", search: "", project: "", count: 180, anchor: { ids: ["thread-150"], index: 150, offset: 0 } })));
  let fail = true;
  state.respond = async (route, query) => {
    if (fail && query.limit === 100) {
      fail = false;
      await route.fulfill({ status: 503, json: { error: "Restore unavailable" } });
      return true;
    }
    return false;
  };
  await page.reload();
  await expect(page.getByText("Restore unavailable")).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("telecodex:tasks:v1:1:123")!).count)).toBe(180);
  await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.getByRole("button", { name: "Открыть топик: Задача 150", exact: true })).toBeVisible();
  expect(state.requests.some(query => query.offset === 100)).toBe(true);
});

test("typing invalidates an older search immediately", async ({ page }) => {
  const state = await dashboardFixture(page);
  state.rows.active = [{ ...session(0), label: "new result" }];
  state.respond = async (route, query) => {
    if (query.search === "old") {
      await new Promise(resolve => setTimeout(resolve, 700));
      await route.fulfill({ json: { generatedAt: Date.now(), counts: { active: 1, recent: 0, attention: 0, completed: 0 },
        page: { ...query, total: 1, hasMore: false }, sessions: [{ ...session(1), label: "old result" }], system: { codexAvailable: true } } });
      return true;
    }
    return false;
  };
  await page.goto("/");
  await page.getByRole("searchbox").fill("old");
  await expect.poll(() => state.requests.some(query => query.search === "old")).toBe(true);
  await page.getByRole("searchbox").fill("new");
  await expect(page.getByRole("button", { name: "Открыть топик: new result", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Открыть топик: old result", exact: true })).toHaveCount(0);
});
