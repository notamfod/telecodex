import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseWeeklySummary, runWeeklySummaryRecipe } from "../src/weekly-recipe.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "weekly-recipe-")); dirs.push(dir);
  const recipe = { id: "weekly", kind: "weekly-summary" as const, cwd: dir, databasePath: "/unused", projects: [{ name: "MirCli", roots: [dir] }], deliver: { chatId: -100123, messageThreadId: 42 } };
  const data = { points: [{ ts: Date.parse("2026-09-10T10:00:00Z"), project: "MirCli" }], entries: [{ ts: Date.parse("2026-09-10T10:00:00Z"), project: "MirCli", role: "assistant" as const, text: "Fixed" }], warnings: [] };
  const deps = { now: new Date("2026-09-13T18:00:00Z"), stateDir: dir, collect: vi.fn(async () => data), commits: vi.fn(async () => ""), summarize: vi.fn(async () => JSON.stringify({ done: ["Исправлена выгрузка <CSV>"], pending: ["Деплой не подтверждён"] })) };
  return { dir, recipe, deps };
}

it("rejects unstructured, empty and oversized summaries", () => {
  expect(() => parseWeeklySummary("looks fine")).toThrow();
  expect(() => parseWeeklySummary('{"done":[],"pending":[]}')).toThrow();
  expect(() => parseWeeklySummary(JSON.stringify({ done: ["x".repeat(401)], pending: [] }))).toThrow();
});

it("previews escaped HTML without delivery or delivery state", async () => {
  const { recipe, deps, dir } = setup(); const send = vi.fn();
  const result = await runWeeklySummaryRecipe(recipe, send, { ...deps, preview: true });
  expect(send).not.toHaveBeenCalled();
  expect(result.messages.join("\n")).toContain("&lt;CSV&gt;");
  expect(result.messages.join("\n")).toContain("оценка");
  expect(() => readFileSync(path.join(dir, "weekly.json"))).toThrow();
});

it("delivers once and suppresses a second run for the same cutoff", async () => {
  const { recipe, deps } = setup(); const send = vi.fn(async () => {});
  const first = await runWeeklySummaryRecipe(recipe, send, deps);
  expect(first.delivered).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.length).toBe(1);
  expect((await runWeeklySummaryRecipe(recipe, send, deps)).delivered).toBe(0);
  expect(deps.collect).toHaveBeenCalledTimes(1);
});

it("does not blindly resend an ambiguous Telegram failure", async () => {
  const { recipe, deps } = setup();
  await expect(runWeeklySummaryRecipe(recipe, vi.fn(async () => { throw new Error("timeout"); }), deps)).rejects.toThrow("timeout");
  const send = vi.fn();
  await expect(runWeeklySummaryRecipe(recipe, send, deps)).rejects.toThrow(/uncertain/);
  expect(send).not.toHaveBeenCalled();
});

it("does not treat corrupt delivery state as a fresh report", async () => {
  const { recipe, deps, dir } = setup();
  writeFileSync(path.join(dir, "weekly.json"), "{broken");
  await expect(runWeeklySummaryRecipe(recipe, vi.fn(), deps)).rejects.toThrow();
  expect(deps.collect).not.toHaveBeenCalled();
});

it("keeps final outcomes when sampling a large alternating conversation", async () => {
  const { recipe, deps } = setup();
  deps.collect.mockResolvedValue({ points: [], warnings: [], entries: Array.from({ length: 200 }, (_, i) => ({
    ts: Date.parse("2026-09-10T10:00:00Z") + i * 1000, project: "MirCli", role: (i % 2 ? "assistant" : "user") as "assistant",
    text: `${i % 2 ? "RESULT" : "REQUEST"} ${"a".repeat(1000)}`,
  })) });
  await runWeeklySummaryRecipe(recipe, vi.fn(), { ...deps, preview: true });
  expect(deps.summarize.mock.calls[0]?.[0]).toContain("assistant: RESULT");
});

it("splits large valid project summaries into Telegram-sized messages", async () => {
  const { recipe, deps } = setup();
  deps.summarize.mockResolvedValue(JSON.stringify({ done: Array(5).fill("<".repeat(400)), pending: Array(5).fill("x".repeat(400)) }));
  const result = await runWeeklySummaryRecipe(recipe, vi.fn(), { ...deps, preview: true });
  expect(result.messages.length).toBeGreaterThan(1);
  expect(result.messages.every((x) => x.length <= 3900)).toBe(true);
});

it("processes every entry of a large history instead of dropping later status changes", async () => {
  const { recipe, deps } = setup();
  deps.collect.mockResolvedValue({ points: [], warnings: [], entries: Array.from({ length: 200 }, (_, i) => ({
    ts: Date.parse("2026-09-10T10:00:00Z") + i * 1000, project: "MirCli", role: "assistant" as const,
    text: `STATUS_${i}_ ${"a".repeat(1100)}`,
  })) });
  await runWeeklySummaryRecipe(recipe, vi.fn(), { ...deps, preview: true });
  const prompts = deps.summarize.mock.calls.map((call) => call[0]).join("\n");
  expect(Array.from({ length: 200 }, (_, i) => prompts.includes(`STATUS_${i}_`)).every(Boolean)).toBe(true);
});

it("renders rich sections and upper-bound client time without a range", async () => {
  const { recipe, deps } = setup();
  deps.summarize.mockResolvedValue(JSON.stringify({ done: ["**Импорт смет:** исправлен <CSV>."], pending: ["**Публикация:** выполнить деплой."] }));
  const result = await runWeeklySummaryRecipe(recipe, vi.fn(), { ...deps, preview: true });
  const html = result.messages.join("\n");
  expect(html).toContain("<b>Результаты</b>");
  expect(html).toContain("<b>Импорт смет:</b> исправлен &lt;CSV&gt;");
  expect(html).toContain("<b>Следующие шаги</b>");
  expect(html).toContain("Трудозатраты (оценка): <b>0,2 ч</b>");
  expect(html).toContain("<b>Итого: 0,2 ч</b>");
  expect(html).not.toContain("Твоё время");
  expect(html).not.toContain("окна 2");
  expect(html).not.toMatch(/\d,\d–\d,\d/);
});
