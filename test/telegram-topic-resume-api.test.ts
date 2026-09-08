import { GrammyError, type ApiClientOptions } from "grammy";
import { vi } from "vitest";

import { createTelegramTopicResumeApi } from "../src/telegram-topic-resume-api.js";

describe("retry-free topic resume API", () => {
  it.each([
    {
      method: "sendChatAction" as const,
      invoke: (api: ReturnType<typeof createTelegramTopicResumeApi>, signal: AbortSignal) =>
        api.sendChatAction(-1001, "typing", { message_thread_id: 41 }, signal),
      body: { chat_id: -1001, action: "typing", message_thread_id: 41 },
    },
    {
      method: "reopenForumTopic" as const,
      invoke: (api: ReturnType<typeof createTelegramTopicResumeApi>, signal: AbortSignal) =>
        api.reopenForumTopic(-1001, 41, signal),
      body: { chat_id: -1001, message_thread_id: 41 },
    },
  ])("propagates the original $method 429 after one HTTP request", async ({
    method, invoke, body,
  }) => {
    const response = {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 1 },
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 429 }),
    );
    const api = createTelegramTopicResumeApi("123:test", {
      fetch: fetch as ApiClientOptions["fetch"],
    });

    const failure = await invoke(api, new AbortController().signal).catch((error) => error);

    expect(failure).toBeInstanceOf(GrammyError);
    expect(failure).toMatchObject({
      error_code: response.error_code,
      description: response.description,
      parameters: response.parameters,
      method,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(new URL(url).pathname.endsWith(`/${method}`)).toBe(true);
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toEqual(body);
  });
});
