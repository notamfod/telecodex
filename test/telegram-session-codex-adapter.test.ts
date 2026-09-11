import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";

import { createTelegramSessionCodexAdapter } from "../src/telegram-session-codex-adapter.js";
import type { TelegramCoordinatorTurnCallbacks } from "../src/telegram-job-coordinator.js";
import type { TelegramJob } from "../src/telegram-job-types.js";

const THREAD = "11111111-1111-4111-8111-111111111111";

describe("Telegram session Codex adapter", () => {
  it("resolves the durable topic, creates one thread, and persists registry metadata", async () => {
    const harness = createHarness(null);
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await expect(adapter.resolveThread(job())).resolves.toBe(THREAD);

    expect(harness.registry.getOrCreate).toHaveBeenCalledWith("-1001:7", { deferThreadStart: true });
    expect(harness.session.newThread).toHaveBeenCalledOnce();
    expect(harness.registry.updateMetadata).toHaveBeenCalledWith("-1001:7", harness.session);
  });

  it("applies durable workspace and launch defaults before creating a session", async () => {
    const harness = createHarness(null);
    harness.registry.listContexts.mockReturnValue([]);
    harness.options.store.readSourcePayload = () => ({
      chatId: -1001, messageThreadId: 7,
      sessionDefaults: {
        workspace: "/workspace/project",
        launchProfileId: "readonly",
        topicName: "Sentry review",
      },
    });
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await adapter.resolveThread(job());

    expect(harness.registry.setContextDefaults).toHaveBeenCalledWith("-1001:7", {
      workspace: "/workspace/project",
      launchProfileId: "readonly",
      topicName: "Sentry review",
    });
    expect(harness.registry.setContextDefaults.mock.invocationCallOrder[0]).toBeLessThan(
      harness.registry.getOrCreate.mock.invocationCallOrder[0]!,
    );
  });

  it("binds the Codex session to the durable target topic, not the control callback topic", async () => {
    const harness = createHarness(null);
    harness.registry.listContexts.mockReturnValue([]);
    harness.options.store.readSourcePayload = () => ({
      chatId: -1001, messageThreadId: 7,
      targetContext: { chatId: -1001, messageThreadId: 91 },
      sessionDefaults: { workspace: "/workspace/project", launchProfileId: "readonly" },
    });

    await createTelegramSessionCodexAdapter(harness.options).resolveThread(job());

    expect(harness.registry.setContextDefaults).toHaveBeenCalledWith("-1001:91", expect.any(Object));
    expect(harness.registry.getOrCreate).toHaveBeenCalledWith("-1001:91", { deferThreadStart: true });
  });

  it("refuses to run durable work in an incompatible already-bound session", async () => {
    const harness = createHarness(THREAD);
    harness.registry.listContexts.mockReturnValue([{
      contextKey: "-1001:7", threadId: THREAD,
      workspace: "/workspace/other", launchProfileId: "default",
    }]);
    harness.options.store.readSourcePayload = () => ({
      chatId: -1001, messageThreadId: 7,
      sessionDefaults: { workspace: "/workspace/project", launchProfileId: "readonly" },
    });
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await expect(adapter.resolveThread(job())).rejects.toThrow("session context conflicts");

    expect(harness.registry.getOrCreate).not.toHaveBeenCalled();
  });

  it("durably forks a read-only session before dispatching an implementation authorization", async () => {
    const harness = createHarness(THREAD, { sandboxMode: "read-only" });
    harness.options.store.readSourcePayload = () => ({
      chatId: -1001, messageThreadId: 7,
      implementationHandoffProfileId: "default",
    });
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await expect(adapter.resolveThread(job())).resolves.toBe("forked-thread");

    expect(harness.session.forkThread).toHaveBeenCalledWith("default");
    expect(harness.registry.updateMetadata).toHaveBeenCalledWith("-1001:7", harness.session);
  });

  it("maps materialized text, images, files, and durable callbacks into one existing turn", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-session-output-"));
    const generated = path.join(directory, "generated.png");
    writeFileSync(generated, "image");
    const materializationRoot = path.join(directory, "materialized");
    const harness = createHarness(THREAD, { generatedImagePath: generated, materializationRoot });
    const adapter = createTelegramSessionCodexAdapter(harness.options);
    const observed: string[] = [];
    const callbacks = coordinatorCallbacks(observed);

    try {
      await adapter.startTurn({
        jobId: "job-1", threadId: THREAD,
        prompt: {
          text: "inspect",
          attachments: [
            { id: "photo", kind: "photo", relativePath: "job/photo.jpg", name: "photo.jpg" },
            { id: "doc", kind: "document", relativePath: "job/report.txt", name: "report.txt" },
          ],
        },
        callbacks,
      });

      expect(harness.session.prompt).toHaveBeenCalledWith({
        text: "inspect",
        imagePaths: [path.join(materializationRoot, "job/photo.jpg")],
        stagedFileInstructions: expect.stringContaining("report.txt"),
      }, expect.any(Object));
      const promptInput = harness.session.prompt.mock.calls[0]![0];
      if (typeof promptInput === "string") throw new Error("expected structured prompt");
      expect(promptInput.stagedFileInstructions?.indexOf("report.txt")).toBeLessThan(
        promptInput.stagedFileInstructions?.indexOf("For Telegram readability") ?? -1,
      );
      expect(promptInput.stagedFileInstructions).not.toContain("-1001");
      expect(observed.slice(0, 5)).toEqual([
        "before", "written", "started:turn-1", "activity:tool", "text:answer",
      ]);
      expect(observed[5]).toMatch(/^attachment:outputs\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}-generated\.png$/);
      expect(observed[6]).toBe("outcome:completed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps user text first and appends bounded Telegram code-format guidance", async () => {
    const harness = createHarness(THREAD);
    await createTelegramSessionCodexAdapter(harness.options).startTurn({
      jobId: "job-1", threadId: THREAD,
      prompt: { text: "show commands", attachments: [] }, callbacks: coordinatorCallbacks([]),
    });
    const input = harness.session.prompt.mock.calls[0]![0];
    if (typeof input === "string") throw new Error("expected structured prompt");
    expect(input.text).toBe("show commands");
    expect(input.stagedFileInstructions).toContain(
      "For Telegram readability, wrap every multiline code, command, configuration, SQL, or log excerpt",
    );
    expect(input.stagedFileInstructions).toContain(
      "Use a language tag when known, otherwise use text. Preserve indentation and internal blank lines.",
    );
    expect(input.stagedFileInstructions).toMatch(/Files elsewhere are not delivered\.$/);
  });

  it("builds byte-identical presentation instructions for equivalent prompts", async () => {
    const first = createHarness(THREAD);
    const second = createHarness(THREAD);
    const turn = { jobId: "job-1", threadId: THREAD,
      prompt: { text: "inspect", attachments: [] }, callbacks: coordinatorCallbacks([]) };
    await createTelegramSessionCodexAdapter(first.options).startTurn(turn);
    await createTelegramSessionCodexAdapter(second.options).startTurn(turn);
    const firstInput = first.session.prompt.mock.calls[0]![0];
    const secondInput = second.session.prompt.mock.calls[0]![0];
    if (typeof firstInput === "string" || typeof secondInput === "string") {
      throw new Error("expected structured prompts");
    }
    expect(firstInput.stagedFileInstructions).toBe(secondInput.stagedFileInstructions);
  });

  it("forwards live commentary and final deltas with their logical agent-message boundaries", async () => {
    const harness = createHarness(THREAD);
    harness.session.prompt.mockImplementationOnce(async (_input, callbacks) => {
      emitAgentMessage(callbacks, "commentary-1", "commentary", "Checking.");
      emitAgentMessage(callbacks, "commentary-2", "commentary", "Still checking.");
      emitAgentMessage(callbacks, "final-1", "final_answer", "Done.");
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: 11 });
    });
    const observed: unknown[][] = [];
    const completed: unknown[] = [];
    const callbacks = {
      ...coordinatorCallbacks([]),
      onTextDelta: (...args: unknown[]) => { observed.push(args); },
      onAgentMessageEnd: (message: unknown) => { completed.push(message); },
    };

    await createTelegramSessionCodexAdapter(harness.options).startTurn({
      jobId: "job-1", threadId: THREAD, prompt: { text: "inspect", attachments: [] }, callbacks,
    });

    expect(observed).toEqual([
      ["Checking.", { itemId: "commentary-1", phase: "commentary" }],
      ["Still checking.", { itemId: "commentary-2", phase: "commentary" }],
      ["Done.", { itemId: "final-1", phase: "final_answer" }],
    ]);
    expect(completed).toEqual([
      { itemId: "commentary-1", phase: "commentary" },
      { itemId: "commentary-2", phase: "commentary" },
      { itemId: "final-1", phase: "final_answer" },
    ]);
  });

  it("forwards recovered commentary and final deltas with the same boundaries", async () => {
    const harness = createHarness(THREAD);
    harness.session.recoverPrompt.mockImplementationOnce(async (_turnId, callbacks) => {
      emitAgentMessage(callbacks, "commentary-1", "commentary", "Recovered check.");
      emitAgentMessage(callbacks, "final-1", "final_answer", "Recovered answer.");
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: 11 });
    });
    const observed: unknown[][] = [];
    const completed: unknown[] = [];
    const callbacks = {
      ...coordinatorCallbacks([]),
      onTextDelta: (...args: unknown[]) => { observed.push(args); },
      onAgentMessageEnd: (message: unknown) => { completed.push(message); },
    };

    await createTelegramSessionCodexAdapter(harness.options).recoverTurn({
      jobId: "job-1", threadId: THREAD, prompt: { text: "", attachments: [] }, callbacks,
    }, "turn-exact");

    expect(observed).toEqual([
      ["Recovered check.", { itemId: "commentary-1", phase: "commentary" }],
      ["Recovered answer.", { itemId: "final-1", phase: "final_answer" }],
    ]);
    expect(completed).toEqual([
      { itemId: "commentary-1", phase: "commentary" },
      { itemId: "final-1", phase: "final_answer" },
    ]);
  });

  it.each(["startTurn", "recoverTurn"] as const)(
    "forwards a terminal outcome when %s rejects after observing it",
    async (method) => {
      const harness = createHarness(THREAD);
      const sessionMethod = method === "startTurn" ? harness.session.prompt : harness.session.recoverPrompt;
      sessionMethod.mockImplementationOnce(async (...args: unknown[]) => {
        const callbacks = args.at(-1) as { onTurnOutcome?: (event: { status: string; eventAt: number }) => void };
        callbacks.onTurnOutcome?.({ status: "failed", eventAt: 11 });
        throw new Error("terminal turn failed");
      });
      const observed: string[] = [];
      const adapter = createTelegramSessionCodexAdapter(harness.options);
      const turn = { jobId: "job-1", threadId: THREAD,
        prompt: { text: "inspect", attachments: [] }, callbacks: coordinatorCallbacks(observed) };

      const execution = method === "startTurn"
        ? adapter.startTurn(turn)
        : adapter.recoverTurn(turn, "turn-exact");

      await expect(execution).rejects.toThrow("terminal turn failed");
      expect(observed).toContain("outcome:failed");
    },
  );

  it("delivers a generated document from the per-job durable outbox before the outcome", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-document-output-"));
    const harness = createHarness(THREAD, {
      materializationRoot: path.join(directory, "materialized"),
      produceArtifact: "report.csv",
    });
    const observed: string[] = [];
    try {
      await createTelegramSessionCodexAdapter(harness.options).startTurn({
        jobId: "job-1", threadId: THREAD, prompt: { text: "report", attachments: [] },
        callbacks: coordinatorCallbacks(observed),
      });
      expect(observed.at(-2)).toMatch(/^attachment:outputs\/[0-9a-f]{32}\/artifacts\/report\.csv$/);
      expect(observed.at(-1)).toBe("outcome:completed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reattaches the exact turn without calling prompt or creating a thread", async () => {
    const harness = createHarness(THREAD);
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await adapter.recoverTurn({
      jobId: "job-1", threadId: THREAD, prompt: { text: "", attachments: [] },
      callbacks: coordinatorCallbacks([]),
    }, "turn-exact");

    expect(harness.session.recoverPrompt).toHaveBeenCalledWith("turn-exact", expect.any(Object));
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.session.newThread).not.toHaveBeenCalled();
  });

  it("resumes the SQLite-persisted exact thread when local context metadata is missing", async () => {
    const harness = createHarness(null);
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await adapter.recoverTurn({
      jobId: "job-1", threadId: THREAD, prompt: { text: "", attachments: [] },
      callbacks: coordinatorCallbacks([]),
    }, "turn-exact");

    expect(harness.session.resumeThread).toHaveBeenCalledWith(THREAD);
    expect(harness.session.recoverPrompt).toHaveBeenCalledWith("turn-exact", expect.any(Object));
    expect(harness.registry.updateMetadata).toHaveBeenCalledWith("-1001:7", harness.session);
  });

  it("rejects a session whose durable thread identity changed", async () => {
    const harness = createHarness("different-thread");
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await expect(adapter.startTurn({
      jobId: "job-1", threadId: THREAD, prompt: { text: "x", attachments: [] },
      callbacks: coordinatorCallbacks([]),
    })).rejects.toThrow("Codex thread identity changed");
    expect(harness.session.prompt).not.toHaveBeenCalled();
  });

  it("aborts only the exact registered thread", async () => {
    const harness = createHarness(THREAD);
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await adapter.abortTurn({ threadId: THREAD, turnId: "turn-exact" });

    expect(harness.registry.getOrCreate).toHaveBeenCalledWith("-1001:7", { deferThreadStart: true });
    expect(harness.session.abortTurn).toHaveBeenCalledWith(THREAD, "turn-exact");
    expect(harness.session.abort).not.toHaveBeenCalled();
  });

  it("rejects materialized paths that escape the durable root", async () => {
    const harness = createHarness(THREAD);
    const adapter = createTelegramSessionCodexAdapter(harness.options);

    await expect(adapter.startTurn({
      jobId: "job-1", threadId: THREAD,
      prompt: {
        text: "inspect",
        attachments: [{ id: "doc", kind: "document", relativePath: "../secret", name: "secret" }],
      },
      callbacks: coordinatorCallbacks([]),
    })).rejects.toThrow("Invalid materialized attachment path");
    expect(harness.session.prompt).not.toHaveBeenCalled();
  });

  it("keeps the text result when a generated image path is not a safe file", async () => {
    const harness = createHarness(THREAD, { generatedImagePath: "/missing/generated.png" });
    const adapter = createTelegramSessionCodexAdapter(harness.options);
    const observed: string[] = [];

    await adapter.startTurn({
      jobId: "job-1", threadId: THREAD, prompt: { text: "x", attachments: [] },
      callbacks: coordinatorCallbacks(observed),
    });

    expect(observed).toContain("text:answer");
    expect(observed).toContain("outcome:completed");
    expect(observed.some((item) => item.startsWith("attachment:"))).toBe(false);
  });

  it("preserves repeated generated-image callbacks from one reused source path separately", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-reused-output-"));
    const generated = path.join(directory, "generated.png");
    writeFileSync(generated, "image");
    const harness = createHarness(THREAD, {
      generatedImagePath: generated,
      generatedImageCount: 2,
      materializationRoot: path.join(directory, "materialized"),
    });
    const observed: string[] = [];
    try {
      await createTelegramSessionCodexAdapter(harness.options).startTurn({
        jobId: "job-1", threadId: THREAD, prompt: { text: "x", attachments: [] },
        callbacks: coordinatorCallbacks(observed),
      });
      const attachments = observed.filter((item) => item.startsWith("attachment:"));
      expect(attachments).toHaveLength(2);
      expect(new Set(attachments).size).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists base64-only generated images into the restart-scannable outbox exactly once", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-base64-output-"));
    const harness = createHarness(THREAD, {
      generatedImageBase64: Buffer.from("png-image").toString("base64"),
      materializationRoot: path.join(directory, "materialized"),
    });
    const observed: string[] = [];
    try {
      await createTelegramSessionCodexAdapter(harness.options).startTurn({
        jobId: "job-1", threadId: THREAD, prompt: { text: "x", attachments: [] },
        callbacks: coordinatorCallbacks(observed),
      });

      const attachments = observed.filter((item) => item.startsWith("attachment:"));
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatch(
        /^attachment:outputs\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}-generated\.png$/,
      );
      expect(observed.at(-1)).toBe("outcome:completed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createHarness(
  initialThreadId: string | null,
  options: {
    generatedImagePath?: string;
    generatedImageCount?: number;
    generatedImageBase64?: string;
    produceArtifact?: string;
    materializationRoot?: string;
    sandboxMode?: string;
  } = {},
) {
  let threadId = initialThreadId;
  let sandboxMode = options.sandboxMode ?? "workspace-write";
  const session = {
    getInfo: vi.fn(() => ({ threadId, sandboxMode })),
    newThread: vi.fn(async () => { threadId = THREAD; return { threadId }; }),
    prompt: vi.fn(async (input, callbacks) => {
      callbacks.beforeDispatchWrite?.({ threadId: THREAD, previousTurnId: null, previousTurnKnown: true, attempt: 1 });
      callbacks.onDispatchWritten?.(); callbacks.onStarted?.("turn-1");
      callbacks.onActivity?.({ activity: "tool", eventAt: 10, method: "item/started" });
      callbacks.onTextDelta("answer");
      if (options.produceArtifact) {
        const instructions = typeof input === "string" ? "" : input.stagedFileInstructions ?? "";
        const outbox = instructions.match(/directly into "([^"]+)"/)?.[1];
        if (!outbox) throw new Error("missing durable outbox instruction");
        writeFileSync(path.join(outbox, options.produceArtifact), "a,b\n1,2\n");
      }
      if (options.generatedImagePath) {
        for (let index = 0; index < (options.generatedImageCount ?? 1); index += 1) {
          callbacks.onGeneratedImage?.({ path: options.generatedImagePath });
        }
      }
      if (options.generatedImageBase64) {
        callbacks.onGeneratedImage?.({ base64: options.generatedImageBase64 });
      }
      callbacks.onTurnOutcome?.({ status: "completed", eventAt: 11 });
    }),
    recoverPrompt: vi.fn(async () => undefined),
    forkThread: vi.fn(async () => {
      threadId = "forked-thread";
      sandboxMode = "workspace-write";
      return { threadId };
    }),
    resumeThread: vi.fn(async (nextThreadId: string) => {
      threadId = nextThreadId;
      return { threadId };
    }),
    abortTurn: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const registry = {
    getOrCreate: vi.fn(async () => session), updateMetadata: vi.fn(), setContextDefaults: vi.fn(),
    listContexts: vi.fn(() => [{ contextKey: "-1001:7", threadId: THREAD }]),
  };
  return {
    session, registry,
    options: {
      store: { readSourcePayload: () => ({ chatId: -1001, messageThreadId: 7 }) },
      registry,
      materializationRoot: options.materializationRoot ?? "/workspace/.telecodex/materialized",
    },
  };
}

function coordinatorCallbacks(observed: string[]): TelegramCoordinatorTurnCallbacks {
  return {
    beforeDispatchWrite: () => { observed.push("before"); },
    onDispatchWritten: () => { observed.push("written"); },
    onStarted: (turnId) => { observed.push(`started:${turnId}`); },
    onActivity: ({ activity }) => { observed.push(`activity:${activity}`); },
    onTextDelta: (text) => { observed.push(`text:${text}`); },
    onOutputAttachment: ({ path: value }) => { observed.push(`attachment:${value}`); },
    onTurnOutcome: ({ status }) => { observed.push(`outcome:${status}`); },
  };
}

function emitAgentMessage(
  callbacks: Parameters<ReturnType<typeof createHarness>["session"]["prompt"]>[1],
  itemId: string,
  phase: "commentary" | "final_answer",
  text: string,
): void {
  callbacks.onAgentMessageStart?.({ itemId, phase });
  callbacks.onTextDelta(text);
  callbacks.onAgentMessageEnd?.({ itemId, phase });
}

function job(): TelegramJob {
  return {
    schemaVersion: 1, id: "job-1", version: 1, source: { botId: "bot", updateId: 1 }, attachments: [],
    phase: "queued", health: "healthy", activity: "unknown", attention: { kind: "none" }, outcome: null,
    dispatchId: null, threadId: null, turnId: null, responsePlan: undefined, deliveries: [],
    acceptedAt: 1, updatedAt: 1, terminalAt: null, dismissedAt: null, retainUntil: null,
  };
}
