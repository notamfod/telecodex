import { parentPort, workerData } from "node:worker_threads";

import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";

interface WorkerInput {
  readonly databasePath: string;
  readonly jobId: string;
  readonly eventId: string;
  readonly gate: SharedArrayBuffer;
  readonly fail?: boolean;
  readonly exit?: boolean;
}

const input = workerData as WorkerInput;
if (!parentPort) throw new Error("Telegram ledger worker requires parentPort");

const timestamp = 1_700_000_000_000;
parentPort.postMessage({ type: "ready" });
Atomics.wait(new Int32Array(input.gate), 0, 0);
try {
  if (input.fail) throw new Error("worker failure");
  if (input.exit) process.exit(0);
  const store = new SqliteTelegramJobStore(input.databasePath);
  const result = store.acceptUpdate({
    eventId: input.eventId,
    sourcePayload: { update_id: 42 },
    job: {
      schemaVersion: 1,
      id: input.jobId,
      version: 1,
      source: { botId: "telecodex-bot", updateId: 42 },
      attachments: [], phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" },
      outcome: null, dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
      acceptedAt: timestamp, updatedAt: timestamp, terminalAt: null, dismissedAt: null, retainUntil: null,
    },
  });
  store.close();
  parentPort.postMessage({ type: "result", created: result.created, jobId: result.job.id });
} catch (error) {
  parentPort.postMessage({ type: "error", message: error instanceof Error ? error.message : "worker error" });
}
