import { vi } from "vitest";

import { TelegramDeliveryOutbox, type TelegramDeliveryOutboxOptions } from "../src/telegram-delivery-outbox.js";
import { SqliteTelegramJobStore, type TelegramJob } from "../src/telegram-job-store.js";
import { planTelegramTopicRecovery } from "../src/telegram-topic-recovery.js";
import { planTelegramTopicResume } from "../src/telegram-topic-resume.js";
import { hashTelegramDeliveryPayload, type TelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import { createHarness, DESTINATION, NOW } from "./telegram-topic-resume-runtime-fixture.js";

export function seedResumeCandidate(store: SqliteTelegramJobStore, updateId = 1,
  settings: { warning?: boolean; multipart?: boolean } = {}) {
  const seed = createHarness();
  const initial = seed.options.store.get("fixture")!;
  const source = { ...seed.options.store.readSourcePayload("fixture")!, updateId };
  const thread = seed.options.getThread(initial.threadId!)!;
  const jobId = `guard-job-${updateId}`;
  let job: TelegramJob = {
    ...initial, id: jobId, version: 1, source: { botId: source.botId, updateId },
    phase: "accepted", health: "healthy", attention: { kind: "none" },
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt: NOW - 100, updatedAt: NOW - 100,
  };
  store.acceptUpdate({ job, sourcePayload: source, eventId: `${jobId}:accepted` });
  const transition = (event: Parameters<SqliteTelegramJobStore["transition"]>[0]["event"]) => {
    job = store.transition({ jobId, expectedVersion: job.version, eventId: `${jobId}:${job.version}`, event });
  };
  transition({ schemaVersion: 1, type: "job.queued", eventAt: NOW - 99 });
  transition({ schemaVersion: 1, type: "dispatch.started", eventAt: NOW - 98, dispatch: {
    id: `${jobId}:dispatch`, threadId: thread.id, previousTurnId: null, attempt: 1,
    startedAt: NOW - 98, transportWriteState: "written", nextAttemptAt: null,
  } });
  transition({ schemaVersion: 1, type: "turn.started", eventAt: NOW - 97,
    identifiers: { turnId: `${jobId}:turn` }, codexEventAt: NOW - 97 });
  transition({ schemaVersion: 1, type: "turn.completed", eventAt: NOW - 96,
    codexEventAt: NOW - 96, turnResult: { schemaVersion: 1, content: [] } });
  const parts = seed.options.store.listDeliveries("fixture").map((part) => {
    let payload = part.payload as TelegramDeliveryPayload;
    if (settings.multipart && payload.operation === "send_rich") {
      const first = payload.fallbackParts[0]!;
      payload = { ...payload, fallbackParts: [first,
        { ...first, partKey: `${part.partKey}:fallback:0001` }] };
    }
    return { ...part, payload, contentHash: hashTelegramDeliveryPayload(payload),
      jobId, state: "pending" as const, attemptCount: 0, lastErrorCode: null };
  });
  job = store.installDeliveryPlan({ jobId, expectedVersion: job.version, eventId: `${jobId}:plan`,
    eventAt: NOW, responsePlan: initial.responsePlan!, parts });
  for (const state of ["sending", "failed"] as const) {
    job = store.transitionDeliveryAndProject({
      jobId, partKey: "status-anchor", expectedJobVersion: job.version,
      expectedState: state === "sending" ? "pending" : "sending", expectedAttemptCount: 0,
      state, attemptCount: state === "sending" ? 0 : 1, eventId: `${jobId}:${state}`,
      updatedAt: NOW, nextAttemptAt: null,
      lastErrorCode: state === "failed" ? "telegram_permanent" : null,
    }).job;
  }
  const anchorPlan = store.getStatusAnchorPlan(jobId)!;
  const recoveryCandidate = planTelegramTopicRecovery({
    job, source, deliveries: store.listDeliveries(jobId), anchorPlan, thread,
  })!;
  const recovery = store.reserveTopicRecovery({ candidate: recoveryCandidate,
    eventId: `${jobId}:recover`, actionToken: updateId.toString(16).padStart(64, "b"), eventAt: NOW });
  store.failTopicRecovery({ jobId, expectedVersion: recovery.job.version,
    actionToken: recovery.recovery.actionToken, reasonCode: "TOPIC_RECOVERY_FAILED", updatedAt: NOW });
  job = store.get(jobId)!;
  if (settings.warning) {
    for (const state of ["sending", "failed"] as const) {
      job = store.transitionDeliveryAndProject({ jobId, partKey: "status-anchor",
        expectedJobVersion: job.version, expectedState: state === "sending" ? "failed" : "sending",
        expectedAttemptCount: 1, state, attemptCount: state === "sending" ? 1 : 2,
        allowFailedRetry: true, eventId: `${jobId}:warning:${state}`, updatedAt: NOW,
        nextAttemptAt: null, lastErrorCode: state === "failed" ? "telegram_permanent" : null }).job;
    }
  }
  const external = { thread, forumChatId: DESTINATION.chatId, hasThreadTopicBinding: true };
  const candidate = planTelegramTopicResume({ job, source, deliveries: store.listDeliveries(jobId),
    anchorPlan, recovery: store.getTopicRecovery(jobId), ...external,
    hasExistingAttempt: false, quarantined: false })!;
  return { store, jobId, job, external, candidate };
}

export function seedResumeDelivery(store: SqliteTelegramJobStore, updateId = 1,
  settings: { warning?: boolean; multipart?: boolean } = {}) {
  const { jobId, external, candidate } = seedResumeCandidate(store, updateId, settings);
  const reserved = store.reserveTopicResume({ candidate, allowedModes: new Set([candidate.mode]),
    externalEligibilitySnapshot: external, eventId: `${jobId}:reserve`,
    actionToken: updateId.toString(16).padStart(64, "a"), eventAt: NOW });
  const handoff = store.transitionTopicResume({ jobId, expectedVersion: reserved.job.version,
    actionToken: reserved.resume.actionToken, expectedState: "probe_in_flight", state: "delivery_handoff",
    externalEligibilitySnapshot: external, updatedAt: NOW });
  const deliver = vi.fn(async () => ({ messageId: 71 }));
  const scheduleWakeup = vi.fn();
  const options: TelegramDeliveryOutboxOptions = {
    store, telegram: { deliver }, now: () => NOW, scheduleWakeup,
    topicResumeExternalSnapshot: () => external,
  };
  const outbox = new TelegramDeliveryOutbox(options);
  return { store, jobId, handoff, external, deliver, scheduleWakeup, options, outbox };
}
