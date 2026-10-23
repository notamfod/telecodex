import { describe, expect, it } from "vitest";

import { JiraIssueCreateClient, JiraIssueCreateUnknownError } from "../src/jira-issue-create.js";
import { pipelineDraftText } from "../src/review-pipeline-render.js";
import type { PipelineJob } from "../src/review-pipeline-store.js";

const job: PipelineJob = { id: "a".repeat(24), source: { recipe: "review", project: "mir-back", cwd: "/work", headSha: "b".repeat(40), finding: { severity: "high", file: "src/a.ts", line: 3, category: "state", description: "lost" } }, status: "creating", round: 1, reports: [], draft: { summary: "[Backend]: retain state", priority: "High", problem: "State is lost.", fix: "Store the state.", benefit: "Keeps the request valid.", acceptance: ["Retry retains state."] }, nextAttemptAt: 0 };
job.reports = [0, 1].map(() => ({ verdict: "confirmed", reason: "Retry loses saved state.", evidence: ["src/a.ts:3"], draft: job.draft,
  assessment: { component: "Backend", labels: ["Фасеты", "акции"], kind: "bug", basis: "The retry path discards persisted state.",
    trigger: "Retry a saved request.", expected: "Saved state is retained.", actual: "State is lost." } }));

describe("JiraIssueCreateClient", () => {
  it("rejects an unavailable reviewed component before creating the issue", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      key: "MIR", components: [{ id: "10701", name: "Frontend" }],
      issueTypes: [{ id: "10004", name: "Ошибка", subtask: false }],
    }), { status: 200 }));
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl });
    await expect(client.create(job, "telecodex-review-job-1")).rejects.toThrow(/component/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps an explicitly reviewed taxonomy gap visible instead of inventing a functional label", async () => {
    const input = { ...job, reports: job.reports.map(report => ({ ...report,
      assessment: { ...report.assessment!, labels: [], labelsReason: "No MCP lifecycle label exists in Jira." },
    })) };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      key: "MIR", components: [{ id: "10700", name: "Backend" }],
      issueTypes: [{ id: "10004", name: "Ошибка", subtask: false }],
    }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-15" }), { status: 201 }));
    await new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl })
      .create(input, "telecodex-review-job-1");
    const fields = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).fields;
    expect(fields.labels).toEqual(["review"]);
    expect(fields.description).toContain("No MCP lifecycle label exists in Jira.");
  });

  it("finds an existing label and creates a concise Bug using the localized MIR type id", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ issues: [{ key: "MIR-12" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: "MIR", components: [{ id: "10700", name: "Backend" }], issueTypes: [{ id: "10004", name: "Ошибка", subtask: false }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-13" }), { status: 201 }));
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test/", login: "a", token: "secret", fetchImpl });
    await expect(client.findByLabel("telecodex-review-job-1")).resolves.toEqual({ key: "MIR-12", url: "https://jira.example.test/browse/MIR-12" });
    await client.create(job, "telecodex-review-job-1");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://jira.example.test/rest/api/2/project/MIR");
    const created = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    expect(created.fields).toMatchObject({ project: { key: "MIR" }, issuetype: { id: "10004" }, priority: { name: "High" }, labels: ["review", "Фасеты", "акции"], components: [{ id: "10700" }] });
    expect(created.properties).toEqual([{ key: "telecodex-review", value: { id: "telecodex-review-job-1" } }]);
    expect(created.fields.description).toBe(pipelineDraftText(job));
    expect(created.fields.description).toContain("Проект: mir-back\nКомпонент: Backend\nМетки: review, Фасеты, акции\nТип: Ошибка");
  });

  it("creates an improvement as a Task and uses the reviewed component in the title", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      key: "MIR", components: [{ id: "10700", name: "Backend" }], issueTypes: [{ id: "10002", name: "Задача", subtask: false }, { id: "10004", name: "Ошибка", subtask: false }],
    }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-14" }), { status: 201 }));
    const input: PipelineJob = { ...job, draft: { ...job.draft!, summary: "[Frontend]: reduce extra requests" },
      reports: job.reports.map(report => ({ ...report, assessment: { component: "Backend", labels: ["Фасеты", "акции"], kind: "improvement", basis: "Avoid redundant background work." } })) };
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl });
    await client.create(input, "telecodex-review-job-1");
    const fields = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).fields;
    expect(fields.issuetype).toEqual({ id: "10002" });
    expect(fields.summary).toBe("[Backend]: reduce extra requests");
    expect(fields.description).toContain("Тип: Улучшение (задача)");
  });

  it("blocks creation before transport when classification is absent or disagrees", async () => {
    const fetchImpl = vi.fn();
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl });
    await expect(client.create({ ...job, reports: [] }, "telecodex-review-job-1")).rejects.toThrow(/assessment|classification/i);
    const reports = [...job.reports];
    reports[1] = { ...reports[1]!, assessment: { component: "Backend", labels: ["Фасеты", "акции"], kind: "improvement", basis: "Not a broken contract." } };
    await expect(client.create({ ...job, reports }, "telecodex-review-job-1")).rejects.toThrow(/assessment|classification/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fall back to Bug when the requested Task type is unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      key: "MIR", components: [{ id: "10700", name: "Backend" }], issueTypes: [{ id: "10004", name: "Ошибка", subtask: false }],
    }), { status: 200 }));
    const input: PipelineJob = { ...job, reports: job.reports.map(report => ({ ...report,
      assessment: { component: "Backend", labels: ["Фасеты", "акции"], kind: "improvement", basis: "Reduce background work." } })) };
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl });
    await expect(client.create(input, "telecodex-review-job-1")).rejects.toThrow(/Task/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reconciles the internal property after replacing technical labels with the review label", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ issues: [{ key: "MIR-13" }, { key: "MIR-14" }], total: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-13", properties: { "telecodex-review": { id: "telecodex-review-another" } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-14", properties: { "telecodex-review": { id: "telecodex-review-job-1" } } }), { status: 200 }));
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl });
    await expect(client.findByLabel("telecodex-review-job-1", job)).resolves.toEqual({ key: "MIR-14", url: "https://jira.example.test/browse/MIR-14" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).jql).toContain(`description ~ "${job.source.headSha.slice(0, 12)}"`);
    expect(fetchImpl.mock.calls[2]?.[0]).toContain("properties=telecodex-review");
  });

  it("fails closed for a truncated property lookup or multiple matching properties", async () => {
    const empty = () => new Response(JSON.stringify({ issues: [] }), { status: 200 });
    const candidates = () => new Response(JSON.stringify({ issues: [{ key: "MIR-1" }, { key: "MIR-2" }], total: 2 }), { status: 200 });
    const fetchImpl = vi.fn().mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(new Response(JSON.stringify({ issues: [{ key: "MIR-1" }], total: 2 }), { status: 200 }));
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl });
    await expect(client.findByLabel("telecodex-review-job-1", job)).rejects.toThrow(/truncated/i);
    fetchImpl.mockResolvedValueOnce(empty()).mockResolvedValueOnce(candidates())
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-1", properties: { "telecodex-review": { id: "telecodex-review-job-1" } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-2", properties: { "telecodex-review": { id: "telecodex-review-job-1" } } }), { status: 200 }));
    await expect(client.findByLabel("telecodex-review-job-1", job)).rejects.toThrow(/ambiguous/i);
  });

  it("accepts the English Bug type name from MIR project metadata", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: "MIR", components: [{ id: "10700", name: "Backend" }], issueTypes: [{ id: "10004", name: "Bug", subtask: false }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: "MIR-13" }), { status: 201 }));
    const client = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl });

    await expect(client.create(job, "telecodex-review-job-1")).resolves.toEqual({
      key: "MIR-13", url: "https://jira.example.test/browse/MIR-13",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).fields.issuetype).toEqual({ id: "10004" });
  });

  it("fails before create when MIR issue metadata is unavailable or ambiguous", async () => {
    const unavailable = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const unavailableClient = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl: unavailable });
    await expect(unavailableClient.create(job, "telecodex-review-job-1")).rejects.not.toBeInstanceOf(JiraIssueCreateUnknownError);
    expect(unavailable).toHaveBeenCalledOnce();

    const ambiguous = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      key: "MIR", components: [{ id: "10700", name: "Backend" }], issueTypes: [
        { id: "10004", name: "Bug", subtask: false },
        { id: "10005", name: "Ошибка", subtask: false },
      ],
    }), { status: 200 }));
    const ambiguousClient = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "secret", fetchImpl: ambiguous });
    await expect(ambiguousClient.create(job, "telecodex-review-job-1")).rejects.not.toBeInstanceOf(JiraIssueCreateUnknownError);
    expect(ambiguous).toHaveBeenCalledOnce();
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
    const inconsistentFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 1, issues: [] }), { status: 200 }));
    const inconsistent = new JiraIssueCreateClient({ server: "https://jira.example.test", login: "a", token: "b", fetchImpl: inconsistentFetch });
    await expect(inconsistent.findByLabel("telecodex-review-job-1", job)).rejects.toThrow(/truncated/i);
    expect(inconsistentFetch).toHaveBeenCalledOnce();
  });

  it("does not retry or hide ambiguous create failures", async () => {
    const client = new JiraIssueCreateClient({
      server: "https://jira.example.test", login: "a", token: "b", fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          key: "MIR", components: [{ id: "10700", name: "Backend" }], issueTypes: [{ id: "10004", name: "Ошибка", subtask: false }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response("oops", { status: 500 })),
    });
    await expect(client.create(job, "telecodex-review-job-1")).rejects.toBeInstanceOf(JiraIssueCreateUnknownError);
  });

  it("treats rejected requests as definitive even if Jira returns non-JSON text", async () => {
    const client = new JiraIssueCreateClient({
      server: "https://jira.example.test", login: "a", token: "b", fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          key: "MIR", components: [{ id: "10700", name: "Backend" }], issueTypes: [{ id: "10004", name: "Bug", subtask: false }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 })),
    });
    await expect(client.create(job, "telecodex-review-job-1")).rejects.toThrow("rejected: 429");
  });
});
