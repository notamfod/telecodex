import { describe, expect, it, vi } from "vitest";

import {
  advancePortfolioState,
  chunkChangedFiles,
  projectStateFor,
  runReviewPortfolio,
} from "../src/review-portfolio.js";
import type { Finding } from "../src/recipes.js";

const finding: Finding = {
  severity: "high",
  file: "src/service.ts",
  line: 12,
  category: "security",
  description: "missing authorization",
};

describe("chunkChangedFiles", () => {
  it("keeps every changed file without truncation", () => {
    const files = Array.from({ length: 47 }, (_, index) => `src/file-${index}.ts`);

    const chunks = chunkChangedFiles(files, 20);

    expect(chunks.map((chunk) => chunk.length)).toEqual([20, 20, 7]);
    expect(chunks.flat()).toEqual(files);
  });
});

describe("portfolio review state", () => {
  it("migrates the legacy mir-back pointer without applying it to other projects", () => {
    const legacy = { lastSha: "legacy-sha", seen: ["legacy-finding"] };

    expect(projectStateFor(legacy, "mir-back")).toEqual(legacy);
    expect(projectStateFor(legacy, "mir-widget")).toEqual({});
  });

  it("advances successful projects and preserves a failed project pointer", () => {
    const previous = {
      projects: {
        "mir-back": { lastSha: "back-old", seen: [] },
        "mir-widget": { lastSha: "widget-old", seen: ["existing"] },
      },
    };

    const next = advancePortfolioState(previous, [
      {
        name: "mir-back",
        status: "reviewed" as const,
        headSha: "back-new",
        findings: [finding],
      },
      {
        name: "mir-widget",
        status: "failed" as const,
        headSha: "widget-new",
        findings: [],
        error: "agent failed",
      },
    ]);

    expect(next.projects?.["mir-back"]?.lastSha).toBe("back-new");
    expect(next.projects?.["mir-back"]?.seen).toHaveLength(1);
    expect(next.projects?.["mir-widget"]).toEqual(previous.projects["mir-widget"]);
  });
});

describe("runReviewPortfolio", () => {
  it("falls back to a fresh baseline when the saved SHA is no longer an ancestor", async () => {
    const git = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "merge-base") throw new Error("not an ancestor");
      if (args[0] === "rev-list") return "fresh-base\n";
      if (args.includes("diff")) return "src/a.ts\0";
      return "";
    });

    const result = await runReviewPortfolio(
      {
        id: "daily-mircli-review",
        kind: "mircli-review",
        cwd: "/srv/mircli",
        worktreeRoot: "/var/cache/reviews",
        promptFile: "recipes/mircli-code-review.md",
      },
      { projects: { "mir-back": { lastSha: "rewritten-history" } } },
      {
        discover: async () => [{ name: "mir-back", sourcePath: "/srv/mircli/mir-back" }],
        prepare: async (project) => ({
          ...project,
          worktreePath: "/var/cache/reviews/mir-back",
          headSha: "head-sha",
          baseRef: "origin/main",
        }),
        git,
        reviewChunk: async () => [],
      },
    );

    expect(result.projects[0].baseSha).toBe("fresh-base");
    expect(git).toHaveBeenCalledWith(
      "/var/cache/reviews/mir-back",
      ["merge-base", "--is-ancestor", "rewritten-history", "head-sha"],
    );
  });

  it("reviews all projects independently and does not advance a partial failure", async () => {
    const files = Array.from({ length: 21 }, (_, index) => `src/file-${index}.ts`);
    const reviewChunk = vi.fn(async (input: { project: { name: string } }) => {
      if (input.project.name === "mir-widget") throw new Error("agent failed");
      return [finding];
    });
    const git = vi.fn(async (cwd: string, args: string[]) => {
      if (args.includes("diff") && cwd.endsWith("mir-back")) return `${files.join("\0")}\0`;
      if (args.includes("diff")) return "src/widget.ts\0";
      return "";
    });

    const result = await runReviewPortfolio(
      {
        id: "daily-mircli-review",
        kind: "mircli-review",
        cwd: "/srv/mircli",
        worktreeRoot: "/var/cache/telecodex/reviews",
        promptFile: "recipes/mircli-code-review.md",
      },
      {
        projects: {
          "mir-back": { lastSha: "back-old", seen: [] },
          "mir-widget": { lastSha: "widget-old", seen: [] },
        },
      },
      {
        discover: async () => [
          { name: "mir-back", sourcePath: "/srv/mircli/mir-back" },
          { name: "mir-widget", sourcePath: "/srv/mircli/mir-widget" },
        ],
        prepare: async (project) => ({
          ...project,
          worktreePath: `/var/cache/telecodex/reviews/${project.name}`,
          headSha: `${project.name}-new`,
          baseRef: "origin/main",
        }),
        git,
        reviewChunk,
      },
    );

    expect(result.projects.map((project) => [project.name, project.status])).toEqual([
      ["mir-back", "reviewed"],
      ["mir-widget", "failed"],
    ]);
    expect(reviewChunk).toHaveBeenCalledTimes(3);
    expect(result.projects[0].changedFiles).toEqual(files);
    expect(git).toHaveBeenCalledWith(
      "/var/cache/telecodex/reviews/mir-back",
      expect.arrayContaining(["core.quotePath=false", "--name-only", "-z"]),
    );

    const next = advancePortfolioState(
      {
        projects: {
          "mir-back": { lastSha: "back-old", seen: [] },
          "mir-widget": { lastSha: "widget-old", seen: [] },
        },
      },
      result.projects,
    );
    expect(next.projects?.["mir-back"]?.lastSha).toBe("mir-back-new");
    expect(next.projects?.["mir-widget"]?.lastSha).toBe("widget-old");
  });
});
