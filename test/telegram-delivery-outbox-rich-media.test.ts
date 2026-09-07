import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  TelegramDeliveryApiError,
  TelegramDeliveryLocalError,
  type TelegramDeliveryPayload,
} from "../src/telegram-delivery-outbox.js";
import {
  SqliteTelegramJobStore,
  type DeliveryPart,
  type ProjectedDeliveryTransitionInput,
} from "../src/telegram-job-store.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import { TelegramReliabilityFixture } from "./telegram-reliability-fixtures.js";

describe("TelegramDeliveryOutbox rich media preflight", () => {
  let fixture: TelegramReliabilityFixture;

  beforeEach(() => { fixture = new TelegramReliabilityFixture(); });
  afterEach(() => { fixture.close(); });

  function richRow(jobId: string): DeliveryPart {
    const row = fixture.store.listDeliveries(jobId).find((part) => {
      const operation = (part.payload as { operation?: unknown }).operation;
      return operation === "edit_rich" || operation === "send_rich";
    });
    if (!row) throw new Error("Missing rich delivery row");
    return row;
  }

  function observingStore(states: ProjectedDeliveryTransitionInput["state"][]): SqliteTelegramJobStore {
    return new Proxy(fixture.store, {
      get(target, property) {
        if (property === "transitionDeliveryAndProject") {
          return (input: ProjectedDeliveryTransitionInput) => {
            states.push(input.state);
            return target.transitionDeliveryAndProject(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function installMissingEditRich(jobId: string): void {
    const job = fixture.delivering(jobId);
    fixture.outbox({ attachmentRoot: path.join(fixture.directory, "attachments") }).installPlan(job.id, {
      chatId: -100_001, messageThreadId: 7, anchorMessageId: 501,
    });
    const payload: TelegramDeliveryPayload = {
      operation: "edit_rich", chatId: -100_001, messageId: 501,
      markdown: "![](tg://photo?id=image)", media: [{ id: "image", path: "missing.png" }],
      fallbackParts: [{
        partKey: "final:0000:fallback:0000", kind: "final",
        payload: { operation: "edit_text", chatId: -100_001, messageId: 501, text: "image" },
      }],
    };
    const contentHash = hashTelegramDeliveryPayload(payload);
    const database = new Database(fixture.databasePath);
    try {
      database.prepare("UPDATE deliveries SET payload_json = ?, content_hash = ? WHERE job_id = ? AND part_key = 'status-anchor'")
        .run(JSON.stringify(payload), contentHash, job.id);
      database.prepare("UPDATE status_anchor_plans SET payload_json = ?, content_hash = ? WHERE job_id = ?")
        .run(JSON.stringify(payload), contentHash, job.id);
    } finally { database.close(); }
  }

  it.each(["missing", "symlink"] as const)(
    "fails %s rich media before sending or calling Telegram",
    async (kind) => {
      const attachmentRoot = path.join(fixture.directory, "attachments");
      const outputs = path.join(attachmentRoot, "outputs");
      mkdirSync(outputs, { recursive: true });
      if (kind === "symlink") {
        const outside = path.join(fixture.directory, "outside.png");
        writeFileSync(outside, "outside");
        symlinkSync(outside, path.join(outputs, "chart.png"));
      }
      const job = fixture.delivering(`rich-media-${kind}`, [
        { kind: "text", text: "chart" },
        { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
      ]);
      const states: ProjectedDeliveryTransitionInput["state"][] = [];
      const worker = fixture.outbox({ attachmentRoot, store: observingStore(states) });
      worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
      fixture.store.transitionDelivery({
        jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
        telegramMessageId: 501, updatedAt: fixture.now,
      });

      await worker.pump();

      expect(fixture.telegram.calls).toEqual([]);
      expect(states).toEqual(["failed"]);
      expect(richRow(job.id)).toMatchObject({ state: "failed", lastErrorCode: "delivery_media_unavailable" });
      expect(fixture.store.get(job.id)?.attention).toMatchObject({
        kind: "required", code: "delivery_media_unavailable",
      });
    },
  );

  it("fails missing edit_rich media before its state becomes sending", async () => {
    const attachmentRoot = path.join(fixture.directory, "attachments");
    mkdirSync(attachmentRoot, { recursive: true });
    installMissingEditRich("edit-rich-media");
    const states: ProjectedDeliveryTransitionInput["state"][] = [];

    await fixture.outbox({ attachmentRoot, store: observingStore(states) }).pump();

    expect(fixture.telegram.calls).toEqual([]);
    expect(states).toEqual(["failed"]);
    expect(richRow("edit-rich-media")).toMatchObject({ state: "failed", lastErrorCode: "delivery_media_unavailable" });
  });

  it("preserves stored fallback-failure attention before checking missing media", async () => {
    const attachmentRoot = path.join(fixture.directory, "attachments");
    mkdirSync(attachmentRoot, { recursive: true });
    installMissingEditRich("attention-before-media");
    const before = richRow("attention-before-media");
    const job = fixture.store.get(before.jobId)!;
    fixture.store.transition({
      jobId: job.id, eventId: "attention-before-media:event", expectedVersion: job.version,
      event: { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: fixture.now,
        deliveries: job.deliveries, attention: {
          kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"],
        } },
    });

    await fixture.outbox({ attachmentRoot }).pump();

    expect(fixture.telegram.calls).toEqual([]);
    expect(richRow(before.jobId)).toEqual(before);
    expect(fixture.store.get(before.jobId)?.attention).toEqual({
      kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"],
    });
  });

  it("preserves stored fallback-failure attention before checking a corrupt payload hash", async () => {
    installMissingEditRich("attention-before-corrupt-hash");
    const job = fixture.store.get("attention-before-corrupt-hash")!;
    fixture.store.transition({
      jobId: job.id, eventId: "attention-before-corrupt-hash:event", expectedVersion: job.version,
      event: { schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: fixture.now,
        deliveries: job.deliveries, attention: {
          kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"],
        } },
    });
    const database = new Database(fixture.databasePath);
    try {
      database.prepare("UPDATE deliveries SET content_hash = ? WHERE job_id = ? AND part_key = 'status-anchor'")
        .run("0".repeat(64), job.id);
    } finally { database.close(); }
    const before = richRow(job.id);

    await fixture.outbox().pump();

    expect(fixture.telegram.calls).toEqual([]);
    expect(richRow(job.id)).toEqual(before);
    expect(fixture.store.get(job.id)?.attention).toEqual({
      kind: "required", code: "telegram_rich_fallback_failed", actions: ["inspect", "retry"],
    });
  });

  it("replans pending rich with missing media when the method circuit is already open", async () => {
    const attachmentRoot = path.join(fixture.directory, "attachments");
    mkdirSync(attachmentRoot, { recursive: true });
    const worker = fixture.outbox({ attachmentRoot });
    const first = fixture.delivering("circuit-media-a");
    worker.installPlan(first.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
    installMissingEditRich("circuit-media-b");
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "edit_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "method_unavailable");
      }
      return { messageId: 501 };
    };

    await worker.pump();

    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toEqual([
      "edit_rich", "edit_text", "edit_text",
    ]);
    expect(fixture.store.get("circuit-media-b")).toMatchObject({ phase: "terminal", outcome: "completed" });
  });

  it("fails a post-lease rich local media error as definitely not sent", async () => {
    const attachmentRoot = path.join(fixture.directory, "attachments");
    mkdirSync(attachmentRoot, { recursive: true });
    const job = fixture.delivering("rich-local-after-lease");
    const worker = fixture.outbox({ attachmentRoot });
    worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
    fixture.telegram.behavior = async () => { throw new TelegramDeliveryLocalError(); };

    await worker.pump();

    expect(fixture.telegram.calls).toHaveLength(1);
    expect(richRow(job.id)).toMatchObject({
      state: "failed", attemptCount: 0, lastErrorCode: "delivery_media_unavailable",
    });
    expect(fixture.store.get(job.id)?.attention).toMatchObject({
      kind: "required", code: "delivery_media_unavailable",
    });
  });

  it("fails a replanned legacy send_media local error without marking it uncertain", async () => {
    const attachmentRoot = path.join(fixture.directory, "attachments");
    const outputs = path.join(attachmentRoot, "outputs");
    mkdirSync(outputs, { recursive: true });
    writeFileSync(path.join(outputs, "chart.png"), "chart");
    const job = fixture.delivering("fallback-media-local", [
      { kind: "text", text: "chart" },
      { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
    ]);
    const worker = fixture.outbox({ attachmentRoot });
    worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: null });
    fixture.telegram.behavior = async (payload) => {
      if (payload.operation === "send_rich") {
        throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      }
      if (payload.operation === "send_media") throw new TelegramDeliveryLocalError();
      return { messageId: 800 };
    };

    await worker.pump();

    const media = fixture.store.listDeliveries(job.id)
      .find((part) => (part.payload as { operation?: unknown }).operation === "send_media");
    expect(fixture.telegram.calls.map(({ payload }) => payload.operation)).toContain("send_media");
    expect(media).toMatchObject({
      state: "failed", attemptCount: 0, lastErrorCode: "delivery_media_unavailable",
    });
    expect(fixture.store.get(job.id)?.attention).toMatchObject({
      kind: "required", code: "delivery_media_unavailable",
    });
  });

  it("rejects a rich supplemental part before persisting any response plan rows", () => {
    const job = fixture.delivering("supplemental-rich-rejected");
    const before = fixture.store.listDeliveries(job.id);

    expect(() => fixture.outbox().installPlan(
      job.id,
      { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 },
      undefined,
      { supplementalParts: [{
        partKey: "custom-rich", kind: "notice",
        payload: {
          operation: "send_rich", chatId: -100_001, messageThreadId: 7,
          markdown: "supplemental", media: [],
          fallbackParts: [{
            partKey: "final:0042:fallback:0000", kind: "notice",
            payload: {
              operation: "send_text", chatId: -100_001, messageThreadId: 7, text: "fallback",
            },
          }],
        },
      } as never] },
    )).toThrow("Invalid supplemental Telegram response part");
    expect(fixture.store.listDeliveries(job.id)).toEqual(before);
  });

  it("preserves manual attention and a second failed delivery while retrying one exact part", async () => {
    const job = fixture.delivering("retry-two-failed-manual");
    const worker = fixture.outbox();
    worker.installPlan(
      job.id,
      { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 },
      undefined,
      { supplementalParts: [{
        partKey: "confirmation", kind: "notice",
        payload: {
          operation: "send_text", chatId: -100_001, messageThreadId: 7, text: "confirm",
        },
      }] },
    );
    fixture.store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: fixture.now,
    });
    const targets = fixture.store.listDeliveries(job.id).filter((part) => part.partKey !== "status-anchor");
    expect(targets).toHaveLength(2);
    let current = fixture.store.get(job.id)!;
    for (const [index, target] of targets.entries()) {
      const sending = fixture.store.transitionDeliveryAndProject({
        jobId: job.id, partKey: target.partKey, expectedJobVersion: current.version,
        expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
        eventId: `retry-two-failed:sending:${index}`, updatedAt: fixture.now,
      });
      const failed = fixture.store.transitionDeliveryAndProject({
        jobId: job.id, partKey: target.partKey, expectedJobVersion: sending.job.version,
        expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
        lastErrorCode: "telegram_permanent",
        attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
        eventId: `retry-two-failed:failed:${index}`, updatedAt: fixture.now,
      });
      current = failed.job;
    }
    fixture.store.transition({
      jobId: job.id, eventId: "retry-two-failed:manual", expectedVersion: current.version,
      event: {
        schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: fixture.now,
        deliveries: current.deliveries,
        attention: { kind: "required", code: "manual_hold", actions: ["inspect"] },
      },
    });
    fixture.telegram.behavior = async () => ({ messageId: 800 });

    await worker.retryFailed(job.id, targets[0]!.partKey);

    expect(fixture.store.listDeliveries(job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ partKey: targets[0]!.partKey, state: "delivered" }),
      expect.objectContaining({ partKey: targets[1]!.partKey, state: "failed" }),
    ]));
    expect(fixture.store.get(job.id)?.attention).toEqual({
      kind: "required", code: "manual_hold", actions: ["inspect"],
    });
  });

  it("conflicts a retry when manual attention races its delivery snapshot before CAS", async () => {
    const job = fixture.delivering("retry-attention-cas");
    const installer = fixture.outbox();
    installer.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
    const pending = fixture.store.listDeliveries(job.id)[0]!;
    const current = fixture.store.get(job.id)!;
    const sending = fixture.store.transitionDeliveryAndProject({
      jobId: job.id, partKey: pending.partKey, expectedJobVersion: current.version,
      expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
      eventId: "retry-attention-cas:sending", updatedAt: fixture.now,
    });
    const failed = fixture.store.transitionDeliveryAndProject({
      jobId: job.id, partKey: pending.partKey, expectedJobVersion: sending.job.version,
      expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
      lastErrorCode: "telegram_permanent",
      attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
      eventId: "retry-attention-cas:failed", updatedAt: fixture.now,
    });
    let raced = false;
    const racingStore = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "listDeliveries") return (jobId: string) => {
          const rows = target.listDeliveries(jobId);
          if (!raced && jobId === job.id) {
            const before = target.get(job.id)!;
            target.transition({
              jobId: job.id, eventId: "retry-attention-cas:manual", expectedVersion: before.version,
              event: {
                schemaVersion: 1, type: "delivery.changed", phase: "delivering", eventAt: fixture.now,
                deliveries: before.deliveries,
                attention: { kind: "required", code: "manual_hold", actions: ["inspect"] },
              },
            });
            raced = true;
          }
          return rows;
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(fixture.outbox({ store: racingStore }).retryFailed(job.id, pending.partKey))
      .rejects.toThrow("Telegram job version conflict");

    expect(raced).toBe(true);
    expect(fixture.telegram.calls).toEqual([]);
    expect(fixture.store.listDeliveries(job.id)[0]).toEqual(failed.delivery);
    expect(fixture.store.get(job.id)?.attention).toEqual({
      kind: "required", code: "manual_hold", actions: ["inspect"],
    });
  });

  it("quarantines a persisted control-bearing media path before Telegram and never marks it uncertain", async () => {
    const job = fixture.delivering("persisted-control-media", [
      { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
    ]);
    const worker = fixture.outbox();
    worker.installPlan(job.id, { chatId: -100_001, messageThreadId: 7, anchorMessageId: 501 });
    fixture.store.transitionDelivery({
      jobId: job.id, partKey: "status-anchor", state: "delivered", attemptCount: 1,
      telegramMessageId: 501, updatedAt: fixture.now,
    });
    const media = fixture.store.listDeliveries(job.id).find((part) => part.partKey !== "status-anchor")!;
    const malformed = { ...media.payload as object, path: "outputs/bad\nreport.pdf" };
    const payloadJson = JSON.stringify(malformed);
    const contentHash = createHash("sha256").update(payloadJson).digest("hex");
    const database = new Database(fixture.databasePath);
    try {
      database.prepare("UPDATE deliveries SET payload_json = ?, content_hash = ? WHERE job_id = ? AND part_key = ?")
        .run(payloadJson, contentHash, job.id, media.partKey);
    } finally { database.close(); }

    await worker.pump();

    expect(fixture.telegram.calls).toEqual([]);
    expect(fixture.store.listDeliveries(job.id).find((part) => part.partKey === media.partKey)).toMatchObject({
      state: "failed", attemptCount: 0, lastErrorCode: "delivery_payload_corrupt",
    });
    expect(fixture.store.listDeliveries(job.id).some((part) => part.state === "uncertain")).toBe(false);
  });
});
