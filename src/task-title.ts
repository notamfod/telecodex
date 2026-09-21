import path from "node:path";

export function containsSecret(value: string): boolean {
  return /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/u.test(value)
    || /\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{16,}\b/iu.test(value);
}

function projectLabel(workspace: string): string {
  const parts = workspace.replaceAll("\\", "/").split("/").filter(Boolean);
  const root = parts.findIndex(part => part.toLowerCase() === "projects");
  const project = root >= 0 ? parts[root + 1] : undefined;
  const raw = (project === "avis" ? parts[root + 2] : project) ?? parts.at(-1) ?? "";
  return !raw || [...raw].length > 40 || containsSecret(raw) ? "Codex" : raw;
}

export function safeTaskText(value: string, limit = 128): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized) || containsSecret(normalized)) {
    throw new Error("Название должно быть непустым и не содержать секретов");
  }
  return [...normalized].slice(0, limit).join("");
}

/** The same Unicode-bounded name is used by Telegram, Codex and task cards. */
export function taskTopicName(title: string, workspace: string, ticketKey?: string): string {
  let body = safeTaskText(title, 4096);
  const project = projectLabel(workspace);
  const emojiMatch = /^(\p{Extended_Pictographic}\uFE0F?)\s+/u.exec(body);
  if (emojiMatch) body = body.slice(emojiMatch[0].length);
  if (body.startsWith(`[${project}]`) || (emojiMatch && /^\[[^\]]+\] (?:[^ ]+ )?· /u.test(body))) body = body.replace(/^\[[^\]]+\]\s*/u, "");
  for (const prefix of new Set([project, path.basename(workspace)])) {
    if (body.startsWith(`${prefix} · `)) body = body.slice(prefix.length + 3);
  }
  const embedded = /^(?:([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[#!]\d+))(?=\s|$)/u.exec(body)?.[1];
  const rawKey = ticketKey?.trim() || embedded;
  const key = rawKey ? safeTaskText(/^\d+$/u.test(rawKey) ? `#${rawKey}` : rawKey, 48) : undefined;
  if (embedded && (!key || embedded === key)) body = body.slice(embedded.length);
  body = body.replace(/^[\s·:|-]+/u, "").trim() || "Задача";
  const emoji = emojiMatch?.[1] ?? (/исправ|почин|добав|реализ|fix\b|implement|build\b/iu.test(body) ? "🛠"
    : /провер|разбор|диагност|ревью|sentry|review|investigat|check\b/iu.test(body) ? "🔎" : "💬");
  return safeTaskText(`${emoji} [${project}]${key ? ` ${key}` : ""} · ${body}`);
}
