import { pathToFileURL } from "node:url";

import { escapeHTML } from "./format.js";
import type { SentryTopRecipe } from "./recipe-config.js";
import { sentryTaskCallbackData } from "./sentry-task-thread.js";

const NOISE = ["n+1 query", "token has expired", "slow db query"];
const PERIOD_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface SentryIssueSummary {
  id: string;
  shortId: string;
  level: string;
  count: number;
  userCount: number;
  project: string;
  title: string;
  culprit: string;
  permalink: string;
}

export interface SentryRecipeResult {
  total: number;
  delivered: number;
  suppressed: number;
}

type SendSentryMessage = (html: string, replyMarkup?: Record<string, unknown>) => Promise<void>;

interface SentryCredentials {
  baseUrl: string;
  org: string;
  token: string;
}

type LoadSentryCredentials = (modulePath: string, realm: string) => Promise<SentryCredentials>;

interface SentryRecipeDependencies {
  fetch?: typeof fetch;
  loadCredentials?: LoadSentryCredentials;
  now?: () => Date;
}

async function loadDofboxSentryCredentials(
  modulePath: string,
  realm: string,
): Promise<SentryCredentials> {
  const loaded = await import(pathToFileURL(modulePath).href) as {
    loadConfig?: (options: { realm: string }) => unknown;
  };
  if (typeof loaded.loadConfig !== "function") {
    throw new Error("dofbox config module does not export loadConfig");
  }
  const config = loaded.loadConfig({ realm }) as {
    sentry?: { baseUrl?: unknown; org?: unknown; token?: unknown };
  };
  return {
    baseUrl: safeUrl(config.sentry?.baseUrl, "sentry.baseUrl").replace(/\/+$/, ""),
    org: text(config.sentry?.org, "sentry.org"),
    token: text(config.sentry?.token, "sentry.token"),
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Sentry response needs ${field}`);
  }
  return value.trim();
}

function number(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Sentry response needs numeric ${field}`);
  }
  return parsed;
}

function safeUrl(value: unknown, field: string): string {
  const raw = text(value, field);
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.href;
    }
  } catch {
    // Fall through to the field-specific error below.
  }
  throw new Error(`Sentry response needs safe ${field}`);
}

function parseIssues(raw: string): SentryIssueSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Sentry returned invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Sentry response must be a list");
  }
  return parsed.map((value, index) => {
    const issue = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const where = `issues[${index}]`;
    const project = (
      typeof issue.project === "object" && issue.project !== null
        ? (issue.project as Record<string, unknown>).slug
        : issue.project
    );
    const id = text(issue.id, `${where}.id`);
    const shortId = text(issue.shortId, `${where}.shortId`);
    sentryTaskCallbackData(id, shortId);
    return {
      id,
      shortId,
      level: text(issue.level ?? "error", `${where}.level`),
      count: number(issue.count, `${where}.count`),
      userCount: number(issue.userCount ?? 0, `${where}.userCount`),
      project: text(project, `${where}.project.slug`),
      title: text(issue.title, `${where}.title`),
      culprit: typeof issue.culprit === "string" ? issue.culprit.trim() : "",
      permalink: safeUrl(issue.permalink, `${where}.permalink`),
    };
  });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function renderIssue(issue: SentryIssueSummary): string {
  const culprit = issue.culprit ? `\n<code>${escapeHTML(truncate(issue.culprit, 240))}</code>` : "";
  return [
    `🐞 <b>${escapeHTML(issue.shortId)}</b> · ${escapeHTML(issue.project)} · ${escapeHTML(issue.level)}`,
    escapeHTML(truncate(issue.title, 500)),
    `Событий: <b>${issue.count.toLocaleString("ru-RU")}</b> · пользователей: ${issue.userCount.toLocaleString("ru-RU")}${culprit}`,
  ].join("\n");
}

function issueButtons(issue: SentryIssueSummary): Record<string, unknown> {
  return {
    inline_keyboard: [[
      { text: "🔎 Разобрать", callback_data: sentryTaskCallbackData(issue.id, issue.shortId) },
      { text: "Открыть в Sentry", url: issue.permalink },
    ]],
  };
}

export async function runSentryTopRecipe(
  recipe: SentryTopRecipe,
  send: SendSentryMessage,
  dependencies: SentryRecipeDependencies = {},
): Promise<SentryRecipeResult> {
  const loadCredentials = dependencies.loadCredentials ?? loadDofboxSentryCredentials;
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now?.() ?? new Date();
  const periodMs = PERIOD_MS[recipe.period];
  if (!periodMs) {
    throw new Error(`Unsupported Sentry period: ${recipe.period}`);
  }
  const credentials = await loadCredentials(recipe.dofboxConfigModule, recipe.realm);
  const url = new URL(
    `${credentials.baseUrl}/organizations/${encodeURIComponent(credentials.org)}/issues/`,
  );
  url.searchParams.set("query", "is:unresolved environment:production");
  url.searchParams.set("sort", "freq");
  url.searchParams.set("project", "-1");
  url.searchParams.set("limit", "100");
  url.searchParams.set("start", new Date(now.getTime() - periodMs).toISOString());
  url.searchParams.set("end", now.toISOString());
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${credentials.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Sentry ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`);
  }
  const raw = await response.text();
  const all = parseIssues(raw);
  const useful = all.filter((issue) => {
    const title = issue.title.toLowerCase();
    return !NOISE.some((noise) => title.includes(noise));
  });
  const selected = useful.slice(0, recipe.limit);

  await send([
    "📊 <b>Sentry · топ ошибок</b>",
    `${escapeHTML(recipe.period)} · production · ${selected.length} для разбора`,
  ].join("\n"));
  for (const issue of selected) {
    await send(renderIssue(issue), issueButtons(issue));
  }

  return {
    total: all.length,
    delivered: selected.length,
    suppressed: all.length - useful.length,
  };
}
