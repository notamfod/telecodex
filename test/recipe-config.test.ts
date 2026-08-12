import { describe, expect, it } from "vitest";

import { parseRecipes } from "../src/recipe-config.js";

const minimal = {
  recipes: [{ id: "daily", cwd: "/srv/project", promptFile: "recipes/daily.md" }],
};

describe("parseRecipes", () => {
  it("fills in the parts a recipe may leave out", () => {
    const [recipe] = parseRecipes(JSON.stringify(minimal));

    expect(recipe).toEqual({
      id: "daily",
      cwd: "/srv/project",
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
