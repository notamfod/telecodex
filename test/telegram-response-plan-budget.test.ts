import { performance } from "node:perf_hooks";

import { buildTelegramResponsePlan } from "../src/telegram-response-plan.js";
import type { TelegramTurnResult } from "../src/telegram-turn-result.js";

const destination = { chatId: -1001, messageThreadId: 77, anchorMessageId: 501 };

function textResult(text: string): TelegramTurnResult {
  return { schemaVersion: 1, content: [{ kind: "text", text }] };
}

describe("Telegram response delivery budgets", () => {
  it("plans one million plain characters within the delivery part budget", () => {
    const started = performance.now();
    const plan = buildTelegramResponsePlan({ result: textResult("x".repeat(1_000_000)), destination });

    expect(performance.now() - started).toBeLessThan(10_000);
    expect(plan.parts.length).toBeLessThanOrEqual(512);
    expect(plan.parts).toHaveLength(334);
  });

  it("rejects a many-item oversized source before combined rich rendering", () => {
    const result: TelegramTurnResult = {
      schemaVersion: 1,
      content: Array.from({ length: 42 }, () => ({ kind: "text", text: "x".repeat(1_000_000) })),
    };
    const started = performance.now();

    expect(() => buildTelegramResponsePlan({ result, destination }))
      .toThrow("Telegram response plan exceeds delivery budget");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("enforces the actual output part cap after HTML expansion", () => {
    expect(() => buildTelegramResponsePlan({
      result: textResult("<".repeat(600_000)),
      destination,
    })).toThrow("Telegram response plan exceeds delivery budget");
  });
});
