import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { vi } from "vitest";

import { TelegramDeliveryOutbox, TelegramDeliveryApiError } from "../src/telegram-delivery-outbox.js";
import { createTelegramDeliveryTransport } from "../src/telegram-grammy-transport.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import { seedResumeCandidate, seedResumeDelivery } from "./telegram-topic-resume-delivery-fixture.js";
import { NOW } from "./telegram-topic-resume-runtime-fixture.js";

describe("resume-owned delivery fencing", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let db: Database.Database;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "topic-resume-guard-"));
    const file = path.join(directory, "jobs.sqlite");
    store = new SqliteTelegramJobStore(file);
    db = new Database(file);
  });
  afterEach(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  it.each([
    new Error("429 Too Many Requests"),
    new TelegramDeliveryApiError("retry_after", 1000),
    { error: { error_code: 429, parameters: { retry_after: 1 } } },
    { error_code: 429 },
    { error_code: 429, parameters: { retry_after: 0 } },
    { error_code: 429, parameters: { retry_after: 3601 } },
    { error_code: 429, parameters: { retry_after: "1" } },
  ])("never repeats a resume delivery after an unconfirmed transport 429", async (failure) => {
    const h = seedResumeDelivery(store);
    const send = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ message_id: 71 });
    const telegram = createTelegramDeliveryTransport({ sendMessage: send, sendRichMessage: send } as never, directory);
    const options = { ...h.options, telegram };
    await new TelegramDeliveryOutbox(options).pump();
    expect(store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")).toMatchObject({ state: "uncertain", attemptCount: 2,
      nextAttemptAt: null, telegramMessageId: null, lastErrorCode: "telegram_send_uncertain" });
    expect(store.getTopicResume(h.jobId)?.reasonCode).toBe("TOPIC_RESUME_DELIVERY_UNCERTAIN");
    store.close(); store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    await new TelegramDeliveryOutbox({ ...options, store, now: () => NOW + 3_600_000 }).pump();
    expect(send).toHaveBeenCalledOnce();
    expect(store.nextDeliveryWakeupAt()).toBeNull();
    expect(h.scheduleWakeup).not.toHaveBeenCalled();
  });

  it("retains a definitive transport 429 deadline without counting a rejected resume attempt", async () => {
    const h = seedResumeDelivery(store);
    const send = vi.fn().mockRejectedValueOnce({ error_code: 429, parameters: { retry_after: 1 } })
      .mockResolvedValue({ message_id: 71 });
    const telegram = createTelegramDeliveryTransport({ sendMessage: send, sendRichMessage: send } as never, directory);
    const options = { ...h.options, telegram };
    await new TelegramDeliveryOutbox(options).pump();
    expect(store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")).toMatchObject({ state: "pending", attemptCount: 1,
      nextAttemptAt: NOW + 1000, lastErrorCode: "telegram_retry_after" });
    await new TelegramDeliveryOutbox({ ...options, now: () => NOW + 999 }).pump();
    expect(send).toHaveBeenCalledOnce();
    await new TelegramDeliveryOutbox({ ...options, now: () => NOW + 1000 }).pump();
    expect(send).toHaveBeenCalledTimes(4);
    expect(store.getTopicResume(h.jobId)?.state).toBe("complete");
  });

  it("preserves the legacy textual 429 retry for an ordinary delivery", async () => {
    const h = seedResumeCandidate(store);
    const send = vi.fn().mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValue({ message_id: 71 });
    const telegram = createTelegramDeliveryTransport({ sendMessage: send, sendRichMessage: send } as never, directory);
    const options = { store, telegram, now: () => NOW };
    await new TelegramDeliveryOutbox(options).retryFailed(h.jobId, "status-anchor");
    expect(store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")).toMatchObject({ state: "pending", attemptCount: 1,
      nextAttemptAt: NOW + 30_000, lastErrorCode: "telegram_retry_after" });
    await new TelegramDeliveryOutbox({ ...options, now: () => NOW + 30_000 }).pump();
    expect(send).toHaveBeenCalledTimes(4);
    expect(store.get(h.jobId)?.phase).toBe("terminal");
  });

  it("denies direct failed retry without any writes when a resume row exists", async () => {
    const h = seedResumeDelivery(store);
    const before = db.prepare("PRAGMA data_version").get();
    const job = store.get(h.jobId);
    const rows = store.listDeliveries(h.jobId);
    await expect(h.outbox.retryFailed(h.jobId, "status-anchor")).rejects.toThrow();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(store.get(h.jobId)).toEqual(job);
    expect(store.listDeliveries(h.jobId)).toEqual(rows);
    expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
  });

  it("detects a mutation committed by the independent store connection", () => {
    const h = seedResumeDelivery(store);
    const before = db.prepare("PRAGMA data_version").get();
    const source = store.readSourcePayload(h.jobId) as Record<string, unknown>;
    store.replaceSourcePayload(h.jobId, store.get(h.jobId)!.source, { ...source, text: "write detector control" });
    expect(db.prepare("PRAGMA data_version").get()).not.toEqual(before);
  });

  it("denies direct send-again on resume-owned uncertain evidence", async () => {
    const h = seedResumeDelivery(store);
    db.prepare("UPDATE deliveries SET state = 'uncertain' WHERE job_id = ? AND part_key = 'status-anchor'")
      .run(h.jobId);
    const rows = store.listDeliveries(h.jobId);
    await expect(h.outbox.sendAgainWithWarning(h.jobId, "status-anchor")).rejects.toThrow();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(store.listDeliveries(h.jobId)).toEqual(rows);
  });

  it("settles binding drift before the anchor without changing delivery rows", async () => {
    const h = seedResumeDelivery(store);
    const rows = store.listDeliveries(h.jobId);
    h.external.hasThreadTopicBinding = false;
    await h.outbox.pump();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(store.getTopicResume(h.jobId)).toMatchObject({
      state: "failed", reasonCode: "TOPIC_RESUME_EVIDENCE_STALE",
    });
    expect(store.listDeliveries(h.jobId)).toEqual(rows);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it("advances resume and job versions together through sending, delivered and completion", async () => {
    const h = seedResumeDelivery(store);
    const versions: number[] = [];
    h.deliver.mockImplementation(async () => {
      const job = store.get(h.jobId)!;
      expect(store.getTopicResume(h.jobId)!.currentJobVersion).toBe(job.version);
      versions.push(job.version);
      return { messageId: 71 };
    });
    await h.outbox.pump();
    expect(versions).toHaveLength(3);
    expect(store.get(h.jobId)!.phase).toBe("terminal");
    expect(store.getTopicResume(h.jobId)).toMatchObject({
      state: "complete", currentJobVersion: store.get(h.jobId)!.version,
    });
  });

  it.each([1, 2])("stops on binding drift after %s delivered parts", async (sent) => {
    const h = seedResumeDelivery(store);
    h.deliver.mockImplementation(async () => {
      if (h.deliver.mock.calls.length === sent) h.external.hasThreadTopicBinding = false;
      return { messageId: 71 };
    });
    await h.outbox.pump();
    expect(h.deliver).toHaveBeenCalledTimes(sent);
    expect(store.getTopicResume(h.jobId)).toMatchObject({
      state: "failed", reasonCode: "TOPIC_RESUME_EVIDENCE_STALE",
    });
    await new TelegramDeliveryOutbox(h.options).pump();
    expect(h.deliver).toHaveBeenCalledTimes(sent);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each(["retry_after", "not_sent"] as const)("fences the %s retry boundary", async (code) => {
    const h = seedResumeDelivery(store);
    h.deliver.mockRejectedValueOnce(new TelegramDeliveryApiError(code, code === "retry_after" ? 1_000 : undefined, undefined, true));
    await h.outbox.pump();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.getTopicResume(h.jobId)!.currentJobVersion).toBe(store.get(h.jobId)!.version);
    const rows = store.listDeliveries(h.jobId);
    h.external.hasThreadTopicBinding = false;
    await new TelegramDeliveryOutbox({ ...h.options, now: () => NOW + 1_000 }).pump();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.listDeliveries(h.jobId)).toEqual(rows);
    expect(store.getTopicResume(h.jobId)?.reasonCode).toBe("TOPIC_RESUME_EVIDENCE_STALE");
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each([
    ["handoff", "UPDATE topic_resume_attempts SET action_token = 'bad'"],
    ["source", "UPDATE inbox_updates SET source_json = '{}'"],
    ["recovery", "UPDATE topic_recoveries SET action_token = 'bad'"],
    ["plan", "UPDATE status_anchor_plans SET payload_json = '{}'"],
    ["delivery", "UPDATE deliveries SET payload_json = '{}'"],
  ])("quarantines malformed %s and progresses an unrelated job across restart", async (_name, sql) => {
    const h = seedResumeDelivery(store);
    db.exec(sql);
    const unrelated = seedResumeDelivery(store, 2);
    await expect(h.outbox.pump()).resolves.toBeUndefined();
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.get(unrelated.jobId)?.phase).toBe("terminal");
    expect(h.deliver).toHaveBeenCalledTimes(3);
    await new TelegramDeliveryOutbox(h.options).pump();
    expect(h.deliver).toHaveBeenCalledTimes(3);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
    expect(store.listQuarantined(10)[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["deadline", "next_attempt_at_ms = 30000"],
    ["error", "last_error_code = 'telegram_retry_after'"],
    ["attempts", "attempt_count = 9"],
  ])("blocks a delivered predecessor with contradictory %s before another send", async (_name, assignment) => {
    const h = seedResumeDelivery(store);
    const original = store.transitionDeliveryAndProject.bind(store);
    vi.spyOn(store, "transitionDeliveryAndProject").mockImplementation((input) => {
      const result = original(input);
      if (input.state === "delivered" && input.partKey === "status-anchor") {
        db.prepare(`UPDATE deliveries SET ${assignment} WHERE job_id = ? AND part_key = 'status-anchor'`)
          .run(h.jobId);
      }
      return result;
    });
    await h.outbox.pump();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    await new TelegramDeliveryOutbox(h.options).pump();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each([
    ["job", (database: Database.Database) => database.exec("UPDATE jobs SET version = version + 1")],
    ["resume", (database: Database.Database) => database.exec("UPDATE topic_resume_attempts SET action_token = replace(action_token, 'a', 'c')")],
    ["recovery", (database: Database.Database) => database.exec("UPDATE topic_recoveries SET current_job_version = current_job_version + 1")],
  ])("rechecks %s drift atomically after authorization and before sending CAS", async (_name, mutate) => {
    const h = seedResumeDelivery(store);
    const rows = store.listDeliveries(h.jobId);
    const authorize = store.authorizeTopicResumeDelivery.bind(store);
    vi.spyOn(store, "authorizeTopicResumeDelivery").mockImplementation((...args) => {
      const result = authorize(...args);
      mutate(db);
      return result;
    });
    await h.outbox.pump();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(store.listDeliveries(h.jobId)).toEqual(rows);
    expect(store.hasJobQuarantine(h.jobId) || store.getTopicResume(h.jobId)?.state === "failed").toBe(true);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each(["source", "delivery"])("records the actual Telegram outcome if %s becomes malformed during send", async (kind) => {
    const h = seedResumeDelivery(store);
    h.deliver.mockImplementation(async () => {
      if (kind === "source") db.exec("UPDATE inbox_updates SET source_json = '['");
      else db.exec("UPDATE deliveries SET payload_json = '[' WHERE part_key = 'notice:0001'");
      return { messageId: 71 };
    });
    await expect(h.outbox.pump()).resolves.toBeUndefined();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT state, telegram_message_id FROM deliveries WHERE part_key = 'status-anchor'").get())
      .toEqual({ state: "delivered", telegram_message_id: 71 });
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    await new TelegramDeliveryOutbox(h.options).pump();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each([
    ["selected payload", "UPDATE deliveries SET payload_json = '[' WHERE part_key = 'status-anchor'"],
    ["selected hash", "UPDATE deliveries SET content_hash = 'invalid' WHERE part_key = 'status-anchor'"],
    ["selected deadline", "UPDATE deliveries SET next_attempt_at_ms = NULL WHERE part_key = 'status-anchor'"],
    ["selected attempts", "UPDATE deliveries SET attempt_count = 99 WHERE part_key = 'status-anchor'"],
    ["selected state", "UPDATE deliveries SET state = 'invalid' WHERE part_key = 'status-anchor'"],
    ["job projection", "UPDATE jobs SET projection_json = '['"],
  ])("preserves actual success and quarantine despite %s corruption during the API call", async (_name, sql) => {
    const h = seedResumeDelivery(store);
    h.deliver.mockImplementation(async () => { db.exec(sql); return { messageId: 71 }; });
    await expect(h.outbox.pump()).resolves.toBeUndefined();
    expect(db.prepare(`SELECT state, telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code
      FROM deliveries WHERE part_key = 'status-anchor'`).get()).toEqual({
      state: "delivered", telegram_message_id: 71, attempt_count: 2,
      next_attempt_at_ms: null, last_error_code: null,
    });
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.getTopicResume(h.jobId)?.state).toBe("failed");
    expect(h.deliver).toHaveBeenCalledOnce();
    await new TelegramDeliveryOutbox(h.options).pump();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each(["permanent", "unknown", "not_sent", "retry_after"])("keeps paired versions after the anchor %s outcome", async (outcome) => {
    const h = seedResumeDelivery(store);
    h.deliver.mockRejectedValueOnce(outcome === "unknown" ? new Error("ambiguous")
      : new TelegramDeliveryApiError(outcome as "permanent", outcome === "retry_after" ? 1000 : undefined, undefined, true));
    await h.outbox.pump();
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.getTopicResume(h.jobId)?.currentJobVersion).toBe(store.get(h.jobId)?.version);
    expect(store.getTopicResume(h.jobId)?.state).toBe(outcome === "permanent" || outcome === "unknown"
      ? "failed" : "delivery_handoff");
  });

  it("restores a deleted sending row from its authorization fence as the observed outcome under quarantine", async () => {
    const h = seedResumeDelivery(store);
    let sending = store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")!;
    h.deliver.mockImplementation(async () => {
      sending = store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")!;
      expect(sending.state).toBe("sending");
      db.prepare("DELETE FROM deliveries WHERE job_id = ? AND part_key = ?").run(h.jobId, sending.partKey);
      return { messageId: 71 };
    });
    await expect(h.outbox.pump()).resolves.toBeUndefined();
    const observed = { ...sending, state: "delivered", attemptCount: sending.attemptCount + 1,
      telegramMessageId: 71, nextAttemptAt: null, lastErrorCode: null };
    expect(store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")).toEqual(observed);
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.getTopicResume(h.jobId)?.state).toBe("failed");
    store.close(); store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    await new TelegramDeliveryOutbox({ ...h.options, store, now: () => NOW + 30_000 }).pump();
    expect(store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")).toEqual(observed);
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it("records an inherited sending lease as uncertain with a paired version and no Telegram", async () => {
    const h = seedResumeDelivery(store);
    const part = store.listDeliveries(h.jobId).find((row) => row.partKey === "status-anchor")!;
    const job = store.get(h.jobId)!;
    const auth = store.authorizeTopicResumeDelivery(job, part, NOW, h.external)!;
    store.transitionDeliveryAndProject({ jobId: h.jobId, partKey: part.partKey,
      state: "sending", attemptCount: part.attemptCount, expectedState: part.state,
      expectedAttemptCount: part.attemptCount, expectedContentHash: part.contentHash,
      expectedJobVersion: job.version, eventId: "inherited-sending", updatedAt: NOW,
      allowFailedRetry: true, lastErrorCode: null, nextAttemptAt: NOW + 1_000,
      topicResumeAuthorization: auth });
    await new TelegramDeliveryOutbox({ ...h.options, now: () => NOW + 1_000 }).pump();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(store.getTopicResume(h.jobId)).toMatchObject({ state: "failed",
      reasonCode: "TOPIC_RESUME_DELIVERY_UNCERTAIN", currentJobVersion: store.get(h.jobId)!.version });
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it.each(["probe_in_flight", "reopen_in_flight", "failed", "complete", "garbled"])(
    "excludes %s ownership from due, sending and wakeup scans", async (state) => {
      const h = seedResumeDelivery(store);
      db.prepare("UPDATE topic_resume_attempts SET state = ?").run(state);
      db.exec("UPDATE deliveries SET next_attempt_at_ms = 10000, state = 'pending'");
      expect(store.listDueDeliveries(NOW, 10)).toEqual([]);
      expect(store.nextDeliveryWakeupAt()).toBeNull();
      db.exec("UPDATE deliveries SET state = 'sending'");
      expect(store.listSendingDeliveries(NOW, 10)).toEqual([]);
      await expect(h.outbox.retryFailed(h.jobId, "status-anchor")).rejects.toThrow();
      await expect(h.outbox.sendAgainWithWarning(h.jobId, "status-anchor")).rejects.toThrow();
      expect(h.deliver).not.toHaveBeenCalled();
    },
  );

  it("quarantines contradictory predecessors at finalization without losing the last actual delivery", async () => {
    const h = seedResumeDelivery(store);
    h.deliver.mockImplementation(async () => {
      if (h.deliver.mock.calls.length === 3) db.exec(
        "UPDATE deliveries SET last_error_code = 'telegram_retry_after' WHERE part_key = 'status-anchor'",
      );
      return { messageId: 71 };
    });
    await h.outbox.pump();
    expect(h.deliver).toHaveBeenCalledTimes(3);
    expect(store.listDeliveries(h.jobId).every((part) => part.state === "delivered")).toBe(true);
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.getTopicResume(h.jobId)?.state).toBe("failed");
    expect(store.getTopicResume(h.jobId)?.currentJobVersion).toBe(store.get(h.jobId)?.version);
  });

  it.each(["final:0000", "notice:0001"])("rechecks a %s safe retry before continuing the suffix", async (key) => {
    const h = seedResumeDelivery(store);
    const calls: string[] = [];
    let retry = true;
    h.deliver.mockImplementation(async () => {
      const sending = store.listDeliveries(h.jobId).find((part) => part.state === "sending")!;
      calls.push(sending.partKey);
      if (sending.partKey === key && retry) { retry = false; throw new TelegramDeliveryApiError("not_sent"); }
      return { messageId: 71 };
    });
    await h.outbox.pump();
    const waiting = store.listDeliveries(h.jobId).find((part) => part.partKey === key)!;
    expect(waiting).toMatchObject({ state: "pending", attemptCount: 0, lastErrorCode: "telegram_not_sent" });
    expect(store.getTopicResume(h.jobId)?.currentJobVersion).toBe(store.get(h.jobId)?.version);
    await new TelegramDeliveryOutbox({ ...h.options, now: () => NOW + 1_000 }).pump();
    expect(calls.filter((part) => part === "status-anchor")).toHaveLength(1);
    expect(calls.filter((part) => part === key)).toHaveLength(2);
    expect(store.getTopicResume(h.jobId)).toMatchObject({ state: "complete", currentJobVersion: store.get(h.jobId)!.version });
  });

  it.each(["finalize", "terminal_event"])("pairs the explicit %s transaction with the resume version", (operation) => {
    const h = seedResumeDelivery(store);
    const job = seedDelivered(h.jobId);
    if (operation === "finalize") store.finalizeDeliveredPlan({ jobId: job.id,
      expectedVersion: job.version, eventId: "explicit-finalize", eventAt: NOW });
    else store.transition({ jobId: job.id, expectedVersion: job.version, eventId: "explicit-terminal",
      event: { schemaVersion: 1, type: "job.terminal", eventAt: NOW, outcome: "completed",
        responsePlan: job.responsePlan, deliveries: job.deliveries, attention: { kind: "none" } } });
    expect(store.getTopicResume(h.jobId)).toMatchObject({ state: "complete",
      currentJobVersion: store.get(h.jobId)!.version });
  });

  it("denies finalization of a canonical payload that changed its reserved topology", () => {
    const h = seedResumeDelivery(store);
    const job = seedDelivered(h.jobId);
    const part = store.listDeliveries(job.id).find((row) => row.partKey === "notice:0001")!;
    const payload = { ...(part.payload as object), text: "changed" };
    db.prepare("UPDATE deliveries SET payload_json = ?, content_hash = ? WHERE job_id = ? AND part_key = ?")
      .run(JSON.stringify(payload), hashTelegramDeliveryPayload(payload), job.id, part.partKey);
    const before = store.listDeliveries(job.id);
    expect(store.finalizeDeliveredPlan({ jobId: job.id, expectedVersion: job.version,
      eventId: "denied-finalization", eventAt: NOW })).toBeNull();
    expect(store.get(job.id)?.phase).toBe("delivering");
    expect(store.listDeliveries(job.id)).toEqual(before);
    expect(store.hasJobQuarantine(job.id)).toBe(true);
  });

  it("quarantines malformed external binding evidence before any Telegram call", async () => {
    const h = seedResumeDelivery(store);
    Object.assign(h.external, { hasThreadTopicBinding: "yes" });
    await h.outbox.pump();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    await new TelegramDeliveryOutbox(h.options).pump();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  function seedDelivered(jobId: string) {
    db.prepare(`UPDATE deliveries SET state = 'delivered', telegram_message_id = 71,
      attempt_count = attempt_count + 1, next_attempt_at_ms = NULL, last_error_code = NULL WHERE job_id = ?`).run(jobId);
    const job = store.get(jobId)!;
    const rows = store.listDeliveries(jobId);
    const deliveries = job.responsePlan!.map((part) => {
      const row = rows.find((row) => row.partKey === part.partId)!;
      return { partId: part.partId, state: row.state, attempts: row.attemptCount,
        messageId: row.telegramMessageId, deliveredAt: row.updatedAt };
    });
    const advanced = store.transition({ jobId, expectedVersion: job.version, eventId: "inherited-delivered",
      event: { schemaVersion: 1, type: "delivery.changed", eventAt: NOW, deliveries } });
    db.prepare("UPDATE topic_resume_attempts SET current_job_version = ? WHERE job_id = ?").run(advanced.version, jobId);
    return advanced;
  }
});
