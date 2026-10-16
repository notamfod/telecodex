import { collectDeployFailure } from "./mircli-deploy-error.js";

export interface DeployRecord {
  id: number;
  jobId: number;
  projectPath: string;
  ref: "main" | "production";
  status: string;
  sha: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  startedAt?: string;
  failureSummary?: string;
  jobUrl: string;
  title?: string;
  deployer?: string;
}

export interface DeploySummaryRow {
  projectPath: string;
  ref: "main" | "production";
  active: DeployRecord[];
  waiting?: DeployRecord[];
  latest?: DeployRecord;
  success?: DeployRecord;
  checkedAt?: string;
  error?: string;
}

export interface CollectDeployRowOptions {
  gitlabUrl: string;
  token: string;
  projectPath: string;
  projectId: number;
  ref: "main" | "production";
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

const STATUSES = new Set(["created", "running", "blocked", "success", "failed", "canceled"]);
const TERMINAL = new Set(["success", "failed", "canceled"]);
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const date = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const project = (value: unknown): value is string => typeof value === "string" && value.length <= 250 && value.split("/").length >= 2 && value.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..");
const shortText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

function safeJobUrl(value: unknown, projectPath: string, jobId: number): boolean {
  if (typeof value !== "string" || value.length > 1000) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith(`/${projectPath}/-/jobs/${jobId}`);
  } catch { return false; }
}

function isRecord(value: unknown): value is DeployRecord {
  return object(value) && id(value.id) && id(value.jobId) && project(value.projectPath) && (value.ref === "main" || value.ref === "production") && typeof value.status === "string" && STATUSES.has(value.status) && typeof value.sha === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value.sha) && date(value.createdAt) && date(value.updatedAt) && (value.finishedAt === undefined || date(value.finishedAt)) && (value.startedAt === undefined || date(value.startedAt)) && (value.failureSummary === undefined || (shortText(value.failureSummary, 180) && value.failureSummary.length > 0 && !/[\u0000-\u001f\u007f]/.test(value.failureSummary))) && (value.title === undefined || shortText(value.title, 300)) && (value.deployer === undefined || (shortText(value.deployer, 80) && value.deployer.length > 0)) && safeJobUrl(value.jobUrl, value.projectPath, value.jobId);
}

function userName(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  for (const candidate of [value.name, value.username]) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    let name = "";
    for (const character of normalized) {
      if (name.length + character.length > 80) break;
      name += character;
    }
    if (name) return name;
  }
  return undefined;
}

export function isDeploySummaryRow(value: unknown): value is DeploySummaryRow {
  if (!object(value) || !project(value.projectPath) || (value.ref !== "main" && value.ref !== "production") || !Array.isArray(value.active) || value.active.length > MAX_PAGES * PAGE_SIZE * 2) return false;
  const matches = (record: unknown): record is DeployRecord => isRecord(record) && record.projectPath === value.projectPath && record.ref === value.ref;
  return value.active.every((record) => matches(record) && record.status === "running") && (value.waiting === undefined || (Array.isArray(value.waiting) && value.waiting.length <= MAX_PAGES * PAGE_SIZE * 2 && value.waiting.every((record) => matches(record) && ["created", "blocked"].includes(record.status)))) && (value.latest === undefined || (matches(value.latest) && TERMINAL.has(value.latest.status))) && (value.success === undefined || (matches(value.success) && value.success.status === "success")) && (value.checkedAt === undefined || date(value.checkedAt)) && (value.error === undefined || shortText(value.error, 1000));
}

function decode(raw: unknown, options: CollectDeployRowOptions, base: string): DeployRecord | undefined {
  if (!object(raw) || typeof raw.ref !== "string" || !object(raw.environment) || typeof raw.environment.name !== "string") throw new Error("Некорректный ответ GitLab");
  if (raw.ref !== options.ref || raw.environment.name !== (options.ref === "main" ? "develop" : "production")) return undefined;
  if (!object(raw.deployable)) throw new Error("Некорректный ответ GitLab: нет deploy job");
  const job = raw.deployable;
  if (typeof job.name !== "string") throw new Error("Некорректный ответ GitLab: нет имени deploy job");
  if (job.name !== (options.ref === "main" ? "deploy:develop" : "deploy:production")) return undefined;
  const deployer = userName(job.user) ?? userName(raw.user);
  const record: unknown = {
    id: raw.id, jobId: job.id, projectPath: options.projectPath, ref: raw.ref,
    status: raw.status, sha: raw.sha, createdAt: raw.created_at, updatedAt: raw.updated_at,
    ...(job.started_at == null ? {} : { startedAt: job.started_at }),
    ...(job.finished_at == null ? {} : { finishedAt: job.finished_at }),
    jobUrl: `${base}/${options.projectPath}/-/jobs/${job.id}`,
    ...(object(job.commit) && typeof job.commit.title === "string" ? { title: job.commit.title.slice(0, 300) } : {}),
    ...(deployer ? { deployer } : {}),
  };
  if (!isRecord(record)) throw new Error("Некорректный ответ GitLab");
  return record;
}

/** Read-only; deployments API has no ref filter, so every page is filtered locally. */
export async function collectDeployRow(options: CollectDeployRowOptions): Promise<DeploySummaryRow> {
  const row: DeploySummaryRow = { projectPath: options.projectPath, ref: options.ref, active: [], waiting: [] };
  const errors: string[] = [];
  let latestFailureReason: unknown;
  let base: string;
  try {
    const url = new URL(options.gitlabUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !id(options.projectId) || !project(options.projectPath) || !["main", "production"].includes(options.ref)) throw new Error();
    base = url.toString().replace(/\/+$/, "");
  } catch {
    return { ...row, error: "Некорректные настройки GitLab" };
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const collect = async (status: "created" | "running" | "blocked" | "success" | undefined): Promise<void> => {
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (options.signal?.aborted) throw new Error("Запрос отменён");
        const url = new URL(`${base}/api/v4/projects/${options.projectId}/deployments`);
        url.search = new URLSearchParams({ environment: options.ref === "main" ? "develop" : "production", order_by: "id", sort: "desc", per_page: String(PAGE_SIZE), page: String(page), ...(status ? { status } : {}) }).toString();
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 10_000);
        let payload: unknown;
        let next: string | null;
        try {
          const response = await fetchImpl(url.toString(), { headers: { "PRIVATE-TOKEN": options.token }, signal: controller.signal, redirect: "error" });
          if (!response.ok) throw new Error(`GitLab HTTP ${response.status}`);
          payload = await response.json();
          next = response.headers.get("x-next-page");
        } catch (error) {
          if (error instanceof Error && /^GitLab HTTP \d{3}$/.test(error.message)) throw error;
          throw new Error(options.signal?.aborted ? "Запрос отменён" : controller.signal.aborted ? "GitLab: превышено время запроса" : "GitLab: ошибка запроса или JSON");
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        }
        if (!Array.isArray(payload) || payload.length > PAGE_SIZE) throw new Error("Некорректный ответ GitLab");
        const records = payload.map((item) => decode(item, options, base)).filter((item): item is DeployRecord => !!item).sort((a, b) => b.id - a.id);
        if (status === "running") row.active.push(...records.filter((record) => record.status === status));
        else if (status === "created" || status === "blocked") row.waiting!.push(...records.filter((record) => record.status === status));
        else if (status === "success") {
          const success = records.find((record) => record.status === "success");
          if (success) { row.success = success; return; }
        } else {
          const latest = records.find((record) => TERMINAL.has(record.status));
          if (latest) {
            row.latest = latest;
            const raw = payload.find((item) => object(item) && item.id === latest.id);
            latestFailureReason = object(raw) && object(raw.deployable) ? raw.deployable.failure_reason : undefined;
            return;
          }
        }
        if (next === "" || (next === null && payload.length < PAGE_SIZE)) return;
        if (next !== null && (!/^\d+$/.test(next) || Number(next) !== page + 1)) throw new Error("Некорректная пагинация GitLab");
        if (page === MAX_PAGES) throw new Error("Данные неполные: достигнут лимит страниц GitLab");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "GitLab: ошибка запроса");
    }
  };
  // The caller bounds row workers; keep one HTTP request per worker in flight.
  for (const status of ["created", "running", "blocked", undefined, "success"] as const) await collect(status);
  row.active = [...new Map(row.active.map((record) => [record.id, record])).values()].sort((a, b) => b.id - a.id);
  row.waiting = [...new Map(row.waiting!.map((record) => [record.id, record])).values()].sort((a, b) => b.id - a.id);
  // Older manual jobs remain invocable forever, but belong to superseded attempts.
  row.waiting = row.latest ? row.waiting.filter((record) => record.id > row.latest!.id) : row.waiting.slice(0, 1);
  if (row.latest?.status === "failed" && !options.signal?.aborted) {
    row.latest.failureSummary = await collectDeployFailure({ base, token: options.token, projectId: options.projectId,
      jobId: row.latest.jobId, failureReason: latestFailureReason, signal: options.signal, fetch: fetchImpl });
  }
  if (errors.length) row.error = [...new Set(errors)].join("; ");
  else row.checkedAt = new Date().toISOString();
  return row;
}
