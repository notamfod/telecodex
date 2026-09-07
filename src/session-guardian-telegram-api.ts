import type { GuardianTelegramApi } from "./session-guardian-telegram.js";

export const GUARDIAN_TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;
export const GUARDIAN_TELEGRAM_RETRY_OPTIONS = Object.freeze({
  maxRetryAttempts: 3,
  maxDelaySeconds: 60,
  rethrowHttpErrors: true,
  rethrowInternalServerErrors: true,
});

interface RawGuardianTelegramApi {
  sendMessage(chatId: number, text: string, options: Record<string, unknown>,
    signal?: AbortSignal): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string,
    options: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export function createGuardianTelegramApi(
  raw: RawGuardianTelegramApi,
  options: { readonly timeoutMs?: number } = {},
): GuardianTelegramApi {
  const timeoutMs = options.timeoutMs ?? GUARDIAN_TELEGRAM_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Guardian Telegram timeout must be a positive safe integer");
  }
  return Object.freeze({
    sendMessage: (chatId: number, text: string, requestOptions: Record<string, unknown>) =>
      withDeadline((signal) => raw.sendMessage(chatId, text, requestOptions, signal), timeoutMs),
    editMessageText: (chatId: number, messageId: number, text: string,
      requestOptions: Record<string, unknown>) => withDeadline(
      (signal) => raw.editMessageText(chatId, messageId, text, requestOptions, signal), timeoutMs,
    ),
  });
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Guardian Telegram request timed out"));
    }, timeoutMs);
  });
  try {
    const request = operation(controller.signal);
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
