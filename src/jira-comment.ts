import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isJiraIssueKey } from "./inbox.js";

const MAX_COMMENT_LENGTH = 30_000;

export interface JiraCommentClientOptions {
  server: string;
  login: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class JiraCommentClient {
  private readonly server: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: JiraCommentClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async postComment(issueKey: string, body: string): Promise<void> {
    const key = issueKey.toUpperCase();
    if (!isJiraIssueKey(key)) {
      throw new Error(`Invalid Jira issue key: ${issueKey}`);
    }
    const response = await this.fetchImpl(
      `${this.server}/rest/api/2/issue/${key}/comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.login}:${this.options.token}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: body.slice(0, MAX_COMMENT_LENGTH) }),
      },
    );
    if (!response.ok) {
      throw new Error(`Jira comment failed: ${response.status} ${await response.text()}`);
    }
  }
}

export function buildJiraComment(answer: string, topicUrl: string): string {
  const suffix = `\n\nTelegram topic: ${topicUrl}`;
  const available = Math.max(0, MAX_COMMENT_LENGTH - suffix.length);
  return `${answer.slice(0, available)}${suffix}`.slice(-MAX_COMMENT_LENGTH);
}

export function canPostTicketToJira(ticket: {
  externalKey?: string;
  jiraCommentPostedAt?: number;
}): boolean {
  return ticket.jiraCommentPostedAt === undefined
    && ticket.externalKey !== undefined
    && isJiraIssueKey(ticket.externalKey);
}

export async function saveTicketAnswer(
  workspace: string,
  ticketId: number,
  answer: string,
): Promise<void> {
  const directory = ticketAnswerDirectory(workspace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${ticketId}.md`), answer, { encoding: "utf8", mode: 0o600 });
}

export function readTicketAnswer(workspace: string, ticketId: number): Promise<string> {
  return readFile(path.join(ticketAnswerDirectory(workspace), `${ticketId}.md`), "utf8");
}

function ticketAnswerDirectory(workspace: string): string {
  return path.join(workspace, ".telecodex", "ticket-answers");
}
