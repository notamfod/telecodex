import { escapeHTML } from "./format.js";
import { renderFindingHTML, type Finding } from "./recipes.js";

export const RECIPE_DIGEST_PAGE_SIZE = 5;
const TELEGRAM_MESSAGE_LIMIT = 4096;

const SEVERITY_MARK: Record<Finding["severity"], string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪️",
};

export interface RecipeDigestButton {
  text: string;
  callback_data: string;
}

export interface RecipeDigestKeyboard {
  [key: string]: unknown;
  inline_keyboard: RecipeDigestButton[][];
}

interface RecipeDigestInput {
  project: string;
  findings: Finding[];
  page: number;
  repeatedCount?: number;
  suppressedCount?: number;
}

function pageCount(findings: Finding[]): number {
  return Math.max(1, Math.ceil(findings.length / RECIPE_DIGEST_PAGE_SIZE));
}

function boundedPage(findings: Finding[], page: number): number {
  return Math.min(Math.max(0, page), pageCount(findings) - 1);
}

function pageSlice(findings: Finding[], page: number): Array<{ finding: Finding; index: number }> {
  const current = boundedPage(findings, page);
  const start = current * RECIPE_DIGEST_PAGE_SIZE;
  return findings
    .slice(start, start + RECIPE_DIGEST_PAGE_SIZE)
    .map((finding, offset) => ({ finding, index: start + offset }));
}

function prioritySummary(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const label = finding.priority ?? finding.severity;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label}: ${count}`).join(" · ");
}

function boundedEscaped(text: string, limit: number): string {
  const escaped = escapeHTML(text);
  if (escaped.length <= limit) {
    return escaped;
  }
  let result = "";
  for (const character of text) {
    const next = escapeHTML(character);
    if (result.length + next.length + 1 > limit) {
      break;
    }
    result += next;
  }
  return `${result}…`;
}

function renderCompactFindingHTML(finding: Finding): string {
  const location = finding.line === undefined
    ? finding.file
    : `${finding.file}:${finding.line}`;
  const label = finding.priority && finding.aspect
    ? `[${finding.priority}][${finding.aspect}]`
    : finding.severity;
  const lines = [
    `${SEVERITY_MARK[finding.severity]} <b>${boundedEscaped(label, 40)}</b> · <code>${boundedEscaped(location, 110)}</code> · ${boundedEscaped(finding.category, 50)}`,
    boundedEscaped(finding.description, 160),
  ];
  if (finding.author) {
    lines.push(`Автор: ${boundedEscaped(finding.author, 60)}`);
  }
  if (finding.commitSha) {
    const shortSha = boundedEscaped(finding.commitSha.slice(0, 8), 16);
    const commitUrl = finding.commitUrl ? escapeHTML(finding.commitUrl) : undefined;
    lines.push(
      commitUrl && commitUrl.length <= 140
        ? `Коммит: <a href="${commitUrl}">${shortSha}</a>`
        : `Коммит: <code>${shortSha}</code>`,
    );
  }
  return lines.join("\n");
}

export function renderRecipeDigestHTML(input: RecipeDigestInput): string {
  const current = boundedPage(input.findings, input.page);
  const totalPages = pageCount(input.findings);
  const freshLabel = input.findings.length === 1 ? "1 новая" : `${input.findings.length} новых`;
  const header = [
    `🔍 <b>${boundedEscaped(input.project, 160)}</b>`,
    `<b>${freshLabel}</b> · ${escapeHTML(prioritySummary(input.findings))}`,
    `<i>Страница ${current + 1}/${totalPages}</i>`,
  ].join("\n");
  const slice = pageSlice(input.findings, current);
  const notes = [
    input.repeatedCount ? `повторы: ${input.repeatedCount}` : "",
    input.suppressedCount ? `заглушено: ${input.suppressedCount}` : "",
  ].filter(Boolean);
  const footer = notes.length > 0 ? `<i>${notes.join(" · ")}</i>` : "";
  const assemble = (compact: boolean): string => {
    const blocks = slice.map(({ finding, index }) =>
      `<b>${index + 1}.</b> ${compact ? renderCompactFindingHTML(finding) : renderFindingHTML(finding)}`
    );
    return [header, blocks.join("\n\n"), footer].filter(Boolean).join("\n\n");
  };
  const full = assemble(false);
  return full.length <= TELEGRAM_MESSAGE_LIMIT ? full : assemble(true);
}

export function recipeDigestKeyboard(
  runId: number,
  findings: Finding[],
  page: number,
): RecipeDigestKeyboard {
  const current = boundedPage(findings, page);
  const totalPages = pageCount(findings);
  const rows = pageSlice(findings, current).map(({ finding, index }) => [{
    text: `${index + 1} · ${finding.priority ?? finding.severity} · ${finding.category}`.slice(0, 60),
    callback_data: `rdetail:${runId}:${index}`,
  }]);
  if (totalPages > 1) {
    rows.push([
      ...(current > 0 ? [{ text: "←", callback_data: `rpage:${runId}:${current - 1}` }] : []),
      { text: `${current + 1}/${totalPages}`, callback_data: `rnoop:${runId}` },
      ...(current + 1 < totalPages
        ? [{ text: "→", callback_data: `rpage:${runId}:${current + 1}` }]
        : []),
    ]);
  }
  return { inline_keyboard: rows };
}

export function renderRecipeFindingDetailHTML(
  project: string,
  finding: Finding,
  index: number,
  total: number,
): string {
  const header = `🔍 <b>${boundedEscaped(project, 160)}</b> · <b>${index + 1} из ${total}</b>`;
  const full = [header, renderFindingHTML(finding)].join("\n\n");
  return full.length <= TELEGRAM_MESSAGE_LIMIT
    ? full
    : [header, renderCompactFindingHTML(finding)].join("\n\n");
}

export function recipeFindingDetailKeyboard(
  runId: number,
  index: number,
  muted = false,
): RecipeDigestKeyboard {
  const back = [{
    text: "← К списку",
    callback_data: `rpage:${runId}:${Math.floor(index / RECIPE_DIGEST_PAGE_SIZE)}`,
  }];
  return {
    inline_keyboard: muted ? [back] : [
      [
        { text: "🔧 Тред-фикс", callback_data: `rfix:${runId}:${index}` },
        { text: "🔇 Игнорировать", callback_data: `rmute:${runId}:${index}` },
      ],
      back,
    ],
  };
}
