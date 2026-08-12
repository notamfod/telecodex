import { escapeHTML } from "./format.js";

/**
 * Machine-readable review findings.
 *
 * Scheduled recipes ask the agent for `FINDING|severity|file:line|category|text`
 * lines so a run can be diffed against the previous one. Anything the agent says
 * around those lines is prose for a human and is dropped here.
 */

export type Severity = "critical" | "high" | "medium" | "low";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** One noisy run must not flood the topic; the prompt asks for this many too. */
export const MAX_FINDINGS = 10;

const FINDING_PREFIX = "FINDING|";
const NO_FINDINGS = "NO_FINDINGS";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_DESCRIPTION_LENGTH = 220;

export interface Finding {
  severity: Severity;
  file: string;
  line?: number;
  category: string;
  description: string;
}

function toSeverity(raw: string): Severity {
  const value = raw.trim().toLowerCase();
  return value in SEVERITY_RANK ? (value as Severity) : "medium";
}

function splitLocation(raw: string): { file: string; line?: number } {
  const match = /^(.*):(\d+)$/.exec(raw.trim());
  if (!match) {
    return { file: raw.trim() };
  }
  return { file: match[1], line: Number(match[2]) };
}

function parseFinding(raw: string): Finding | undefined {
  const line = raw.trim();
  if (!line.startsWith(FINDING_PREFIX)) {
    return undefined;
  }

  const parts = line.slice(FINDING_PREFIX.length).split("|");
  if (parts.length < 4) {
    return undefined;
  }

  // The description is last and may itself contain the delimiter.
  const description = parts.slice(3).join("|").trim();
  const category = parts[2].trim();
  if (!description || !category) {
    return undefined;
  }

  return {
    severity: toSeverity(parts[0]),
    ...splitLocation(parts[1]),
    category,
    description,
  };
}

export function parseFindings(output: string): Finding[] {
  if (output.trim() === NO_FINDINGS) {
    return [];
  }

  const findings = output
    .split("\n")
    .map(parseFinding)
    .filter((finding): finding is Finding => finding !== undefined);

  // Array#sort is stable, so same-severity findings keep the agent's own order.
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return findings.slice(0, MAX_FINDINGS);
}

/**
 * A stable key for "the same finding as last time".
 *
 * Line numbers are excluded because unrelated edits above shift them, and digits
 * inside the description are flattened because the agent tends to restate the
 * line number there.
 *
 * ponytail: this also merges findings that differ only by a number ("timeout 30"
 * vs "timeout 300"); hash the raw description if that ever loses a real finding.
 */
export function fingerprintFinding(finding: Finding): string {
  const description = finding.description
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
  return `${finding.file}|${finding.category}|${description}`;
}

/**
 * Drops findings that name a file the checkout does not have.
 *
 * Every prompt carries few-shot examples with invented paths, and an agent that
 * echoes one would otherwise produce a finding nobody can act on.
 */
export function keepExistingFiles(
  findings: Finding[],
  exists: (file: string) => boolean,
): Finding[] {
  return findings.filter((finding) => exists(finding.file));
}

export interface Triage {
  fresh: Finding[];
  repeated: Finding[];
  suppressed: Finding[];
  shouldDeliver: boolean;
}

export function triageFindings(
  findings: Finding[],
  history: { seen: string[]; ignored: string[] },
): Triage {
  const seen = new Set(history.seen);
  const ignored = new Set(history.ignored);

  const fresh: Finding[] = [];
  const repeated: Finding[] = [];
  const suppressed: Finding[] = [];

  for (const finding of findings) {
    const fingerprint = fingerprintFinding(finding);
    // Muting wins over "seen before": a muted finding must never resurface.
    if (ignored.has(fingerprint)) {
      suppressed.push(finding);
    } else if (seen.has(fingerprint)) {
      repeated.push(finding);
    } else {
      fresh.push(finding);
    }
  }

  return { fresh, repeated, suppressed, shouldDeliver: fresh.length > 0 };
}

const SEVERITY_MARK: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪️",
};

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** One finding as its own Telegram message, so it can carry its own buttons. */
export function renderFindingHTML(finding: Finding, project?: string): string {
  // Each finding is its own message, so the path has to say which repository it
  // belongs to on its own; the batch header scrolls away.
  const file =
    project && !finding.file.startsWith(`${project}/`) ? `${project}/${finding.file}` : finding.file;
  const location = finding.line === undefined ? file : `${file}:${finding.line}`;
  return [
    `${SEVERITY_MARK[finding.severity]} <b>${finding.severity}</b> · <code>${escapeHTML(location)}</code> · ${escapeHTML(finding.category)}`,
    escapeHTML(truncate(finding.description, MAX_DESCRIPTION_LENGTH)),
  ].join("\n");
}

export function renderRunHTML(run: {
  recipe: string;
  fresh: Finding[];
  repeated: Finding[];
  suppressed: Finding[];
}): string {
  const header = `🔍 <b>${escapeHTML(run.recipe)}</b>`;
  const notes: string[] = [];
  if (run.repeated.length > 0) {
    notes.push(`повторы: ${run.repeated.length}`);
  }
  if (run.suppressed.length > 0) {
    notes.push(`заглушено: ${run.suppressed.length}`);
  }
  const footer = notes.length > 0 ? `<i>${notes.join(" · ")}</i>` : "";

  if (run.fresh.length === 0) {
    return [header, "Новых находок нет.", footer].filter(Boolean).join("\n\n");
  }

  const budget = MAX_MESSAGE_LENGTH - header.length - footer.length - 64;
  const blocks: string[] = [];
  let used = 0;

  for (const finding of run.fresh) {
    const block = renderFindingHTML(finding);
    if (used + block.length + 2 > budget) {
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }

  const dropped = run.fresh.length - blocks.length;
  if (dropped > 0) {
    blocks.push(`<i>…ещё ${dropped}, не поместились в сообщение</i>`);
  }

  return [header, blocks.join("\n\n"), footer].filter(Boolean).join("\n\n");
}

/** Telegram rejects a longer forum topic name. */
const MAX_TOPIC_NAME = 128;

export function fixTopicName(finding: Finding): string {
  const file = finding.file.split("/").at(-1) ?? finding.file;
  const location = finding.line === undefined ? file : `${file}:${finding.line}`;
  const name = `\u{1F527} ${location} \u00B7 ${finding.category}`;
  const characters = [...name];
  return characters.length <= MAX_TOPIC_NAME
    ? name
    : `${characters.slice(0, MAX_TOPIC_NAME - 1).join("")}\u2026`;
}

/**
 * The opening prompt of a fix thread.
 *
 * The finding is handed over as a claim to be checked, not as fact: a review
 * pass is wrong often enough that starting from "fix this" invites the agent to
 * invent a problem and then solve it.
 */
export function buildFixPrompt(recipe: string, finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return [
    `Автоматическое ревью (рецепт ${recipe}) сообщило о проблеме.`,
    "Ниже — его находка. Это заявка, а не истина: она вполне может быть ложной.",
    "",
    `Файл: ${location}`,
    `Категория: ${finding.category}`,
    `Что нашли: ${finding.description}`,
    "",
    "Сначала проверь, настоящая ли проблема: открой файл, посмотри контекст и вызывающий код.",
    "Если находка ложная — скажи это одной фразой с обоснованием и ничего не меняй.",
    "Если настоящая — предложи минимальное исправление и покажи дифф.",
    "Ничего не коммить и не пушить.",
  ].join("\n");
}
