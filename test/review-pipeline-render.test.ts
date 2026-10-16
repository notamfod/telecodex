import { describe, expect, it } from "vitest";

import { pipelineDraftKeyboard, pipelineDraftText, renderPipelineAnalysisPrompt, renderPipelineDraft } from "../src/review-pipeline-render.js";
import type { PipelineJob } from "../src/review-pipeline-store.js";

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
  expect(pipelineDraftKeyboard(job.id)).toEqual({ inline_keyboard: [[{ text: "Да, создать", callback_data: `rpcreate:${job.id}` }], [{ text: "Нет, продолжить анализ", callback_data: `rpcontinue:${job.id}` }]] });
});

it("uses the same draft facts for Jira text and continued analysis", () => {
  expect(pipelineDraftText(job)).toContain("stop stale polling");
  const prompt = renderPipelineAnalysisPrompt(job);
  expect(prompt).toContain(job.source.headSha);
  expect(prompt).toContain("Late response survives cleanup.");
  expect(prompt).toContain("только для чтения");
});
