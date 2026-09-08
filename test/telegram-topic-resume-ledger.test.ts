import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";
import { SqliteTelegramJobStore, type TelegramJob } from "../src/telegram-job-store.js";
import { hashTelegramDeliveryPayload } from "../src/telegram-response-plan.js";
import { planTelegramTopicRecovery } from "../src/telegram-topic-recovery.js";
import {
  hashTelegramTopicResumeTopology,
  planTelegramTopicResume,
  type TelegramTopicResumeCandidate,
} from "../src/telegram-topic-resume.js";
import type {
  TelegramTopicResumeExternalEligibilitySnapshot,
  TelegramTopicResumeState,
} from "../src/telegram-topic-resume-ledger.js";

const NOW = 1_700_000_000_000;
const DESTINATION = { chatId: -100_123, messageThreadId: 41 } as const;
const THREAD_ID = "018f0000-0000-7000-8000-000000000001";
const token = (value: number) => value.toString(16).padStart(64, "0");

describe("Telegram existing topic resume ledger", () => {
  let directory: string;
  let databasePath: string;
  let stores: SqliteTelegramJobStore[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-resume-"));
    databasePath = path.join(directory, "jobs.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function open(readOnly = false): SqliteTelegramJobStore {
    const store = new SqliteTelegramJobStore(databasePath, { readOnly });
    stores.push(store);
    return store;
  }

  it("reserves one exact candidate, advances the job once, and supports read-only inspection", () => {
    const fixture = resumable(open());
    const result = fixture.store.reserveTopicResume(reserveInput(fixture, 1, "resume-reserve"));

    expect(result.job).toMatchObject({
      version: fixture.job.version + 1,
      attention: { kind: "required", code: "TOPIC_RESUME_PROBE_IN_FLIGHT", actions: ["inspect"] },
    });
    expect(result.resume).toEqual({
      jobId: fixture.job.id,
      actionToken: token(1),
      state: "probe_in_flight",
      mode: "standard",
      anchorAttemptBaseline: 1,
      recoveryJobVersionBaseline: fixture.job.version,
      deliveryTopologyHash: hashTelegramTopicResumeTopology(
        fixture.job,
        fixture.store.listDeliveries(fixture.job.id),
      ),
      destination: DESTINATION,
      reservedJobVersion: fixture.job.version,
      currentJobVersion: fixture.job.version + 1,
      nextAttemptAt: null,
      reasonCode: null,
      startedAt: NOW + 30,
      updatedAt: NOW + 30,
    });
    expect(fixture.store.getTopicResume(fixture.job.id)).toEqual(result.resume);
    expect(fixture.store.listTopicResumes(["probe_in_flight"])).toEqual([result.resume]);
    expect(fixture.store.getStatusAnchorPlan(fixture.job.id)).toEqual(fixture.anchorPlan);
    expect(fixture.store.hasJobQuarantine(fixture.job.id)).toBe(false);

    const readOnly = open(true);
    expect(readOnly.getTopicResume(fixture.job.id)).toEqual(result.resume);
    expect(() => readOnly.transitionTopicResume({
      jobId: fixture.job.id,
      expectedVersion: result.job.version,
      actionToken: token(1),
      expectedState: "probe_in_flight",
      state: "delivery_handoff",
      externalEligibilitySnapshot: externalSnapshot(),
      reasonCode: null,
      nextAttemptAt: null,
      updatedAt: NOW + 31,
    })).toThrow(/readonly/i);
  });

  it("rejects reservation when the historical anchor attempt count is not exactly one", () => {
    const fixture = resumable(open());
    raw(databasePath, (db) => db.prepare(`UPDATE deliveries SET attempt_count = 2
      WHERE job_id = ? AND part_key = 'status-anchor'`).run(fixture.job.id));
    const before = snapshot(databasePath, fixture.job.id);
    const input = reserveInput(fixture, 1);

    expect(() => fixture.store.reserveTopicResume({
      ...input,
      candidate: { ...input.candidate, anchorAttemptCount: 2 },
    })).toThrow();
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it("persists the current recovery version and topology in the reservation transaction", () => {
    const fixture = resumable(open());
    const recovery = fixture.store.getTopicRecovery(fixture.job.id)!;
    const expectedTopology = hashTelegramTopicResumeTopology(
      fixture.job,
      fixture.store.listDeliveries(fixture.job.id),
    );

    const result = reserve(fixture, 1);

    expect(result.resume).toMatchObject({
      mode: "standard",
      anchorAttemptBaseline: 1,
      recoveryJobVersionBaseline: recovery.currentJobVersion,
      deliveryTopologyHash: expectedTopology,
      reservedJobVersion: fixture.job.version,
    });
    expect(result.resume.recoveryJobVersionBaseline).toBe(result.resume.reservedJobVersion);
  });

  it("atomically reserves warning mode with the exact baseline and trailing recovery", () => {
    const fixture = resumable(open());
    raw(databasePath, (db) => db.prepare(`UPDATE deliveries SET attempt_count = 4
      WHERE job_id = ? AND part_key = 'status-anchor'`).run(fixture.job.id));
    const original = reserveInput(fixture, 1);
    const result = fixture.store.reserveTopicResume({
      ...original, allowedModes: new Set(["warning_replay"]),
      candidate: { ...original.candidate, mode: "warning_replay", anchorAttemptCount: 4 },
    });
    expect(result.resume).toMatchObject({
      mode: "warning_replay", anchorAttemptBaseline: 4,
      recoveryJobVersionBaseline: fixture.job.version,
      currentJobVersion: result.job.version,
    });
    expect(() => fixture.store.reserveTopicResume(original)).toThrow();
  });

  it.each([undefined, new Set(), new Set(["warning_replay"] as const)])(
    "rejects standard reservation without exact allowed-mode authority", (allowedModes) => {
      const fixture = resumable(open());
      const before = snapshot(databasePath, fixture.job.id);
      expect(() => fixture.store.reserveTopicResume({ ...reserveInput(fixture, 1), allowedModes }))
        .toThrow("Telegram topic resume conflict");
      expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
    },
  );

  it("allows exactly the prescribed state transitions", () => {
    const legal: Readonly<Record<TelegramTopicResumeState, readonly TelegramTopicResumeState[]>> = {
      probe_in_flight: ["probe_retry_wait", "reopen_in_flight", "delivery_handoff", "failed"],
      probe_retry_wait: ["probe_in_flight"],
      reopen_in_flight: ["reopen_retry_wait", "reopen_unknown", "delivery_handoff", "failed"],
      reopen_retry_wait: ["reopen_in_flight"],
      reopen_unknown: ["reopen_unknown", "delivery_handoff"],
      delivery_handoff: [],
      complete: [],
      failed: [],
    };
    let sequence = 10;
    for (const [from, targets] of Object.entries(legal) as Array<[TelegramTopicResumeState, readonly TelegramTopicResumeState[]]>) {
      for (const state of targets) {
        const fixture = resumable(open(), `job-${sequence}`, sequence);
        const reserved = reserve(fixture, sequence++);
        seedResumeState(databasePath, fixture.job.id, from, reserved.job.version, NOW + 30);
        const input = transitionInput(fixture.job.id, reserved.job.version, reserved.resume.actionToken, from, state);
        const result = fixture.store.transitionTopicResume(input);
        expect(result.resume.state).toBe(state);
        expect(result.job.version).toBe(reserved.job.version + 1);
        expect(result.resume.currentJobVersion).toBe(result.job.version);
      }
    }

    const terminalStates: TelegramTopicResumeState[] = ["delivery_handoff", "complete", "failed"];
    for (const from of terminalStates) {
      const fixture = resumable(open(), `job-${sequence}`, sequence);
      const reserved = reserve(fixture, sequence++);
      seedResumeState(databasePath, fixture.job.id, from, reserved.job.version, NOW + 30);
      const before = snapshot(databasePath, fixture.job.id);
      expect(() => fixture.store.transitionTopicResume({
        ...transitionInput(fixture.job.id, reserved.job.version, reserved.resume.actionToken, from, "probe_in_flight"),
      })).toThrow("Telegram topic resume conflict");
      expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
    }
  });

  it.each([
    ["stale version", (fixture: ReservedFixture) => ({ expectedVersion: fixture.reserved.job.version - 1 })],
    ["wrong token", () => ({ actionToken: token(999) })],
    ["wrong prior state", () => ({ expectedState: "reopen_in_flight" as const })],
    ["invalid deadline", () => ({ nextAttemptAt: NOW + 31 })],
    ["invalid reason", () => ({ reasonCode: "TOPIC_RESUME_REOPEN_FAILED" as const })],
  ])("rolls back a transition with %s", (_name, mutate) => {
    const fixture = reserved(open());
    const before = snapshot(databasePath, fixture.job.id);
    const input = {
      ...transitionInput(
        fixture.job.id,
        fixture.reserved.job.version,
        fixture.reserved.resume.actionToken,
        "probe_in_flight",
        "delivery_handoff",
      ),
      ...mutate(fixture),
    };
    expect(() => fixture.store.transitionTopicResume(input)).toThrow();
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it("permits only a bounded 429 deadline on the reopen_unknown self-transition", () => {
    const fixture = reserved(open());
    seedResumeState(databasePath, fixture.job.id, "reopen_unknown", fixture.reserved.job.version, NOW + 30);
    const result = fixture.store.transitionTopicResume({
      jobId: fixture.job.id,
      expectedVersion: fixture.reserved.job.version,
      actionToken: fixture.reserved.resume.actionToken,
      expectedState: "reopen_unknown",
      state: "reopen_unknown",
      reasonCode: "TOPIC_RESUME_PROBE_RATE_LIMITED",
      nextAttemptAt: NOW + 40,
      updatedAt: NOW + 31,
    });
    expect(result.resume).toMatchObject({
      state: "reopen_unknown",
      reasonCode: "TOPIC_RESUME_PROBE_RATE_LIMITED",
      nextAttemptAt: NOW + 40,
    });
  });

  it("does not leave a rate-limited reopen_unknown state before its safe-probe deadline", () => {
    const fixture = reserved(open());
    seedResumeState(databasePath, fixture.job.id, "reopen_unknown", fixture.reserved.job.version, NOW + 30);
    const waiting = fixture.store.transitionTopicResume({
      jobId: fixture.job.id, expectedVersion: fixture.reserved.job.version,
      actionToken: fixture.reserved.resume.actionToken, expectedState: "reopen_unknown",
      state: "reopen_unknown", reasonCode: "TOPIC_RESUME_PROBE_RATE_LIMITED",
      nextAttemptAt: NOW + 50, updatedAt: NOW + 31,
    });
    const before = snapshot(databasePath, fixture.job.id);
    expect(() => fixture.store.transitionTopicResume({
      jobId: fixture.job.id, expectedVersion: waiting.job.version,
      actionToken: waiting.resume.actionToken, expectedState: "reopen_unknown",
      state: "delivery_handoff", reasonCode: null, nextAttemptAt: null, updatedAt: NOW + 49,
      externalEligibilitySnapshot: externalSnapshot(),
    })).toThrow("Telegram topic resume conflict");
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it.each(["reopen_in_flight", "delivery_handoff"] as const)(
    "requires a fresh external snapshot before entering %s",
    (state) => {
      const fixture = reserved(open());
      const before = snapshot(databasePath, fixture.job.id);
      const { externalEligibilitySnapshot: _omitted, ...input } = transitionInput(
        fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
        "probe_in_flight", state,
      );
      expect(() => fixture.store.transitionTopicResume(input)).toThrow();
      expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
    },
  );

  const revalidationFailures: Array<[
    string,
    (fixture: ReservedFixture) => void,
    Partial<TelegramTopicResumeExternalEligibilitySnapshot>?,
  ]> = [
    ["source destination", (fixture) => rewriteSourceDestination(databasePath, fixture.job.id)],
    ["recovery state", (fixture) => raw(databasePath, (db) => db.prepare(`UPDATE topic_recoveries
      SET state = 'unknown', reason_code = 'TOPIC_RECOVERY_UNKNOWN' WHERE job_id = ?`).run(fixture.job.id))],
    ["recovery topic", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE topic_recoveries SET new_message_thread_id = 42 WHERE job_id = ?",
    ).run(fixture.job.id))],
    ["recovery destination", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE topic_recoveries SET old_message_thread_id = old_message_thread_id + 1 WHERE job_id = ?",
    ).run(fixture.job.id))],
    ["recovery version", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE topic_recoveries SET current_job_version = current_job_version - 1 WHERE job_id = ?",
    ).run(fixture.job.id))],
    ["recovery version advanced after reservation", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE topic_recoveries SET current_job_version = current_job_version + 1 WHERE job_id = ?",
    ).run(fixture.job.id))],
    ["quarantine", (fixture) => insertQuarantine(databasePath, fixture.job.id)],
    ["anchor plan raw JSON", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE status_anchor_plans SET payload_json = ' ' || payload_json WHERE job_id = ?",
    ).run(fixture.job.id))],
    ["anchor plan hash", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE status_anchor_plans SET content_hash = ? WHERE job_id = ?",
    ).run("0".repeat(64), fixture.job.id))],
    ["anchor state", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE deliveries SET state = 'pending' WHERE job_id = ? AND part_key = 'status-anchor'",
    ).run(fixture.job.id))],
    ["anchor baseline attempt", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE deliveries SET attempt_count = 2 WHERE job_id = ? AND part_key = 'status-anchor'",
    ).run(fixture.job.id))],
    ["follower state", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE deliveries SET state = 'sending' WHERE job_id = ? AND part_key = 'final:0000'",
    ).run(fixture.job.id))],
    ["follower raw JSON", (fixture) => raw(databasePath, (db) => db.prepare(`UPDATE deliveries
      SET payload_json = ' ' || payload_json WHERE job_id = ? AND part_key = 'final:0000'`).run(fixture.job.id))],
    ["follower hash", (fixture) => raw(databasePath, (db) => db.prepare(`UPDATE deliveries
      SET content_hash = ? WHERE job_id = ? AND part_key = 'final:0000'`).run("0".repeat(64), fixture.job.id))],
    ["follower destination", (fixture) => rewriteFollowerDestination(databasePath, fixture.job.id, false)],
    ["rich fallback destination", (fixture) => rewriteFollowerDestination(databasePath, fixture.job.id, true)],
    ["follower ordering", (fixture) => raw(databasePath, (db) => db.prepare(`UPDATE deliveries SET ordinal =
      CASE part_key WHEN 'final:0000' THEN 1 ELSE 0 END
      WHERE job_id = ? AND part_key IN ('final:0000', 'notice:0001')`).run(fixture.job.id))],
    ["persisted topology hash", (fixture) => raw(databasePath, (db) => db.prepare(
      "UPDATE topic_resume_attempts SET delivery_topology_hash = ? WHERE job_id = ?",
    ).run("0".repeat(64), fixture.job.id))],
    ["missing follower", (fixture) => raw(databasePath, (db) => db.prepare(
      "DELETE FROM deliveries WHERE job_id = ? AND part_key = 'notice:0001'",
    ).run(fixture.job.id))],
    ["thread", () => undefined, { thread: null }],
    ["forum", () => undefined, { forumChatId: DESTINATION.chatId - 1 }],
    ["binding", () => undefined, { hasThreadTopicBinding: false }],
  ];
  it.each((["reopen_in_flight", "delivery_handoff"] as const).flatMap((state) =>
    revalidationFailures.map(([name, mutate, external]) => [state, name, mutate, external] as const)))(
    "rolls back %s when current %s evidence no longer matches",
    (state, _name, mutate, external = {}) => {
      const fixture = reserved(open());
      mutate(fixture);
      const before = snapshot(databasePath, fixture.job.id);
      const input = {
        ...transitionInput(fixture.job.id, fixture.reserved.job.version,
          fixture.reserved.resume.actionToken, "probe_in_flight", state),
        externalEligibilitySnapshot: externalSnapshot(external),
      };
      expect(() => fixture.store.transitionTopicResume(input)).toThrow("Telegram topic resume conflict");
      expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
    },
  );

  it.each([
    ["missing thread", { thread: null }],
    ["forum mismatch", { forumChatId: DESTINATION.chatId - 1 }],
    ["missing binding", { hasThreadTopicBinding: false }],
  ])("rejects a stale external snapshot with %s without a partial reservation", (_name, override) => {
    const fixture = resumable(open());
    const before = snapshot(databasePath, fixture.job.id);
    expect(() => fixture.store.reserveTopicResume(reserveInput(fixture, 1, undefined, override)))
      .toThrow("Telegram topic resume conflict");
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it("propagates a database read failure instead of converting it to an eligibility conflict", () => {
    const fixture = resumable(open());
    const before = snapshot(databasePath, fixture.job.id);
    const internal = fixture.store as unknown as {
      statement(sql: string): Database.Statement;
    };
    const original = internal.statement.bind(fixture.store);
    internal.statement = (sql) => {
      if (sql.startsWith("SELECT source_json FROM inbox_updates")) throw new Error("fixture database read failed");
      return original(sql);
    };
    expect(() => reserve(fixture, 1)).toThrow("fixture database read failed");
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it("allows only one winner when two worker stores reserve after the same gate", async () => {
    const fixture = resumable(open());
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerModule = new URL("./telegram-topic-resume-worker.ts", import.meta.url).href;
    const bootstrap = `(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(workerModule)}); })();`;
    const workers = [1, 2].map((sequence) => new Worker(bootstrap, {
      eval: true,
      workerData: { databasePath, reserveInput: reserveInput(fixture, sequence), gate },
    }));
    try {
      await Promise.all(workers.map((worker) => once(worker, "message")));
      const results = workers.map((worker) => once(worker, "message"));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      const messages = (await Promise.all(results)).map(([message]) => message as {
        readonly outcome: "success" | "failure";
        readonly message?: string;
      });
      expect(messages.filter((message) => message.outcome === "success")).toHaveLength(1);
      expect(messages.filter((message) => message.outcome === "failure"))
        .toEqual([expect.objectContaining({ message: "Telegram topic resume conflict" })]);
      expect(fixture.store.listTopicResumes(["probe_in_flight"])).toHaveLength(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 20_000);

  it.each([
    ["source JSON", "UPDATE inbox_updates SET source_json = ' ' || source_json WHERE job_id = ?"],
    ["anchor plan JSON", "UPDATE status_anchor_plans SET payload_json = ' ' || payload_json WHERE job_id = ?"],
    ["delivery payload JSON", "UPDATE deliveries SET payload_json = ' ' || payload_json WHERE job_id = ? AND part_key = 'final:0000'"],
    ["delivery content hash", "UPDATE deliveries SET content_hash = lower(hex(randomblob(32))) WHERE job_id = ? AND part_key = 'final:0000'"],
    ["delivery state", "UPDATE deliveries SET state = 'sending' WHERE job_id = ? AND part_key = 'final:0000'"],
    ["recovery row", "UPDATE topic_recoveries SET current_job_version = current_job_version - 1 WHERE job_id = ?"],
    ["destination", "UPDATE deliveries SET payload_json = replace(payload_json, '\"messageThreadId\":41', '\"messageThreadId\":42') WHERE job_id = ? AND part_key = 'notice:0001'"],
  ])("rejects changed %s without a partial reservation", (_name, sql) => {
    const fixture = resumable(open());
    raw(databasePath, (db) => db.prepare(sql).run(fixture.job.id));
    const before = snapshot(databasePath, fixture.job.id);
    expect(() => reserve(fixture, 1)).toThrow();
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it("rejects a quarantine race without a partial reservation", () => {
    const fixture = resumable(open());
    raw(databasePath, (db) => db.prepare(`INSERT INTO job_quarantine
      (job_id, reason_code, fingerprint, quarantined_at_ms) VALUES (?, ?, ?, ?)`).run(
      fixture.job.id, "TEST", "f".repeat(64), NOW + 29,
    ));
    const before = snapshot(databasePath, fixture.job.id);
    expect(() => reserve(fixture, 1)).toThrow();
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it("leaves delivery handoff unchanged until delivery evidence becomes terminal", () => {
    const fixture = reserved(open());
    const handoff = fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id,
      fixture.reserved.job.version,
      fixture.reserved.resume.actionToken,
      "probe_in_flight",
      "delivery_handoff",
    ));
    raw(databasePath, (db) => db.prepare(`UPDATE deliveries SET updated_at_ms = ?
      WHERE job_id = ? AND part_key = 'status-anchor'`).run(handoff.resume.updatedAt, fixture.job.id));
    const before = snapshot(databasePath, fixture.job.id);

    expect(fixture.store.settleTopicResumeDelivery({
      jobId: fixture.job.id,
      expectedVersion: handoff.job.version,
      actionToken: handoff.resume.actionToken,
      updatedAt: NOW + 32,
    })).toEqual(handoff.resume);
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it.each(["failed", "uncertain"] as const)(
    "does not treat an attempt-one %s anchor as post-handoff after an unrelated job advance",
    (state) => {
      const fixture = reserved(open());
      const handoff = fixture.store.transitionTopicResume(transitionInput(
        fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
        "probe_in_flight", "delivery_handoff",
      ));
      raw(databasePath, (db) => db.prepare(`UPDATE deliveries
        SET state = ?, attempt_count = 1, updated_at_ms = ?
        WHERE job_id = ? AND part_key = 'status-anchor'`).run(
        state, handoff.resume.updatedAt, fixture.job.id,
      ));
      const advanced = fixture.store.transition({
        jobId: fixture.job.id,
        eventId: `unrelated-job-advance-${state}`,
        expectedVersion: handoff.job.version,
        event: { schemaVersion: 1, type: "delivery.changed", eventAt: handoff.resume.updatedAt },
      });
      const before = snapshot(databasePath, fixture.job.id);

      expect(() => fixture.store.settleTopicResumeDelivery({
        jobId: fixture.job.id,
        expectedVersion: advanced.version,
        actionToken: handoff.resume.actionToken,
        updatedAt: NOW + 32,
      })).toThrow("Telegram topic resume conflict");
      expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
    },
  );

  it.each([
    ["failed", "TOPIC_RESUME_DELIVERY_FAILED"],
    ["uncertain", "TOPIC_RESUME_DELIVERY_UNCERTAIN"],
  ] as const)("settles a causally later same-millisecond %s anchor without changing the job", (state, reasonCode) => {
    const fixture = reserved(open());
    const handoff = fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
      "probe_in_flight", "delivery_handoff",
    ));
    const sending = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "status-anchor", expectedJobVersion: handoff.job.version,
      expectedState: "failed", expectedAttemptCount: 1, state: "sending", attemptCount: 1,
      allowFailedRetry: true, eventId: `anchor-retry-${state}`, updatedAt: NOW + 31,
    });
    const terminal = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "status-anchor", expectedJobVersion: sending.job.version,
      expectedState: "sending", expectedAttemptCount: 1, state, attemptCount: 2,
      lastErrorCode: "telegram_permanent", eventId: `anchor-${state}`, updatedAt: NOW + 31,
    });
    const jobBefore = fixture.store.get(fixture.job.id);

    expect(fixture.store.settleTopicResumeDelivery({
      jobId: fixture.job.id, expectedVersion: terminal.job.version,
      actionToken: handoff.resume.actionToken, updatedAt: NOW + 31,
    })).toMatchObject({ state: "failed", reasonCode, currentJobVersion: terminal.job.version });
    expect(fixture.store.get(fixture.job.id)).toEqual(jobBefore);
  });

  it("does not settle an anchor whose attempt count jumps beyond the stored baseline", () => {
    const fixture = reserved(open());
    const handoff = fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
      "probe_in_flight", "delivery_handoff",
    ));
    const sending = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "status-anchor", expectedJobVersion: handoff.job.version,
      expectedState: "failed", expectedAttemptCount: 1, state: "sending", attemptCount: 1,
      allowFailedRetry: true, eventId: "anchor-jump-sending", updatedAt: NOW + 31,
    });
    const failed = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "status-anchor", expectedJobVersion: sending.job.version,
      expectedState: "sending", expectedAttemptCount: 1, state: "failed", attemptCount: 3,
      lastErrorCode: "telegram_permanent", eventId: "anchor-jump-failed", updatedAt: NOW + 32,
    });
    const before = snapshot(databasePath, fixture.job.id);

    expect(fixture.store.settleTopicResumeDelivery({
      jobId: fixture.job.id, expectedVersion: failed.job.version,
      actionToken: handoff.resume.actionToken, updatedAt: NOW + 33,
    })).toMatchObject({ state: "delivery_handoff", currentJobVersion: failed.job.version });
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it.each([
    ["failed", 0, "TOPIC_RESUME_FOLLOWER_FAILED"],
    ["failed", 1, "TOPIC_RESUME_FOLLOWER_FAILED"],
    ["uncertain", 1, "TOPIC_RESUME_FOLLOWER_UNCERTAIN"],
  ] as const)("settles a causally later %s follower at attempt %s", (state, attemptCount, reasonCode) => {
    const fixture = reserved(open());
    const handoff = fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
      "probe_in_flight", "delivery_handoff",
    ));
    const anchorSending = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "status-anchor", expectedJobVersion: handoff.job.version,
      expectedState: "failed", expectedAttemptCount: 1, state: "sending", attemptCount: 1,
      allowFailedRetry: true, eventId: `follower-${state}-anchor-sending`, updatedAt: NOW + 31,
    });
    const anchorDelivered = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "status-anchor", expectedJobVersion: anchorSending.job.version,
      expectedState: "sending", expectedAttemptCount: 1, state: "delivered", attemptCount: 2,
      telegramMessageId: 71, eventId: `follower-${state}-anchor-delivered`, updatedAt: NOW + 32,
    });
    const followerSending = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "final:0000", expectedJobVersion: anchorDelivered.job.version,
      expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
      eventId: `follower-${state}-sending`, updatedAt: NOW + 33,
    });
    const followerTerminal = guardedDeliveryTransition(fixture.store, {
      jobId: fixture.job.id, partKey: "final:0000", expectedJobVersion: followerSending.job.version,
      expectedState: "sending", expectedAttemptCount: 0, state, attemptCount,
      lastErrorCode: state === "failed" ? "telegram_permanent" : "telegram_send_uncertain",
      eventId: `follower-${state}-terminal`, updatedAt: NOW + 34,
    });
    const jobBefore = fixture.store.get(fixture.job.id);

    expect(fixture.store.settleTopicResumeDelivery({
      jobId: fixture.job.id, expectedVersion: followerTerminal.job.version,
      actionToken: handoff.resume.actionToken, updatedAt: NOW + 35,
    })).toMatchObject({ state: "failed", reasonCode, currentJobVersion: followerTerminal.job.version });
    expect(fixture.store.get(fixture.job.id)).toEqual(jobBefore);
  });

  it("settles complete only after exactly three delivered rows and terminal completion", () => {
    const fixture = reserved(open());
    const handoff = fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
      "probe_in_flight", "delivery_handoff",
    ));
    const terminal = deliverAllAndFinalize(fixture.store, handoff.job);
    const jobBefore = fixture.store.get(fixture.job.id);

    expect(fixture.store.settleTopicResumeDelivery({
      jobId: fixture.job.id, expectedVersion: terminal.version,
      actionToken: handoff.resume.actionToken, updatedAt: NOW + 50,
    })).toMatchObject({ state: "complete", reasonCode: null, currentJobVersion: terminal.version });
    expect(fixture.store.get(fixture.job.id)).toEqual(jobBefore);
  });

  it("does not complete after the delivered topology drifts", () => {
    const fixture = reserved(open());
    const handoff = fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
      "probe_in_flight", "delivery_handoff",
    ));
    const terminal = deliverAllAndFinalize(fixture.store, handoff.job);
    raw(databasePath, (db) => {
      const row = db.prepare("SELECT payload_json FROM deliveries WHERE job_id = ? AND part_key = ?")
        .get(fixture.job.id, "notice:0001") as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as { text: string };
      payload.text = "changed after delivery";
      db.prepare(`UPDATE deliveries SET payload_json = ?, content_hash = ?
        WHERE job_id = ? AND part_key = ?`).run(
        JSON.stringify(payload), hashTelegramDeliveryPayload(payload), fixture.job.id, "notice:0001",
      );
    });
    const before = snapshot(databasePath, fixture.job.id);

    expect(() => fixture.store.settleTopicResumeDelivery({
      jobId: fixture.job.id, expectedVersion: terminal.version,
      actionToken: handoff.resume.actionToken, updatedAt: NOW + 50,
    })).toThrow("Telegram topic resume conflict");
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it("does not complete when delivered rows drift from the job projection", () => {
    const fixture = reserved(open());
    const handoff = fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id, fixture.reserved.job.version, fixture.reserved.resume.actionToken,
      "probe_in_flight", "delivery_handoff",
    ));
    const terminal = deliverAllAndFinalize(fixture.store, handoff.job);
    raw(databasePath, (db) => db.prepare(`UPDATE deliveries SET attempt_count = attempt_count + 1
      WHERE job_id = ? AND part_key = ?`).run(fixture.job.id, "notice:0001"));
    const before = snapshot(databasePath, fixture.job.id);

    expect(() => fixture.store.settleTopicResumeDelivery({
      jobId: fixture.job.id, expectedVersion: terminal.version,
      actionToken: handoff.resume.actionToken, updatedAt: NOW + 50,
    })).toThrow("Telegram topic resume conflict");
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });

  it.each([
    ["unknown state", "state = 'unexpected'"],
    ["bad token", "action_token = 'A'"],
    ["unknown mode", "resume_mode = 'other'"],
    ["zero anchor baseline", "anchor_attempt_baseline = 0"],
    ["non-standard anchor baseline", "anchor_attempt_baseline = 2"],
    ["wrong standard recovery baseline", "recovery_job_version_baseline = reserved_job_version - 1"],
    ["future recovery baseline", "recovery_job_version_baseline = reserved_job_version + 1"],
    ["uppercase topology hash", "delivery_topology_hash = upper(delivery_topology_hash)"],
    ["short topology hash", "delivery_topology_hash = 'abc'"],
    ["version regression", "current_job_version = reserved_job_version - 1"],
    ["timestamp regression", "updated_at_ms = started_at_ms - 1"],
    ["invalid destination", "message_thread_id = 0"],
    ["invalid deadline", "state = 'probe_retry_wait', reason_code = 'TOPIC_RESUME_PROBE_RATE_LIMITED', next_attempt_at_ms = updated_at_ms"],
    ["invalid reason combination", "state = 'probe_in_flight', reason_code = 'TOPIC_RESUME_SOURCE_MISSING'"],
  ])("strictly rejects a resume row with %s", (_name, assignment) => {
    const fixture = reserved(open());
    raw(databasePath, (db) => db.exec(`UPDATE topic_resume_attempts SET ${assignment}`));
    expect(() => fixture.store.getTopicResume(fixture.job.id)).toThrow("Malformed Telegram topic resume");
  });

  it("decodes a structurally valid warning replay record without reserving one", () => {
    const fixture = reserved(open());
    raw(databasePath, (db) => db.prepare(`UPDATE topic_resume_attempts SET
      resume_mode = 'warning_replay', anchor_attempt_baseline = 2,
      recovery_job_version_baseline = reserved_job_version - 1
      WHERE job_id = ?`).run(fixture.job.id));

    expect(fixture.store.getTopicResume(fixture.job.id)).toMatchObject({
      mode: "warning_replay",
      anchorAttemptBaseline: 2,
      recoveryJobVersionBaseline: fixture.reserved.resume.reservedJobVersion - 1,
    });
  });

  it("does not let a structurally valid warning replay row authorize a Task 1 transition", () => {
    const fixture = reserved(open());
    raw(databasePath, (db) => db.prepare(`UPDATE topic_resume_attempts SET
      resume_mode = 'warning_replay', anchor_attempt_baseline = 2,
      recovery_job_version_baseline = reserved_job_version - 1
      WHERE job_id = ?`).run(fixture.job.id));
    const warning = fixture.store.getTopicResume(fixture.job.id)!;
    const before = snapshot(databasePath, fixture.job.id);

    expect(() => fixture.store.transitionTopicResume(transitionInput(
      fixture.job.id, warning.currentJobVersion, warning.actionToken,
      "probe_in_flight", "delivery_handoff",
    ))).toThrow("Telegram topic resume conflict");
    expect(snapshot(databasePath, fixture.job.id)).toEqual(before);
  });
});

interface ResumeFixture {
  readonly store: SqliteTelegramJobStore;
  readonly job: TelegramJob;
  readonly source: TelegramWorkSource;
  readonly anchorPlan: { readonly payload: unknown; readonly contentHash: string };
  readonly thread: CodexThreadRecord;
  readonly candidate: TelegramTopicResumeCandidate;
}

type ReservedFixture = ResumeFixture & {
  readonly reserved: ReturnType<SqliteTelegramJobStore["reserveTopicResume"]>;
};

function reserved(store: SqliteTelegramJobStore): ReservedFixture {
  const fixture = resumable(store);
  return { ...fixture, reserved: reserve(fixture, 1) };
}

function reserve(fixture: ResumeFixture, sequence: number) {
  return fixture.store.reserveTopicResume(reserveInput(fixture, sequence));
}

function reserveInput(
  fixture: ResumeFixture,
  sequence: number,
  eventId = `resume-reserve-${sequence}`,
  externalOverride: Partial<{
    readonly thread: CodexThreadRecord | null;
    readonly forumChatId: number;
    readonly hasThreadTopicBinding: boolean;
  }> = {},
) {
  return {
    candidate: fixture.candidate,
    allowedModes: new Set(["standard"] as const),
    externalEligibilitySnapshot: {
      thread: fixture.thread,
      forumChatId: DESTINATION.chatId,
      hasThreadTopicBinding: true,
      ...externalOverride,
    },
    eventId,
    actionToken: token(sequence),
    eventAt: NOW + 30,
  };
}

function externalSnapshot(
  override: Partial<TelegramTopicResumeExternalEligibilitySnapshot> = {},
): TelegramTopicResumeExternalEligibilitySnapshot {
  return {
    thread: {
      id: THREAD_ID, title: "Resume topic", cwd: "/work/telecodex", model: null, modelProvider: null,
      createdAt: new Date(0), updatedAt: new Date(0), firstUserMessage: "request",
    },
    forumChatId: DESTINATION.chatId,
    hasThreadTopicBinding: true,
    ...override,
  };
}

function transitionInput(
  jobId: string,
  expectedVersion: number,
  actionToken: string,
  expectedState: TelegramTopicResumeState,
  state: TelegramTopicResumeState,
) {
  const retry = state === "probe_retry_wait" || (state === "reopen_unknown" && expectedState === "reopen_unknown")
    ? "TOPIC_RESUME_PROBE_RATE_LIMITED"
    : state === "reopen_retry_wait" ? "TOPIC_RESUME_REOPEN_RATE_LIMITED" : null;
  const reasonCode = state === "failed"
    ? expectedState === "probe_in_flight" ? "TOPIC_RESUME_SOURCE_MISSING" : "TOPIC_RESUME_REOPEN_FAILED"
    : state === "reopen_unknown" && expectedState !== "reopen_unknown" ? "TOPIC_RESUME_REOPEN_UNKNOWN"
    : retry;
  const external = state === "reopen_in_flight" || state === "delivery_handoff"
    ? { externalEligibilitySnapshot: externalSnapshot() }
    : {};
  return {
    jobId,
    expectedVersion,
    actionToken,
    expectedState,
    state,
    reasonCode,
    nextAttemptAt: retry ? NOW + 40 : null,
    updatedAt: NOW + 31,
    ...external,
  } as const;
}

function seedResumeState(
  databasePath: string,
  jobId: string,
  state: TelegramTopicResumeState,
  version: number,
  updatedAt: number,
): void {
  const values = state === "probe_retry_wait"
    ? ["TOPIC_RESUME_PROBE_RATE_LIMITED", updatedAt + 1]
    : state === "reopen_retry_wait" ? ["TOPIC_RESUME_REOPEN_RATE_LIMITED", updatedAt + 1]
    : state === "reopen_unknown" ? ["TOPIC_RESUME_REOPEN_UNKNOWN", null]
    : state === "failed" ? ["TOPIC_RESUME_REOPEN_FAILED", null]
    : [null, null];
  raw(databasePath, (db) => db.prepare(`UPDATE topic_resume_attempts
    SET state = ?, current_job_version = ?, reason_code = ?, next_attempt_at_ms = ?, updated_at_ms = ?
    WHERE job_id = ?`).run(state, version, values[0], values[1], updatedAt, jobId));
}

function resumable(store: SqliteTelegramJobStore, id = "job-1", updateId = 1): ResumeFixture {
  const source: TelegramWorkSource = {
    botId: "bot", updateId, ...DESTINATION, messageId: updateId, kind: "text", text: "request",
    attachment: null, retryOfJobId: null,
  };
  let job: TelegramJob = {
    schemaVersion: 1, version: 1, id, source: { botId: source.botId, updateId }, attachments: [],
    phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt: NOW, updatedAt: NOW, terminalAt: null, dismissedAt: null, retainUntil: null,
  };
  store.acceptUpdate({ job, sourcePayload: source, eventId: `${id}:accepted` });
  job = store.transition({ jobId: id, eventId: `${id}:queued`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "job.queued", eventAt: NOW + 1 } });
  job = store.transition({ jobId: id, eventId: `${id}:dispatch`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "dispatch.started", eventAt: NOW + 2, dispatch: {
      id: `${id}:dispatch-id`, threadId: THREAD_ID, previousTurnId: null, attempt: 1,
      startedAt: NOW + 2, transportWriteState: "written", nextAttemptAt: null,
    } } });
  job = store.transition({ jobId: id, eventId: `${id}:started`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.started", eventAt: NOW + 3,
      identifiers: { turnId: `${id}:turn` }, codexEventAt: NOW + 3 } });
  job = store.transition({ jobId: id, eventId: `${id}:completed`, expectedVersion: job.version,
    event: { schemaVersion: 1, type: "turn.completed", eventAt: NOW + 4,
      codexEventAt: NOW + 4, turnResult: { schemaVersion: 1, content: [] } } });
  const anchor = { operation: "send_text" as const, ...DESTINATION, text: "Response follows." };
  const final = { operation: "send_rich" as const, ...DESTINATION, markdown: "# Result", media: [], fallbackParts: [{
    partKey: "final:0000:fallback:0000", kind: "final" as const,
    payload: { operation: "send_text" as const, ...DESTINATION, text: "Result" },
  }] };
  const notice = { operation: "send_text" as const, ...DESTINATION, text: "Notice" };
  job = store.installDeliveryPlan({
    jobId: id, expectedVersion: job.version, eventId: `${id}:plan`, eventAt: NOW + 5,
    responsePlan: [{ partId: "final:0000", kind: "final" }, { partId: "notice:0001", kind: "notice" }],
    parts: [planned(id, "status-anchor", 0, "status-anchor", anchor),
      planned(id, "final:0000", 0, "final", final), planned(id, "notice:0001", 1, "notice", notice)],
  });
  let moved = store.transitionDeliveryAndProject({
    jobId: id, partKey: "status-anchor", expectedJobVersion: job.version,
    expectedState: "pending", expectedAttemptCount: 0, state: "sending", attemptCount: 0,
    eventId: `${id}:anchor-sending`, updatedAt: NOW + 6,
  });
  moved = store.transitionDeliveryAndProject({
    jobId: id, partKey: "status-anchor", expectedJobVersion: moved.job.version,
    expectedState: "sending", expectedAttemptCount: 0, state: "failed", attemptCount: 1,
    lastErrorCode: "telegram_permanent", eventId: `${id}:anchor-failed`, updatedAt: NOW + 7,
    attention: { kind: "required", code: "telegram_delivery_failed", actions: ["inspect", "retry"] },
  });
  job = moved.job;
  const anchorPlan = { payload: anchor, contentHash: hashTelegramDeliveryPayload(anchor) };
  const thread: CodexThreadRecord = {
    id: THREAD_ID, title: "Resume topic", cwd: "/work/telecodex", model: null, modelProvider: null,
    createdAt: new Date(0), updatedAt: new Date(0), firstUserMessage: "request",
  };
  const recoveryCandidate = planTelegramTopicRecovery({
    job, source, deliveries: store.listDeliveries(id), anchorPlan, thread,
  });
  if (!recoveryCandidate) throw new Error("expected topic recovery candidate");
  const recoveryReserved = store.reserveTopicRecovery({
    candidate: recoveryCandidate, eventId: `${id}:recovery-reserve`, actionToken: token(updateId + 100), eventAt: NOW + 8,
  });
  store.failTopicRecovery({
    jobId: id, expectedVersion: recoveryReserved.job.version, actionToken: recoveryReserved.recovery.actionToken,
    reasonCode: "TOPIC_RECOVERY_FAILED", updatedAt: NOW + 9,
  });
  job = store.get(id)!;
  const recovery = store.getTopicRecovery(id)!;
  const candidate = planTelegramTopicResume({
    job, source, deliveries: store.listDeliveries(id), anchorPlan, thread, recovery,
    hasExistingAttempt: false, forumChatId: DESTINATION.chatId,
    hasThreadTopicBinding: true, quarantined: false,
  });
  if (!candidate) throw new Error("expected topic resume candidate");
  return { store, job, source, anchorPlan, thread, candidate };
}

function planned(jobId: string, partKey: string, ordinal: number, kind: string, payload: unknown) {
  return {
    jobId, partKey, ordinal, kind, state: "pending" as const, payload,
    contentHash: hashTelegramDeliveryPayload(payload), updatedAt: NOW + 5,
  };
}

function deliverAllAndFinalize(store: SqliteTelegramJobStore, initial: TelegramJob): TelegramJob {
  let job = initial;
  let updatedAt = NOW + 32;
  for (const partKey of ["status-anchor", "final:0000", "notice:0001"]) {
    const part = store.listDeliveries(job.id).find((candidate) => candidate.partKey === partKey)!;
    const sending = guardedDeliveryTransition(store, {
      jobId: job.id, partKey, expectedJobVersion: job.version,
      expectedState: part.state, expectedAttemptCount: part.attemptCount,
      state: "sending", attemptCount: part.attemptCount,
      allowFailedRetry: part.state === "failed", eventId: `${partKey}:sending`, updatedAt: updatedAt++,
    });
    const delivered = guardedDeliveryTransition(store, {
      jobId: job.id, partKey, expectedJobVersion: sending.job.version,
      expectedState: "sending", expectedAttemptCount: part.attemptCount,
      state: "delivered", attemptCount: part.attemptCount + 1, telegramMessageId: updatedAt,
      eventId: `${partKey}:delivered`, updatedAt: updatedAt++,
    });
    job = delivered.job;
  }
  if (job.phase === "terminal") return job;
  return store.finalizeDeliveredPlan({
    jobId: job.id, expectedVersion: job.version, eventId: "resume-finalize", eventAt: updatedAt,
  })!;
}

function rewriteSourceDestination(databasePath: string, jobId: string): void {
  raw(databasePath, (database) => {
    const row = database.prepare("SELECT source_json FROM inbox_updates WHERE job_id = ?")
      .get(jobId) as { source_json: string };
    const source = JSON.parse(row.source_json) as { messageThreadId: number };
    source.messageThreadId += 1;
    database.prepare("UPDATE inbox_updates SET source_json = ? WHERE job_id = ?")
      .run(JSON.stringify(source), jobId);
  });
}

function guardedDeliveryTransition(store: SqliteTelegramJobStore,
  input: Parameters<SqliteTelegramJobStore["transitionDeliveryAndProject"]>[0]) {
  const job = store.get(input.jobId)!;
  const part = store.listDeliveries(job.id).find((row) => row.partKey === input.partKey)!;
  const authorization = input.state === "sending"
    ? store.authorizeTopicResumeDelivery(job, part, input.updatedAt, externalSnapshot()) : null;
  return store.transitionDeliveryAndProject({ ...input,
    nextAttemptAt: input.state === "sending" ? input.updatedAt + 1_000 : null,
    lastErrorCode: input.state === "sending" || input.state === "delivered" ? null : input.lastErrorCode,
    expectedContentHash: part.contentHash,
    ...(authorization ? { topicResumeAuthorization: authorization } : {}),
  });
}

function rewriteFollowerDestination(databasePath: string, jobId: string, fallback: boolean): void {
  raw(databasePath, (database) => {
    const partKey = fallback ? "final:0000" : "notice:0001";
    const row = database.prepare("SELECT payload_json FROM deliveries WHERE job_id = ? AND part_key = ?")
      .get(jobId, partKey) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as {
      messageThreadId: number;
      fallbackParts?: Array<{ payload: { messageThreadId: number } }>;
    };
    if (fallback) payload.fallbackParts![0]!.payload.messageThreadId += 1;
    else payload.messageThreadId += 1;
    database.prepare(`UPDATE deliveries SET payload_json = ?, content_hash = ?
      WHERE job_id = ? AND part_key = ?`).run(
      JSON.stringify(payload), hashRawPayload(payload), jobId, partKey,
    );
  });
}

function hashRawPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function insertQuarantine(databasePath: string, jobId: string): void {
  raw(databasePath, (database) => database.prepare(`INSERT INTO job_quarantine
    (job_id, reason_code, fingerprint, quarantined_at_ms) VALUES (?, 'TEST', ?, ?)`)
    .run(jobId, "f".repeat(64), NOW + 31));
}

function snapshot(databasePath: string, jobId: string): unknown {
  return raw(databasePath, (db) => Object.fromEntries([
    "jobs", "inbox_updates", "job_events", "deliveries", "status_anchor_plans",
    "topic_recoveries", "topic_resume_attempts", "job_quarantine",
  ].map((table) => [table, db.prepare(`SELECT * FROM ${table} WHERE ${table === "jobs" ? "id" : "job_id"} = ? ORDER BY rowid`).all(jobId)])));
}

function raw<T>(databasePath: string, callback: (database: Database.Database) => T): T {
  const database = new Database(databasePath);
  try { return callback(database); }
  finally { database.close(); }
}
