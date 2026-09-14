import { TelegramDeliveryApiError } from "../src/telegram-delivery-outbox.js";
import { missingStatusAnchorSendPayload, replaceMissingStatusAnchorEditValues } from "../src/telegram-status-anchor-ledger.js";
import { hashTelegramDeliveryPayload, type TelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import { TelegramReliabilityFixture } from "./telegram-reliability-fixtures.js";

describe("missing rich final anchor", () => {
  let fixture: TelegramReliabilityFixture;
  beforeEach(() => { fixture = new TelegramReliabilityFixture(); });
  afterEach(() => { fixture.close(); });

  function install() {
    const worker = fixture.outbox({
      statusDestination: () => ({ chatId: -100_001, messageThreadId: 7 }),
    });
    const job = fixture.delivering("missing-rich-anchor", [
      { kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" },
    ]);
    worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
    const original = fixture.store.listDeliveries(job.id)[0]!;
    return { worker, job, original };
  }

  it("replaces a definitively missing rich final with the same content and rebound fallback", async () => {
    const { worker, job, original } = install();
    fixture.telegram.behavior = async payload => {
      if (payload.operation === "edit_rich") throw new TelegramDeliveryApiError("message_missing");
      return { messageId: 902 };
    };
    await worker.pump();

    expect(fixture.telegram.calls.map(call => call.payload.operation)).toEqual(["edit_rich", "send_rich"]);
    const before = original.payload as Extract<TelegramDeliveryPayload, { operation: "edit_rich" }>;
    const replacement = fixture.telegram.calls[1]!.payload;
    expect(replacement).toEqual({
      operation: "send_rich", chatId: before.chatId, messageThreadId: 7,
      markdown: before.markdown, media: before.media,
      fallbackParts: before.fallbackParts.map(part => ({
        ...part, payload: { operation: "send_text", chatId: before.chatId, messageThreadId: 7,
          text: (part.payload as { text: string }).text },
      })),
    });
    const delivered = fixture.store.listDeliveries(job.id)[0]!;
    expect(delivered).toMatchObject({ state: "delivered", telegramMessageId: 902, payload: replacement });
    expect(fixture.store.getStatusAnchorPlan(job.id)).toEqual({ payload: replacement, contentHash: delivered.contentHash });
    expect(fixture.store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("contains an ambiguous replacement send without retrying or completing the final", async () => {
    const { worker, job } = install();
    fixture.telegram.behavior = async payload => {
      if (payload.operation === "edit_rich") throw new TelegramDeliveryApiError("message_missing");
      throw new Error("connection lost after send");
    };
    await worker.pump();
    await worker.pump();
    expect(fixture.telegram.calls.map(call => call.payload.operation)).toEqual(["edit_rich", "send_rich"]);
    expect(fixture.store.listDeliveries(job.id)[0]).toMatchObject({
      state: "uncertain", telegramMessageId: null, lastErrorCode: "telegram_send_uncertain",
    });
    expect(fixture.store.get(job.id)).toMatchObject({ phase: "delivering", outcome: null });
  });

  it("delivers the rebound fallback when Telegram rejects the replacement rich representation", async () => {
    const { worker, job } = install();
    fixture.telegram.behavior = async payload => {
      if (payload.operation === "edit_rich") throw new TelegramDeliveryApiError("message_missing");
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      return { messageId: 903 };
    };
    await worker.pump();
    expect(fixture.telegram.calls.map(call => call.payload.operation)).toEqual(["edit_rich", "send_rich", "send_text"]);
    expect(fixture.telegram.calls[2]!.payload).toMatchObject({
      operation: "send_text", chatId: -100_001, messageThreadId: 7,
    });
    expect(fixture.store.get(job.id)).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it.each(["lease", "hash", "attempt", "message", "markdown", "media", "fallback"] as const)(
    "rejects replacement with changed %s evidence without modifying the durable plan", mismatch => {
      const { job, original } = install();
      const payload = original.payload as Extract<TelegramDeliveryPayload, { operation: "edit_rich" }>;
      const current = { ...original, state: "sending" as const, nextAttemptAt: fixture.now + 30_000 };
      const replacement = missingStatusAnchorSendPayload(payload, 7) as Extract<TelegramDeliveryPayload, { operation: "send_rich" }>;
      const input = {
        jobId: job.id, expectedAttemptCount: current.attemptCount,
        expectedContentHash: current.contentHash, expectedLeaseUntil: current.nextAttemptAt,
        expectedMessageId: 501, replacementPayload: replacement, updatedAt: fixture.now,
      };
      if (mismatch === "lease") input.expectedLeaseUntil++;
      if (mismatch === "hash") input.expectedContentHash = "a".repeat(64);
      if (mismatch === "attempt") input.expectedAttemptCount++;
      if (mismatch === "message") input.expectedMessageId++;
      if (mismatch === "markdown") input.replacementPayload = { ...replacement, markdown: "different answer" };
      if (mismatch === "media") input.replacementPayload = { ...replacement, media: [{ id: "image", path: "image.png" }] };
      if (mismatch === "fallback") input.replacementPayload = { ...replacement, fallbackParts: replacement.fallbackParts.map(part => ({
        ...part, payload: { operation: "send_text", chatId: -100_001, messageThreadId: 8, text: "wrong topic" },
      })) };
      const plan = fixture.store.getStatusAnchorPlan(job.id);
      expect(() => replaceMissingStatusAnchorEditValues(input, current)).toThrow();
      expect(fixture.store.getStatusAnchorPlan(job.id)).toEqual(plan);
    },
  );

  it("preserves rich media in the validated replacement", () => {
    const { job, original } = install();
    const payload = { ...(original.payload as Extract<TelegramDeliveryPayload, { operation: "edit_rich" }>),
      media: [{ id: "image", path: "image.png" }] };
    const current = { ...original, payload, contentHash: hashTelegramDeliveryPayload(payload),
      state: "sending" as const, nextAttemptAt: fixture.now + 30_000 };
    const replacement = replaceMissingStatusAnchorEditValues({
      jobId: job.id, expectedAttemptCount: current.attemptCount, expectedContentHash: current.contentHash,
      expectedLeaseUntil: current.nextAttemptAt, expectedMessageId: 501,
      replacementPayload: missingStatusAnchorSendPayload(payload, 7), updatedAt: fixture.now,
    }, current);
    expect(replacement.payload).toMatchObject({ operation: "send_rich", media: payload.media });
  });
});
