import { describe, expect, it } from "vitest";

import {
  bumpKind,
  composerDirectDependencies,
  escapeGoModulePath,
  latestStable,
  parseGoMod,
  renderDepsTable,
} from "../src/deps.js";

describe("parseGoMod", () => {
  it("reads a require block", () => {
    const deps = parseGoMod(
      ["module example.com/app", "", "go 1.22", "", "require (", "\tgithub.com/foo/bar v1.2.3", "\tgithub.com/baz/qux v0.4.0", ")"].join("\n"),
    );

    expect(deps).toEqual([
      { name: "github.com/foo/bar", current: "v1.2.3" },
      { name: "github.com/baz/qux", current: "v0.4.0" },
    ]);
  });

  it("reads a single-line require", () => {
    expect(parseGoMod("require github.com/foo/bar v1.2.3")).toEqual([
      { name: "github.com/foo/bar", current: "v1.2.3" },
    ]);
  });

  it("skips indirect dependencies, which are not ours to bump", () => {
    const deps = parseGoMod(
      ["require (", "\tgithub.com/foo/bar v1.2.3", "\tgithub.com/deep/dep v0.1.0 // indirect", ")"].join("\n"),
    );

    expect(deps.map((dep) => dep.name)).toEqual(["github.com/foo/bar"]);
  });

  it("ignores module, go and replace lines", () => {
    const deps = parseGoMod(
      ["module example.com/app", "go 1.22", "replace github.com/a/b => ../b", "require github.com/foo/bar v1.0.0"].join("\n"),
    );

    expect(deps).toEqual([{ name: "github.com/foo/bar", current: "v1.0.0" }]);
  });

  it("returns nothing for a go.mod with no requirements", () => {
    expect(parseGoMod("module example.com/app\n\ngo 1.22\n")).toEqual([]);
  });
});

describe("composerDirectDependencies", () => {
  const lock = {
    packages: [
      { name: "laravel/framework", version: "v11.9.2" },
      { name: "guzzlehttp/guzzle", version: "7.8.1" },
      { name: "psr/log", version: "3.0.0" },
    ],
  };

  it("keeps only what composer.json requires directly", () => {
    const deps = composerDirectDependencies(
      { require: { "laravel/framework": "^11.0", "guzzlehttp/guzzle": "^7.0" } },
      lock,
    );

    expect(deps.map((dep) => dep.name).sort()).toEqual(["guzzlehttp/guzzle", "laravel/framework"]);
  });

  it("takes the resolved version from the lock, not the constraint", () => {
    const [dep] = composerDirectDependencies({ require: { "laravel/framework": "^11.0" } }, lock);

    expect(dep.current).toBe("v11.9.2");
  });

  it("drops php and ext-*, which composer cannot update", () => {
    const deps = composerDirectDependencies(
      { require: { php: "^8.3", "ext-redis": "*", "laravel/framework": "^11.0" } },
      lock,
    );

    expect(deps.map((dep) => dep.name)).toEqual(["laravel/framework"]);
  });

  it("skips a requirement the lock never resolved", () => {
    const deps = composerDirectDependencies({ require: { "not/installed": "^1.0" } }, lock);

    expect(deps).toEqual([]);
  });

  it("returns nothing when composer.json requires nothing", () => {
    expect(composerDirectDependencies({}, lock)).toEqual([]);
  });
});

describe("escapeGoModulePath", () => {
  it("leaves an all-lowercase module alone", () => {
    expect(escapeGoModulePath("github.com/foo/bar")).toBe("github.com/foo/bar");
  });

  it("escapes capitals the way the module proxy demands", () => {
    expect(escapeGoModulePath("github.com/Masterminds/squirrel")).toBe(
      "github.com/!masterminds/squirrel",
    );
  });

  it("escapes every capital, not just the first", () => {
    expect(escapeGoModulePath("github.com/AWS/SDK")).toBe("github.com/!a!w!s/!s!d!k");
  });
});

describe("latestStable", () => {
  it("picks the highest release", () => {
    expect(latestStable(["1.0.0", "1.2.0", "1.10.0", "1.9.0"])).toBe("1.10.0");
  });

  it("compares numerically, so 1.10 beats 1.9", () => {
    expect(latestStable(["v1.9.0", "v1.10.0"])).toBe("v1.10.0");
  });

  it("ignores prereleases, which nobody wants suggested on a Monday", () => {
    expect(latestStable(["2.0.0-beta.1", "1.9.0", "2.0.0-rc1", "1.9.0-dev"])).toBe("1.9.0");
  });

  it("handles Go's +incompatible suffix", () => {
    expect(latestStable(["v2.1.0+incompatible", "v2.0.0+incompatible"])).toBe("v2.1.0+incompatible");
  });

  it("returns nothing when every candidate is a prerelease", () => {
    expect(latestStable(["1.0.0-alpha", "1.0.0-rc.2"])).toBeUndefined();
  });

  it("returns nothing for an empty list", () => {
    expect(latestStable([])).toBeUndefined();
  });
});

describe("bumpKind", () => {
  it("calls a leading-number change major", () => {
    expect(bumpKind("v11.9.2", "v12.0.1")).toBe("major");
  });

  it("calls a second-number change minor", () => {
    expect(bumpKind("7.8.1", "7.9.0")).toBe("minor");
  });

  it("calls a third-number change patch", () => {
    expect(bumpKind("7.8.1", "7.8.4")).toBe("patch");
  });

  it("reports none when already current", () => {
    expect(bumpKind("v1.2.3", "1.2.3")).toBe("none");
  });

  it("reports none when the lock is ahead of the registry", () => {
    expect(bumpKind("2.0.0", "1.9.0")).toBe("none");
  });

  it("treats 0.x minor bumps as major, since 0.x has no stability promise", () => {
    expect(bumpKind("v0.4.0", "v0.5.0")).toBe("major");
  });
});

describe("renderDepsTable", () => {
  const updates = [
    { name: "laravel/framework", current: "v11.9.2", latest: "v12.0.1", bump: "major" as const, ecosystem: "composer" as const },
    { name: "guzzlehttp/guzzle", current: "7.8.1", latest: "7.9.0", bump: "minor" as const, ecosystem: "composer" as const },
    { name: "github.com/foo/bar", current: "v1.2.3", latest: "v1.2.9", bump: "patch" as const, ecosystem: "go" as const },
  ];

  it("lists every update with its versions", () => {
    const table = renderDepsTable(updates);

    expect(table).toContain("laravel/framework");
    expect(table).toContain("v11.9.2");
    expect(table).toContain("v12.0.1");
    expect(table).toContain("github.com/foo/bar");
  });

  it("groups by ecosystem so the agent knows which registry to look at", () => {
    const table = renderDepsTable(updates);

    expect(table).toMatch(/composer/i);
    expect(table).toMatch(/\bgo\b/i);
  });

  it("puts majors first, since those are the ones worth reading a changelog for", () => {
    const table = renderDepsTable(updates);

    expect(table.indexOf("laravel/framework")).toBeLessThan(table.indexOf("guzzlehttp/guzzle"));
  });

  it("says so plainly when everything is current", () => {
    expect(renderDepsTable([])).toMatch(/нет обновлений/i);
  });
});
