import {
  normalizeTelegramTurnResult,
  TELEGRAM_TURN_RESULT_MAX_CONTENT_PARTS,
  type TelegramTurnAttachmentReference,
  type TelegramTurnResultContent,
  type TelegramTurnTextPhase,
} from "./telegram-turn-result.js";
import type { JobActivity, TelegramJob } from "./telegram-job-types.js";

interface ObservationHandlers {
  beforeDispatchWrite(fact: {
    threadId: string; previousTurnId: string | null; previousTurnKnown: boolean; attempt: number;
  }): void;
  onDispatchWritten(): void;
  onStarted(turnId: string): void;
  onActivity(event: { activity: JobActivity; eventAt: number; method: string }): void;
  onCommentaryCompleted?(commentary: {
    readonly itemId: string;
    readonly commentaryIndex: number;
    readonly text: string;
  }): void;
}

export interface TelegramTurnObservation {
  readonly callbacks: ObservationHandlers & {
    onTextDelta(delta: string, message?: { readonly itemId: string; readonly phase?: string }): void;
    onAgentMessageEnd(message: { readonly itemId: string; readonly phase?: string }): void;
    onOutputAttachment(attachment: TelegramTurnAttachmentReference): void;
    onTurnOutcome(event: { status: string; eventAt: number }): void;
  };
  snapshot(): {
    readonly outcome: { status: string; eventAt: number } | null;
    readonly content: readonly TelegramTurnResultContent[];
    readonly invalidOutput: boolean;
  };
}

export function createTelegramTurnObservation(handlers: ObservationHandlers): TelegramTurnObservation {
  const content: TelegramTurnResultContent[] = [];
  let invalidOutput = false;
  let outcome: { status: string; eventAt: number } | null = null;
  let previousTextMessageKey: string | undefined;
  let commentaryIndex = 0;
  const contentIndexByMessageKey = new Map<string, number>();
  const completedMessageKeys = new Set<string>();
  const callbacks = {
    ...handlers,
    onTurnOutcome: (fact: { status: string; eventAt: number }) => {
      outcome = { status: boundedStatus(fact.status), eventAt: timestamp(fact.eventAt) };
    },
    onTextDelta: (text: string, message?: { readonly itemId: string; readonly phase?: string }) => {
      if (!text || invalidOutput) return;
      const phase = durableTextPhase(message?.phase);
      if (message !== undefined && message.phase !== undefined && phase === undefined) return;
      const messageKey = message === undefined
        ? "legacy"
        : `${message.itemId}\0${phase ?? "legacy"}`;
      const previous = content.at(-1);
      const canCombine = previous?.kind === "text" && previousTextMessageKey === messageKey;
      if (!canCombine && content.length >= TELEGRAM_TURN_RESULT_MAX_CONTENT_PARTS) {
        invalidOutput = true;
        return;
      }
      const combined = canCombine ? previous.text + text : text;
      try {
        const normalized = normalizeTelegramTurnResult({
          schemaVersion: 1,
          content: [{ kind: "text", ...(phase === undefined ? {} : { phase }), text: combined }],
        }).content[0]!;
        if (canCombine) content[content.length - 1] = normalized;
        else {
          content.push(normalized);
          if (message !== undefined) contentIndexByMessageKey.set(messageKey, content.length - 1);
        }
        previousTextMessageKey = messageKey;
      } catch { invalidOutput = true; }
    },
    onAgentMessageEnd: (message: { readonly itemId: string; readonly phase?: string }) => {
      if (invalidOutput || durableTextPhase(message.phase) !== "commentary") return;
      const messageKey = `${message.itemId}\0commentary`;
      if (completedMessageKeys.has(messageKey)) return;
      const index = contentIndexByMessageKey.get(messageKey);
      const item = index === undefined ? undefined : content[index];
      if (item?.kind !== "text" || item.phase !== "commentary") return;
      completedMessageKeys.add(messageKey);
      handlers.onCommentaryCompleted?.({
        itemId: message.itemId,
        commentaryIndex: commentaryIndex++,
        text: item.text,
      });
    },
    onOutputAttachment: (attachment: TelegramTurnAttachmentReference) => {
      if (invalidOutput) return;
      if (content.length >= TELEGRAM_TURN_RESULT_MAX_CONTENT_PARTS) {
        invalidOutput = true;
        return;
      }
      try {
        content.push(normalizeTelegramTurnResult({
          schemaVersion: 1, content: [{ kind: "attachment", attachment }],
        }).content[0]!);
      } catch { invalidOutput = true; }
    },
  };
  return {
    callbacks,
    snapshot: () => ({ outcome, content: [...content], invalidOutput }),
  };
}

function durableTextPhase(value: string | undefined): TelegramTurnTextPhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

export function isOccupying(job: TelegramJob): boolean {
  return job.phase === "dispatching" || job.phase === "running";
}

export class PreviousTurnUnknownError extends Error {}

export function exactQueuedSnapshot(current: TelegramJob, expected: TelegramJob): TelegramJob {
  if (current.phase !== "queued" || current.version !== expected.version) {
    throw new Error("Telegram job version conflict");
  }
  return expected;
}

export function exactOwnedDispatch(current: TelegramJob, dispatchId: string): TelegramJob {
  if (current.dispatch?.id !== dispatchId) throw new Error("Telegram job version conflict");
  return current;
}

export function ownsDispatch(job: TelegramJob, dispatchId: string | undefined): boolean {
  return job.dispatch?.id === dispatchId;
}

export function isAborted(status: string | undefined): boolean {
  return status === "aborted" || status === "cancelled" || status === "interrupted";
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "Telegram job version conflict";
}

export function eventAt(now: () => number, job: TelegramJob): number {
  return Math.max(timestamp(now()), job.updatedAt);
}

export function boundedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid coordinator timestamp");
  return result;
}

export function boundedId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.includes("\0")) {
    throw new Error("Invalid coordinator id");
  }
  return value;
}

export function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid coordinator timestamp");
  }
  return value;
}

export function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function boundedStatus(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.includes("\0")) {
    throw new Error("Invalid Codex turn status");
  }
  return value;
}
