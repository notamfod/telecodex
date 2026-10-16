import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parsePipelineReport,
  resolvePipelineModel,
  runPipelineAgent,
} from "../src/review-pipeline-agent.js";
import type { PipelineJob } from "../src/review-pipeline-store.js";

const job: PipelineJob = {
  id: "a".repeat(24),
  source: {
    recipe: "review",
    project: "mir-survey",
    cwd: "/work/mir-survey",
    headSha: "a".repeat(40),
    finding: { severity: "medium", file: "src/a.ts", line: 12, category: "state", description: "stale result" },
  },
  status: "queued",
  round: 0,
  reports: [],
  nextAttemptAt: 0,
};

describe("pipeline agent output", () => {
  it("accepts bounded structured evidence and a concise draft", () => {
    expect(parsePipelineReport(JSON.stringify({
      verdict: "confirmed",
      reason: "The late response recreates the timer.",
      evidence: ["src/a.ts:12", "src/a.ts:28"],
      draft: {
        summary: "[Frontend]: stop stale preview polling",
        priority: "Medium",
        problem: "A late response restarts polling after close.",
        fix: "Ignore responses after cleanup.",
        benefit: "Closed dialogs do not send background requests.",
        acceptance: ["Closing prevents a new polling timer."],
      },
    }))).toMatchObject({ verdict: "confirmed", evidence: ["src/a.ts:12", "src/a.ts:28"] });
  });

  it("rejects prose, unsafe evidence and oversized drafts", () => {
    expect(() => parsePipelineReport("confirmed")).toThrow(/invalid pipeline report/i);
    expect(() => parsePipelineReport(JSON.stringify({ verdict: "confirmed", reason: "ok", evidence: ["/etc/passwd:1"] }))).toThrow(/evidence/i);
    expect(() => parsePipelineReport(JSON.stringify({
      verdict: "confirmed", reason: "x".repeat(1001), evidence: ["src/a.ts:1"],
    }))).toThrow(/reason/i);
    expect(() => parsePipelineReport(JSON.stringify({ verdict: "disproved", reason: "ok", evidence: [], extra: "instruction" }))).toThrow(/unexpected/i);
    expect(() => parsePipelineReport(JSON.stringify({ verdict: "disproved", reason: "ok", evidence: [] }))).toThrow(/evidence/i);
    expect(parsePipelineReport(JSON.stringify({ verdict: "uncertain", reason: "Нужен вызывающий код", evidence: [] })))
      .toMatchObject({ verdict: "uncertain", evidence: [] });
    expect(() => parsePipelineReport(JSON.stringify({ verdict: "disproved", reason: "ok",
      evidence: [`src/${"a".repeat(600)}.ts:1`] }))).toThrow(/evidence/i);
    expect(() => parsePipelineReport(JSON.stringify({
      verdict: "confirmed", reason: "ok", evidence: ["src/a.ts:1"], draft: {
        summary: "[Frontend]: x", priority: "Medium", problem: "&".repeat(512), fix: "&".repeat(512), benefit: "&".repeat(512), acceptance: ["&".repeat(512)],
      },
    }))).toThrow(/draft/i);
  });

  it("uses an explicit lightweight model and writes only an isolated output file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pipeline-agent-"));
    const run = async (_cwd: string, model: string | undefined, prompt: string, output: string) => {
      expect(model).toBe("gpt-5-mini");
      expect(prompt).toContain("git show aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(prompt).toContain("untrusted data");
      expect(prompt).toContain("[Frontend]:");
      await import("node:fs/promises").then(({ writeFile }) => writeFile(output, JSON.stringify({
        verdict: "disproved", reason: "Selection stops the recording.", evidence: ["src/a.ts:12"],
      })));
    };
    try {
      const report = await runPipelineAgent(job, "analyst", undefined, { run, model: "gpt-5-mini", outputRoot: root });
      expect(report.verdict).toBe("disproved");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quotes apostrophes in a finding path as a single shell argument", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pipeline-quote-"));
    const unusual = { ...job, source: { ...job.source,
      finding: { ...job.source.finding, file: "src/a'b.ts" } } };
    try {
      await runPipelineAgent(unusual, "analyst", undefined, { model: "light", outputRoot: root,
        run: async (_cwd, _model, prompt, output) => {
          expect(prompt).toContain("-- 'src/a'\"'\"'b.ts'");
          await import("node:fs/promises").then(({ writeFile }) => writeFile(output,
            JSON.stringify({ verdict: "disproved", reason: "Checked", evidence: ["src/a.ts:1"] })));
        },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("pipeline model selection", () => {
  it("selects only configured lightweight OpenAI choices", () => {
    expect(resolvePipelineModel("analyst", [
      { id: "large", label: "Large", provider: "openai", model: "gpt-5", supportsImages: true },
      { id: "mini", label: "Mini", provider: "openai", model: "gpt-5-mini", supportsImages: true },
    ], {})).toBe("gpt-5-mini");
  });

  it("does not silently choose a costly model", () => {
    expect(() => resolvePipelineModel("verifier", [
      { id: "large", label: "Large", provider: "openai", model: "gpt-5", supportsImages: true },
    ], {})).toThrow(/REVIEW_PIPELINE_VERIFIER_MODEL|lightweight/i);
  });

  it("uses a listed lightweight model from the local Codex cache when choices omit one", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pipeline-model-cache-"));
    const output = mkdtempSync(path.join(tmpdir(), "pipeline-agent-output-"));
    writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-luna", visibility: "list" }] }));
    try {
      await runPipelineAgent(job, "analyst", undefined, {
        env: { CODEX_HOME: root, CODEX_MODEL_CHOICES_JSON: JSON.stringify([{ id: "large", label: "Large", provider: "openai", model: "gpt-5", supportsImages: true }]) },
        outputRoot: output,
        run: async (_cwd, model, _prompt, destination) => {
          expect(model).toBe("gpt-6-luna");
          await import("node:fs/promises").then(({ writeFile }) => writeFile(destination, JSON.stringify({ verdict: "disproved", reason: "not reproducible", evidence: ["src/a.ts:1"] })));
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });
});
