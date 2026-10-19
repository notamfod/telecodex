import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ReviewPipelineProgressRuntime } from "../src/review-pipeline-progress.js";
import { ReviewPipelineProgressStore } from "../src/review-pipeline-progress-store.js";
import { ReviewPipelineStore } from "../src/review-pipeline-store.js";

it("shows missing context as a paused outcome without scheduling another analysis", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-context-progress-"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  const event = { projectPath: "group/mir-admin", after: "a".repeat(40) };
  const finding = { severity: "medium" as const, file: "x.ts", category: "api", description: "Backend contract unknown" };
  const job = jobs.enqueue({ recipe: "daily", project: "mir-admin", cwd: "/repo", headSha: event.after, finding });
  jobs.claim(); const report = { verdict: "uncertain" as const, reason: "Need backend validation", evidence: ["x.ts:1"] };
  jobs.finishRound(job.id, report, report);
  const batch = progress.trackBatch([event], { chatId: -1001, messageThreadId: 7 });
  progress.markRange(event, { phase: "reviewed", result: { name: "mir-admin", sourcePath: "/repo", status: "reviewed", headSha: event.after, findings: [finding] } });
  const send = vi.fn(async () => 12); const edit = vi.fn();
  const runtime = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit });
  try {
    await runtime.runOnce(); await runtime.runOnce();
    expect(progress.listBatches().find((b) => b.id === batch.id)?.finished).toBe(true);
    expect(send.mock.calls[0]?.[1]).toContain("Нужен контекст");
    expect(send.mock.calls[0]?.[1]).toContain("автоповтор остановлен");
    expect(send.mock.calls[0]?.[1]).toContain("отклонено: 0");
    expect(edit).not.toHaveBeenCalled();
  } finally { await runtime.dispose(); progress.close(); jobs.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps one visible batch card across restart and finishes only after review and draft delivery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-progress-"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  const event = { projectPath: "group/mir-back", after: "a".repeat(40) };
  const batch = progress.trackBatch([event], { chatId: -1001, messageThreadId: 7 });
  const send = vi.fn(async () => 12); const edit = vi.fn(async () => undefined);
  let sessionId: string | undefined;
  const runtime = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit, jiraUrl: "https://t.me/c/1/9",
    sessionId: () => sessionId });
  try {
    await runtime.runOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toContain("0/1");
    await runtime.runOnce();
    expect(edit).not.toHaveBeenCalled();
    sessionId = "01a144a8-f9be-7962-ae96-5e6af46f906a";
    await runtime.runOnce();
    expect(edit.mock.calls.at(-1)?.[1]).toContain(sessionId);
    const finding = { severity: "medium" as const, file: "x.php", line: 2, category: "race", description: "late reply" };
    const job = jobs.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: event.after, finding });
    progress.markRange(event, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repo", status: "reviewed", headSha: event.after, findings: [finding] } });
    jobs.claim(); progress.markAgent(job.id, "verifier");
    await runtime.runOnce();
    expect(edit.mock.calls.at(-1)?.[1]).toContain("проверяющий");
    expect(progress.listBatches()[0]?.finished).toBe(false);
    const report = { verdict: "confirmed" as const, reason: "confirmed", evidence: ["x.php:2"], draft: {
      summary: "Stop late replies", priority: "Medium" as const, problem: "Late reply", fix: "Cancel", benefit: "No work", acceptance: ["No late work"],
    } };
    jobs.finishRound(job.id, report, report);
    await runtime.runOnce();
    expect(progress.listBatches()[0]?.finished).toBe(false);
    jobs.markDelivered(job.id, -1001, 9, 18);
    await runtime.dispose();
    const restarted = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit, jiraUrl: "https://t.me/c/1/9" });
    await restarted.runOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(edit.mock.calls.at(-1)?.[0].messageId).toBe(12);
    expect(edit.mock.calls.at(-1)?.[1]).toContain("Пайплайн завершён");
    expect(edit.mock.calls.at(-1)?.[1]).toContain("https://t.me/c/1/9");
    expect(progress.listBatches().find((item) => item.id === batch.id)?.finished).toBe(true);
    await restarted.dispose();
  } finally { await runtime.dispose(); jobs.close(); progress.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("reopens the visible card when a completed negative verdict is resumed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-progress-"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  const event = { projectPath: "group/mir-back", after: "a".repeat(40) };
  progress.trackBatch([event], { chatId: -1001, messageThreadId: 7 });
  const finding = { severity: "medium" as const, file: "x.php", category: "race", description: "late reply" };
  const job = jobs.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: event.after, finding });
  jobs.claim();
  const report = { verdict: "disproved" as const, reason: "not reproduced", evidence: ["x.php:1"] };
  jobs.finishRound(job.id, report, report);
  progress.markRange(event, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repo", status: "reviewed", headSha: event.after, findings: [finding] } });
  const send = vi.fn(async () => 12); const edit = vi.fn(async () => undefined);
  const runtime = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit });
  try {
    await runtime.runOnce();
    expect(progress.listBatches()[0]?.finished).toBe(true);
    jobs.resumeSource("mir-back", event.after);
    await runtime.runOnce();
    expect(edit.mock.calls.at(-1)?.[1]).toContain("повторный анализ");
    expect(progress.listBatches()[0]?.finished).toBe(false);
  } finally { await runtime.dispose(); jobs.close(); progress.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("never resends an ambiguously accepted progress card across restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-progress-"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  progress.trackBatch([{ projectPath: "group/mir-back", after: "a".repeat(40) }], { chatId: -1001, messageThreadId: 7 });
  const send = vi.fn().mockRejectedValue(new Error("response lost"));
  const runtime = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit: vi.fn() });
  try {
    await runtime.runOnce(); await runtime.runOnce();
    await runtime.dispose(); progress.recoverMessages();
    const restarted = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit: vi.fn() });
    await restarted.runOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(progress.listBatches()[0]?.sendState).toBe("unknown");
    await restarted.dispose();
  } finally { await runtime.dispose(); jobs.close(); progress.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("retains a known Telegram acknowledgement while retrying local persistence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-progress-"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  progress.trackBatch([{ projectPath: "group/mir-back", after: "a".repeat(40) }], { chatId: -1001, messageThreadId: 7 });
  const send = vi.fn(async () => 12); const edit = vi.fn(async () => undefined);
  vi.spyOn(progress, "markMessage").mockImplementationOnce(() => { throw new Error("disk busy"); });
  const runtime = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit });
  try {
    await runtime.runOnce(); await runtime.runOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]?.[0].messageId).toBe(12);
    expect(progress.listBatches()[0]?.messageId).toBe(12);
  } finally { await runtime.dispose(); jobs.close(); progress.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("retries a failed Telegram edit without sending another card", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-progress-"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  const event = { projectPath: "group/mir-back", after: "a".repeat(40) };
  progress.trackBatch([event], { chatId: -1001, messageThreadId: 7 });
  const send = vi.fn(async () => 12); const edit = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(undefined);
  const runtime = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit });
  try {
    await runtime.runOnce();
    progress.markRange(event, { phase: "failed" });
    await runtime.runOnce();
    await runtime.runOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0]?.[1]).toContain("повтор");
  } finally { await runtime.dispose(); jobs.close(); progress.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps a maximum-size batch message within Telegram's limit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-progress-"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  const events = Array.from({ length: 30 }, (_, index) => ({ projectPath: `group/${"p".repeat(90)}${index}`,
    after: (index + 1).toString(16).padStart(40, "0") }));
  progress.trackBatch(events, { chatId: -1001, messageThreadId: 7 });
  const send = vi.fn(async () => 12);
  const runtime = new ReviewPipelineProgressRuntime({ progress, jobs, send, edit: vi.fn(),
    sessionId: () => "01a144a8-f9be-7962-ae96-5e6af46f906a" });
  try {
    await runtime.runOnce();
    expect(send).toHaveBeenCalledOnce();
    const html = send.mock.calls[0]?.[1] as string;
    expect(html.length).toBeLessThanOrEqual(4096);
    expect((html.match(/<b>/g) ?? []).length).toBe((html.match(/<\/b>/g) ?? []).length);
    expect((html.match(/<code>/g) ?? []).length).toBe(31);
  } finally { await runtime.dispose(); jobs.close(); progress.close(); rmSync(dir, { recursive: true, force: true }); }
});
