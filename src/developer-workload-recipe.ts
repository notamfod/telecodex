import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { escapeHTML } from "./format.js";
import { weeklyPeriod } from "./weekly-activity.js";

const run = promisify(execFile);
const LIMIT = 500;

export interface DeveloperWorkloadRecipe {
  id: string;
  kind: "developer-workload";
  cwd: string;
  jiraClient: string;
  capacityHours: number;
  fromStatus: string;
  completionStatuses: string[];
  deliver: { chatId: number; messageThreadId: number };
}

interface Issue {
  key: string;
  summary: string;
  url: string;
  assignee?: string;
  original_estimate_seconds?: number;
  status_transitions?: unknown[];
}

type Execute = (command: string, args: string[], cwd: string) => Promise<string>;

function dateAt(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(1).replace(".", ",");
}

function validIssue(value: unknown): value is Issue {
  const issue = value as Record<string, unknown>;
  return typeof issue?.key === "string"
    && typeof issue.summary === "string"
    && typeof issue.url === "string";
}

function parseIssues(raw: string): Issue[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("jira-client workload returned invalid JSON"); }
  const response = parsed as { issues?: unknown; total?: unknown; returned?: unknown };
  const issues = response.issues;
  if (!Array.isArray(issues) || !issues.every(validIssue)) {
    throw new Error("jira-client workload response needs issues");
  }
  if (typeof response.total !== "number" || typeof response.returned !== "number" || response.total > response.returned) {
    throw new Error("jira-client workload result is truncated");
  }
  return issues;
}

function estimate(issue: Issue): number {
  return typeof issue.original_estimate_seconds === "number" && issue.original_estimate_seconds > 0
    ? issue.original_estimate_seconds : 0;
}

function link(issue: Issue): string {
  return `<a href="${escapeHTML(issue.url)}">${escapeHTML(issue.key)}</a> - ${escapeHTML(issue.summary)}`;
}

function completedWithin(issue: Issue, start: number, end: number): boolean {
  return Array.isArray(issue.status_transitions) && issue.status_transitions.some((transition) => {
    const at = Date.parse((transition as { at?: unknown })?.at as string);
    return Number.isFinite(at) && at >= start && at < end;
  });
}

async function query(
  recipe: DeveloperWorkloadRecipe,
  jql: string,
  startDate: string,
  endDate: string,
  execute: Execute,
): Promise<Issue[]> {
  const raw = await execute(recipe.jiraClient, [
    "workload", jql,
    "--start-date", startDate,
    "--end-date", endDate,
    "--from-status", recipe.fromStatus,
    ...recipe.completionStatuses.flatMap((status) => ["--to-status", status]),
    "--limit", String(LIMIT),
    "--refresh",
  ], recipe.cwd);
  return parseIssues(raw);
}

export async function runDeveloperWorkloadRecipe(
  recipe: DeveloperWorkloadRecipe,
  send: (html: string) => Promise<void>,
  dependencies: { now?: Date; execute?: Execute } = {},
): Promise<{ message: string }> {
  const period = weeklyPeriod(dependencies.now ?? new Date());
  const startDate = dateAt(period.start);
  const endDate = dateAt(period.end);
  const execute = dependencies.execute ?? (async (command, args, cwd) => {
    const { stdout } = await run(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  });
  const [completed, active, backlog] = await Promise.all([
    query(recipe, `project = MIR AND updated >= "${startDate}" AND updated <= "${endDate}"`, startDate, endDate, execute),
    query(recipe, `project = MIR AND status = "${recipe.fromStatus}" AND assignee IS NOT EMPTY`, startDate, endDate, execute),
    query(recipe, "project = MIR AND statusCategory = new", startDate, endDate, execute),
  ]);

  const capacity = recipe.capacityHours * 3600;
  const done = new Map<string, { count: number; seconds: number }>();
  for (const issue of completed) {
    if (!issue.assignee || !completedWithin(issue, period.start, period.end)) continue;
    const summary = done.get(issue.assignee) ?? { count: 0, seconds: 0 };
    summary.count++; summary.seconds += estimate(issue); done.set(issue.assignee, summary);
  }
  const load = new Map<string, number>();
  for (const issue of active) {
    if (issue.assignee) load.set(issue.assignee, (load.get(issue.assignee) ?? 0) + estimate(issue));
  }
  const people = [...new Set([...done.keys(), ...load.keys()])].sort((a, b) => a.localeCompare(b, "ru"));
  const freePeople = () => people
    .map((name) => ({ name, spare: capacity - (load.get(name) ?? 0) }))
    .filter((person) => person.spare > 0)
    .sort((a, b) => b.spare - a.spare || a.name.localeCompare(b.name, "ru"));

  const unassigned = backlog.filter((issue) => !issue.assignee).slice(0, 10);
  const reassigned = backlog.filter((issue) => issue.assignee && (load.get(issue.assignee) ?? 0) > capacity).slice(0, 10);
  const lines = [
    `<b>Нагрузка разработчиков</b>\n${startDate} - ${endDate}`,
    "<b>Сделано за неделю</b>",
    ...(people.length ? people.map((name) => {
      const value = done.get(name) ?? { count: 0, seconds: 0 };
      return `• ${escapeHTML(name)}: ${value.count} задач, ${hours(value.seconds)} ч`;
    }) : ["• Нет задач с подтверждённым переходом."]),
    "<b>В работе</b>",
    ...(people.length ? people.map((name) => {
      const seconds = load.get(name) ?? 0;
      const balance = capacity - seconds;
      return `• ${escapeHTML(name)}: ${hours(seconds)} ч, ${balance >= 0 ? `свободно ${hours(balance)} ч` : `перегрузка ${hours(-balance)} ч`}`;
    }) : ["• Нет назначенных задач в работе."]),
    "<b>К выдаче из бэклога</b>",
    ...(unassigned.length ? unassigned.map((issue) => {
      const target = freePeople().find((person) => person.spare >= estimate(issue)) ?? freePeople()[0];
      return `• ${link(issue)}${target ? ` - предложить ${escapeHTML(target.name)} (${hours(target.spare)} ч свободно)` : " - нет свободной ёмкости"}`;
    }) : ["• Нет нераспределённых задач с начальным статусом."]),
    "<b>К перераспределению</b>",
    ...(reassigned.length ? reassigned.map((issue) => {
      const target = freePeople().find((person) => person.name !== issue.assignee && person.spare >= estimate(issue)) ?? freePeople().find((person) => person.name !== issue.assignee);
      return `• ${link(issue)} - снять с ${escapeHTML(issue.assignee ?? "исполнителя")}${target ? `, предложить ${escapeHTML(target.name)}` : ""}`;
    }) : ["• Нет не начатых задач у перегруженных исполнителей."]),
    `<i>Расчёт: ${recipe.capacityHours} ч плановой ёмкости на человека. Предложения не меняют Jira и требуют подтверждения руководителя.</i>`,
  ];
  const message = lines.join("\n");
  if (message.length > 3900) throw new Error("Developer workload report exceeds Telegram message limit");
  await send(message);
  return { message };
}
