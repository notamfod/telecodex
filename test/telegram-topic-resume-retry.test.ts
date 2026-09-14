import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { vi } from "vitest";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { TelegramDeliveryApiError, TelegramDeliveryOutbox } from "../src/telegram-delivery-outbox.js";
import { createTelegramTopicResumeRuntime } from "../src/telegram-topic-resume-runtime.js";
import { seedResumeDelivery } from "./telegram-topic-resume-delivery-fixture.js";
import { NOW } from "./telegram-topic-resume-runtime-fixture.js";

describe("operator retry of a definitively failed topic resume", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let db: Database.Database;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "topic-resume-retry-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    db = new Database(path.join(directory, "jobs.sqlite"));
  });
  afterEach(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  async function failed() {
    const h = seedResumeDelivery(store, 1, { warning: true });
    h.deliver.mockRejectedValue(new TelegramDeliveryApiError("permanent"));
    await h.outbox.pump();
    const prior = store.getTopicResume(h.jobId)!;
    expect(prior).toMatchObject({ state: "failed", reasonCode: "TOPIC_RESUME_DELIVERY_FAILED" });
    const calls: string[] = [];
    const deliver = vi.fn(async () => ({ messageId: 99 }));
    const outbox = new TelegramDeliveryOutbox({ ...h.options, now: () => NOW + 1, telegram: { deliver } });
    const runtime = createTelegramTopicResumeRuntime({
      store, allowedModes: new Set(["warning_replay"]), forumChatId: h.external.forumChatId,
      getThread: () => h.external.thread, hasThreadTopicBinding: () => h.external.hasThreadTopicBinding,
      classifyForumTopic: async () => { calls.push("probe"); expect(store.getTopicResume(h.jobId)?.actionToken).not.toBe(prior.actionToken); return "live"; },
      reopenForumTopic: async () => true,
      outboxRetryFailed: async () => { calls.push("handoff"); await outbox.pump(); },
      outboxPump: () => outbox.pump(), now: () => NOW + 1,
    });
    return { h, prior, runtime, calls, deliver, input: { jobId: h.jobId, expectedVersion: store.get(h.jobId)!.version, priorActionToken: prior.actionToken } };
  }

  it("archives the failed attempt, reserves a fresh token, and delivers once", async () => {
    const f = await failed();
    await f.runtime.retryFailed(f.input);
    const current = store.getTopicResume(f.h.jobId)!;
    expect(current.state).toBe("complete");
    expect(current.actionToken).not.toBe(f.prior.actionToken);
    expect(current.anchorAttemptBaseline).toBe(f.prior.anchorAttemptBaseline + 1);
    const rows = db.prepare("SELECT * FROM topic_resume_attempt_history").all() as { snapshot_json: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.snapshot_json)).toEqual(f.prior);
    expect(f.deliver).toHaveBeenCalledTimes(3);
    expect(f.calls).toEqual(["probe", "handoff"]);
    await expect(f.runtime.retryFailed(f.input)).rejects.toThrow();
    expect(f.deliver).toHaveBeenCalledTimes(3);
    f.runtime.dispose();
  });

  it("does not automatically retry a failed attempt", async () => {
    const f = await failed();
    await f.runtime.reconcile();
    expect(store.getTopicResume(f.h.jobId)).toEqual(f.prior);
    expect(f.deliver).not.toHaveBeenCalled();
    f.runtime.dispose();
  });

  it.each(["version", "token", "binding", "topology", "uncertain", "attempts", "follower"])("rejects %s drift before effects or archiving", async (kind) => {
    const f = await failed();
    if (kind === "version") f.input.expectedVersion--;
    if (kind === "token") f.input.priorActionToken = "f".repeat(64);
    if (kind === "binding") f.h.external.hasThreadTopicBinding = false;
    if (kind === "topology") db.exec("UPDATE topic_resume_attempts SET delivery_topology_hash = '" + "f".repeat(64) + "'");
    if (kind === "uncertain") db.exec("UPDATE topic_resume_attempts SET reason_code = 'TOPIC_RESUME_DELIVERY_UNCERTAIN'");
    if (kind === "attempts") db.exec("UPDATE deliveries SET attempt_count = attempt_count + 1 WHERE part_key = 'status-anchor'");
    if (kind === "follower") db.exec("UPDATE deliveries SET attempt_count = 1 WHERE part_key <> 'status-anchor'");
    await expect(f.runtime.retryFailed(f.input)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(db.prepare("SELECT count(*) FROM topic_resume_attempt_history").pluck().get()).toBe(0);
    f.runtime.dispose();
  });

  it("rolls back archive, version, and current token when replacing the attempt fails", async () => {
    const f = await failed();
    db.exec("CREATE TRIGGER reject_retry BEFORE UPDATE OF action_token ON topic_resume_attempts BEGIN SELECT RAISE(ABORT, 'test reject'); END");
    await expect(f.runtime.retryFailed(f.input)).rejects.toThrow();
    expect(store.getTopicResume(f.h.jobId)).toEqual(f.prior);
    expect(store.get(f.h.jobId)!.version).toBe(f.input.expectedVersion);
    expect(db.prepare("SELECT count(*) FROM topic_resume_attempt_history").pluck().get()).toBe(0);
    expect(f.calls).toEqual([]);
    f.runtime.dispose();
  });
  it("migrates a v9 ledger with its failed attempt intact and an empty archive", async () => {
    const f = await failed(); f.runtime.dispose(); store.close();
    db.exec("DROP TABLE topic_resume_attempt_history"); db.pragma("user_version = 9");
    const rows = db.prepare("SELECT * FROM topic_resume_attempts").all();
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    expect(db.pragma("user_version", { simple: true })).toBe(10);
    expect(db.prepare("SELECT * FROM topic_resume_attempts").all()).toEqual(rows);
    expect(store.getTopicResume(f.h.jobId)).toEqual(f.prior);
    expect(db.prepare("SELECT count(*) FROM topic_resume_attempt_history").pluck().get()).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("lets only one concurrent operator reserve and keeps the first snapshot immutable", async () => {
    const f = await failed();
    const results = await Promise.allSettled([f.runtime.retryFailed(f.input), f.runtime.retryFailed(f.input)]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.deliver).toHaveBeenCalledTimes(3);
    const archive = db.prepare("SELECT * FROM topic_resume_attempt_history").all();
    await f.runtime.reconcile();
    expect(db.prepare("SELECT * FROM topic_resume_attempt_history").all()).toEqual(archive);
    f.runtime.dispose();
  });

});
