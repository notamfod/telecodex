import { escapeHTML } from "./format.js";

/** Telegram truncates button labels past 64 code points. */
const MAX_BUTTON_LABEL = 64;
/** Shorter than Telegram's 128 limit, so the topic list stays readable. */
const MAX_TOPIC_TITLE = 40;

export interface MergeRequestSummary {
  projectId: number;
  iid: number;
  project: string;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  draft: boolean;
}

export interface MergeRequestChange {
  newPath: string;
  oldPath: string;
  diff: string;
}

type FetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

export type FetchLike = (
  url: string,
  init?: { headers: Record<string, string>; method?: string; body?: string },
) => Promise<FetchResponse>;

export class GitLabClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async listOpenMergeRequests(groupId: string, limit = 50): Promise<MergeRequestSummary[]> {
    const payload = (await this.request(
      `groups/${encodeURIComponent(groupId)}/merge_requests` +
        `?state=opened&per_page=${limit}&order_by=updated_at&sort=desc`,
    )) as RawMergeRequest[];

    return payload.map(toSummary);
  }

  async fetchChanges(projectId: number, iid: number): Promise<MergeRequestChange[]> {
    const payload = (await this.request(
      `projects/${projectId}/merge_requests/${iid}/changes`,
    )) as { changes?: Array<{ new_path?: string; old_path?: string; diff?: string }> };

    return (payload.changes ?? []).map((change) => ({
      newPath: change.new_path ?? "",
      oldPath: change.old_path ?? "",
      diff: change.diff ?? "",
    }));
  }

  /** Posts a comment. The only call in this module that writes to GitLab. */
  async createMergeRequestNote(projectId: number, iid: number, body: string): Promise<void> {
    await this.request(`projects/${projectId}/merge_requests/${iid}/notes`, { body });
  }

  private async request(pathname: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v4/${pathname}`, {
      headers: {
        "PRIVATE-TOKEN": this.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(`GitLab request failed (${response.status ?? "?"}): ${body.message ?? pathname}`);
    }

    return response.json();
  }
}

interface RawMergeRequest {
  iid: number;
  project_id: number;
  title: string;
  source_branch: string;
  target_branch: string;
  draft?: boolean;
  web_url: string;
  author?: { username?: string };
  references?: { full?: string };
}

function toSummary(raw: RawMergeRequest): MergeRequestSummary {
  return {
    projectId: raw.project_id,
    iid: raw.iid,
    project: projectFromReference(raw.references?.full),
    title: raw.title,
    author: raw.author?.username ?? "неизвестен",
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    webUrl: raw.web_url,
    draft: raw.draft === true,
  };
}

/** "acme/apps/api!19" names the project better than a numeric id does. */
function projectFromReference(reference?: string): string {
  const withoutIid = (reference ?? "").split("!")[0];
  return withoutIid.split("/").filter(Boolean).pop() ?? "проект";
}

export function mergeRequestTopicName(mr: MergeRequestSummary): string {
  return `!${mr.iid} ${mr.project}: ${shorten(titleWithDraft(mr), MAX_TOPIC_TITLE)}`;
}

export function mergeRequestButtons(
  mrs: MergeRequestSummary[],
): Array<{ label: string; callbackData: string }> {
  return mrs.map((mr) => ({
    label: shorten(`!${mr.iid} ${mr.project} · ${titleWithDraft(mr)}`, MAX_BUTTON_LABEL),
    callbackData: `mr:${mr.projectId}:${mr.iid}`,
  }));
}

export function renderMergeRequestCardHTML(
  mr: MergeRequestSummary,
  changes: MergeRequestChange[],
): string {
  const files = changes.slice(0, 12).map((change) => `• <code>${escapeHTML(change.newPath)}</code>`);
  if (changes.length > files.length) {
    files.push(`• …и ещё ${changes.length - files.length}`);
  }

  return [
    `🔀 <b>!${mr.iid} ${escapeHTML(mr.project)}</b>${mr.draft ? " [draft]" : ""}`,
    escapeHTML(mr.title),
    "",
    `Автор: ${escapeHTML(mr.author)}`,
    `Ветки: <code>${escapeHTML(mr.sourceBranch)}</code> → <code>${escapeHTML(mr.targetBranch)}</code>`,
    `<a href="${mr.webUrl}">Открыть в GitLab</a>`,
    "",
    files.length > 0 ? `Файлов изменено: ${changes.length}` : "Изменений в диффе нет.",
    ...files,
  ].join("\n");
}

export function formatChanges(
  changes: MergeRequestChange[],
  limit: number,
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let used = 0;

  for (const change of changes) {
    const block = `--- ${change.newPath}\n${change.diff}`;
    if (used + block.length > limit) {
      return {
        text: `${parts.join("\n\n")}\n\n[дифф обрезан по лимиту, показаны не все файлы]`.trim(),
        truncated: true,
      };
    }
    parts.push(block);
    used += block.length;
  }

  return { text: parts.join("\n\n"), truncated: false };
}

export function buildReviewPrompt(
  mr: MergeRequestSummary,
  changes: MergeRequestChange[],
  limit: number,
): string {
  const { text, truncated } = formatChanges(changes, limit);

  return [
    `Ревью merge request !${mr.iid} в проекте ${mr.project}.`,
    `Заголовок: ${mr.title}`,
    `Ветки: ${mr.sourceBranch} → ${mr.targetBranch}`,
    `Автор: ${mr.author}`,
    `Ссылка: ${mr.webUrl}`,
    "",
    "Рабочая копия в этом воркспейсе не переключена на ветку MR и обновить её нельзя,",
    "поэтому дифф ниже — источник правды по изменениям. Окружающий код читай в файлах.",
    truncated ? "Внимание: дифф обрезан, часть файлов не попала — скажи об этом в выводе." : undefined,
    "",
    "--- начало диффа ---",
    text || "(дифф пустой)",
    "--- конец диффа ---",
    "",
    "Что нужно: найти ошибки, риски и места, которые сломаются в проде.",
    "- Сначала то, что действительно ломается, потом замечания по качеству.",
    "- Ссылайся на файлы и строки.",
    "- Если всё чисто, так и скажи, не выдумывай замечаний.",
    "- Это только ревью: ничего не меняй, не коммить, деструктивных команд не запускай.",
    "- Отвечай по-русски.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function titleWithDraft(mr: MergeRequestSummary): string {
  return mr.draft ? `[draft] ${mr.title}` : mr.title;
}

function shorten(value: string, max: number): string {
  const characters = [...value];
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join("")}…`;
}

/**
 * Merge requests that mention a ticket key.
 *
 * Most MRs carry it in the branch name rather than the title, so both are checked.
 */
export function linkedMergeRequests(
  mrs: MergeRequestSummary[],
  key: string,
): MergeRequestSummary[] {
  const needle = key.toUpperCase();
  return mrs.filter(
    (mr) =>
      mr.title.toUpperCase().includes(needle) || mr.sourceBranch.toUpperCase().includes(needle),
  );
}

export function buildDoneComment(key: string, text: string): string {
  const body = text.trim();
  return [
    `${key}: готово.`,
    ...(body ? ["", body] : []),
    "",
    "---",
    "_Отправлено из Telegram через telecodex._",
  ].join("\n");
}

export function renderDraftHTML(mr: MergeRequestSummary, body: string): string {
  return [
    "<b>Черновик комментария</b>",
    `Куда: <a href="${mr.webUrl}">!${mr.iid}</a> ${escapeHTML(mr.project)} \u00B7 ${escapeHTML(mr.title)}`,
    "",
    `<pre>${escapeHTML(body)}</pre>`,
  ].join("\n");
}
