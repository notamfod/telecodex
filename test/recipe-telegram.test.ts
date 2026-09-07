import { describe, expect, it, vi } from "vitest";

import type { ReviewRecipe } from "../src/recipe-config.js";
import { sendRecipeMessage } from "../src/recipe-telegram.js";

const recipe: ReviewRecipe = {
  id: "daily",
  cwd: "/repo",
  baseRef: "origin/main",
  promptFile: "recipes/daily.md",
  paths: [],
  deliver: { chatId: -100123, messageThreadId: 42 },
};

describe("sendRecipeMessage", () => {
  it("honors Telegram retry_after and retries only the failed message", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 39 },
      }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await sendRecipeMessage(recipe, "hello", undefined, {
      token: "bot-token",
      fetch,
      sleep,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(39_000);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
  });

  it("does not wait for an excessive Telegram retry_after", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      parameters: { retry_after: 90 },
    }), { status: 429 }));
    const sleep = vi.fn();

    await expect(sendRecipeMessage(recipe, "hello", undefined, {
      token: "bot-token",
      fetch,
      sleep,
    })).rejects.toThrow(/429/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
