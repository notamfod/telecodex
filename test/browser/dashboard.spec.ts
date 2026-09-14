import { test, expect } from "@playwright/test";
import { dashboardFixture, scrollToEnd, session } from "./dashboard-fixture.js";

test("refresh removes a completed session instead of contradicting the count", async ({ page }) => {
  const data = await dashboardFixture(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Открыть топик: Задача 0", exact: true })).toBeVisible();
  data.rows.active = [];
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Активные: 0" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Открыть топик: Задача 0", exact: true })).toHaveCount(0);
  await expect(page.getByText("В этом разделе нет сессий")).toBeVisible();
});

test("manual pagination retry sends one request and does not auto-loop on error", async ({ page }) => {
  const data = await dashboardFixture(page);
  data.rows.active = Array.from({ length: 200 }, (_, index) => session(index));
  let attempts = 0;
  data.respond = async (route, query) => {
    if (query.offset === 0) return false;
    attempts++;
    await route.fulfill({ status: 503, json: { error: "Страница временно недоступна" } });
    return true;
  };
  await page.goto("/");
  await expect(page.locator(".thread").first()).toBeVisible();
  await scrollToEnd(page);
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(attempts).toBe(2);
});

test("switching tabs during pagination starts the new view and ignores the old error", async ({ page }) => {
  const data = await dashboardFixture(page);
  data.rows.active = Array.from({ length: 200 }, (_, index) => session(index));
  data.rows.recent = [session(99, "recent")];
  let finish!: () => void;
  data.respond = async (route, query) => {
    if (query.view !== "active" || query.offset === 0) return false;
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ status: 503, json: { error: "Ошибка старой вкладки" } });
    return true;
  };
  await page.goto("/");
  await expect(page.locator(".thread").first()).toBeVisible();
  await scrollToEnd(page);
  await expect.poll(() => Boolean(finish)).toBe(true);
  await page.getByRole("button", { name: "Недавние: 1" }).click();
  await expect(page.getByRole("heading", { name: "Открыть топик: Задача 99", exact: true })).toBeVisible();
  finish();
  await expect(page.getByText("Ошибка старой вкладки")).toHaveCount(0);
});

test("opening a session by its title works without a swipe", async ({ page }) => {
  const data = await dashboardFixture(page);
  await page.goto("/");
  await page.getByRole("heading", { name: "Открыть топик: Задача 0", exact: true }).click();
  await expect.poll(() => data.topicRequests).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual(["https://t.me/c/123/10"]);
});

test("expired authentication stops polling and explains how to return", async ({ page }) => {
  const data = await dashboardFixture(page);
  await page.clock.install();
  data.respond = async (route) => {
    await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
    return true;
  };
  await page.goto("/");
  await expect(page.getByText("Сессия истекла", { exact: true })).toBeVisible();
  await expect(page.getByText(/Откройте Dashboard заново/)).toBeVisible();
  const count = data.requests.length;
  await page.clock.fastForward(20_000);
  expect(data.requests.length).toBe(count);
  await expect(page.getByRole("button", { name: "Обновить", exact: true })).toBeDisabled();
});

test("refreshing loaded pages retains a visible session when a preceding row disappears", async ({ page }) => {
  const data = await dashboardFixture(page);
  data.rows.active = Array.from({ length: 200 }, (_, index) => session(index));
  await page.goto("/");
  await expect(page.locator(".thread").first()).toBeVisible();
  await scrollToEnd(page);
  await expect.poll(() => data.requests.some((query) => query.offset === 30)).toBe(true);
  const row = page.getByRole("heading", { name: "Открыть топик: Задача 27", exact: true });
  await expect(row).toBeVisible();
  const before = await row.boundingBox();
  data.rows.active = data.rows.active.slice(1);
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Активные: 199" })).toBeVisible();
  await expect(row).toBeVisible();
  const after = await row.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(3);
});


test("pending topic opens once and never navigates after leaving and returning to the tab", async ({ page }) => {
  const data = await dashboardFixture(page);
  let finish!: () => void;
  data.respondTopic = async (route) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ json: { created: false, url: "https://t.me/c/123/10" } });
  };
  await page.goto("/");
  const title = page.getByRole("button", { name: "Открыть топик: Задача 0", exact: true });
  await title.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => data.topicRequests).toBe(1);
  await expect(title).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(data.topicRequests).toBe(1);
  await page.getByRole("button", { name: "Недавние: 0" }).click();
  await page.getByRole("button", { name: "Активные: 1" }).click();
  await expect(title).toBeDisabled();
  finish();
  await expect(title).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([]);
});

test("a vertical gesture and a cancelled touch do not activate the topic title", async ({ page }) => {
  const data = await dashboardFixture(page);
  await page.goto("/");
  const title = page.getByRole("button", { name: "Открыть топик: Задача 0", exact: true });
  await expect(title).toBeVisible();
  for (const end of ["pointerup", "pointercancel"]) {
    await title.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", button: 0, clientX: 80, clientY: 160 });
    await title.dispatchEvent("pointermove", { pointerId: 7, pointerType: "touch", clientX: 81, clientY: 200 });
    await title.dispatchEvent(end, { pointerId: 7, pointerType: "touch", clientX: 81, clientY: 200 });
    await title.dispatchEvent("click", { detail: 1 });
  }
  expect(data.topicRequests).toBe(0);
  await title.click();
  await expect.poll(() => data.topicRequests).toBe(1);
});

test("background network errors keep the last list without repeated error vibration", async ({ page }) => {
  const data = await dashboardFixture(page);
  await page.clock.install();
  await page.goto("/");
  const title = page.getByRole("button", { name: "Открыть топик: Задача 0", exact: true });
  await expect(title).toBeVisible();
  data.respond = async (route) => { await route.abort("internetdisconnected"); return true; };
  await page.clock.fastForward(6000);
  await expect(page.getByText("Ошибка обновления", { exact: true })).toBeVisible();
  await expect(title).toBeVisible();
  expect(await page.evaluate(() => (window as any).__haptics)).toEqual([]);
});

for (const width of [320, 1280]) {
  for (const theme of ["light", "dark"] as const) {
    test(`explicit actions fit ${width}px ${theme} with long waiting and stalled tasks`, async ({ page }) => {
      await page.setViewportSize({ width, height: 640 });
      const data = await dashboardFixture(page, theme);
      data.rows.active = [session(0, "waiting"), session(1, "stalled")];
      data.rows.active[0].label = "Очень длинное название задачи для проверки переноса и доступности действий";
      data.rows.active[0].waitingOn = "input";
      await page.goto("/");
      await expect(page.getByText("нужно ответить", { exact: true })).toBeVisible();
      await expect(page.getByText("зависла", { exact: true })).toBeVisible();
      const button = page.getByRole("button", { name: "Открыть топик", exact: true }).first();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await button.click();
      await expect.poll(() => data.topicRequests).toBe(1);
    });
  }
}


test("if an anchor and following rows disappear the nearest preceding row is kept", async ({ page }) => {
  const data = await dashboardFixture(page);
  data.rows.active = Array.from({ length: 200 }, (_, index) => session(index));
  await page.goto("/");
  await expect(page.locator(".thread").first()).toBeVisible();
  await scrollToEnd(page);
  await expect.poll(() => data.requests.some((query) => query.offset === 30)).toBe(true);
  const anchor = await page.locator(".session-list__viewport").evaluate((viewport) => {
    const top = viewport.getBoundingClientRect().top;
    const row = [...viewport.querySelectorAll<HTMLElement>(".session-list__row")]
      .find((node) => node.getBoundingClientRect().bottom > top)!;
    return { index: Number(row.dataset.index), y: row.getBoundingClientRect().top };
  });
  expect(anchor.index).toBeGreaterThan(0);
  data.rows.active = data.rows.active.filter((_, i) => i < anchor.index || i > anchor.index + 20);
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Активные: 179" })).toBeVisible();
  const previous = page.getByRole("button", { name: `Открыть топик: Задача ${anchor.index - 1}`, exact: true });
  await expect(previous).toBeVisible();
  const row = previous.locator("xpath=ancestor::div[contains(@class,'session-list__row')]");
  await expect.poll(async () => Math.abs((await row.boundingBox())!.y - anchor.y)).toBeLessThan(3);
});


test("a refresh that exhausts the list removes the obsolete pagination retry", async ({ page }) => {
  const data = await dashboardFixture(page);
  data.rows.active = Array.from({ length: 200 }, (_, i) => session(i));
  data.respond = async (route, query) => {
    if (!query.offset) return false;
    await route.fulfill({ status: 503, json: { error: "Ошибка следующей страницы" } });
    return true;
  };
  await page.goto("/");
  await expect(page.locator(".thread").first()).toBeVisible();
  await scrollToEnd(page);
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeVisible();
  data.rows.active = [];
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByText("В этом разделе нет сессий")).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toHaveCount(0);
});
