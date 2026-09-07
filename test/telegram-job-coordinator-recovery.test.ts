import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import {
  TelegramJobCoordinator,
  type TelegramCoordinatorCodexAdapter,
  type TelegramCoordinatorTurnRequest,
} from "../src/telegram-job-coordinator.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";

const NOW = 1_700_000_000_000;

class RecoveryCodex implements TelegramCoordinatorCodexAdapter {
  readonly resolves: string[] = [];
  readonly starts: TelegramCoordinatorTurnRequest[] = [];
  readonly recoveries: Array<{ request: TelegramCoordinatorTurnRequest; turnId: string }> = [];
  recoverBehavior?: (request: TelegramCoordinatorTurnRequest, turnId: string) => Promise<void>;

  async resolveThread(job: TelegramJob): Promise<string> {
    this.resolves.push(job.id);
    return job.threadId ?? "unexpected-thread";
  }

  async startTurn(request: TelegramCoordinatorTurnRequest): Promise<void> {
    this.starts.push(request);
  }

  recoverTurn(request: TelegramCoordinatorTurnRequest, turnId: string): Promise<void> {
    this.recoveries.push({ request, turnId });
    return this.recoverBehavior?.(request, turnId) ?? Promise.resolve();
  }

  async abortTurn(): Promise<void> {}
}

describe("TelegramJobCoordinator exact turn recovery", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let codex: RecoveryCodex;
  let sequence: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-coordinator-recovery-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    codex = new RecoveryCodex();
    sequence = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function coordinator(overrides: Partial<ConstructorParameters<typeof TelegramJobCoordinator>[0]> = {}): TelegramJobCoordinator {
    return new TelegramJobCoordinator({
      store, codex,
      materializer: { materialize: async () => ({ text: "prompt", attachments: [] }) },
      now: () => NOW, createId: () => `recovery-event-${++sequence}`,
      scheduleWakeup: () => {},
      ...overrides,
    });
  }

  function accept(id: string): TelegramJob {
    const job: TelegramJob = {
      schemaVersion: 1, id, version: 1, source: { botId: "bot", updateId: 1 }, attachments: [],
      phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" },
      outcome: null, dispatchId: null, threadId: null, turnId: null, deliveries: [],
      acceptedAt: NOW, updatedAt: NOW, terminalAt: null, dismissedAt: null, retainUntil: null,
    };
    store.acceptUpdate({
      job, eventId: `accept-${id}`,
      sourcePayload: {
        botId: "bot", updateId: 1, chatId: -100, messageThreadId: 7, messageId: 1,
        kind: "text", text: "prompt", attachment: null, retryOfJobId: null,
      },
    });
    return job;
  }

  function running(id = "job-running", threadId = "thread-exact", turnId = "turn-exact"): TelegramJob {
    accept(id);
    let job = store.transition({
      jobId: id, eventId: `${id}-materialized`, expectedVersion: 1,
      event: {
        schemaVersion: 1, type: "materialization.succeeded", eventAt: NOW,
        materializedPrompt: { text: "prompt", attachments: [] },
      },
    });
    job = store.transition({
      jobId: id, eventId: `${id}-queued`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "job.queued", eventAt: NOW },
    });
    job = store.transition({
      jobId: id, eventId: `${id}-dispatch`, expectedVersion: job.version,
      event: {
        schemaVersion: 1, type: "dispatch.started", eventAt: NOW,
        dispatch: {
          id: `${id}-dispatch-id`, threadId, previousTurnId: null, attempt: 1,
          startedAt: NOW, transportWriteState: "prepared", nextAttemptAt: null,
        },
      },
    });
    job = store.transition({
      jobId: id, eventId: `${id}-flight`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.in_flight", eventAt: NOW },
    });
    job = store.transition({
      jobId: id, eventId: `${id}-written`, expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.written", eventAt: NOW },
    });
    return store.transition({
      jobId: id, eventId: `${id}-started`, expectedVersion: job.version,
      event: {
        schemaVersion: 1, type: "turn.started", eventAt: NOW,
        identifiers: { turnId }, codexEventAt: NOW,
      },
    });
  }

  it("registers one exact recovery and returns without awaiting the active turn", async () => {
    running();
    let finish!: () => void;
    let activeRequest!: TelegramCoordinatorTurnRequest;
    codex.recoverBehavior = (request) => {
      activeRequest = request;
      return new Promise<void>((resolve) => { finish = resolve; });
    };
    const subject = coordinator();

    await expect(subject.recoverExactTurn("job-running")).resolves.toEqual({ scheduled: true });
    await expect(subject.recoverExactTurn("job-running")).resolves.toEqual({ scheduled: false });

    expect(codex.recoveries).toHaveLength(1);
    expect(codex.recoveries[0]).toMatchObject({
      turnId: "turn-exact", request: { threadId: "thread-exact", prompt: { text: "", attachments: [] } },
    });
    expect(codex.resolves).toEqual([]);
    expect(codex.starts).toEqual([]);
    activeRequest.callbacks.onStarted("turn-exact");
    activeRequest.callbacks.onTextDelta("active answer");
    activeRequest.callbacks.onTurnOutcome({ status: "completed", eventAt: NOW + 1 });
    finish();
    await vi.waitFor(() => expect(store.get("job-running")?.phase).toBe("delivering"));
    expect(store.get("job-running")?.turnResult?.content).toEqual([
      { kind: "text", text: "active answer" },
    ]);
  });

  it("rebuilds a completed stored turn through the normal activity and result pipeline", async () => {
    running();
    const publishCommentary = vi.fn();
    codex.recoverBehavior = async (request, turnId) => {
      request.callbacks.onStarted(turnId);
      request.callbacks.onActivity({ activity: "tool", eventAt: NOW + 1, method: "item/started" });
      request.callbacks.onTextDelta("stored commentary", {
        itemId: "commentary-1", phase: "commentary",
      });
      request.callbacks.onAgentMessageEnd?.({ itemId: "commentary-1", phase: "commentary" });
      expect(publishCommentary).toHaveBeenCalledWith({
        jobId: "job-running", turnId: "turn-exact", itemId: "commentary-1",
        commentaryIndex: 0, text: "stored commentary",
      });
      request.callbacks.onOutputAttachment({ kind: "file", path: "outputs/result.txt" });
      request.callbacks.onTurnOutcome({ status: "completed", eventAt: NOW + 2 });
    };
    const subject = coordinator({ publishCommentary });

    await expect(subject.recoverExactTurn("job-running")).resolves.toEqual({ scheduled: true });
    await vi.waitFor(() => expect(store.get("job-running")?.phase).toBe("delivering"));

    expect(store.get("job-running")).toMatchObject({
      lastCodexEventAt: NOW + 2,
      turnResult: {
        schemaVersion: 1,
        content: [
          { kind: "text", phase: "commentary", text: "stored commentary" },
          { kind: "attachment", attachment: { kind: "file", path: "outputs/result.txt" } },
        ],
      },
    });
    const eventTypes = store.listEvents("job-running").map(({ event }) => event.type);
    expect(eventTypes.filter((type) => type === "dispatch.started")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "turn.started")).toHaveLength(1);
    expect(codex.resolves).toEqual([]);
    expect(codex.starts).toEqual([]);
    await expect(subject.recoverExactTurn("job-running")).resolves.toEqual({ scheduled: false });
  });

  it("fails closed on a recovery error without replaying the prompt or leaking details", async () => {
    running();
    codex.recoverBehavior = async () => { throw new Error("unsafe daemon payload"); };
    const subject = coordinator();

    await subject.recoverExactTurn("job-running");
    await vi.waitFor(() => expect(store.get("job-running")?.attention.kind).toBe("required"));

    expect(store.get("job-running")).toMatchObject({
      phase: "running",
      attention: { kind: "required", code: "turn_recovery_failed", actions: ["inspect"] },
    });
    expect(JSON.stringify(store.get("job-running"))).not.toContain("unsafe daemon payload");
    expect(codex.resolves).toEqual([]);
    expect(codex.starts).toEqual([]);
    await expect(subject.recoverExactTurn("job-running")).resolves.toEqual({ scheduled: false });
    expect(codex.recoveries).toHaveLength(1);
  });

  it("persists a proven failed exact turn as terminal instead of leaving it running", async () => {
    running();
    codex.recoverBehavior = async (request) => {
      request.callbacks.onStarted("turn-exact");
      request.callbacks.onTurnOutcome({ status: "failed", eventAt: NOW + 1 });
      throw new Error("server overloaded");
    };

    await coordinator().recoverExactTurn("job-running");
    await vi.waitFor(() => expect(store.get("job-running")?.phase).toBe("terminal"));

    expect(store.get("job-running")).toMatchObject({
      phase: "terminal",
      outcome: "failed",
      attention: { kind: "required", code: "codex_turn_failed", actions: ["inspect", "retry"] },
    });
  });

  it("refuses callbacks for a different turn identity", async () => {
    running();
    codex.recoverBehavior = async (request) => {
      request.callbacks.onStarted("turn-foreign");
      request.callbacks.onTextDelta("foreign answer");
      request.callbacks.onTurnOutcome({ status: "completed", eventAt: NOW + 1 });
    };

    await coordinator().recoverExactTurn("job-running");
    await vi.waitFor(() => expect(store.get("job-running")?.attention.kind).toBe("required"));

    expect(store.get("job-running")).toMatchObject({
      phase: "running", turnId: "turn-exact",
      attention: { kind: "required", code: "turn_recovery_identity_mismatch", actions: ["inspect"] },
    });
    expect(store.get("job-running")?.turnResult).toBeUndefined();
    expect(codex.starts).toEqual([]);
  });

  it("rejects jobs without an exact persisted running identity before Codex", async () => {
    accept("job-accepted");

    await expect(coordinator().recoverExactTurn("job-accepted")).rejects.toThrow("not recoverable");
    expect(codex.recoveries).toEqual([]);
  });
});
