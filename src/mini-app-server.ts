import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { JiraMiniAppController } from "./jira-mini-app.js";
import type { DashboardQuery, DashboardView } from "./dashboard-api.js";
import { validateTelegramInitData } from "./mini-app-auth.js";
import type {
  TelegramStatusAction,
  TelegramStatusActionKind,
} from "./telegram-status-projection.js";

const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,15}-\d+$/;
const JOB_ID_PATTERN = THREAD_ID_PATTERN;
const ACTION_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ACTION_BODY_BYTES = 2_048;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROBE_REASON_CODES = new Set([
  "STORE_UNAVAILABLE",
  "STORE_TIMEOUT",
  "STORE_READ_ONLY",
  "MIGRATION_PENDING",
  "RECONCILIATION_PENDING",
  "POLLING_NOT_OWNED",
  "APP_SERVER_UNAVAILABLE",
  "GUARDIAN_UNAVAILABLE",
  "TELEGRAM_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
  "PROBE_NOT_CONFIGURED",
  "PROBE_FAILED",
  "PROBE_TIMEOUT",
]);
const ACTION_KINDS = new Set<TelegramStatusActionKind>([
  "abort", "refresh", "details", "inspect", "retry_new_turn", "guardian_restore",
  "retry_delivery", "send_again_warning",
]);

export interface MiniAppProbeResult {
  readonly ok: boolean;
  readonly reasonCodes: readonly string[];
}

export interface MiniAppProbeProvider {
  health(signal?: AbortSignal): Promise<MiniAppProbeResult>;
  readiness(signal?: AbortSignal): Promise<MiniAppProbeResult>;
}

export type MiniAppDependencyReasonCode =
  | "APP_SERVER_UNAVAILABLE"
  | "GUARDIAN_UNAVAILABLE"
  | "TELEGRAM_UNAVAILABLE"
  | "DEPENDENCY_UNAVAILABLE";

export interface MiniAppProbeChecks {
  healthReadStore?: () => Promise<void>;
  readStore(): Promise<void>;
  writeStore(): Promise<void>;
  migrationComplete(): boolean;
  reconciliationComplete(): boolean;
  pollingOwned(): boolean;
  dependencies: ReadonlyArray<{
    readonly unavailableCode: MiniAppDependencyReasonCode;
    check(signal?: AbortSignal): Promise<boolean>;
  }>;
}

export async function checkTelegramApiAvailability(
  api: { getMe(signal?: never): Promise<unknown> },
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // grammY types this with abort-controller's compatible AbortSignal shim.
    await api.getMe(signal as never);
    return true;
  } catch {
    return false;
  }
}

export function createMiniAppProbeProvider(checks: MiniAppProbeChecks): MiniAppProbeProvider {
  return {
    health: async (_signal) => {
      try {
        await (checks.healthReadStore ?? checks.readStore)();
        return { ok: true, reasonCodes: [] };
      } catch {
        return { ok: false, reasonCodes: ["STORE_UNAVAILABLE"] };
      }
    },
    readiness: async (signal) => {
      const reasonCodes: string[] = [];
      if (!checks.migrationComplete()) reasonCodes.push("MIGRATION_PENDING");
      if (!checks.reconciliationComplete()) reasonCodes.push("RECONCILIATION_PENDING");
      if (!checks.pollingOwned()) reasonCodes.push("POLLING_NOT_OWNED");
      const results = await Promise.allSettled([
        checks.readStore(),
        checks.writeStore(),
        ...checks.dependencies.map(async (dependency) => {
          if (!await dependency.check(signal)) throw new DependencyUnavailable(dependency.unavailableCode);
        }),
      ]);
      if (results[0]?.status === "rejected") reasonCodes.push("STORE_UNAVAILABLE");
      if (results[1]?.status === "rejected") reasonCodes.push("STORE_READ_ONLY");
      for (const result of results.slice(2)) {
        if (result.status !== "rejected") continue;
        reasonCodes.push(result.reason instanceof DependencyUnavailable
          ? result.reason.reasonCode : "DEPENDENCY_UNAVAILABLE");
      }
      return { ok: reasonCodes.length === 0, reasonCodes: [...new Set(reasonCodes)] };
    },
  };
}

class DependencyUnavailable extends Error {
  constructor(readonly reasonCode: MiniAppDependencyReasonCode) { super(reasonCode); }
}

export interface MiniAppTopicResult {
  created: boolean;
  url: string;
}

export interface MiniAppServerOptions {
  host: string;
  port: number;
  staticDir: string;
  botToken: string;
  allowedUserIds: ReadonlySet<number>;
  authMaxAgeSeconds: number;
  loadDashboard(query: DashboardQuery): Promise<unknown>;
  ensureTopic(threadId: string): Promise<MiniAppTopicResult>;
  runJobAction?(action: TelegramStatusAction): Promise<void>;
  probes?: MiniAppProbeProvider;
  probeTimeoutMs?: number;
  jira?: JiraMiniAppController;
  nowSeconds?: () => number;
  logger?: Pick<Console, "info" | "warn">;
}

export interface RunningMiniAppServer {
  url: string;
  close(): Promise<void>;
}

export async function startMiniAppServer(
  options: MiniAppServerOptions,
): Promise<RunningMiniAppServer> {
  const logger = options.logger ?? console;
  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error) => {
      const status = statusCode(error);
      if (status >= 500) logger.warn(`Mini App request failed: ${describe(error)}`);
      if (!response.headersSent) {
        sendJson(response, status, { error: status === 401 ? "Unauthorized" : "Internal server error" });
      }
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Mini App server did not expose a TCP address");
  }
  const displayHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  const url = `http://${displayHost}:${address.port}`;
  logger.info(`Mini App server: ${url}`);
  return {
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MiniAppServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" && request.method === "GET") {
    await sendProbe(
      response,
      options.probes ? (signal) => options.probes!.health(signal) : undefined,
      options.probeTimeoutMs,
    );
    return;
  }
  if (url.pathname === "/readyz" && request.method === "GET") {
    await sendProbe(
      response,
      options.probes ? (signal) => options.probes!.readiness(signal) : undefined,
      options.probeTimeoutMs,
    );
    return;
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    authenticate(request, options);
    const rawView = url.searchParams.get("view") ?? "active";
    if (!isDashboardView(rawView)) throw httpError(400, "Invalid view");
    const query: DashboardQuery = {
      view: rawView,
      offset: boundedQueryInteger(url.searchParams, "offset", 0, 0, 1_000_000),
      limit: boundedQueryInteger(url.searchParams, "limit", 30, 1, 100),
    };
    sendJson(response, 200, await options.loadDashboard(query));
    return;
  }

  const topicMatch = /^\/api\/dashboard\/threads\/([^/]+)\/topic$/.exec(url.pathname);
  if (topicMatch && request.method === "POST" && THREAD_ID_PATTERN.test(topicMatch[1])) {
    authenticate(request, options);
    sendJson(response, 200, await options.ensureTopic(topicMatch[1]));
    return;
  }
  const actionMatch = /^\/api\/dashboard\/jobs\/([^/]+)\/actions\/([^/]+)$/.exec(url.pathname);
  if (actionMatch && request.method === "POST" && JOB_ID_PATTERN.test(actionMatch[1])) {
    authenticate(request, options);
    if (!options.runJobAction) throw httpError(503, "Dashboard job actions are unavailable");
    const body = await readJsonObject(request);
    const action = parseJobAction(actionMatch[1], actionMatch[2], body);
    await options.runJobAction(action);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (options.jira) {
    const refresh = url.searchParams.get("refresh") === "1";
    if (url.pathname === "/api/jira/my-sprint" && request.method === "GET") {
      authenticate(request, options);
      sendJson(response, 200, await options.jira.getMySprint(refresh));
      return;
    }
    if (url.pathname === "/api/jira/sprint" && request.method === "GET") {
      authenticate(request, options);
      sendJson(response, 200, await options.jira.getSprint(refresh));
      return;
    }
    if (url.pathname === "/api/jira/backlog" && request.method === "GET") {
      authenticate(request, options);
      const startAt = boundedQueryInteger(url.searchParams, "startAt", 0, 0, 1_000_000);
      const limit = boundedQueryInteger(url.searchParams, "limit", 50, 1, 100);
      sendJson(response, 200, await options.jira.getBacklog(startAt, limit, refresh));
      return;
    }
    if (url.pathname === "/api/jira/kanban" && request.method === "GET") {
      authenticate(request, options);
      sendJson(response, 200, await options.jira.getKanban(refresh));
      return;
    }
    if (url.pathname === "/api/jira/filters" && request.method === "GET") {
      authenticate(request, options);
      sendJson(response, 200, await options.jira.getFilters(refresh));
      return;
    }
    const filterMatch = /^\/api\/jira\/filters\/(\d+)$/.exec(url.pathname);
    if (filterMatch && request.method === "GET") {
      authenticate(request, options);
      sendJson(response, 200, await options.jira.runFilter(filterMatch[1], refresh));
      return;
    }
    const issueMatch = /^\/api\/jira\/issues\/([^/]+)$/.exec(url.pathname);
    if (issueMatch && request.method === "GET" && JIRA_ISSUE_KEY_PATTERN.test(issueMatch[1])) {
      authenticate(request, options);
      sendJson(response, 200, await options.jira.getIssue(issueMatch[1], refresh));
      return;
    }
    const jiraThreadMatch = /^\/api\/jira\/issues\/([^/]+)\/thread$/.exec(url.pathname);
    if (
      jiraThreadMatch
      && request.method === "POST"
      && JIRA_ISSUE_KEY_PATTERN.test(jiraThreadMatch[1])
    ) {
      authenticate(request, options);
      sendJson(response, 200, await options.jira.ensureThread(jiraThreadMatch[1]));
      return;
    }
  }
  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  await sendStatic(response, url.pathname, request.method === "HEAD", options.staticDir);
}

async function sendProbe(
  response: ServerResponse,
  probe: ((signal: AbortSignal) => Promise<MiniAppProbeResult>) | undefined,
  configuredTimeoutMs: number | undefined,
): Promise<void> {
  if (!probe) {
    sendJson(response, 503, { status: "fail", reasons: ["PROBE_NOT_CONFIGURED"] });
    return;
  }
  const timeoutMs = positiveInteger(configuredTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, "probe timeout");
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      probe(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ProbeTimeout();
          reject(error);
          controller.abort(error);
        }, timeoutMs);
      }),
    ]);
    const reasons = safeProbeReasons(result.reasonCodes);
    if (result.ok !== true && reasons.length === 0) reasons.push("PROBE_FAILED");
    const ok = result.ok === true && reasons.length === 0;
    sendJson(response, ok ? 200 : 503, { status: ok ? "ok" : "fail", reasons });
  } catch (error) {
    const code = error instanceof ProbeTimeout ? "PROBE_TIMEOUT" : "PROBE_FAILED";
    sendJson(response, 503, { status: "fail", reasons: [code] });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeProbeReasons(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 8) throw new Error("Invalid probe reasons");
  const reasons = [...new Set(values)];
  if (reasons.some((value) => !PROBE_REASON_CODES.has(value))) {
    throw new Error("Invalid probe reason");
  }
  return reasons;
}

class ProbeTimeout extends Error {}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_ACTION_BODY_BYTES) throw httpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw httpError(400, "Invalid request body");
  }
}

function parseJobAction(
  jobId: string,
  rawKind: string,
  body: Record<string, unknown>,
): TelegramStatusAction {
  if (!ACTION_KINDS.has(rawKind as TelegramStatusActionKind)) {
    throw httpError(400, "Invalid dashboard action");
  }
  const allowedKeys = new Set(["expectedVersion", "alertId", "partKey"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw httpError(400, "Invalid dashboard action");
  }
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
    throw httpError(400, "Invalid dashboard action");
  }
  const optional = (name: "alertId" | "partKey"): string | undefined => {
    const value = body[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !ACTION_VALUE_PATTERN.test(value)) {
      throw httpError(400, "Invalid dashboard action");
    }
    return value;
  };
  const alertId = optional("alertId");
  const partKey = optional("partKey");
  return {
    kind: rawKind as TelegramStatusActionKind,
    jobId,
    expectedVersion: body.expectedVersion as number,
    ...(alertId === undefined ? {} : { alertId }),
    ...(partKey === undefined ? {} : { partKey }),
  };
}

function authenticate(request: IncomingMessage, options: MiniAppServerOptions): void {
  const header = request.headers["x-telegram-init-data"];
  const initData = Array.isArray(header) ? header[0] : header;
  try {
    validateTelegramInitData(initData ?? "", {
      botToken: options.botToken,
      allowedUserIds: options.allowedUserIds,
      maxAgeSeconds: options.authMaxAgeSeconds,
      nowSeconds: options.nowSeconds?.(),
    });
  } catch {
    const error = new Error("Unauthorized") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
}

async function sendStatic(
  response: ServerResponse,
  pathname: string,
  headOnly: boolean,
  staticDir: string,
): Promise<void> {
  const root = path.resolve(staticDir);
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (!(await isFile(filePath)) && path.extname(relative) === "") {
    filePath = path.join(root, "index.html");
  }
  if (!(await isFile(filePath))) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const content = await readFile(filePath);
  response.writeHead(200, {
    "content-type": mimeType(filePath),
    "content-length": content.length,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(headOnly ? undefined : content);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCode(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  const value = (error as { statusCode?: unknown }).statusCode;
  return value === 400 || value === 401 || value === 413 || value === 503 ? value : 500;
}

function httpError(statusCodeValue: 400 | 413 | 503, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCodeValue;
  return error;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error(`Invalid ${name}`);
  return value;
}

function boundedQueryInteger(
  params: URLSearchParams, name: string, fallback: number, minimum: number, maximum: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw httpError(400, `Invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw httpError(400, `Invalid ${name}`);
  return value;
}

function isDashboardView(value: string): value is DashboardView {
  return value === "active" || value === "recent" || value === "attention";
}
