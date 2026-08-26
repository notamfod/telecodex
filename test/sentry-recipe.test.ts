import { describe, expect, it, vi } from "vitest";

import type { SentryTopRecipe } from "../src/recipe-config.js";
import { runSentryTopRecipe } from "../src/sentry-recipe.js";

const recipe: SentryTopRecipe = {
  id: "daily-sentry-top",
  kind: "sentry-top",
  cwd: "/root/dev/Projects/mircli",
  dofboxConfigModule: "/opt/dofbox/src/utils/config.js",
  realm: "mircli",
  period: "24h",
  limit: 2,
  deliver: { chatId: -1003981282865, messageThreadId: 635 },
};

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: "3999",
  shortId: "MIR-BACK-2TC",
  level: "error",
  count: 210,
  userCount: 3,
  project: { slug: "mir-back" },
  title: "Can't convert <value>",
  culprit: "ReindexerResponseParser::parse",
  permalink: "https://sentry.mircli.ru/organizations/sentry/issues/3999/",
  ...overrides,
});

describe("runSentryTopRecipe", () => {
  it("collects organization-wide issues without invoking an AI and sends review buttons", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      issue({ id: "1", shortId: "MIR-BACK-1", title: "N+1 Query", count: 500 }),
      issue(),
      issue({ id: "3820", shortId: "MIR-BACK-2NE", title: "Unique violation", count: 117 }),
      issue({ id: "2", shortId: "MIR-BACK-2", title: "Queue failed", count: 57 }),
    ])));
    const loadCredentials = vi.fn().mockResolvedValue({
      baseUrl: "https://sentry.mircli.ru/api/0",
      org: "sentry",
      token: "secret-token",
    });
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await runSentryTopRecipe(recipe, send, {
      fetch,
      loadCredentials,
      now: () => new Date("2026-08-20T05:00:00.000Z"),
    });

    expect(loadCredentials).toHaveBeenCalledWith(
      "/opt/dofbox/src/utils/config.js",
      "mircli",
    );
    const request = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(request.pathname).toBe("/api/0/organizations/sentry/issues/");
    expect(Object.fromEntries(request.searchParams)).toEqual({
      query: "is:unresolved environment:production",
      sort: "freq",
      project: "-1",
      limit: "100",
      start: "2026-08-19T05:00:00.000Z",
      end: "2026-08-20T05:00:00.000Z",
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(result).toEqual({ total: 4, delivered: 2, suppressed: 1 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]?.[0]).toContain("Sentry · топ ошибок");
    expect(send.mock.calls[1]?.[0]).toContain("Can't convert &lt;value&gt;");
    expect(send.mock.calls[1]?.[1]).toEqual({
      inline_keyboard: [[
        { text: "🔎 Разобрать", callback_data: "sentry_task:3999:MIR-BACK-2TC" },
        { text: "Открыть в Sentry", url: "https://sentry.mircli.ru/organizations/sentry/issues/3999/" },
      ]],
    });
    expect(send.mock.calls[2]?.[0]).toContain("MIR-BACK-2NE");
  });

  it("rejects unsafe issue links before sending", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      issue({ permalink: "javascript:alert(1)" }),
    ])));
    const send = vi.fn().mockResolvedValue(undefined);

    await expect(runSentryTopRecipe(recipe, send, {
      fetch,
      loadCredentials: vi.fn().mockResolvedValue({
        baseUrl: "https://sentry.mircli.ru/api/0",
        org: "sentry",
        token: "secret-token",
      }),
    })).rejects.toThrow(/permalink/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("attributes malformed JSON to the direct Sentry response", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await expect(runSentryTopRecipe(recipe, send, {
      fetch: vi.fn().mockResolvedValue(new Response("not-json")),
      loadCredentials: vi.fn().mockResolvedValue({
        baseUrl: "https://sentry.mircli.ru/api/0",
        org: "sentry",
        token: "secret-token",
      }),
    })).rejects.toThrow("Sentry returned invalid JSON");
    expect(send).not.toHaveBeenCalled();
  });
});
