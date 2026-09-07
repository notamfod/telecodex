import { vi } from "vitest";

import {
  handleTelegramWork,
  type TelegramWorkHandlerOptions,
} from "../src/telegram-work-handlers.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";
import type { TelegramAttachmentRef, TelegramJob } from "../src/telegram-job-types.js";

const NOW = 1_700_000_300_000;

describe("handleTelegramWork", () => {
  it.each([
    ["text", "prompt", null, null],
    ["voice", null, attachment("voice"), null],
    ["audio", "caption", attachment("audio"), null],
    ["photo", "caption", attachment("photo"), null],
    ["document", null, attachment("document"), null],
    ["command", "/run recipe", null, null],
    ["confirmation", "confirm deployment", null, null],
    ["retry", "retry prompt", null, "original-job"],
  ] as const)("routes normalized %s work through every durable boundary in order", async (
    kind,
    text,
    file,
    retryOfJobId,
  ) => {
    const harness = createHarness();
    const input = source({ kind, text, attachment: file, retryOfJobId });

    const result = await handleTelegramWork(input, harness.options);

    expect(result).toMatchObject({ created: true, job: { id: "job-1" }, status: { state: "refreshed" } });
    expect(harness.calls).toEqual([
      `accept:${kind}`, "status:job-1", "materialize:job-1", "pump:job-1",
    ]);
  });

  it.each(["photo", "document"] as const)(
    "starts %s attachment work only inside materialization after durable acceptance",
    async (kind) => {
      const calls: string[] = [];
      let accepted = false;
      const input = source({ kind, text: null, attachment: attachment(kind) });
      const options: TelegramWorkHandlerOptions = {
        ingress: {
          accept: () => {
            calls.push("accept");
            accepted = true;
            return { created: true, job: job("attachment-job", input) };
          },
          materialize: async () => {
            calls.push("materialize");
            expect(accepted).toBe(true);
            calls.push("download");
            return { text: "attachment", attachments: [] };
          },
        },
        status: { refresh: async () => { calls.push("status"); } },
        coordinator: { pump: async () => { calls.push("pump"); } },
      };

      await handleTelegramWork(input, options);

      expect(calls).toEqual(["accept", "status", "materialize", "download", "pump"]);
    },
  );

  it("keeps an accepted job moving when status refresh fails and returns no raw detail", async () => {
    const harness = createHarness({ statusError: new Error("secret transport detail") });

    const result = await handleTelegramWork(source(), harness.options);

    expect(result.status).toEqual({ state: "failed", reasonCode: "telegram_status_unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret transport detail");
    expect(harness.calls).toEqual([
      "accept:text", "status:job-1", "materialize:job-1", "pump:job-1",
    ]);
    expect(harness.jobs).toHaveLength(1);
  });

  it("reuses the accepted job on a duplicate update and keeps downstream work idempotent", async () => {
    const harness = createHarness();
    const first = await handleTelegramWork(source(), harness.options);
    const duplicate = await handleTelegramWork(source({ text: "must not replace" }), harness.options);

    expect(first.job.id).toBe("job-1");
    expect(duplicate).toMatchObject({ created: false, job: { id: "job-1" } });
    expect(harness.jobs).toHaveLength(1);
    expect(harness.turns).toEqual(["job-1"]);
    expect(harness.responsePlans).toEqual(["job-1"]);
    expect(harness.materialized).toEqual(["job-1"]);
    expect(harness.calls).toEqual([
      "accept:text", "status:job-1", "materialize:job-1", "pump:job-1",
      "accept:text", "status:job-1", "materialize:job-1", "pump:job-1",
    ]);
  });

  it("rejects non-work routes before ingress", async () => {
    const harness = createHarness();
    const nonWork = { ...source(), kind: "status" } as unknown as TelegramWorkSource;

    await expect(handleTelegramWork(nonWork, harness.options)).rejects.toThrow(
      "Unsupported Telegram work route",
    );

    expect(harness.calls).toEqual([]);
    expect(harness.jobs).toEqual([]);
  });
});

function createHarness(setup: { statusError?: unknown } = {}) {
  const calls: string[] = [];
  const jobs: TelegramJob[] = [];
  const acceptedByUpdate = new Map<string, TelegramJob>();
  const materializedSet = new Set<string>();
  const turnSet = new Set<string>();
  const responsePlanSet = new Set<string>();
  let latestJobId = "";
  const options: TelegramWorkHandlerOptions = {
    ingress: {
      accept: (input) => {
        calls.push(`accept:${input.kind}`);
        const key = `${input.botId}:${input.updateId}`;
        const existing = acceptedByUpdate.get(key);
        if (existing) {
          latestJobId = existing.id;
          return { created: false, job: structuredClone(existing) };
        }
        const accepted = job(`job-${jobs.length + 1}`, input);
        jobs.push(accepted);
        acceptedByUpdate.set(key, accepted);
        latestJobId = accepted.id;
        return { created: true, job: structuredClone(accepted) };
      },
      materialize: async (jobId) => {
        calls.push(`materialize:${jobId}`);
        materializedSet.add(jobId);
        return { text: "materialized", attachments: [] };
      },
    },
    status: {
      refresh: vi.fn(async (jobId) => {
        calls.push(`status:${jobId}`);
        if (setup.statusError !== undefined) throw setup.statusError;
      }),
    },
    coordinator: {
      pump: async () => {
        calls.push(`pump:${latestJobId}`);
        for (const jobId of materializedSet) {
          turnSet.add(jobId);
          responsePlanSet.add(jobId);
        }
      },
    },
  };
  return {
    options,
    calls,
    jobs,
    get materialized() { return [...materializedSet]; },
    get turns() { return [...turnSet]; },
    get responsePlans() { return [...responsePlanSet]; },
  };
}

function source(overrides: Partial<TelegramWorkSource> = {}): TelegramWorkSource {
  return {
    botId: "telecodex-bot", updateId: 17, chatId: -1_000_000_001,
    messageThreadId: 7, messageId: 19, kind: "text", text: "prompt",
    attachment: null, retryOfJobId: null, ...overrides,
  };
}

function attachment(kind: TelegramAttachmentRef["kind"]): TelegramAttachmentRef {
  return {
    id: `${kind}-attachment`, kind, telegramFileId: `${kind}-file-id`,
    telegramFileUniqueId: `${kind}-unique-id`, name: `${kind}.bin`,
    mimeType: "application/octet-stream", size: 4,
  };
}

function job(id: string, input: TelegramWorkSource): TelegramJob {
  return {
    schemaVersion: 1, id, version: 1,
    source: { botId: input.botId, updateId: input.updateId }, attachments: [],
    phase: "accepted", health: "healthy", activity: "unknown", attention: { kind: "none" },
    outcome: null, dispatchId: null, threadId: null, turnId: null, responsePlan: undefined,
    deliveries: [], acceptedAt: NOW, updatedAt: NOW, terminalAt: null,
    dismissedAt: null, retainUntil: null,
  };
}
