import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ReviewPipelineJournalRuntime } from "../src/review-pipeline-journal.js";
import { ReviewPipelineJournalStore } from "../src/review-pipeline-journal-store.js";
import { ReviewPipelineProgressStore } from "../src/review-pipeline-progress-store.js";
import { ReviewPipelineStore } from "../src/review-pipeline-store.js";

const threadId = "01a144a8-f9be-7962-ae96-5e6af46f906a";
function setup(projectPath = "group/mir-back") {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-journal-"));
  const journal = new ReviewPipelineJournalStore(path.join(dir, "journal.sqlite"));
  const progress = new ReviewPipelineProgressStore(path.join(dir, "progress.sqlite"));
  const jobs = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  const event = { projectPath, after: "a".repeat(40) };
  const batch = progress.trackBatch([event], { chatId: -1001, messageThreadId: 7 });
  const client = {
    create: vi.fn(async (_title, _cwd, _model, onCreated) => { onCreated?.(threadId); return threadId; }),
    inspect: vi.fn(async () => ({ busy: false, markers: [] as string[] })),
    append: vi.fn(async (_id, _cwd, _model, _key, _text, onWritten) => { onWritten(); }),
    dispose: vi.fn(async () => undefined),
  };
  const options = { journal, progress, jobs, client, cwd: "/repos", model: "light-model" };
  return { ...options, options, event, batch, close: () => { journal.close(); progress.close(); jobs.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("creates one named Codex journal for a scheduled batch with two findings", async () => {
  const f = setup("recipes/daily-diff-review/mir-back"); const runtime = new ReviewPipelineJournalRuntime(f.options);
  try {
    const findings = ["race", "cancellation"].map((category) => ({ severity: "medium" as const, file: "x.php", category, description: category }));
    for (const finding of findings) f.jobs.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: f.event.after, finding });
    f.progress.markRange(f.event, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repo", status: "reviewed", headSha: f.event.after, findings } });
    await runtime.runOnce(); await runtime.runOnce();
    expect(f.client.create).toHaveBeenCalledOnce();
    expect(f.client.create.mock.calls[0]?.[0]).toContain("плановая проверка");
    expect(f.client.append.mock.calls.map((call) => call[4]).join("\n")).toContain("cancellation");
  } finally { await runtime.dispose(); f.close(); }
});

it("retains one batch session across restarts and records both independent agent reports", async () => {
  const f = setup(); const runtime = new ReviewPipelineJournalRuntime(f.options);
  try {
    const job = f.jobs.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: f.event.after,
      finding: { severity: "medium", file: "x.php", category: "race", description: "late reply" } });
    f.progress.markRange(f.event, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repo", status: "reviewed",
      headSha: f.event.after, findings: [job.source.finding] } });
    await runtime.runOnce();
    expect(f.client.create).toHaveBeenCalledOnce();
    expect(runtime.threadId(f.batch.id)).toBe(threadId);
    runtime.recordPhase({ ...job, round: 1 }, "analyst");
    runtime.recordReport({ ...job, round: 1 }, "analyst", { verdict: "uncertain", reason: "Need caller", evidence: [] });
    runtime.recordReport({ ...job, round: 1 }, "verifier", { verdict: "disproved", reason: "Caller cancels", evidence: ["x.php:2"] });
    await runtime.runOnce();
    await runtime.dispose();
    const restarted = new ReviewPipelineJournalRuntime(f.options);
    await restarted.runOnce();
    expect(f.client.create).toHaveBeenCalledOnce();
    const text = f.client.append.mock.calls.map((call) => call[4]).join("\n");
    expect(text).toContain("Need caller"); expect(text).toContain("Caller cancels");
    expect(text).toContain("Аналитик"); expect(text).toContain("Проверяющий");
    await restarted.dispose();
  } finally { await runtime.dispose(); f.close(); }
});

it("reconciles an accepted journal turn after a lost response without resending", async () => {
  const f = setup(); let acceptedKey = "";
  f.client.append.mockImplementationOnce(async (_id, _cwd, _model, key, _text, onWritten) => {
    onWritten(); acceptedKey = key; throw new Error("response lost");
  });
  const runtime = new ReviewPipelineJournalRuntime(f.options);
  try {
    await runtime.runOnce();
    f.client.inspect.mockResolvedValue({ busy: false, markers: [acceptedKey] });
    await runtime.runOnce();
    expect(f.client.append).toHaveBeenCalledOnce();
    expect(f.journal.sessions()[0]?.pending).toBeUndefined();
  } finally { await runtime.dispose(); f.close(); }
});

it("preserves a written but unconfirmed turn and waits while the user is active", async () => {
  const f = setup(); const runtime = new ReviewPipelineJournalRuntime(f.options);
  f.client.inspect.mockResolvedValue({ busy: true, markers: [] });
  try {
    await runtime.runOnce();
    expect(f.client.append).not.toHaveBeenCalled();
    f.client.inspect.mockResolvedValue({ busy: false, markers: [] });
    f.client.append.mockImplementation(async (_id, _cwd, _model, _key, _text, onWritten) => {
      onWritten(); throw new Error("unknown result");
    });
    await runtime.runOnce(); await runtime.runOnce();
    expect(f.client.append).toHaveBeenCalledOnce();
    expect(f.journal.sessions()[0]?.pending?.state).toBe("written");
  } finally { await runtime.dispose(); f.close(); }
});

it("backfills saved reports and retries a journal request that definitely was never sent", async () => {
  const f = setup(); const runtime = new ReviewPipelineJournalRuntime(f.options);
  const job = f.jobs.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: f.event.after,
    finding: { severity: "medium", file: "x.php", category: "race", description: "late reply" } });
  f.jobs.claim();
  const report = { verdict: "disproved" as const, reason: "Existing source guard", evidence: ["x.php:2"] };
  f.jobs.finishRound(job.id, report, report);
  f.progress.markRange(f.event, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repo", status: "reviewed",
    headSha: f.event.after, findings: [job.source.finding] } });
  f.client.append.mockImplementationOnce(async (_id, _cwd, _model, _key, _text, onWritten) => {
    onWritten(); throw Object.assign(new Error("not sent"), { code: "APP_SERVER_NOT_SENT" });
  });
  try {
    await runtime.runOnce();
    expect(f.journal.sessions()[0]?.pending?.state).toBe("prepared");
    await runtime.runOnce();
    expect(f.client.append).toHaveBeenCalledTimes(2);
    const text = f.client.append.mock.calls[1]?.[4];
    expect(text).toContain("Existing source guard");
    expect(text).toContain("Сохранённый отчёт аналитика");
    expect(text).toContain("Сохранённый отчёт проверяющего");
    expect(f.journal.sessions()[0]?.pending).toBeUndefined();
  } finally { await runtime.dispose(); f.close(); }
});

it("keeps reports out of a different change range sharing the same head", async () => {
  const f = setup(); const runtime = new ReviewPipelineJournalRuntime(f.options);
  const secondEvent = { ...f.event, before: "b".repeat(40) };
  const secondBatch = f.progress.trackBatch([secondEvent], { chatId: -1001, messageThreadId: 7 });
  const job = f.jobs.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: f.event.after,
    finding: { severity: "medium", file: "x.php", category: "race", description: "late reply" } });
  f.progress.markRange(f.event, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repo", status: "reviewed", headSha: f.event.after, findings: [job.source.finding] } });
  f.progress.markRange(secondEvent, { phase: "reviewed", result: { name: "mir-back", sourcePath: "/repo", status: "reviewed", headSha: f.event.after, findings: [] } });
  try {
    runtime.recordReport(job, "analyst", { verdict: "uncertain", reason: "Only first range", evidence: [] });
    expect(f.journal.pendingEvents(f.batch.id).map((event) => event.text).join("\n")).toContain("Only first range");
    expect(f.journal.sessions().some((session) => session.batchId === secondBatch.id)).toBe(false);
  } finally { await runtime.dispose(); f.close(); }
});
