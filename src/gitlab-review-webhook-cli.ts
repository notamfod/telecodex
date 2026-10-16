#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  GitlabReviewQueue,
  type GitlabReviewEvent,
  type GitlabReviewResult,
  type GitlabReviewRunResults,
  type GitlabReviewFeedback,
  isValidResult,
} from "./gitlab-review-queue.js";
import { GitlabReviewFeedbackStore } from "./gitlab-review-feedback.js";
import { GitlabReviewLaunchStore, type GitlabReviewLaunchTarget } from "./gitlab-review-launch.js";
import { loadGitlabReviewLaunchSecret } from "./gitlab-review-launch-client.js";
import { runOwnedProcessGroup, type OwnedProcessGroupOptions } from "./gitlab-review-runner.js";
import { parseGitlabSigningToken, startGitlabReviewWebhook } from "./gitlab-review-webhook.js";
import { parseRecipes, RECIPE_CONFIG_PATH, type MircliReviewRecipe } from "./recipe-config.js";
import { sendRecipeMessage } from "./recipe-telegram.js";
import { gitlabReviewKeyboard, type GitlabReviewKeyboard } from "./gitlab-review-links.js";
import type { GitlabReviewDetails } from "./gitlab-review-details.js";
import { loadMircliDeploySummaryConfig, MircliDeploySummary } from "./mircli-deploy-summary.js";

const MAX_RUNNER_OUTPUT_BYTES = 256 * 1024;
const RUNNER_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PROJECT_PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

export interface GitlabReviewWebhookConfig {
  readonly secret: string;
  readonly signingToken: string;
  readonly projects: readonly string[];
  readonly projectIds: Readonly<Record<string, number>>;
  readonly host: string;
  readonly port: number;
  readonly statePath: string;
  readonly runnerCwd: string;
  readonly runnerPath: string;
  readonly debounceMs: number;
}

interface ReviewRunnerConfig {
  readonly runnerCwd: string;
  readonly runnerPath: string;
  readonly projects: readonly string[];
  readonly outputLogPath?: string;
}

interface ReviewEventPath {
  readonly projectPath: string;
  readonly dedupId: string;
  readonly pipeline?: true;
  readonly after?: string;
  readonly before?: string;
}

export function loadGitlabReviewWebhookConfig(
  env: Readonly<Record<string, string | undefined>>,
): GitlabReviewWebhookConfig {
  const secret = required(env, "GITLAB_REVIEW_WEBHOOK_SECRET");
  if (Buffer.byteLength(secret) < 32) {
    throw new Error("GITLAB_REVIEW_WEBHOOK_SECRET must be at least 32 bytes");
  }
  const projects = parseProjects(required(env, "GITLAB_REVIEW_WEBHOOK_PROJECTS"));
  const statePath = absolutePath(required(env, "GITLAB_REVIEW_WEBHOOK_STATE_PATH"), "STATE_PATH");
  const runnerCwd = absolutePath(required(env, "GITLAB_REVIEW_RUNNER_CWD"), "RUNNER_CWD");
  const runnerPath = absolutePath(required(env, "GITLAB_REVIEW_RUNNER_PATH"), "RUNNER_PATH");
  const signingToken = required(env, "GITLAB_REVIEW_WEBHOOK_SIGNING_TOKEN");
  parseGitlabSigningToken(signingToken);
  const projectIds = parseProjectIds(required(env, "GITLAB_REVIEW_WEBHOOK_PROJECT_IDS"), projects);
  return {
    secret,
    signingToken,
    projects,
    projectIds,
    host: optional(env, "GITLAB_REVIEW_WEBHOOK_HOST") ?? "127.0.0.1",
    port: parseInteger(optional(env, "GITLAB_REVIEW_WEBHOOK_PORT") ?? "8790", 1, 65_535, "PORT"),
    statePath,
    runnerCwd,
    runnerPath,
    debounceMs: parseInteger(
      optional(env, "GITLAB_REVIEW_WEBHOOK_DEBOUNCE_MS") ?? "30000",
      1_000,
      300_000,
      "DEBOUNCE_MS",
    ),
  };
}

export async function runDailyDiffReview(
  config: ReviewRunnerConfig,
  events: readonly ReviewEventPath[],
  dependencies: {
    readonly runProcess?: (options: OwnedProcessGroupOptions) => Promise<{ stdout: string; stderr: string }>;
    readonly log?: (message: string) => void;
    readonly signal?: AbortSignal;
  } = {},
): Promise<GitlabReviewRunResults> {
  const pipelines = events.filter((event) => event.pipeline);
  if (pipelines.length && pipelines.length !== events.length) {
    const normal = await runDailyDiffReview(config, events.filter((event) => !event.pipeline), dependencies);
    return { ...normal, ...await runDailyDiffReview(config, pipelines, dependencies) };
  }
  const allowed = new Map(config.projects.map((project) => [project, path.posix.basename(project)]));
  const projectNames = [...new Set(events.map((event) => allowed.get(event.projectPath)))].filter(
    (name): name is string => name !== undefined,
  ).sort();
  if (projectNames.length === 0 || projectNames.length !== new Set(events.map((event) => event.projectPath)).size) {
    throw new Error("GitLab review batch contains a project outside the configured allowlist");
  }
  const runProcess = dependencies.runProcess ?? runOwnedProcessGroup;
  const log = dependencies.log ?? console.log;
  try {
    const result = await runProcess({
      file: process.execPath,
      args: [config.runnerPath, "daily-diff-review", "--projects", JSON.stringify(projectNames), "--webhook",
        ...(pipelines.length ? ["--pipeline-events", JSON.stringify(pipelines.map((event) => ({
          projectPath: event.projectPath, after: event.after, ...(event.before ? { before: event.before } : {}),
        })))] : [])],
      cwd: config.runnerCwd,
      timeoutMs: RUNNER_TIMEOUT_MS,
      maxOutputBytes: MAX_RUNNER_OUTPUT_BYTES,
      signal: dependencies.signal,
      outputLogPath: config.outputLogPath,
    });
    const summary = `stdoutBytes=${Buffer.byteLength(result.stdout)} stderrBytes=${Buffer.byteLength(result.stderr)}`;
    log(`GitLab review runner completed ${summary}${config.outputLogPath ? ` outputLog=${config.outputLogPath}` : ""}`);
    const parsed = parseRunnerResults(result.stdout, projectNames);
    if (!parsed) {
      log("GitLab review runner result marker invalid");
      return {};
    }
    const byName = new Map(parsed.map(({ name, result: reviewResult }) => [name, reviewResult]));
    return Object.fromEntries(events.map((event) => [
      event.dedupId,
      byName.get(path.posix.basename(event.projectPath))!,
    ]));
  } catch (error) {
    log(`GitLab review runner failed${config.outputLogPath ? ` outputLog=${config.outputLogPath}` : ""}`);
    throw error;
  }
}

const RESULT_MARKER = "TELECODEX_GITLAB_REVIEW_RESULT=";

function parseRunnerResults(
  stdout: string,
  selectedNames: readonly string[],
): Array<{ name: string; result: GitlabReviewResult }> | undefined {
  const line = stdout.split(/\r?\n/).reverse().find((value) => value.startsWith(RESULT_MARKER));
  if (!line || Buffer.byteLength(line) > MAX_RUNNER_OUTPUT_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(RESULT_MARKER.length));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).join(",") !== "projects"
    || !Array.isArray(value.projects) || value.projects.length !== selectedNames.length) return undefined;
  const allowed = new Set(selectedNames);
  const seen = new Set<string>();
  const parsed: Array<{ name: string; result: GitlabReviewResult }> = [];
  for (const item of value.projects) {
    if (!isRecord(item) || typeof item.name !== "string" || !allowed.has(item.name) || seen.has(item.name)) {
      return undefined;
    }
    seen.add(item.name);
    if (item.status === "unchanged" && Object.keys(item).length === 2) {
      parsed.push({ name: item.name, result: { outcome: "unchanged" } });
      continue;
    }
    if (item.status !== "reviewed"
      || Object.keys(item).some((key) => !["name", "status", "findings", "freshFindings", "details"].includes(key))
      || !boundedCount(item.findings) || !boundedCount(item.freshFindings)
      || (item.freshFindings as number) > (item.findings as number)) return undefined;
    const reviewResult = {
      outcome: "reviewed",
      findings: item.findings as number,
      freshFindings: item.freshFindings as number,
      ...(item.details === undefined ? {} : { details: item.details }),
    };
    if (!isValidResult(reviewResult)) return undefined;
    parsed.push({ name: item.name, result: reviewResult });
  }
  return parsed;
}

function boundedCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000;
}

export async function main(env = process.env): Promise<void> {
  const config = loadGitlabReviewWebhookConfig(env);
  const deployConfig = loadMircliDeploySummaryConfig(env, config);
  const launchSecret = loadGitlabReviewLaunchSecret(env);
  const telegramToken = required(env, "TELEGRAM_BOT_TOKEN");
  const configPath = env.RECIPES_CONFIG?.trim() || RECIPE_CONFIG_PATH;
  const recipe = loadDailyDiffReviewRecipe(await readFile(
    path.isAbsolute(configPath) ? configPath : path.resolve(config.runnerCwd, configPath),
    "utf8",
  ));
  const queue = await GitlabReviewQueue.open({
    statePath: config.statePath,
    debounceMs: config.debounceMs,
    runReview: (events: readonly GitlabReviewEvent[], signal: AbortSignal) => runDailyDiffReview(
      { ...config, outputLogPath: `${config.statePath}.runner.log` },
      events,
      { signal },
    ),
  });
  const links = { gitlabUrl: env.GITLAB_URL, miniAppLaunchUrl: env.MINI_APP_LAUNCH_URL };
  let launches: GitlabReviewLaunchStore;
  let feedback: GitlabReviewFeedbackStore;
  try {
    launches = await GitlabReviewLaunchStore.open({
      statePath: `${config.statePath}.launches.json`,
      target: recipe.deliver!,
      enqueue: (event) => queue.enqueue(event),
      canRecyclePipeline: (requestId, dedupId) => feedback?.hasDeliveredCompletion(requestId, queue.feedback(dedupId)) === true,
      links,
      sendCard: async (card, target, signal) => {
        const fetchWithSignal: typeof fetch = (input, init) => fetch(input, { ...init, signal });
        const messageId = await sendRecipeMessage({ ...recipe, deliver: target }, card.html, card.replyMarkup, {
          token: telegramToken,
          fetch: fetchWithSignal,
          sleep: (milliseconds) => abortableSleep(milliseconds, signal),
        });
        if (messageId === undefined) throw new Error("Telegram did not return a message id");
        return messageId;
      },
    });
  } catch (error) {
    await queue.close();
    throw error;
  }
  try {
    feedback = await GitlabReviewFeedbackStore.open({
      statePath: `${config.statePath}.feedback.json`,
      listOffers: () => launches.feedbackOffers(),
      feedbackFor: (dedupId) => queue.feedback(dedupId),
      editCard: (offer, html, signal) => editGitlabReviewCard(
        offer.target,
        offer.messageId,
        html,
        { token: telegramToken, signal, replyMarkup: gitlabReviewKeyboard(
          offer.event, offer.requestId, links, false,
          completedDetails(queue.feedback(offer.dedupId)),
        ) },
      ),
    });
  } catch (error) {
    await launches.close();
    await queue.close();
    throw error;
  }
  let webhook: Awaited<ReturnType<typeof startGitlabReviewWebhook>>;
  let deployments: MircliDeploySummary | undefined;
  try {
    if (deployConfig) deployments = await MircliDeploySummary.open(deployConfig);
    webhook = await startGitlabReviewWebhook({
      host: config.host,
      port: config.port,
      secret: config.secret,
      signingToken: config.signingToken,
      projects: config.projects,
      projectIds: config.projectIds,
      offer: (event, summary) => launches.offer(event, summary),
      launchSecret,
      onLaunch: (activation) => launches.activate(activation),
      onPipeline: (activation) => launches.activate(activation, true),
      ...(deployments ? {
        onDeployment: (projectPath: string) => deployments!.invalidate(projectPath),
        onDeployView: (request) => deployments!.selectView(request),
      } : {}),
    });
  } catch (error) {
    await deployments?.close();
    await feedback.close();
    await launches.close();
    await queue.close();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    stopping ??= (async () => {
      await webhook.close();
      await deployments?.close();
      await feedback.close();
      await launches.close();
      await queue.close();
    })();
    return stopping;
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0), () => process.exit(1)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0), () => process.exit(1)));
  console.log(`GitLab review webhook listening on ${webhook.host}:${webhook.port}`);
}

export async function editGitlabReviewCard(
  target: GitlabReviewLaunchTarget,
  messageId: number,
  html: string,
  dependencies: {
    readonly token?: string;
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly replyMarkup?: GitlabReviewKeyboard;
  } = {},
): Promise<void> {
  const token = dependencies.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram token unavailable");
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Telegram card edit timeout is invalid");
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, timeoutSignal])
    : timeoutSignal;
  signal.throwIfAborted();
  const response = await (dependencies.fetch ?? fetch)(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        message_id: messageId,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        text: html,
        reply_markup: dependencies.replyMarkup ?? { inline_keyboard: [] },
      }),
      signal,
    },
  );
  if (response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  const responseBody = await readBoundedResponseText(response, 4_096, signal);
  if (response.status === 400 && responseBody.includes("message is not modified")) return;
  throw new Error(`Telegram card edit failed with status ${response.status}`);
}

function completedDetails(feedback: GitlabReviewFeedback | undefined): GitlabReviewDetails | undefined {
  return feedback?.phase === "completed" && feedback.result?.outcome === "reviewed"
    ? feedback.result.details : undefined;
}

async function readBoundedResponseText(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= maximum) {
    const chunk = await readResponseChunk(reader, signal);
    if (chunk.done) return Buffer.concat(chunks).toString("utf8");
    size += chunk.value.byteLength;
    if (size > maximum) break;
    chunks.push(chunk.value);
  }
  void reader.cancel().catch(() => undefined);
  return "";
}

function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      void reader.cancel().catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function loadDailyDiffReviewTarget(raw: string): GitlabReviewLaunchTarget {
  return loadDailyDiffReviewRecipe(raw).deliver!;
}

function loadDailyDiffReviewRecipe(raw: string): MircliReviewRecipe {
  const recipe = parseRecipes(raw).find(({ id }) => id === "daily-diff-review");
  if (!recipe || recipe.kind !== "mircli-review") {
    throw new Error("daily-diff-review mircli-review recipe is required");
  }
  if (!recipe.deliver) throw new Error("daily-diff-review requires a deliver target");
  return recipe;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function parseProjects(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("GITLAB_REVIEW_WEBHOOK_PROJECTS must be a non-empty JSON array");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 500
    || !value.every((item) => typeof item === "string"
      && item.length <= 300 && PROJECT_PATH_PATTERN.test(item))
    || new Set(value).size !== value.length) {
    throw new Error("GITLAB_REVIEW_WEBHOOK_PROJECTS must be a non-empty JSON array of unique project paths");
  }
  return value as string[];
}

function parseProjectIds(
  raw: string,
  projects: readonly string[],
): Record<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("GITLAB_REVIEW_WEBHOOK_PROJECT_IDS must be a JSON object");
  }
  if (!isRecord(value) || Object.keys(value).length > 500) {
    throw new Error("GITLAB_REVIEW_WEBHOOK_PROJECT_IDS must be a JSON object");
  }
  for (const id of Object.values(value)) {
    if (!Number.isInteger(id) || (id as number) <= 0) {
      throw new Error("GITLAB_REVIEW_WEBHOOK_PROJECT_IDS contains an invalid project id");
    }
  }
  const configured = Object.keys(value).sort();
  const allowlisted = [...projects].sort();
  if (configured.length !== allowlisted.length
    || configured.some((project, index) => project !== allowlisted[index])) {
    throw new Error("GITLAB_REVIEW_WEBHOOK_PROJECT_IDS keys must exactly match PROJECTS");
  }
  return value as Record<string, number>;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function optional(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  return value && value.trim() === value ? value : undefined;
}

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`GITLAB_REVIEW_WEBHOOK_${name} must be an absolute normalized path`);
  }
  return value;
}

function parseInteger(raw: string, minimum: number, maximum: number, name: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`GITLAB_REVIEW_WEBHOOK_${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`GITLAB_REVIEW_WEBHOOK_${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const entrypoint = process.argv[1];
let isMain = false;
if (entrypoint !== undefined) {
  try {
    isMain = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint);
  } catch {
    isMain = import.meta.url === pathToFileURL(path.resolve(entrypoint)).href;
  }
}
if (isMain) {
  void main().catch(() => {
    console.error("GitLab review webhook failed to start");
    process.exitCode = 1;
  });
}
