import { transitionJob } from "../src/telegram-job-transition.js";
import type { TelegramJob, TelegramJobEvent } from "../src/telegram-job-types.js";

const START = 1_700_000_000_000;

function transitionFixture(): TelegramJob {
  return {
    schemaVersion: 1, id: "transition", version: 7, source: { botId: "bot", updateId: 1 }, attachments: [],
    phase: "delivering", health: "quiet", activity: "tool",
    attention: { kind: "required", code: "KEEP", actions: ["inspect"] }, outcome: null,
    dispatchId: "dispatch-1", threadId: "thread-1", turnId: "turn-1",
    responsePlan: [{ partId: "final:0000", kind: "final" }],
    deliveries: [{ partId: "final:0000", state: "sending", attempts: 2, messageId: null, deliveredAt: null }],
    acceptedAt: START, updatedAt: START, terminalAt: null, dismissedAt: null, retainUntil: null,
  };
}

function applyEvent(previous: TelegramJob, event: TelegramJobEvent): TelegramJob {
  const result = transitionJob(previous, event);
  if (result.kind === "conflict") throw new Error(result.code);
  return result.job;
}

describe("delivery.replanned event", () => {
  const responsePlan = [{ partId: "final:0000:fallback:0000", kind: "final" }] as const;
  const deliveries = [{
    partId: "final:0000:fallback:0000", state: "pending", attempts: 0, messageId: null, deliveredAt: null,
  }] as const;
  const valid = {
    schemaVersion: 1 as const, type: "delivery.replanned" as const, phase: "delivering" as const,
    reasonCode: "rich_local_fallback" as const, responsePlan, deliveries, eventAt: START + 1,
  };

  it("changes only responsePlan, deliveries, updatedAt, and version", () => {
    const previous = transitionFixture();
    expect(applyEvent(previous, valid)).toEqual({
      ...previous, responsePlan, deliveries, updatedAt: START + 1, version: 8,
    });
  });

  it("rejects replan unless the current phase is already delivering", () => {
    const previous = { ...transitionFixture(), phase: "running" as const };
    const snapshot = structuredClone(previous);
    expect(() => applyEvent(previous, valid)).toThrowError(expect.objectContaining({ code: "INVALID_EVENT_PHASE" }));
    expect(previous).toEqual(snapshot);
  });

  it("rejects invalid keys, reason codes, phases, metadata, and missing projections", () => {
    for (const invalid of [
      { ...valid, reasonCode: "telegram_rejected" },
      { ...valid, phase: "terminal" },
      { ...valid, health: "stalled" },
      { ...valid, identifiers: { turnId: "changed" } },
      { ...valid, outcome: "failed" },
      { ...valid, unknown: true },
      { ...valid, responsePlan: undefined },
      { ...valid, deliveries: undefined },
    ]) {
      expect(() => applyEvent(transitionFixture(), invalid as unknown as TelegramJobEvent)).toThrowError(
        expect.objectContaining({ code: invalid.phase === "terminal" ? "INVALID_EVENT_PHASE" : "INVALID_EVENT_SHAPE" }),
      );
    }
    for (const missing of ["reasonCode", "responsePlan", "deliveries"] as const) {
      const invalid = { ...valid } as Record<string, unknown>;
      delete invalid[missing];
      expect(() => applyEvent(transitionFixture(), invalid as unknown as TelegramJobEvent)).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT_SHAPE" }),
      );
    }
  });

  it("rejects oversized, length-mismatched, and reordered replacement projections", () => {
    const oversizedPlan = Array.from({ length: 513 }, (_, index) => ({
      partId: `final:${String(index).padStart(4, "0")}`, kind: "final" as const,
    }));
    const oversizedDeliveries = oversizedPlan.map(({ partId }) => ({
      partId, state: "pending" as const, attempts: 0, messageId: null, deliveredAt: null,
    }));
    for (const invalid of [
      { ...valid, responsePlan: oversizedPlan, deliveries: oversizedDeliveries },
      { ...valid, deliveries: [] },
      { ...valid, responsePlan: [
        { partId: "final:0000:fallback:0000", kind: "final" as const },
        { partId: "final:0000:fallback:0001", kind: "final" as const },
      ], deliveries: [
        { ...deliveries[0]!, partId: "final:0000:fallback:0001" },
        deliveries[0]!,
      ] },
    ]) {
      expect(() => applyEvent(transitionFixture(), invalid as TelegramJobEvent)).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT_SHAPE" }),
      );
    }
  });
});
