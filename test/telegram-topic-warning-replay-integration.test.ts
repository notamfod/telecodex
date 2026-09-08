import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { vi } from "vitest";

import { TelegramDeliveryApiError, TelegramDeliveryOutbox, type TelegramDeliveryPayload } from "../src/telegram-delivery-outbox.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import { createTelegramReliabilityRuntime, type TelegramReliabilityRuntime,
  type TelegramReliabilityRuntimeOptions } from "../src/telegram-reliability-runtime.js";
import { hashTelegramTopicResumeTopology, type TelegramTopicResumeMode } from "../src/telegram-topic-resume.js";
import { seedResumeCandidate, seedResumeDelivery } from "./telegram-topic-resume-delivery-fixture.js";
import { NOW, DESTINATION } from "./telegram-topic-resume-runtime-fixture.js";

describe("warning replay persistence integration", () => {
  let directory: string;
  let file: string;
  let store: SqliteTelegramJobStore;
  let db: Database.Database;
  const runtimes: TelegramReliabilityRuntime[] = [];
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "topic-warning-integration-"));
    file = path.join(directory, "jobs.sqlite");
    store = new SqliteTelegramJobStore(file);
    db = new Database(file);
  });
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    db.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });

  function harness(settings: { closed?: boolean; empty?: boolean; warning?: boolean } = {}) {
    const seeded = settings.empty ? null : seedResumeCandidate(store, 1,
      { warning: settings.warning ?? true, multipart: true });
    let clock = NOW;
    let probe = async () => settings.closed ? "closed" as const : "live" as const;
    let sending = async (_payload: TelegramDeliveryPayload) => ({ messageId: 71 });
    let reopening = async () => true as const;
    const trace: string[] = [];
    const wakeups: { at: number; wake: () => void | Promise<void> }[] = [];
    const schedule = (at: number, wake: () => void | Promise<void>) => { wakeups.push({ at, wake }); };
    const options: TelegramReliabilityRuntimeOptions = {
      store,
      registry: { getOrCreate: vi.fn(async () => { throw new Error("unexpected dispatch"); }),
        updateMetadata: vi.fn(), setContextDefaults: vi.fn(), listContexts: () => [] },
      materializationRoot: path.join(directory, "materialized"),
      exactTurnReader: { request: vi.fn(async () => { throw new Error("unexpected inspection"); }) },
      guardian: { inspectThread: async () => {
        trace.push("reload");
        return { outcome: "ok", message: "ok", thread: {
          threadId: seeded!.external.thread.id, turnId: null, threadStatus: "idle", turnStatus: null,
          updatedAt: clock, itemCount: 0, lastItemType: null, source: "telecodex",
          canAcceptDirectInput: true, root: true,
        } };
      } },
      downloadAttachment: vi.fn(async () => new Uint8Array()),
      statusTransport: { send: vi.fn(async () => { trace.push("status"); return 71; }),
        edit: vi.fn(async () => { trace.push("status"); }) },
      classifyStatusTransportError: () => ({ disposition: "permanent" }),
      deliveryTransport: { deliver: async (payload) => {
        const job = store.get(seeded!.jobId)!;
        const resume = store.getTopicResume(job.id)!;
        expect(resume.state).toBe("delivery_handoff");
        expect(resume.currentJobVersion === job.version).toBe(true);
        expect(resume.deliveryTopologyHash === hashTelegramTopicResumeTopology(job, store.listDeliveries(job.id))).toBe(true);
        const rows = store.listDeliveries(job.id);
        const anchor = rows.find((row) => row.partKey === "status-anchor")!;
        trace.push(anchor.state === "sending" ? "anchor" : "follower");
        if (anchor.state !== "sending") {
          expect(anchor.state === "delivered" && anchor.attemptCount === resume.anchorAttemptBaseline + 1
            && anchor.telegramMessageId !== null && anchor.nextAttemptAt === null && anchor.lastErrorCode === null).toBe(true);
        }
        return sending(payload);
      } },
      now: () => clock,
      scheduleCoordinatorWakeup: schedule, scheduleDeliveryWakeup: schedule,
      topicResume: {
        allowedModes: new Set(["warning_replay"]), forumChatId: DESTINATION.chatId,
        classifyForumTopic: async () => {
          trace.push("probe");
          const resume = store.getTopicResume(seeded!.jobId)!;
          expect(resume.mode).toBe("warning_replay");
          expect(resume.anchorAttemptBaseline).toBe(2);
          expect(resume.recoveryJobVersionBaseline === store.getTopicRecovery(seeded!.jobId)!.currentJobVersion).toBe(true);
          expect(resume.deliveryTopologyHash === hashTelegramTopicResumeTopology(store.get(seeded!.jobId)!, store.listDeliveries(seeded!.jobId))).toBe(true);
          return probe();
        },
        reopenForumTopic: async () => {
          expect(store.getTopicResume(seeded!.jobId)?.state).toBe("reopen_in_flight");
          trace.push("reopen"); return reopening();
        },
        getThread: () => seeded!.external.thread,
        hasThreadTopicBinding: () => seeded!.external.hasThreadTopicBinding,
        now: () => clock, scheduleWakeup: schedule,
      },
    };
    return { seeded, trace, wakeups, options,
      setProbe: (value: typeof probe) => { probe = value; },
      setSending: (value: typeof sending) => { sending = value; },
      setReopen: (value: typeof reopening) => { reopening = value; },
      advanceTo: (value: number) => { clock = value; },
      start(modes: ReadonlySet<TelegramTopicResumeMode> = new Set(["warning_replay"])) {
        const runtime = createTelegramReliabilityRuntime({ ...options, store,
          topicResume: { ...options.topicResume!, allowedModes: modes } });
        runtimes.push(runtime); return runtime;
      },
    };
  }

  it.each([false, true])("replays exactly once after persisted reservation and dynamic fallback (closed=%s)", async (closed) => {
    const h = harness({ closed });
    const runtime = h.start();
    const snapshot = await runtime.loadDashboardReliability();
    const actions = snapshot.jobs[0]!.projection.actions.filter((action) => action.kind.startsWith("resume_existing_topic"));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("resume_existing_topic_warning");
    const action = actions[0]!;
    const before = db.prepare("PRAGMA data_version").get();
    for (const invalid of [{ ...action, kind: "resume_existing_topic" as const },
      { ...action, expectedVersion: action.expectedVersion - 1 }, { ...action, mode: "standard" }]) {
      await expect(runtime.runDashboardAction(invalid)).rejects.toThrow();
      expect(store.getTopicResume(h.seeded!.jobId)).toBeNull();
      expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
    }
    expect(h.trace.every((entry) => entry === "reload")).toBe(true);
    h.trace.length = 0;
    h.setProbe(async () => { throw { error_code: 429, parameters: { retry_after: 1 } }; });
    await runtime.runDashboardAction(action);
    expect(h.trace).toEqual(["reload", "probe"]);
    expect(store.getTopicResume(h.seeded!.jobId)?.state).toBe("probe_retry_wait");
    await expect(runtime.runDashboardAction(action)).rejects.toThrow();
    await runtime.dispose();
    store.close(); store = new SqliteTelegramJobStore(file);
    const inherited = store.getTopicResume(h.seeded!.jobId)!;
    expect(inherited.mode).toBe("warning_replay");
    expect(inherited.anchorAttemptBaseline).toBe(2);
    h.advanceTo(inherited.nextAttemptAt!);
    h.setProbe(async () => closed ? "closed" : "live");
    h.setSending(async (payload) => {
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      return { messageId: 71 };
    });
    h.trace.length = 0; h.wakeups.length = 0;
    const restarted = h.start(new Set());
    await restarted.reconcile();
    expect(store.getTopicResume(h.seeded!.jobId)!.currentJobVersion === store.get(h.seeded!.jobId)!.version).toBe(true);
    for (const wake of h.wakeups.splice(0)) await wake.wake();
    expect(h.trace.filter((entry) => entry !== "reload")).toEqual([
      "probe", ...(closed ? ["reopen"] : []), "anchor", "follower", "follower", "follower", "follower",
    ]);
    const resume = store.getTopicResume(h.seeded!.jobId)!;
    expect(resume.state).toBe("complete");
    expect(resume.currentJobVersion === store.get(h.seeded!.jobId)!.version).toBe(true);
    expect(resume.deliveryTopologyHash === inherited.deliveryTopologyHash).toBe(false);
    expect(store.listDeliveries(h.seeded!.jobId).filter((row) => row.state === "delivered")).toHaveLength(4);
    expect(store.get(h.seeded!.jobId)?.deliveries).toHaveLength(3);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
    expect(store.hasJobQuarantine(h.seeded!.jobId)).toBe(false);
    const calls = h.trace.length;
    await restarted.reconcile();
    expect(h.trace).toHaveLength(calls);
  });

  it.each([false, true])("contains partial fallback uncertainty and forged retries after reconstruction (malformed=%s)", async (malformed) => {
    const h = harness();
    h.setSending(async (payload) => {
      if (payload.operation === "send_rich") throw new TelegramDeliveryApiError("rich_rejected", undefined, "format");
      if (h.trace.filter((entry) => entry === "follower").length === 3) throw new Error("ambiguous");
      return { messageId: 71 };
    });
    const runtime = h.start();
    const snapshot = await runtime.loadDashboardReliability();
    await runtime.runDashboardAction(snapshot.jobs[0]!.projection.actions.find((a) => a.kind === "resume_existing_topic_warning")!);
    expect(store.getTopicResume(h.seeded!.jobId)?.reasonCode).toBe("TOPIC_RESUME_FOLLOWER_UNCERTAIN");
    await runtime.dispose(); store.close(); store = new SqliteTelegramJobStore(file);
    if (malformed) db.exec("UPDATE topic_resume_attempts SET action_token = 'invalid'");
    const restarted = h.start(new Set());
    await restarted.reconcile();
    const before = db.prepare("PRAGMA data_version").get();
    const calls = h.trace.filter((entry) => entry !== "reload").length;
    for (const kind of ["retry_delivery", "send_again_warning", "resume_existing_topic_warning"] as const) {
      await expect(restarted.runDashboardAction({ kind, jobId: h.seeded!.jobId,
        expectedVersion: store.get(h.seeded!.jobId)!.version,
        ...(kind === "resume_existing_topic_warning" ? {} : { partKey: "final:0000:fallback:0001" }) })).rejects.toThrow();
    }
    const outbox = new TelegramDeliveryOutbox({ store, telegram: h.options.deliveryTransport, now: () => NOW });
    for (const row of store.listDeliveries(h.seeded!.jobId)) {
      await expect(outbox.retryFailed(h.seeded!.jobId, row.partKey)).rejects.toThrow();
      await expect(outbox.sendAgainWithWarning(h.seeded!.jobId, row.partKey)).rejects.toThrow();
    }
    expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
    expect(h.trace.filter((entry) => entry !== "reload")).toHaveLength(calls);
    if (!malformed) expect(store.getTopicResume(h.seeded!.jobId)?.reasonCode).toBe("TOPIC_RESUME_FOLLOWER_UNCERTAIN");
    expect(store.hasJobQuarantine(h.seeded!.jobId)).toBe(malformed);
  });

  it("keeps a zero-row dormant runtime free of Telegram work", async () => {
    const h = harness({ empty: true });
    await h.start(new Set()).reconcile();
    expect(h.trace).toEqual([]);
    expect(h.wakeups).toEqual([]);
    expect(store.listTopicResumes(["probe_in_flight", "delivery_handoff", "failed", "complete"])).toEqual([]);
  });

  it.each([
    ["failed anchor", "failed", "final:0000", "payload_json = '['"],
    ["uncertain anchor", "uncertain", "final:0000", "payload_json = '['"],
    ["malformed anchor", "failed", "status-anchor", "payload_json = '['"],
    ["invalid follower payload", "failed", "final:0000", "payload_json = '{}'"],
    ["mismatched follower hash", "failed", "final:0000", "content_hash = '" + "a".repeat(64) + "'"],
  ])("degrades absent-resume evidence while retaining valid Dashboard actions: %s", async (_name, anchorState, damagedPart, assignment) => {
    const h = harness();
    if (anchorState === "uncertain") {
      await new TelegramDeliveryOutbox({ store, now: () => NOW,
        telegram: { deliver: async () => { throw new Error("ambiguous"); } } })
        .retryFailed(h.seeded!.jobId, "status-anchor");
    }
    const unrelated = seedResumeCandidate(store, 2);
    const runtime = h.start(new Set(["standard", "warning_replay"]));
    expect(store.hasTopicResume(h.seeded!.jobId)).toBe(false);
    db.prepare(`UPDATE deliveries SET ${assignment} WHERE job_id = ? AND part_key = ?`)
      .run(h.seeded!.jobId, damagedPart);
    const before = db.prepare("PRAGMA data_version").get();
    const snapshot = await runtime.loadDashboardReliability();
    const affected = snapshot.jobs.find((entry) => entry.projection.jobId === h.seeded!.jobId)!.projection;
    const valid = snapshot.jobs.find((entry) => entry.projection.jobId === unrelated.jobId)!.projection;
    expect(affected.actions.some((a) => a.kind.startsWith("resume_existing_topic"))).toBe(false);
    const retries = affected.actions.filter((a) => a.kind === "retry_delivery" || a.kind === "send_again_warning");
    expect(retries).toEqual(damagedPart === "status-anchor" ? [] : [{
      kind: anchorState === "uncertain" ? "send_again_warning" : "retry_delivery",
      jobId: h.seeded!.jobId, expectedVersion: affected.expectedVersion, partKey: "status-anchor",
    }]);
    expect(affected.reasonCodes).toContain("DELIVERY_EVIDENCE_MALFORMED");
    expect(affected.actions.some((a) => a.kind === "inspect")).toBe(true);
    expect(affected.actions.some((a) => a.kind === "details")).toBe(true);
    expect(affected.isDone).toBe(false);
    expect(affected.anchorKnownDelivered).toBe(false);
    expect(valid.actions.some((a) => a.kind === "resume_existing_topic")).toBe(true);
    expect(valid.actions.some((a) => a.kind === "retry_delivery" && a.partKey === "status-anchor")).toBe(true);
    for (const kind of ["resume_existing_topic", "resume_existing_topic_warning"] as const) {
      await expect(runtime.runDashboardAction({ kind, jobId: h.seeded!.jobId,
        expectedVersion: affected.expectedVersion })).rejects.toThrow();
    }
    expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
    expect(store.hasTopicResume(h.seeded!.jobId)).toBe(false);
    expect(h.trace.every((entry) => entry === "reload")).toBe(true);
  });

  it.each(["failed", "complete"] as const)("excludes terminal %s resume source from repeated generic reconciliation", async (state) => {
    const h = harness();
    if (state === "failed") h.setSending(async () => { throw new Error("ambiguous"); });
    const runtime = h.start();
    const snapshot = await runtime.loadDashboardReliability();
    await runtime.runDashboardAction(snapshot.jobs[0]!.projection.actions.find((a) => a.kind === "resume_existing_topic_warning")!);
    expect(store.getTopicResume(h.seeded!.jobId)?.state).toBe(state);
    const ownedRows = store.listDeliveries(h.seeded!.jobId);
    const ownedVersion = store.get(h.seeded!.jobId)!.version;
    await runtime.dispose();
    db.prepare("UPDATE inbox_updates SET source_json = '[' WHERE job_id = ?").run(h.seeded!.jobId);
    store.close(); store = new SqliteTelegramJobStore(file);
    const unrelated = seedResumeDelivery(store, 2);
    const send = vi.fn(async () => ({ messageId: 71 }));
    const restarted = createTelegramReliabilityRuntime({ ...h.options, store,
      deliveryTransport: { deliver: send }, topicResume: { ...h.options.topicResume!, allowedModes: new Set() } });
    runtimes.push(restarted);
    await expect(restarted.reconcile()).resolves.toBeDefined();
    expect(store.get(unrelated.jobId)?.phase).toBe("terminal");
    expect(send).toHaveBeenCalledTimes(3);
    const before = db.prepare("PRAGMA data_version").get();
    await expect(restarted.reconcile()).resolves.toBeDefined();
    await expect(restarted.reconcile()).resolves.toBeDefined();
    expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
    expect(store.get(h.seeded!.jobId)!.version).toBe(ownedVersion);
    expect(store.listDeliveries(h.seeded!.jobId)).toEqual(ownedRows);
    expect(send).toHaveBeenCalledTimes(3);
    expect(store.nextDeliveryWakeupAt()).toBeNull();
  });

  it("contains malformed recovery projection with both runtimes without hiding safe anchor or unrelated actions", async () => {
    const h = harness();
    const unrelated = seedResumeCandidate(store, 2);
    const forbidden = vi.fn(async () => { throw new Error("unexpected Telegram operation"); });
    const rebind = vi.fn();
    const runtime = createTelegramReliabilityRuntime({ ...h.options, store,
      topicResume: { ...h.options.topicResume!, allowedModes: new Set(["standard", "warning_replay"]) },
      topicRecovery: {
        forumChatId: DESTINATION.chatId,
        getThread: h.options.topicResume!.getThread,
        hasThreadTopicBinding: h.options.topicResume!.hasThreadTopicBinding,
        probeForumTopic: forbidden, createForumTopic: forbidden,
        sendWelcome: forbidden, rebindThreadTopic: rebind,
      },
    });
    runtimes.push(runtime);
    expect(store.hasTopicResume(h.seeded!.jobId)).toBe(false);
    db.prepare("UPDATE topic_recoveries SET action_token = 'invalid' WHERE job_id = ?").run(h.seeded!.jobId);
    const before = db.prepare("PRAGMA data_version").get();
    for (let read = 0; read < 2; read++) {
      const snapshot = await runtime.loadDashboardReliability();
      const affected = snapshot.jobs.find((entry) => entry.projection.jobId === h.seeded!.jobId)!.projection;
      const valid = snapshot.jobs.find((entry) => entry.projection.jobId === unrelated.jobId)!.projection;
      expect(affected.actions.some((a) => a.kind.startsWith("resume_existing_topic") || a.kind === "recover_missing_topic")).toBe(false);
      expect(affected.actions.some((a) => a.kind === "retry_delivery" && a.partKey === "status-anchor")).toBe(true);
      expect(affected.actions.some((a) => a.kind === "details")).toBe(true);
      expect(valid.actions.some((a) => a.kind === "resume_existing_topic")).toBe(true);
      expect(valid.actions.some((a) => a.kind === "retry_delivery" && a.partKey === "status-anchor")).toBe(true);
      for (const kind of ["resume_existing_topic", "resume_existing_topic_warning", "recover_missing_topic"] as const) {
        await expect(runtime.runDashboardAction({ kind, jobId: h.seeded!.jobId,
          expectedVersion: affected.expectedVersion })).rejects.toThrow();
      }
    }
    expect(() => store.getTopicRecovery(h.seeded!.jobId)).toThrow("Malformed Telegram topic recovery");
    expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
    expect(store.hasTopicResume(h.seeded!.jobId)).toBe(false);
    expect(h.trace.every((entry) => entry === "reload")).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
    expect(rebind).not.toHaveBeenCalled();
  });

  function reserve(h: ReturnType<typeof harness>, unknown = false) {
    const seeded = h.seeded!;
    const reserved = store.reserveTopicResume({ candidate: seeded.candidate,
      allowedModes: new Set(["warning_replay"]), externalEligibilitySnapshot: seeded.external,
      eventId: "fixture:reserve", actionToken: "e".repeat(64), eventAt: NOW });
    if (!unknown) return reserved.resume;
    const reopening = store.transitionTopicResume({ jobId: seeded.jobId, expectedVersion: reserved.job.version,
      actionToken: reserved.resume.actionToken, expectedState: "probe_in_flight", state: "reopen_in_flight",
      externalEligibilitySnapshot: seeded.external, updatedAt: NOW });
    return store.transitionTopicResume({ jobId: seeded.jobId, expectedVersion: reopening.job.version,
      actionToken: reserved.resume.actionToken, expectedState: "reopen_in_flight", state: "reopen_unknown",
      reasonCode: "TOPIC_RESUME_REOPEN_UNKNOWN", updatedAt: NOW }).resume;
  }

  it.each(["probe", "reopen", "unknown"] as const)("settles binding drift at the scheduled %s retry before another call", async (stage) => {
    const h = harness({ closed: stage === "reopen" });
    const rateLimited = async (): Promise<never> => { throw { error_code: 429, parameters: { retry_after: 1 } }; };
    if (stage === "reopen") h.setReopen(rateLimited);
    else h.setProbe(rateLimited);
    if (stage === "unknown") reserve(h, true);
    const runtime = h.start();
    if (stage === "unknown") await runtime.reconcile();
    else await runtime.runDashboardAction({ kind: "resume_existing_topic_warning",
      jobId: h.seeded!.jobId, expectedVersion: h.seeded!.candidate.expectedVersion });
    const current = store.getTopicResume(h.seeded!.jobId)!;
    expect(current.nextAttemptAt).toBe(NOW + 1000);
    h.seeded!.external.hasThreadTopicBinding = false;
    h.advanceTo(current.nextAttemptAt!);
    const calls = h.trace.filter((entry) => entry !== "reload").length;
    for (const wake of h.wakeups.splice(0)) await wake.wake();
    expect(h.trace.filter((entry) => entry !== "reload")).toHaveLength(calls);
    expect(store.getTopicResume(h.seeded!.jobId)?.reasonCode).toBe("TOPIC_RESUME_EVIDENCE_STALE");
    await runtime.reconcile();
    expect(h.trace.filter((entry) => entry !== "reload")).toHaveLength(calls);
    expect(h.wakeups).toEqual([]);
  });

  it.each([false, true])("limits inherited unknown probes across real process reconstruction (unknown=%s)", async (unknown) => {
    const h = harness();
    reserve(h, unknown);
    h.setProbe(async () => {
      expect(store.getTopicResume(h.seeded!.jobId)?.state).toBe("reopen_unknown");
      throw new Error("ambiguous");
    });
    let runtime = h.start(new Set());
    await runtime.reconcile(); await runtime.reconcile();
    expect(h.trace.filter((entry) => entry === "probe")).toHaveLength(1);
    expect(store.getTopicResume(h.seeded!.jobId)?.state).toBe("reopen_unknown");
    expect(h.wakeups).toEqual([]);
    await runtime.dispose(); store.close(); store = new SqliteTelegramJobStore(file);
    h.setProbe(async () => "closed");
    runtime = h.start(new Set());
    await runtime.reconcile(); await runtime.reconcile();
    expect(h.trace.filter((entry) => entry === "probe")).toHaveLength(2);
    expect(h.trace.includes("reopen") || h.trace.includes("anchor")).toBe(false);
    expect(store.getTopicResume(h.seeded!.jobId)?.state).toBe("reopen_unknown");
    expect(h.wakeups).toEqual([]);
  });

  it("consumes a persisted unknown-probe 429 deadline once after reconstruction", async () => {
    const h = harness();
    reserve(h, true);
    h.setProbe(async () => { throw { error_code: 429, parameters: { retry_after: 1 } }; });
    let runtime = h.start(new Set());
    await runtime.reconcile();
    await runtime.dispose(); store.close(); store = new SqliteTelegramJobStore(file);
    h.wakeups.length = 0;
    h.setProbe(async () => { throw new Error("429 Too Many Requests, retry after 5"); });
    runtime = h.start(new Set());
    await runtime.reconcile();
    h.advanceTo(NOW + 1000);
    for (const wake of h.wakeups.splice(0)) await wake.wake();
    const calls = h.trace.filter((entry) => entry === "probe").length;
    expect(calls).toBe(2);
    await runtime.reconcile(); await runtime.reconcile();
    expect(h.trace.filter((entry) => entry === "probe")).toHaveLength(calls);
    expect(h.wakeups).toEqual([]);
    expect(store.getTopicResume(h.seeded!.jobId)?.state).toBe("reopen_unknown");
    expect(store.getTopicResume(h.seeded!.jobId)?.nextAttemptAt).toBeNull();
    expect(store.getTopicResume(h.seeded!.jobId)?.reasonCode).toBe("TOPIC_RESUME_REOPEN_UNKNOWN");
  });

  it("reserves once when duplicate warning actions race through two SQLite stores", async () => {
    const h = harness();
    const first = h.start();
    const secondStore = new SqliteTelegramJobStore(file);
    const second = createTelegramReliabilityRuntime({ ...h.options, store: secondStore });
    try {
      const action = { kind: "resume_existing_topic_warning" as const,
        jobId: h.seeded!.jobId, expectedVersion: h.seeded!.candidate.expectedVersion };
      const results = await Promise.allSettled([first.runDashboardAction(action), second.runDashboardAction(action)]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS count FROM topic_resume_attempts").get()).toEqual({ count: 1 });
      expect(h.trace.filter((entry) => entry === "probe")).toHaveLength(1);
      expect(h.trace.filter((entry) => entry === "anchor")).toHaveLength(1);
      expect(store.getTopicResume(h.seeded!.jobId)?.state).toBe("complete");
    } finally { await second.dispose(); secondStore.close(); }
  });

  it("does not normalize unexpected anchor progress while a probe retry is pending", async () => {
    const h = harness();
    h.setProbe(async () => { throw { error_code: 429, parameters: { retry_after: 1 } }; });
    const runtime = h.start();
    await runtime.runDashboardAction({ kind: "resume_existing_topic_warning",
      jobId: h.seeded!.jobId, expectedVersion: h.seeded!.candidate.expectedVersion });
    db.exec(`UPDATE deliveries SET state = 'delivered', attempt_count = 3, telegram_message_id = 71,
      next_attempt_at_ms = NULL, last_error_code = NULL WHERE part_key = 'status-anchor'`);
    h.advanceTo(NOW + 1000);
    for (const wake of h.wakeups.splice(0)) await wake.wake();
    expect(h.trace.filter((entry) => entry === "probe")).toHaveLength(1);
    expect(store.getTopicResume(h.seeded!.jobId)?.reasonCode).toBe("TOPIC_RESUME_EVIDENCE_STALE");
  });
});
