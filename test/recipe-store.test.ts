import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RecipeMutes, readPendingRun, writePendingRun } from "../src/recipe-store.js";
import { parseFindings } from "../src/recipes.js";

function statePath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "telecodex-recipes-")), "recipes.json");
}

const findings = parseFindings(
  [
    "FINDING|high|app/A.php:1|n+1|первая",
    "FINDING|low|app/B.php:2|index|вторая",
  ].join("\n"),
);

describe("pending runs", () => {
  it("hands the bot back the findings the runner delivered", () => {
    const file = statePath();
    writePendingRun(file, 7, { recipe: "daily-diff-review", cwd: "/repo", findings });

    expect(readPendingRun(file, 7)?.findings.map((f) => f.description)).toEqual([
      "первая",
      "вторая",
    ]);
  });

  it("keeps the recipe's working directory, which the fix thread needs", () => {
    const file = statePath();
    writePendingRun(file, 7, { recipe: "migration-audit", cwd: "/repo/mir-back", findings });

    expect(readPendingRun(file, 7)?.cwd).toBe("/repo/mir-back");
  });

  it("has nothing for a run id it never stored", () => {
    expect(readPendingRun(statePath(), 99)).toBeUndefined();
  });

  it("survives a missing state file rather than throwing at the button press", () => {
    expect(readPendingRun("/nonexistent/telecodex/recipes.json", 1)).toBeUndefined();
  });

  it("keeps earlier runs reachable, so yesterday's buttons still work", () => {
    const file = statePath();
    writePendingRun(file, 1, { recipe: "r", cwd: "/repo", findings });
    writePendingRun(file, 2, { recipe: "r", cwd: "/repo", findings });

    expect(readPendingRun(file, 1)).toBeDefined();
    expect(readPendingRun(file, 2)).toBeDefined();
  });

  it("does not clobber the runner's other state", () => {
    const file = statePath();
    writePendingRun(file, 1, { recipe: "r", cwd: "/repo", findings });
    writePendingRun(file, 2, { recipe: "r", cwd: "/repo", findings });

    expect(readPendingRun(file, 1)?.recipe).toBe("r");
  });
});

describe("RecipeMutes", () => {
  function mutesPath(): string {
    return path.join(mkdtempSync(path.join(tmpdir(), "telecodex-mutes-")), "recipe-mutes.json");
  }

  it("starts empty", () => {
    expect(new RecipeMutes(mutesPath()).list()).toEqual([]);
  });

  it("remembers a muted fingerprint across restarts", () => {
    const file = mutesPath();
    new RecipeMutes(file).add("app/A.php|n+1|первая");

    expect(new RecipeMutes(file).list()).toEqual(["app/A.php|n+1|первая"]);
  });

  it("does not store the same fingerprint twice", () => {
    const file = mutesPath();
    const mutes = new RecipeMutes(file);
    mutes.add("dup");
    mutes.add("dup");

    expect(mutes.list()).toEqual(["dup"]);
  });

  it("reports an unreadable file as no mutes rather than failing the run", () => {
    expect(new RecipeMutes("/nonexistent/telecodex/recipe-mutes.json").list()).toEqual([]);
  });
});
