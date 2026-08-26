import { describe, expect, it } from "vitest";

import {
  buildReviewChunkPrompt,
  changedLineMapFromDiff,
  keepFindingsOnChangedLines,
  parseStrictReviewOutput,
} from "../src/review-agent.js";
import type { Finding } from "../src/recipes.js";

describe("buildReviewChunkPrompt", () => {
  it("binds the agent to the exact range, project and complete chunk file list", () => {
    const prompt = buildReviewChunkPrompt("Review {{PROJECT}} in {{CWD}}", {
      project: {
        name: "mir-back",
        sourcePath: "/srv/mircli/mir-back",
        worktreePath: "/var/cache/reviews/mir-back",
        headSha: "head-sha",
        baseRef: "origin/main",
      },
      baseSha: "base-sha",
      headSha: "head-sha",
      files: ["src/a.php", "src/b.php"],
      chunkIndex: 1,
      totalChunks: 3,
    });

    expect(prompt).toContain("Review mir-back in /var/cache/reviews/mir-back");
    expect(prompt).toContain("base-sha..head-sha");
    expect(prompt).toContain("часть 2 из 3");
    expect(prompt).toContain("- src/a.php\n- src/b.php");
    expect(prompt).toContain("git diff base-sha..head-sha -- src/a.php src/b.php");
  });

  it("quotes unusual Git paths instead of turning them into shell syntax", () => {
    const prompt = buildReviewChunkPrompt("Review", {
      project: {
        name: "repo",
        sourcePath: "/src/repo",
        worktreePath: "/cache/repo",
        headSha: "head",
        baseRef: "origin/main",
      },
      baseSha: "base",
      headSha: "head",
      files: ["src/a; touch escaped"],
      chunkIndex: 0,
      totalChunks: 1,
    });

    expect(prompt).toContain("'src/a; touch escaped'");
    expect(prompt).not.toContain("-- src/a; touch escaped");
  });
});

describe("changed-line validation", () => {
  const finding = (line: number): Finding => ({
    severity: "high",
    file: "src/a.ts",
    line,
    category: "bug",
    description: "broken",
  });

  it("parses all added line ranges from a zero-context diff", () => {
    const ranges = changedLineMapFromDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2,0 +3,2 @@",
      "+a",
      "+b",
      "@@ -10 +12 @@",
      "+c",
    ].join("\n"));

    expect([...ranges.get("src/a.ts") ?? []]).toEqual([3, 4, 12]);
  });

  it("keeps line findings only when the reported line changed", () => {
    const ranges = new Map([["src/a.ts", new Set([3, 4])]]);

    expect(keepFindingsOnChangedLines([finding(3), finding(9)], ranges)).toEqual([finding(3)]);
  });
});

describe("parseStrictReviewOutput", () => {
  it("rejects prose or malformed findings so the state cannot advance", () => {
    expect(() => parseStrictReviewOutput("Всё хорошо")).toThrow(/invalid review output/i);
    expect(() => parseStrictReviewOutput(
      "FINDING|P1|security|src/a.ts:3|idor|broken\nextra prose",
    )).toThrow(/invalid review output/i);
  });

  it("accepts the explicit no-findings marker", () => {
    expect(parseStrictReviewOutput("NO_FINDINGS\n")).toEqual([]);
  });
});
