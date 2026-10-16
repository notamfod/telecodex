import { pipelineDraftText } from "./review-pipeline-render.js";
import type { PipelineJob } from "./review-pipeline-store.js";

const REQUEST_TIMEOUT_MS = 15_000;
const SAFE_LABEL = /^telecodex-review-[A-Za-z0-9_-]{1,96}$/;

export interface JiraIssueCreateClientOptions {
  server: string;
  login: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class JiraIssueCreateUnknownError extends Error {
  constructor(message = "Jira issue creation outcome is unknown; do not retry automatically") {
    super(message);
    this.name = "JiraIssueCreateUnknownError";
  }
}

export class JiraIssueCreateClient {
  private readonly server: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: JiraIssueCreateClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async findByLabel(label: string): Promise<{ key: string; url: string } | undefined> {
    this.validate(label);
    const { response, body } = await this.requestJson("/rest/api/2/search", {
      method: "POST",
      body: JSON.stringify({ jql: `project = MIR AND labels = \"${label}\"`, maxResults: 2, fields: ["key"] }),
    });
    if (!response.ok) throw new Error(`Jira issue lookup failed: ${response.status}`);
    if (!isRecord(body) || !Array.isArray(body.issues)) throw new Error("Jira issue lookup returned an invalid response");
    const total = body.total;
    if (total !== undefined && (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)) throw new Error("Jira issue lookup returned an invalid response");
    const issues = body.issues;
    if (issues.length > 1 || (typeof total === "number" && total > 1)) throw new Error("Jira issue lookup is ambiguous for review label");
    const key = issues[0]?.key;
    if (issues.length === 0) return undefined;
    if (typeof key !== "string" || !/^MIR-\d+$/.test(key)) throw new Error("Jira issue lookup returned an invalid issue key");
    return { key, url: `${this.server}/browse/${key}` };
  }

  async create(job: PipelineJob, label: string): Promise<{ key: string; url: string }> {
    this.validate(label);
    if (!job.draft) throw new Error("Jira issue creation requires a pipeline draft");
    const description = pipelineDraftText(job);
    const issueTypeId = await this.resolveMirBugIssueTypeId();
    let result: { response: Response; body: unknown };
    try {
      result = await this.requestJson("/rest/api/2/issue", { method: "POST", body: JSON.stringify({ fields: { project: { key: "MIR" }, issuetype: { id: issueTypeId }, priority: { name: job.draft.priority }, summary: job.draft.summary, description, labels: [label] } }) });
    } catch (error) {
      if (error instanceof JiraIssueCreateUnknownError) throw error;
      throw new JiraIssueCreateUnknownError();
    }
    if (!result.response.ok) {
      if (result.response.status >= 500 || result.response.status === 408) throw new JiraIssueCreateUnknownError();
      throw new Error(`Jira issue creation rejected: ${result.response.status}`);
    }
    if (!isRecord(result.body) || typeof result.body.key !== "string" || !/^MIR-\d+$/.test(result.body.key)) throw new JiraIssueCreateUnknownError();
    return { key: result.body.key, url: `${this.server}/browse/${result.body.key}` };
  }

  private validate(label: string): void {
    let url: URL;
    try { url = new URL(this.server); } catch { throw new Error("Jira server must be a valid HTTPS URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Jira server must be a plain HTTPS URL without credentials, query, or hash");
    if (!SAFE_LABEL.test(label)) throw new Error("Invalid Jira review label");
  }

  private async resolveMirBugIssueTypeId(): Promise<string> {
    const { response, body } = await this.requestJson("/rest/api/2/project/MIR", { method: "GET" }, false);
    if (!response.ok) throw new Error(`Jira issue metadata lookup failed: ${response.status}`);
    if (!isRecord(body) || body.key !== "MIR" || !Array.isArray(body.issueTypes)) {
      throw new Error("Jira issue metadata lookup returned an invalid response");
    }
    const matches = body.issueTypes.filter((issueType): issueType is Record<string, unknown> => {
      if (!isRecord(issueType)) return false;
      return (issueType.name === "Bug" || issueType.name === "Ошибка")
        && issueType.subtask === false && typeof issueType.id === "string"
        && /^[1-9][0-9]{0,18}$/.test(issueType.id);
    });
    if (matches.length !== 1) throw new Error("Jira issue metadata did not resolve one Bug type");
    return matches[0]!.id as string;
  }

  private async requestJson(
    pathname: string,
    init: RequestInit,
    unknownOnFailure = true,
  ): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.server}${pathname}`, { ...init, signal: controller.signal, headers: { Authorization: `Basic ${Buffer.from(`${this.options.login}:${this.options.token}`).toString("base64")}`, "Content-Type": "application/json" } });
      if (!response.ok) return { response, body: undefined };
      return { response, body: await response.json() };
    } catch {
      if (unknownOnFailure) throw new JiraIssueCreateUnknownError();
      throw new Error("Jira request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
