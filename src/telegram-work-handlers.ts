import type { TelegramWorkSource } from "./telegram-job-ingress.js";
import type { AcceptUpdateResult } from "./telegram-job-store.js";
import type { MaterializedPrompt } from "./telegram-job-types.js";

const WORK_KINDS = new Set([
  "text", "voice", "audio", "photo", "document", "command", "confirmation", "retry",
]);

export type TelegramWorkStatusOutcome =
  | { readonly state: "refreshed" }
  | { readonly state: "failed"; readonly reasonCode: "telegram_status_unavailable" };

export interface TelegramWorkHandlerOptions {
  readonly ingress: {
    accept(source: TelegramWorkSource): AcceptUpdateResult;
    materialize(jobId: string): Promise<MaterializedPrompt>;
  };
  readonly status: { refresh(jobId: string): Promise<void> };
  readonly coordinator: { pump(): Promise<void> };
}

export interface TelegramWorkHandlingResult extends AcceptUpdateResult {
  readonly status: TelegramWorkStatusOutcome;
}

export async function handleTelegramWork(
  source: TelegramWorkSource,
  options: TelegramWorkHandlerOptions,
): Promise<TelegramWorkHandlingResult> {
  if (!WORK_KINDS.has(source.kind)) throw new Error("Unsupported Telegram work route");

  const accepted = options.ingress.accept(source);
  let status: TelegramWorkStatusOutcome = { state: "refreshed" };
  try {
    await options.status.refresh(accepted.job.id);
  } catch {
    status = { state: "failed", reasonCode: "telegram_status_unavailable" };
  }
  await options.ingress.materialize(accepted.job.id);
  await options.coordinator.pump();
  return { ...accepted, status };
}
