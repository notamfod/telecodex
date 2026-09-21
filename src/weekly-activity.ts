import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";

export interface WeeklyProject { name: string; roots: string[] }
export interface Period { start: number; end: number }
export interface ActivityPoint { ts: number; project: string }
export interface ActivityEntry extends ActivityPoint { role: "user" | "assistant"; text: string; sessionId?: string }
export interface ActivityData { points: ActivityPoint[]; entries: ActivityEntry[]; warnings: string[] }
const MINUTE = 60_000;
const DAY = 86_400_000;

/** Contiguous weeks ending Sunday at 20:00 Moscow (UTC+3, no DST). */
export function weeklyPeriod(now: Date): Period {
  const cutoff = new Date(now);
  cutoff.setUTCHours(17, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - cutoff.getUTCDay());
  if (cutoff.getTime() > now.getTime()) cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  return { start: cutoff.getTime() - 7 * DAY, end: cutoff.getTime() };
}

export function projectForPath(cwd: string, projects: WeeklyProject[]): string | undefined {
  const normalized = path.resolve(cwd);
  return projects.flatMap((project) => project.roots.map((root) => ({ name: project.name, root: path.resolve(root) })))
    .filter(({ root }) => normalized === root || normalized.startsWith(`${root}${path.sep}`))
    .sort((a, b) => b.root.length - a.root.length)[0]?.name;
}

/** No tool output is consumed; scrub common credentials even in conversational text. */
export function safeWeeklyText(text: string): string {
  return text.replaceAll("—", "-")
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|glpat-[\w-]{12,}|\d{7,}:[A-Za-z0-9_-]{25,})\b/g, "[REDACTED]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@")
    .trim();
}

function isScaffolding(text: string): boolean {
  return /^(?:# AGENTS\.md|<environment_context>|<recommended_plugins>|<permissions instructions>|<turn_aborted>|<system_reminder>|You are an AI|\[Automated|This session is being continued)/i.test(text.trim());
}

export async function readSessionActivity(file: string, projects: WeeklyProject[], period: Period): Promise<ActivityData> {
  const result: ActivityData = { points: [], entries: [], warnings: [] };
  let sessionId = path.basename(file);
  let cwd = "";
  let metadataCwd = "";
  let pending: { ts: number; text: string }[] = [];
  const seen = new Set<string>();
  const append = (ts: number, role: "user" | "assistant", text: string) => {
    const metadataBelowCwd = metadataCwd.startsWith(`${path.resolve(cwd)}${path.sep}`);
    const project = projectForPath(cwd, projects) ?? (metadataBelowCwd ? projectForPath(metadataCwd, projects) : undefined);
    if (!project || ts < period.start || ts >= period.end || !Number.isFinite(ts) || !text.trim()) return;
    if (role === "user" && isScaffolding(text)) return;
    const safe = safeWeeklyText(text);
    const key = `${ts}:${role}:${safe}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.entries.push({ ts, project, role, text: safe, sessionId });
    if (role === "user") result.points.push({ ts, project });
  };
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const p = row?.payload;
      if (!p || typeof p !== "object") continue;
      if (row.type === "session_meta") {
        if (JSON.stringify(p.source ?? "").includes("subagent") || p.source === "exec") return result;
        if (typeof p.id === "string") sessionId = p.id;
        metadataCwd = cwd = typeof p.cwd === "string" ? p.cwd : "";
      }
      if (row.type === "turn_context") {
        if (typeof p.cwd === "string") cwd = p.cwd;
        for (const entry of pending) append(entry.ts, "user", entry.text);
        pending = [];
      }
      const ts = Date.parse(row.timestamp);
      if (ts < period.start || ts >= period.end || !Number.isFinite(ts)) continue;
      if (row.type === "response_item" && p.type === "message" && Array.isArray(p.content)) {
        const text = p.content.map((part: { text?: unknown }) => typeof part?.text === "string" ? part.text : "").join("\n");
        // User input precedes turn_context; wait for the actual workspace for this turn.
        if (p.role === "user") pending.push({ ts, text });
        if (p.role === "assistant" && (p.phase === "final_answer" || p.phase === "final" || !p.phase)) {
          for (const entry of pending) append(entry.ts, "user", entry.text);
          pending = [];
          append(ts, "assistant", text);
        }
      }
      // Legacy rollouts use event_msg instead of response_item for user input.
      if (row.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") {
        pending.push({ ts, text: p.message });
      }
    }
    for (const entry of pending) append(entry.ts, "user", entry.text);
  } finally { lines.close(); input.destroy(); }
  return result;
}

export async function collectWeeklyActivity(databasePath: string, projects: WeeklyProject[], period: Period): Promise<ActivityData> {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  let rows: { rollout_path: string }[];
  try {
    // Include archived threads and threads created before this week.
    rows = db.prepare(`SELECT DISTINCT rollout_path FROM threads
      WHERE updated_at >= ? AND (source IS NULL OR (source NOT LIKE '%subagent%' AND source <> 'exec'))`)
      .all(Math.floor(period.start / 1000)) as { rollout_path: string }[];
  } finally { db.close(); }
  const result: ActivityData = { points: [], entries: [], warnings: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    let data: ActivityData;
    try { data = await readSessionActivity(row.rollout_path, projects, period); }
    catch { result.warnings.push("Не удалось прочитать одну из сессий."); continue; }
    for (const entry of data.entries) {
      // Forked/copied histories must not inflate either results or personal time.
      const key = `${entry.ts}:${entry.project}:${entry.role}:${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.entries.push(entry);
      if (entry.role === "user") result.points.push({ ts: entry.ts, project: entry.project });
    }
  }
  result.entries.sort((a, b) => a.ts - b.ts);
  return result;
}

/** 2-10 minute windows around each human input; overlapping time is shared. */
export function estimateTime(points: ActivityPoint[], period: Period): Map<string, { lowMinutes: number; highMinutes: number }> {
  const result = new Map<string, { lowMinutes: number; highMinutes: number }>();
  const events = points.filter((p) => p.ts >= period.start && p.ts < period.end).flatMap((p) =>
    ([1, 5] as const).flatMap((radius) => [
      { ts: Math.max(period.start, p.ts - radius * MINUTE), project: p.project, radius, delta: 1 },
      { ts: Math.min(period.end, p.ts + radius * MINUTE), project: p.project, radius, delta: -1 },
    ])).sort((a, b) => a.ts - b.ts);
  const lowActive = new Map<string, number>();
  const highActive = new Map<string, number>();
  let previous = events[0]?.ts ?? 0;
  for (const event of events) {
    const minutes = (event.ts - previous) / MINUTE;
    // Keep the lower-window attribution inside the upper estimate. Only the
    // additional upper-window time is distributed among the wider active set.
    for (const [field, active] of [
      ["lowMinutes", lowActive],
      ["highMinutes", lowActive.size ? lowActive : highActive],
    ] as const) {
      for (const project of active.keys()) {
        const time = result.get(project) ?? { lowMinutes: 0, highMinutes: 0 };
        time[field] += minutes / active.size;
        result.set(project, time);
      }
    }
    const active = event.radius === 1 ? lowActive : highActive;
    const count = (active.get(event.project) ?? 0) + event.delta;
    if (count) active.set(event.project, count); else active.delete(event.project);
    previous = event.ts;
  }
  return result;
}
