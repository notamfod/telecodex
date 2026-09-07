import { vi } from "vitest";

import { inspectTelegramExactTurn } from "../src/telegram-exact-turn-inspector.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const TURN = "turn-exact";

describe("inspectTelegramExactTurn", () => {
  it.each([
    ["inProgress", "active"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["interrupted", "failed"],
    ["cancelled", "failed"],
  ] as const)("classifies the one exact %s turn as %s", async (status, state) => {
    const request = vi.fn(async () => ({ thread: {
      id: THREAD, turns: [{ id: "older", status: "completed" }, { id: TURN, status }],
    } }));

    await expect(inspectTelegramExactTurn({ request }, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual({ state });
    expect(request).toHaveBeenCalledWith("thread/read", { threadId: THREAD, includeTurns: true });
  });

  it("distinguishes absent and duplicate exact turn identities", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ thread: { id: THREAD, turns: [{ id: "other", status: "completed" }] } })
      .mockResolvedValueOnce({ thread: { id: THREAD, turns: [
        { id: TURN, status: "completed" }, { id: TURN, status: "completed" },
      ] } });

    await expect(inspectTelegramExactTurn({ request }, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual({ state: "absent" });
    await expect(inspectTelegramExactTurn({ request }, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual({ state: "ambiguous" });
  });

  it("fails closed on mismatched or malformed thread/read responses", async () => {
    for (const response of [
      { thread: { id: "different", turns: [] } },
      { thread: { id: THREAD, turns: "not-an-array" } },
      { thread: { id: THREAD, turns: [{ id: TURN, status: 42 }] } },
    ]) {
      const request = vi.fn(async () => response);
      await expect(inspectTelegramExactTurn({ request }, { threadId: THREAD, turnId: TURN }))
        .rejects.toThrow("Invalid thread/read response");
    }
  });

  it("keeps an unknown exact status ambiguous", async () => {
    const request = vi.fn(async () => ({ thread: {
      id: THREAD, turns: [{ id: TURN, status: "future-status" }],
    } }));

    await expect(inspectTelegramExactTurn({ request }, { threadId: THREAD, turnId: TURN }))
      .resolves.toEqual({ state: "ambiguous" });
  });

  it("never invokes a write method", async () => {
    const request = vi.fn(async () => ({ thread: { id: THREAD, turns: [] } }));
    await inspectTelegramExactTurn({ request }, { threadId: THREAD, turnId: TURN });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
  });
});
