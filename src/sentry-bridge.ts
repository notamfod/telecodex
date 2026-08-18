import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const SEEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface SentryBridgeTarget {
  inboxContextKey: string;
  workspace: string;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit?: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
}

export interface SentryBridgeResult {
  fetched: number;
  created: number;
  skipped: number;
  failures: string[];
}

export interface SentryBridgeOptions {
  baseUrl: string;
  token: string;
  org: string;
  mappings: Record<string, SentryBridgeTarget>;
  intervalMs: number;
  limit: number;
  statePath: string;
  createTicket: (
    issue: SentryIssue,
    target: SentryBridgeTarget,
    project: string,
  ) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface SentryBridgeState {
  seen: Record<string, number>;
}

export class SentryBridge {
  private timer?: NodeJS.Timeout;
  private running = false;
  private runTail: Promise<void> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: SentryBridgeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.runScheduled();
    this.timer = setInterval(() => void this.runScheduled(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  run(hours = 24): Promise<SentryBridgeResult> {
    const next = this.runTail.then(() => this.runOnce(hours));
    this.runTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async runOnce(hours: number): Promise<SentryBridgeResult> {
    const state = this.loadState();
    const now = this.now();
    const cutoff = now - SEEN_RETENTION_MS;
    for (const [id, seenAt] of Object.entries(state.seen)) {
      if (!Number.isFinite(seenAt) || seenAt < cutoff) delete state.seen[id];
    }

    const result: SentryBridgeResult = { fetched: 0, created: 0, skipped: 0, failures: [] };
    let attempts = 0;
    for (const [project, target] of Object.entries(this.options.mappings)) {
      let issues: SentryIssue[];
      try {
        issues = await this.fetchIssues(project, hours);
      } catch (error) {
        result.failures.push(`${project}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      result.fetched += issues.length;
      for (const issue of issues) {
        if (state.seen[issue.id] !== undefined) {
          result.skipped += 1;
          continue;
        }
        if (attempts >= this.options.limit) continue;
        attempts += 1;
        try {
          await this.options.createTicket(issue, target, project);
          state.seen[issue.id] = now;
          result.created += 1;
          this.saveState(state);
        } catch (error) {
          result.failures.push(
            `${project}/${issue.shortId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    this.saveState(state);
    return result;
  }

  private async runScheduled(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.run();
      if (result.failures.length) {
        console.warn(`Sentry bridge completed with ${result.failures.length} failure(s): ${result.failures.join("; ")}`);
      }
    } catch (error) {
      console.warn("Sentry bridge failed:", error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async fetchIssues(project: string, hours: number): Promise<SentryIssue[]> {
    const query = new URLSearchParams({
      query: "is:unresolved",
      sort: "freq",
      statsPeriod: `${hours}h`,
    });
    const baseUrl = this.options.baseUrl.replace(/\/+$/, "");
    const apiBaseUrl = baseUrl.endsWith("/api/0") ? baseUrl : `${baseUrl}/api/0`;
    const url = `${apiBaseUrl}/projects/${encodeURIComponent(this.options.org)}/${encodeURIComponent(project)}/issues/?${query}`;
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });
    if (!response.ok) {
      throw new Error(`Sentry issues failed: ${response.status} ${await response.text()}`);
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("Sentry issues response is not an array");
    return payload.filter(isSentryIssue);
  }

  private loadState(): SentryBridgeState {
    try {
      if (!existsSync(this.options.statePath)) return { seen: {} };
      const parsed = JSON.parse(readFileSync(this.options.statePath, "utf8")) as Partial<SentryBridgeState>;
      return {
        seen: parsed.seen && typeof parsed.seen === "object" ? parsed.seen : {},
      };
    } catch {
      return { seen: {} };
    }
  }

  private saveState(state: SentryBridgeState): void {
    const directory = path.dirname(this.options.statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.options.statePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.options.statePath);
  }
}

export function renderSentryTicketText(issue: SentryIssue): string {
  return [
    `Sentry ${issue.shortId}: ${issue.title}`,
    `Culprit: ${issue.culprit || "(unknown)"}`,
    `Events: ${issue.count}`,
    `First seen: ${issue.firstSeen}`,
    `Last seen: ${issue.lastSeen}`,
    `Link: ${issue.permalink}`,
  ].join("\n");
}

function isSentryIssue(value: unknown): value is SentryIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as Record<string, unknown>;
  return ["id", "shortId", "title", "count", "firstSeen", "lastSeen", "permalink"]
    .every((key) => typeof issue[key] === "string")
    && (issue.culprit === undefined || typeof issue.culprit === "string");
}
