import { describe, expect, it, vi } from "vitest";

import { registerCommands } from "../src/bot.js";

describe("TeleCodex command menu", () => {
  it("registers /tickets for unresolved ticket navigation", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "tickets", description: "List unresolved inbox tickets" },
    ]));
  });
});
