import path from "node:path";
import { collectDeployRow, type CollectDeployRowOptions, type DeploySummaryRow } from "./mircli-deploy-data.js";
import { canAnimateDeploy, renderDeploySummary } from "./mircli-deploy-render.js";
import { deployTelegramCall, MircliDeployTopic, type DeployTelegramCall, type DeployViewRequest } from "./mircli-deploy-topic.js";

export interface MircliDeploySummaryConfig {
  target: { chatId: number; messageThreadId: number };
  statePath: string;
  gitlabUrl: string;
  gitlabToken: string;
  telegramToken: string;
  projectIds: Readonly<Record<string, number>>;
  intervalMs: number;
}

export function loadMircliDeploySummaryConfig(
  env: Readonly<Record<string, string | undefined>>,
  review: { projectIds: Readonly<Record<string, number>>; statePath: string },
): MircliDeploySummaryConfig | undefined {
  if (!env.MIRCLI_DEPLOY_TOPIC_ID) return undefined;
  const topic = integer(env.MIRCLI_DEPLOY_TOPIC_ID, 1, 2_147_483_647, "MIRCLI_DEPLOY_TOPIC_ID");
  const chat = integer(required(env, "MIRCLI_DEPLOY_CHAT_ID", "TELEGRAM_FORUM_CHAT_ID"), -(2 ** 52 - 1), -1, "MIRCLI_DEPLOY_CHAT_ID");
  const intervalSeconds = integer(env.MIRCLI_DEPLOY_POLL_SECONDS ?? "60", 15, 3600, "MIRCLI_DEPLOY_POLL_SECONDS");
  const gitlabUrl = required(env, "GITLAB_URL");
  const url = new URL(gitlabUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid GITLAB_URL for deploy summary");
  }
  const statePath = env.MIRCLI_DEPLOY_STATE_PATH ?? `${review.statePath}.deploy.json`;
  if (!path.isAbsolute(statePath)) throw new Error("MIRCLI_DEPLOY_STATE_PATH must be absolute");
  const projectIds = env.MIRCLI_DEPLOY_PROJECTS
    ? selectedProjects(env.MIRCLI_DEPLOY_PROJECTS, review.projectIds) : review.projectIds;
  if (!Object.keys(projectIds).length || Object.keys(projectIds).length > 100) throw new Error("Invalid deploy project count");
  return { target: { chatId: chat, messageThreadId: topic }, statePath, gitlabUrl,
    gitlabToken: required(env, "GITLAB_TOKEN"), telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    projectIds, intervalMs: intervalSeconds * 1000 };
}

interface Dependencies {
  call?: DeployTelegramCall;
  collect?: (options: CollectDeployRowOptions) => Promise<DeploySummaryRow>;
  autoSchedule?: boolean;
  log?: (message: string) => void;
}

export class MircliDeploySummary {
  private timer: NodeJS.Timeout | undefined;
  private timerDueAt = 0;
  private animationTimer: NodeJS.Timeout | undefined;
  private animationRun: Promise<void> | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private dirty = new Set<string>();
  private lastFullRefreshAt = 0;
  private closed = false;
  private constructor(private readonly config: MircliDeploySummaryConfig, private readonly topic: MircliDeployTopic,
    private readonly dependencies: Dependencies) {}

  static async open(config: MircliDeploySummaryConfig, dependencies: Dependencies = {}): Promise<MircliDeploySummary> {
    const topic = await MircliDeployTopic.open({ statePath: config.statePath, target: config.target,
      call: dependencies.call ?? deployTelegramCall(config.telegramToken) });
    const summary = new MircliDeploySummary(config, topic, dependencies);
    summary.schedule(0);
    return summary;
  }

  rows(): DeploySummaryRow[] { return this.topic.rows(); }
  async selectView(request: DeployViewRequest): Promise<void> {
    if (this.closed) throw new Error("Deploy summary closed");
    await this.topic.selectView(request, renderDeploySummary(this.topic.rows(), request.ref)[0]);
    this.scheduleAnimation();
  }

  invalidate(projectPath: string): void {
    if (this.closed || !Object.hasOwn(this.config.projectIds, projectPath)) return;
    this.dirty.add(projectPath);
    if (!this.active) this.schedule(1000);
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const controller = new AbortController();
    this.controller = controller;
    const full = !this.dirty.size || Date.now() - this.lastFullRefreshAt >= this.config.intervalMs;
    const projects = full ? Object.keys(this.config.projectIds) : [...this.dirty];
    if (full) this.lastFullRefreshAt = Date.now();
    this.dirty.clear();
    const active = this.update(projects, controller.signal);
    this.active = active;
    void active.finally(() => {
      this.active = undefined;
      this.controller = undefined;
      this.schedule(this.dirty.size ? 1000 : Math.max(1000, this.config.intervalMs - (Date.now() - this.lastFullRefreshAt)));
    }).catch(() => undefined);
    return active;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.animationTimer) clearTimeout(this.animationTimer);
    this.controller?.abort();
    await this.active?.catch(() => undefined);
    await this.animationRun?.catch(() => undefined);
    await this.topic.close();
  }

  private async update(projects: readonly string[], signal: AbortSignal): Promise<void> {
    const previous = this.topic.rows();
    const rows = Object.keys(this.config.projectIds).flatMap((projectPath) => (['main', 'production'] as const).map((ref) =>
      previous.find((row) => row.projectPath === projectPath && row.ref === ref) ?? { projectPath, ref, active: [] }));
    const work = rows.filter((row) => projects.includes(row.projectPath));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, work.length) }, async () => {
      while (cursor < work.length && !signal.aborted) {
        const row = work[cursor++];
        let fresh: DeploySummaryRow;
        try {
          fresh = await (this.dependencies.collect ?? collectDeployRow)({ gitlabUrl: this.config.gitlabUrl,
            token: this.config.gitlabToken, projectPath: row.projectPath, projectId: this.config.projectIds[row.projectPath],
            ref: row.ref, signal });
        } catch { fresh = { projectPath: row.projectPath, ref: row.ref, active: [], error: "GitLab: обновление не удалось" }; }
        if (signal.aborted) return;
        const next = fresh.error ? { ...row,
          active: fresh.active.length ? fresh.active : row.active,
          waiting: fresh.waiting?.length ? fresh.waiting : row.waiting,
          latest: fresh.latest ?? row.latest, success: fresh.success ?? row.success,
          error: fresh.error,
        } : fresh;
        rows[rows.findIndex((item) => item.projectPath === row.projectPath && item.ref === row.ref)] = next;
      }
    }));
    if (signal.aborted) return;
    await this.topic.saveRows(rows);
    // Independent publishing retries preserve ids and never enqueue review or event messages.
    const ref = this.topic.view();
    if (signal.aborted) return;
    try { await this.topic.publish(ref, renderDeploySummary(rows, ref)); }
    catch { (this.dependencies.log ?? console.error)(`MirCli deploy summary ${ref}: Telegram update failed; retry scheduled`); }
    this.scheduleAnimation();
  }

  private scheduleAnimation(): void {
    if (this.animationTimer) clearTimeout(this.animationTimer);
    this.animationTimer = undefined;
    const ref = this.topic.view();
    if (this.closed || this.dependencies.autoSchedule === false || this.animationRun
      || !this.topic.rows().some(row => row.ref === ref && canAnimateDeploy(row))) return;
    this.animationTimer = setTimeout(() => {
      this.animationTimer = undefined;
      const work = this.animate();
      this.animationRun = work;
      void work.catch(() => (this.dependencies.log ?? console.error)("MirCli deploy animation: Telegram update failed"))
        .finally(() => { this.animationRun = undefined; this.scheduleAnimation(); });
    }, 5_000);
    this.animationTimer.unref();
  }

  private async animate(): Promise<void> {
    if (this.closed) return;
    const rows = this.topic.rows();
    const ref = this.topic.view();
    if (rows.some(row => row.ref === ref && canAnimateDeploy(row))) {
      await this.topic.publish(ref, renderDeploySummary(rows, ref));
    }
  }

  private schedule(delay: number): void {
    if (this.closed || this.dependencies.autoSchedule === false || this.active) return;
    const dueAt = Date.now() + delay;
    if (this.timer && this.timerDueAt <= dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => (this.dependencies.log ?? console.error)("MirCli deploy summary: state update failed; retry scheduled"));
    }, delay);
    this.timer.unref();
  }
}

function selectedProjects(raw: string, allowed: Readonly<Record<string, number>>): Record<string, number> {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length
    || !value.every((key) => typeof key === "string" && Object.hasOwn(allowed, key))) throw new Error("Invalid MIRCLI_DEPLOY_PROJECTS");
  return Object.fromEntries(value.map((key) => [key, allowed[key]]));
}
function integer(raw: string, min: number, max: number, name: string): number {
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error(`Invalid ${name}`);
  return Number(raw);
}
function required(env: Readonly<Record<string, string | undefined>>, key: string, fallback?: string): string {
  const value = env[key] ?? (fallback ? env[fallback] : undefined);
  if (!value?.trim() || value !== value.trim()) throw new Error(`${key} is required`);
  return value;
}
