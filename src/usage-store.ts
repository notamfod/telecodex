import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

export interface UsageEntry {
  ts: number;
  contextKey: string;
  workspace: string;
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UsageAggregate {
  workspace: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

export type TokenBudgetStatus = "ok" | "warning" | "exceeded";

export class UsageStore {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  record(entry: UsageEntry): void {
    if (!isUsageEntry(entry)) {
      throw new Error("Invalid token usage entry");
    }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  aggregate(days: number, now = Date.now()): UsageAggregate[] {
    const cutoff = now - days * DAY_MS;
    const grouped = new Map<string, UsageAggregate>();
    for (const entry of this.readEntries()) {
      if (entry.ts < cutoff || entry.ts > now) continue;
      const aggregate = grouped.get(entry.workspace) ?? {
        workspace: entry.workspace,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turns: 0,
      };
      aggregate.inputTokens += entry.inputTokens;
      aggregate.cachedInputTokens += entry.cachedInputTokens;
      aggregate.outputTokens += entry.outputTokens;
      aggregate.totalTokens += entry.inputTokens + entry.outputTokens;
      aggregate.turns += 1;
      grouped.set(entry.workspace, aggregate);
    }

    return [...grouped.values()].sort((left, right) =>
      right.totalTokens - left.totalTokens || left.workspace.localeCompare(right.workspace),
    );
  }

  compact(now = Date.now()): number {
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    const entries = this.readEntries().filter((entry) => entry.ts >= cutoff && entry.ts <= now);
    const temporaryPath = `${this.filePath}.tmp`;
    const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(temporaryPath, content ? `${content}\n` : "", { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    return entries.length;
  }

  private readEntries(): UsageEntry[] {
    if (!existsSync(this.filePath)) return [];
    const entries: UsageEntry[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isUsageEntry(value)) entries.push(value);
      } catch {
        // A partially written or manually damaged line must not hide valid usage.
      }
    }
    return entries;
  }
}

export function tokenBudgetStatus(total: number, limit: number): TokenBudgetStatus {
  if (total >= limit) return "exceeded";
  if (total >= limit * 0.8) return "warning";
  return "ok";
}

function isUsageEntry(value: unknown): value is UsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return Number.isFinite(entry.ts)
    && typeof entry.contextKey === "string"
    && entry.contextKey.length > 0
    && typeof entry.workspace === "string"
    && entry.workspace.length > 0
    && (entry.model === undefined || typeof entry.model === "string")
    && isTokenCount(entry.inputTokens)
    && isTokenCount(entry.cachedInputTokens)
    && isTokenCount(entry.outputTokens);
}

function isTokenCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
