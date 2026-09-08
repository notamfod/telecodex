const MAX_RETRY_AFTER_MS = 3_600_000;

export class TelegramDeliveryApiError extends Error {
  readonly name = "TelegramDeliveryApiError";
  constructor(
    readonly code: "not_sent" | "retry_after" | "message_missing" | "message_not_modified" | "rich_rejected" | "permanent",
    readonly retryAfterMs?: number,
    readonly richReason?: "format" | "method_unavailable",
    readonly confirmedRetryAfter = false,
  ) {
    super("Telegram delivery failed");
    if (code === "retry_after") {
      if (!positiveInteger(retryAfterMs) || retryAfterMs > MAX_RETRY_AFTER_MS) throw new Error("Invalid retryAfterMs");
    } else if (retryAfterMs !== undefined) throw new Error("Invalid Telegram delivery error");
    if (code === "rich_rejected") {
      if (richReason !== "format" && richReason !== "method_unavailable") {
        throw new Error("Invalid Telegram rich rejection reason");
      }
    } else if (richReason !== undefined) throw new Error("Invalid Telegram delivery error");
  }
}

export class TelegramDeliveryLocalError extends Error {
  readonly name = "TelegramDeliveryLocalError";
  readonly reason = "unsafe_attachment";
  constructor() { super("Unsafe Telegram attachment path"); }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
