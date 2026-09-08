import { parentPort, workerData } from "node:worker_threads";

import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { ReserveTopicResumeInput } from "../src/telegram-topic-resume-ledger.js";

const input = workerData as {
  readonly databasePath: string;
  readonly reserveInput: ReserveTopicResumeInput;
  readonly gate: SharedArrayBuffer;
};
if (!parentPort) throw new Error("Telegram topic resume worker requires parentPort");

const store = new SqliteTelegramJobStore(input.databasePath);
parentPort.postMessage({ type: "ready" });
Atomics.wait(new Int32Array(input.gate), 0, 0);
try {
  store.reserveTopicResume(input.reserveInput);
  parentPort.postMessage({ type: "result", outcome: "success" });
} catch (error) {
  parentPort.postMessage({
    type: "result",
    outcome: "failure",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  store.close();
}
