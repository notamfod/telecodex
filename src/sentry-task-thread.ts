const CALLBACK_PREFIX = "sentry_task:";
const SHORT_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,40}$/;

export interface SentryTaskCallback {
  issueId: string;
  shortId: string;
}

interface OpenSentryTaskDependencies {
  createTopic: (topicName: string) => Promise<number>;
  initializeTopic: (topicId: number, topicName: string) => Promise<void>;
  startAnalysis: (topicId: number, prompt: string) => Promise<void>;
}

export function sentryTaskCallbackData(issueId: string, shortId: string): string {
  if (!/^\d+$/.test(issueId) || !SHORT_ID_PATTERN.test(shortId)) {
    throw new Error("Invalid Sentry issue identity");
  }
  const data = `${CALLBACK_PREFIX}${issueId}:${shortId}`;
  if (Buffer.byteLength(data, "utf8") > 64) {
    throw new Error("Sentry callback exceeds Telegram's 64-byte limit");
  }
  return data;
}

export function parseSentryTaskCallback(data: string): SentryTaskCallback | null {
  if (!data.startsWith(CALLBACK_PREFIX)) {
    return null;
  }
  const [issueId, shortId, extra] = data.slice(CALLBACK_PREFIX.length).split(":");
  if (extra !== undefined || !issueId || !shortId) {
    return null;
  }
  if (!/^\d+$/.test(issueId) || !SHORT_ID_PATTERN.test(shortId)) {
    return null;
  }
  return { issueId, shortId };
}

export function sentryTaskTopicName(shortId: string): string {
  if (!SHORT_ID_PATTERN.test(shortId)) {
    throw new Error("Invalid Sentry short id");
  }
  return `🔎 ${shortId} · Sentry`;
}

export function buildSentryAnalysisPrompt(issueId: string, shortId: string, realm = "mircli"): string {
  if (!/^\d+$/.test(issueId) || !SHORT_ID_PATTERN.test(shortId)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(realm)) {
    throw new Error("Invalid Sentry issue identity");
  }
  return [
    `Разбери production issue Sentry ${shortId} (numeric id ${issueId}) в realm ${realm}.`,
    "Сначала получи свежие данные read-only командой:",
    `dofbox --realm ${realm} sentry issue ${issueId}`,
    "Затем найди связанный код в рабочем репозитории и проверь гипотезу по текущему исходному коду.",
    "Дай короткий разбор: что происходит, вероятная причина, где чинить и каких данных не хватает для уверенности.",
    "Ничего не меняй, не коммить, не пушить и не меняй статус issue в Sentry.",
  ].join("\n");
}

export async function openSentryTaskThread(
  issue: SentryTaskCallback,
  dependencies: OpenSentryTaskDependencies,
  realm = "mircli",
): Promise<{ topicId: number; topicName: string }> {
  const topicName = sentryTaskTopicName(issue.shortId);
  const topicId = await dependencies.createTopic(topicName);
  await dependencies.initializeTopic(topicId, topicName);
  await dependencies.startAnalysis(
    topicId,
    buildSentryAnalysisPrompt(issue.issueId, issue.shortId, realm),
  );
  return { topicId, topicName };
}
