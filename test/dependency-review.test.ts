import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDependencyReviewTable,
  collectProjectRequirements,
} from "../src/dependency-review.js";

describe("collectProjectRequirements", () => {
  it("keeps the same package separately for each project and includes npm", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-deps-"));
    const back = path.join(root, "mir-back");
    const admin = path.join(root, "mir-admin");
    await mkdir(back);
    await mkdir(admin);
    await writeFile(path.join(back, "composer.json"), JSON.stringify({
      require: { "psr/log": "^3" },
    }));
    await writeFile(path.join(back, "composer.lock"), JSON.stringify({
      packages: [{ name: "psr/log", version: "3.0.0" }],
    }));
    await writeFile(path.join(admin, "package.json"), JSON.stringify({
      dependencies: { react: "^19" },
    }));
    await writeFile(path.join(admin, "package-lock.json"), JSON.stringify({
      packages: { "node_modules/react": { version: "19.1.0" } },
    }));

    const requirements = [
      ...await collectProjectRequirements("mir-back", back),
      ...await collectProjectRequirements("mir-admin", admin),
    ];

    expect(requirements).toEqual([
      {
        project: "mir-back",
        manifest: "composer.json",
        ecosystem: "composer",
        name: "psr/log",
        current: "3.0.0",
      },
      {
        project: "mir-admin",
        manifest: "package.json",
        ecosystem: "npm",
        name: "react",
        current: "19.1.0",
      },
    ]);
  });
});

describe("buildDependencyReviewTable", () => {
  it("updates every project worktree and does not deduplicate a shared package", async () => {
    const prepare = async (project: { name: string; sourcePath: string }) => ({
      ...project,
      worktreePath: `/cache/${project.name}`,
      headSha: `${project.name}-sha`,
      baseRef: "origin/main" as const,
    });

    const table = await buildDependencyReviewTable(
      {
        id: "dependency-review",
        kind: "deps",
        cwd: "/srv/mircli",
        baseRef: "origin/main",
        worktreeRoot: "/cache",
        promptFile: "recipes/dependency-review.md",
        paths: [],
      },
      {
        discover: async () => [
          { name: "service-a", sourcePath: "/srv/mircli/service-a" },
          { name: "service-b", sourcePath: "/srv/mircli/service-b" },
        ],
        prepare,
        collect: async (project) => [{
          project,
          manifest: "go.mod",
          ecosystem: "go",
          name: "example.org/shared",
          current: "v1.0.0",
        }],
        latest: async () => "v1.1.0",
      },
    );

    expect(table.match(/example\.org\/shared/g)).toHaveLength(2);
    expect(table).toContain("service-a");
    expect(table).toContain("service-b");
  });
});
