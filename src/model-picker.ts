import type { CodexModelChoice } from "./codex-model.js";
import type { CodexPromptInput } from "./codex-session.js";

const TOKEN = /^[a-f0-9]{12}$/;
const CHOICE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function promptModelCallback(token: string, choiceId: string): string {
  if (!TOKEN.test(token) || !CHOICE_ID.test(choiceId)) {
    throw new Error("Invalid model picker callback data");
  }
  const value = `jobmodel:${token}:${choiceId}`;
  if (Buffer.byteLength(value) > 64) {
    throw new Error("Model picker callback exceeds Telegram's 64-byte limit");
  }
  return value;
}

export function parsePromptModelCallback(
  value: string,
): { token: string; choiceId: string } | null {
  const match = /^jobmodel:([^:]+):([^:]+)$/.exec(value);
  if (!match || !TOKEN.test(match[1]!) || !CHOICE_ID.test(match[2]!)) {
    return null;
  }
  return { token: match[1]!, choiceId: match[2]! };
}

export function canUseChoiceForInput(
  choice: CodexModelChoice,
  input: CodexPromptInput,
): boolean {
  return typeof input === "string" || !input.imagePaths?.length || choice.supportsImages;
}
