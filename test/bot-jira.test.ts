import { describe, expect, it, vi } from "vitest";

import { registerCommands } from "../src/bot.js";

describe("TeleCodex Jira command", () => {
  it("registers /jira in the Telegram command menu", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "jira", description: "Спринт Jira и фильтры" },
    ]));
  });
});
