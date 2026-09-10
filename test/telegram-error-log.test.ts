import { describe, expect, it, vi } from "vitest";
import {
  formatTelegramErrorLog,
  inspectTelegramErrorForLog,
  isTelegramPollingConflict,
  isTelegramTopicNotModified,
  sanitizeTelegramLogText,
  type TelegramLogCategory,
  type TelegramLogOperation,
} from "../src/telegram-error-log.js";

const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("sanitizeTelegramLogText", () => {
  it("redacts Telegram API and file URL credentials", () => {
    for (const input of [
      `Network request for 'https://api.telegram.org/bot${TOKEN}/getUpdates' failed`,
      `GET https://api.telegram.org/file/bot${TOKEN}/documents/a.txt`,
    ]) {
      const output = sanitizeTelegramLogText(input);
      expect(output).not.toContain(TOKEN);
      expect(output).toContain("[REDACTED]");
    }
  });

  it("redacts URI userinfo and common credential query parameters", () => {
    const parameters = [
      "access_token", "api_key", "apikey", "auth", "authorization", "password", "secret", "token",
    ];
    const input = `https://user:password@example.test/path?${parameters
      .map((parameter) => `${parameter}=${TOKEN}`)
      .join("&")}&key=value`;
    const output = sanitizeTelegramLogText(input);

    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("user:password");
    expect(output.match(/\[REDACTED\]/g)?.length).toBe(parameters.length + 1);
    expect(output).toContain("key=value");
  });

  it("redacts raw Telegram tokens", () => {
    const output = sanitizeTelegramLogText(`telegram token ${TOKEN}`);
    expect(output).toBe("telegram token [REDACTED]");
    expect(output).not.toContain(TOKEN);
  });

  it("removes controls, collapses whitespace, and bounds Unicode by code point", () => {
    const output = sanitizeTelegramLogText(` safe\n\r\u0000\t value ${"😀".repeat(600)}`);

    expect(output).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(output.startsWith("safe value ")).toBe(true);
    expect(Array.from(output).length).toBe(512);
    expect(output.endsWith("😀")).toBe(true);
  });

  it("uses deterministic safe bounds for boundary and invalid limits", () => {
    expect(sanitizeTelegramLogText("😀😀", 1)).toBe("😀");
    expect(Array.from(sanitizeTelegramLogText("x".repeat(600), 512))).toHaveLength(512);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000]) {
      expect(Array.from(sanitizeTelegramLogText("x".repeat(600), limit))).toHaveLength(512);
    }
  });

  it("uses a safe fallback for empty text", () => {
    expect(sanitizeTelegramLogText("\n\u0000\t")).toBe("Unknown error");
  });

  it("bounds input before running sanitizer regexes", () => {
    const input = `safe ${" ".repeat(2_000_000)}network timeout`;
    expect(sanitizeTelegramLogText(input)).toBe("safe");
    expect(inspectTelegramErrorForLog(new Error(input), "delivery_send"))
      .toEqual({ category: "internal_local" });
  });

  it("does not emit partial credentials when bounded input truncates them", () => {
    const longSecret = "A".repeat(20_000);
    const cases = [
      {
        input: `${"x".repeat(499)} 123456789:${longSecret}`,
        forbidden: /123456789:/,
      },
      {
        input: `${"x".repeat(450)}https://api.telegram.org/bot123456789:${longSecret}/getUpdates`,
        forbidden: /bot123456789:/,
      },
      {
        input: `${"x".repeat(450)}https://example.test/path?token=123456789:${longSecret}&ok=1`,
        forbidden: /token=123456789:/,
      },
      {
        input: `${"x".repeat(470)}https://user:${longSecret}@example.test/path`,
        forbidden: /https:\/\/user:/,
      },
    ];

    for (const { input, forbidden } of cases) {
      const output = sanitizeTelegramLogText(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toMatch(forbidden);
      expect(Array.from(output).length).toBeLessThanOrEqual(512);
    }
  });
});

describe("inspectTelegramErrorForLog", () => {
  const cases: ReadonlyArray<readonly [unknown, TelegramLogOperation, TelegramLogCategory]> = [
    [{ error_code: 429, parameters: { retry_after: 24 } }, "delivery_send", "rate_limited"],
    [{ error_code: 400, description: "Bad Request: TOPIC_CLOSED" }, "topic", "topic_closed"],
    [{ error_code: 400, description: "Bad Request: message thread not found" }, "topic", "topic_missing"],
    [{ error_code: 400, description: "Bad Request: topic not found" }, "topic", "topic_missing"],
    [{ error_code: 400, description: "Bad Request: message to edit not found" }, "status_edit", "message_missing"],
    [{ error_code: 403, description: "Forbidden" }, "bot_handler", "forbidden"],
    [{ error_code: 400, description: "Bad Request: can't parse rich message" }, "rich_send", "rich_rejected"],
    [{ error_code: 400, description: "Bad Request: Rich Messages are not available" }, "rich_edit", "rich_rejected"],
    [{ error_code: 400, description: "Bad Request" }, "bot_handler", "bad_request_other"],
    [new Error("fetch failed"), "status_edit", "network_retryable"],
    [new Error("fetch failed"), "delivery_send", "acceptance_unknown"],
    [new Error("socket hang up"), "rich_send", "acceptance_unknown"],
    [new Error("local invariant"), "reliability", "internal_local"],
  ];

  it("classifies the safe diagnostic categories", () => {
    for (const [error, operation, category] of cases) {
      expect(inspectTelegramErrorForLog(error, operation).category).toBe(category);
    }
  });

  it("extracts a grammY-shaped rate limit and retry delay", () => {
    const diagnostic = inspectTelegramErrorForLog({
      name: "GrammyError",
      message: "Call to getUpdates failed",
      error: {
        error_code: 429,
        description: "Too Many Requests: retry after 24",
        parameters: { retry_after: 24 },
      },
    }, "polling");

    expect(diagnostic).toEqual({
      category: "rate_limited",
      telegramCode: 429,
      retryAfterMs: 24_000,
    });
  });

  it("selects one coherent text-only rate-limit candidate", () => {
    expect(inspectTelegramErrorForLog({
      parameters: { retry_after: 3_600 },
      error: {
        description: "Too Many Requests: retry later",
        parameters: { retry_after: 2 },
      },
    }, "polling")).toEqual({ category: "rate_limited", retryAfterMs: 2_000 });

    expect(inspectTelegramErrorForLog({
      description: "Too Many Requests: retry later",
      error: { parameters: { retry_after: 2 } },
    }, "polling")).toEqual({ category: "rate_limited", retryAfterMs: 30_000 });

    expect(inspectTelegramErrorForLog({
      description: "Too Many Requests: retry later",
      error: {
        message: "429 rate limited",
        parameters: { retry_after: 2 },
      },
    }, "polling")).toEqual({ category: "rate_limited", retryAfterMs: 2_000 });

    expect(inspectTelegramErrorForLog({
      message: "local invariant",
      error: { parameters: { retry_after: 2 } },
    }, "polling")).toEqual({ category: "internal_local" });
  });

  it("ignores integers outside the Telegram status-code range", () => {
    for (const errorCode of [-1, 0, 99, 600, 1_234_567_890_123, 987_654_321]) {
      const diagnostic = inspectTelegramErrorForLog({ error_code: errorCode }, "bot_handler");
      expect(diagnostic).not.toHaveProperty("telegramCode");
      expect(formatTelegramErrorLog("bot_handler", { error_code: errorCode })).not.toContain(" code=");
    }
  });

  it("finds Telegram fields through both cause and error wrappers", () => {
    expect(inspectTelegramErrorForLog({
      cause: { error: { error_code: 403, description: "Forbidden" } },
    }, "cleanup")).toMatchObject({ category: "forbidden", telegramCode: 403 });
    expect(inspectTelegramErrorForLog({
      error: { cause: { error_code: 400, description: "Bad Request: TOPIC_CLOSED" } },
    }, "topic")).toMatchObject({ category: "topic_closed", telegramCode: 400 });
  });

  it("keeps Telegram code, retry, and classification text on one BFS candidate", () => {
    expect(inspectTelegramErrorForLog({
      error_code: 403,
      description: "Forbidden",
      error: { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 24 } },
    }, "delivery_send")).toEqual({ category: "forbidden", telegramCode: 403 });
    expect(inspectTelegramErrorForLog({
      error_code: 403,
      description: "Forbidden",
      error: { description: "Too Many Requests", parameters: { retry_after: 2 } },
    }, "delivery_send")).toEqual({ category: "forbidden", telegramCode: 403 });

    expect(inspectTelegramErrorForLog({
      error_code: 400,
      description: "Bad Request: TOPIC_CLOSED",
      error: { description: "Bad Request: message thread not found" },
    }, "topic")).toEqual({ category: "topic_closed", telegramCode: 400 });

    expect(inspectTelegramErrorForLog({
      error_code: 400,
      description: "Bad Request",
      cause: { description: "Bad Request: TOPIC_CLOSED" },
    }, "topic")).toEqual({ category: "bad_request_other", telegramCode: 400 });
  });

  it("is cycle safe and does not traverse past four object levels", () => {
    const cycle: { error?: unknown; message: string } = { message: "local invariant" };
    cycle.error = cycle;
    expect(inspectTelegramErrorForLog(cycle, "reliability")).toEqual({ category: "internal_local" });

    const beyondCodeGetter = vi.fn(() => 429);
    const beyondLimit = Object.defineProperty({}, "error_code", { get: beyondCodeGetter });
    const depthFour = { error: beyondLimit };
    const depthThree = { error: depthFour };
    const depthTwo = { error: depthThree };
    const root = { error: depthTwo };
    expect(inspectTelegramErrorForLog(root, "cleanup")).toEqual({ category: "internal_local" });
    expect(beyondCodeGetter).not.toHaveBeenCalled();
  });

  it("guards every allowlisted property read and never reads payload", () => {
    const payloadGetter = vi.fn(() => TOKEN);
    const hostile = Object.defineProperties({}, {
      name: { get: () => { throw new Error("getter secret"); } },
      message: { get: () => { throw new Error("getter secret"); } },
      cause: { get: () => { throw new Error("getter secret"); } },
      error: { get: () => { throw new Error("getter secret"); } },
      error_code: { get: () => { throw new Error("getter secret"); } },
      description: { get: () => { throw new Error("getter secret"); } },
      parameters: { get: () => { throw new Error("getter secret"); } },
      payload: { get: payloadGetter },
      toString: { get: () => { throw new Error("must not stringify"); } },
    });

    expect(() => inspectTelegramErrorForLog(hostile, "bot_handler")).not.toThrow();
    expect(inspectTelegramErrorForLog(hostile, "bot_handler")).toEqual({ category: "internal_local" });
    expect(payloadGetter).not.toHaveBeenCalled();
  });

  it("handles a hostile Proxy without coercing it", () => {
    const hostile = new Proxy({}, {
      get: () => { throw new Error("must not escape"); },
    });

    expect(inspectTelegramErrorForLog(hostile, "startup")).toEqual({ category: "internal_local" });
  });

  it("does not classify rich rejection outside rich operations", () => {
    const error = { error_code: 400, description: "Bad Request: can't parse rich message" };
    expect(inspectTelegramErrorForLog(error, "delivery_send").category).toBe("bad_request_other");
  });

  it("matches topic and message-missing predicates with transport parity", () => {
    for (const description of [
      "Bad Request: message thread not found",
      "Bad Request: TOPIC_ID_INVALID",
      "Bad Request: TOPIC_DELETED",
    ]) {
      expect(inspectTelegramErrorForLog(
        { error_code: 400, description }, "topic",
      ).category).toBe("topic_missing");
    }
    for (const description of [
      "Bad Request: TOPIC_CLOSED",
      "Bad Request: topic is closed",
      "Bad Request: topic is already closed",
    ]) {
      expect(inspectTelegramErrorForLog(
        { error_code: 400, description }, "topic",
      ).category).toBe("topic_closed");
    }
    for (const operation of ["keyboard_edit", "status_edit", "delivery_edit", "rich_edit"] as const) {
      expect(inspectTelegramErrorForLog({
        error_code: 400, description: "Bad Request: message to edit not found",
      }, operation).category).toBe("message_missing");
    }
    for (const [description, operation] of [
      ["Bad Request: message to edit not found: extra", "status_edit"],
      ["Bad Request: message to edit not found", "delivery_send"],
    ] as const) {
      expect(inspectTelegramErrorForLog(
        { error_code: 400, description }, operation,
      ).category).toBe("bad_request_other");
    }
  });

  it("matches rich rejection with exact transport parity", () => {
    const formatDescriptions = [
      "Bad Request: can't parse rich message",
      "Bad Request: can't parse rich message: unsupported tag",
      "Bad Request: failed to parse rich message",
      "Bad Request: can't parse rich markdown",
      "Bad Request: failed to parse rich markdown: unsupported tag",
    ];
    const capabilityDescriptions = [
      "Bad Request: rich message is not available",
      "Bad Request: rich message is unavailable",
      "Bad Request: rich messages are not available",
      "Bad Request: rich messages are unavailable",
    ];
    for (const operation of ["rich_send", "rich_edit"] as const) {
      for (const description of [...formatDescriptions, ...capabilityDescriptions]) {
        expect(inspectTelegramErrorForLog(
          { error_code: 400, description }, operation,
        ).category).toBe("rich_rejected");
      }
    }

    const sendMethodDescriptions = [
      "Bad Request: method not found",
      "Bad Request: method is not available",
      "Bad Request: method is unavailable",
      "Bad Request: method sendRichMessage not found",
      "Bad Request: method sendRichMessage is not available",
      "Bad Request: method sendRichMessage is unavailable",
      "Bad Request: sendRichMessage method not found",
      "Bad Request: sendRichMessage method is not available",
      "Bad Request: sendRichMessage method is unavailable",
    ];
    for (const description of sendMethodDescriptions) {
      expect(inspectTelegramErrorForLog(
        { error_code: 400, description }, "rich_send",
      ).category).toBe("rich_rejected");
      expect(inspectTelegramErrorForLog(
        { error_code: 400, description }, "rich_edit",
      ).category).toBe("bad_request_other");
    }

    for (const description of [
      "can't parse rich message",
      "Bad Request: can't parse rich message suffix",
      "Bad Request: can't parse entities",
      "Bad Request: rich messages are unavailable: extra",
      "Bad Request: method editRichMessage is unavailable",
    ]) {
      for (const operation of ["rich_send", "rich_edit"] as const) {
        expect(inspectTelegramErrorForLog(
          { error_code: 400, description }, operation,
        ).category).toBe("bad_request_other");
      }
    }
  });

  it("sanitizes bounded text locally before classification without exposing it", () => {
    const diagnostic = inspectTelegramErrorForLog(new Error("fetch\nfailed"), "status_edit");
    expect(diagnostic).toEqual({ category: "network_retryable" });
    expect(diagnostic).not.toHaveProperty("detail");
  });

  it("does not treat generic timeout configuration text as a network failure", () => {
    for (const message of ["invalid timeout configuration", "timeout must be positive"]) {
      expect(inspectTelegramErrorForLog(new Error(message), "delivery_send"))
        .toEqual({ category: "internal_local" });
    }
    expect(inspectTelegramErrorForLog(new Error("network timeout"), "delivery_send"))
      .toEqual({ category: "acceptance_unknown" });
  });

  it("handles primitive, string, and null errors without unsafe coercion", () => {
    expect(inspectTelegramErrorForLog("network timeout", "status_send")).toEqual({
      category: "network_retryable",
    });
    for (const error of [null, undefined, 42, true, Symbol("secret")]) {
      expect(inspectTelegramErrorForLog(error, "reliability")).toEqual({ category: "internal_local" });
    }
  });
});

describe("formatTelegramErrorLog", () => {
  it("never emits free-form Telegram error text", () => {
    const output = formatTelegramErrorLog("bot_handler", new Error(
      `https://api.telegram.org/bot${TOKEN}/createForumTopic message=77 payload=PRIVATE`,
    ));

    expect(output).toBe("telegram event=bot_handler category=internal_local");
    expect(output).not.toMatch(/123456789:|message=77|PRIVATE/);
  });

  it("emits one bounded line in exact fixed field order", () => {
    const output = formatTelegramErrorLog("reliability", {
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 24 },
    });

    expect(output).toBe(
      "telegram event=reliability category=rate_limited code=429 retryAfterMs=24000",
    );
    expect(output).not.toMatch(/[\r\n]/);
    expect(Array.from(output).length).toBeLessThanOrEqual(640);
  });

  it("omits absent optional fields and does not leak hostile values", () => {
    const payloadGetter = vi.fn(() => TOKEN);
    const hostile = Object.defineProperties({}, {
      message: { get: () => { throw new Error(TOKEN); } },
      payload: { get: payloadGetter },
      toString: { value: () => { throw new Error(TOKEN); } },
    });

    const output = formatTelegramErrorLog("bot_handler", hostile);
    expect(output).toBe("telegram event=bot_handler category=internal_local");
    expect(output).not.toContain(TOKEN);
    expect(payloadGetter).not.toHaveBeenCalled();
  });
});

describe("Telegram error predicates", () => {
  it("recognizes polling conflicts by numeric code or bounded safe pattern", () => {
    expect(isTelegramPollingConflict({ error_code: 409 })).toBe(true);
    expect(isTelegramPollingConflict({ cause: new Error("409: Conflict: terminated by other getUpdates") })).toBe(true);
    expect(isTelegramPollingConflict({ description: "Conflict: terminated by other getUpdates" })).toBe(true);
    expect(isTelegramPollingConflict({ name: "Conflict" })).toBe(false);
    expect(isTelegramPollingConflict("409 Conflict")).toBe(false);
    expect(isTelegramPollingConflict(new Error("processed 409 records"))).toBe(false);
    expect(isTelegramPollingConflict(new Error("local invariant"))).toBe(false);
    expect(isTelegramPollingConflict({ message: `${"x".repeat(513)} Conflict` })).toBe(false);
  });

  it("recognizes TOPIC_NOT_MODIFIED only in bounded allowlisted Telegram text", () => {
    expect(isTelegramTopicNotModified({
      error: { error_code: 400, description: "Bad Request: TOPIC_NOT_MODIFIED" },
    })).toBe(true);
    expect(isTelegramTopicNotModified(new Error("Bad Request: TOPIC_NOT_MODIFIED"))).toBe(true);
    expect(isTelegramTopicNotModified({ name: "TOPIC_NOT_MODIFIED" })).toBe(false);
    expect(isTelegramTopicNotModified({ payload: "TOPIC_NOT_MODIFIED" })).toBe(false);
    expect(isTelegramTopicNotModified({
      description: `${"x".repeat(513)}TOPIC_NOT_MODIFIED`,
    })).toBe(false);
  });

  it("keeps predicates side-effect safe for cycles and throwing getters", () => {
    const payloadGetter = vi.fn(() => "TOPIC_NOT_MODIFIED");
    const hostile: Record<string, unknown> = Object.defineProperties({}, {
      message: { get: () => { throw new Error("getter secret"); } },
      error: { value: null, writable: true },
      payload: { get: payloadGetter },
    });
    hostile.error = hostile;

    expect(isTelegramPollingConflict(hostile)).toBe(false);
    expect(isTelegramTopicNotModified(hostile)).toBe(false);
    expect(payloadGetter).not.toHaveBeenCalled();
  });
});
