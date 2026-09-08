import { createHash } from "node:crypto";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";
import type { DeliveryPart, TelegramJob } from "../src/telegram-job-store.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import {
  hashTelegramTopicResumeTopology,
  isTelegramTopicResumeContinuationValid,
  planTelegramTopicResume,
} from "../src/telegram-topic-resume.js";
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
      mode: "standard",
      jobId: "job-1",
      expectedVersion: 541,
      threadId: THREAD_ID,
      destination: DESTINATION,
      anchorPartKey: "status-anchor",
      anchorAttemptCount: 1,
    });
  });

  it("returns warning mode with the exact historical attempt baseline and trailing recovery", () => {
    const input = fixture();
    input.deliveries[0] = { ...input.deliveries[0]!, attemptCount: 4 };
    input.recovery = { ...input.recovery!, currentJobVersion: 540 };
    const before = structuredClone(input);

    expect(planTelegramTopicResume(input)).toMatchObject({ mode: "warning_replay", anchorAttemptCount: 4 });
    expect(input).toEqual(before);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid warning baseline %s", (attemptCount) => {
    const input = fixture();
    input.deliveries[0] = { ...input.deliveries[0]!, attemptCount };
    expect(planTelegramTopicResume(input)).toBeNull();
  });

  it.each([null, [null]] as const)("fails closed for undecodable delivery evidence", (deliveries) => {
    const input = fixture();
    input.deliveries = deliveries as unknown as DeliveryPart[];
    expect(planTelegramTopicResume(input)).toBeNull();
  });

  it("validates warning continuation using the persisted trailing recovery version", () => {
    const input = fixture();
    input.deliveries[0] = { ...input.deliveries[0]!, attemptCount: 4 };
    input.recovery = { ...input.recovery!, currentJobVersion: 540 };
    const deliveryTopologyHash = hashTelegramTopicResumeTopology(input.job, input.deliveries);
    input.job = { ...input.job, version: 542 };
    input.hasExistingAttempt = true;
    expect(isTelegramTopicResumeContinuationValid({
      ...input, mode: "warning_replay", reservedJobVersion: 541, currentJobVersion: 542,
      anchorAttemptBaseline: 4, recoveryJobVersionBaseline: 540, deliveryTopologyHash,
    })).toBe(true);
  });

  it.each([1, 4])("preserves standard anchor formats but requires warning send_text (%s)", (baseline) => {
    const input = fixture();
    const payload = input.deliveries[1]!.payload;
    const contentHash = hashTelegramDeliveryPayload(payload);
    input.anchorPlan = { payload, contentHash };
    input.deliveries[0] = { ...input.deliveries[0]!, payload, contentHash, attemptCount: baseline };
    const candidate = planTelegramTopicResume(input);
    expect(candidate !== null).toBe(baseline === 1);
  });

  it("validates a standard continuation against the actual post-reservation job", () => {
    const input = fixture();
    const reservedJobVersion = input.job.version;
    const deliveryTopologyHash = hashTelegramTopicResumeTopology(input.job, input.deliveries);
    input.hasExistingAttempt = true;
    input.job = {
      ...input.job,
      version: reservedJobVersion + 1,
      updatedAt: input.job.updatedAt + 1,
    };

    expect(isTelegramTopicResumeContinuationValid({
      ...input,
      mode: "standard",
      reservedJobVersion,
      currentJobVersion: input.job.version,
      anchorAttemptBaseline: 1,
      recoveryJobVersionBaseline: reservedJobVersion,
      deliveryTopologyHash,
    })).toBe(true);
  });

  it.each([
    ["missing persisted attempt", { hasExistingAttempt: false }],
    ["warning mode", { mode: "warning_replay" }],
    ["wrong anchor baseline", { anchorAttemptBaseline: 2 }],
    ["wrong recovery baseline", { recoveryJobVersionBaseline: 540 }],
    ["future recovery baseline", { recoveryJobVersionBaseline: 543 }],
    ["stale current version", { currentJobVersion: 541 }],
    ["invalid topology hash", { deliveryTopologyHash: "A".repeat(64) }],
  ] as const)("rejects a standard continuation with %s", (_name, override) => {
    const input = fixture();
    const reservedJobVersion = input.job.version;
    const deliveryTopologyHash = hashTelegramTopicResumeTopology(input.job, input.deliveries);
    input.hasExistingAttempt = true;
    input.job = { ...input.job, version: reservedJobVersion + 1, updatedAt: input.job.updatedAt + 1 };

    expect(isTelegramTopicResumeContinuationValid({
      ...input,
      mode: "standard",
      reservedJobVersion,
      currentJobVersion: input.job.version,
      anchorAttemptBaseline: 1,
      recoveryJobVersionBaseline: reservedJobVersion,
      deliveryTopologyHash,
      ...override,
    })).toBe(false);
  });

  it.each([null, "telegram_not_sent"] as const)(
    "rejects a standard continuation whose anchor error is %s",
    (lastErrorCode) => {
      const input = fixture();
      const reservedJobVersion = input.job.version;
      const deliveryTopologyHash = hashTelegramTopicResumeTopology(input.job, input.deliveries);
      input.hasExistingAttempt = true;
      input.job = { ...input.job, version: reservedJobVersion + 1, updatedAt: input.job.updatedAt + 1 };
      input.deliveries[0] = { ...input.deliveries[0]!, lastErrorCode };

      expect(isTelegramTopicResumeContinuationValid({
        ...input,
        mode: "standard",
        reservedJobVersion,
        currentJobVersion: input.job.version,
        anchorAttemptBaseline: 1,
        recoveryJobVersionBaseline: reservedJobVersion,
        deliveryTopologyHash,
      })).toBe(false);
    },
  );

  it("hashes topology without delivery state while detecting canonical payload changes", () => {
    const input = fixture();
    const baseline = hashTelegramTopicResumeTopology(input.job, input.deliveries);
    const transitioned = input.deliveries.map((part, index) => ({
      ...part,
      state: "delivered" as const,
      attemptCount: index + 2,
      telegramMessageId: index + 10,
      nextAttemptAt: 999,
      lastErrorCode: "ignored-state",
      updatedAt: part.updatedAt + 10,
    }));
    expect(hashTelegramTopicResumeTopology(input.job, transitioned)).toBe(baseline);
    expect(hashTelegramTopicResumeTopology(input.job, [...input.deliveries].reverse())).toBe(baseline);

    const changed = structuredClone(input.deliveries);
    const payload = {
      operation: "send_text" as const,
      ...DESTINATION,
      text: "Different notice",
    };
    changed[2] = { ...changed[2]!, payload, contentHash: hashTelegramDeliveryPayload(payload) };
    expect(hashTelegramTopicResumeTopology(input.job, changed)).not.toBe(baseline);
  });

  const invalidTopologies: Array<[string, (input: Fixture) => void]> = [
    ["missing row", (input) => { input.deliveries.pop(); }],
    ["extra row", (input) => {
      const payload = { operation: "send_text" as const, ...DESTINATION, text: "extra" };
      input.deliveries.push(row("extra:0002", 2, "notice", "pending", payload));
    }],
    ["wrong key", (input) => { input.deliveries[1] = { ...input.deliveries[1]!, partKey: "other" }; }],
    ["wrong ordinal", (input) => { input.deliveries[1] = { ...input.deliveries[1]!, ordinal: 1 }; }],
    ["wrong kind", (input) => { input.deliveries[1] = { ...input.deliveries[1]!, kind: "notice" }; }],
    ["mismatched plan order", (input) => {
      input.job = { ...input.job, responsePlan: [...input.job.responsePlan!].reverse() };
    }],
    ["wrong content hash", (input) => {
      input.deliveries[1] = { ...input.deliveries[1]!, contentHash: "0".repeat(64) };
    }],
  ];

  it.each(invalidTopologies)("rejects topology with %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => hashTelegramTopicResumeTopology(input.job, input.deliveries))
      .toThrow("Invalid Telegram topic resume topology");
  });

  it("changes the topology hash for a consistently reordered response plan", () => {
    const input = fixture();
    const baseline = hashTelegramTopicResumeTopology(input.job, input.deliveries);
    const reordered = fixture();
    reordered.job = {
      ...reordered.job,
      responsePlan: [...reordered.job.responsePlan!].reverse(),
      deliveries: [...reordered.job.deliveries].reverse(),
    };
    reordered.deliveries[1] = { ...reordered.deliveries[1]!, ordinal: 1 };
    reordered.deliveries[2] = { ...reordered.deliveries[2]!, ordinal: 0 };

    expect(hashTelegramTopicResumeTopology(reordered.job, reordered.deliveries)).not.toBe(baseline);
  });

  it.each([
    ["non-failed recovery", (value: Fixture) => { value.recovery = { ...value.recovery!, state: "unknown", reasonCode: "TOPIC_RECOVERY_UNKNOWN" }; }],
    ["active running job", (value: Fixture) => { value.job = { ...value.job, phase: "running" }; }],
    ["future recovery version", (value: Fixture) => { value.recovery = { ...value.recovery!, currentJobVersion: 542 }; }],
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
    ["anchor deadline", (value: Fixture) => { value.deliveries[0] = { ...value.deliveries[0]!, nextAttemptAt: 999 }; }],
    ["missing anchor error", (value: Fixture) => { value.deliveries[0] = { ...value.deliveries[0]!, lastErrorCode: null }; }],
    ["wrong anchor error", (value: Fixture) => { value.deliveries[0] = { ...value.deliveries[0]!, lastErrorCode: "telegram_not_sent" }; }],
    ["delivered follower", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, state: "delivered", telegramMessageId: 6 }; }],
    ["sending follower", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, state: "sending" }; }],
    ["follower deadline", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, nextAttemptAt: 999 }; }],
    ["follower attempt", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, attemptCount: 1 }; }],
    ["follower error", (value: Fixture) => { value.deliveries[1] = { ...value.deliveries[1]!, lastErrorCode: "telegram_permanent" }; }],
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
  ])("rejects %s without mutating its input", (name, mutate) => {
    for (const baseline of [1, 4]) {
      if (name === "stale recovery version" && baseline > 1) continue;
      const input = fixture();
      input.deliveries[0] = { ...input.deliveries[0]!, attemptCount: baseline };
      mutate(input);
      const before = structuredClone(input);
      expect(planTelegramTopicResume(input)).toBeNull();
      expect(input).toEqual(before);
    }
  });
});
