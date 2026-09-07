import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { GUARDIAN_SOCKET_PATH_MAX_BYTES } from "./session-guardian-ipc-client.js";
import type { GuardianRoute } from "./session-guardian-types.js";

const MAX_TELEGRAM_CHAT_ID = 2 ** 52 - 1;
const MAX_TELEGRAM_TOPIC_ID = 2_147_483_647;

export interface SessionGuardianConfig {
  readonly appServerSocketPath: string;
  readonly socketPath: string;
  readonly databasePath: string;
  readonly scanIntervalMs: number;
  readonly staleAfterMs: number;
  readonly recentWindowMs: number;
  readonly confirmationsRequired: number;
  readonly fallbackRoute?: Readonly<GuardianRoute>;
  readonly observationOnly: boolean;
  readonly repairEnabled: boolean;
}

export interface SessionGuardianConfigOptions {
  readonly home: string;
  readonly workspace: string;
}

export interface SessionGuardianEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspace: string;
}

export function loadSessionGuardianEnvironment(options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): SessionGuardianEnvironment {
  assertAbsoluteDirectory(options.cwd, "cwd");
  const env: Record<string, string | undefined> = { ...options.env };
  const envPath = path.join(options.cwd, ".env");
  if (existsSync(envPath)) {
    const contents = readFileSync(envPath, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
      const separator = normalized.indexOf("=");
      if (separator < 1) continue;
      const key = normalized.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] !== undefined) continue;
      let value = normalized.slice(separator + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[key] = value.replace(/\\n/g, "\n");
    }
  }
  return Object.freeze({ env: Object.freeze(env), workspace: options.cwd });
}

export function parseSessionGuardianConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: SessionGuardianConfigOptions,
): SessionGuardianConfig {
  assertAbsoluteDirectory(options.home, "home");
  assertAbsoluteDirectory(options.workspace, "workspace");
  const codexHome = optional(env.CODEX_HOME) ?? path.join(options.home, ".codex");
  assertAbsoluteDirectory(codexHome, "CODEX_HOME");
  const appServerSocketPath = optional(env.SESSION_GUARDIAN_APP_SERVER_SOCKET)
    ?? path.join(codexHome, "app-server-control", "app-server-control.sock");
  const socketPath = optional(env.SESSION_GUARDIAN_SOCKET_PATH)
    ?? path.join(options.workspace, ".telecodex", "session-guardian.sock");
  const databasePath = optional(env.SESSION_GUARDIAN_DB_PATH)
    ?? path.join(options.workspace, ".telecodex", "session-guardian.sqlite");
  assertFilePath(appServerSocketPath, "SESSION_GUARDIAN_APP_SERVER_SOCKET", true);
  assertFilePath(socketPath, "SESSION_GUARDIAN_SOCKET_PATH", true);
  assertFilePath(databasePath, "SESSION_GUARDIAN_DB_PATH", false);

  const scanSeconds = parseInteger(
    env.SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS,
    "SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS",
    60,
    10,
  );
  assertSafeMilliseconds(scanSeconds, "SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS");
  const staleSeconds = parseInteger(
    env.SESSION_GUARDIAN_STALE_AFTER_SECONDS,
    "SESSION_GUARDIAN_STALE_AFTER_SECONDS",
    600,
    1,
  );
  assertSafeMilliseconds(staleSeconds, "SESSION_GUARDIAN_STALE_AFTER_SECONDS");
  if (staleSeconds < scanSeconds * 2) {
    throw new Error("SESSION_GUARDIAN_STALE_AFTER_SECONDS must be at least twice the scan interval");
  }
  const recentWindowSeconds = parseInteger(
    env.SESSION_GUARDIAN_RECENT_WINDOW_SECONDS,
    "SESSION_GUARDIAN_RECENT_WINDOW_SECONDS",
    86_400,
    1,
  );
  assertSafeMilliseconds(recentWindowSeconds, "SESSION_GUARDIAN_RECENT_WINDOW_SECONDS");
  if (recentWindowSeconds < staleSeconds) {
    throw new Error(
      "SESSION_GUARDIAN_RECENT_WINDOW_SECONDS must be at least SESSION_GUARDIAN_STALE_AFTER_SECONDS",
    );
  }
  const confirmationsRequired = parsePositiveSafeInteger(
    env.SESSION_GUARDIAN_CONFIRMATIONS,
    "SESSION_GUARDIAN_CONFIRMATIONS",
    2,
    2,
  );
  const fallbackRoute = parseFallbackRoute(
    env.SESSION_GUARDIAN_FALLBACK_CHAT_ID,
    env.SESSION_GUARDIAN_FALLBACK_TOPIC_ID,
  );
  if (fallbackRoute) {
    const forumChatId = parseForumChatId(env.TELEGRAM_FORUM_CHAT_ID);
    if (forumChatId !== fallbackRoute.chatId) {
      throw new Error("SESSION_GUARDIAN_FALLBACK_CHAT_ID must equal TELEGRAM_FORUM_CHAT_ID");
    }
  }
  const observationOnly = parseBoolean(
    env.SESSION_GUARDIAN_OBSERVATION_ONLY,
    "SESSION_GUARDIAN_OBSERVATION_ONLY",
    true,
  );
  const repairEnabled = parseBoolean(
    env.SESSION_GUARDIAN_REPAIR_ENABLED,
    "SESSION_GUARDIAN_REPAIR_ENABLED",
    false,
  );
  if (observationOnly && repairEnabled) {
    throw new Error("SESSION_GUARDIAN_REPAIR_ENABLED cannot be enabled in observation-only mode");
  }
  return Object.freeze({
    appServerSocketPath,
    socketPath,
    databasePath,
    scanIntervalMs: scanSeconds * 1_000,
    staleAfterMs: staleSeconds * 1_000,
    recentWindowMs: recentWindowSeconds * 1_000,
    confirmationsRequired,
    fallbackRoute,
    observationOnly,
    repairEnabled,
  });
}

function parseForumChatId(raw: string | undefined): number {
  const text = optional(raw);
  if (text === undefined) {
    throw new Error("TELEGRAM_FORUM_CHAT_ID is required when Guardian fallback is configured");
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value >= 0 || Math.abs(value) > MAX_TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_FORUM_CHAT_ID must be a negative 52-bit integer");
  }
  return value;
}

function parseFallbackRoute(
  rawChatId: string | undefined,
  rawTopicId: string | undefined,
): Readonly<GuardianRoute> | undefined {
  const chatValue = optional(rawChatId);
  const topicValue = optional(rawTopicId);
  if ((chatValue === undefined) !== (topicValue === undefined)) {
    throw new Error("SESSION_GUARDIAN_FALLBACK_CHAT_ID and SESSION_GUARDIAN_FALLBACK_TOPIC_ID must be configured together");
  }
  if (chatValue === undefined || topicValue === undefined) return undefined;
  const chatId = Number(chatValue);
  if (!Number.isSafeInteger(chatId) || chatId === 0 || Math.abs(chatId) > MAX_TELEGRAM_CHAT_ID) {
    throw new Error("SESSION_GUARDIAN_FALLBACK_CHAT_ID must be a non-zero 52-bit integer");
  }
  const messageThreadId = Number(topicValue);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0
    || messageThreadId > MAX_TELEGRAM_TOPIC_ID) {
    throw new Error("SESSION_GUARDIAN_FALLBACK_TOPIC_ID must be a positive signed 32-bit integer");
  }
  return Object.freeze({ chatId, messageThreadId });
}

function parseInteger(raw: string | undefined, name: string, fallback: number, minimum: number): number {
  const text = optional(raw);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  if (value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  return value;
}

function parsePositiveSafeInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum = 1,
): number {
  const text = optional(raw);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  if (value < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return value;
}

function assertSafeMilliseconds(seconds: number, name: string): void {
  if (!Number.isSafeInteger(seconds * 1_000)) {
    throw new Error(`${name} must convert to safe milliseconds`);
  }
}

function parseBoolean(raw: string | undefined, name: string, fallback: boolean): boolean {
  const text = optional(raw);
  if (text === undefined) return fallback;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function assertAbsoluteDirectory(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
}

function assertFilePath(value: string, name: string, unixSocket: boolean): void {
  if (value.includes("\0")) throw new Error(`${name} must not contain NUL`);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  if (value === path.parse(value).root) throw new Error(`${name} must name a file`);
  if (unixSocket && Buffer.byteLength(value) > GUARDIAN_SOCKET_PATH_MAX_BYTES) {
    throw new Error(`${name} must be at most ${GUARDIAN_SOCKET_PATH_MAX_BYTES} bytes`);
  }
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}
