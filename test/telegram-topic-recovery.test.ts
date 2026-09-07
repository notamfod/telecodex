import { isDeepStrictEqual } from "node:util";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";
import type { DeliveryPart, TelegramJob } from "../src/telegram-job-store.js";
import {
  hashTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
} from "../src/telegram-response-plan.js";
import { buildTopicName } from "../src/topic-sync.js";
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
    const candidate = planTelegramTopicRecovery(input);

    expect(candidate).toEqual({
      jobId: "job-1", expectedVersion: 9, threadId: "thread-1", topicName: buildTopicName(input.thread),
      oldDestination: OLD,
      parts: [
        expect.objectContaining({ partKey: "final:0000", payload: expect.objectContaining(OLD) }),
        expect.objectContaining({ partKey: "attachment:0001", payload: expect.objectContaining(OLD) }),
        expect.objectContaining({ partKey: "summary:0002", payload: expect.objectContaining(OLD) }),
      ],
      anchorPlan: expect.objectContaining({ partKey: "status-anchor", payload: expect.objectContaining(OLD) }),
    });
    expect(candidate?.parts[0].payload).toMatchObject({ fallbackParts: [{ payload: OLD }] });
    expect(candidate?.parts.map((part) => part.contentHash)).toEqual(candidate?.parts.map((part) => hashTelegramDeliveryPayload(part.payload)));
    expect(input).toEqual(before);
  });

  test("uses the durable target context when the historical source points to a control topic", () => {
    const input = fixture();
    input.source = source({ chatId: -2001, messageThreadId: 3, targetContext: OLD });

    expect(planTelegramTopicRecovery(input)?.oldDestination).toEqual(OLD);
  });

  test.each([
    ["stale phase", (value: ReturnType<typeof fixture>) => { value.job = job({ phase: "running" }); }],
    ["missing thread", (value: ReturnType<typeof fixture>) => { value.thread = null as unknown as CodexThreadRecord; }],
    ["mismatched thread", (value: ReturnType<typeof fixture>) => { value.thread = thread({ id: "other" }); }],
    ["absent response plan", (value: ReturnType<typeof fixture>) => { value.job = job({ responsePlan: undefined }); }],
    ["target provisioning", (value: ReturnType<typeof fixture>) => { value.source = source({ targetProvision: { kind: "forum_topic", topicName: "new", state: "planned" } }); }],
    ["non-pending response", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], state: "sending" }; }],
    ["delivered response", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], state: "delivered", telegramMessageId: 4 }; }],
    ["uncertain response", (value: ReturnType<typeof fixture>) => { value.deliveries[1] = { ...value.deliveries[1], state: "uncertain" }; }],
    ["missing response", (value: ReturnType<typeof fixture>) => { value.deliveries.pop(); }],
    ["extra response", (value: ReturnType<typeof fixture>) => { value.deliveries.push(row("notice:0003", 3, "notice", "pending", { operation: "send_text", ...OLD, text: "extra" })); }],
    ["duplicate response", (value: ReturnType<typeof fixture>) => { value.deliveries.push({ ...value.deliveries[1] }); }],
    ["non-failed anchor", (value: ReturnType<typeof fixture>) => { value.deliveries[0] = { ...value.deliveries[0], state: "pending" }; }],
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
  ])("rejects %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(planTelegramTopicRecovery(input)).toBeNull();
  });

  test.each([
    [{ operation: "send_text", ...OLD, text: "text" }],
    [{ operation: "send_media", ...OLD, mediaKind: "image", path: "outputs/chart.png", caption: "chart" }],
    [{ operation: "send_rich", ...OLD, markdown: "# rich", media: [], fallbackParts: [{ partKey: "final:0000:fallback:0000", kind: "final", payload: { operation: "send_text", ...OLD, text: "fallback" } }] }],
  ] as const)("rebinds %s payloads without mutation", (payload) => {
    const before = structuredClone(payload);
    const rebound = rebindTelegramTopicPayload(payload, OLD, NEW);
    expect(rebound.payload).toMatchObject(NEW);
    expect(rebound.contentHash).toBe(hashTelegramDeliveryPayload(rebound.payload));
    expect(payload).toEqual(before);
    expect(isDeepStrictEqual(payload, before)).toBe(true);
  });

  test("rewrites every rich fallback and rejects invalid direct arguments", () => {
    const payload = fixture().deliveries[1].payload as TelegramDeliveryPayload;
    const rebound = rebindTelegramTopicPayload(payload, OLD, NEW);
    expect(rebound.payload).toMatchObject({ ...NEW, fallbackParts: [{ payload: NEW }] });
    expect(() => rebindTelegramTopicPayload({ operation: "edit_text", chatId: -1001, messageId: 1, text: "edit" }, OLD, NEW))
      .toThrow("Invalid Telegram topic recovery payload");
    expect(() => rebindTelegramTopicPayload(payload, NEW, OLD)).toThrow("Invalid Telegram topic recovery payload");
  });
});
