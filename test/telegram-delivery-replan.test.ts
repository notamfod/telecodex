import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { DeliveryPart, TelegramJob } from "../src/telegram-job-store.js";
import {
  hashTelegramDeliveryPayload,
  type TelegramDeliveryPayload,
  type TelegramFallbackPart,
} from "../src/telegram-response-plan.js";

const START = 1_700_000_000_000;

interface Fixture {
  readonly job: TelegramJob;
  readonly primary: DeliveryPart;
  readonly databasePath: string;
}

describe("TelegramDeliveryReplan", () => {
  let directory: string;
  let databasePath: string;
  let stores: SqliteTelegramJobStore[];
  let sourceId: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-delivery-replan-"));
    databasePath = path.join(directory, "jobs.sqlite");
    stores = [];
    sourceId = 0;
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function open(): SqliteTelegramJobStore {
    const store = new SqliteTelegramJobStore(databasePath);
    stores.push(store);
    return store;
  }

  function delivering(store: SqliteTelegramJobStore, id: string): TelegramJob {
    const updateId = ++sourceId;
    const initial: TelegramJob = {
      schemaVersion: 1, id, version: 1, source: { botId: "bot", updateId }, attachments: [],
      phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
      dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
      acceptedAt: START, updatedAt: START, terminalAt: null, dismissedAt: null, retainUntil: null,
    };
    store.acceptUpdate({
      job: initial,
      sourcePayload: { botId: "bot", updateId, chatId: -1001, messageThreadId: 7, messageId: updateId },
      eventId: `${id}:accepted`,
      initialDeliveries: [{
        jobId: id, partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "pending",
        payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "Working" },
        contentHash: hashTelegramDeliveryPayload({ operation: "edit_text", chatId: -1001, messageId: 501, text: "Working" }),
        telegramMessageId: 501, updatedAt: START,
      }],
    });
    let job = store.transition({ jobId: id, eventId: `${id}:queued`, expectedVersion: 1,
      event: { schemaVersion: 1, type: "job.queued", eventAt: START + 1 } });
    job = store.transition({ jobId: id, eventId: `${id}:dispatch`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.started", eventAt: START + 2, dispatch: {
        id: `${id}:dispatch`, threadId: "thread-1", previousTurnId: null, attempt: 1,
        startedAt: START + 2, transportWriteState: "written", nextAttemptAt: null,
      } } });
    job = store.transition({ jobId: id, eventId: `${id}:turn`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "turn.started", eventAt: START + 3,
        identifiers: { turnId: "turn-1" } } });
    return store.transition({ jobId: id, eventId: `${id}:completed`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "turn.completed", eventAt: START + 4,
        turnResult: { schemaVersion: 1, content: [{ kind: "text", text: "answer" }] } } });
  }

  function fallback(primaryKey = "final:0000", count = 2): TelegramFallbackPart[] {
    return Array.from({ length: count }, (_, index) => ({
      partKey: `${primaryKey}:fallback:${String(index).padStart(4, "0")}`,
      kind: "final" as const,
      payload: {
        operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: `fallback ${index}`,
      },
    }));
  }

  function ordinary(store: SqliteTelegramJobStore, options: {
    readonly id?: string;
    readonly fallbackPrimaryKey?: string;
    readonly fallbackCount?: number;
    readonly laterKeys?: readonly string[];
    readonly state?: "pending" | "sending" | "delivered" | "uncertain" | "failed";
  } = {}): Fixture {
    const id = options.id ?? "ordinary";
    const beforePlan = delivering(store, id);
    const primaryKey = "final:0000";
    const rich: TelegramDeliveryPayload = {
      operation: "send_rich", chatId: -1001, messageThreadId: 7, markdown: "**rich**", media: [],
      fallbackParts: fallback(options.fallbackPrimaryKey ?? primaryKey, options.fallbackCount ?? 2),
    };
    const laterKeys = options.laterKeys ?? ["notice:later"];
    const responsePlan = [
      { partId: primaryKey, kind: "final" as const },
      ...laterKeys.map((partId) => ({ partId, kind: "notice" as const })),
    ];
    const parts = [
      {
        jobId: id, partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "pending" as const,
        payload: { operation: "edit_text" as const, chatId: -1001, messageId: 501, text: "Response follows" },
        contentHash: hashTelegramDeliveryPayload({ operation: "edit_text", chatId: -1001, messageId: 501, text: "Response follows" }),
        telegramMessageId: 501, updatedAt: START + 5,
      },
      {
        jobId: id, partKey: primaryKey, ordinal: 0, kind: "final", state: "pending" as const,
        payload: rich, contentHash: hashTelegramDeliveryPayload(rich), updatedAt: START + 5,
      },
      ...laterKeys.map((partKey, index) => {
        const payload = { operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: partKey };
        return { jobId: id, partKey, ordinal: index + 1, kind: "notice", state: "pending" as const,
          payload, contentHash: hashTelegramDeliveryPayload(payload), updatedAt: START + 5 };
      }),
    ];
    let job = store.installDeliveryPlan({
      jobId: id, eventId: `${id}:plan`, expectedVersion: beforePlan.version, eventAt: START + 5,
      responsePlan, parts,
    });
    const requestedState = options.state ?? "sending";
    if (requestedState === "sending") {
      job = store.transitionDeliveryAndProject({
        jobId: id, partKey: primaryKey, expectedJobVersion: job.version,
        expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
        eventId: `${id}:sending`, updatedAt: START + 6,
      }).job;
    } else if (requestedState !== "pending") {
      store.transitionDelivery({
        jobId: id, partKey: primaryKey, state: requestedState,
        attemptCount: 1, telegramMessageId: requestedState === "delivered" ? 700 : null,
        lastErrorCode: requestedState === "uncertain" ? "telegram_send_uncertain"
          : requestedState === "failed" ? "telegram_send_failed" : null,
        updatedAt: START + 6,
      });
    }
    const primary = store.listDeliveries(id).find((part) => part.partKey === primaryKey)!;
    return { job, primary, databasePath };
  }

  function anchor(store: SqliteTelegramJobStore, id = "anchor", collideFallback = false): Fixture {
    const beforePlan = delivering(store, id);
    const rich: TelegramDeliveryPayload = {
      operation: "edit_rich", chatId: -1001, messageId: 501, markdown: "**rich anchor**", media: [],
      fallbackParts: [{
        partKey: "final:0000:fallback:0000", kind: "final",
        payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "rich anchor" },
      }],
    };
    const collisionPayload = {
      operation: "send_text" as const, chatId: -1001, messageThreadId: 7, text: "collision",
    };
    const collisionParts = collideFallback ? [{
      jobId: id, partKey: "final:0000:fallback:0000", ordinal: 0, kind: "final", state: "pending" as const,
      payload: collisionPayload, contentHash: hashTelegramDeliveryPayload(collisionPayload), updatedAt: START + 5,
    }] : [];
    let job = store.installDeliveryPlan({
      jobId: id, eventId: `${id}:plan`, expectedVersion: beforePlan.version, eventAt: START + 5,
      responsePlan: collisionParts.map((part) => ({ partId: part.partKey, kind: part.kind })), parts: [{
        jobId: id, partKey: "status-anchor", ordinal: 0, kind: "status-anchor", state: "pending",
        payload: rich, contentHash: hashTelegramDeliveryPayload(rich), telegramMessageId: 501, updatedAt: START + 5,
      }, ...collisionParts],
    });
    job = store.transitionDeliveryAndProject({
      jobId: id, partKey: "status-anchor", expectedJobVersion: job.version,
      expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
      eventId: `${id}:sending`, updatedAt: START + 6,
    }).job;
    return {
      job,
      primary: store.listDeliveries(id).find((part) => part.partKey === "status-anchor")!,
      databasePath,
    };
  }

  function replace(store: SqliteTelegramJobStore, fixture: Fixture, overrides: Record<string, unknown> = {}) {
    return store.replaceRejectedRichDelivery({
      jobId: fixture.job.id, partKey: fixture.primary.partKey,
      expectedJobVersion: fixture.job.version, expectedState: "sending",
      expectedAttemptCount: fixture.primary.attemptCount, expectedContentHash: fixture.primary.contentHash,
      eventId: `${fixture.job.id}:replanned`, eventAt: START + 7,
      reasonCode: "rich_format_rejected", ...overrides,
    });
  }

  function snapshot(store: SqliteTelegramJobStore, jobId: string): string {
    return JSON.stringify({ job: store.get(jobId), rows: store.listDeliveries(jobId), events: store.listEvents(jobId) });
  }

  it("atomically replaces an ordinary sending rich part and survives reopen plus replay", () => {
    let store = open();
    const fixture = ordinary(store);
    const previousVersion = fixture.job.version;

    const result = replace(store, fixture);
    const ordinaryRows = result.deliveries.filter((part: DeliveryPart) => part.partKey !== "status-anchor");
    expect(result.job).toMatchObject({
      version: previousVersion + 1,
      responsePlan: [
        { partId: "final:0000:fallback:0000", kind: "final" },
        { partId: "final:0000:fallback:0001", kind: "final" },
        { partId: "notice:later", kind: "notice" },
      ],
      deliveries: [
        { partId: "final:0000:fallback:0000", state: "pending", attempts: 0 },
        { partId: "final:0000:fallback:0001", state: "pending", attempts: 0 },
        { partId: "notice:later", state: "pending", attempts: 0 },
      ],
    });
    expect(ordinaryRows.map((part: DeliveryPart) => [part.partKey, part.ordinal, part.state, part.attemptCount]))
      .toEqual([
        ["final:0000:fallback:0000", 0, "pending", 0],
        ["final:0000:fallback:0001", 1, "pending", 0],
        ["notice:later", 2, "pending", 0],
      ]);
    expect(store.listEvents(fixture.job.id).at(-1)?.event).toMatchObject({
      type: "delivery.replanned", expectedVersion: previousVersion, reasonCode: "rich_format_rejected",
    });
    store.close();
    store = open();
    expect(store.get(fixture.job.id)).toEqual(result.job);
    expect(store.listEvents(fixture.job.id).at(-1)?.event.type).toBe("delivery.replanned");
  });

  it("replans edit_rich status-anchor in place and preserves message and planned-anchor evidence", () => {
    const store = open();
    const fixture = anchor(store);
    const inspect = new Database(databasePath);
    const before = inspect.prepare("SELECT installed_at_ms FROM status_anchor_plans WHERE job_id = ?")
      .get(fixture.job.id) as { installed_at_ms: number };
    inspect.close();

    const result = replace(store, fixture, { reasonCode: "rich_method_unavailable" });
    expect(result.job.responsePlan).toEqual([]);
    expect(result.job.deliveries).toEqual([]);
    expect(result.deliveries).toEqual([expect.objectContaining({
      partKey: "status-anchor", state: "pending", attemptCount: 0, telegramMessageId: 501,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "rich anchor" },
    })]);
    const verify = new Database(databasePath, { readonly: true });
    try {
      const plan = verify.prepare("SELECT * FROM status_anchor_plans WHERE job_id = ?").get(fixture.job.id) as Record<string, unknown>;
      expect(plan.installed_at_ms).toBe(before.installed_at_ms);
      expect(JSON.parse(String(plan.payload_json))).toEqual(result.deliveries[0]?.payload);
      expect(plan.content_hash).toBe(result.deliveries[0]?.contentHash);
    } finally { verify.close(); }
  });

  it("rejects a status-anchor fallback key that collides with the ordinary global key space", () => {
    const store = open();
    const fixture = anchor(store, "anchor-collision", true);
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it.each([
    ["stale job version", { expectedJobVersion: 1 }],
    ["stale state", { expectedState: "pending" }],
    ["stale attempt", { expectedAttemptCount: 9 }],
    ["stale hash", { expectedContentHash: "f".repeat(64) }],
  ])("rolls back without an event for %s", (_name, overrides) => {
    const store = open();
    const fixture = ordinary(store);
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture, overrides)).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("atomically replaces an untouched pending rich part", () => {
    const store = open();
    const fixture = ordinary(store, { id: "pending-primary", state: "pending" });

    const result = replace(store, fixture, { expectedState: "pending" });

    expect(result.deliveries.some((part) => part.partKey === fixture.primary.partKey)).toBe(false);
    expect(result.deliveries.filter((part) => part.partKey.includes(":fallback:"))).toEqual([
      expect.objectContaining({ partKey: "final:0000:fallback:0000", state: "pending", attemptCount: 0 }),
      expect.objectContaining({ partKey: "final:0000:fallback:0001", state: "pending", attemptCount: 0 }),
    ]);
  });

  it("atomically replaces an untouched pending rich status anchor", () => {
    const store = open();
    const fixture = anchor(store, "pending-anchor");
    store.transitionDelivery({
      jobId: fixture.job.id, partKey: fixture.primary.partKey, state: "pending",
      attemptCount: fixture.primary.attemptCount, telegramMessageId: 501, updatedAt: START + 6,
    });
    const pending = store.listDeliveries(fixture.job.id).find((part) => part.partKey === "status-anchor")!;

    const result = replace(store, { ...fixture, primary: pending }, { expectedState: "pending" });

    expect(result.deliveries).toEqual([expect.objectContaining({
      partKey: "status-anchor", state: "pending", telegramMessageId: 501,
      payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "rich anchor" },
    })]);
  });

  it.each(["delivered", "uncertain", "failed"] as const)("rejects a %s primary row", (state) => {
    const store = open();
    const fixture = ordinary(store, { id: `state-${state}`, state });
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("rejects a missing primary row without appending an event", () => {
    const store = open();
    const fixture = ordinary(store, { id: "missing-primary" });
    const raw = new Database(databasePath);
    raw.prepare("DELETE FROM deliveries WHERE job_id = ? AND part_key = ?")
      .run(fixture.job.id, fixture.primary.partKey);
    raw.close();
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("rejects legacy and malformed persisted primary payloads without mutation", () => {
    const store = open();
    for (const [id, payload] of [
      ["legacy", { operation: "send_text", chatId: -1001, messageThreadId: 7, text: "legacy" }],
      ["malformed", { operation: "send_rich", chatId: -1001, messageThreadId: 7, markdown: "rich", media: [],
        fallbackParts: [{ partKey: "bad", kind: "final", payload: {
          operation: "send_text", chatId: -1001, messageThreadId: 7, text: "fallback",
        } }] }],
    ] as const) {
      const fixture = ordinary(store, { id });
      const raw = new Database(databasePath);
      const contentHash = id === "legacy" ? hashTelegramDeliveryPayload(payload) : fixture.primary.contentHash;
      raw.prepare("UPDATE deliveries SET payload_json = ?, content_hash = ? WHERE job_id = ? AND part_key = ?")
        .run(JSON.stringify(payload), contentHash, id, fixture.primary.partKey);
      raw.close();
      const current = { ...fixture, primary: { ...fixture.primary, contentHash } };
      const before = snapshot(store, id);
      expect(() => replace(store, current)).toThrow();
      expect(snapshot(store, id)).toBe(before);
    }
  });

  it.each([
    ["fallback prefix mismatch", { fallbackPrimaryKey: "final:9999" }],
    ["duplicate fallback key", { laterKeys: ["final:0000:fallback:0000"] }],
    ["response budget expansion", {
      laterKeys: Array.from({ length: 511 }, (_, index) => `notice:${String(index).padStart(4, "0")}`),
    }],
  ])("rolls back on %s", (_name, options) => {
    const store = open();
    const fixture = ordinary(store, { id: `invalid-${sourceId + 1}`, ...options });
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("rejects a duplicate event id and rolls back every replacement write", () => {
    const store = open();
    const fixture = ordinary(store);
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture, { eventId: `${fixture.job.id}:sending` })).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("rejects delivery.replanned through the public generic transition without mutation", () => {
    const store = open();
    const fixture = ordinary(store, { id: "public-transition" });
    const before = snapshot(store, fixture.job.id);
    expect(() => store.transition({
      jobId: fixture.job.id, eventId: "public-transition:bypass", expectedVersion: fixture.job.version,
      event: {
        schemaVersion: 1, type: "delivery.replanned", phase: "delivering", eventAt: START + 7,
        reasonCode: "rich_local_fallback", responsePlan: fixture.job.responsePlan!,
        deliveries: fixture.job.deliveries,
      },
    })).toThrow("Unsupported Telegram job event");
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it.each(["ordinary", "anchor"] as const)("bounds physical row reads for the %s path", (kind) => {
    const store = open();
    const fixture = kind === "ordinary" ? ordinary(store, { id: "overflow-ordinary" })
      : anchor(store, "overflow-anchor");
    const raw = new Database(databasePath);
    const count = (raw.prepare("SELECT count(*) AS count FROM deliveries WHERE job_id = ?")
      .get(fixture.job.id) as { count: number }).count;
    raw.prepare(`WITH RECURSIVE sequence(value) AS (
      SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < ?
    ) INSERT INTO deliveries (job_id, part_key, ordinal, kind, state, payload_json, content_hash,
      telegram_message_id, attempt_count, next_attempt_at_ms, last_error_code, updated_at_ms)
      SELECT job_id, 'overflow:' || printf('%04d', value), 1000 + value, 'notice', 'pending',
        payload_json, content_hash, NULL, 0, NULL, NULL, updated_at_ms
      FROM sequence CROSS JOIN (SELECT * FROM deliveries WHERE job_id = ? AND part_key = ?)`).run(
      515 - count, fixture.job.id, fixture.primary.partKey,
    );
    raw.prepare(`UPDATE deliveries SET payload_json = '{}'
      WHERE job_id = ? AND part_key = (SELECT part_key FROM deliveries WHERE job_id = ?
        ORDER BY ordinal DESC, part_key DESC LIMIT 1)`).run(fixture.job.id, fixture.job.id);
    raw.close();
    const rawSnapshot = () => {
      const inspect = new Database(databasePath, { readonly: true });
      try {
        return JSON.stringify({
          job: inspect.prepare("SELECT * FROM jobs WHERE id = ?").get(fixture.job.id),
          rows: inspect.prepare("SELECT * FROM deliveries WHERE job_id = ? ORDER BY ordinal, part_key").all(fixture.job.id),
          events: inspect.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence").all(fixture.job.id),
          statusPlan: inspect.prepare("SELECT * FROM status_anchor_plans WHERE job_id = ?").get(fixture.job.id),
        });
      } finally { inspect.close(); }
    };
    const before = rawSnapshot();
    expect(() => replace(store, fixture)).toThrow("Telegram response plan conflict");
    expect(rawSnapshot()).toBe(before);
  });

  it("rejects non-enumerable input fields instead of silently ignoring them", () => {
    const store = open();
    const fixture = ordinary(store, { id: "strict-input" });
    const input = {
      jobId: fixture.job.id, partKey: fixture.primary.partKey,
      expectedJobVersion: fixture.job.version, expectedState: "sending" as const,
      expectedAttemptCount: fixture.primary.attemptCount, expectedContentHash: fixture.primary.contentHash,
      eventId: "strict-input:replanned", eventAt: START + 7, reasonCode: "rich_local_fallback" as const,
    };
    Object.defineProperty(input, "hidden", { value: true });
    const before = snapshot(store, fixture.job.id);
    expect(() => store.replaceRejectedRichDelivery(input)).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("rejects a replan timestamp older than the persisted delivery row", () => {
    const store = open();
    const fixture = ordinary(store, { id: "stale-timestamp" });
    store.transitionDelivery({
      jobId: fixture.job.id, partKey: fixture.primary.partKey, state: "sending",
      attemptCount: fixture.primary.attemptCount, updatedAt: START + 10,
    });
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow();
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("allows exactly one of two stores racing on the same rich delivery to replace it", async () => {
    const store = open();
    const fixture = ordinary(store);
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const input = {
      jobId: fixture.job.id, partKey: fixture.primary.partKey,
      expectedJobVersion: fixture.job.version, expectedState: "sending" as const,
      expectedAttemptCount: fixture.primary.attemptCount, expectedContentHash: fixture.primary.contentHash,
      eventId: "race:replanned", eventAt: START + 7, reasonCode: "rich_format_rejected" as const,
    };
    const workerModule = new URL("./telegram-delivery-replan-worker.ts", import.meta.url).href;
    const bootstrap = `(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(workerModule)}); })();`;
    const workers = Array.from({ length: 2 }, () => new Worker(bootstrap, {
      eval: true, workerData: { databasePath, input, gate },
    }));
    try {
      await Promise.all(workers.map((worker) => once(worker, "message")));
      const results = workers.map((worker) => once(worker, "message"));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      const messages = (await Promise.all(results)).map(([message]) => message as { outcome: string; message?: string });
      expect(messages.filter((message) => message.outcome === "success")).toHaveLength(1);
      expect(messages.filter((message) => message.outcome === "failure")).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/^Telegram (job version|delivery) conflict$/) }),
      ]);
      expect(store.listEvents(fixture.job.id).filter((event) => event.event.type === "delivery.replanned")).toHaveLength(1);
      expect(store.listDeliveries(fixture.job.id).some((part) => part.partKey === fixture.primary.partKey)).toBe(false);
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  }, 20_000);

  it.each(["delivery", "job", "event"] as const)("rolls back if the %s write fails", (target) => {
    const store = open();
    const fixture = ordinary(store, { id: `fault-${target}` });
    const raw = new Database(databasePath);
    const timing = target === "event" ? "INSERT" : target === "job" ? "UPDATE" : "DELETE";
    const table = target === "event" ? "job_events" : target === "job" ? "jobs" : "deliveries";
    raw.exec(`CREATE TRIGGER block_${target} BEFORE ${timing} ON ${table} BEGIN SELECT RAISE(ABORT, 'fault'); END`);
    raw.close();
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow("fault");
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("restores the primary, ordinals, job, and event after a later fallback insert aborts", () => {
    const store = open();
    const fixture = ordinary(store, { id: "fault-second-fallback" });
    const raw = new Database(databasePath);
    raw.exec(`CREATE TRIGGER block_second_fallback BEFORE INSERT ON deliveries
      WHEN NEW.job_id = 'fault-second-fallback'
        AND NEW.part_key = 'final:0000:fallback:0001'
      BEGIN SELECT RAISE(ABORT, 'second fallback fault'); END`);
    raw.close();
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow("second fallback fault");
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });

  it("rolls back anchor, job, and event when the status plan write fails", () => {
    const store = open();
    const fixture = anchor(store, "fault-status-plan");
    const raw = new Database(databasePath);
    raw.exec("CREATE TRIGGER block_status_plan BEFORE UPDATE ON status_anchor_plans BEGIN SELECT RAISE(ABORT, 'fault'); END");
    raw.close();
    const before = snapshot(store, fixture.job.id);
    expect(() => replace(store, fixture)).toThrow("fault");
    expect(snapshot(store, fixture.job.id)).toBe(before);
  });
});
