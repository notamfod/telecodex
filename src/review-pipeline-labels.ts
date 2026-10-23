export interface ReviewLabelExample { key: string; summary: string; }
export interface ReviewLabelCatalogEntry { label: string; examples: ReviewLabelExample[]; }
export interface ReviewLabelCatalogOptions { server: string; login: string; token: string; fetchImpl?: typeof fetch; }

const PAGE_SIZE = 1_000;
const MAX_ISSUES = 10_000;
const MAX_LABELS = 1_000;
const MAX_EXAMPLES = 3;
const CACHE_TTL_MS = 5 * 60_000;
const EXCLUDED = /^(?:ID\d+|telecodex-review(?:[-_].*)?|review|backend|frontend|каст_борд|тех_борд|бекенд_беклог|фронт_беклог|релиз_беклог|от_кастомера|от_пользователя|от_бизнеса)$/i;
let cached: { expiresAt: number; key: string; fetchImpl: typeof fetch; catalog: ReviewLabelCatalogEntry[] } | undefined;

export async function fetchReviewLabelCatalog(options: ReviewLabelCatalogOptions, signal?: AbortSignal): Promise<ReviewLabelCatalogEntry[]> {
  const server = validateOptions(options); const key = `${server}\u0000${options.login}\u0000${options.token}`; const fetchImpl = options.fetchImpl ?? fetch;
  if (cached && cached.key === key && cached.fetchImpl === fetchImpl && cached.expiresAt > Date.now()) return cached.catalog;
  const labels = new Map<string, ReviewLabelExample[]>(); const issueKeys = new Set<string>(); let startAt = 0; let total: number | undefined;
  while (true) {
    if (startAt >= MAX_ISSUES) throw new Error("Jira label catalog exceeds the bounded issue limit");
    const pageSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const response = await fetchImpl(`${server}/rest/api/2/search`, { method: "POST", signal: pageSignal,
      headers: { Authorization: `Basic ${Buffer.from(`${options.login}:${options.token}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jql: "project = MIR AND labels is not EMPTY ORDER BY key", startAt, maxResults: PAGE_SIZE, fields: ["summary", "labels"] }),
    });
    if (!response.ok) throw new Error(`Jira label catalog lookup failed: ${response.status}`);
    const body: unknown = await response.json(); if (!isRecord(body) || !Array.isArray(body.issues) || !Number.isSafeInteger(body.total) || (body.total as number) < 0 || body.issues.length > PAGE_SIZE || body.startAt !== undefined && body.startAt !== startAt) throw new Error("Jira label catalog returned an invalid page");
    const pageTotal = body.total as number;
    if (total === undefined) total = pageTotal; else if (total !== pageTotal) throw new Error("Jira label catalog pagination changed");
    if (pageTotal > MAX_ISSUES || startAt + body.issues.length > pageTotal) throw new Error("Jira label catalog pagination is invalid");
    for (const issue of body.issues) { const issueKey = collectIssue(issue, labels); if (issueKeys.has(issueKey)) throw new Error("Jira label catalog pagination repeated an issue"); issueKeys.add(issueKey); }
    startAt += body.issues.length;
    if (startAt === pageTotal) break;
    if (body.issues.length === 0) throw new Error("Jira label catalog pagination is truncated");
  }
  const catalog = [...labels].map(([label, examples]) => ({ label, examples })).sort((a, b) => a.label.localeCompare(b.label));
  if (catalog.length === 0 || catalog.length > MAX_LABELS) throw new Error("Jira label catalog is empty or exceeds bounds");
  cached = { key, fetchImpl, expiresAt: Date.now() + CACHE_TTL_MS, catalog }; return catalog;
}

function collectIssue(value: unknown, result: Map<string, ReviewLabelExample[]>): string {
  if (!isRecord(value) || typeof value.key !== "string" || !/^MIR-\d+$/.test(value.key) || !isRecord(value.fields)
    || typeof value.fields.summary !== "string" || !Array.isArray(value.fields.labels)) throw new Error("Jira label catalog returned an invalid issue");
  const summary = normalizeSummary(value.fields.summary); if (!summary) throw new Error("Jira label catalog returned an invalid issue");
  for (const label of value.fields.labels) {
    if (!validText(label, 128) || EXCLUDED.test(label)) continue;
    const examples = result.get(label) ?? [];
    if (!result.has(label)) result.set(label, examples);
    if (examples.length < MAX_EXAMPLES) examples.push({ key: value.key, summary });
  }
  return value.key;
}
function normalizeSummary(value: string): string | undefined {
  if (value.length > 4_096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return validText(normalized, 512) ? normalized : undefined;
}

function validateOptions(options: ReviewLabelCatalogOptions): string {
  let url: URL; try { url = new URL(options.server); } catch { throw new Error("Jira label catalog server must be HTTPS"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !validText(options.login, 512) || !validText(options.token, 512)) throw new Error("Jira label catalog credentials are invalid");
  return options.server.replace(/\/+$/, "");
}
function validText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
