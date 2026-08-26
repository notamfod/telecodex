import { describe, expect, it } from "vitest";

import { parseRecipes } from "../src/recipe-config.js";

const minimal = {
  recipes: [{
    id: "daily",
    cwd: "/srv/project",
    worktreeRoot: "/var/cache/telecodex/reviews",
    promptFile: "recipes/daily.md",
  }],
};

describe("parseRecipes", () => {
  it("fills in the parts a recipe may leave out", () => {
    const [recipe] = parseRecipes(JSON.stringify(minimal));

    expect(recipe).toEqual({
      id: "daily",
      cwd: "/srv/project",
      worktreeRoot: "/var/cache/telecodex/reviews",
      promptFile: "recipes/daily.md",
      baseRef: "",
      paths: [],
    });
  });

  it("keeps the delivery target when one is configured", () => {
    const configured = {
      recipes: [
        {
          ...minimal.recipes[0],
          kind: "deps",
          baseRef: "origin/main",
          paths: ["*.php"],
          model: "gpt-5.6-sol",
          deliver: { chatId: -100123, messageThreadId: 7 },
        },
      ],
    };

    expect(parseRecipes(JSON.stringify(configured))[0]).toMatchObject({
      kind: "deps",
      baseRef: "origin/main",
      paths: ["*.php"],
      model: "gpt-5.6-sol",
      deliver: { chatId: -100123, messageThreadId: 7 },
    });
  });

  it("parses a Jira filter recipe without review-only fields", () => {
    const configured = {
      recipes: [
        {
          id: "hourly-jira-new-issues",
          kind: "jira-filter",
          cwd: "/root/dev/Projects/mircli",
          jiraClient: "/root/.local/share/jira-mcp/.venv/bin/jira-client",
          filterId: "11525",
          deliver: { chatId: -1003981282865, messageThreadId: 999 },
        },
      ],
    };

    expect(parseRecipes(JSON.stringify(configured))).toEqual(configured.recipes);
  });

  it("parses a deterministic Sentry top recipe without review prompt fields", () => {
    const configured = {
      recipes: [
        {
          id: "daily-sentry-top",
          kind: "sentry-top",
          cwd: "/root/dev/Projects/mircli",
          dofboxConfigModule: "/root/dev/bin/dofbox/src/utils/config.js",
          realm: "mircli",
          period: "24h",
          limit: 10,
          deliver: { chatId: -1003981282865, messageThreadId: 635 },
        },
      ],
    };

    expect(parseRecipes(JSON.stringify(configured))).toEqual(configured.recipes);
  });

  it("parses a portfolio review recipe for every first-level project", () => {
    const configured = {
      recipes: [{
        id: "daily-mircli-review",
        kind: "mircli-review",
        cwd: "/root/dev/Projects/mircli",
        worktreeRoot: "/root/.cache/telecodex/review-worktrees/mircli",
        promptFile: "recipes/mircli-code-review.md",
        deliver: { chatId: -1003981282865, messageThreadId: 635 },
      }],
    };

    expect(parseRecipes(JSON.stringify(configured))).toEqual(configured.recipes);
  });

  it("requires an isolated worktree root for source review recipes", () => {
    const configured = {
      recipes: [{ id: "daily", cwd: "/srv/project", promptFile: "recipes/daily.md" }],
    };

    expect(() => parseRecipes(JSON.stringify(configured))).toThrow(/worktreeRoot/);
  });

  it("requires a delivery target for a Sentry top recipe", () => {
    const configured = {
      recipes: [
        {
          id: "daily-sentry-top",
          kind: "sentry-top",
          cwd: "/root/dev/Projects/mircli",
          dofboxConfigModule: "/opt/dofbox/src/utils/config.js",
          realm: "mircli",
          period: "24h",
          limit: 10,
        },
      ],
    };

    expect(() => parseRecipes(JSON.stringify(configured))).toThrow(/deliver/i);
  });

  it("requires a delivery target for a Jira filter recipe", () => {
    const configured = {
      recipes: [
        {
          id: "hourly-jira-new-issues",
          kind: "jira-filter",
          cwd: "/root/dev/Projects/mircli",
          jiraClient: "jira-client",
          filterId: "11525",
        },
      ],
    };

    expect(() => parseRecipes(JSON.stringify(configured))).toThrow(/deliver/i);
  });

  it("refuses a recipe that is missing what the runner needs", () => {
    expect(() => parseRecipes(JSON.stringify({ recipes: [{ id: "daily" }] }))).toThrow(/cwd/);
  });

  it("refuses a kind it would not know how to run", () => {
    const wrong = { recipes: [{ ...minimal.recipes[0], kind: "vibes" }] };

    expect(() => parseRecipes(JSON.stringify(wrong))).toThrow(/vibes/);
  });

  it("refuses a half-configured delivery target rather than silently going quiet", () => {
    const wrong = {
      recipes: [{ ...minimal.recipes[0], deliver: { chatId: -100123 } }],
    };

    expect(() => parseRecipes(JSON.stringify(wrong))).toThrow(/messageThreadId/);
  });

  it("says what is wrong with the file rather than throwing a parser error", () => {
    expect(() => parseRecipes("{ nope")).toThrow(/recipes/i);
    expect(() => parseRecipes(JSON.stringify({ recipes: {} }))).toThrow(/list/i);
  });

  it("refuses two recipes under one id, since state is keyed by it", () => {
    const clashing = { recipes: [minimal.recipes[0], minimal.recipes[0]] };

    expect(() => parseRecipes(JSON.stringify(clashing))).toThrow(/daily/);
  });
});
