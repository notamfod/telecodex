import { parentPort, workerData } from "node:worker_threads";

import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { ReplanRichDeliveryInput } from "../src/telegram-job-store.js";

const data = workerData as {
  readonly databasePath: string;
  readonly input: ReplanRichDeliveryInput;
  readonly gate: SharedArrayBuffer;
};
const store = new SqliteTelegramJobStore(data.databasePath);
parentPort!.postMessage({ type: "ready" });
Atomics.wait(new Int32Array(data.gate), 0, 0);
try {
  store.replaceRejectedRichDelivery(data.input);
  parentPort!.postMessage({ type: "result", outcome: "success" });
} catch (error) {
  parentPort!.postMessage({
    type: "result",
    outcome: "failure",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  store.close();
}
