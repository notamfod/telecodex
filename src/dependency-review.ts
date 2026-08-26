import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  bumpKind,
  composerDirectDependencies,
  escapeGoModulePath,
  latestStable,
  npmDirectDependencies,
  parseGoMod,
  renderDepsTable,
  yarnV1DirectDependencies,
  type DepRequirement,
  type DepUpdate,
  type Ecosystem,
} from "./deps.js";
import type { ReviewRecipe } from "./recipe-config.js";
import {
  discoverReviewProjects,
  prepareReviewWorktree,
  type PreparedReviewProject,
  type ReviewProject,
} from "./review-worktree.js";

export interface ProjectRequirement extends DepRequirement {
  project: string;
  manifest: string;
  ecosystem: Ecosystem;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "bin",
  "graphify-out",
  "node_modules",
  "obj",
  "vendor",
]);

const REGISTRY_TIMEOUT_MS = 15_000;
const REGISTRY_CONCURRENCY = 8;

async function findFiles(root: string, names: Set<string>): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
      } else if (entry.isFile() && names.has(entry.name)) {
        found.push(path.join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return found.sort();
}

function withContext(
  requirements: DepRequirement[],
  project: string,
  manifest: string,
  ecosystem: Ecosystem,
): ProjectRequirement[] {
  return requirements.map((requirement) => ({
    ...requirement,
    project,
    manifest,
    ecosystem,
  }));
}

export async function collectProjectRequirements(
  project: string,
  worktreePath: string,
): Promise<ProjectRequirement[]> {
  const found: ProjectRequirement[] = [];
  const manifests = await findFiles(worktreePath, new Set(["composer.json", "go.mod", "package.json"]));

  for (const manifestPath of manifests) {
    const directory = path.dirname(manifestPath);
    const manifest = path.relative(worktreePath, manifestPath).split(path.sep).join("/");
    if (path.basename(manifestPath) === "composer.json") {
      const lockPath = path.join(directory, "composer.lock");
      if (!existsSync(lockPath)) continue;
      found.push(...withContext(
        composerDirectDependencies(
          JSON.parse(await readFile(manifestPath, "utf8")),
          JSON.parse(await readFile(lockPath, "utf8")),
        ),
        project,
        manifest,
        "composer",
      ));
      continue;
    }
    if (path.basename(manifestPath) === "go.mod") {
      found.push(...withContext(
        parseGoMod(await readFile(manifestPath, "utf8")),
        project,
        manifest,
        "go",
      ));
      continue;
    }

    const packageJson = JSON.parse(await readFile(manifestPath, "utf8"));
    const packageLockPath = path.join(directory, "package-lock.json");
    const yarnLockPath = path.join(directory, "yarn.lock");
    if (existsSync(packageLockPath)) {
      found.push(...withContext(
        npmDirectDependencies(packageJson, JSON.parse(await readFile(packageLockPath, "utf8"))),
        project,
        manifest,
        "npm",
      ));
    } else if (existsSync(yarnLockPath)) {
      found.push(...withContext(
        yarnV1DirectDependencies(packageJson, await readFile(yarnLockPath, "utf8")),
        project,
        manifest,
        "npm",
      ));
    }
  }

  return found;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function latestVersion(requirement: ProjectRequirement): Promise<string | undefined> {
  if (requirement.ecosystem === "composer") {
    const body = await fetchJson(`https://repo.packagist.org/p2/${requirement.name}.json`);
    const packages = (body?.packages ?? {}) as Record<string, Array<{ version?: string }>>;
    const versions = packages[requirement.name];
    return Array.isArray(versions)
      ? latestStable(versions.map((entry) => String(entry.version ?? "")).filter(Boolean))
      : undefined;
  }
  if (requirement.ecosystem === "go") {
    const body = await fetchJson(
      `https://proxy.golang.org/${escapeGoModulePath(requirement.name)}/@latest`,
    );
    const version = body?.Version;
    return typeof version === "string" && !version.includes("-") ? version : undefined;
  }
  const body = await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(requirement.name)}/latest`,
  );
  return typeof body?.version === "string" ? body.version : undefined;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

interface DependencyReviewDependencies {
  discover?: (root: string) => Promise<ReviewProject[]>;
  prepare?: (
    project: ReviewProject,
    worktreeRoot: string,
  ) => Promise<PreparedReviewProject>;
  collect?: (project: string, worktreePath: string) => Promise<ProjectRequirement[]>;
  latest?: (requirement: ProjectRequirement) => Promise<string | undefined>;
}

export async function buildDependencyReviewTable(
  recipe: ReviewRecipe,
  dependencies: DependencyReviewDependencies = {},
): Promise<string> {
  return (await prepareDependencyReview(recipe, dependencies)).table;
}

export async function prepareDependencyReview(
  recipe: ReviewRecipe,
  dependencies: DependencyReviewDependencies = {},
): Promise<{ table: string; projects: PreparedReviewProject[] }> {
  const discover = dependencies.discover ?? discoverReviewProjects;
  const prepare = dependencies.prepare ?? prepareReviewWorktree;
  const collect = dependencies.collect ?? collectProjectRequirements;
  const lookupLatest = dependencies.latest ?? latestVersion;
  const requirements: ProjectRequirement[] = [];
  const projects: PreparedReviewProject[] = [];

  for (const project of await discover(recipe.cwd)) {
    const prepared = await prepare(project, recipe.worktreeRoot);
    projects.push(prepared);
    requirements.push(...await collect(project.name, prepared.worktreePath));
  }

  const updates = await mapLimit(requirements, REGISTRY_CONCURRENCY, async (requirement) => {
    const latest = await lookupLatest(requirement);
    if (!latest) return undefined;
    const bump = bumpKind(requirement.current, latest);
    return bump === "none" ? undefined : ({ ...requirement, latest, bump } as DepUpdate);
  });
  return {
    table: renderDepsTable(updates.filter((update): update is DepUpdate => update !== undefined)),
    projects,
  };
}
