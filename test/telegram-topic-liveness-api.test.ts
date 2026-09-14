import { GrammyError, type ApiClientOptions } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { createTelegramTopicLivenessApi } from "../src/telegram-topic-liveness-api.js";
import { createForumTopicLivenessProbe } from "../src/telegram-topic-liveness.js";

describe("retry-free topic liveness API", () => {
  it("propagates the original Telegram 429 after exactly one HTTP request", async () => {
    const response = {
      ok: false, error_code: 429, description: "Too Many Requests: retry after 1",
      parameters: { retry_after: 1 },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 429 }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true })));
    const api = createTelegramTopicLivenessApi("123:test", {
      fetch: fetch as ApiClientOptions["fetch"],
    });
    const probe = createForumTopicLivenessProbe(api);

    const failure = await probe({ chatId: -1001, messageThreadId: 41 }).catch((error) => error);

    expect(failure).toBeInstanceOf(GrammyError);
    expect(failure).toMatchObject({
      error_code: response.error_code, description: response.description,
      parameters: response.parameters, method: "sendChatAction",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(new URL(url).pathname.endsWith("/sendChatAction")).toBe(true);
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toEqual({
      chat_id: -1001, action: "typing", message_thread_id: 41,
    });
    // A later explicit probe can succeed; the failed request was never retried or cached.
    await expect(probe({ chatId: -1001, messageThreadId: 41 })).rejects.toThrow("Telegram topic availability is unknown");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
