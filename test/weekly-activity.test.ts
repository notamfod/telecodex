import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { estimateTime, readSessionActivity, weeklyPeriod, projectForPath } from "../src/weekly-activity.js";

const roots = [{ name: "MirCli", roots: ["/projects/mircli"] }, { name: "TeleCodex", roots: ["/projects/telecodex"] }];
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

it("uses the last Sunday 20:00 Moscow cutoff, including delayed Monday runs", () => {
  expect(weeklyPeriod(new Date("2026-09-14T08:00:00Z"))).toEqual({
    start: Date.parse("2026-09-06T17:00:00Z"), end: Date.parse("2026-09-13T17:00:00Z"),
  });
  expect(weeklyPeriod(new Date("2026-09-13T16:59:00Z")).end).toBe(Date.parse("2026-09-06T17:00:00Z"));
});

it("groups nested repos using path boundaries and the most specific root", () => {
  expect(projectForPath("/projects/mircli/mir-back", roots)).toBe("MirCli");
  expect(projectForPath("/projects/mircli-other", roots)).toBeUndefined();
  expect(projectForPath("/projects/mircli/special/x", [...roots, { name: "Special", roots: ["/projects/mircli/special"] }])).toBe("Special");
});

it("does not count autonomous hours or simultaneous activity twice", () => {
  const points = [{ ts: 600_000, project: "MirCli" }, { ts: 600_000, project: "MirCli" }, { ts: 660_000, project: "TeleCodex" }];
  const result = estimateTime(points, { start: 0, end: 86_400_000 });
  expect([...result.values()].reduce((n, x) => n + x.lowMinutes, 0)).toBe(3);
  expect([...result.values()].reduce((n, x) => n + x.highMinutes, 0)).toBe(11);
  expect(estimateTime([], { start: 0, end: 86_400_000 }).size).toBe(0);
});

it("reads real user input and final answers, skips scaffolding, tools and out-of-period history", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "weekly-activity-")); directories.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  const record = (type: string, payload: unknown, timestamp = "2026-09-10T10:00:00Z") => JSON.stringify({ type, payload, timestamp });
  writeFileSync(file, [
    record("session_meta", { id: "test-session", cwd: "/projects/mircli/mir-back", source: "vscode" }),
    record("response_item", { type: "message", role: "user", content: [{ text: "# AGENTS.md instructions for /projects/mircli" }] }),
    record("response_item", { type: "message", role: "user", content: [{ text: "Исправь выгрузку" }] }),
    record("response_item", { type: "message", role: "assistant", phase: "commentary", content: [{ text: "Изучаю" }] }),
    record("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "Исправлена выгрузка. Деплой не выполнен." }] }),
    record("response_item", { type: "function_call_output", output: "secret tool output" }),
    record("response_item", { type: "message", role: "user", content: [{ text: "Old" }] }, "2026-08-01T00:00:00Z"),
    "{partial",
  ].join("\n"));
  const data = await readSessionActivity(file, roots, weeklyPeriod(new Date("2026-09-13T18:00:00Z")));
  expect(data.points).toHaveLength(1);
  expect(data.entries.every((x) => x.sessionId === "test-session")).toBe(true);
  expect(data.entries.map((x) => x.text)).toEqual(["Исправь выгрузку", "Исправлена выгрузка. Деплой не выполнен."]);
  expect(data.entries.every((x) => x.project === "MirCli")).toBe(true);
});

it("ignores subagent rollouts entirely", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "weekly-child-")); directories.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { cwd: "/projects/mircli", source: { subagent: {} } } }));
  expect((await readSessionActivity(file, roots, { start: 0, end: Date.now() })).points).toEqual([]);
});

it("does not attribute an unrelated workspace to the original project", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "weekly-cwd-")); directories.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  const timestamp = "2026-09-10T10:00:00Z";
  writeFileSync(file, [
    { type: "session_meta", payload: { cwd: "/projects/mircli", source: "vscode" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "Do unrelated work" }] } },
    { type: "turn_context", payload: { cwd: "/projects/unrelated" } },
  ].map((r) => JSON.stringify({ ...r, timestamp })).join("\n"));
  expect((await readSessionActivity(file, roots, weeklyPeriod(new Date("2026-09-13T18:00:00Z")))) .points).toHaveLength(0);
});

it("clips human activity to the reporting period and scrubs credentials", async () => {
  const { safeWeeklyText } = await import("../src/weekly-activity.js");
  expect(estimateTime([{ project: "MirCli", ts: 30_000 }], { start: 0, end: 60_000 }).get("MirCli"))
    .toEqual({ lowMinutes: 1, highMinutes: 1 });
  expect(safeWeeklyText("TOKEN=example-private-value password=example-pass https://u:p@example.com"))
    .toBe("TOKEN=[REDACTED] password=[REDACTED] https://[REDACTED]@example.com");
});

it("reads archived and long-running root sessions from the database", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { collectWeeklyActivity } = await import("../src/weekly-activity.js");
  const dir = mkdtempSync(path.join(tmpdir(), "weekly-db-")); directories.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  const ts = "2026-09-10T10:00:00Z";
  writeFileSync(file, [
    { type: "session_meta", payload: { cwd: "/projects/mircli", source: "vscode" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "Fix export" }] } },
  ].map((r) => JSON.stringify({ ...r, timestamp: ts })).join("\n"));
  const databasePath = path.join(dir, "state.sqlite");
  const db = new Database(databasePath);
  db.exec("CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER, source TEXT, archived INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, 'vscode', 1)").run(file, Date.parse(ts) / 1000);
  db.prepare("INSERT INTO threads VALUES (?, ?, 'exec', 0)").run("/missing-automation", Date.parse(ts) / 1000);
  db.close();
  const result = await collectWeeklyActivity(databasePath, roots, weeklyPeriod(new Date("2026-09-13T18:00:00Z")));
  expect(result.points).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

it("keeps each upper estimate above the lower without inflating overlapping totals", () => {
  const points = [10, 12, 14, 16, 18, 20].map((t) => ({ ts: t * 60_000, project: "A" }));
  for (const project of ["B", "C", "D", "E"]) for (const t of [10, 20]) points.push({ ts: t * 60_000, project });
  const result = estimateTime(points, { start: 0, end: 60 * 60_000 });
  for (const time of result.values()) expect(time.highMinutes).toBeGreaterThanOrEqual(time.lowMinutes);
  expect([...result.values()].reduce((n, t) => n + t.lowMinutes, 0)).toBeCloseTo(12);
  expect([...result.values()].reduce((n, t) => n + t.highMinutes, 0)).toBeCloseTo(20);
});

it("preserves a late status at the end of a long final answer", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "weekly-long-")); directories.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  const text = `${"details ".repeat(1000)}MR merged and deployed`;
  writeFileSync(file, [
    { type: "session_meta", payload: { cwd: "/projects/mircli", source: "vscode" } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text }] } },
  ].map((r) => JSON.stringify({ ...r, timestamp: "2026-09-10T10:00:00Z" })).join("\n"));
  const result = await readSessionActivity(file, roots, weeklyPeriod(new Date("2026-09-13T18:00:00Z")));
  expect(result.entries[0].text.endsWith("MR merged and deployed")).toBe(true);
});
