import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadConfig,
  parseReliabilityTimeoutConfig,
  parseSessionGuardianSocketPath,
} from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-config-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_MODEL_CHOICES_JSON;
    delete process.env.CODEX_DEFAULT_MODEL_CHOICE;
    delete process.env.CODEX_SANDBOX_MODE;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_LAUNCH_PROFILES_JSON;
    delete process.env.CODEX_DEFAULT_LAUNCH_PROFILE;
    delete process.env.ENABLE_UNSAFE_LAUNCH_PROFILES;
    delete process.env.TOOL_VERBOSITY;
    delete process.env.SHOW_TURN_TOKEN_USAGE;
    delete process.env.TELEGRAM_WEEKLY_TOKEN_LIMIT;
    delete process.env.MAX_FILE_SIZE;
    delete process.env.ENABLE_TELEGRAM_LOGIN;
    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    delete process.env.TELEGRAM_FORUM_CHAT_ID;
    delete process.env.TOPIC_SYNC_INTERVAL_SECONDS;
    delete process.env.TELEGRAM_MAX_ACTIVE_TOPICS;
    delete process.env.TELEGRAM_PROGRESS_HEARTBEAT_SECONDS;
    delete process.env.TELEGRAM_TOPIC_RECOVERY_ENABLED;
    delete process.env.STATUS_BOARD_INTERVAL_SECONDS;
    delete process.env.TELEGRAM_JOB_STORE_MODE;
    delete process.env.TELEGRAM_JOB_DB_PATH;
    delete process.env.TELEGRAM_JOB_LEGACY_JSON_PATH;
    delete process.env.TELEGRAM_JOB_MAX_ATTEMPTS;
    delete process.env.TELEGRAM_JOB_PAYLOAD_RETENTION_DAYS;
    delete process.env.TELEGRAM_JOB_METADATA_RETENTION_DAYS;
    delete process.env.TELEGRAM_JOB_RETENTION_INITIAL_DELAY_SECONDS;
    delete process.env.MINI_APP_LAUNCH_URL;
    delete process.env.MINI_APP_HOST;
    delete process.env.MINI_APP_PORT;
    delete process.env.MINI_APP_AUTH_MAX_AGE_SECONDS;
    delete process.env.JIRA_PANEL_CHAT_ID;
    delete process.env.JIRA_PANEL_TOPIC_ID;
    delete process.env.JIRA_CLIENT_PATH;
    delete process.env.JIRA_PANEL_WORKSPACE;
    delete process.env.JIRA_COMMENT_SERVER;
    delete process.env.JIRA_COMMENT_LOGIN;
    delete process.env.JIRA_COMMENT_TOKEN;
    delete process.env.SESSION_GUARDIAN_SOCKET_PATH;
    delete process.env.APP_SERVER_CONNECT_TIMEOUT_SECONDS;
    delete process.env.APP_SERVER_REQUEST_TIMEOUT_SECONDS;
    delete process.env.APP_SERVER_TURN_START_TIMEOUT_SECONDS;
    delete process.env.TELEGRAM_DELIVERY_TIMEOUT_SECONDS;
    delete process.env.container;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    expect(() => loadConfig()).toThrow("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  });

  it("throws when TELEGRAM_ALLOWED_USER_IDS is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    expect(() => loadConfig()).toThrow(
      "Missing required environment variable: TELEGRAM_ALLOWED_USER_IDS",
    );
  });

  it("parses a valid config correctly", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.CODEX_API_KEY = "secret-key";
    process.env.CODEX_MODEL = "o3";
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    process.env.CODEX_APPROVAL_POLICY = "on-request";
    process.env.TOOL_VERBOSITY = "all";
    process.env.TELEGRAM_FORUM_CHAT_ID = "-1001234567890";
    process.env.TOPIC_SYNC_INTERVAL_SECONDS = "15";

    const config = loadConfig();

    expect(config).toEqual({
      telegramBotToken: "bot-token",
      telegramAllowedUserIds: [123, 456],
      telegramAllowedUserIdSet: new Set([123, 456]),
      workspace: process.cwd(),
      telegramJobs: {
        storeMode: "json",
        databasePath: path.join(process.cwd(), ".telecodex", "jobs.sqlite"),
        legacyJsonPath: path.join(process.cwd(), ".telecodex", "jobs.json"),
        maxAttempts: 5,
        payloadRetentionDays: 7,
        metadataRetentionDays: 90,
        retentionInitialDelaySeconds: 0,
      },
      maxFileSize: 20 * 1024 * 1024,
      codexApiKey: "secret-key",
      threadReopenCommand: undefined,
      codexModel: "o3",
      modelChoices: [],
      defaultModelChoiceId: undefined,
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "on-request",
      launchProfiles: [
        {
          id: "default",
          label: "Default",
          sandboxMode: "danger-full-access",
          approvalPolicy: "on-request",
          unsafe: true,
        },
        {
          id: "readonly",
          label: "Read Only",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          unsafe: false,
        },
        {
          id: "review",
          label: "Review",
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
          unsafe: false,
        },
      ],
      defaultLaunchProfileId: "default",
      enableUnsafeLaunchProfiles: false,
      toolVerbosity: "all",
      showTurnTokenUsage: false,
      telegramWeeklyTokenLimit: undefined,
      enableTelegramLogin: false,
      enableTelegramReactions: false,
      telegramTopicRecoveryEnabled: false,
      telegramForumChatId: -1001234567890,
      topicSyncIntervalMs: 15_000,
      topicSyncEnabled: true,
      telegramMaxActiveTopics: 4,
      telegramProgressHeartbeatMs: 120_000,
      statusBoardIntervalMs: 5_000,
      miniApp: undefined,
      gitlabUrl: undefined,
      gitlabToken: undefined,
      gitlabGroupId: undefined,
      gitlabWorkspaceRoot: undefined,
      jiraPanel: undefined,
      jiraComment: undefined,
      reliabilityTimeouts: {
        appServerConnectMs: 10_000,
        appServerRequestMs: 15_000,
        appServerTurnStartMs: 30_000,
        telegramDeliveryMs: 30_000,
      },
    });
  });

  it("applies default values for optional fields", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const config = loadConfig();

    expect(config.codexApiKey).toBeUndefined();
    expect(config.codexModel).toBeUndefined();
    expect(config.modelChoices).toEqual([]);
    expect(config.defaultModelChoiceId).toBeUndefined();
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(config.defaultLaunchProfileId).toBe("default");
    expect(config.enableUnsafeLaunchProfiles).toBe(false);
    expect(config.toolVerbosity).toBe("summary");
    expect(config.showTurnTokenUsage).toBe(false);
    expect(config.telegramWeeklyTokenLimit).toBeUndefined();
    expect(config.enableTelegramLogin).toBe(false);
    expect(config.enableTelegramReactions).toBe(false);
    expect(config.telegramTopicRecoveryEnabled).toBe(false);
    expect(config.telegramForumChatId).toBeUndefined();
    expect(config.topicSyncIntervalMs).toBe(30_000);
    expect(config.telegramMaxActiveTopics).toBe(4);
    expect(config.telegramProgressHeartbeatMs).toBe(120_000);
    expect(config.statusBoardIntervalMs).toBe(5_000);
    expect(config.miniApp).toBeUndefined();
    expect(config.workspace).toBe(process.cwd());
    expect(config.jiraPanel).toBeUndefined();
    expect(config.jiraComment).toBeUndefined();
    expect(config.sessionGuardianSocketPath).toBeUndefined();
    expect(config.reliabilityTimeouts).toEqual({
      appServerConnectMs: 10_000,
      appServerRequestMs: 15_000,
      appServerTurnStartMs: 30_000,
      telegramDeliveryMs: 30_000,
    });
  });

  it("parses bounded reliability deadlines in seconds", () => {
    expect(parseReliabilityTimeoutConfig({
      APP_SERVER_CONNECT_TIMEOUT_SECONDS: "12",
      APP_SERVER_REQUEST_TIMEOUT_SECONDS: "20",
      APP_SERVER_TURN_START_TIMEOUT_SECONDS: "45",
      TELEGRAM_DELIVERY_TIMEOUT_SECONDS: "50",
    })).toEqual({
      appServerConnectMs: 12_000,
      appServerRequestMs: 20_000,
      appServerTurnStartMs: 45_000,
      telegramDeliveryMs: 50_000,
    });
  });

  it.each([
    ["APP_SERVER_CONNECT_TIMEOUT_SECONDS", "0"],
    ["APP_SERVER_REQUEST_TIMEOUT_SECONDS", "1.5"],
    ["APP_SERVER_TURN_START_TIMEOUT_SECONDS", "301"],
    ["TELEGRAM_DELIVERY_TIMEOUT_SECONDS", "Infinity"],
  ])("rejects invalid bounded deadline %s=%s", (name, value) => {
    expect(() => parseReliabilityTimeoutConfig({ [name]: value })).toThrow(name);
  });

  it("parses explicit Telegram job authority, paths, retry, and retention settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_JOB_STORE_MODE = "sqlite";
    process.env.TELEGRAM_JOB_DB_PATH = "/var/lib/telecodex/jobs.sqlite";
    process.env.TELEGRAM_JOB_LEGACY_JSON_PATH = "/var/lib/telecodex/jobs.json";
    process.env.TELEGRAM_JOB_MAX_ATTEMPTS = "9";
    process.env.TELEGRAM_JOB_PAYLOAD_RETENTION_DAYS = "14";
    process.env.TELEGRAM_JOB_METADATA_RETENTION_DAYS = "120";
    process.env.TELEGRAM_JOB_RETENTION_INITIAL_DELAY_SECONDS = "86400";

    expect(loadConfig().telegramJobs).toEqual({
      storeMode: "sqlite",
      databasePath: "/var/lib/telecodex/jobs.sqlite",
      legacyJsonPath: "/var/lib/telecodex/jobs.json",
      maxAttempts: 9,
      payloadRetentionDays: 14,
      metadataRetentionDays: 120,
      retentionInitialDelaySeconds: 86_400,
    });
  });

  it.each([
    ["TELEGRAM_JOB_STORE_MODE", "invalid"],
    ["TELEGRAM_JOB_DB_PATH", "relative.sqlite"],
    ["TELEGRAM_JOB_MAX_ATTEMPTS", "0"],
    ["TELEGRAM_JOB_PAYLOAD_RETENTION_DAYS", "0"],
    ["TELEGRAM_JOB_METADATA_RETENTION_DAYS", "6"],
    ["TELEGRAM_JOB_RETENTION_INITIAL_DELAY_SECONDS", "604801"],
  ])("rejects invalid %s before startup", (name, value) => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env[name] = value;

    expect(() => loadConfig()).toThrow();
  });

  it("parses an optional absolute session guardian socket path", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_FORUM_CHAT_ID = "-1001234567890";
    process.env.SESSION_GUARDIAN_SOCKET_PATH = "/run/user/0/codex-guardian.sock";

    expect(loadConfig().sessionGuardianSocketPath).toBe(
      "/run/user/0/codex-guardian.sock",
    );
  });

  it.each(["relative.sock", "./guardian.sock"])(
    "rejects non-absolute session guardian socket path %s",
    (value) => {
      process.env.TELEGRAM_BOT_TOKEN = "bot-token";
      process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
      process.env.SESSION_GUARDIAN_SOCKET_PATH = value;

      expect(() => loadConfig()).toThrow(
        "SESSION_GUARDIAN_SOCKET_PATH must be an absolute path",
      );
    },
  );

  it("validates guardian socket emptiness, NUL bytes, and Unix path length precisely", () => {
    expect(() => parseSessionGuardianSocketPath("   ")).toThrow(
      "SESSION_GUARDIAN_SOCKET_PATH must be non-empty",
    );
    expect(() => parseSessionGuardianSocketPath("/run/bad\0socket")).toThrow(
      "SESSION_GUARDIAN_SOCKET_PATH must not contain NUL",
    );
    expect(() => parseSessionGuardianSocketPath(`/${"x".repeat(107)}`)).toThrow(
      "SESSION_GUARDIAN_SOCKET_PATH must be at most 107 bytes",
    );
  });

  it("requires the configured forum chat when the guardian adapter is enabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.SESSION_GUARDIAN_SOCKET_PATH = "/run/user/0/codex-guardian.sock";

    expect(() => loadConfig()).toThrow(
      "SESSION_GUARDIAN_SOCKET_PATH requires TELEGRAM_FORUM_CHAT_ID",
    );
  });

  it("parses the Jira panel topic and executable", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.JIRA_PANEL_CHAT_ID = "-1003981282865";
    process.env.JIRA_PANEL_TOPIC_ID = "999";
    process.env.JIRA_CLIENT_PATH = "/opt/jira-client";
    process.env.JIRA_PANEL_WORKSPACE = "/root/dev/Projects/mircli";

    const config = loadConfig();

    expect(config.jiraPanel).toEqual({
      chatId: -1003981282865,
      topicId: 999,
      clientPath: "/opt/jira-client",
      workspace: "/root/dev/Projects/mircli",
    });
  });

  it("requires both Jira panel topic coordinates", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.JIRA_PANEL_CHAT_ID = "-1003981282865";

    expect(() => loadConfig()).toThrow(
      "JIRA_PANEL_CHAT_ID and JIRA_PANEL_TOPIC_ID must be configured together",
    );
  });

  it("parses Jira comment credentials only as a complete set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.JIRA_COMMENT_SERVER = "https://jira.example.test";
    process.env.JIRA_COMMENT_LOGIN = "agent";
    process.env.JIRA_COMMENT_TOKEN = "token";

    expect(loadConfig().jiraComment).toEqual({
      server: "https://jira.example.test",
      login: "agent",
      token: "token",
    });

    delete process.env.JIRA_COMMENT_TOKEN;
    expect(() => loadConfig()).toThrow(
      "JIRA_COMMENT_SERVER, JIRA_COMMENT_LOGIN, and JIRA_COMMENT_TOKEN must be configured together",
    );
  });

  it("rejects an invalid Telegram forum chat id", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_FORUM_CHAT_ID = "not-a-chat";

    expect(() => loadConfig()).toThrow("Invalid TELEGRAM_FORUM_CHAT_ID: not-a-chat");
  });

  it("leaves topic sync off until its interval is configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_FORUM_CHAT_ID = "-1001234567890";

    const config = loadConfig();

    expect(config.topicSyncEnabled).toBe(false);
  });

  it("turns topic sync on once its interval is configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_FORUM_CHAT_ID = "-1001234567890";
    process.env.TOPIC_SYNC_INTERVAL_SECONDS = "30";

    const config = loadConfig();

    expect(config.topicSyncEnabled).toBe(true);
  });

  it("rejects a topic sync interval shorter than five seconds", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TOPIC_SYNC_INTERVAL_SECONDS = "2";

    expect(() => loadConfig()).toThrow("TOPIC_SYNC_INTERVAL_SECONDS must be an integer of at least 5");
  });

  it("parses Telegram concurrency and progress heartbeat settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_MAX_ACTIVE_TOPICS = "6";
    process.env.TELEGRAM_PROGRESS_HEARTBEAT_SECONDS = "90";
    process.env.STATUS_BOARD_INTERVAL_SECONDS = "12";

    const config = loadConfig();

    expect(config.telegramMaxActiveTopics).toBe(6);
    expect(config.telegramProgressHeartbeatMs).toBe(90_000);
    expect(config.statusBoardIntervalMs).toBe(12_000);
  });

  it("enables the Mini App server when a launch URL is configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_FORUM_CHAT_ID = "-1001234567890";
    process.env.MINI_APP_LAUNCH_URL = "https://t.me/telecodex_bot/dashboard?startapp=dashboard";
    process.env.MINI_APP_HOST = "0.0.0.0";
    process.env.MINI_APP_PORT = "8787";
    process.env.MINI_APP_AUTH_MAX_AGE_SECONDS = "600";

    expect(loadConfig().miniApp).toEqual({
      launchUrl: "https://t.me/telecodex_bot/dashboard?startapp=dashboard",
      host: "0.0.0.0",
      port: 8787,
      authMaxAgeSeconds: 600,
      staticDir: path.join(process.cwd(), "dist-web"),
    });
  });

  it("rejects unsafe Mini App launch URLs and invalid ports", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_FORUM_CHAT_ID = "-1001234567890";
    process.env.MINI_APP_LAUNCH_URL = "http://example.test/dashboard";

    expect(() => loadConfig()).toThrow("MINI_APP_LAUNCH_URL must use https");

    process.env.MINI_APP_LAUNCH_URL = "https://t.me/telecodex_bot/dashboard";
    process.env.MINI_APP_PORT = "0";
    expect(() => loadConfig()).toThrow("MINI_APP_PORT must be an integer of at least 1");
  });

  it("requires a forum chat for Mini App topic actions", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.MINI_APP_LAUNCH_URL = "https://t.me/telecodex_bot/dashboard";

    expect(() => loadConfig()).toThrow(
      "MINI_APP_LAUNCH_URL requires TELEGRAM_FORUM_CHAT_ID",
    );
  });

  it("rejects invalid Telegram concurrency and heartbeat settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_MAX_ACTIVE_TOPICS = "0";

    expect(() => loadConfig()).toThrow("TELEGRAM_MAX_ACTIVE_TOPICS must be an integer of at least 1");

    process.env.TELEGRAM_MAX_ACTIVE_TOPICS = "4";
    process.env.TELEGRAM_PROGRESS_HEARTBEAT_SECONDS = "10";
    expect(() => loadConfig()).toThrow(
      "TELEGRAM_PROGRESS_HEARTBEAT_SECONDS must be an integer of at least 30",
    );
  });

  it("throws when a user id is invalid", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,nope";

    expect(() => loadConfig()).toThrow(
      "Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: nope",
    );
  });

  it("rejects an allowed-user list that becomes empty after parsing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = " , , ";

    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  });

  it("loads values from .env without overwriting existing environment variables", () => {
    writeFileSync(
      path.join(tempDir, ".env"),
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_ALLOWED_USER_IDS=123,456",
        "CODEX_API_KEY='from-dotenv'",
        'CODEX_MODEL="gpt-4.1"',
        "CODEX_SANDBOX_MODE=read-only",
        "CODEX_APPROVAL_POLICY=on-failure",
        'EXTRA_MULTILINE="hello\\nworld"',
      ].join("\n"),
    );
    process.env.TELEGRAM_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-process");
    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.codexApiKey).toBe("from-dotenv");
    expect(config.codexModel).toBe("gpt-4.1");
    expect(config.codexSandboxMode).toBe("read-only");
    expect(config.codexApprovalPolicy).toBe("on-failure");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "read-only",
        approvalPolicy: "on-failure",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(process.env.EXTRA_MULTILINE).toBe("hello\nworld");
  });

  it("resolves workspace to /workspace when running in Docker", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });

  it("parses MAX_FILE_SIZE when configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.MAX_FILE_SIZE = String(5 * 1024 * 1024);

    const config = loadConfig();

    expect(config.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it("parses ENABLE_TELEGRAM_LOGIN boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_LOGIN;
    const config = loadConfig();
    expect(config.enableTelegramLogin).toBe(false);
  });

  it("parses ENABLE_TELEGRAM_REACTIONS boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    const config = loadConfig();
    expect(config.enableTelegramReactions).toBe(false);
  });

  it("keeps Telegram topic recovery disabled unless explicitly enabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    expect(loadConfig().telegramTopicRecoveryEnabled).toBe(false);

    process.env.TELEGRAM_TOPIC_RECOVERY_ENABLED = "true";
    expect(loadConfig().telegramTopicRecoveryEnabled).toBe(true);
  });

  it.each(["1", "yes", "TRUE-ish", "x".repeat(256)])(
    "fails closed for invalid TELEGRAM_TOPIC_RECOVERY_ENABLED=%s",
    (value) => {
      process.env.TELEGRAM_BOT_TOKEN = "bot-token";
      process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
      process.env.TELEGRAM_TOPIC_RECOVERY_ENABLED = value;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(loadConfig().telegramTopicRecoveryEnabled).toBe(false);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toMatch(/^Invalid boolean env value: .{1,160}$/);
      expect(warning.mock.calls[0]?.[0]).not.toContain(value);
    },
  );

  it("parses SHOW_TURN_TOKEN_USAGE boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(false);
    }

    delete process.env.SHOW_TURN_TOKEN_USAGE;
    const config = loadConfig();
    expect(config.showTurnTokenUsage).toBe(false);
  });

  it("parses an optional positive weekly token limit", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_WEEKLY_TOKEN_LIMIT = "250000";

    expect(loadConfig().telegramWeeklyTokenLimit).toBe(250_000);

    process.env.TELEGRAM_WEEKLY_TOKEN_LIMIT = "0";
    expect(() => loadConfig()).toThrow(
      "TELEGRAM_WEEKLY_TOKEN_LIMIT must be an integer of at least 1",
    );
  });

  it("falls back to defaults for invalid optional enum values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_SANDBOX_MODE = "unsafe";
    process.env.CODEX_APPROVAL_POLICY = "sometimes";
    process.env.TOOL_VERBOSITY = "loud";
    process.env.MAX_FILE_SIZE = "nope";

    const config = loadConfig();

    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.toolVerbosity).toBe("summary");
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it("parses model choices and their explicit default", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_MODEL_CHOICES_JSON = JSON.stringify([
      {
        id: "openai-default",
        label: "OpenAI GPT-5.6 Sol",
        provider: "openai",
        model: "gpt-5.6-sol",
        supportsImages: true,
      },
      {
        id: "glm-53",
        label: "Z.AI GLM-5.3",
        provider: "zai",
        model: "glm-5.3",
        supportsImages: false,
        webSearch: "disabled",
      },
    ]);
    process.env.CODEX_DEFAULT_MODEL_CHOICE = "openai-default";

    const config = loadConfig();

    expect(config.modelChoices).toHaveLength(2);
    expect(config.modelChoices[1]).toEqual({
      id: "glm-53",
      label: "Z.AI GLM-5.3",
      provider: "zai",
      model: "glm-5.3",
      supportsImages: false,
      webSearch: "disabled",
    });
    expect(config.defaultModelChoiceId).toBe("openai-default");
  });

  it("rejects a non-OpenAI default while model selection is disabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_MODEL_CHOICES_JSON = JSON.stringify([
      { id: "openai", label: "OpenAI", provider: "openai", model: "gpt" },
      { id: "glm", label: "GLM", provider: "zai", model: "glm" },
    ]);
    process.env.CODEX_DEFAULT_MODEL_CHOICE = "glm";

    expect(() => loadConfig()).toThrow(
      "CODEX_DEFAULT_MODEL_CHOICE must use the openai provider",
    );
  });

  it("uses the first configured choice when no explicit default is set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_MODEL_CHOICES_JSON = JSON.stringify([
      { id: "openai", label: "OpenAI", provider: "openai", model: "gpt" },
      { id: "glm", label: "GLM", provider: "zai", model: "glm" },
    ]);

    expect(loadConfig().defaultModelChoiceId).toBe("openai");
  });

  it("rejects an unknown default model choice", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_MODEL_CHOICES_JSON = JSON.stringify([
      { id: "openai", label: "OpenAI", provider: "openai", model: "gpt" },
    ]);
    process.env.CODEX_DEFAULT_MODEL_CHOICE = "missing";

    expect(() => loadConfig()).toThrow("Unknown CODEX_DEFAULT_MODEL_CHOICE: missing");
  });

  it("parses explicit launch profiles and default selection", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.ENABLE_UNSAFE_LAUNCH_PROFILES = "true";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "readonly";

    const config = loadConfig();

    expect(config.enableUnsafeLaunchProfiles).toBe(true);
    expect(config.defaultLaunchProfileId).toBe("readonly");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
      {
        id: "full-access",
        label: "Full Access",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
    ]);
  });

  it("throws when CODEX_DEFAULT_LAUNCH_PROFILE is unknown", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "missing";

    expect(() => loadConfig()).toThrow("Unknown CODEX_DEFAULT_LAUNCH_PROFILE: missing");
  });

  it("throws when unsafe extra launch profiles are configured without enabling them", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);

    expect(() => loadConfig()).toThrow(
      'Unsafe launch profile "danger-full" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true',
    );
  });

  it("throws on duplicate launch profile ids", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "readonly",
        label: "Read Only 2",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      },
    ]);

    expect(() => loadConfig()).toThrow("Duplicate launch profile id: readonly");
  });
});
