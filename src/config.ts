import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  parseLaunchProfilesJson,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";
import {
  parseModelChoicesJson,
  resolveDefaultModelChoice,
  type CodexModelChoice,
} from "./codex-model.js";
import { storagePathsAlias } from "./telegram-job-storage-path.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";
export type TelegramJobStoreMode = "json" | "shadow" | "sqlite";

export interface TelegramJobConfig {
  storeMode: TelegramJobStoreMode;
  databasePath: string;
  legacyJsonPath: string;
  maxAttempts: number;
  payloadRetentionDays: number;
  metadataRetentionDays: number;
  retentionInitialDelaySeconds: number;
}

export interface JiraPanelConfig {
  chatId: number;
  topicId: number;
  clientPath: string;
  workspace?: string;
}

export interface JiraCommentConfig {
  server: string;
  login: string;
  token: string;
}

export interface MiniAppConfig {
  launchUrl: string;
  host: string;
  port: number;
  authMaxAgeSeconds: number;
  staticDir: string;
}

export interface ReliabilityTimeoutConfig {
  appServerConnectMs: number;
  appServerRequestMs: number;
  appServerTurnStartMs: number;
  telegramDeliveryMs: number;
}

export interface TeleCodexConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  workspace: string;
  telegramJobs: TelegramJobConfig;
  maxFileSize: number;
  codexApiKey?: string;
  /** Told that a thread was re-read from disk, so a sync tool can clear its guard. */
  threadReopenCommand?: string;
  codexModel?: string;
  modelChoices: CodexModelChoice[];
  defaultModelChoiceId?: string;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  launchProfiles: CodexLaunchProfile[];
  defaultLaunchProfileId: string;
  enableUnsafeLaunchProfiles: boolean;
  toolVerbosity: ToolVerbosity;
  showTurnTokenUsage: boolean;
  telegramWeeklyTokenLimit?: number;
  enableTelegramLogin: boolean;
  enableTelegramReactions: boolean;
  telegramTopicRecoveryEnabled: boolean;
  telegramTopicResumeEnabled: boolean;
  telegramTopicWarningReplayEnabled: boolean;
  telegramForumChatId?: number;
  statusBoardIntervalMs: number;
  miniApp?: MiniAppConfig;
  gitlabUrl?: string;
  gitlabToken?: string;
  gitlabGroupId?: string;
  gitlabWorkspaceRoot?: string;
  topicSyncIntervalMs?: number;
  topicSyncEnabled: boolean;
  telegramMaxActiveTopics: number;
  telegramProgressHeartbeatMs: number;
  jiraPanel?: JiraPanelConfig;
  jiraComment?: JiraCommentConfig;
  sessionGuardianSocketPath?: string;
  reliabilityTimeouts: ReliabilityTimeoutConfig;
}

export function loadConfig(): TeleCodexConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const workspace = resolveWorkspace();
  const telegramJobs = parseTelegramJobConfig(workspace);
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const threadReopenCommand = optionalString(process.env.THREAD_REOPEN_COMMAND);
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const modelChoices = parseModelChoicesJson(
    optionalString(process.env.CODEX_MODEL_CHOICES_JSON),
  );
  const defaultModelChoice = modelChoices.length
    ? resolveDefaultModelChoice(
        modelChoices,
        optionalString(process.env.CODEX_DEFAULT_MODEL_CHOICE),
        codexModel,
      )
    : undefined;
  if (defaultModelChoice && defaultModelChoice.provider !== "openai") {
    throw new Error("CODEX_DEFAULT_MODEL_CHOICE must use the openai provider");
  }
  const defaultModelChoiceId = defaultModelChoice?.id;
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const enableUnsafeLaunchProfiles = parseBooleanEnv(
    optionalString(process.env.ENABLE_UNSAFE_LAUNCH_PROFILES),
    false,
  );
  const launchProfiles = parseLaunchProfiles(
    optionalString(process.env.CODEX_LAUNCH_PROFILES_JSON),
    codexSandboxMode,
    codexApprovalPolicy,
    enableUnsafeLaunchProfiles,
  );
  const defaultLaunchProfileId = parseDefaultLaunchProfileId(
    optionalString(process.env.CODEX_DEFAULT_LAUNCH_PROFILE),
    launchProfiles,
  );
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const showTurnTokenUsage = parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false);
  const telegramWeeklyTokenLimit = optionalString(process.env.TELEGRAM_WEEKLY_TOKEN_LIMIT) === undefined
    ? undefined
    : parseIntegerSetting(
        "TELEGRAM_WEEKLY_TOKEN_LIMIT",
        optionalString(process.env.TELEGRAM_WEEKLY_TOKEN_LIMIT),
        1,
        1,
      );
  const enableTelegramLogin = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_LOGIN),
    false,
  );
  const enableTelegramReactions = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
    false,
  );
  const telegramTopicRecoveryEnabled = parseBooleanEnv(
    optionalString(process.env.TELEGRAM_TOPIC_RECOVERY_ENABLED),
    false,
    { strict: true, name: "TELEGRAM_TOPIC_RECOVERY_ENABLED" },
  );
  const telegramTopicResumeEnabled = parseBooleanEnv(
    process.env.TELEGRAM_TOPIC_RESUME_ENABLED,
    false,
    { strict: true, name: "TELEGRAM_TOPIC_RESUME_ENABLED" },
  );
  const telegramForumChatId = parseTelegramForumChatId(
    optionalString(process.env.TELEGRAM_FORUM_CHAT_ID),
  );
  const telegramTopicWarningReplayEnabled = parseBooleanEnv(
    process.env.TELEGRAM_TOPIC_WARNING_REPLAY_ENABLED,
    false,
    { strict: true, name: "TELEGRAM_TOPIC_WARNING_REPLAY_ENABLED" },
  );
  const gitlabUrl = optionalString(process.env.GITLAB_URL);
  const gitlabToken = optionalString(process.env.GITLAB_TOKEN);
  const gitlabGroupId = optionalString(process.env.GITLAB_GROUP_ID);
  const gitlabWorkspaceRoot = optionalString(process.env.GITLAB_WORKSPACE_ROOT);
  const topicSyncIntervalMs = parseTopicSyncInterval(
    optionalString(process.env.TOPIC_SYNC_INTERVAL_SECONDS),
  );
  // Creating a forum topic for every Codex thread is its own decision. It used
  // to switch on the moment the forum id became known, which meant you could
  // not name the forum for anything else without also opting into that sweep.
  const topicSyncEnabled = optionalString(process.env.TOPIC_SYNC_INTERVAL_SECONDS) !== undefined;
  const telegramMaxActiveTopics = parseIntegerSetting(
    "TELEGRAM_MAX_ACTIVE_TOPICS",
    optionalString(process.env.TELEGRAM_MAX_ACTIVE_TOPICS),
    4,
    1,
  );
  const statusBoardIntervalMs = parseIntegerSetting(
    "STATUS_BOARD_INTERVAL_SECONDS",
    optionalString(process.env.STATUS_BOARD_INTERVAL_SECONDS),
    5,
    1,
  ) * 1000;
  const miniApp = parseMiniAppConfig(
    optionalString(process.env.MINI_APP_LAUNCH_URL),
    optionalString(process.env.MINI_APP_HOST),
    optionalString(process.env.MINI_APP_PORT),
    optionalString(process.env.MINI_APP_AUTH_MAX_AGE_SECONDS),
  );
  if (miniApp && telegramForumChatId === undefined) {
    throw new Error("MINI_APP_LAUNCH_URL requires TELEGRAM_FORUM_CHAT_ID");
  }
  const telegramProgressHeartbeatMs = parseIntegerSetting(
    "TELEGRAM_PROGRESS_HEARTBEAT_SECONDS",
    optionalString(process.env.TELEGRAM_PROGRESS_HEARTBEAT_SECONDS),
    120,
    30,
  ) * 1000;
  const jiraPanel = parseJiraPanelConfig(
    optionalString(process.env.JIRA_PANEL_CHAT_ID),
    optionalString(process.env.JIRA_PANEL_TOPIC_ID),
    optionalString(process.env.JIRA_CLIENT_PATH),
    optionalString(process.env.JIRA_PANEL_WORKSPACE),
  );
  const jiraComment = parseJiraCommentConfig(
    optionalString(process.env.JIRA_COMMENT_SERVER),
    optionalString(process.env.JIRA_COMMENT_LOGIN),
    optionalString(process.env.JIRA_COMMENT_TOKEN),
  );
  const sessionGuardianSocketPath = parseSessionGuardianSocketPath(
    process.env.SESSION_GUARDIAN_SOCKET_PATH,
  );
  if (sessionGuardianSocketPath && telegramForumChatId === undefined) {
    throw new Error("SESSION_GUARDIAN_SOCKET_PATH requires TELEGRAM_FORUM_CHAT_ID");
  }
  const reliabilityTimeouts = parseReliabilityTimeoutConfig(process.env);
  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    workspace,
    telegramJobs,
    maxFileSize,
    codexApiKey,
    threadReopenCommand,
    codexModel,
    modelChoices,
    defaultModelChoiceId,
    codexSandboxMode,
    codexApprovalPolicy,
    launchProfiles,
    defaultLaunchProfileId,
    enableUnsafeLaunchProfiles,
    toolVerbosity,
    showTurnTokenUsage,
    telegramWeeklyTokenLimit,
    enableTelegramLogin,
    enableTelegramReactions,
    telegramTopicRecoveryEnabled,
    telegramTopicResumeEnabled,
    telegramTopicWarningReplayEnabled,
    telegramForumChatId,
    statusBoardIntervalMs,
    miniApp,
    gitlabUrl,
    gitlabToken,
    gitlabGroupId,
    gitlabWorkspaceRoot,
    topicSyncIntervalMs,
    topicSyncEnabled,
    telegramMaxActiveTopics,
    telegramProgressHeartbeatMs,
    jiraPanel,
    jiraComment,
    reliabilityTimeouts,
    ...(sessionGuardianSocketPath ? { sessionGuardianSocketPath } : {}),
  };
}

export function parseReliabilityTimeoutConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReliabilityTimeoutConfig {
  const seconds = (name: string, fallback: number): number => boundedIntegerSetting(
    name,
    environment[name],
    fallback,
    1,
    300,
  ) * 1_000;
  return {
    appServerConnectMs: seconds("APP_SERVER_CONNECT_TIMEOUT_SECONDS", 10),
    appServerRequestMs: seconds("APP_SERVER_REQUEST_TIMEOUT_SECONDS", 15),
    appServerTurnStartMs: seconds("APP_SERVER_TURN_START_TIMEOUT_SECONDS", 30),
    telegramDeliveryMs: seconds("TELEGRAM_DELIVERY_TIMEOUT_SECONDS", 30),
  };
}

export function parseTelegramJobConfig(
  workspace: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TelegramJobConfig {
  const mode = environment.TELEGRAM_JOB_STORE_MODE ?? "json";
  if (mode !== "json" && mode !== "shadow" && mode !== "sqlite") {
    throw new Error("TELEGRAM_JOB_STORE_MODE must be json, shadow, or sqlite");
  }
  const databasePath = jobStorePath(
    "TELEGRAM_JOB_DB_PATH",
    environment.TELEGRAM_JOB_DB_PATH,
    path.join(workspace, ".telecodex", "jobs.sqlite"),
  );
  const legacyJsonPath = jobStorePath(
    "TELEGRAM_JOB_LEGACY_JSON_PATH",
    environment.TELEGRAM_JOB_LEGACY_JSON_PATH,
    path.join(workspace, ".telecodex", "jobs.json"),
  );
  if (storagePathsAlias(legacyJsonPath, databasePath)) {
    throw new Error("TELEGRAM_JOB_DB_PATH and TELEGRAM_JOB_LEGACY_JSON_PATH must not overlap");
  }
  const maxAttempts = boundedIntegerSetting(
    "TELEGRAM_JOB_MAX_ATTEMPTS", environment.TELEGRAM_JOB_MAX_ATTEMPTS, 5, 1, 100,
  );
  const payloadRetentionDays = boundedIntegerSetting(
    "TELEGRAM_JOB_PAYLOAD_RETENTION_DAYS", environment.TELEGRAM_JOB_PAYLOAD_RETENTION_DAYS, 7, 1, 3_650,
  );
  const metadataRetentionDays = boundedIntegerSetting(
    "TELEGRAM_JOB_METADATA_RETENTION_DAYS", environment.TELEGRAM_JOB_METADATA_RETENTION_DAYS, 90, 1, 3_650,
  );
  const retentionInitialDelaySeconds = boundedIntegerSetting(
    "TELEGRAM_JOB_RETENTION_INITIAL_DELAY_SECONDS",
    environment.TELEGRAM_JOB_RETENTION_INITIAL_DELAY_SECONDS,
    0,
    0,
    7 * 24 * 60 * 60,
  );
  if (metadataRetentionDays < payloadRetentionDays) {
    throw new Error("TELEGRAM_JOB_METADATA_RETENTION_DAYS must not be shorter than payload retention");
  }
  return {
    storeMode: mode,
    databasePath,
    legacyJsonPath,
    maxAttempts,
    payloadRetentionDays,
    metadataRetentionDays,
    retentionInitialDelaySeconds,
  };
}

function jobStorePath(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback;
  if (value.includes("\0") || !path.isAbsolute(value) || value === path.parse(value).root) {
    throw new Error(`${name} must be an absolute file path`);
  }
  return path.normalize(value);
}

function boundedIntegerSetting(
  name: string, raw: string | undefined, fallback: number, minimum: number, maximum: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function parseSessionGuardianSocketPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().length === 0) {
    throw new Error("SESSION_GUARDIAN_SOCKET_PATH must be non-empty");
  }
  if (raw.includes("\0")) throw new Error("SESSION_GUARDIAN_SOCKET_PATH must not contain NUL");
  if (!path.isAbsolute(raw)) throw new Error("SESSION_GUARDIAN_SOCKET_PATH must be an absolute path");
  if (raw === path.parse(raw).root) {
    throw new Error("SESSION_GUARDIAN_SOCKET_PATH must name a socket file");
  }
  if (Buffer.byteLength(raw) > 107) {
    throw new Error("SESSION_GUARDIAN_SOCKET_PATH must be at most 107 bytes");
  }
  return raw;
}

function parseMiniAppConfig(
  launchUrl: string | undefined,
  host: string | undefined,
  rawPort: string | undefined,
  rawAuthMaxAgeSeconds: string | undefined,
): MiniAppConfig | undefined {
  if (!launchUrl) return undefined;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(launchUrl);
  } catch {
    throw new Error("MINI_APP_LAUNCH_URL must be a valid https URL");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error("MINI_APP_LAUNCH_URL must use https");
  }
  return {
    launchUrl: parsedUrl.toString(),
    host: host ?? "127.0.0.1",
    port: parseIntegerSetting("MINI_APP_PORT", rawPort, 8787, 1),
    authMaxAgeSeconds: parseIntegerSetting(
      "MINI_APP_AUTH_MAX_AGE_SECONDS",
      rawAuthMaxAgeSeconds,
      3600,
      60,
    ),
    staticDir: path.resolve(process.cwd(), "dist-web"),
  };
}

function parseJiraCommentConfig(
  server: string | undefined,
  login: string | undefined,
  token: string | undefined,
): JiraCommentConfig | undefined {
  if (!server && !login && !token) return undefined;
  if (!server || !login || !token) {
    throw new Error(
      "JIRA_COMMENT_SERVER, JIRA_COMMENT_LOGIN, and JIRA_COMMENT_TOKEN must be configured together",
    );
  }
  return { server, login, token };
}

/**
 * Workspace is derived automatically:
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd()
 */
function resolveWorkspace(): string {
  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseTelegramForumChatId(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed >= 0) {
    throw new Error(`Invalid TELEGRAM_FORUM_CHAT_ID: ${raw}`);
  }
  return parsed;
}

function parseJiraPanelConfig(
  rawChatId: string | undefined,
  rawTopicId: string | undefined,
  clientPath: string | undefined,
  workspace: string | undefined,
): JiraPanelConfig | undefined {
  if (!rawChatId && !rawTopicId) return undefined;
  if (!rawChatId || !rawTopicId) {
    throw new Error("JIRA_PANEL_CHAT_ID and JIRA_PANEL_TOPIC_ID must be configured together");
  }

  const chatId = Number(rawChatId);
  if (!Number.isSafeInteger(chatId) || chatId >= 0) {
    throw new Error(`Invalid JIRA_PANEL_CHAT_ID: ${rawChatId}`);
  }
  const topicId = Number(rawTopicId);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) {
    throw new Error(`Invalid JIRA_PANEL_TOPIC_ID: ${rawTopicId}`);
  }

  return {
    chatId,
    topicId,
    clientPath: clientPath ?? "jira-client",
    ...(workspace ? { workspace: path.resolve(workspace) } : {}),
  };
}

function parseTopicSyncInterval(raw: string | undefined): number {
  if (!raw) {
    return 30_000;
  }

  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 5) {
    throw new Error("TOPIC_SYNC_INTERVAL_SECONDS must be an integer of at least 5");
  }
  return seconds * 1000;
}

function parseIntegerSetting(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
): number {
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function parseBooleanEnv(
  raw: string | undefined,
  defaultValue: boolean,
  options: { readonly strict?: boolean; readonly name?: string } = {},
): boolean {
  if (raw === undefined || (!options.strict && raw === "")) {
    return defaultValue;
  }

  const value = options.strict ? raw : raw.toLowerCase();
  if (value === "true" || (!options.strict && (value === "1" || value === "yes"))) {
    return true;
  }
  if (value === "false" || (!options.strict && (value === "0" || value === "no"))) {
    return false;
  }

  console.warn(options.name
    ? `Invalid boolean env value: ${options.name}. Falling back to ${defaultValue}.`
    : `Invalid boolean env value: "${raw.slice(0, 80)}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "never";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "never".`,
    );
    return "never";
  }

  return raw;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`,
      );
      return "summary";
  }
}

function parseLaunchProfiles(
  raw: string | undefined,
  codexSandboxMode: CodexSandboxMode,
  codexApprovalPolicy: CodexApprovalPolicy,
  enableUnsafeLaunchProfiles: boolean,
): CodexLaunchProfile[] {
  const defaultProfile = createDefaultLaunchProfile(codexSandboxMode, codexApprovalPolicy);
  const profiles = createBuiltinLaunchProfiles(defaultProfile, {
    includeFullAccess: enableUnsafeLaunchProfiles,
  });

  if (!raw) {
    return profiles;
  }

  const parsedProfiles = parseLaunchProfilesJson(raw);
  const profileIndexes = new Map(profiles.map((profile, index) => [profile.id, index]));
  const explicitIds = new Set<string>();

  for (const profile of parsedProfiles) {
    if (profile.id === defaultProfile.id || explicitIds.has(profile.id)) {
      throw new Error(`Duplicate launch profile id: ${profile.id}`);
    }
    if (profile.unsafe && !enableUnsafeLaunchProfiles) {
      throw new Error(
        `Unsafe launch profile "${profile.id}" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true`,
      );
    }

    const existingIndex = profileIndexes.get(profile.id);
    if (existingIndex === undefined) {
      profiles.push(profile);
      profileIndexes.set(profile.id, profiles.length - 1);
    } else {
      profiles[existingIndex] = profile;
    }

    explicitIds.add(profile.id);
  }

  return profiles;
}

function parseDefaultLaunchProfileId(
  raw: string | undefined,
  launchProfiles: CodexLaunchProfile[],
): string {
  if (!raw) {
    return launchProfiles[0]!.id;
  }

  const profile = findLaunchProfile(launchProfiles, raw);
  if (!profile) {
    throw new Error(`Unknown CODEX_DEFAULT_LAUNCH_PROFILE: ${raw}`);
  }

  return profile.id;
}
