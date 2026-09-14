import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { TelegramJobIngress } from "../src/telegram-job-ingress.js";

describe("task context completion guard", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let db: Database.Database;
  let ingress: TelegramJobIngress;
  let sequence: number;
  const context = { botId: "bot", chatId: -1001, messageThreadId: 7 };
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "task-guard-"));
    const file = path.join(directory, "jobs.sqlite");
    store = new SqliteTelegramJobStore(file);
    db = new Database(file);
    sequence = 0;
    ingress = new TelegramJobIngress({ store, materializationRoot: directory, downloadAttachment: async () => new Uint8Array() });
  });
  afterEach(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  function accept(overrides = {}) {
    return ingress.accept({ ...context, updateId: ++sequence, messageId: sequence,
      kind: "text", text: "task", attachment: null, retryOfJobId: null, ...overrides }).job;
  }
  function finish(id: string, extra = {}) {
    const row = db.prepare("SELECT projection_json FROM jobs WHERE id = ?").get(id) as { projection_json: string };
    const prior = JSON.parse(row.projection_json);
    const job = { ...prior, phase: "terminal", outcome: "aborted", terminalAt: prior.updatedAt, ...extra };
    db.prepare("UPDATE jobs SET projection_json = ? WHERE id = ?").run(JSON.stringify(job), id);
    db.prepare("UPDATE deliveries SET state = 'delivered', telegram_message_id = 10 WHERE job_id = ?").run(id);
  }
  it("allows an empty context and rejects active accepted work", () => {
    expect(store.readTaskContextGuard(context).safe).toBe(true);
    accept();
    expect(store.readTaskContextGuard(context)).toMatchObject({ safe: false, activeJobs: 1 });
  });
  it("uses the effective Inbox target, not the original Inbox topic", () => {
    accept({ messageThreadId: 2, targetContext: { chatId: -1001, messageThreadId: 7 } });
    expect(store.readTaskContextGuard(context).safe).toBe(false);
    expect(store.readTaskContextGuard({ ...context, messageThreadId: 2 }).safe).toBe(true);
    expect(store.readTaskContextGuard({ ...context, botId: "another" }).safe).toBe(true);
  });
  it("does not hide old work behind a dashboard limit or quarantine", () => {
    const old = accept();
    for (let i = 0; i < 105; i++) finish(accept().id);
    db.prepare("INSERT INTO job_quarantine VALUES (?, ?, ?, ?)").run(old.id, "test", "fingerprint", Date.now());
    expect(store.readTaskContextGuard(context)).toMatchObject({ safe: false, activeJobs: 1 });
  });
  it.each(["pending", "sending", "uncertain", "failed"])("blocks a terminal job with %s delivery", (state) => {
    const job = accept(); finish(job.id);
    db.prepare(`INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json, content_hash, updated_at_ms)
      VALUES (?, 'answer', 0, 'text', ?, '{}', 'hash', 1)`).run(job.id, state);
    expect(store.readTaskContextGuard(context)).toMatchObject({ safe: false, unresolvedDeliveries: 1 });
  });
  it("blocks an unmaterialized answer plan and accepts its confirmed delivery", () => {
    const job = accept(); finish(job.id, { outcome: "completed", responsePlan: [{ partId: "answer", kind: "final" }],
      deliveries: [{ partId: "answer", state: "delivered", attempts: 1, messageId: 12, deliveredAt: job.updatedAt }] });
    expect(store.readTaskContextGuard(context).safe).toBe(false);
    db.prepare(`INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json, content_hash, telegram_message_id, updated_at_ms)
      VALUES (?, 'answer', 0, 'text', 'delivered', '{}', 'hash', 12, 1)`).run(job.id);
    expect(store.readTaskContextGuard(context).safe).toBe(true);
  });
  it("fails closed for an unreadable projection", () => {
    const job = accept();
    db.prepare("UPDATE jobs SET projection_json = '{}' WHERE id = ?").run(job.id);
    expect(store.readTaskContextGuard(context).safe).toBe(false);
  });
  it("does not consider an invalid terminal outcome or missing delivery ID safe", () => {
    const job = accept(); finish(job.id, { outcome: null });
    expect(store.readTaskContextGuard(context).safe).toBe(false);
    finish(job.id);
    db.prepare("UPDATE deliveries SET telegram_message_id = NULL WHERE job_id = ?").run(job.id);
    expect(store.readTaskContextGuard(context).safe).toBe(false);
  });
  it("validates context identifiers", () => {
    expect(() => store.readTaskContextGuard({ ...context, messageThreadId: 0 })).toThrow();
    expect(() => store.readTaskContextGuard({ ...context, chatId: 0 })).toThrow();
  });
  it.each([{}, { chatId: -1001, messageThreadId: 7, targetContext: {} },
    { chatId: -1001, messageThreadId: "7" }, { chatId: -1001, messageThreadId: 7, targetContext: null }])(
    "blocks when a durable destination cannot be trusted: %j", (source) => {
      const job = accept();
      db.prepare("UPDATE inbox_updates SET source_json = ? WHERE job_id = ?").run(JSON.stringify(source), job.id);
      expect(store.readTaskContextGuard(context).safe).toBe(false);
    });
});
