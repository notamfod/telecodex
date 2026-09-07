import { transitionJob } from "../src/telegram-job-transition.js";
import type { MaterializedPrompt, TelegramJob } from "../src/telegram-job-types.js";

function acceptedJob(): TelegramJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    version: 1,
    source: { botId: "bot", updateId: 1 },
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
    acceptedAt: 100,
    updatedAt: 100,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
}

const prompt: MaterializedPrompt = {
  text: "hello",
  attachments: [{
    id: "attachment-1",
    kind: "document",
    relativePath: "a1/b2.txt",
    name: "notes.txt",
    mimeType: "text/plain",
  }],
};

describe("Telegram job materialization transitions", () => {
  it("durably records a successfully materialized prompt without Task 7 queueing", () => {
    const result = transitionJob(acceptedJob(), {
      schemaVersion: 1,
      type: "materialization.succeeded",
      eventAt: 101,
      materializedPrompt: prompt,
    });

    expect(result).toEqual({
      kind: "applied",
      job: expect.objectContaining({ phase: "accepted", version: 2, materializedPrompt: prompt }),
    });
  });

  it("keeps a safe retryable accepted projection after materialization failure", () => {
    const result = transitionJob(acceptedJob(), {
      schemaVersion: 1,
      type: "materialization.failed",
      eventAt: 101,
      failureCode: "download_failed",
      attention: { kind: "required", code: "materialization_failed", actions: ["retry"] },
    });

    expect(result).toEqual({
      kind: "applied",
      job: expect.objectContaining({
        phase: "accepted",
        version: 2,
        attention: { kind: "required", code: "materialization_failed", actions: ["retry"] },
      }),
    });
  });

  it.each(["/absolute/file", "../escape", "safe/../escape", "safe\\escape"])(
    "rejects a non-durable materialized path: %s",
    (relativePath) => {
      expect(() => transitionJob(acceptedJob(), {
        schemaVersion: 1,
        type: "materialization.succeeded",
        eventAt: 101,
        materializedPrompt: {
          ...prompt,
          attachments: [{ ...prompt.attachments[0]!, relativePath }],
        },
      })).toThrow();
    },
  );
});
