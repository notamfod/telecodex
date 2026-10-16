import { describe, expect, it } from "vitest";

import { JiraIssueCreateClient, JiraIssueCreateUnknownError } from "../src/jira-issue-create.js";
import { pipelineDraftText } from "../src/review-pipeline-render.js";
import type { PipelineJob } from "../src/review-pipeline-store.js";

const job: PipelineJob = { id: "a".repeat(24), source: { recipe: "review", project: "mir-back", cwd: "/work", headSha: "b".repeat(40), finding: { severity: "high", file: "src/a.ts", line: 3, category: "state", description: "lost" } }, status: "creating", round: 1, reports: [], draft: { summary: "[Backend]: retain state", priority: "High", problem: "State is lost.", fix: "Store the state.", benefit: "Keeps the request valid.", acceptance: ["Retry retains state."] }, nextAttemptAt: 0 };

describe("JiraIssueCreateClient", () => {
  it("finds an existing label and creates a concise Bug using HTTPS", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ issues: [{ key: "MIR-12" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-13" }), { status: 201 }));
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test/", login: "a", token: "secret", fetchImpl });
    await expect(client.findByLabel("telecodex-review-job-1")).resolves.toEqual({ key: "MIR-12", url: "https://jira.example.test/browse/MIR-12" });
    await client.create(job, "telecodex-review-job-1");
    const created = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(created.fields).toMatchObject({ project: { key: "MIR" }, issuetype: { name: "Bug" }, priority: { name: "High" }, labels: ["telecodex-review-job-1"] });
    expect(created.fields.description).toBe(pipelineDraftText(job));
  });

  it("rejects unsafe labels and non-HTTPS servers before transport", async () => {
    const fetchImpl = vi.fn();
    const unsafe = new JiraIssueCreateClient({ server: "http://jira.example.test", login: "a", token: "b", fetchImpl });
    await expect(unsafe.findByLabel("telecodex-review-ok")).rejects.toThrow(/HTTPS/i);
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "b", fetchImpl });
    await expect(client.findByLabel("x\" OR project = OTHER")).rejects.toThrow(/label/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not treat malformed or truncated search results as no existing issue", async () => {
    const malformed = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "b", fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ issues: [{ key: "OTHER-1" }] }), { status: 200 })) });
    await expect(malformed.findByLabel("telecodex-review-job-1")).rejects.toThrow(/issue key/i);
    const truncated = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "b", fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 2, issues: [{ key: "MIR-1" }] }), { status: 200 })) });
    await expect(truncated.findByLabel("telecodex-review-job-1")).rejects.toThrow(/ambiguous/i);
  });

  it("does not retry or hide ambiguous create failures", async () => {
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "b", fetchImpl: vi.fn().mockResolvedValue(new Response("oops", { status: 500 })) });
    await expect(client.create(job, "telecodex-review-job-1")).rejects.toBeInstanceOf(JiraIssueCreateUnknownError);
  });

  it("treats rejected requests as definitive even if Jira returns non-JSON text", async () => {
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "b", fetchImpl: vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })) });
    await expect(client.create(job, "telecodex-review-job-1")).rejects.toThrow("rejected: 429");
  });
});
