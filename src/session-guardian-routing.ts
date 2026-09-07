import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";

import type { GuardianRoute } from "./session-guardian-types.js";

interface PersistedContext {
  readonly contextKey: string;
  readonly threadId: string | null;
}

const MAX_TELEGRAM_CHAT_ID = 2 ** 52 - 1;
const MAX_TELEGRAM_TOPIC_ID = 2_147_483_647;
/** Persisted routing metadata is operationally small; reject abnormal files before parsing. */
const MAX_CONTEXTS_FILE_BYTES = 1024 * 1024;

export class SessionGuardianRouter {
  private readonly fallback: Readonly<GuardianRoute>;

  constructor(
    private readonly contextsPath: string,
    fallback: GuardianRoute,
  ) {
    if (typeof contextsPath !== "string" || contextsPath.length === 0) {
      throw new Error("contextsPath must be a non-empty string");
    }
    assertRoute(fallback, "fallback");
    this.fallback = Object.freeze({
      chatId: fallback.chatId,
      ...(fallback.messageThreadId === undefined
        ? {}
        : { messageThreadId: fallback.messageThreadId }),
    });
  }

  route(threadId: string): GuardianRoute {
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new Error("threadId must be a non-empty string");
    }
    const contexts = readContexts(this.contextsPath);
    if (!contexts) return this.fallback;
    const matches = contexts.filter((context) => context.threadId === threadId);
    if (matches.length !== 1) return this.fallback;
    return parsePersistedContextKey(matches[0]!.contextKey) ?? this.fallback;
  }
}

function readContexts(contextsPath: string): PersistedContext[] | null {
  const raw = readBoundedRegularFile(contextsPath);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const contexts: PersistedContext[] = [];
  for (const entry of value) {
    if (!isRecord(entry)
      || typeof entry.contextKey !== "string"
      || entry.contextKey.length === 0
      || (entry.threadId !== null
        && (typeof entry.threadId !== "string" || entry.threadId.length === 0))) {
      return null;
    }
    contexts.push({ contextKey: entry.contextKey, threadId: entry.threadId });
  }
  return contexts;
}

function readBoundedRegularFile(filePath: string): string | null {
  if (typeof constants.O_NOFOLLOW !== "number") return null;
  let descriptor: number | undefined;
  let raw: string | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (metadata.isFile()
      && Number.isSafeInteger(metadata.size)
      && metadata.size >= 0
      && metadata.size <= MAX_CONTEXTS_FILE_BYTES) {
      const buffer = Buffer.allocUnsafe(MAX_CONTEXTS_FILE_BYTES + 1);
      let total = 0;
      let valid = true;
      while (total < buffer.length) {
        const remaining = buffer.length - total;
        const count = readSync(descriptor, buffer, total, remaining, total);
        if (!Number.isSafeInteger(count) || count < 0 || count > remaining) {
          valid = false;
          break;
        }
        if (count === 0) break;
        total += count;
      }
      if (valid && total <= MAX_CONTEXTS_FILE_BYTES) {
        raw = buffer.toString("utf8", 0, total);
      }
    }
  } catch {
    raw = null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        raw = null;
      }
    }
  }
  return raw;
}

function parsePersistedContextKey(contextKey: string): GuardianRoute | null {
  const match = /^(-?[1-9]\d*)(?::([1-9]\d*))?$/.exec(contextKey);
  if (!match) return null;
  const chatId = Number(match[1]);
  const messageThreadId = match[2] === undefined ? undefined : Number(match[2]);
  const route = {
    chatId,
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
  };
  try {
    assertRoute(route, "persisted route");
    return route;
  } catch {
    return null;
  }
}

function assertRoute(route: GuardianRoute, name: string): void {
  if (!Number.isSafeInteger(route.chatId)
    || route.chatId === 0
    || Math.abs(route.chatId) > MAX_TELEGRAM_CHAT_ID) {
    throw new Error(`${name}.chatId must be a non-zero 52-bit integer`);
  }
  if (route.messageThreadId !== undefined
    && (!Number.isSafeInteger(route.messageThreadId)
      || route.messageThreadId <= 0
      || route.messageThreadId > MAX_TELEGRAM_TOPIC_ID)) {
    throw new Error(`${name}.messageThreadId must be a positive signed 32-bit integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
