import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  JiraCommentClient,
  buildJiraComment,
  canPostTicketToJira,
  readTicketAnswer,
  saveTicketAnswer,
} from "../src/jira-comment.js";

describe("JiraCommentClient", () => {
  it("posts a Jira Server comment with Basic authentication", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    const client = new JiraCommentClient({
      server: "https://jira.example.test/",
      login: "agent@example.test",
      token: "secret-token",
      fetchImpl,
    });

    await client.postComment("mir-123", "Analysis result");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://jira.example.test/rest/api/2/issue/MIR-123/comment",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from("agent@example.test:secret-token").toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "Analysis result" }),
      }),
    );
  });

  it("rejects invalid issue keys before making a request", async () => {
    const fetchImpl = vi.fn();
    const client = new JiraCommentClient({
      server: "https://jira.example.test",
      login: "agent",
      token: "token",
      fetchImpl,
    });

    await expect(client.postComment("#123", "body")).rejects.toThrow("Invalid Jira issue key");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps comment bodies at 30000 characters", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    const client = new JiraCommentClient({
      server: "https://jira.example.test",
      login: "agent",
      token: "token",
      fetchImpl,
    });

    await client.postComment("MIR-1", "x".repeat(31_000));

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.body).toHaveLength(30_000);
  });

  it("reports Jira HTTP failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    const client = new JiraCommentClient({
      server: "https://jira.example.test",
      login: "agent",
      token: "token",
      fetchImpl,
    });

    await expect(client.postComment("MIR-1", "body")).rejects.toThrow(
      "Jira comment failed: 403 denied",
    );
  });

  it("preserves the Telegram topic link within the Jira size cap", () => {
    const topicUrl = "https://t.me/c/123/456";
    const body = buildJiraComment("x".repeat(31_000), topicUrl);

    expect(body).toHaveLength(30_000);
    expect(body).toContain(topicUrl);
  });

  it("offers posting only for an unposted Jira-key ticket", () => {
    expect(canPostTicketToJira({ externalKey: "MIR-123" })).toBe(true);
    expect(canPostTicketToJira({ externalKey: "#123" })).toBe(false);
    expect(canPostTicketToJira({ externalKey: "MIR-123", jiraCommentPostedAt: 1 })).toBe(false);
  });
});

describe("ticket answer storage", () => {
  it("stores and reads the cleaned answer under the ticket id", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telecodex-jira-answer-"));
    try {
      await saveTicketAnswer(root, 42, "Clean analysis\n");

      expect(await readTicketAnswer(root, 42)).toBe("Clean analysis\n");
      expect(readFileSync(path.join(root, ".telecodex", "ticket-answers", "42.md"), "utf8"))
        .toBe("Clean analysis\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
