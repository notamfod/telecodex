import { isDeepStrictEqual } from "node:util";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";
import type { DeliveryPart, TelegramJob } from "../src/telegram-job-store.js";
import {
  hashTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
} from "../src/telegram-response-plan.js";
import {
  planTelegramTopicRecovery,
  rebindTelegramTopicPayload,
} from "../src/telegram-topic-recovery.js";

const OLD = { chatId: -1001, messageThreadId: 7 } as const;
const NEW = { chatId: -1002, messageThreadId: 8 } as const;

function thread(overrides: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  return {
    id: "thread-1", title: "Recover topic", cwd: "/work/telecodex", model: null, modelProvider: null,
    createdAt: new Date(0), updatedAt: new Date(0), firstUserMessage: "recover", ...overrides,
  };
}

function source(overrides: Partial<TelegramWorkSource> = {}): TelegramWorkSource {
  return {
    botId: "bot", updateId: 1, ...OLD, messageId: 42, kind: "text", text: "recover", attachment: null,
    retryOfJobId: null, ...overrides,
  };
}

function job(overrides: Partial<TelegramJob> = {}): TelegramJob {
  return {
    schemaVersion: 1, version: 9, id: "job-1", source: { botId: "bot", updateId: 1 }, attachments: [],
    phase: "delivering", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: "dispatch-1", threadId: "thread-1", turnId: "turn-1",
    responsePlan: [
      { partId: "final:0000", kind: "final" },
      { partId: "attachment:0001", kind: "attachment" },
      { partId: "summary:0002", kind: "summary" },
    ],
    deliveries: [
      { partId: "final:0000", state: "pending", attempts: 0, messageId: null, deliveredAt: null },
      { partId: "attachment:0001", state: "pending", attempts: 0, messageId: null, deliveredAt: null },
      { partId: "summary:0002", state: "pending", attempts: 0, messageId: null, deliveredAt: null },
    ],
    acceptedAt: 1, updatedAt: 2, terminalAt: null, dismissedAt: null, retainUntil: null, ...overrides,
  };
}

function row(
  partKey: string,
  ordinal: number,
  kind: string,
  state: DeliveryPart["state"],
  payload: unknown,
  overrides: Partial<DeliveryPart> = {},
): DeliveryPart {
  return {
    jobId: "job-1", partKey, ordinal, kind, state, payload, contentHash: hashTelegramDeliveryPayload(payload),
    telegramMessageId: null, attemptCount: state === "failed" ? 1 : 0,
    nextAttemptAt: null, lastErrorCode: state === "failed" ? "telegram_topic_missing" : null, updatedAt: 3,
    ...overrides,
  };
}

function fixture(): {
  job: TelegramJob;
  source: TelegramWorkSource;
  thread: CodexThreadRecord;
  deliveries: DeliveryPart[];
  anchorPlan: { payload: unknown; contentHash: string };
} {
  const anchor = { operation: "send_text" as const, ...OLD, text: "Response follows." };
  const rich: TelegramDeliveryPayload = {
    operation: "send_rich", ...OLD, markdown: "# Result", media: [], fallbackParts: [{
      partKey: "final:0000:fallback:0000", kind: "final",
      payload: { operation: "send_text", ...OLD, text: "Result" },
    }],
  };
  return {
    job: job(), source: source(), thread: thread(),
    deliveries: [
      row("status-anchor", 0, "status-anchor", "failed", anchor),
      row("final:0000", 0, "final", "pending", rich),
      row("attachment:0001", 1, "attachment", "pending", {
        operation: "send_media", ...OLD, mediaKind: "file", path: "outputs/result.pdf", name: "result.pdf",
      }),
      row("summary:0002", 2, "summary", "pending", { operation: "send_text", ...OLD, text: "Summary" }),
    ],
    anchorPlan: { payload: anchor, contentHash: hashTelegramDeliveryPayload(anchor) },
  };
}

describe("Telegram topic recovery", () => {
  test("plans a canonical failed-topic recovery with all response parts preserved for later rebinding", () => {
    const input = fixture();
    const before = structuredClone(input);
    const expectedAnchor = { operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: "Response follows." };
    const expectedFinal: TelegramDeliveryPayload = {
      operation: "send_rich", chatId: -1001, messageThreadId: 7, markdown: "# Result", media: [], fallbackParts: [{
        partKey: "final:0000:fallback:0000", kind: "final",
        payload: { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "Result" },
      }],
    };
    const expectedAttachment = {
      operation: "send_media" as const, chatId: -1001, messageThreadId: 7, mediaKind: "file" as const,
      path: "outputs/result.pdf", name: "result.pdf",
    };
    const expectedSummary = { operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: "Summary" };
    const candidate = planTelegramTopicRecovery(input);

    expect(hashTelegramDeliveryPayload(expectedAnchor)).toBe("52b78b4472ee8501450496c8e8d62a25df04a1b914d0526315bbfd7e9fb7e601");
    expect(hashTelegramDeliveryPayload(expectedFinal)).toBe("33f27a6e265acb08edff13defb04510e8b55375d76afaf28ea05ffb27aff0b5f");
    expect(hashTelegramDeliveryPayload(expectedAttachment)).toBe("0d0efac0224ca45e0bda56bbb248efabfc9b06cf2fafa277ef4efe601ce59d97");
    expect(hashTelegramDeliveryPayload(expectedSummary)).toBe("76c254c4f747d35b61b45c7b21ce03728fd28d645465543bdedfff17428def67");
    expect(candidate).toEqual({
      jobId: "job-1", expectedVersion: 9, threadId: "thread-1", topicName: "telecodex · Recover topic",
      oldDestination: { chatId: -1001, messageThreadId: 7 },
      parts: [
        { partKey: "final:0000", payload: expectedFinal, contentHash: "33f27a6e265acb08edff13defb04510e8b55375d76afaf28ea05ffb27aff0b5f" },
        { partKey: "attachment:0001", payload: expectedAttachment, contentHash: "0d0efac0224ca45e0bda56bbb248efabfc9b06cf2fafa277ef4efe601ce59d97" },
        { partKey: "summary:0002", payload: expectedSummary, contentHash: "76c254c4f747d35b61b45c7b21ce03728fd28d645465543bdedfff17428def67" },
      ],
      anchorPlan: {
        partKey: "status-anchor", payload: expectedAnchor,
        contentHash: "52b78b4472ee8501450496c8e8d62a25df04a1b914d0526315bbfd7e9fb7e601",
      },
    });
    expect(input).toEqual(before);
  });

  test("uses the durable target context when the historical source points to a control topic", () => {
    const input = fixture();
    input.source = source({ messageThreadId: 3, targetContext: OLD });

    expect(planTelegramTopicRecovery(input)?.oldDestination).toEqual(OLD);
  });

  test.each([
    ["stale phase", (value: ReturnType<typeof fixture>) => { value.job = job({ phase: "running" }); }],
    ["missing thread", (value: ReturnType<typeof fixture>) => { value.thread = null as unknown as CodexThreadRecord; }],
    ["mismatched thread", (value: ReturnType<typeof fixture>) => { value.thread = thread({ id: "other" }); }],
    ["absent response plan", (value: ReturnType<typeof fixture>) => { value.job = job({ responsePlan: undefined }); }],
    ["target provisioning", (value: ReturnType<typeof fixture>) => { value.source = source({ targetProvision: { kind: "forum_topic", topicName: "new", state: "planned" } }); }],
    ["source bot mismatch", (value: ReturnType<typeof fixture>) => { value.source = source({ botId: "other" }); }],
    ["source identity mismatch", (value: ReturnType<typeof fixture>) => { value.source = source({ updateId: 2 }); }],
    ["cross-chat target context", (value: ReturnType<typeof fixture>) => { value.source = source({ chatId: -2001, targetContext: OLD }); }],
    ["non-pending response", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], state: "sending" }; }],
    ["delivered response", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], state: "delivered", telegramMessageId: 4 }; }],
    ["uncertain response", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], state: "uncertain" }; }],
    ["missing response", (value: ReturnType<typeof fixture>) => { value.deliveries.pop(); }],
    ["extra response", (value: ReturnType<typeof fixture>) => { value.deliveries.push(row("notice:0003", 3, "notice", "pending", { operation: "send_text", ...OLD, text: "extra" })); }],
    ["duplicate response", (value: ReturnType<typeof fixture>) => { value.deliveries.push({ ...value.deliveries[1] }); }],
    ["non-failed anchor", (value: ReturnType<typeof fixture>) => { value.deliveries[0] = { ...value.deliveries[0], state: "pending" }; }],
    ["bad anchor kind", (value: ReturnType<typeof fixture>) => { value.deliveries[0] = { ...value.deliveries[0], kind: "final" }; }],
    ["anchor job mismatch", (value: ReturnType<typeof fixture>) => { value.deliveries[0] = { ...value.deliveries[0], jobId: "other" }; }],
    ["edit anchor", (value: ReturnType<typeof fixture>) => { const payload = { operation: "edit_text" as const, chatId: OLD.chatId, messageId: 4, text: "x" }; value.deliveries[0] = row("status-anchor", 0, "status-anchor", "failed", payload); value.anchorPlan = { payload, contentHash: hashTelegramDeliveryPayload(payload) }; }],
    ["known anchor message", (value: ReturnType<typeof fixture>) => { value.deliveries[0] = { ...value.deliveries[0], telegramMessageId: 4 }; }],
    ["missing anchor plan", (value: ReturnType<typeof fixture>) => { value.anchorPlan = null as unknown as ReturnType<typeof fixture>["anchorPlan"]; }],
    ["mismatched anchor plan", (value: ReturnType<typeof fixture>) => { value.anchorPlan = { payload: { operation: "send_text", ...OLD, text: "other" }, contentHash: value.anchorPlan.contentHash }; }],
    ["mixed primary destination", (value: ReturnType<typeof fixture>) => { const payload = { operation: "send_text" as const, chatId: OLD.chatId, messageThreadId: 99, text: "wrong" }; value.deliveries[3] = row("summary:0002", 2, "summary", "pending", payload); }],
    ["mixed rich fallback destination", (value: ReturnType<typeof fixture>) => { const payload = structuredClone(value.deliveries[1].payload) as any; payload.fallbackParts[0].payload.messageThreadId = 99; value.deliveries[1] = { ...value.deliveries[1], payload, contentHash: "0".repeat(64) }; }],
    ["invalid destination", (value: ReturnType<typeof fixture>) => { value.source = source({ messageThreadId: null }); }],
    ["malformed hash", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], contentHash: "0".repeat(64) }; }],
    ["malformed payload", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], payload: {}, contentHash: "0".repeat(64) }; }],
    ["noncanonical pending row", (value: ReturnType<typeof fixture>) => { value.deliveries[3] = { ...value.deliveries[3], attemptCount: 1 }; }],
    ["negative anchor updated time", (value: ReturnType<typeof fixture>) => { value.deliveries[0] = { ...value.deliveries[0], updatedAt: -1 }; }],
    ["negative follower updated time", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], updatedAt: -1 }; }],
    ["reordered job projection", (value: ReturnType<typeof fixture>) => { value.job = job({ deliveries: [...value.job.deliveries].reverse() }); }],
  ])("rejects %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(planTelegramTopicRecovery(input)).toBeNull();
  });

  test.each([
    [
      { operation: "send_text", ...OLD, text: "text", replyMarkup: { inlineKeyboard: [[{ text: "Retry", callbackData: "retry" }]] } },
      { operation: "send_text", ...NEW, text: "text", replyMarkup: { inlineKeyboard: [[{ text: "Retry", callbackData: "retry" }]] } },
    ],
    [
      { operation: "send_media", ...OLD, mediaKind: "image", path: "outputs/chart.png", caption: "chart" },
      { operation: "send_media", ...NEW, mediaKind: "image", path: "outputs/chart.png", caption: "chart" },
    ],
    [
      { operation: "send_rich", ...OLD, markdown: "# rich", media: [{ id: "generated_0001", path: "outputs/chart.png" }], fallbackParts: [{ partKey: "final:0000:fallback:0000", kind: "final", payload: { operation: "send_text", ...OLD, text: "fallback" } }] },
      { operation: "send_rich", ...NEW, markdown: "# rich", media: [{ id: "generated_0001", path: "outputs/chart.png" }], fallbackParts: [{ partKey: "final:0000:fallback:0000", kind: "final", payload: { operation: "send_text", ...NEW, text: "fallback" } }] },
    ],
  ] as const)("rebinds payloads exactly without mutation", (payload, expected) => {
    const before = structuredClone(payload);
    const rebound = rebindTelegramTopicPayload(payload, OLD, NEW);
    expect(rebound.payload).toEqual(expected);
    expect(rebound.contentHash).toBe(hashTelegramDeliveryPayload(rebound.payload));
    expect(payload).toEqual(before);
    expect(isDeepStrictEqual(payload, before)).toBe(true);
  });

  test("rewrites every rich fallback and rejects edit payloads", () => {
    const payload: TelegramDeliveryPayload = {
      operation: "send_rich", ...OLD, markdown: "# Result", media: [], fallbackParts: [
        { partKey: "final:0000:fallback:0000", kind: "final", payload: { operation: "send_text", ...OLD, text: "first" } },
        { partKey: "final:0000:fallback:0001", kind: "final", payload: { operation: "send_text", ...OLD, text: "second" } },
      ],
    };
    const rebound = rebindTelegramTopicPayload(payload, OLD, NEW);
    expect(rebound.payload).toEqual({
      operation: "send_rich", ...NEW, markdown: "# Result", media: [], fallbackParts: [
        { partKey: "final:0000:fallback:0000", kind: "final", payload: { operation: "send_text", ...NEW, text: "first" } },
        { partKey: "final:0000:fallback:0001", kind: "final", payload: { operation: "send_text", ...NEW, text: "second" } },
      ],
    });
    expect(() => rebindTelegramTopicPayload({ operation: "edit_text", chatId: -1001, messageId: 1, text: "edit" }, OLD, NEW))
      .toThrow("Invalid Telegram topic recovery payload");
    expect(() => rebindTelegramTopicPayload({
      operation: "edit_rich", chatId: -1001, messageId: 1, markdown: "# edit", media: [],
      fallbackParts: [{ partKey: "final:0000:fallback:0000", kind: "final", payload: { operation: "edit_text", chatId: -1001, messageId: 1, text: "edit" } }],
    }, OLD, NEW)).toThrow("Invalid Telegram topic recovery payload");
    expect(() => rebindTelegramTopicPayload(payload, NEW, OLD)).toThrow("Invalid Telegram topic recovery payload");
  });

  test("rejects plans beyond the runtime response-part limit", () => {
    const input = fixture();
    const responsePlan = Array.from({ length: 513 }, (_, index) => ({ partId: `final:${String(index).padStart(4, "0")}`, kind: "final" as const }));
    input.job = job({ responsePlan, deliveries: responsePlan.map((part) => ({ partId: part.partId, state: "pending", attempts: 0, messageId: null, deliveredAt: null })) });
    input.deliveries = [input.deliveries[0], ...responsePlan.map((part, index) => row(part.partId, index, "final", "pending", { operation: "send_text", ...OLD, text: part.partId }))];

    expect(planTelegramTopicRecovery(input)).toBeNull();
  });
});
