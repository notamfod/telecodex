import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enrichFindingMetadata,
  gitRemoteWebUrl,
  keepSafeReviewFindings,
} from "../src/review-metadata.js";
import type { Finding } from "../src/recipes.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function finding(file: string): Finding {
  return {
    severity: "high",
    priority: "P1",
    aspect: "security",
    file,
    line: 7,
    category: "path-traversal",
    description: "unsafe path",
  };
}

describe("keepSafeReviewFindings", () => {
  it("rejects traversal, absolute and unchanged paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "telecodex-review-paths-"));
    directories.push(root);
    writeFileSync(path.join(root, "changed.ts"), "export {};\n");

    const kept = keepSafeReviewFindings(
      [finding("changed.ts"), finding("../outside.ts"), finding("/etc/passwd"), finding("old.ts")],
      root,
      ["changed.ts"],
    );

    expect(kept.map((entry) => entry.file)).toEqual(["changed.ts"]);
  });

  it("rejects a changed symlink that escapes the worktree", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "telecodex-review-symlink-"));
    directories.push(parent);
    const root = path.join(parent, "worktree");
    const outside = path.join(parent, "secret.txt");
    mkdirSync(root);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, path.join(root, "secret.txt"));

    const kept = keepSafeReviewFindings([finding("secret.txt")], root, ["secret.txt"]);

    expect(kept).toEqual([]);
  });
});

describe("review commit metadata", () => {
  it("normalizes GitLab SSH remotes", () => {
    expect(gitRemoteWebUrl("git@gitlab.mircli.ru:mircli-ru/apps/mir-back.git")).toBe(
      "https://gitlab.mircli.ru/mircli-ru/apps/mir-back",
    );
  });

  it("gets the author and commit link from blame on the exact head", async () => {
    const git = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "blame") {
        return [
          "abcdef1234567890 7 7 1",
          "author Иван Иванов",
          "author-mail <ivan@example.com>",
        ].join("\n");
      }
      if (args[0] === "remote") {
        return "git@gitlab.mircli.ru:mircli-ru/apps/mir-back.git\n";
      }
      return "";
    });

    const enriched = await enrichFindingMetadata(
      finding("src/service.ts"),
      {
        worktreePath: "/cache/mir-back",
        baseSha: "base123",
        headSha: "head456",
      },
      { git },
    );

    expect(enriched).toMatchObject({
      author: "Иван Иванов",
      commitSha: "abcdef1234567890",
      commitUrl: "https://gitlab.mircli.ru/mircli-ru/apps/mir-back/-/commit/abcdef1234567890",
    });
    expect(git).toHaveBeenCalledWith("/cache/mir-back", [
      "blame",
      "--line-porcelain",
      "-L",
      "7,7",
      "head456",
      "--",
      "src/service.ts",
    ]);
  });
});
