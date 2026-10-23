import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ReviewPipelineStore } from "../src/review-pipeline-store.js";
import { ReviewPipelineActions } from "../src/review-pipeline-actions.js";
import { JiraIssueCreateUnknownError } from "../src/jira-issue-create.js";

it("keeps legacy unclassified cards awaiting review without touching Jira", async () => {
  const legacy = { id: "a".repeat(24), status: "awaiting", chatId: -1001, topicId: 7, messageId: 10, reports: [] };
  const store = { get: vi.fn(() => legacy), claimDecision: vi.fn() } as unknown as ReviewPipelineStore;
  const jira = { findByLabel: vi.fn(), create: vi.fn() };
  const actions = new ReviewPipelineActions({ store, jira, openAnalysis: vi.fn() });
  expect(await actions.decide(legacy.id, "create", { chatId: -1001, topicId: 7, messageId: 10 }))
    .toMatchObject({ outcome: "needs_review" });
  expect(store.claimDecision).not.toHaveBeenCalled();
  expect(jira.findByLabel).not.toHaveBeenCalled();
  expect(jira.create).not.toHaveBeenCalled();
});

it("never repeats an ambiguous Jira POST; later clicks reconcile the saved label", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tc-actions-"));
  const store = new ReviewPipelineStore(path.join(directory, "db.sqlite"));
  try {
    const job = store.enqueue({ recipe: "daily", project: "mir-back", cwd: "/repo", headSha: "a".repeat(40),
      finding: { severity: "medium", file: "x.ts", category: "race", description: "race" } });
    store.claim();
    const report = { verdict: "confirmed" as const, assessment: { component: "Backend", labels: ["поиск"], kind: "bug" as const, basis: "Cancellation contract is violated.", trigger: "Cancel an active request.", expected: "Work stops.", actual: "Work continues." }, reason: "late answer", evidence: ["x.ts:1"], draft: {
      summary: "[Backend]: Прекращать опрос", priority: "Medium" as const, problem: "Опрос продолжается",
      fix: "Проверить активность", benefit: "Нет фоновых запросов", acceptance: ["Запросы прекращаются"],
    } };
    store.finishRound(job.id, report, report);
    store.markDelivered(job.id, -1001, 7, 10);
    const jira = { findByLabel: vi.fn().mockRejectedValueOnce(new Error("lookup unavailable"))
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockResolvedValue({ key: "MIR-123", url: "https://jira.example/browse/MIR-123" }),
    create: vi.fn().mockRejectedValue(new JiraIssueCreateUnknownError()) };
    const openAnalysis = vi.fn(async () => 11);
    const actions = new ReviewPipelineActions({ store, jira, openAnalysis });
    const target = { chatId: -1001, topicId: 7, messageId: 10 };
    expect(await actions.decide(job.id, "create", target)).toMatchObject({ outcome: "unknown" });
    expect(store.get(job.id)?.status).toBe("awaiting");
    expect(jira.create).not.toHaveBeenCalled();
    expect(await actions.decide(job.id, "create", target)).toMatchObject({ outcome: "unknown" });
    expect(await actions.decide(job.id, "create", target)).toMatchObject({ outcome: "unknown" });
    expect(jira.create).toHaveBeenCalledOnce();
    expect(await actions.decide(job.id, "create", target)).toMatchObject({ outcome: "created" });
    expect(store.get(job.id)?.issueKey).toBe("MIR-123");
    expect(await actions.decide(job.id, "continue", target)).toMatchObject({ outcome: "created" });
    expect(openAnalysis).not.toHaveBeenCalled();

    const second = store.enqueue({ ...job.source, finding: { ...job.source.finding, category: "persistence" } });
    store.claim(); store.finishRound(second.id, report, report); store.markDelivered(second.id, -1001, 7, 11);
    const acceptedJira = { findByLabel: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ key: "MIR-124", url: "https://jira.example/browse/MIR-124" })) };
    const secondActions = new ReviewPipelineActions({ store, jira: acceptedJira, openAnalysis });
    const persist = vi.spyOn(store, "created").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    await expect(secondActions.decide(second.id, "create", { ...target, messageId: 11 })).rejects.toThrow("disk unavailable");
    expect(store.get(second.id)?.status).toBe("creating");
    expect(await secondActions.decide(second.id, "create", { ...target, messageId: 11 })).toMatchObject({ outcome: "unknown" });
    expect(acceptedJira.create).toHaveBeenCalledOnce();
    persist.mockRestore();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
