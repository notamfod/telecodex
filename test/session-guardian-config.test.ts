import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadSessionGuardianEnvironment, parseSessionGuardianConfig }
  from "../src/session-guardian-config.js";

const OPTIONS = {
  home: "/home/guardian",
  workspace: "/srv/telecodex",
};

describe("parseSessionGuardianConfig", () => {
  it("uses safe observation-only defaults under Codex and workspace state", () => {
    expect(parseSessionGuardianConfig({}, OPTIONS)).toEqual({
      appServerSocketPath: "/home/guardian/.codex/app-server-control/app-server-control.sock",
      socketPath: "/srv/telecodex/.telecodex/session-guardian.sock",
      databasePath: "/srv/telecodex/.telecodex/session-guardian.sqlite",
      scanIntervalMs: 60_000,
      staleAfterMs: 600_000,
      recentWindowMs: 86_400_000,
      confirmationsRequired: 2,
      fallbackRoute: undefined,
      observationOnly: true,
      repairEnabled: false,
    });
  });

  it("uses CODEX_HOME and accepts every explicit setting", () => {
    const config = parseSessionGuardianConfig({
      CODEX_HOME: "/var/lib/codex",
      SESSION_GUARDIAN_APP_SERVER_SOCKET: "/run/user/1000/app.sock",
      SESSION_GUARDIAN_SOCKET_PATH: "/run/user/1000/guardian.sock",
      SESSION_GUARDIAN_DB_PATH: "/var/lib/guardian/state.sqlite",
      SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS: "15",
      SESSION_GUARDIAN_STALE_AFTER_SECONDS: "30",
      SESSION_GUARDIAN_RECENT_WINDOW_SECONDS: "45",
      SESSION_GUARDIAN_CONFIRMATIONS: "3",
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: "-1001234567890",
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "42",
      TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
      SESSION_GUARDIAN_OBSERVATION_ONLY: "false",
      SESSION_GUARDIAN_REPAIR_ENABLED: "true",
    }, OPTIONS);

    expect(config).toEqual({
      appServerSocketPath: "/run/user/1000/app.sock",
      socketPath: "/run/user/1000/guardian.sock",
      databasePath: "/var/lib/guardian/state.sqlite",
      scanIntervalMs: 15_000,
      staleAfterMs: 30_000,
      recentWindowMs: 45_000,
      confirmationsRequired: 3,
      fallbackRoute: { chatId: -1_001_234_567_890, messageThreadId: 42 },
      observationOnly: false,
      repairEnabled: true,
    });
  });

  it.each([
    ["scan below ten seconds", { SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS: "9" }, "at least 10"],
    ["fractional scan", { SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS: "10.5" }, "integer"],
    ["unsafe millisecond conversion", {
      SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS: String(Number.MAX_SAFE_INTEGER),
      SESSION_GUARDIAN_STALE_AFTER_SECONDS: String(Number.MAX_SAFE_INTEGER),
    }, "safe milliseconds"],
    ["stale below two scans", {
      SESSION_GUARDIAN_SCAN_INTERVAL_SECONDS: "20",
      SESSION_GUARDIAN_STALE_AFTER_SECONDS: "39",
    }, "at least twice"],
    ["recent window below stale threshold", {
      SESSION_GUARDIAN_STALE_AFTER_SECONDS: "600",
      SESSION_GUARDIAN_RECENT_WINDOW_SECONDS: "599",
    }, "must be at least SESSION_GUARDIAN_STALE_AFTER_SECONDS"],
    ["fractional recent window", {
      SESSION_GUARDIAN_RECENT_WINDOW_SECONDS: "86400.5",
    }, "integer"],
    ["unsafe recent-window millisecond conversion", {
      SESSION_GUARDIAN_RECENT_WINDOW_SECONDS: String(Number.MAX_SAFE_INTEGER),
    }, "safe milliseconds"],
    ["zero confirmations", { SESSION_GUARDIAN_CONFIRMATIONS: "0" }, "positive safe integer"],
    ["one confirmation", { SESSION_GUARDIAN_CONFIRMATIONS: "1" }, "at least 2"],
    ["fractional confirmations", { SESSION_GUARDIAN_CONFIRMATIONS: "1.5" }, "positive safe integer"],
    ["chat without topic", { SESSION_GUARDIAN_FALLBACK_CHAT_ID: "-1001" }, "configured together"],
    ["topic without chat", { SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "2" }, "configured together"],
    ["fallback without forum", {
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: "-1001",
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "2",
    }, "TELEGRAM_FORUM_CHAT_ID is required"],
    ["fallback forum mismatch", {
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: "-1001",
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "2",
      TELEGRAM_FORUM_CHAT_ID: "-1002",
    }, "must equal"],
    ["invalid positive forum", {
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: "-1001",
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "2",
      TELEGRAM_FORUM_CHAT_ID: "1001",
    }, "negative 52-bit"],
    ["zero chat", {
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: "0",
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "2",
    }, "52-bit"],
    ["oversized chat", {
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: String(2 ** 52),
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "2",
    }, "52-bit"],
    ["zero topic", {
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: "-1001",
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "0",
    }, "signed 32-bit"],
    ["oversized topic", {
      SESSION_GUARDIAN_FALLBACK_CHAT_ID: "-1001",
      SESSION_GUARDIAN_FALLBACK_TOPIC_ID: "2147483648",
    }, "signed 32-bit"],
    ["invalid observation flag", { SESSION_GUARDIAN_OBSERVATION_ONLY: "maybe" }, "true or false"],
    ["invalid repair flag", { SESSION_GUARDIAN_REPAIR_ENABLED: "yes" }, "true or false"],
    ["contradictory modes", {
      SESSION_GUARDIAN_OBSERVATION_ONLY: "true",
      SESSION_GUARDIAN_REPAIR_ENABLED: "true",
    }, "cannot be enabled"],
  ])("rejects %s", (_name, env, message) => {
    expect(() => parseSessionGuardianConfig(env, OPTIONS)).toThrow(message);
  });

  it.each([
    ["SESSION_GUARDIAN_APP_SERVER_SOCKET", "relative.sock", "absolute"],
    ["SESSION_GUARDIAN_SOCKET_PATH", "/", "file"],
    ["SESSION_GUARDIAN_DB_PATH", "/", "file"],
    ["SESSION_GUARDIAN_DB_PATH", "/tmp/bad\0name", "NUL"],
    ["SESSION_GUARDIAN_SOCKET_PATH", `/${"x".repeat(108)}`, "107 bytes"],
  ])("rejects unsafe %s", (name, value, message) => {
    expect(() => parseSessionGuardianConfig({ [name]: value }, OPTIONS)).toThrow(message);
  });

  it("rejects unsafe defaults at their input boundary", () => {
    expect(() => parseSessionGuardianConfig({}, { ...OPTIONS, workspace: "." }))
      .toThrow("workspace must be an absolute path");
    expect(() => parseSessionGuardianConfig({}, { ...OPTIONS, home: "/" }))
      .not.toThrow();
    expect(path.isAbsolute(OPTIONS.workspace)).toBe(true);
  });

  it("loads the repository env narrowly while preserving explicit process values", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guardian-env-"));
    try {
      writeFileSync(path.join(directory, ".env"), [
        "TELEGRAM_BOT_TOKEN='from-file'",
        "SESSION_GUARDIAN_SOCKET_PATH=/run/from-file.sock",
        "UNRELATED_SECRET=do-not-log",
      ].join("\n"));
      const loaded = loadSessionGuardianEnvironment({
        cwd: directory,
        env: { SESSION_GUARDIAN_SOCKET_PATH: "/run/explicit.sock" },
      });
      expect(loaded.env.TELEGRAM_BOT_TOKEN).toBe("from-file");
      expect(loaded.env.SESSION_GUARDIAN_SOCKET_PATH).toBe("/run/explicit.sock");
      expect(loaded.workspace).toBe(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
