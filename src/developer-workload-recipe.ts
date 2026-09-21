import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { escapeHTML } from "./format.js";
import { weeklyPeriod } from "./weekly-activity.js";

const run = promisify(execFile);
const LIMIT = 500;
const DESCRIPTION_MINIMUM_LENGTH = 80;

export type DeveloperRole = "design" | "frontend" | "backend" | "fullstack";
type IssueRole = Exclude<DeveloperRole, "fullstack"> | "analysis";

export interface DeveloperWorkloadRecipe {
  id: string;
  kind: "developer-workload";
  cwd: string;
  jiraClient: string;
  capacityHours: number;
  fromStatus: string;
  completionStatuses: string[];
  developerRoles: Record<string, DeveloperRole[]>;
  deliver: { chatId: number; messageThreadId: number };
}

interface Issue {
  key: string;
  summary: string;
  url: string;
  assignee?: string;
  components?: string[];
  description_length?: number;
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

function parseIssues(raw: string, allowTruncated = false): Issue[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("jira-client workload returned invalid JSON"); }
  const response = parsed as { issues?: unknown; total?: unknown; returned?: unknown };
  const issues = response.issues;
  if (!Array.isArray(issues) || !issues.every(validIssue)) {
    throw new Error("jira-client workload response needs issues");
  }
  if (typeof response.total !== "number" || typeof response.returned !== "number"
    || (!allowTruncated && response.total > response.returned)) {
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

function issueRole(issue: Issue): IssueRole {
  if ((issue.description_length ?? 0) < DESCRIPTION_MINIMUM_LENGTH) return "analysis";
  const text = `${issue.summary} ${(issue.components ?? []).join(" ")}`.toLocaleLowerCase("ru");
  if (/design|дизайн|figma|макет/.test(text)) return "design";
  if (/backend|бэкенд|бэк/.test(text)) return "backend";
  if (/frontend|фронтенд|фронт|\bui\b/.test(text)) return "frontend";
  return "analysis";
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
  allowTruncated = false,
  limit = LIMIT,
): Promise<Issue[]> {
  const raw = await execute(recipe.jiraClient, [
    "workload", jql,
    "--start-date", startDate,
    "--end-date", endDate,
    "--from-status", recipe.fromStatus,
    ...recipe.completionStatuses.flatMap((status) => ["--to-status", status]),
    "--limit", String(limit),
    "--refresh",
  ], recipe.cwd);
  return parseIssues(raw, allowTruncated);
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
  const [completed, active, unassignedBacklog, assignedBacklog] = await Promise.all([
    query(recipe, `project = MIR AND updated >= "${startDate}" AND updated <= "${endDate}"`, startDate, endDate, execute),
    query(recipe, `project = MIR AND status = "${recipe.fromStatus}" AND assignee IS NOT EMPTY`, startDate, endDate, execute),
    query(recipe, "project = MIR AND statusCategory = new AND assignee IS EMPTY ORDER BY created DESC", startDate, endDate, execute, true, 10),
    query(recipe, "project = MIR AND statusCategory = new AND assignee IS NOT EMPTY ORDER BY created DESC", startDate, endDate, execute, true, 10),
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
  const people = [...new Set([...Object.keys(recipe.developerRoles), ...done.keys(), ...load.keys()])]
    .sort((a, b) => a.localeCompare(b, "ru"));
  const freePeople = (role: IssueRole) => people
    .map((name) => ({ name, spare: capacity - (load.get(name) ?? 0) }))
    .filter((person) => person.spare > 0)
    .filter((person) => {
      const roles = recipe.developerRoles[person.name] ?? [];
      return role === "analysis" ? roles.includes("fullstack") : roles.includes(role) || roles.includes("fullstack");
    })
    .sort((a, b) => {
      const aRoles = recipe.developerRoles[a.name] ?? [];
      const bRoles = recipe.developerRoles[b.name] ?? [];
      const preferred = (roles: DeveloperRole[]) => role === "analysis"
        ? (roles.includes("fullstack") ? 0 : 1)
        : (roles.includes(role) || (role === "backend" && roles.includes("fullstack")) ? 0 : 1);
      const aSpecialist = preferred(aRoles);
      const bSpecialist = preferred(bRoles);
      return aSpecialist - bSpecialist || b.spare - a.spare || a.name.localeCompare(b.name, "ru");
    });

  const proposal = (issue: Issue, excludedName?: string): string => {
    const role = issueRole(issue);
    const candidates = freePeople(role).filter((person) => person.name !== excludedName);
    const target = candidates.find((person) => person.spare >= estimate(issue)) ?? candidates[0];
    if (!target) return "нет подходящей свободной ёмкости";
    if (role === "analysis") return `нужен анализ: ${escapeHTML(target.name)} · свободно ${hours(target.spare)} ч`;
    return `${escapeHTML(target.name)} · свободно ${hours(target.spare)} ч`;
  };

  const unassigned = unassignedBacklog.slice(0, 5);
  const reassigned = assignedBacklog.slice(0, 5);
  const loadMarker = (seconds: number) => seconds > capacity ? "🔴" : seconds >= capacity * 0.8 ? "🟡" : "🟢";
  const lines = [
    `<b>📊 Нагрузка разработчиков</b>\n<i>${startDate} - ${endDate}</i>`,
    "<b>✅ Сделано за неделю</b>",
    ...(done.size ? [...done.entries()].sort(([a], [b]) => a.localeCompare(b, "ru")).map(([name, value]) =>
      `• <b>${escapeHTML(name)}</b> · ${value.count} задач · ${hours(value.seconds)} ч`) : ["• Нет задач с подтверждённым переходом."]),
    `<b>🧩 В работе</b> <i>норма ${recipe.capacityHours} ч</i>`,
    ...(people.length ? people.map((name) => {
      const seconds = load.get(name) ?? 0;
      const balance = capacity - seconds;
      return `${loadMarker(seconds)} <b>${escapeHTML(name)}</b> · ${hours(seconds)} ч · ${balance >= 0 ? `свободно ${hours(balance)} ч` : `<b>перегрузка ${hours(-balance)} ч</b>`}`;
    }) : ["• Нет назначенных задач в работе."]),
    "<b>🆕 К выдаче из бэклога</b> <i>5 новых задач</i>",
    ...(unassigned.length ? unassigned.map((issue) => {
      return `• ${link(issue)}\n  → ${proposal(issue)}`;
    }) : ["• Нет нераспределённых задач с начальным статусом."]),
    "<b>🔁 К перераспределению</b>",
    ...(reassigned.length ? reassigned.map((issue) => {
      return `• ${link(issue)}\n  → сейчас ${escapeHTML(issue.assignee ?? "не назначена")}, ${proposal(issue, issue.assignee)}`;
    }) : ["• Нет назначенных, но не начатых задач."]),
    `<i>Плановая ёмкость: ${recipe.capacityHours} ч на человека. Предложения не меняют Jira.</i>`,
  ];
  const message = lines.join("\n");
  if (message.length > 3900) throw new Error("Developer workload report exceeds Telegram message limit");
  await send(message);
  return { message };
}
