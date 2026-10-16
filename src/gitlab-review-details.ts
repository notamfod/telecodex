import type { Finding } from "./recipes.js";

export interface GitlabReviewDetailItem {
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly file: string;
  readonly line?: number;
  readonly description: string;
}

export interface GitlabReviewDetails {
  readonly baseSha: string;
  readonly headSha: string;
  readonly items: readonly GitlabReviewDetailItem[];
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PRIORITIES = { critical: "P0", high: "P1", medium: "P2", low: "P3" } as const;

export function reviewDetails(
  baseSha: string | undefined,
  headSha: string,
  findings: readonly Finding[],
): GitlabReviewDetails | undefined {
  if (!baseSha || !SHA.test(baseSha) || !SHA.test(headSha)) return undefined;
  const items = findings.map((finding): GitlabReviewDetailItem => ({
    priority: finding.priority ?? PRIORITIES[finding.severity],
    file: boundedLine(finding.file, 200),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    description: boundedLine(finding.description, 220),
  })).sort((left, right) => left.priority.localeCompare(right.priority)).slice(0, 10);
  const details = { baseSha, headSha, items };
  return isValidGitlabReviewDetails(details) ? details : undefined;
}

export function isValidGitlabReviewDetails(value: unknown): value is GitlabReviewDetails {
  if (!record(value) || Object.keys(value).length !== 3
    || typeof value.baseSha !== "string" || !SHA.test(value.baseSha)
    || typeof value.headSha !== "string" || !SHA.test(value.headSha)
    || !Array.isArray(value.items) || value.items.length > 10) return false;
  return value.items.every((item: unknown) => record(item)
    && Object.keys(item).every((key) => ["priority", "file", "line", "description"].includes(key))
    && typeof item.priority === "string" && /^P[0-3]$/.test(item.priority)
    && typeof item.file === "string" && item.file.length > 0 && boundedLine(item.file, 200) === item.file
    && typeof item.description === "string" && item.description.length > 0
    && boundedLine(item.description, 220) === item.description
    && (item.line === undefined || Number.isSafeInteger(item.line) && Number(item.line) > 0));
}

function boundedLine(value: string, maximum: number): string {
  return [...value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, maximum).join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
