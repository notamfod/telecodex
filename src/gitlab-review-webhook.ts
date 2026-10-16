import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { GitlabReviewEnqueueResult, GitlabReviewEvent } from "./gitlab-review-queue.js";
import { DeployViewContextError, DeployViewNotReadyError, type DeployViewRequest } from "./mircli-deploy-topic.js";
import {
  GitlabReviewLaunchContextError,
  GitlabReviewLaunchNotFoundError,
  GitlabReviewLaunchNotReadyError,
  type GitlabReviewLaunchActivation,
  type GitlabReviewSummary,
} from "./gitlab-review-launch.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const MAIN_REF = "refs/heads/main";
const SHA_PATTERN = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const PROJECT_PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

export interface GitlabReviewWebhookOptions {
  readonly host: string;
  readonly port: number;
  readonly secret: string;
  readonly signingToken?: string;
  readonly projects: readonly string[];
  readonly projectIds?: Readonly<Record<string, number>>;
  readonly enqueue?: (event: GitlabReviewEvent) => Promise<GitlabReviewEnqueueResult>;
  readonly offer?: (event: GitlabReviewEvent, summary: GitlabReviewSummary) => Promise<{
    outcome: "accepted" | "duplicate";
    requestId: string;
  }>;
  readonly launchSecret?: string;
  readonly onLaunch?: (activation: GitlabReviewLaunchActivation) => Promise<GitlabReviewEnqueueResult>;
  readonly onDeployment?: (projectPath: string) => void;
  readonly onDeployView?: (request: DeployViewRequest) => Promise<void>;
  readonly bodyReadTimeoutMs?: number;
  readonly now?: () => number;
}

export interface GitlabReviewWebhook {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export async function startGitlabReviewWebhook(
  options: GitlabReviewWebhookOptions,
): Promise<GitlabReviewWebhook> {
  validateOptions(options);
  const signingKey = options.signingToken ? parseGitlabSigningToken(options.signingToken) : undefined;
  const projectSet = new Set(options.projects);
  const bodyReadTimeoutMs = boundedInteger(options.bodyReadTimeoutMs ?? 5_000, 50, 30_000, "bodyReadTimeoutMs");
  const now = options.now ?? Date.now;
  const server = createServer((request, response) => {
    void handleRequest(request, response, options, projectSet, signingKey, bodyReadTimeoutMs, now);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 100;
  server.maxRequestsPerSocket = 100;
  await listen(server, options.host, options.port);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("GitLab review webhook did not bind a TCP address");
  }
  return {
    host: options.host,
    port: address.port,
    async close() {
      server.closeAllConnections();
      await closeServer(server);
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GitlabReviewWebhookOptions,
  projects: ReadonlySet<string>,
  signingKey: Buffer | undefined,
  bodyReadTimeoutMs: number,
  now: () => number,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      request.resume();
      sendJson(response, 200, { outcome: "ok" });
      return;
    }
    if (request.method === "POST" && request.url === "/internal/gitlab/review-launch") {
      await handleLaunchRequest(request, response, options, bodyReadTimeoutMs);
      return;
    }
    if (request.method === "POST" && request.url === "/internal/gitlab/deploy-view") {
      await handleDeployViewRequest(request, response, options, bodyReadTimeoutMs);
      return;
    }
    if (request.method !== "POST" || request.url !== "/hooks/gitlab/review") {
      request.resume();
      sendJson(response, 404, { outcome: "failed" });
      return;
    }
    if (!secureEqual(singleHeader(request, "x-gitlab-token") ?? "", options.secret)) {
      request.resume();
      sendJson(response, 401, { outcome: "failed" });
      return;
    }
    const eventType = singleHeader(request, "x-gitlab-event");
    if (!signingKey && eventType !== "Push Hook" && !(eventType === "Deployment Hook" && options.onDeployment)) {
      request.resume();
      sendJson(response, 200, { outcome: "ignored" });
      return;
    }
    if (!isJsonContentType(singleHeader(request, "content-type"))) {
      request.resume();
      sendJson(response, 415, { outcome: "failed" });
      return;
    }
    const rawBody = await readBody(request, bodyReadTimeoutMs);
    if (signingKey && !verifyStandardWebhook(request, rawBody, signingKey, now())) {
      sendJson(response, 401, { outcome: "failed" });
      return;
    }
    if (eventType === "Deployment Hook" && options.onDeployment) {
      const payload = parseObject(rawBody);
      if (payload.object_kind !== "deployment" || !isRecord(payload.project)
        || typeof payload.project.path_with_namespace !== "string" || !positiveInteger(payload.project.id)
        || !positiveInteger(payload.deployment_id)) throw new HttpError(400);
      const projectPath = payload.project.path_with_namespace;
      if (!projects.has(projectPath) || options.projectIds?.[projectPath] !== payload.project.id) {
        sendJson(response, 403, { outcome: "forbidden" });
        return;
      }
      if (!["develop", "production"].includes(String(payload.environment))) {
        sendJson(response, 200, { outcome: "ignored" });
        return;
      }
      // Reconcile authoritative API data; delivery/order/replay never create notification messages.
      options.onDeployment(projectPath);
      sendJson(response, 202, { outcome: "accepted" });
      return;
    }
    if (eventType !== "Push Hook") {
      sendJson(response, 200, { outcome: "ignored" });
      return;
    }
    const payload = parseObject(rawBody);
    if (payload.object_kind !== "push") {
      sendJson(response, 200, { outcome: "ignored" });
      return;
    }
    if (payload.ref !== MAIN_REF) {
      sendJson(response, 200, { outcome: "ignored" });
      return;
    }
    if (typeof payload.after === "string" && /^0+$/.test(payload.after)) {
      sendJson(response, 200, { outcome: "ignored" });
      return;
    }
    const normalized = normalizePayload(request, payload, now());
    if (!projects.has(normalized.projectPath)) {
      sendJson(response, 403, { outcome: "forbidden" });
      return;
    }
    const pinnedId = options.projectIds?.[normalized.projectPath];
    if (pinnedId !== undefined && pinnedId !== normalized.projectId) {
      sendJson(response, 403, { outcome: "forbidden" });
      return;
    }
    const result = options.offer
      ? await options.offer(normalized, extractSummary(payload))
      : { outcome: await options.enqueue!(normalized) };
    const outcome = result.outcome;
    sendJson(response, 202, { outcome });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(response, status, { outcome: "failed" });
  }
}

async function handleDeployViewRequest(
  request: IncomingMessage, response: ServerResponse,
  options: GitlabReviewWebhookOptions, bodyReadTimeoutMs: number,
): Promise<void> {
  if (!isLoopback(request.socket.remoteAddress) || !options.launchSecret || !options.onDeployView
    || !secureEqual(singleHeader(request, "x-telecodex-review-token") ?? "", options.launchSecret)) {
    request.resume(); sendJson(response, 401, { outcome: "failed" }); return;
  }
  if (!isJsonContentType(singleHeader(request, "content-type"))) {
    request.resume(); sendJson(response, 400, { outcome: "failed" }); return;
  }
  try {
    const body = parseObject(await readBody(request, bodyReadTimeoutMs));
    if (Object.keys(body).sort().join(",") !== "chatId,messageId,messageThreadId,ref"
      || !Number.isSafeInteger(body.chatId) || body.chatId === 0 || !positiveInteger(body.messageId)
      || !positiveInteger(body.messageThreadId) || !["main", "production"].includes(String(body.ref))) throw new HttpError(400);
    await options.onDeployView(body as unknown as DeployViewRequest);
    sendJson(response, 202, { outcome: "accepted" });
  } catch (error) {
    const status = error instanceof DeployViewContextError ? 403 : error instanceof DeployViewNotReadyError ? 409
      : error instanceof HttpError ? error.status : 500;
    sendJson(response, status, { outcome: "failed" });
  }
}

async function handleLaunchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GitlabReviewWebhookOptions,
  bodyReadTimeoutMs: number,
): Promise<void> {
  if (!isLoopback(request.socket.remoteAddress)
    || !options.launchSecret || !options.onLaunch
    || !secureEqual(singleHeader(request, "x-telecodex-review-token") ?? "", options.launchSecret)) {
    request.resume();
    sendJson(response, 401, { outcome: "failed" });
    return;
  }
  if (!isJsonContentType(singleHeader(request, "content-type"))) {
    request.resume();
    sendJson(response, 400, { outcome: "failed" });
    return;
  }
  try {
    const body = parseObject(await readBody(request, bodyReadTimeoutMs));
    const activation = parseActivation(body);
    const outcome = await options.onLaunch(activation);
    sendJson(response, 202, { outcome });
  } catch (error) {
    const status = error instanceof GitlabReviewLaunchNotFoundError ? 404
      : error instanceof GitlabReviewLaunchContextError ? 403
        : error instanceof GitlabReviewLaunchNotReadyError ? 409
          : error instanceof HttpError ? error.status : 500;
    sendJson(response, status, { outcome: "failed" });
  }
}

function parseActivation(value: Record<string, unknown>): GitlabReviewLaunchActivation {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "chatId,messageId,messageThreadId,requestId"
    || typeof value.requestId !== "string" || !/^[a-f0-9]{32}$/.test(value.requestId)
    || !Number.isSafeInteger(value.chatId) || value.chatId === 0
    || !positiveInteger(value.messageThreadId) || !positiveInteger(value.messageId)) {
    throw new HttpError(400);
  }
  return value as unknown as GitlabReviewLaunchActivation;
}

function extractSummary(payload: Record<string, unknown>): GitlabReviewSummary {
  const commits = Array.isArray(payload.commits) ? payload.commits.filter(isRecord) : [];
  const after = typeof payload.after === "string" ? payload.after.toLowerCase() : "";
  const head = commits.find((commit) => typeof commit.id === "string" && commit.id.toLowerCase() === after)
    ?? commits.at(-1);
  const title = typeof head?.title === "string" ? head.title
    : typeof head?.message === "string" ? head.message.split(/\r?\n/, 1)[0] : undefined;
  return {
    ...(title ? { commitTitle: title } : {}),
    ...(Number.isSafeInteger(payload.total_commits_count)
      ? { commitCount: payload.total_commits_count as number } : {}),
    ...(typeof payload.user_name === "string" ? { author: payload.user_name } : {}),
  };
}

function normalizePayload(
  request: IncomingMessage,
  payload: Record<string, unknown>,
  receivedAt: number,
): GitlabReviewEvent {
  const project = payload.project;
  if (!isRecord(project)
    || !Number.isInteger(project.id) || (project.id as number) <= 0
    || typeof project.path_with_namespace !== "string"
    || project.path_with_namespace.length > 300
    || !PROJECT_PATH_PATTERN.test(project.path_with_namespace)
    || payload.ref !== MAIN_REF
    || typeof payload.after !== "string"
    || !SHA_PATTERN.test(payload.after)
    || (payload.before !== undefined && (typeof payload.before !== "string" || !SHA_PATTERN.test(payload.before)))) {
    throw new HttpError(400);
  }
  const suppliedId = firstHeader(request, [
    "webhook-id",
    "idempotency-key",
    "x-gitlab-event-uuid",
  ]);
  if (suppliedId !== undefined && !EVENT_ID_PATTERN.test(suppliedId)) throw new HttpError(400);
  const dedupId = suppliedId ?? `push:${createHash("sha256")
    .update(`${project.id}:${payload.ref}:${payload.after}`)
    .digest("hex")}`;
  return {
    dedupId,
    projectId: project.id as number,
    projectPath: project.path_with_namespace,
    ref: MAIN_REF,
    after: payload.after.toLowerCase(),
    ...(typeof payload.before === "string" ? { before: payload.before.toLowerCase() } : {}),
    receivedAt,
  };
}

function verifyStandardWebhook(
  request: IncomingMessage,
  rawBody: Buffer,
  signingKey: Buffer,
  nowMs: number,
): boolean {
  const id = singleHeader(request, "webhook-id");
  const timestampValue = singleHeader(request, "webhook-timestamp");
  const signatureValue = singleHeader(request, "webhook-signature");
  if (!id || !EVENT_ID_PATTERN.test(id) || !timestampValue || !signatureValue) return false;
  if (!/^\d{1,12}$/.test(timestampValue)) return false;
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp)
    || Math.abs(Math.floor(nowMs / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", signingKey)
    .update(id)
    .update(".")
    .update(timestampValue)
    .update(".")
    .update(rawBody)
    .digest();
  return signatureValue.split(" ").some((candidate) => {
    const match = /^v1,([A-Za-z0-9+/]+={0,2})$/.exec(candidate);
    if (!match) return false;
    let supplied: Buffer;
    try {
      supplied = Buffer.from(match[1], "base64");
    } catch {
      return false;
    }
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}

export function parseGitlabSigningToken(token: string): Buffer {
  if (!token.startsWith("whsec_") || token.length > 200) {
    throw new Error("GitLab review signing token must use whsec_ format");
  }
  const key = Buffer.from(token.slice("whsec_".length), "base64");
  if (key.length !== 32 || key.toString("base64") !== token.slice("whsec_".length)) {
    throw new Error("GitLab review signing token must encode exactly 32 bytes");
  }
  return key;
}

async function readBody(request: IncomingMessage, timeoutMs: number): Promise<Buffer> {
  const declared = singleHeader(request, "content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    request.resume();
    throw new HttpError(413);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: HttpError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        request.resume();
        finish(new HttpError(413));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new HttpError(400));
    const onError = () => finish(new HttpError(400));
    const timer = setTimeout(() => finish(new HttpError(408)), timeoutMs);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function parseObject(raw: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400);
  }
}

function validateOptions(options: GitlabReviewWebhookOptions): void {
  if (Buffer.byteLength(options.secret) < 32) throw new Error("GitLab webhook secret must be at least 32 bytes");
  if (!options.enqueue && !options.offer) throw new Error("GitLab webhook requires an ingress handler");
  if ((options.launchSecret === undefined) !== (options.onLaunch === undefined)) {
    throw new Error("GitLab review launch endpoint requires both secret and handler");
  }
  if (options.launchSecret !== undefined && Buffer.byteLength(options.launchSecret) < 32) {
    throw new Error("GitLab review launch secret must be at least 32 bytes");
  }
  boundedInteger(options.port, 0, 65_535, "port");
  if (options.projects.length === 0 || new Set(options.projects).size !== options.projects.length) {
    throw new Error("GitLab webhook projects must be a non-empty unique list");
  }
  for (const project of options.projects) {
    if (project.length > 300 || !PROJECT_PATH_PATTERN.test(project)) throw new Error("Invalid GitLab project path");
  }
  for (const [project, id] of Object.entries(options.projectIds ?? {})) {
    if (!projectsContain(options.projects, project) || !Number.isInteger(id) || id <= 0) {
      throw new Error("Invalid GitLab pinned project id");
    }
  }
}

function projectsContain(projects: readonly string[], project: string): boolean {
  return projects.includes(project);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function firstHeader(request: IncomingMessage, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = singleHeader(request, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
