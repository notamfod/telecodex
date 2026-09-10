import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

interface RunnerLogScope {
  readonly name: string;
  readonly block: string | null;
  readonly expectedCalls: readonly string[];
}

function runnerLogViolations(candidate: string): string[] {
  const startupBoundary = candidate.indexOf("const shutdown");
  const startupRegion = startupBoundary === -1 ? candidate : candidate.slice(0, startupBoundary);
  const pollingFunction = extractBlock(candidate, "async function startPolling(): Promise<void> {");
  const pollingCatch = pollingFunction === null
    ? null
    : extractBlock(pollingFunction, "} catch (error) {");
  const scopes: readonly RunnerLogScope[] = [
    {
      name: "cleanup callback",
      block: extractBlock(candidate, "onCleanupError: (step, error) => {"),
      expectedCalls: [
        'console.warn(formatTelegramErrorLog("cleanup", error))',
        'console.warn("Failed to stop Telegram retention runtime cleanly")',
        'console.warn("Failed to stop Telegram reliability runtime cleanly")',
        'console.warn(formatTelegramErrorLog("cleanup", error))',
      ],
    },
    {
      name: "runtime callback",
      block: extractBlock(candidate, "onRuntimeError: ({ operation, error }) => {"),
      expectedCalls: [
        "console.error(formatTelegramErrorLog(RUNTIME_LOG_OPERATION[operation], error))",
      ],
    },
    {
      name: "startup catch",
      block: extractBlock(startupRegion, "} catch (error) {", true),
      expectedCalls: ['console.error(formatTelegramErrorLog("startup", error))'],
    },
    {
      name: "shutdown reporter",
      block: extractBlock(candidate, "const reportShutdownFailure = (error: unknown): void => {"),
      expectedCalls: ['console.error(formatTelegramErrorLog("cleanup", error))'],
    },
    {
      name: "polling catch",
      block: pollingCatch,
      expectedCalls: [
        'console.warn(formatTelegramErrorLog("polling", error))',
        "console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`)",
        'console.error(formatTelegramErrorLog("polling", error))',
      ],
    },
  ];

  const violations: string[] = [];
  for (const scope of scopes) {
    if (scope.block === null) {
      violations.push(`${scope.name}: block not found`);
      continue;
    }
    const actualCalls = collectConsoleCalls(scope.block).map(compactCode);
    const expectedCalls = scope.expectedCalls.map(compactCode);
    if (JSON.stringify(actualCalls) !== JSON.stringify(expectedCalls)) {
      violations.push(`${scope.name}: unexpected console arguments`);
    }
  }

  if (pollingCatch === null) {
    violations.push("polling catch: conflict decision not found");
  } else {
    const compactPollingCatch = compactCode(pollingCatch);
    if (!compactPollingCatch.includes("isTelegramPollingConflict(error)")) {
      violations.push("polling catch: structured conflict predicate missing");
    }
    if (/message\.includes\((?:'409'|'Conflict'|"409"|"Conflict")\)/.test(compactPollingCatch)) {
      violations.push("polling catch: raw message conflict predicate present");
    }
  }
  return violations;
}

function extractBlock(candidate: string, anchor: string, fromEnd = false): string | null {
  const anchorIndex = fromEnd ? candidate.lastIndexOf(anchor) : candidate.indexOf(anchor);
  if (anchorIndex === -1) return null;
  const openingIndex = anchorIndex + anchor.lastIndexOf("{");
  const closingIndex = findClosingDelimiter(candidate, openingIndex, "{", "}");
  return closingIndex === -1 ? null : candidate.slice(openingIndex + 1, closingIndex);
}

function collectConsoleCalls(block: string): string[] {
  const calls: string[] = [];
  const pattern = /console\.(?:warn|error)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const openingIndex = pattern.lastIndex - 1;
    const closingIndex = findClosingDelimiter(block, openingIndex, "(", ")");
    if (closingIndex === -1) {
      calls.push(block.slice(match.index));
      break;
    }
    calls.push(block.slice(match.index, closingIndex + 1));
    pattern.lastIndex = closingIndex + 1;
  }
  return calls;
}

function findClosingDelimiter(
  candidate: string,
  openingIndex: number,
  opening: "(" | "{",
  closing: ")" | "}",
): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingIndex; index < candidate.length; index += 1) {
    const character = candidate[index];
    const next = candidate[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function compactCode(candidate: string): string {
  let compact = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (const character of candidate) {
    if (quote !== null) {
      compact += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      compact += character;
    } else if (!/\s/.test(character)) {
      compact += character;
    }
  }
  return compact;
}

function replaceOnce(candidate: string, before: string, after: string): string {
  if (!candidate.includes(before)) throw new Error(`Mutation target not found: ${before}`);
  return candidate.replace(before, after);
}

describe("main runner Telegram log safety", () => {
  it("routes caught runner errors through the shared safe formatter", () => {
    expect(source).toContain('from "./telegram-error-log.js"');
    expect(source).toContain('console.warn(formatTelegramErrorLog("cleanup", error));');
    expect(source).toContain(
      'console.error(formatTelegramErrorLog(RUNTIME_LOG_OPERATION[operation], error));',
    );
    expect(source).toContain('console.error(formatTelegramErrorLog("startup", error));');
    expect(source).toContain('console.error(formatTelegramErrorLog("cleanup", error));');
    expect(source).toContain('console.warn(formatTelegramErrorLog("polling", error));');
    expect(source).toContain('console.error(formatTelegramErrorLog("polling", error));');
  });

  it("maps every reliability runtime operation to an approved log operation", () => {
    expect(source).toContain(
      "satisfies Record<TelegramReliabilityRuntimeOperation, TelegramLogOperation>",
    );
    expect(source).toMatch(/status_refresh:\s*"status_edit"/);
    expect(source).toMatch(/delivery:\s*"reliability"/);
    expect(source).toMatch(/coordinator:\s*"reliability"/);
    expect(source).toMatch(/reconciliation:\s*"reliability"/);
  });

  it("does not retain raw runner error formatting or identifiers", () => {
    expect(source).not.toMatch(/const message = error instanceof Error/);
    expect(source).not.toMatch(/job=\$\{jobId/);
    expect(source).not.toMatch(/function (?:boundedErrorText|telegramErrorCodeForLog)/);
    expect(source).not.toContain("telegramRetryAfterMsForLog");
    expect(source).not.toMatch(/console\.(?:warn|error)\(\s*(?:"[^"]*"|`[^`]*`)\s*,\s*(?:error|detail)\s*\)/s);
    expect(source).not.toMatch(/console\.(?:warn|error)\(\s*formatTelegramErrorLog\([^)]*\)\s*,\s*(?:error|detail)\s*\)/s);
  });

  it("allows only the expected one-argument logging calls in target error scopes", () => {
    expect(runnerLogViolations(source)).toEqual([]);
  });

  it("uses only the structured polling conflict predicate", () => {
    const pollingFunction = extractBlock(source, "async function startPolling(): Promise<void> {");
    const pollingCatch = pollingFunction === null
      ? null
      : extractBlock(pollingFunction, "} catch (error) {");

    expect(pollingCatch).toContain("isTelegramPollingConflict(error)");
    expect(pollingCatch).not.toMatch(
      /message\s*\.\s*includes\s*\(\s*(['"])(?:409|Conflict)\1\s*\)/,
    );
  });

  it.each([
    {
      name: "raw error after a double-quoted message",
      mutate: (candidate: string) => replaceOnce(
        candidate,
        'console.warn(formatTelegramErrorLog("cleanup", error));',
        'console.warn("cleanup failed", error);',
      ),
    },
    {
      name: "raw detail after a single-quoted message",
      mutate: (candidate: string) => replaceOnce(
        candidate,
        'console.error(formatTelegramErrorLog(RUNTIME_LOG_OPERATION[operation], error));',
        "console.error('runtime failed', detail);",
      ),
    },
    {
      name: "raw error after a variable",
      mutate: (candidate: string) => replaceOnce(
        candidate,
        'console.error(formatTelegramErrorLog("startup", error));',
        "console.error(message, error);",
      ),
    },
    {
      name: "raw detail concatenation",
      mutate: (candidate: string) => replaceOnce(
        candidate,
        'console.error(formatTelegramErrorLog("cleanup", error));',
        'console.error("shutdown: " + detail);',
      ),
    },
    {
      name: "raw String error conversion",
      mutate: (candidate: string) => replaceOnce(
        candidate,
        'console.warn(formatTelegramErrorLog("polling", error));',
        "console.warn(String(error));",
      ),
    },
    {
      name: "raw trailing arguments after the formatter",
      mutate: (candidate: string) => replaceOnce(
        candidate,
        'console.error(formatTelegramErrorLog("polling", error));',
        'console.error(formatTelegramErrorLog("polling", error), error, detail);',
      ),
    },
    {
      name: "message-based polling conflict detection",
      mutate: (candidate: string) => replaceOnce(
        candidate,
        "isTelegramPollingConflict(error)",
        "message.includes('409') || message.includes('Conflict')",
      ),
    },
  ])("rejects $name", ({ mutate }) => {
    expect(runnerLogViolations(mutate(source))).not.toEqual([]);
  });
});
