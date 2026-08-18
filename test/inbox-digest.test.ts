import { describe, expect, it, vi } from "vitest";

import {
  renderInboxDigest,
  sendInboxDigest,
} from "../src/inbox-digest.js";
import type { Ticket } from "../src/inbox.js";

const now = Date.UTC(2026, 7, 18, 6);

function ticket(overrides: Partial<Ticket>): Ticket {
  return {
    id: 1,
    inboxContextKey: "-100123:537",
    workTopicId: 700,
    workspace: "/work/mircli",
    prompt: "prompt",
    source: "support",
    createdAt: now - 2 * 86_400_000,
    ...overrides,
  };
}

describe("renderInboxDigest", () => {
  it("renders the empty ticket state", () => {
    const digest = renderInboxDigest([], [], { now });

    expect(digest.html).toContain("Открытых тикетов нет");
  });

  it("groups unresolved tickets with age, state, and topic links", () => {
    const digest = renderInboxDigest([
      ticket({ id: 1, externalKey: "MIR-10", startedAt: now - 3_600_000 }),
      ticket({ id: 2, workspace: "/work/antwerp", workTopicId: 701, createdAt: now - 3_600_000 }),
      ticket({ id: 3, resolvedAt: now - 1_000 }),
    ], [], { now });

    expect(digest.html).toContain("/work/mircli");
    expect(digest.html).toContain("/work/antwerp");
    expect(digest.html).toContain("https://t.me/c/123/700");
    expect(digest.html).toContain("MIR-10");
    expect(digest.html).toContain("2 дн.");
    expect(digest.html).toContain("разбор запущен");
    expect(digest.html).toContain("ожидает запуска");
    expect(digest.html).not.toContain("Тикет #3");
  });

  it("escapes workspace HTML and includes weekly usage and warnings", () => {
    const digest = renderInboxDigest([], [{
      workspace: "/work/<unsafe>",
      inputTokens: 800,
      cachedInputTokens: 200,
      outputTokens: 100,
      totalTokens: 900,
      turns: 2,
    }], { now, weeklyLimit: 1_000 });

    expect(digest.html).toContain("/work/&lt;unsafe&gt;");
    expect(digest.html).toContain("Всего: 900");
    expect(digest.html).toContain("90% недельного лимита");
  });
});

describe("sendInboxDigest", () => {
  it("omits message_thread_id when no digest topic is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await sendInboxDigest({
      token: "bot-token",
      chatId: -100123,
      html: "<b>digest</b>",
      fetchImpl,
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request).toEqual({
      chat_id: -100123,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text: "<b>digest</b>",
    });
  });

  it("splits a large digest into Telegram-sized messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const html = Array.from({ length: 200 }, (_, index) => `• ticket ${index} ${"x".repeat(30)}`).join("\n");

    await sendInboxDigest({ token: "bot-token", chatId: -100123, html, fetchImpl });

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchImpl.mock.calls) {
      const request = JSON.parse(String(call[1]?.body));
      expect(request.text.length).toBeLessThanOrEqual(3_900);
    }
  });
});
