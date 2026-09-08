import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { vi } from "vitest";

import { TelegramDeliveryApiError, TelegramDeliveryOutbox } from "../src/telegram-delivery-outbox.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { hashTelegramTopicResumeTopology } from "../src/telegram-topic-resume.js";
import { seedResumeDelivery } from "./telegram-topic-resume-delivery-fixture.js";
import { NOW } from "./telegram-topic-resume-runtime-fixture.js";

describe("resume rich fallback lineage", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let db: Database.Database;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "topic-resume-rich-"));
    const file = path.join(directory, "jobs.sqlite");
    store = new SqliteTelegramJobStore(file);
    db = new Database(file);
  });
  afterEach(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  it.each(["format", "method_unavailable"] as const)("atomically advances topology for %s and completes every descendant", async (reason) => {
    const h = seedResumeDelivery(store, 1, { multipart: true, warning: true });
    const oldHash = store.getTopicResume(h.jobId)!.deliveryTopologyHash;
    const observed: string[] = [];
    const outbox = new TelegramDeliveryOutbox({ ...h.options, telegram: { async deliver(payload) {
      const job = store.get(h.jobId)!;
      const resume = store.getTopicResume(h.jobId)!;
      expect(resume.currentJobVersion === job.version).toBe(true);
      expect(resume.deliveryTopologyHash === hashTelegramTopicResumeTopology(job, store.listDeliveries(h.jobId))).toBe(true);
      observed.push(payload.operation);
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, reason);
      return { messageId: 71 };
    } } });
    await outbox.pump();
    expect(store.getTopicResume(h.jobId)?.state).toBe("complete");
    expect(observed).toEqual(["send_text", "send_rich", "send_text", "send_text", "send_text"]);
    expect(store.get(h.jobId)?.responsePlan).toHaveLength(3);
    expect(store.listDeliveries(h.jobId).filter((row) => row.state === "delivered")).toHaveLength(4);
    expect(store.getTopicResume(h.jobId)!.deliveryTopologyHash === oldHash).toBe(false);
    expect(store.hasJobQuarantine(h.jobId)).toBe(false);
  });

  it("revalidates binding after a rich rejection before rewriting or sending fallback", async () => {
    const h = seedResumeDelivery(store, 1, { multipart: true });
    const oldHash = store.getTopicResume(h.jobId)!.deliveryTopologyHash;
    let calls = 0;
    const outbox = new TelegramDeliveryOutbox({ ...h.options, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich") {
        h.external.hasThreadTopicBinding = false;
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: 71 };
    } } });
    await outbox.pump();
    expect(calls).toBe(2);
    expect(store.getTopicResume(h.jobId)?.reasonCode).toBe("TOPIC_RESUME_EVIDENCE_STALE");
    expect(store.getTopicResume(h.jobId)?.deliveryTopologyHash === oldHash).toBe(true);
    expect(store.get(h.jobId)?.responsePlan).toHaveLength(2);
    const rejected = store.listDeliveries(h.jobId).find((row) => row.partKey === "final:0000")!;
    expect(rejected.state).toBe("failed");
    expect(rejected.attemptCount).toBe(1);
    expect(rejected.lastErrorCode).toBe("telegram_rich_fallback_failed");
    expect(rejected.telegramMessageId).toBeNull();
    expect(rejected.nextAttemptAt).toBeNull();
    expect(store.getTopicResume(h.jobId)?.currentJobVersion === store.get(h.jobId)?.version).toBe(true);
    await new TelegramDeliveryOutbox(h.options).pump();
    expect(calls).toBe(2);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it("contains partial fallback uncertainty once across reconstruction", async () => {
    const h = seedResumeDelivery(store, 1, { multipart: true });
    let calls = 0;
    const options = { ...h.options, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      if (calls === 4) throw new Error("ambiguous");
      return { messageId: 71 };
    } } };
    await new TelegramDeliveryOutbox(options).pump();
    expect(store.getTopicResume(h.jobId)?.reasonCode).toBe("TOPIC_RESUME_FOLLOWER_UNCERTAIN");
    expect(calls).toBe(4);
    const version = store.get(h.jobId)?.version;
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(4);
    expect(store.get(h.jobId)?.version).toBe(version);
    expect(store.hasJobQuarantine(h.jobId)).toBe(false);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it("fences the known-unavailable replan with a fresh snapshot and no rich API retry", async () => {
    const first = seedResumeDelivery(store, 1, { multipart: true });
    const second = seedResumeDelivery(store, 2, { multipart: true });
    const replan = vi.spyOn(store, "replaceRejectedRichDelivery");
    let richCalls = 0;
    const outbox = new TelegramDeliveryOutbox({ ...first.options,
      topicResumeExternalSnapshot: (jobId) => structuredClone(jobId === first.jobId ? first.external : second.external),
      telegram: { async deliver(payload) {
        if (payload.operation === "send_rich") {
          richCalls++;
          throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
        }
        return { messageId: 71 };
      } },
    });
    await outbox.pump();
    expect([store.getTopicResume(first.jobId)?.state, store.getTopicResume(second.jobId)?.state]).toEqual(["complete", "complete"]);
    expect(richCalls).toBe(1);
    expect(replan).toHaveBeenCalledTimes(2);
    expect(replan.mock.calls.map(([input]) => input.expectedState)).toEqual(["sending", "pending"]);
    expect(replan.mock.calls.every(([input]) => input.topicResumeReplan?.quarantined === false
      && input.topicResumeReplan?.external.hasThreadTopicBinding === true)).toBe(true);
    expect(replan.mock.calls[0]![0].topicResumeReplan?.external === replan.mock.calls[1]![0].topicResumeReplan?.external).toBe(false);
  });

  it.each(["sending", "pending"] as const)("blocks fresh durable drift immediately before a %s replan", async (state) => {
    const first = seedResumeDelivery(store, 1, { multipart: true });
    const second = state === "pending" ? seedResumeDelivery(store, 2, { multipart: true }) : first;
    const original = store.replaceRejectedRichDelivery.bind(store);
    vi.spyOn(store, "replaceRejectedRichDelivery").mockImplementation((input) => {
      if (input.jobId === second.jobId) {
        db.prepare("UPDATE topic_recoveries SET current_job_version = current_job_version + 1 WHERE job_id = ?")
          .run(second.jobId);
      }
      return original(input);
    });
    let calls = 0;
    const outbox = new TelegramDeliveryOutbox({ ...first.options, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
      return { messageId: 71 };
    } } });
    const hash = store.getTopicResume(second.jobId)!.deliveryTopologyHash;
    await outbox.pump();
    expect(store.getTopicResume(second.jobId)?.reasonCode).toBe("TOPIC_RESUME_EVIDENCE_STALE");
    expect(store.getTopicResume(second.jobId)?.deliveryTopologyHash === hash).toBe(true);
    expect(store.get(second.jobId)?.responsePlan).toHaveLength(2);
    const count = calls;
    await outbox.pump();
    expect(calls).toBe(count);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it("rolls back every fallback row if the topology CAS fails and quarantines ownership", async () => {
    const h = seedResumeDelivery(store, 1, { multipart: true });
    const hash = store.getTopicResume(h.jobId)!.deliveryTopologyHash;
    db.exec(`CREATE TRIGGER reject_topology BEFORE UPDATE OF delivery_topology_hash ON topic_resume_attempts
      BEGIN SELECT RAISE(ABORT, 'fixture fault'); END`);
    let calls = 0;
    await new TelegramDeliveryOutbox({ ...h.options, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      return { messageId: 71 };
    } } }).pump();
    expect(calls).toBe(2);
    expect(store.get(h.jobId)?.responsePlan).toHaveLength(2);
    expect(store.listDeliveries(h.jobId)).toHaveLength(3);
    expect(store.getTopicResume(h.jobId)?.deliveryTopologyHash === hash).toBe(true);
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each(["retry_after", "not_sent"] as const)("retries a fallback %s only at its persisted deadline with unchanged attempt baseline", async (code) => {
    const h = seedResumeDelivery(store, 1, { multipart: true });
    let clock = NOW;
    let calls = 0;
    const options = { ...h.options, now: () => clock, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      if (calls === 4) throw new TelegramDeliveryApiError(code, code === "retry_after" ? 1000 : undefined, undefined, true);
      return { messageId: 71 };
    } } };
    await new TelegramDeliveryOutbox(options).pump();
    const pending = store.listDeliveries(h.jobId).find((row) => row.lastErrorCode !== null)!;
    expect(pending.attemptCount).toBe(0);
    expect(pending.nextAttemptAt).toBe(NOW + 1000);
    clock = pending.nextAttemptAt! - 1;
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(4);
    clock++;
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(6);
    expect(store.getTopicResume(h.jobId)?.state).toBe("complete");
    expect(store.listDeliveries(h.jobId).filter((row) => row.partKey !== "status-anchor")
      .every((row) => row.attemptCount === 1)).toBe(true);
  });

  it.each([3, 4])("fences binding drift after fallback API call %s before the next descendant", async (stop) => {
    const h = seedResumeDelivery(store, 1, { multipart: true });
    let calls = 0;
    const options = { ...h.options, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      if (calls === stop) h.external.hasThreadTopicBinding = false;
      return { messageId: 71 };
    } } };
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(stop);
    expect(store.getTopicResume(h.jobId)?.reasonCode).toBe("TOPIC_RESUME_EVIDENCE_STALE");
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(stop);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each([
    "next_attempt_at_ms = 30000", "last_error_code = 'telegram_retry_after'", "attempt_count = 9",
    "telegram_message_id = NULL", "payload_json = '{}'",
  ])("quarantines malformed delivered fallback evidence at dynamic completion (%s)", async (assignment) => {
    const h = seedResumeDelivery(store, 1, { multipart: true });
    let calls = 0;
    const options = { ...h.options, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      if (calls === 5) db.exec(`UPDATE deliveries SET ${assignment} WHERE part_key = 'final:0000:fallback:0000'`);
      return { messageId: 71 };
    } } };
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(5);
    expect(store.getTopicResume(h.jobId)?.state).toBe("failed");
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.get(h.jobId)?.phase).not.toBe("terminal");
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(5);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each(["source", "job"] as const)("contains malformed %s during a rich rejection while an unrelated job progresses", async (kind) => {
    const h = seedResumeDelivery(store, 1, { multipart: true });
    const unrelated = seedResumeDelivery(store, 2);
    let calls = 0;
    let corrupted = false;
    const options = { ...h.options, telegram: { async deliver(payload) {
      calls++;
      if (payload.operation === "send_rich" && !corrupted) {
        corrupted = true;
        const sql = kind === "source" ? "UPDATE inbox_updates SET source_json = '[' WHERE job_id = ?"
          : "UPDATE jobs SET projection_json = '[' WHERE id = ?";
        db.prepare(sql).run(h.jobId);
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      return { messageId: 71 };
    } } };
    await expect(new TelegramDeliveryOutbox(options).pump()).resolves.toBeUndefined();
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.getTopicResume(unrelated.jobId)?.state).toBe("complete");
    expect(calls).toBe(5);
    await new TelegramDeliveryOutbox(options).pump();
    expect(calls).toBe(5);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });
});
