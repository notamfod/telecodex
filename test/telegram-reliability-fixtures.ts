import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  TelegramDeliveryOutbox,
  type TelegramDeliveryAdapter,
  type TelegramDeliveryPayload,
} from "../src/telegram-delivery-outbox.js";
import {
  TelegramJobCoordinator,
  type TelegramCoordinatorCodexAdapter,
  type TelegramCoordinatorTurnRequest,
} from "../src/telegram-job-coordinator.js";
import { TelegramJobIngress, type TelegramWorkSource } from "../src/telegram-job-ingress.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { TelegramJob } from "../src/telegram-job-types.js";
import type { TelegramTurnResultContent } from "../src/telegram-turn-result.js";

export const FAULT_NOW = 1_700_000_000_000;

export class FaultCodex implements TelegramCoordinatorCodexAdapter {
  readonly starts: TelegramCoordinatorTurnRequest[] = [];
  readonly recoveries: Array<{ request: TelegramCoordinatorTurnRequest; turnId: string }> = [];
  readonly aborts: Array<{ threadId: string; turnId: string }> = [];
  resolveBehavior: (job: TelegramJob) => Promise<string> = async (job) => job.threadId ?? `thread-${job.id}`;
  startBehavior: (request: TelegramCoordinatorTurnRequest) => Promise<void> = async (request) => {
    request.callbacks.beforeDispatchWrite({
      threadId: request.threadId,
      previousTurnId: null,
      previousTurnKnown: true,
      attempt: 1,
    });
    request.callbacks.onDispatchWritten();
    request.callbacks.onStarted(`turn-${request.jobId}`);
  };
  recoverBehavior: (request: TelegramCoordinatorTurnRequest, turnId: string) => Promise<void> = async () => {};

  resolveThread(job: TelegramJob): Promise<string> {
    return this.resolveBehavior(job);
  }

  startTurn(request: TelegramCoordinatorTurnRequest): Promise<void> {
    this.starts.push(request);
    return this.startBehavior(request);
  }

  recoverTurn(request: TelegramCoordinatorTurnRequest, turnId: string): Promise<void> {
    this.recoveries.push({ request, turnId });
    return this.recoverBehavior(request, turnId);
  }

  async abortTurn(input: { readonly threadId: string; readonly turnId: string }): Promise<void> {
    this.aborts.push(input);
  }
}

export class FaultTelegram implements TelegramDeliveryAdapter {
  readonly calls: Array<{ payload: TelegramDeliveryPayload; signal: AbortSignal }> = [];
  behavior: TelegramDeliveryAdapter["deliver"] = async () => ({ messageId: 900 });

  deliver(payload: TelegramDeliveryPayload, signal: AbortSignal): Promise<{ readonly messageId: number }> {
    this.calls.push({ payload: structuredClone(payload), signal });
    return this.behavior(payload, signal);
  }
}

export class TelegramReliabilityFixture {
  readonly directory = mkdtempSync(path.join(tmpdir(), "telecodex-faults-"));
  readonly databasePath = path.join(this.directory, "jobs.sqlite");
  readonly materializationRoot = path.join(this.directory, "materialized");
  store = new SqliteTelegramJobStore(this.databasePath);
  readonly codex = new FaultCodex();
  readonly telegram = new FaultTelegram();
  now = FAULT_NOW;
  private sequence = 0;
  private updateSequence = 0;

  createId = (): string => `fault-event-${++this.sequence}`;

  source(overrides: Partial<TelegramWorkSource> = {}): TelegramWorkSource {
    const updateId = overrides.updateId ?? ++this.updateSequence;
    return {
      botId: "fault-bot",
      updateId,
      chatId: -100_001,
      messageThreadId: 7,
      messageId: updateId,
      kind: "text",
      text: "fault prompt",
      attachment: null,
      retryOfJobId: null,
      ...overrides,
    };
  }

  ingress(overrides: Partial<ConstructorParameters<typeof TelegramJobIngress>[0]> = {}): TelegramJobIngress {
    return new TelegramJobIngress({
      store: this.store,
      materializationRoot: this.materializationRoot,
      now: () => this.now,
      createId: this.createId,
      downloadAttachment: async () => new Uint8Array([1, 2, 3]),
      ...overrides,
    });
  }

  acceptText(id?: string, source = this.source()): TelegramJob {
    const ingress = this.ingress({ ...(id ? { createId: this.idSequence(id) } : {}) });
    const accepted = ingress.accept(source).job;
    return this.store.transition({
      jobId: accepted.id,
      eventId: this.createId(),
      expectedVersion: accepted.version,
      event: {
        schemaVersion: 1,
        type: "materialization.succeeded",
        eventAt: this.now,
        materializedPrompt: { text: source.text ?? "", attachments: [] },
      },
    });
  }

  queue(job: TelegramJob): TelegramJob {
    return this.store.transition({
      jobId: job.id,
      eventId: this.createId(),
      expectedVersion: job.version,
      event: { schemaVersion: 1, type: "job.queued", eventAt: this.now },
    });
  }

  running(id = `running-${this.updateSequence + 1}`): TelegramJob {
    let job = this.queue(this.acceptText(id));
    job = this.store.transition({
      jobId: job.id,
      eventId: this.createId(),
      expectedVersion: job.version,
      event: {
        schemaVersion: 1,
        type: "dispatch.started",
        eventAt: this.now,
        dispatch: {
          id: `${id}-dispatch`,
          threadId: `${id}-thread`,
          previousTurnId: null,
          attempt: 1,
          startedAt: this.now,
          transportWriteState: "prepared",
          nextAttemptAt: null,
        },
      },
    });
    job = this.store.transition({
      jobId: job.id,
      eventId: this.createId(),
      expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.in_flight", eventAt: this.now },
    });
    job = this.store.transition({
      jobId: job.id,
      eventId: this.createId(),
      expectedVersion: job.version,
      event: { schemaVersion: 1, type: "dispatch.written", eventAt: this.now },
    });
    return this.store.transition({
      jobId: job.id,
      eventId: this.createId(),
      expectedVersion: job.version,
      event: {
        schemaVersion: 1,
        type: "turn.started",
        eventAt: this.now,
        identifiers: { turnId: `${id}-turn` },
        codexEventAt: this.now,
      },
    });
  }

  delivering(
    id = `delivering-${this.updateSequence + 1}`,
    content: readonly TelegramTurnResultContent[] = [{ kind: "text", text: "fault answer" }],
  ): TelegramJob {
    const running = this.running(id);
    return this.store.transition({
      jobId: running.id,
      eventId: this.createId(),
      expectedVersion: running.version,
      event: {
        schemaVersion: 1,
        type: "turn.completed",
        eventAt: this.now,
        codexEventAt: this.now,
        turnResult: { schemaVersion: 1, content },
      },
    });
  }

  coordinator(overrides: Partial<ConstructorParameters<typeof TelegramJobCoordinator>[0]> = {}): TelegramJobCoordinator {
    return new TelegramJobCoordinator({
      store: this.store,
      materializer: this.ingress(),
      codex: this.codex,
      now: () => this.now,
      createId: this.createId,
      scheduleWakeup: () => {},
      ...overrides,
    });
  }

  outbox(overrides: Partial<ConstructorParameters<typeof TelegramDeliveryOutbox>[0]> = {}): TelegramDeliveryOutbox {
    return new TelegramDeliveryOutbox({
      store: this.store,
      telegram: this.telegram,
      now: () => this.now,
      createId: this.createId,
      scheduleWakeup: () => {},
      timeoutMs: 20,
      ...overrides,
    });
  }

  reopen(): void {
    this.store.close();
    this.store = new SqliteTelegramJobStore(this.databasePath);
  }

  close(): void {
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  private idSequence(jobId: string): () => string {
    let first = true;
    return () => {
      if (first) {
        first = false;
        return jobId;
      }
      return this.createId();
    };
  }
}
