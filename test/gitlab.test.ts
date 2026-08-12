import { describe, expect, it } from "vitest";

import {
  GitLabClient,
  buildReviewPrompt,
  formatChanges,
  mergeRequestButtons,
  mergeRequestTopicName,
  renderMergeRequestCardHTML,
  type MergeRequestSummary,
  buildDoneComment,
  linkedMergeRequests,
  renderDraftHTML,
} from "../src/gitlab.js";

function mr(overrides: Partial<MergeRequestSummary> = {}): MergeRequestSummary {
  return {
    projectId: 48,
    iid: 19,
    project: "api",
    title: "chore: restrict schema description to MCP tables",
    author: "alice",
    sourceBranch: "chore/restrict-schema-description",
    targetBranch: "main",
    webUrl: "https://gitlab.example.com/acme/apps/api/-/merge_requests/19",
    draft: false,
    ...overrides,
  };
}

function makeMr(over: Partial<MergeRequestSummary>): MergeRequestSummary {
  return {
    projectId: 10,
    iid: 1,
    project: "mir-back",
    title: "cleanup",
    author: "alice",
    sourceBranch: "main",
    targetBranch: "main",
    webUrl: "https://gitlab.example.com/x/-/merge_requests/1",
    draft: false,
    ...over,
  };
}

describe("linkedMergeRequests", () => {
  const mrs = [
    makeMr({ iid: 1, title: "MIR-6319 fix: hide badge", sourceBranch: "MIR-6319" }),
    makeMr({ iid: 2, title: "cleanup", sourceBranch: "MIR-6319-backend" }),
    makeMr({ iid: 3, projectId: 11, title: "MIR-9999 other", sourceBranch: "MIR-9999" }),
  ];

  it("matches the key in the title", () => {
    expect(linkedMergeRequests(mrs, "MIR-6319").map((found) => found.iid)).toContain(1);
  });

  it("matches the key in the branch name, which is how most MRs carry it", () => {
    expect(linkedMergeRequests(mrs, "MIR-6319").map((found) => found.iid)).toContain(2);
  });

  it("leaves unrelated merge requests alone", () => {
    expect(linkedMergeRequests(mrs, "MIR-6319").map((found) => found.iid)).not.toContain(3);
  });

  it("ignores case", () => {
    expect(linkedMergeRequests(mrs, "mir-9999")).toHaveLength(1);
  });

  it("finds nothing for a key nobody used", () => {
    expect(linkedMergeRequests(mrs, "MIR-1")).toEqual([]);
  });
});

describe("buildDoneComment", () => {
  it("leads with the ticket key so the thread is searchable", () => {
    expect(buildDoneComment("MIR-6319", "поправил бейдж")).toMatch(/^MIR-6319/);
  });

  it("keeps the author's text", () => {
    expect(buildDoneComment("MIR-6319", "поправил бейдж")).toContain("поправил бейдж");
  });

  it("still says something useful when no text was given", () => {
    const body = buildDoneComment("MIR-6319", "");

    expect(body).toContain("MIR-6319");
    expect(body).toMatch(/готов/i);
  });

  it("marks itself as posted by the bot, so a reviewer is not misled", () => {
    expect(buildDoneComment("MIR-6319", "готово")).toMatch(/telecodex/i);
  });
});

describe("renderDraftHTML", () => {
  const target = makeMr({ iid: 7, title: "MIR-6319 fix: hide badge", sourceBranch: "MIR-6319" });

  it("shows which merge request will receive the comment", () => {
    const html = renderDraftHTML(target, "MIR-6319 готово");

    expect(html).toContain("!7");
    expect(html).toContain("MIR-6319 fix: hide badge");
  });

  it("shows the comment body verbatim so it can be checked before sending", () => {
    expect(renderDraftHTML(target, "MIR-6319 готово")).toContain("MIR-6319 готово");
  });

  it("escapes markup in the body", () => {
    expect(renderDraftHTML(target, "<b>готово</b>")).toContain("&lt;b&gt;");
  });
});

describe("GitLabClient.listOpenMergeRequests", () => {
  const payload = [
    {
      iid: 19,
      project_id: 48,
      title: "chore: restrict schema description to MCP tables",
      source_branch: "chore/restrict-schema-description",
      target_branch: "main",
      draft: false,
      web_url: "https://gitlab.example.com/acme/apps/api/-/merge_requests/19",
      author: { username: "alice" },
      references: { full: "acme/apps/api!19" },
    },
  ];

  it("names the project from the reference path", async () => {
    const client = new GitLabClient("https://gitlab.example.com/", "token", async () => ({
      ok: true,
      json: async () => payload,
    }));

    const [first] = await client.listOpenMergeRequests("46");

    expect(first.project).toBe("api");
    expect(first.projectId).toBe(48);
    expect(first.author).toBe("alice");
  });

  it("sends the token as a header and asks only for open ones", async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
    const client = new GitLabClient("https://gitlab.example.com/", "secret", async (url, init) => {
      calls.push({ url: String(url), init: init as { headers: Record<string, string> } });
      return { ok: true, json: async () => payload };
    });

    await client.listOpenMergeRequests("46");

    expect(calls[0].url).toContain("/api/v4/groups/46/merge_requests");
    expect(calls[0].url).toContain("state=opened");
    expect(calls[0].init.headers["PRIVATE-TOKEN"]).toBe("secret");
  });

  it("reports a failed request instead of returning nothing", async () => {
    const client = new GitLabClient("https://gitlab.example.com", "token", async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: "401 Unauthorized" }),
    }));

    await expect(client.listOpenMergeRequests("46")).rejects.toThrow(/401/);
  });
});

describe("mergeRequestTopicName", () => {
  it("leads with the merge request reference and its project", () => {
    expect(mergeRequestTopicName(mr())).toBe(
      "!19 api: chore: restrict schema description to M…",
    );
  });

  it("marks a draft so it is obvious in the topic list", () => {
    expect(mergeRequestTopicName(mr({ iid: 1207, title: "Resolve MIR-5476", draft: true }))).toBe(
      "!1207 api: [draft] Resolve MIR-5476",
    );
  });
});

describe("mergeRequestButtons", () => {
  it("carries project and merge request ids so a tap survives a restart", () => {
    expect(mergeRequestButtons([mr()])).toEqual([
      {
        label: "!19 api · chore: restrict schema description to MCP tables",
        callbackData: "mr:48:19",
      },
    ]);
  });
});

describe("formatChanges", () => {
  const changes = [
    { newPath: "src/schema.ts", oldPath: "src/schema.ts", diff: "@@ -1 +1 @@\\n-a\\n+b\\n" },
    { newPath: "README.md", oldPath: "README.md", diff: "@@ -2 +2 @@\\n-c\\n+d\\n" },
  ];

  it("labels every file with its patch", () => {
    const { text, truncated } = formatChanges(changes, 10_000);

    expect(text).toContain("--- src/schema.ts");
    expect(text).toContain("--- README.md");
    expect(truncated).toBe(false);
  });

  it("stops at the limit and says so rather than silently cutting", () => {
    const { text, truncated } = formatChanges(changes, 40);

    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(200);
    expect(text).toContain("обрезан");
  });
});

describe("buildReviewPrompt", () => {
  it("gives the reviewer the branches, the diff and a read-only instruction", () => {
    const prompt = buildReviewPrompt(
      mr(),
      [{ newPath: "src/schema.ts", oldPath: "src/schema.ts", diff: "@@ -1 +1 @@" }],
      10_000,
    );

    expect(prompt).toContain("!19");
    expect(prompt).toContain("chore/restrict-schema-description → main");
    expect(prompt).toContain("src/schema.ts");
    expect(prompt).toContain("@@ -1 +1 @@");
    expect(prompt).toContain("ничего не меняй");
  });

  it("warns that the checkout does not match the branch under review", () => {
    const prompt = buildReviewPrompt(mr(), [], 10_000);

    expect(prompt).toMatch(/рабочая копия.*не переключена|дифф.*источник правды/i);
  });
});

describe("renderMergeRequestCardHTML", () => {
  it("escapes a title that carries angle brackets", () => {
    const html = renderMergeRequestCardHTML(mr({ title: "fix <Card> render" }), []);

    expect(html).toContain("fix &lt;Card&gt; render");
    expect(html).not.toContain("<Card>");
  });
});
