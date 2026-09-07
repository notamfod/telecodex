import type { Bot, Context } from "grammy";

import {
  GuardianIpcTimeoutError,
  SessionGuardianIpcClient,
  type GuardianIpcResponse,
} from "./session-guardian-ipc.js";

export const GUARDIAN_RESTORE_CALLBACK_PATTERN =
  /^guardian_restore:([A-Za-z0-9_-]{22})$/;

export interface GuardianBotAdapterOptions {
  readonly socketPath: string;
  readonly requestTimeoutMs?: number;
}

export interface GuardianBotAdapterClient {
  repairAlert(alertId: string): Promise<GuardianIpcResponse>;
}

export interface GuardianBotAdapterDependencies {
  readonly client?: GuardianBotAdapterClient;
}

export function registerGuardianCallbacks(
  bot: Pick<Bot<Context>, "callbackQuery">,
  options: GuardianBotAdapterOptions,
  dependencies: GuardianBotAdapterDependencies = {},
): void {
  const client = dependencies.client ?? new SessionGuardianIpcClient(options.socketPath, {
    requestTimeoutMs: options.requestTimeoutMs,
  });

  bot.callbackQuery(GUARDIAN_RESTORE_CALLBACK_PATTERN, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Проверяю..." }).catch(() => undefined);
    const match = GUARDIAN_RESTORE_CALLBACK_PATTERN.exec(ctx.callbackQuery.data);
    if (!match) return;
    const alertId = match[1]!;
    let rendered: GuardianRenderedResult;
    try {
      rendered = renderGuardianResult(await client.repairAlert(alertId));
    } catch (error) {
      rendered = {
        message: error instanceof GuardianIpcTimeoutError
          ? "Проверка продолжается. Итог появится в уведомлении Guardian."
          : "Не удалось восстановить сессию. Попробуйте позже.",
        preserveRestore: true,
      };
    }

    const keyboard = rendered.preserveRestore
      ? restoreKeyboard(alertId)
      : { reply_markup: { inline_keyboard: [] } };
    try {
      await ctx.editMessageText(rendered.message, keyboard);
    } catch {
      if (!rendered.preserveRestore) {
        await ctx.editMessageReplyMarkup(keyboard).catch(() => undefined);
      }
      const messageThreadId = ctx.callbackQuery.message?.message_thread_id;
      await ctx.reply(rendered.message, {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      }).catch(() => undefined);
    }
  });
}

interface GuardianRenderedResult {
  readonly message: string;
  readonly preserveRestore: boolean;
}

function restoreKeyboard(alertId: string) {
  return { reply_markup: { inline_keyboard: [[{
    text: "Restore",
    callback_data: `guardian_restore:${alertId}`,
  }]] } };
}

function renderGuardianResult(result: GuardianIpcResponse): GuardianRenderedResult {
  switch (result.outcome) {
    case "restored":
      return { message: "Сессия восстановлена.", preserveRestore: false };
    case "self-recovered":
      return { message: "Сессия уже восстановилась сама.", preserveRestore: false };
    case "observation-only":
      return { message: "Guardian работает в режиме наблюдения. Сессия проверена, изменений не внесено.", preserveRestore: true };
    case "repair-disabled":
      return { message: "Восстановление сейчас отключено.", preserveRestore: true };
    case "expired":
    case "no-longer-eligible":
      return { message: "Запрос больше не актуален.", preserveRestore: false };
    case "failed":
    case "ok":
    case "degraded":
    default:
      return { message: "Не удалось восстановить сессию. Попробуйте позже.", preserveRestore: true };
  }
}
