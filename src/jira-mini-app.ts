import type {
  JiraClientPort,
  JiraBacklogResult,
  JiraFilterResult,
  JiraFiltersResult,
  JiraIssue,
  JiraIssueResult,
  JiraKanbanResult,
  JiraSprintResult,
} from "./jira-client.js";

export interface JiraMiniAppIssue extends JiraIssue {
  telegramUrl?: string;
}

export interface JiraMiniAppIssueResult extends JiraIssueResult {
  telegramUrl?: string;
}

export interface JiraMiniAppFilterResult extends Omit<JiraFilterResult, "issues"> {
  issues: JiraMiniAppIssue[];
}

export interface JiraMiniAppSprintResult extends Omit<JiraSprintResult, "issues"> {
  issues: JiraMiniAppIssue[];
}

export interface JiraMiniAppBacklogResult extends Omit<JiraBacklogResult, "issues"> {
  issues: JiraMiniAppIssue[];
}

export interface JiraMiniAppKanbanResult extends Omit<JiraKanbanResult, "columns"> {
  columns: Array<Omit<JiraKanbanResult["columns"][number], "issues"> & {
    issues: JiraMiniAppIssue[];
  }>;
}

export interface JiraMiniAppThreadResult {
  created: boolean;
  url: string;
}

export interface JiraMiniAppController {
  getMySprint(refresh: boolean): Promise<JiraMiniAppFilterResult>;
  getSprint(refresh: boolean): Promise<JiraMiniAppSprintResult>;
  getBacklog(startAt: number, limit: number, refresh: boolean): Promise<JiraMiniAppBacklogResult>;
  getKanban(refresh: boolean): Promise<JiraMiniAppKanbanResult>;
  getFilters(refresh: boolean): Promise<JiraFiltersResult>;
  runFilter(id: string, refresh: boolean): Promise<JiraMiniAppFilterResult>;
  getIssue(key: string, refresh: boolean): Promise<JiraMiniAppIssueResult>;
  ensureThread(key: string): Promise<JiraMiniAppThreadResult>;
}

export interface JiraMiniAppControllerOptions {
  client: JiraClientPort;
  findThreadUrl(issueKey: string): string | undefined;
  openThread(issue: JiraIssueResult): Promise<JiraMiniAppThreadResult>;
}

export function createJiraMiniAppController(
  options: JiraMiniAppControllerOptions,
): JiraMiniAppController {
  const decorate = (issue: JiraIssue): JiraMiniAppIssue => {
    const telegramUrl = options.findThreadUrl(issue.key);
    return { ...issue, ...(telegramUrl ? { telegramUrl } : {}) };
  };

  return {
    getMySprint: async (refresh) => {
      const result = await options.client.getMySprint(refresh);
      return { ...result, issues: result.issues.map(decorate) };
    },
    getSprint: async (refresh) => {
      const result = await options.client.getSprint(refresh);
      return { ...result, issues: result.issues.map(decorate) };
    },
    getBacklog: async (startAt, limit, refresh) => {
      const result = await options.client.getBacklog(startAt, limit, refresh);
      return { ...result, issues: result.issues.map(decorate) };
    },
    getKanban: async (refresh) => {
      const result = await options.client.getKanban(refresh);
      return {
        ...result,
        columns: result.columns.map((column) => ({
          ...column,
          issues: column.issues.map(decorate),
        })),
      };
    },
    getFilters: (refresh) => options.client.getFilters(refresh),
    runFilter: async (id, refresh) => {
      const result = await options.client.runFilter(id, refresh);
      return { ...result, issues: result.issues.map(decorate) };
    },
    getIssue: async (key, refresh) => {
      const issue = await options.client.getIssue(key.toUpperCase(), refresh);
      return decorate(issue) as JiraMiniAppIssueResult;
    },
    ensureThread: async (key) => {
      const issue = await options.client.getIssue(key.toUpperCase(), true);
      return options.openThread(issue);
    },
  };
}
