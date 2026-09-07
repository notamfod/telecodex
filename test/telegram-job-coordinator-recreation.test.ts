import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { AppServerRequestError } from "../src/app-server-client.js";
import {
  TelegramJobCoordinator,
  type TelegramCoordinatorCodexAdapter,
  type TelegramCoordinatorTurnRequest,
} from "../src/telegram-job-coordinator.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";

const NOW = 1_700_000_000_000;

class FakeCodex implements TelegramCoordinatorCodexAdapter {
  readonly pending: Array<{ jobId: string; reject: (error: Error) => void }> = [];
  readonly writes: string[] = [];
  readonly threads = new Map<string, string>();
  previousTurnKnown = true;
  completeImmediately = false;
  attachmentCount = 0;

  async resolveThread(job: TelegramJob): Promise<string> {
    return this.threads.get(job.id) ?? `thread-${job.id}`;
  }

  startTurn(request: TelegramCoordinatorTurnRequest): Promise<void> {
    request.callbacks.beforeDispatchWrite({
      threadId: request.threadId,
      previousTurnId: null,
      previousTurnKnown: this.previousTurnKnown,
      attempt: 1,
    });
    this.writes.push(request.jobId);
    if (this.completeImmediately) {
      request.callbacks.onStarted(`turn-${request.jobId}`);
      for (let index = 0; index < this.attachmentCount; index += 1) {
        request.callbacks.onOutputAttachment({ kind: "file", path: `outputs/${index}.txt` });
      }
      request.callbacks.onTurnOutcome({ status: "completed", eventAt: NOW });
      return Promise.resolve();
    }
    return new Promise<void>((_resolve, reject) => this.pending.push({ jobId: request.jobId, reject }));
  }

  async recoverTurn(): Promise<void> {}

  async abortTurn(): Promise<void> {}
}

describe("TelegramJobCoordinator durable FIFO boundaries", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let codex: FakeCodex;
  let sequence: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-coordinator-boundary-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    codex = new FakeCodex();
    sequence = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function coordinator(
    selectedStore: ConstructorParameters<typeof TelegramJobCoordinator>[0]["store"] = store,
  ): TelegramJobCoordinator {
    return new TelegramJobCoordinator({
      store: selectedStore, codex,
      materializer: { materialize: async () => ({ text: "prompt", attachments: [] }) },
      now: () => NOW, createId: () => `event-${++sequence}`, globalConcurrency: 2,
      retryBackoffMs: 1_000, scheduleWakeup: () => {},
    });
  }

  function accept(id: string, updateId: number, topic: number): void {
    const job: TelegramJob = {
      schemaVersion: 1, id, version: 1, source: { botId: "bot", updateId }, attachments: [],
      phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
      dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
      acceptedAt: NOW, updatedAt: NOW, terminalAt: null, dismissedAt: null, retainUntil: null,
    };
    store.acceptUpdate({
      job, eventId: `accept-${id}`,
      sourcePayload: { botId: "bot", updateId, chatId: -100, messageThreadId: topic },
    });
    store.transition({
      jobId: id, eventId: `materialized-${id}`, expectedVersion: 1,
      event: {
        schemaVersion: 1, type: "materialization.succeeded", eventAt: NOW,
        materializedPrompt: { text: "prompt", attachments: [] },
      },
    });
  }

  it("blocks transport when the previous latest turn baseline is unknown", async () => {
    accept("job-unknown", 1, 7);
    codex.previousTurnKnown = false;

    await coordinator().pump();

    expect(codex.writes).toEqual([]);
    expect(store.get("job-unknown")).toMatchObject({
      phase: "queued",
      attention: { kind: "required", code: "previous_turn_unknown", actions: ["inspect"] },
    });
    expect(store.get("job-unknown")!.dispatch).toBeUndefined();
  });

  it("keeps a later topic blocked behind a deferred job on the same bound thread", async () => {
    accept("job-a", 1, 7);
    accept("job-b", 2, 8);
    codex.threads.set("job-a", "shared");
    codex.threads.set("job-b", "shared");
    const first = coordinator();

    await first.pump();
    expect(codex.writes).toEqual(["job-a"]);
    codex.pending[0]!.reject(new AppServerRequestError("APP_SERVER_NOT_SENT"));
    await vi.waitFor(() => expect(store.get("job-a")?.phase).toBe("queued"));
    await first.pump();

    expect(store.get("job-a")?.threadId).toBe("shared");
    expect(store.get("job-a")?.nextAttemptAt).toBe(NOW + 1_000);
    expect(codex.writes).toEqual(["job-a"]);
  });

  it("does not lose the next FIFO wakeup when a turn completes inside the current pump", async () => {
    accept("job-a", 1, 7);
    accept("job-b", 2, 7);
    codex.completeImmediately = true;

    await coordinator().pump();

    await vi.waitFor(() => expect(codex.writes).toEqual(["job-a", "job-b"]));
    expect(store.get("job-a")?.phase).toBe("delivering");
    expect(store.get("job-b")?.phase).toBe("delivering");
  });

  it("retries an authoritative completion transition after a concurrent observation", async () => {
    accept("job-cas", 1, 7);
    codex.completeImmediately = true;
    let raced = false;
    const base = store;
    const competingStore = {
      get: base.get.bind(base), listUnfinished: base.listUnfinished.bind(base),
      listDispatchable: base.listDispatchable.bind(base), readSourcePayload: base.readSourcePayload.bind(base),
      transition: (input: Parameters<typeof base.transition>[0]) => {
        if (!raced && input.event.type === "turn.completed") {
          raced = true;
          const current = base.get(input.jobId)!;
          base.transition({
            jobId: input.jobId, eventId: "guardian-race", expectedVersion: current.version,
            event: { schemaVersion: 1, type: "guardian.observed", eventAt: NOW, health: "quiet" },
          });
        }
        return base.transition(input);
      },
    };

    await coordinator(competingStore).pump();

    await vi.waitFor(() => expect(store.get("job-cas")?.phase).toBe("delivering"));
    expect(store.listEvents("job-cas").map(({ event }) => event.type)).toContain("turn.completed");
  });

  it("fails safely when logical result content exceeds its durable part bound", async () => {
    accept("job-result-bound", 1, 7);
    codex.completeImmediately = true;
    codex.attachmentCount = 257;

    await coordinator().pump();

    await vi.waitFor(() => expect(store.get("job-result-bound")?.phase).toBe("terminal"));
    expect(store.get("job-result-bound")).toMatchObject({
      outcome: "failed",
      attention: { kind: "required", code: "invalid_codex_output", actions: ["inspect"] },
    });
  });
});
