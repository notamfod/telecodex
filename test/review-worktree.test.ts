import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  discoverReviewProjects,
  prepareReviewWorktree,
} from "../src/review-worktree.js";

describe("discoverReviewProjects", () => {
  it("returns every first-level Git repository in stable order", async () => {
    const git = vi.fn(async (cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir" && !cwd.endsWith("artifacts")) {
        return ".git\n";
      }
      throw new Error("not a repository");
    });

    const projects = await discoverReviewProjects("/srv/mircli", {
      listDirectories: async () => ["mir-widget", "artifacts", "mir-back"],
      git,
    });

    expect(projects).toEqual([
      { name: "mir-back", sourcePath: "/srv/mircli/mir-back" },
      { name: "mir-widget", sourcePath: "/srv/mircli/mir-widget" },
    ]);
  });
});

describe("prepareReviewWorktree", () => {
  it("creates a detached worktree at the freshly fetched origin/main SHA", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main^{commit}") {
        return "abc123\n";
      }
      return "";
    });
    const mkdir = vi.fn(async () => undefined);

    const prepared = await prepareReviewWorktree(
      { name: "mir-back", sourcePath: "/srv/mircli/mir-back" },
      "/var/cache/telecodex/reviews",
      { git, pathExists: () => false, mkdir },
    );

    expect(prepared).toEqual({
      name: "mir-back",
      sourcePath: "/srv/mircli/mir-back",
      worktreePath: "/var/cache/telecodex/reviews/mir-back",
      headSha: "abc123",
      baseRef: "origin/main",
    });
    expect(calls).toContainEqual({
      cwd: "/srv/mircli/mir-back",
      args: ["fetch", "--quiet", "origin", "main"],
    });
    expect(calls).toContainEqual({
      cwd: "/srv/mircli/mir-back",
      args: ["worktree", "add", "--detach", "/var/cache/telecodex/reviews/mir-back", "abc123"],
    });
    expect(mkdir).toHaveBeenCalledWith("/var/cache/telecodex/reviews");
  });

  it("updates an existing clean worktree without touching its source checkout", async () => {
    const target = path.join("/var/cache/telecodex/reviews", "mir-back");
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main^{commit}") {
        return "def456\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return "/srv/mircli/mir-back/.git\n";
      }
      if (args[0] === "status") return "";
      return "";
    });

    const prepared = await prepareReviewWorktree(
      { name: "mir-back", sourcePath: "/srv/mircli/mir-back" },
      "/var/cache/telecodex/reviews",
      { git, pathExists: () => true, mkdir: async () => undefined },
    );

    expect(prepared.headSha).toBe("def456");
    expect(calls).toContainEqual({ cwd: target, args: ["status", "--porcelain"] });
    expect(calls).toContainEqual({ cwd: target, args: ["checkout", "--detach", "def456"] });
    expect(calls).not.toContainEqual(expect.objectContaining({
      cwd: "/srv/mircli/mir-back",
      args: expect.arrayContaining(["reset"]),
    }));
  });

  it("refuses to overwrite a dirty managed worktree", async () => {
    const git = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main^{commit}") {
        return "abc123\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return "/srv/mircli/mir-back/.git\n";
      }
      if (args[0] === "status") return " M src/file.ts\n";
      return "";
    });

    await expect(prepareReviewWorktree(
      { name: "mir-back", sourcePath: "/srv/mircli/mir-back" },
      "/var/cache/telecodex/reviews",
      { git, pathExists: () => true, mkdir: async () => undefined },
    )).rejects.toThrow(/dirty/i);

    expect(git).not.toHaveBeenCalledWith(
      "/var/cache/telecodex/reviews/mir-back",
      ["checkout", "--detach", expect.any(String)],
    );
  });

  it("refuses an existing worktree owned by another repository", async () => {
    const git = vi.fn(async (cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main^{commit}") {
        return "abc123\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return cwd === "/srv/mircli/mir-back"
          ? "/srv/mircli/mir-back/.git\n"
          : "/srv/other/.git\n";
      }
      return "";
    });

    await expect(prepareReviewWorktree(
      { name: "mir-back", sourcePath: "/srv/mircli/mir-back" },
      "/var/cache/telecodex/reviews",
      { git, pathExists: () => true, mkdir: async () => undefined },
    )).rejects.toThrow(/does not belong/i);
  });
});
