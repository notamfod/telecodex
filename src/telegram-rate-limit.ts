const DEFAULT_RETRY_AFTER_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const MAX_WRAPPER_DEPTH = 4;

export function definitiveTelegramRetryAfterMs(error: unknown): number | undefined {
  const response = record(error);
  if (!response || !Object.hasOwn(response, "error_code") || response.error_code !== 429) return undefined;
  const seconds = record(response.parameters)?.retry_after;
  return typeof seconds === "number" && Number.isSafeInteger(seconds)
    && seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : undefined;
}

export function telegramRetryAfterMs(error: unknown): number | undefined {
  const candidates = telegramErrorCandidates(error);
  const explicitErrorCandidates = candidates.filter((candidate) =>
    typeof candidate.error_code === "number" && Number.isFinite(candidate.error_code));
  const rateLimitedCandidates = explicitErrorCandidates.length > 0
    ? explicitErrorCandidates.filter((candidate) => candidate.error_code === 429)
    : candidates.filter((candidate) => [candidate.description, candidate.message].some(
      (value) => typeof value === "string" && /\b429\b|too many requests/i.test(value),
    ));
  if (rateLimitedCandidates.length === 0) return undefined;

  for (const candidate of rateLimitedCandidates) {
    const parameters = record(candidate.parameters);
    const retryAfter = parameters?.retry_after;
    if (typeof retryAfter === "number" && Number.isSafeInteger(retryAfter)
      && retryAfter >= 1 && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
      return retryAfter * 1_000;
    }
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function telegramErrorCandidates(error: unknown): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = record(error);
  for (let depth = 0; current !== null && depth < MAX_WRAPPER_DEPTH; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    candidates.push(current);
    current = record(current.error);
  }
  return candidates;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
