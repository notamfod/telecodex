import { describe, expect, it } from "vitest";

import { pipelineDraftKeyboard, pipelineDraftSummary, pipelineDraftText, renderPipelineAnalysisPrompt, renderPipelineDraft } from "../src/review-pipeline-render.js";
import type { PipelineAssessment, PipelineJob } from "../src/review-pipeline-store.js";

const job: PipelineJob = {
  id: "a".repeat(24),
  source: { recipe: "review", project: "mir-survey", cwd: "/work", headSha: "b".repeat(40), finding: { severity: "high", file: "src/<bad>.ts", line: 7, category: "xss", description: "<b>unsafe</b>" } },
  status: "awaiting",
  round: 1,
  reports: [{ verdict: "confirmed", reason: "Late response survives cleanup.", evidence: ["src/a.ts:7"] }],
  draft: { summary: "[Frontend]: stop stale polling", priority: "Medium", problem: "<unsafe>", fix: "Cancel the stale callback.", benefit: "No hidden traffic.", acceptance: ["Close prevents new requests."] },
  nextAttemptAt: 0,
};

it("renders a safe compact Telegram draft and callback buttons", () => {
  const html = renderPipelineDraft(job);
  expect(html).toContain("&lt;unsafe&gt;");
  expect(html).not.toContain("<unsafe>");
  expect(html.length).toBeLessThanOrEqual(4096);
  expect(pipelineDraftKeyboard(job.id, true)).toEqual({ inline_keyboard: [[{ text: "Да, создать", callback_data: `rpcreate:${job.id}` }], [{ text: "Нет, продолжить анализ", callback_data: `rpcontinue:${job.id}` }]] });
  expect(pipelineDraftKeyboard(job.id).inline_keyboard).toEqual([[{ text: "Продолжить проверку", callback_data: `rpcontinue:${job.id}` }]]);
});

it("uses the same draft facts for Jira text and continued analysis", () => {
  const description = pipelineDraftText(job);
  expect(description).not.toContain(job.draft!.summary);
  expect(description).not.toContain("Приоритет:");
  expect(description.split("\n")[0]).toBe(job.draft!.problem);
  expect(description).toContain(`Как исправить: ${job.draft!.fix}`);
  expect(description).toContain(`Зачем: ${job.draft!.benefit}`);
  const prompt = renderPipelineAnalysisPrompt(job);
  expect(prompt).toContain(job.source.headSha);
  expect(prompt).toContain("Late response survives cleanup.");
  expect(prompt).toContain("только для чтения");
});

function assessed(project: string, component: string, kind: PipelineAssessment["kind"] = "bug"): PipelineJob {
  const assessment: PipelineAssessment = { component, labels: ["Фасеты", "акции"], kind, basis: "The request survives cleanup.",
    trigger: "Close a dialog during a request.", expected: "Polling stops.", actual: "Polling resumes." };
  const report = { ...job.reports[0]!, draft: job.draft, assessment };
  return { ...job, source: { ...job.source, project }, reports: [report, report] };
}

it.each([
  ["mir-catalog-go", "Backend"],
  ["mir-mcp", "Backend"],
  ["mir-survey", "Frontend"],
  ["mir-survey", "Backend"],
])("renders repository %s and independently reviewed component %s", (project, component) => {
  const input = assessed(project, component);
  expect(pipelineDraftText(input)).toContain(`Проект: ${project}\nКомпонент: ${component}\nМетки: review, Фасеты, акции\nТип: Ошибка`);
  expect(renderPipelineDraft(input)).toContain(`<b>Проект:</b> ${project}\n<b>Компонент:</b> ${component}`);
  expect(pipelineDraftSummary(input)).toBe(`[${component}]: stop stale polling`);
});

it("shows improvements as tasks rather than bugs", () => {
  expect(pipelineDraftText(assessed("mir-mcp", "Backend", "improvement"))).toContain("Тип: Улучшение (задача)");
});

it("preserves and escapes the project while leaving legacy classification unconfirmed", () => {
  const input = { ...job, source: { ...job.source, project: "<custom>" } };
  expect(pipelineDraftText(input)).toContain("Проект: <custom>\nКомпонент: требует проверки\nМетки: требует проверки\nТип: требует проверки");
  expect(renderPipelineDraft(input)).toContain("<b>Проект:</b> &lt;custom&gt;\n<b>Компонент:</b> требует проверки");
  expect(pipelineDraftSummary(input)).toBe("stop stale polling");
});

it("renders a rechecked inconclusive card without an obsolete task proposal", () => {
  const input: PipelineJob = { ...job, status: "needs_context", draft: undefined,
    reports: [{ verdict: "uncertain", reason: "Caller is missing.", evidence: [] }] };
  expect(renderPipelineDraft(input)).toContain("Нужна дополнительная проверка");
  expect(renderPipelineDraft(input)).toContain("Caller is missing.");
  expect(renderPipelineDraft(input)).not.toContain("stop stale polling");
});


it("renders functional Jira labels separately from the component", () => {
  const input = assessed("mir-catalog-go", "Backend");
  expect(renderPipelineDraft(input)).toContain("<b>Метки:</b> review, Фасеты, акции");
  expect(pipelineDraftText(input)).toContain("Метки: review, Фасеты, акции");
});

it("explicitly explains when Jira has no suitable functional label", () => {
  const input = assessed("mir-mcp", "Backend");
  input.reports = input.reports.map(report => ({ ...report, assessment: {
    ...report.assessment!, labels: [], labelsReason: "Для жизненного цикла MCP-сервера подходящей метки нет.",
  } }));
  expect(renderPipelineDraft(input)).toContain("Метки:</b> review; функциональная метка не найдена");
  expect(renderPipelineDraft(input)).toContain("жизненного цикла MCP-сервера");
  expect(renderPipelineDraft(input)).toContain("Тип:</b> Ошибка");
});
