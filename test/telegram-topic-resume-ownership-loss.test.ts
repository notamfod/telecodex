import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { vi } from "vitest";

import { TelegramDeliveryOutbox } from "../src/telegram-delivery-outbox.js";
import { createTelegramDeliveryTransport } from "../src/telegram-grammy-transport.js";
import { SqliteTelegramJobStore, type DeliveryPart } from "../src/telegram-job-store.js";
import { seedResumeDelivery } from "./telegram-topic-resume-delivery-fixture.js";
import { NOW } from "./telegram-topic-resume-runtime-fixture.js";

describe("resume ownership lost at an authorized delivery boundary", () => {
  let directory: string;
  let file: string;
  let store: SqliteTelegramJobStore;
  let db: Database.Database;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "topic-resume-ownership-loss-"));
    file = path.join(directory, "jobs.sqlite");
    store = new SqliteTelegramJobStore(file);
    db = new Database(file);
  });
  afterEach(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  it.each(["status-anchor", "final:0000"].flatMap((partKey) =>
    ["missing", "replacement_token", "replacement_terminal", "replacement_malformed"].map((mode) => ({ partKey, mode }))),
  )("quarantines $mode at the $partKey sending CAS without changing delivery evidence", async ({ partKey, mode }) => {
    const h = seedResumeDelivery(store);
    const expectedCalls = partKey === "status-anchor" ? 0 : 1;
    const snapshot = () => JSON.stringify((db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'job_quarantine' ORDER BY name",
    ).all() as { name: string }[]).map(({ name }) => {
      if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected fixture table");
      return [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()];
    }));
    let afterInterleaving: string | undefined;
    let beforeQuarantine: unknown;
    const authorize = store.authorizeTopicResumeDelivery.bind(store);
    vi.spyOn(store, "authorizeTopicResumeDelivery").mockImplementation((...args) => {
      const authorization = authorize(...args);
      if (authorization && authorization.part.partKey === partKey) {
        const raw = db.prepare("SELECT * FROM topic_resume_attempts WHERE job_id = ?").get(h.jobId) as Record<string, string | number | null>;
        db.transaction(() => {
          db.prepare("DELETE FROM topic_resume_attempts WHERE job_id = ?").run(h.jobId);
          if (mode !== "missing") {
            if (mode === "replacement_token") raw.action_token = "c".repeat(64);
            if (mode === "replacement_terminal") {
              raw.state = "failed"; raw.reason_code = "TOPIC_RESUME_EVIDENCE_STALE";
            }
            if (mode === "replacement_malformed") raw.anchor_attempt_baseline = -1;
            const columns = Object.keys(raw);
            db.prepare(`INSERT INTO topic_resume_attempts (${columns.join(", ")})
              VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(raw));
          }
        }).immediate();
        afterInterleaving = snapshot();
        beforeQuarantine = db.prepare("PRAGMA data_version").get();
      }
      return authorization;
    });
    await expect(h.outbox.pump()).resolves.toBeUndefined();
    expect(afterInterleaving).toBeDefined();
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    expect(store.listQuarantined(10)).toHaveLength(1);
    expect(store.listQuarantined(10)[0]).toMatchObject({
      reasonCode: "malformed_topic_resume_evidence", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot() === afterInterleaving).toBe(true);
    expect(db.prepare("PRAGMA data_version").get()).not.toEqual(beforeQuarantine);
    expect(h.deliver).toHaveBeenCalledTimes(expectedCalls);
    expect(h.scheduleWakeup).not.toHaveBeenCalled();
    expect(store.nextDeliveryWakeupAt()).toBeNull();

    store.close(); store = new SqliteTelegramJobStore(file);
    const restarted = new TelegramDeliveryOutbox({ ...h.options, store, now: () => NOW + 60_000 });
    const beforeRepeatedAttempts = db.prepare("PRAGMA data_version").get();
    await restarted.pump();
    await restarted.pump();
    for (const row of store.listDeliveries(h.jobId)) {
      await expect(restarted.retryFailed(h.jobId, row.partKey)).rejects.toThrow();
      await expect(restarted.sendAgainWithWarning(h.jobId, row.partKey)).rejects.toThrow();
    }
    expect(db.prepare("PRAGMA data_version").get()).toEqual(beforeRepeatedAttempts);
    expect(snapshot() === afterInterleaving).toBe(true);
    expect(h.deliver).toHaveBeenCalledTimes(expectedCalls);
    expect(h.scheduleWakeup).not.toHaveBeenCalled();
    expect(store.nextDeliveryWakeupAt()).toBeNull();

    const unrelated = seedResumeDelivery(store, 2);
    await new TelegramDeliveryOutbox({ ...h.options, store,
      topicResumeExternalSnapshot: (jobId) => jobId === unrelated.jobId ? unrelated.external : h.external }).pump();
    expect(store.get(unrelated.jobId)?.phase).toBe("terminal");
    expect(h.deliver).toHaveBeenCalledTimes(expectedCalls + 3);
    expect(store.hasJobQuarantine(h.jobId)).toBe(true);
  });

  it.each(["success_with_drift", "text_429", "wrapped_429", "missing_delivery", "rich_rejected"] as const)(
    "retains captured ownership and observed outcome after %s", async (mode) => {
      const h = seedResumeDelivery(store);
      const selectedKey = mode === "rich_rejected" ? "final:0000" : "status-anchor";
      const expectedCalls = mode === "rich_rejected" ? 2 : 1;
      const baseline = store.listDeliveries(h.jobId);
      let sending: DeliveryPart | undefined;
      const send = vi.fn(async () => {
        if (send.mock.calls.length === expectedCalls) {
          sending = store.listDeliveries(h.jobId).find((row) => row.partKey === selectedKey)!;
          expect(sending.state).toBe("sending");
          db.prepare("DELETE FROM topic_resume_attempts WHERE job_id = ?").run(h.jobId);
          if (mode === "success_with_drift") h.external.hasThreadTopicBinding = false;
          if (mode === "missing_delivery") {
            db.prepare("DELETE FROM deliveries WHERE job_id = ? AND part_key = ?").run(h.jobId, selectedKey);
          }
          if (mode === "text_429") throw new Error("429 Too Many Requests");
          if (mode === "wrapped_429") throw { error: { error_code: 429, parameters: { retry_after: 1 } } };
          if (mode === "rich_rejected") throw { error_code: 400, description: "Bad Request: can't parse rich message" };
        }
        return { message_id: 71 };
      });
      const telegram = createTelegramDeliveryTransport({ sendMessage: send, sendRichMessage: send } as never, directory);
      const options = { ...h.options, telegram };
      await expect(new TelegramDeliveryOutbox(options).pump()).resolves.toBeUndefined();
      const uncertain = mode === "text_429" || mode === "wrapped_429";
      const rejected = mode === "rich_rejected";
      const observed = { ...sending, state: uncertain ? "uncertain" : rejected ? "failed" : "delivered",
        attemptCount: sending!.attemptCount + 1, telegramMessageId: uncertain || rejected ? null : 71,
        nextAttemptAt: null, lastErrorCode: uncertain ? "telegram_send_uncertain"
          : rejected ? "telegram_rich_fallback_failed" : null };
      expect(store.listDeliveries(h.jobId).find((row) => row.partKey === selectedKey)).toEqual(observed);
      expect(store.hasTopicResume(h.jobId)).toBe(false);
      expect(store.hasJobQuarantine(h.jobId)).toBe(true);
      expect(store.listQuarantined(10)[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(store.listDeliveries(h.jobId).filter((row) => row.partKey !== selectedKey && row.partKey !== "status-anchor"))
        .toEqual(baseline.filter((row) => row.partKey !== selectedKey && row.partKey !== "status-anchor"));
      expect(send).toHaveBeenCalledTimes(expectedCalls);
      expect(h.scheduleWakeup).not.toHaveBeenCalled();
      expect(store.nextDeliveryWakeupAt()).toBeNull();

      store.close(); store = new SqliteTelegramJobStore(file);
      const restarted = new TelegramDeliveryOutbox({ ...options, store, now: () => NOW + 60_000 });
      const before = db.prepare("PRAGMA data_version").get();
      await restarted.pump();
      for (const row of store.listDeliveries(h.jobId)) {
        await expect(restarted.retryFailed(h.jobId, row.partKey)).rejects.toThrow();
        await expect(restarted.sendAgainWithWarning(h.jobId, row.partKey)).rejects.toThrow();
      }
      expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
      expect(store.listDeliveries(h.jobId).find((row) => row.partKey === selectedKey)).toEqual(observed);
      expect(send).toHaveBeenCalledTimes(expectedCalls);
      expect(store.nextDeliveryWakeupAt()).toBeNull();

      const unrelated = seedResumeDelivery(store, 2);
      await new TelegramDeliveryOutbox({ ...options, store,
        topicResumeExternalSnapshot: (jobId) => jobId === unrelated.jobId ? unrelated.external : h.external }).pump();
      expect(store.get(unrelated.jobId)?.phase).toBe("terminal");
      expect(send).toHaveBeenCalledTimes(expectedCalls + 3);
      expect(store.hasJobQuarantine(h.jobId)).toBe(true);
    },
  );
});
