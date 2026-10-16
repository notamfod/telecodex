import type { DeployRecord, DeploySummaryRow } from "./mircli-deploy-data.js";
const LIMIT = 3899;
const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const formatter = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function time(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? formatter.format(new Date(value)).replace(",", "") : "время неизвестно";
}
function job(record: DeployRecord): string {
  const label = escape(time(record.finishedAt ?? record.updatedAt));
  try {
    const url = new URL(record.jobUrl);
    const href = escape(url.toString());
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.endsWith(`/${record.projectPath}/-/jobs/${record.jobId}`) && href.length < 600) {
      return `<a href="${href}">${label}</a>`;
    }
  } catch { /* Invalid links remain plain text. */ }
  return label;
}
function priority(row: DeploySummaryRow): number {
  return row.active.length ? 0 : row.latest?.status === "failed" ? 1 : row.waiting?.length ? 2 : row.error ? 3 : 4;
}
export function canAnimateDeploy(row: DeploySummaryRow, now = Date.now()): boolean {
  const age = row.checkedAt ? now - Date.parse(row.checkedAt) : Number.POSITIVE_INFINITY;
  return !row.error && row.active.length > 0 && age >= -5_000 && age <= 120_000;
}
function activity(record: DeployRecord, now: number): string {
  const start = Date.parse(record.startedAt ?? record.updatedAt);
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  const phase = Math.floor(seconds / 5) % 14;
  const position = phase <= 7 ? phase : 14 - phase;
  const bar = `${"░".repeat(position)}███${"░".repeat(7 - position)}`;
  const elapsed = seconds < 60 ? `${seconds}с` : `${Math.floor(seconds / 60)}м ${seconds % 60}с`;
  return `\n   <code>${bar}</code> · ${elapsed}`;
}
function block(row: DeploySummaryRow, now: number): string {
  const name = escape((row.projectPath.split("/").pop() ?? row.projectPath).slice(0, 80));
  const current = row.active[0] ?? row.waiting?.[0] ?? row.latest ?? row.success;
  const status = row.active.length ? "🟡" : row.waiting?.length ? "⏸" : current?.status === "failed" ? "🔴" : current?.status === "canceled" ? "⚪" : "✅";
  const label = row.active.length ? `выкладывается${row.active.length > 1 ? ` (+${row.active.length - 1})` : ""} · `
    : row.waiting?.length ? "ждёт запуска · " : current?.status === "failed" ? "ошибка · " : current?.status === "canceled" ? "отменён · " : "";
  let result = `${row.error ? "⚠️" : status} <b>${name}</b> · ${row.error ? "данные устарели · " : ""}${label}${current ? job(current) : "нет данных"}`;
  if (current && !row.error) result += ` · <code>${escape(current.sha.slice(0, 8))}</code>`;
  if (current && canAnimateDeploy(row, now)) result += activity(current, now);
  if (current?.status === "failed" && current.failureSummary) result += `\n   ↳ причина: ${escape(current.failureSummary)}`;
  if (current?.status === "failed") result += `\n   ↳ запустил: ${escape(current.deployer ?? "неизвестно")}`;
  if (row.success && row.success.id !== current?.id) result += `\n   ↳ последний успех ${job(row.success)}`;
  return result;
}
/** One message per selected environment. Complete HTML blocks stay within Telegram's limit. */
export function renderDeploySummary(rows: readonly DeploySummaryRow[], ref: "main" | "production", now = Date.now()): string[] {
  const selected = rows.filter(row => row.ref === ref && (row.latest || row.success || row.active.length || row.waiting?.length || row.error))
    .sort((a, b) => priority(a) - priority(b) || a.projectPath.localeCompare(b.projectPath));
  const checked = rows.filter(row => row.ref === ref && row.checkedAt).map(row => row.checkedAt!).sort()[0];
  const footer = `\n\nОбновлено ${time(checked)} МСК`;
  let html = `<b>MirCli · ${ref === "main" ? "DEV" : "PROD"}</b> · <code>${ref}</code>\n`;
  let shown = 0;
  for (const row of selected) {
    const text = block(row, now);
    if (html.length + text.length + footer.length + 70 > LIMIT) break;
    html += `\n${text}`;
    shown++;
  }
  if (!selected.length) html += "\nПока нет деплоев.";
  if (shown < selected.length) html += `\n…ещё ${selected.length - shown} сервисов`;
  return [html + footer];
}
