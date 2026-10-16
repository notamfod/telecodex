import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const lowlight = createLowlight({ bash, csharp, css, go, javascript, json, markdown, php, python, scss, sql, typescript, xml, yaml });
const MAX_HIGHLIGHT_CHARS = 160_000;

export interface HighlightedDiffToken {
  readonly text: string;
  readonly className: string;
}

export interface HighlightedDiffLine {
  readonly kind: "added" | "removed" | "hunk" | "context";
  readonly tokens: readonly HighlightedDiffToken[];
  readonly oldLine?: number;
  readonly newLine?: number;
}

type Side = "old" | "new";
type Projection = { source: string[]; rows: number[] };

export function highlightGitlabDiff(diff: string, newPath: string, oldPath?: string): HighlightedDiffLine[] {
  const rows = numberedRows(diff);
  const language = languageFor(newPath) ?? languageFor(oldPath ?? "");
  if (!language || diff.length > MAX_HIGHLIGHT_CHARS) return rows;

  for (const group of hunkGroups(rows)) {
    const oldProjection: Projection = { source: [], rows: [] };
    const newProjection: Projection = { source: [], rows: [] };
    for (const index of group) {
      const row = rows[index]!;
      const body = codeBody(row);
      if (body === undefined) continue;
      if (row.kind !== "added") addProjection(oldProjection, body, index);
      if (row.kind !== "removed") addProjection(newProjection, body, index);
    }
    applyProjection(rows, oldProjection, "old", language);
    applyProjection(rows, newProjection, "new", language);
  }
  return rows;
}

type LineRange = { next: number; remaining: number };

function numberedRows(diff: string): HighlightedDiffLine[] {
  let inHunk = false;
  let oldRange: LineRange | undefined;
  let newRange: LineRange | undefined;
  return diff.split("\n").map((text) => {
    if (text.startsWith("@@")) {
      inHunk = true;
      oldRange = newRange = undefined;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
      if (match) {
        const old = lineRange(match[1]!, match[2]);
        const next = lineRange(match[3]!, match[4]);
        if (old && next) { oldRange = old; newRange = next; }
      }
    }
    const row = plainRow(text, inHunk);
    if (row.kind === "hunk" || codeBody(row) === undefined) return row;
    const oldLine = row.kind !== "added" ? takeLine(oldRange) : undefined;
    const newLine = row.kind !== "removed" ? takeLine(newRange) : undefined;
    return { ...row, ...(oldLine === undefined ? {} : { oldLine }), ...(newLine === undefined ? {} : { newLine }) };
  });
}

function lineRange(start: string, count: string | undefined): LineRange | undefined {
  const next = Number(start);
  const remaining = count === undefined ? 1 : Number(count);
  if (!Number.isSafeInteger(next) || !Number.isSafeInteger(remaining) ||
      !Number.isSafeInteger(next + remaining) || (next === 0 && remaining > 0)) return undefined;
  return { next, remaining };
}

function takeLine(range: LineRange | undefined): number | undefined {
  if (!range || range.remaining === 0) return undefined;
  range.remaining -= 1;
  return range.next++;
}

function plainRow(text: string, inHunk: boolean): HighlightedDiffLine {
  if (text.startsWith("@@") || (!inHunk && (text.startsWith("--- ") || text.startsWith("+++ ")))) return tokenRow("hunk", text);
  if (text.startsWith("+")) return tokenRow("added", text);
  if (text.startsWith("-")) return tokenRow("removed", text);
  return tokenRow("context", text);
}

function tokenRow(kind: HighlightedDiffLine["kind"], text: string): HighlightedDiffLine {
  return { kind, tokens: [{ text, className: "" }] };
}

function hunkGroups(rows: readonly HighlightedDiffLine[]): number[][] {
  const groups: number[][] = [];
  let group: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === "hunk") {
      if (group.length) groups.push(group);
      group = [];
      continue;
    }
    group.push(index);
  }
  if (group.length) groups.push(group);
  return groups;
}

function codeBody(row: HighlightedDiffLine): string | undefined {
  const text = row.tokens[0]?.text ?? "";
  if (text.startsWith("\\ No newline at end of file")) return undefined;
  if (row.kind === "hunk") return undefined;
  if (row.kind === "context") return text.startsWith(" ") ? text.slice(1) : undefined;
  return text.slice(1);
}

function addProjection(projection: Projection, source: string, row: number): void {
  projection.source.push(source);
  projection.rows.push(row);
}

function applyProjection(
  rows: HighlightedDiffLine[],
  projection: Projection,
  side: Side,
  language: string,
): void {
  if (projection.source.length === 0) return;
  const tokens = highlightedLines(projection.source.join("\n"), language);
  if (!tokens || tokens.length !== projection.rows.length) return;
  projection.rows.forEach((rowIndex, index) => {
    const row = rows[rowIndex]!;
    if (side === "old" && row.kind === "added") return;
    if (side === "new" && row.kind === "removed") return;
    const prefix = row.kind === "context" ? " " : row.kind === "added" ? "+" : "-";
    rows[rowIndex] = { ...row, tokens: joinTokens([{ text: prefix, className: "" }, ...tokens[index]!]) };
  });
}

function highlightedLines(source: string, language: string): HighlightedDiffToken[][] | undefined {
  try {
    const root = lowlight.highlight(language, source);
    return splitLines(flatten(root.children));
  } catch {
    return undefined;
  }
}

function flatten(nodes: readonly unknown[], inherited = ""): HighlightedDiffToken[] {
  const tokens: HighlightedDiffToken[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const value = node as { type?: unknown; value?: unknown; properties?: { className?: unknown }; children?: unknown };
    if (value.type === "text" && typeof value.value === "string") {
      tokens.push({ text: value.value, className: inherited });
      continue;
    }
    if (Array.isArray(value.children)) {
      const classNames = Array.isArray(value.properties?.className)
        ? value.properties.className.filter((name): name is string => typeof name === "string").join(" ")
        : "";
      tokens.push(...flatten(value.children, [inherited, classNames].filter(Boolean).join(" ")));
    }
  }
  return tokens;
}

function splitLines(tokens: readonly HighlightedDiffToken[]): HighlightedDiffToken[][] {
  const lines: HighlightedDiffToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (part) lines[lines.length - 1]!.push({ text: part, className: token.className });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  return lines.map(joinTokens);
}

function joinTokens(tokens: readonly HighlightedDiffToken[]): HighlightedDiffToken[] {
  return tokens.reduce<HighlightedDiffToken[]>((joined, token) => {
    if (!token.text) return joined;
    const previous = joined.at(-1);
    if (previous?.className === token.className) {
      joined[joined.length - 1] = { ...previous, text: previous.text + token.text };
    } else joined.push(token);
    return joined;
  }, []);
}

function languageFor(path: string): string | undefined {
  const name = path.toLowerCase().split("/").at(-1) ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return ({ js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", css: "css", scss: "scss", sass: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", php: "php", go: "go", json: "json", yml: "yaml", yaml: "yaml", sh: "bash", bash: "bash", zsh: "bash", cs: "csharp", sql: "sql", py: "python", md: "markdown", markdown: "markdown" } as Record<string, string | undefined>)[extension];
}
