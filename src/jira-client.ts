import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RESULT_LIMIT = "100";

export interface JiraCacheMetadata {
  cached: boolean;
  stale: boolean;
  cache_age_seconds: number;
}

export interface JiraSprint {
  id: number;
  board_id?: number;
  name: string;
  state: string;
  start_date?: string;
  end_date?: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  status_category?: string;
  assignee?: string;
  priority?: string;
  issue_type?: string;
  created?: string;
  updated?: string;
  sprints?: JiraSprint[];
  url: string;
}

export interface JiraIssueList extends JiraCacheMetadata {
  total: number;
  returned?: number;
  issues: JiraIssue[];
}

export interface JiraIssueResult extends JiraIssue, JiraCacheMetadata {}

export interface JiraSprintResult extends JiraIssueList {
  sprints: JiraSprint[];
}

export interface JiraFilterSummary {
  id: string;
  name: string;
  owner?: string;
  favourite?: boolean;
  url: string;
}

export interface JiraFiltersResult extends JiraCacheMetadata {
  count: number;
  filters: JiraFilterSummary[];
}

export interface JiraFilterResult extends JiraIssueList {
  filter: Pick<JiraFilterSummary, "id" | "name">;
}

export interface JiraKanbanColumn {
  status: string;
  status_category?: string;
  count: number;
  issues: JiraIssue[];
}

export interface JiraKanbanResult extends JiraCacheMetadata {
  title: string;
  total: number;
  returned?: number;
  columns: JiraKanbanColumn[];
}

export interface JiraClientPort {
  getMySprint(refresh: boolean): Promise<JiraFilterResult>;
  getSprint(refresh: boolean): Promise<JiraSprintResult>;
  getKanban(refresh: boolean): Promise<JiraKanbanResult>;
  getFilters(refresh: boolean): Promise<JiraFiltersResult>;
  runFilter(id: string, refresh: boolean): Promise<JiraFilterResult>;
}

export type JiraJsonExecutor = (file: string, args: string[]) => Promise<string>;

export class JiraClient implements JiraClientPort {
  constructor(
    private readonly executable: string,
    private readonly execute: JiraJsonExecutor = executeJsonCommand,
  ) {}

  getIssue(key: string, refresh: boolean): Promise<JiraIssueResult> {
    const normalizedKey = key.toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,15}-\d+$/.test(normalizedKey)) {
      return Promise.reject(new Error("Invalid Jira issue key"));
    }
    return this.run(
      ["issue", normalizedKey, ...refreshFlag(refresh)],
      isIssueResult,
      "issue",
    );
  }

  getMySprint(refresh: boolean): Promise<JiraFilterResult> {
    return this.run(
      ["filter", "Мой спринт", "--limit", RESULT_LIMIT, ...refreshFlag(refresh)],
      isFilterResult,
      "filter",
    );
  }

  getSprint(refresh: boolean): Promise<JiraSprintResult> {
    return this.run(
      ["sprint", "--limit", RESULT_LIMIT, ...refreshFlag(refresh)],
      isSprintResult,
      "sprint",
    );
  }

  getKanban(refresh: boolean): Promise<JiraKanbanResult> {
    return this.run(
      [
        "kanban",
        "Мой спринт",
        "--limit",
        RESULT_LIMIT,
        "--json",
        ...refreshFlag(refresh),
      ],
      isKanbanResult,
      "kanban",
    );
  }

  getFilters(refresh: boolean): Promise<JiraFiltersResult> {
    return this.run(["filters", ...refreshFlag(refresh)], isFiltersResult, "filters");
  }

  runFilter(id: string, refresh: boolean): Promise<JiraFilterResult> {
    if (!/^\d+$/.test(id)) {
      return Promise.reject(new Error("Invalid Jira filter id"));
    }
    return this.run(
      ["filter", id, "--limit", RESULT_LIMIT, ...refreshFlag(refresh)],
      isFilterResult,
      "filter",
    );
  }

  private async run<T>(
    args: string[],
    validate: (value: unknown) => value is T,
    responseName: string,
  ): Promise<T> {
    const output = await this.execute(this.executable, args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("Jira client returned invalid JSON");
    }
    if (!validate(parsed)) {
      throw new Error(`Jira client returned invalid ${responseName} response`);
    }
    return parsed;
  }
}

async function executeJsonCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

function refreshFlag(refresh: boolean): string[] {
  return refresh ? ["--refresh"] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCacheMetadata(value: Record<string, unknown>): boolean {
  return typeof value.cached === "boolean"
    && typeof value.stale === "boolean"
    && typeof value.cache_age_seconds === "number";
}

function isIssue(value: unknown): value is JiraIssue {
  return isRecord(value)
    && typeof value.key === "string"
    && typeof value.summary === "string"
    && typeof value.status === "string"
    && typeof value.url === "string";
}

function isIssueResult(value: unknown): value is JiraIssueResult {
  return isRecord(value) && hasCacheMetadata(value) && isIssue(value);
}

function isIssueList(value: Record<string, unknown>): boolean {
  return hasCacheMetadata(value)
    && typeof value.total === "number"
    && Array.isArray(value.issues)
    && value.issues.every(isIssue);
}

function isSprint(value: unknown): value is JiraSprint {
  return isRecord(value)
    && typeof value.id === "number"
    && typeof value.name === "string"
    && typeof value.state === "string";
}

function isSprintResult(value: unknown): value is JiraSprintResult {
  return isRecord(value)
    && isIssueList(value)
    && Array.isArray(value.sprints)
    && value.sprints.every(isSprint);
}

function isFilterSummary(value: unknown): value is JiraFilterSummary {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.url === "string";
}

function isFiltersResult(value: unknown): value is JiraFiltersResult {
  return isRecord(value)
    && hasCacheMetadata(value)
    && typeof value.count === "number"
    && Array.isArray(value.filters)
    && value.filters.every(isFilterSummary);
}

function isFilterResult(value: unknown): value is JiraFilterResult {
  return isRecord(value)
    && isIssueList(value)
    && isRecord(value.filter)
    && typeof value.filter.id === "string"
    && typeof value.filter.name === "string";
}

function isKanbanColumn(value: unknown): value is JiraKanbanColumn {
  return isRecord(value)
    && typeof value.status === "string"
    && typeof value.count === "number"
    && Array.isArray(value.issues)
    && value.issues.every(isIssue);
}

function isKanbanResult(value: unknown): value is JiraKanbanResult {
  return isRecord(value)
    && hasCacheMetadata(value)
    && typeof value.title === "string"
    && typeof value.total === "number"
    && Array.isArray(value.columns)
    && value.columns.every(isKanbanColumn);
}
