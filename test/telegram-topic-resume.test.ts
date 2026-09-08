import { createHash } from "node:crypto";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";
import type { DeliveryPart, TelegramJob } from "../src/telegram-job-store.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import { planTelegramTopicResume } from "../src/telegram-topic-resume.js";
import type { TelegramTopicRecoveryRecord } from "../src/telegram-topic-recovery-ledger.js";

const DESTINATION = { chatId: -100123, messageThreadId: 41 } as const;
const THREAD_ID = "018f0000-0000-7000-8000-000000000001";

interface Fixture {
  job: TelegramJob;
  source: TelegramWorkSource;
  deliveries: DeliveryPart[];
  anchorPlan: { payload: unknown; contentHash: string } | null;
  thread: CodexThreadRecord | null;
  recovery: TelegramTopicRecoveryRecord | null;
  hasExistingAttempt: boolean;
  forumChatId: number;
  hasThreadTopicBinding: boolean;
  quarantined: boolean;
}

function fixture(): Fixture {
  const anchor = { operation: "send_text" as const, ...DESTINATION, text: "Response follows." };
  const rich = {
    operation: "send_rich" as const,
    ...DESTINATION,
    markdown: "# Result",
    media: [],
    fallbackParts: [{
      partKey: "final:0000:fallback:0000",
      kind: "final" as const,
      payload: { operation: "send_text" as const, ...DESTINATION, text: "Result" },
    }],
  };
  const notice = { operation: "send_text" as const, ...DESTINATION, text: "Notice" };
  return {
    job: {
      schemaVersion: 1,
      version: 541,
      id: "job-1",
      source: { botId: "bot", updateId: 1 },
      attachments: [],
      phase: "delivering",
      health: "healthy",
      activity: "unknown",
      attention: { kind: "required", code: "TOPIC_RECOVERY_FAILED", actions: ["inspect"] },
      outcome: null,
      dispatchId: "dispatch-1",
      threadId: THREAD_ID,
      turnId: "turn-1",
      responsePlan: [
        { partId: "final:0000", kind: "final" },
        { partId: "notice:0001", kind: "notice" },
      ],
      deliveries: [
        { partId: "final:0000", state: "pending", attempts: 0, messageId: null, deliveredAt: null },
        { partId: "notice:0001", state: "pending", attempts: 0, messageId: null, deliveredAt: null },
      ],
      acceptedAt: 1,
      updatedAt: 541,
      terminalAt: null,
      dismissedAt: null,
      retainUntil: null,
    },
    source: {
      botId: "bot",
      updateId: 1,
      ...DESTINATION,
      messageId: 1,
      kind: "text",
      text: "request",
      attachment: null,
      retryOfJobId: null,
    },
    deliveries: [
      row("status-anchor", 0, "status-anchor", "failed", anchor, {
        attemptCount: 1,
        lastErrorCode: "telegram_permanent",
      }),
      row("final:0000", 0, "final", "pending", rich),
      row("notice:0001", 1, "notice", "pending", notice),
    ],
    anchorPlan: { payload: anchor, contentHash: hashTelegramDeliveryPayload(anchor) },
    thread: {
      id: THREAD_ID,
      title: "Resume topic",
      cwd: "/work/telecodex",
      model: null,
      modelProvider: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      firstUserMessage: "request",
    },
    recovery: {
      jobId: "job-1",
      actionToken: "a".repeat(64),
      state: "failed",
      oldDestination: DESTINATION,
      newMessageThreadId: null,
      reservedJobVersion: 539,
      currentJobVersion: 541,
      nextAttemptAt: null,
      reasonCode: "TOPIC_RECOVERY_FAILED",
      startedAt: 539,
      updatedAt: 541,
    },
    hasExistingAttempt: false,
    forumChatId: DESTINATION.chatId,
    hasThreadTopicBinding: true,
    quarantined: false,
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
    jobId: "job-1",
    partKey,
    ordinal,
    kind,
    state,
    payload,
    contentHash: hashTelegramDeliveryPayload(payload),
    telegramMessageId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    updatedAt: 541,
    ...overrides,
  };
}

describe("Telegram existing topic resume eligibility", () => {
  it("returns the exact candidate for the failed historical replacement recovery", () => {
    expect(planTelegramTopicResume(fixture())).toEqual({
      jobId: "job-1",
      expectedVersion: 541,
      threadId: THREAD_ID,
      destination: DESTINATION,
      anchorPartKey: "status-anchor",
      anchorAttemptCount: 1,
    });
  });

  it("rejects an otherwise valid failed anchor whose attempt count is not exactly one", () => {
    const input = fixture();
    input.deliveries[0] = { ...input.deliveries[0]!, attemptCount: 2 };
    const before = structuredClone(input);

    expect(planTelegramTopicResume(input)).toBeNull();
    expect(input).toEqual(before);
  });

  it.each([
    ["non-failed recovery", (value: Fixture) => { value.recovery = { ...value.recovery!, state: "unknown", reasonCode: "TOPIC_RECOVERY_UNKNOWN" }; }],
    ["recovery with a new topic", (value: Fixture) => { value.recovery = { ...value.recovery!, newMessageThreadId: 42 }; }],
    ["recovery destination mismatch", (value: Fixture) => { value.recovery = { ...value.recovery!, oldDestination: { ...DESTINATION, messageThreadId: 42 } }; }],
    ["stale recovery version", (value: Fixture) => { value.recovery = { ...value.recovery!, currentJobVersion: 540 }; }],
    ["existing resume row", (value: Fixture) => { value.hasExistingAttempt = true; }],
    ["quarantined job", (value: Fixture) => { value.quarantined = true; }],
    ["missing binding", (value: Fixture) => { value.hasThreadTopicBinding = false; }],
    ["forum mismatch", (value: Fixture) => { value.forumChatId = -100124; }],
    ["missing thread", (value: Fixture) => { value.thread = null; }],
    ["malformed source", (value: Fixture) => { value.source = { ...value.source, messageThreadId: null } as TelegramWorkSource; }],
    ["missing anchor plan", (value: Fixture) => { value.anchorPlan = null; }],
    ["mismatched anchor plan", (value: Fixture) => { value.anchorPlan = { ...value.anchorPlan!, contentHash: "0".repeat(64) }; }],
    ["non-failed anchor", (value: Fixture) => { value.deliveries[0] = { ...value.deliveries[0]!, state: "pending" }; }],
    ["known anchor message", (value: Fixture) => { value.deliveries[0] = { ...value.deliveries[0]!, telegramMessageId: 5 }; }],
    ["delivered follower", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, state: "delivered", telegramMessageId: 6 }; }],
    ["sending follower", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, state: "sending" }; }],
    ["uncertain follower", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, state: "uncertain" }; }],
    ["missing follower", (value: Fixture) => { value.deliveries.pop(); }],
    ["extra follower", (value: Fixture) => { value.deliveries.push(row("summary:0002", 2, "summary", "pending", { operation: "send_text", ...DESTINATION, text: "extra" })); }],
    ["self-consistent one-follower plan", (value: Fixture) => {
      value.job = { ...value.job, responsePlan: value.job.responsePlan!.slice(0, 1), deliveries: value.job.deliveries.slice(0, 1) };
      value.deliveries = value.deliveries.slice(0, 2);
    }],
    ["self-consistent three-follower plan", (value: Fixture) => {
      const payload = { operation: "send_text" as const, ...DESTINATION, text: "Summary" };
      value.job = {
        ...value.job,
        responsePlan: [...value.job.responsePlan!, { partId: "summary:0002", kind: "summary" }],
        deliveries: [...value.job.deliveries, {
          partId: "summary:0002", state: "pending", attempts: 0, messageId: null, deliveredAt: null,
        }],
      };
      value.deliveries.push(row("summary:0002", 2, "summary", "pending", payload));
    }],
    ["mixed primary destination", (value: Fixture) => {
      const payload = { operation: "send_text" as const, ...DESTINATION, messageThreadId: 42, text: "Notice" };
      value.deliveries[2] = row("notice:0001", 1, "notice", "pending", payload);
    }],
    ["mixed rich fallback destination", (value: Fixture) => {
      const payload = structuredClone(value.deliveries[1]!.payload) as {
        fallbackParts: Array<{ payload: { messageThreadId: number } }>;
      };
      payload.fallbackParts[0]!.payload.messageThreadId = 42;
      value.deliveries[1] = {
        ...value.deliveries[1]!, payload,
        contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      };
    }],
  ])("rejects %s without mutating its input", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    const before = structuredClone(input);

    expect(planTelegramTopicResume(input)).toBeNull();
    expect(input).toEqual(before);
  });
});
