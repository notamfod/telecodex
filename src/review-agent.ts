import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { enrichFindingMetadata, keepSafeReviewFindings } from "./review-metadata.js";
import type { ReviewChunkInput } from "./review-portfolio.js";
import { MAX_FINDINGS, parseFindings, type Finding } from "./recipes.js";

const CODEX_TIMEOUT_MS = 20 * 60 * 1000;
const exec = promisify(execFile);

export function codexStdio(): ["pipe", "ignore", "ignore"] {
  return ["pipe", "ignore", "ignore"];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function displayPath(value: string): string {
  return /[\r\n]/.test(value) ? JSON.stringify(value) : value;
}

export function buildReviewChunkPrompt(template: string, input: ReviewChunkInput): string {
  const files = input.files.map((file) => `- ${displayPath(file)}`).join("\n");
  const diffCommand = [
    "git diff",
    `${input.baseSha}..${input.headSha}`,
    "--",
    ...input.files.map(shellQuote),
  ].join(" ");
  return [
    template
      .replaceAll("{{PROJECT}}", input.project.name)
      .replaceAll("{{CWD}}", input.project.worktreePath),
    "",
    "## Данные запуска",
    `Проект: ${input.project.name}`,
    `Диапазон: ${input.baseSha}..${input.headSha}`,
    `Файлы, часть ${input.chunkIndex + 1} из ${input.totalChunks}:`,
    files,
    "",
    "Прочитай точный дифф только этого диапазона и списка файлов:",
    diffCommand,
  ].join("\n");
}

export function changedLineMapFromDiff(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
      if (!changed.has(file)) changed.set(file, new Set());
      continue;
    }
    if (!file || !line.startsWith("@@ ")) continue;
    const hunk = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let number = start; number < start + count; number += 1) {
      changed.get(file)?.add(number);
    }
  }
  return changed;
}

export function keepFindingsOnChangedLines(
  findings: Finding[],
  changedLines: Map<string, Set<number>>,
): Finding[] {
  return findings.filter((finding) =>
    finding.line === undefined || changedLines.get(finding.file)?.has(finding.line) === true
  );
}

export function parseStrictReviewOutput(output: string): Finding[] {
  if (output.trim() === "NO_FINDINGS") return [];
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const findings = parseFindings(output);
  if (
    lines.length === 0
    || lines.length > MAX_FINDINGS
    || lines.some((line) => !line.startsWith("FINDING|"))
    || findings.length !== lines.length
  ) {
    throw new Error("invalid review output: expected only valid FINDING lines or NO_FINDINGS");
  }
  return findings;
}

async function exactDiff(input: ReviewChunkInput): Promise<string> {
  const { stdout } = await exec("git", [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=0",
    `${input.baseSha}..${input.headSha}`,
    "--",
    ...input.files,
  ], {
    cwd: input.project.worktreePath,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

export function runCodexReadOnly(
  cwd: string,
  model: string | undefined,
  prompt: string,
  outputFile: string,
): Promise<void> {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "-s",
    "read-only",
    "-o",
    outputFile,
  ];
  if (model) args.push("-m", model);
  args.push("-");

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: codexStdio() });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex exec exceeded ${CODEX_TIMEOUT_MS / 60000} minutes`));
    }, CODEX_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`codex exec exited with ${code}`));
    });
    child.stdin.end(prompt);
  });
}

export async function reviewPortfolioChunk(
  template: string,
  model: string | undefined,
  outputRoot: string,
  input: ReviewChunkInput,
): Promise<Finding[]> {
  await mkdir(outputRoot, { recursive: true });
  const outputFile = path.join(
    outputRoot,
    `${input.project.name}-${input.chunkIndex}-${randomUUID()}.txt`,
  );
  await runCodexReadOnly(
    input.project.worktreePath,
    model,
    buildReviewChunkPrompt(template, input),
    outputFile,
  );

  const parsed = parseStrictReviewOutput(await readFile(outputFile, "utf8"));
  const safe = keepSafeReviewFindings(parsed, input.project.worktreePath, input.files);
  if (safe.length !== parsed.length) {
    throw new Error("invalid review output: finding path is unsafe or outside the reviewed chunk");
  }
  const changed = keepFindingsOnChangedLines(
    safe,
    changedLineMapFromDiff(await exactDiff(input)),
  );
  if (changed.length !== safe.length) {
    throw new Error("invalid review output: finding line is outside the reviewed diff");
  }
  return Promise.all(changed.map((finding) => enrichFindingMetadata(finding, {
    worktreePath: input.project.worktreePath,
    baseSha: input.baseSha,
    headSha: input.headSha,
  })));
}
