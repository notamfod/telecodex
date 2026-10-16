import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadMircliDeploySummaryConfig, MircliDeploySummary } from "../src/mircli-deploy-summary.js";

const base = { projectIds: { "mircli/api": 42 }, statePath: "/tmp/review.json" };
const env = { MIRCLI_DEPLOY_TOPIC_ID: "7", TELEGRAM_FORUM_CHAT_ID: "-1001", TELEGRAM_BOT_TOKEN: "token", GITLAB_TOKEN: "gitlab", GITLAB_URL: "https://gitlab.example.com" };
let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it("is disabled by default and validates explicit configuration", () => {
  expect(loadMircliDeploySummaryConfig({}, base)).toBeUndefined();
  expect(loadMircliDeploySummaryConfig(env, base)).toMatchObject({ target: { chatId: -1001, messageThreadId: 7 }, intervalMs: 60_000 });
  expect(() => loadMircliDeploySummaryConfig({ ...env, MIRCLI_DEPLOY_TOPIC_ID: "7x" }, base)).toThrow();
  expect(() => loadMircliDeploySummaryConfig({ ...env, GITLAB_URL: "https://user:pass@example.com" }, base)).toThrow();
});
it("retains good state during outage, restores it after restart, and retries edits without new messages", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-summary-"));
  const config = loadMircliDeploySummaryConfig(env, { ...base, statePath: path.join(directory, "review.json") })!;
  let offline = false;
  const collect = vi.fn(async (options) => {
    if (offline) throw new Error("token must not leak");
    return { projectPath: options.projectPath, ref: options.ref, active: [], checkedAt: "2026-10-13T08:00:00Z" };
  });
  let id = 0;
  const call = vi.fn(async (method) => method === "sendMessage" ? { message_id: ++id } : true);
  const summary = await MircliDeploySummary.open(config, { call, collect, autoSchedule: false });
  await summary.refresh();
  expect(call.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
  offline = true;
  await summary.refresh();
  expect(summary.rows().every((row) => row.checkedAt === "2026-10-13T08:00:00Z" && row.error === "GitLab: обновление не удалось")).toBe(true);
  await summary.close();
  const restarted = await MircliDeploySummary.open(config, { call, collect, autoSchedule: false });
  expect(restarted.rows()).toEqual(summary.rows());
  await restarted.refresh();
  expect(call.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
  expect(JSON.stringify(call.mock.calls)).not.toContain("must not leak");
  await restarted.close();
});

it("uses successful partial data on a cold start and marks it incomplete", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-summary-"));
  const config = loadMircliDeploySummaryConfig(env, { ...base, statePath: path.join(directory, "review.json") })!;
  const record = { id: 1, jobId: 11, projectPath: "mircli/api", ref: "main" as const, status: "success",
    sha: "a".repeat(40), createdAt: "2026-10-13T08:00:00Z", updatedAt: "2026-10-13T08:00:00Z",
    jobUrl: "https://gitlab.example.com/mircli/api/-/jobs/11" };
  let id = 0;
  const summary = await MircliDeploySummary.open(config, { autoSchedule: false,
    call: vi.fn(async (method) => method === "sendMessage" ? { message_id: ++id } : true),
    collect: async (options) => ({ projectPath: options.projectPath, ref: options.ref, active: [], error: "GitLab HTTP 503",
      ...(options.ref === "main" ? { latest: record, success: record } : {}) }),
  });
  await summary.refresh();
  expect(summary.rows().find((row) => row.ref === "main")).toMatchObject({ success: record, error: "GitLab HTTP 503" });
  await summary.close();
});

it("periodically reconciles other services during a continuous deployment webhook stream", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-summary-"));
  const config = loadMircliDeploySummaryConfig(env, { projectIds: { "mircli/api": 42, "mircli/web": 43 }, statePath: path.join(directory, "review.json") })!;
  let id = 0;
  let now = 2_000_000_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const collect = vi.fn(async ({ projectPath, ref }) => ({ projectPath, ref, active: [] }));
  const summary = await MircliDeploySummary.open(config, { autoSchedule: false, collect,
    call: async (method) => method === "sendMessage" ? { message_id: ++id } : true });
  try {
    await summary.refresh();
    collect.mockClear();
    summary.invalidate("mircli/api");
    now += 1000;
    await summary.refresh();
    expect(collect.mock.calls.map(([item]) => item.projectPath)).toEqual(["mircli/api", "mircli/api"]);
    collect.mockClear();
    summary.invalidate("mircli/api");
    now += 60_000;
    await summary.refresh();
    expect(collect.mock.calls.some(([item]) => item.projectPath === "mircli/web")).toBe(true);
  } finally { clock.mockRestore(); await summary.close(); }
});

it("does not postpone a scheduled update during sub-second deployment bursts", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-summary-"));
  const config = loadMircliDeploySummaryConfig(env, { ...base, statePath: path.join(directory, "review.json") })!;
  let id = 0;
  const collect = vi.fn(async ({ projectPath, ref }) => ({ projectPath, ref, active: [] }));
  const summary = await MircliDeploySummary.open(config, { collect,
    call: async (method) => method === "sendMessage" ? { message_id: ++id } : true });
  await summary.refresh();
  collect.mockClear();
  vi.useFakeTimers();
  try {
    for (let i = 0; i < 8; i++) {
      summary.invalidate("mircli/api");
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(collect).toHaveBeenCalled();
  } finally { vi.useRealTimers(); await summary.close(); }
});

it("animates cached running state without refetching GitLab or posting another message", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-summary-"));
  const config = loadMircliDeploySummaryConfig(env, { ...base, statePath: path.join(directory, "review.json") })!;
  const startedAt = new Date().toISOString();
  const active = { id: 1, jobId: 11, projectPath: "mircli/api", ref: "main" as const, status: "running",
    sha: "a".repeat(40), createdAt: startedAt, updatedAt: startedAt, startedAt,
    jobUrl: "https://gitlab.example.com/mircli/api/-/jobs/11" };
  let status = "running";
  let id = 0;
  const collect = vi.fn(async ({ projectPath, ref }) => ({ projectPath, ref,
    active: ref === "main" && status === "running" ? [active] : [], checkedAt: new Date().toISOString(),
    ...(status === "offline" ? { error: "GitLab unavailable" } : {}) }));
  const call = vi.fn(async (method) => method === "sendMessage" ? { message_id: ++id } : true);
  vi.useFakeTimers();
  const summary = await MircliDeploySummary.open(config, { call, collect });
  try {
    await summary.refresh();
    collect.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === "editMessageText")).toBe(true));
    expect(collect).not.toHaveBeenCalled();
    expect(call.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
    await summary.selectView({ ...config.target, messageId: 1, ref: "production" });
    const count = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call).toHaveBeenCalledTimes(count);
    await summary.selectView({ ...config.target, messageId: 1, ref: "main" });
    status = "offline";
    await summary.refresh();
    const offline = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call).toHaveBeenCalledTimes(offline);
    status = "finished";
    await summary.refresh();
    const stopped = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call).toHaveBeenCalledTimes(stopped);
  } finally { await summary.close(); vi.useRealTimers(); }
});
