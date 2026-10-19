import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ReviewPipelineStore, type PipelineReport } from "../src/review-pipeline-store.js";
import { ReviewPipelineRuntime } from "../src/review-pipeline-runtime.js";

it("does not call agents again after both report missing context", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-context-runtime-"));
  const store = new ReviewPipelineStore(path.join(dir, "jobs.sqlite"));
  let now = 1_000_000;
  const analyze = vi.fn(async () => ({ verdict: "uncertain" as const, reason: "Need backend code", evidence: ["x.ts:1"] }));
  const deliver = vi.fn();
  const runtime = new ReviewPipelineRuntime({ store, analyze, deliver, now: () => now, snapshot: async (job) => job });
  try {
    const job = store.enqueue({ recipe: "daily", project: "mir-admin", cwd: "/repo", headSha: "a".repeat(40),
      finding: { severity: "medium", file: "x.ts", category: "api", description: "Missing context" } });
    await runtime.runOnce(); now += 365 * 86_400_000; store.recover(); await runtime.runOnce();
    expect(analyze).toHaveBeenCalledTimes(2);expect(deliver).not.toHaveBeenCalled();
    expect(store.get(job.id)?.status).toBe("needs_context");
  } finally { await runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("reanalyses disagreements and delivers a concise proposal only after both agents confirm", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-pipeline-"));
  const store = new ReviewPipelineStore(path.join(dir, "store.sqlite"));
  const draft = { summary: "[Frontend]: Останавливать опрос", priority: "Medium" as const,
    problem: "Поздний ответ возобновляет опрос", fix: "Проверять активность окна", benefit: "Нет фоновых запросов",
    acceptance: ["Закрытое окно не делает запросов"] };
  const confirmed: PipelineReport = { verdict: "confirmed", reason: "Проверено", evidence: ["src/view.ts:10"], draft };
  let now = 1_000_000;
  const analyze = vi.fn().mockResolvedValueOnce(confirmed)
    .mockResolvedValueOnce({ verdict: "uncertain", reason: "Нужно проверить отмену", evidence: [] })
    .mockResolvedValue(confirmed);
  const deliver = vi.fn(async () => ({ chatId: -1001, topicId: 7, messageId: 10 }));
  const onPhase = vi.fn();
  const onReport = vi.fn().mockImplementationOnce(() => { throw new Error("journal unavailable"); });
  const runtime = new ReviewPipelineRuntime({ store, analyze, deliver, now: () => now,
    snapshot: async (job) => job, onPhase, onReport });
  try {
    const job = store.enqueue({ recipe: "daily", project: "mir-admin", cwd: "/repo", headSha: "a".repeat(40),
      finding: { severity: "medium", priority: "P2", file: "src/view.ts", line: 10,
        category: "polling", description: "Поздний ответ возобновляет опрос" } });
    await runtime.runOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.get(job.id)?.status).toBe("queued");
    now += 86_400_000;
    await runtime.runOnce();
    expect(analyze).toHaveBeenCalledTimes(4);
    expect(deliver).toHaveBeenCalledOnce();
    expect(onPhase.mock.calls.map(([, phase]) => phase)).toEqual(["analyst", "verifier", "analyst", "verifier"]);
    expect(onReport.mock.calls.map(([, role, report]) => [role, report.verdict])).toEqual([
      ["analyst", "confirmed"], ["verifier", "uncertain"], ["analyst", "confirmed"], ["verifier", "confirmed"],
    ]);
    expect(store.get(job.id)).toMatchObject({ status: "awaiting", messageId: 10 });
    await runtime.runOnce();
    expect(deliver).toHaveBeenCalledOnce();
  } finally { await runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
