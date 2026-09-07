import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteTelegramJobStore, type NewDeliveryPart } from "../src/telegram-job-store.js";
import type { TelegramJob, TelegramSourceKey } from "../src/telegram-job-types.js";

function job(id: string, source: TelegramSourceKey): TelegramJob {
  const acceptedAt = 1_700_000_000_000;
  return {
    schemaVersion: 1,
    id,
    version: 1,
    source,
    attachments: [],
    phase: "accepted",
    health: "healthy",
    activity: "unknown",
    attention: { kind: "none" },
    outcome: null,
    dispatchId: null,
    threadId: null,
    turnId: null,
    responsePlan: undefined,
    deliveries: [],
    acceptedAt,
    updatedAt: acceptedAt,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
}

function anchor(jobId: string): NewDeliveryPart {
  return {
    jobId,
    partKey: "status-anchor",
    ordinal: 0,
    kind: "status-anchor",
    state: "pending",
    payload: { chatId: -100, messageThreadId: 7, sourceMessageId: 11 },
    contentHash: "a".repeat(64),
    updatedAt: 1_700_000_000_000,
  };
}

describe("SqliteTelegramJobStore atomic acceptance deliveries", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-ingress-ledger-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("commits the accepted job and initial status anchor in one transaction", () => {
    const source = { botId: "bot", updateId: 1 };
    const accepted = job("job-1", source);

    expect(store.acceptUpdate({
      job: accepted,
      sourcePayload: { kind: "text", text: "hello" },
      eventId: "accept-1",
      initialDeliveries: [anchor(accepted.id)],
    })).toEqual({ created: true, job: accepted });
    expect(store.listDeliveries(accepted.id)).toEqual([
      expect.objectContaining({ partKey: "status-anchor", state: "pending" }),
    ]);
  });

  it("rolls back job, source, event, and deliveries when an initial delivery insert fails", () => {
    const source = { botId: "bot", updateId: 2 };
    const accepted = job("job-rollback", source);
    const duplicate = anchor(accepted.id);

    expect(() => store.acceptUpdate({
      job: accepted,
      sourcePayload: { kind: "text", text: "hello" },
      eventId: "accept-rollback",
      initialDeliveries: [duplicate, duplicate],
    })).toThrow();
    expect(store.get(accepted.id)).toBeNull();
    expect(store.getBySourceKey(source)).toBeNull();
    expect(store.listEvents(accepted.id)).toEqual([]);
    expect(store.listDeliveries(accepted.id)).toEqual([]);

    expect(store.acceptUpdate({
      job: accepted,
      sourcePayload: { kind: "text", text: "hello" },
      eventId: "accept-retry",
      initialDeliveries: [duplicate],
    }).created).toBe(true);
  });

  it("requires materialized prompts to enter through an append-only success event", () => {
    const source = { botId: "bot", updateId: 3 };
    const invalid = {
      ...job("job-pre-materialized", source),
      materializedPrompt: { text: "bypassed event", attachments: [] },
    };

    expect(() => store.acceptUpdate({
      job: invalid,
      sourcePayload: { kind: "text", text: "bypassed event" },
      eventId: "accept-invalid",
      initialDeliveries: [anchor(invalid.id)],
    })).toThrow("Invalid accepted Telegram job");
    expect(store.get(invalid.id)).toBeNull();
  });
});
