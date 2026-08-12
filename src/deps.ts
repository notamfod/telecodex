/**
 * Outdated direct dependencies, worked out without composer or go on the host.
 *
 * Neither tool is installed on the bridge, so the lockfiles are read straight
 * from the checkout and the registries are queried over HTTP by the bot.
 */

export type Bump = "major" | "minor" | "patch" | "none";
export type Ecosystem = "composer" | "go";

export interface DepRequirement {
  name: string;
  current: string;
}

export interface DepUpdate extends DepRequirement {
  latest: string;
  bump: Bump;
  ecosystem: Ecosystem;
}

const GO_IGNORED_DIRECTIVES = /^(module|go|toolchain|replace|exclude|retract)\b/;

export function parseGoMod(text: string): DepRequirement[] {
  const deps: DepRequirement[] = [];
  let inBlock = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (inBlock) {
      if (line === ")") {
        inBlock = false;
        continue;
      }
      addGoRequirement(deps, line);
      continue;
    }

    if (line.startsWith("require (")) {
      inBlock = true;
      continue;
    }
    if (line.startsWith("require ")) {
      addGoRequirement(deps, line.slice("require ".length));
      continue;
    }
    if (GO_IGNORED_DIRECTIVES.test(line)) {
      continue;
    }
  }

  return deps;
}

function addGoRequirement(deps: DepRequirement[], line: string): void {
  // Indirect requirements come from someone else's go.mod; bumping them here is noise.
  if (!line || line.startsWith("//") || line.includes("// indirect")) {
    return;
  }
  const match = /^(\S+)\s+(v\S+)/.exec(line);
  if (match) {
    deps.push({ name: match[1], current: match[2] });
  }
}

/**
 * proxy.golang.org rejects capitals in a module path; each one is written as
 * `!` plus its lowercase form.
 */
export function escapeGoModulePath(module: string): string {
  return module.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

export function composerDirectDependencies(
  composerJson: { require?: Record<string, string> },
  composerLock: { packages?: Array<{ name: string; version: string }> },
): DepRequirement[] {
  const locked = new Map((composerLock.packages ?? []).map((entry) => [entry.name, entry.version]));

  return Object.keys(composerJson.require ?? {})
    // php itself and ext-* are platform requirements, not packages composer can bump.
    .filter((name) => name !== "php" && !name.startsWith("ext-") && name.includes("/"))
    .flatMap((name) => {
      const current = locked.get(name);
      return current ? [{ name, current }] : [];
    });
}

/** Strips the `v` prefix and any `+build` metadata, leaving `1.2.3` or `1.2.3-rc1`. */
function core(version: string): string {
  return version.replace(/^v/, "").split("+")[0];
}

function isStable(version: string): boolean {
  return !core(version).includes("-");
}

function segments(version: string): number[] {
  return core(version)
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function latestStable(versions: string[]): string | undefined {
  return versions.filter(isStable).sort(compareVersions).at(-1);
}

export function bumpKind(current: string, latest: string): Bump {
  if (compareVersions(latest, current) <= 0) {
    return "none";
  }

  const [currentMajor, currentMinor] = segments(current);
  const [latestMajor, latestMinor] = segments(latest);

  if (currentMajor !== latestMajor) {
    return "major";
  }
  // 0.x promises nothing between minors, so treat those as breaking too.
  if (currentMinor !== latestMinor) {
    return currentMajor === 0 ? "major" : "minor";
  }
  return "patch";
}

const BUMP_RANK: Record<Bump, number> = { major: 0, minor: 1, patch: 2, none: 3 };
const ECOSYSTEM_ORDER: Ecosystem[] = ["composer", "go"];

export function renderDepsTable(updates: DepUpdate[]): string {
  if (updates.length === 0) {
    return "Нет обновлений: все прямые зависимости на последних стабильных версиях.";
  }

  const sections = ECOSYSTEM_ORDER.flatMap((ecosystem) => {
    const rows = updates
      .filter((update) => update.ecosystem === ecosystem)
      .sort((a, b) => BUMP_RANK[a.bump] - BUMP_RANK[b.bump] || a.name.localeCompare(b.name));

    if (rows.length === 0) {
      return [];
    }

    return [
      [
        `### ${ecosystem}`,
        "",
        "| пакет | сейчас | последняя | скачок |",
        "| --- | --- | --- | --- |",
        ...rows.map(
          (row) => `| ${row.name} | ${row.current} | ${row.latest} | ${row.bump} |`,
        ),
      ].join("\n"),
    ];
  });

  return sections.join("\n\n");
}
