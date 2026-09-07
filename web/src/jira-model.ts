export interface JiraCacheMetadata {
  cached: boolean;
  stale: boolean;
  cache_age_seconds: number;
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
  url: string;
  telegramUrl?: string;
}

export interface JiraComment {
  author: string;
  created: string;
  body: string;
}

export interface JiraIssueDetail extends JiraIssue, JiraCacheMetadata {
  description?: string;
  comments?: JiraComment[];
}

export interface JiraIssueList extends JiraCacheMetadata {
  total: number;
  issues: JiraIssue[];
  filter?: { id: string; name: string };
  sprints?: Array<{ id: number; name: string; state: string }>;
}

export interface JiraBacklogPage extends JiraIssueList {
  jql?: string;
  start_at: number;
  limit: number;
  returned: number;
}

export interface JiraKanban extends JiraCacheMetadata {
  title: string;
  total: number;
  columns: Array<{
    status: string;
    status_category?: string;
    count: number;
    issues: JiraIssue[];
  }>;
}

export interface JiraFilters extends JiraCacheMetadata {
  count: number;
  filters: Array<{
    id: string;
    name: string;
    owner?: string;
    favourite?: boolean;
    url: string;
  }>;
}

export type JiraView = "my-sprint" | "sprint" | "backlog" | "kanban" | "filters" | "filter";
export type JiraViewResult = JiraIssueList | JiraBacklogPage | JiraKanban | JiraFilters;
export type JiraStatusType = "red" | "purple" | "green" | "blue" | "cool-gray";

export interface JiraStatusGroup {
  status: string;
  statusCategory?: string;
  issues: JiraIssue[];
}

export interface JiraAssigneeOption {
  id: string;
  text: string;
}

export interface JiraStatusOption {
  id: string;
  text: string;
}

export const UNASSIGNED_ASSIGNEE_ID = "__unassigned__";

const WORKFLOW_STATUS_RANK = new Map<string, number>([
  ["сделать", 0],
  ["заблокировано", 1],
  ["blocked", 1],
  ["в работе", 2],
  ["for qa", 3],
  ["in qa", 4],
  ["for verification", 5],
  ["готово", 6],
]);

export interface RequestGate {
  start(): number;
  invalidate(): void;
  isLatest(request: number): boolean;
}

export function createRequestGate(): RequestGate {
  let latest = 0;
  return {
    start: () => ++latest,
    invalidate: () => { latest += 1; },
    isLatest: (request) => request === latest,
  };
}

export function jiraResultCount(result: JiraViewResult): number {
  return "total" in result ? result.total : result.count;
}

export function jiraAssigneeOptions(issues: JiraIssue[]): JiraAssigneeOption[] {
  const names = new Set<string>();
  let hasUnassigned = false;
  for (const issue of issues) {
    const name = issue.assignee?.trim();
    if (name) names.add(name);
    else hasUnassigned = true;
  }
  const options = [...names].map((name) => ({ id: name, text: name }));
  if (hasUnassigned) {
    options.push({ id: UNASSIGNED_ASSIGNEE_ID, text: "Не назначен" });
  }
  return options;
}

export function filterIssuesByAssignees(
  issues: JiraIssue[],
  selectedIds: readonly string[],
): JiraIssue[] {
  if (selectedIds.length === 0) return issues;
  const selected = new Set(selectedIds);
  return issues.filter((issue) => selected.has(
    issue.assignee?.trim() || UNASSIGNED_ASSIGNEE_ID,
  ));
}

export function jiraStatusOptions(issues: JiraIssue[]): JiraStatusOption[] {
  return groupIssuesByStatus(issues).map((group) => ({
    id: group.status,
    text: group.status,
  }));
}

export function filterIssuesByStatuses(
  issues: JiraIssue[],
  selectedIds: readonly string[],
): JiraIssue[] {
  if (selectedIds.length === 0) return issues;
  const selected = new Set(selectedIds);
  return issues.filter((issue) => selected.has(issue.status));
}

export function assigneeInitials(name?: string): string {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase();
}

export function jiraIssueStatusType(issue: JiraIssue): JiraStatusType {
  if (issue.status.toLowerCase() === "blocked") return "red";
  if (issue.status_category === "indeterminate") return "purple";
  if (issue.status_category === "done") return "green";
  if (issue.status_category === "new") return "blue";
  return "cool-gray";
}

export function mergeBacklogPage(
  current: JiraBacklogPage,
  next: JiraBacklogPage,
): JiraBacklogPage {
  const issues = [...current.issues];
  const keys = new Set(issues.map((issue) => issue.key));
  for (const issue of next.issues) {
    if (keys.has(issue.key)) continue;
    keys.add(issue.key);
    issues.push(issue);
  }
  return {
    ...next,
    start_at: 0,
    limit: current.limit,
    returned: Math.max(current.returned, next.start_at + next.returned),
    issues,
    cached: current.cached && next.cached,
    stale: current.stale || next.stale,
    cache_age_seconds: Math.max(current.cache_age_seconds, next.cache_age_seconds),
  };
}

export function shouldRequestNextBacklog(
  hasMore: boolean,
  loadingNext: boolean,
  requestedCursor: number,
  loadedCount: number,
): boolean {
  return hasMore && !loadingNext && requestedCursor !== loadedCount;
}

export function groupIssuesByStatus(issues: JiraIssue[]): JiraStatusGroup[] {
  const groups = new Map<string, JiraStatusGroup>();
  for (const issue of issues) {
    let group = groups.get(issue.status);
    if (!group) {
      group = {
        status: issue.status,
        statusCategory: issue.status_category,
        issues: [],
      };
      groups.set(issue.status, group);
    }
    group.issues.push(issue);
  }
  return sortStatusGroups([...groups.values()]);
}

export function sortStatusGroups(groups: JiraStatusGroup[]): JiraStatusGroup[] {
  return groups
    .map((group, index) => ({ group, index, rank: statusRank(group.status) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ group }) => group);
}

function statusRank(status: string): number {
  return WORKFLOW_STATUS_RANK.get(status.trim().toLocaleLowerCase("ru-RU")) ?? 7;
}
