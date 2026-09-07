import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  TelegramJobIngress,
  TelegramMaterializationError,
  type TelegramWorkSource,
} from "../src/telegram-job-ingress.js";
import { SqliteTelegramJobStore } from "../src/telegram-job-store.js";
import type { TelegramAttachmentRef } from "../src/telegram-job-types.js";

const START = 1_700_000_000_000;

function attachment(kind: TelegramAttachmentRef["kind"]): TelegramAttachmentRef {
  return {
    id: `${kind}-attachment`,
    kind,
    telegramFileId: `${kind}-file-id`,
    telegramFileUniqueId: `${kind}-unique-id`,
    name: `${kind}-notes.txt`,
    mimeType: kind === "photo" ? "image/jpeg" : "text/plain",
    size: 123,
  };
}

function source(overrides: Partial<TelegramWorkSource> = {}): TelegramWorkSource {
  return {
    botId: "telecodex-bot",
    updateId: 1,
    chatId: -1_000_000_001,
    messageThreadId: 7,
    messageId: 11,
    kind: "text",
    text: "hello",
    attachment: null,
    retryOfJobId: null,
    ...overrides,
  };
}

describe("TelegramJobIngress", () => {
  let directory: string;
  let store: SqliteTelegramJobStore;
  let downloadAttachment: ReturnType<typeof vi.fn>;
  let transcribeAttachment: ReturnType<typeof vi.fn>;
  let nextId: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-job-ingress-"));
    store = new SqliteTelegramJobStore(path.join(directory, "jobs.sqlite"));
    downloadAttachment = vi.fn(async () => new Uint8Array([1, 2, 3]));
    transcribeAttachment = vi.fn(async () => "transcript");
    nextId = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function ingress(overrides: Record<string, unknown> = {}): TelegramJobIngress {
    return new TelegramJobIngress({
      store,
      materializationRoot: path.join(directory, "materialized"),
      now: () => START + nextId,
      createId: () => `generated-${++nextId}`,
      downloadAttachment,
      transcribeAttachment,
      ...overrides,
    });
  }

  it.each([
    ["text", "hello", null],
    ["command", "/status", null],
    ["confirmation", "confirm", null],
    ["voice", null, attachment("voice")],
    ["audio", "caption", attachment("audio")],
    ["photo", "caption", attachment("photo")],
    ["document", null, attachment("document")],
  ] as const)("accepts and durably normalizes a %s source", (kind, text, file) => {
    const input = source({ kind, text, attachment: file });
    const result = ingress().accept(input);

    expect(result.created).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
    expect(store.readSourcePayload(result.job.id)).toEqual(input);
    expect(result.job.attachments).toEqual(file ? [file] : []);
    expect(store.listDeliveries(result.job.id)).toEqual([
      expect.objectContaining({
        partKey: "status-anchor",
        kind: "status-anchor",
        state: "pending",
        payload: {
          chatId: input.chatId,
          messageThreadId: input.messageThreadId,
          sourceMessageId: input.messageId,
        },
      }),
    ]);
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(transcribeAttachment).not.toHaveBeenCalled();
  });

  it("rejects invalid cross-field envelopes before the ledger or effects", () => {
    const app = ingress();
    for (const invalid of [
      source({ messageThreadId: 0 }),
      source({ kind: "voice", text: null, attachment: attachment("audio") }),
      source({ kind: "document", text: null, attachment: null }),
      source({ kind: "retry", retryOfJobId: null }),
      source({ completion: { kind: "inbox_ticket", ticketId: 1 } }),
      source({ completion: { kind: "inbox_ticket", ticketId: 0 } as never }),
      source({ completion: { kind: "other", ticketId: 1 } as never }),
      source({
        kind: "document",
        text: null,
        attachment: { ...attachment("document"), name: "x".repeat(1025) },
      }),
    ]) expect(() => app.accept(invalid)).toThrow("Invalid Telegram work source");
    expect(store.countJobs()).toBe(0);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("persists strict Inbox completion metadata with the accepted source", () => {
    const input = source({
      kind: "confirmation",
      completion: { kind: "inbox_ticket", ticketId: 42 },
    });

    const accepted = ingress().accept(input);

    expect(store.readSourcePayload(accepted.job.id)).toEqual(input);
  });

  it("deduplicates botId and updateId without downstream work", () => {
    const app = ingress();
    const first = app.accept(source());
    const duplicate = app.accept(source({ text: "must not replace the first payload" }));

    expect(duplicate).toEqual({ created: false, job: first.job });
    expect(store.countJobs()).toBe(1);
    expect(store.readSourcePayload(first.job.id)).toEqual(source());
    expect(store.listDeliveries(first.job.id)).toHaveLength(1);
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(transcribeAttachment).not.toHaveBeenCalled();
  });

  it("persists Telegram file metadata before download and materializes idempotently", async () => {
    const file = attachment("document");
    const app = ingress({
      downloadAttachment: vi.fn(async (requested: TelegramAttachmentRef) => {
        const accepted = store.getBySourceKey({ botId: "telecodex-bot", updateId: 1 });
        expect(accepted?.attachments).toEqual([file]);
        expect(store.readSourcePayload(accepted!.id)).toEqual(source({
          kind: "document", text: null, attachment: file,
        }));
        expect(store.listDeliveries(accepted!.id)[0]?.state).toBe("pending");
        expect(requested).toEqual(file);
        return new Uint8Array([4, 5, 6]);
      }),
    });
    const accepted = app.accept(source({ kind: "document", text: null, attachment: file }));

    const prompt = await app.materialize(accepted.job.id);
    const repeated = await app.materialize(accepted.job.id);

    expect(repeated).toEqual(prompt);
    expect(prompt.attachments).toHaveLength(1);
    const relativePath = prompt.attachments[0]!.relativePath;
    expect(path.isAbsolute(relativePath)).toBe(false);
    expect(relativePath.split("/")).not.toContain("..");
    const absolutePath = path.join(directory, "materialized", ...relativePath.split("/"));
    expect(readFileSync(absolutePath)).toEqual(Buffer.from([4, 5, 6]));
    expect(statSync(path.dirname(absolutePath)).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(directory, "materialized")).mode & 0o777).toBe(0o700);
    expect(statSync(absolutePath).mode & 0o777).toBe(0o600);
    expect(store.get(accepted.job.id)).toMatchObject({
      phase: "accepted",
      materializedPrompt: prompt,
    });
    expect(store.listEvents(accepted.job.id).map(({ event }) => event.type)).toEqual([
      "update.accepted", "materialization.succeeded",
    ]);
    expect(JSON.stringify(store.listEvents(accepted.job.id))).not.toContain(directory);
  });

  it.each(["voice", "audio"] as const)("transcribes a materialized %s attachment", async (kind) => {
    const file = attachment(kind);
    const app = ingress();
    const accepted = app.accept(source({ kind, text: "caption", attachment: file }));

    await expect(app.materialize(accepted.job.id)).resolves.toMatchObject({
      text: "caption\ntranscript",
      attachments: [expect.objectContaining({ id: file.id, kind })],
    });
    expect(transcribeAttachment).toHaveBeenCalledOnce();
    expect(transcribeAttachment.mock.calls[0]?.[0]).toMatchObject({ attachment: file });
    expect(path.isAbsolute(transcribeAttachment.mock.calls[0]?.[0].absolutePath)).toBe(true);
  });

  it("records a safe retryable failure and permits a later same-job materialization attempt", async () => {
    const unsafe = "download leaked secret payload";
    downloadAttachment.mockRejectedValueOnce(new Error(unsafe));
    const file = attachment("photo");
    const app = ingress();
    const accepted = app.accept(source({ kind: "photo", text: "caption", attachment: file }));

    await expect(app.materialize(accepted.job.id)).rejects.toMatchObject({
      code: "download_failed",
      message: "Telegram attachment materialization failed",
    });
    expect(store.get(accepted.job.id)).toMatchObject({
      phase: "accepted",
      attention: { kind: "required", code: "materialization_failed", actions: ["retry"] },
    });
    expect(store.listEvents(accepted.job.id).at(-1)?.event).toMatchObject({
      type: "materialization.failed",
      failureCode: "download_failed",
    });
    expect(JSON.stringify(store.listEvents(accepted.job.id))).not.toContain(unsafe);

    await expect(app.materialize(accepted.job.id)).resolves.toMatchObject({ text: "caption" });
    expect(downloadAttachment).toHaveBeenCalledTimes(2);
    expect(store.listEvents(accepted.job.id).map(({ event }) => event.type)).toEqual([
      "update.accepted", "materialization.failed", "materialization.succeeded",
    ]);
  });

  it("bounds a hung download and durably exposes a retryable failure", async () => {
    const app = ingress({
      materializationTimeoutMs: 10,
      downloadAttachment: vi.fn(() => new Promise<Uint8Array>(() => {})),
    });
    const accepted = app.accept(source({
      kind: "document", text: null, attachment: attachment("document"),
    }));

    await expect(app.materialize(accepted.job.id)).rejects.toMatchObject({ code: "download_failed" });

    expect(store.get(accepted.job.id)).toMatchObject({
      phase: "accepted",
      attention: { kind: "required", code: "materialization_failed", actions: ["retry"] },
    });
  });

  it("rejects a symlinked materialization root before download and records a safe failure", async () => {
    const outside = path.join(directory, "outside");
    const linkedRoot = path.join(directory, "linked-materialized");
    symlinkSync(outside, linkedRoot, "dir");
    const app = ingress({ materializationRoot: linkedRoot });
    const accepted = app.accept(source({ kind: "photo", text: null, attachment: attachment("photo") }));

    await expect(app.materialize(accepted.job.id)).rejects.toEqual(
      expect.objectContaining<TelegramMaterializationError>({ code: "staging_failed" }),
    );
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(lstatSync(linkedRoot).isSymbolicLink()).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  it("rejects a symlinked ancestor without creating or chmodding an external directory", async () => {
    const outside = path.join(directory, "outside-existing");
    const linkedParent = path.join(directory, "linked-parent");
    const nestedRoot = path.join(linkedParent, "materialized");
    mkdirSync(outside, { mode: 0o755 });
    symlinkSync(outside, linkedParent, "dir");
    const app = ingress({ materializationRoot: nestedRoot });
    const accepted = app.accept(source({ kind: "photo", text: null, attachment: attachment("photo") }));

    await expect(app.materialize(accepted.job.id)).rejects.toEqual(
      expect.objectContaining<TelegramMaterializationError>({ code: "staging_failed" }),
    );
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(existsSync(path.join(outside, "materialized"))).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  it("rejects a pre-existing shared root without changing its permissions", async () => {
    const sharedRoot = path.join(directory, "shared-root");
    mkdirSync(sharedRoot, { mode: 0o755 });
    const app = ingress({ materializationRoot: sharedRoot });
    const accepted = app.accept(source({ kind: "photo", text: null, attachment: attachment("photo") }));

    await expect(app.materialize(accepted.job.id)).rejects.toEqual(
      expect.objectContaining<TelegramMaterializationError>({ code: "staging_failed" }),
    );
    expect(statSync(sharedRoot).mode & 0o777).toBe(0o755);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("rejects the filesystem root without changing its permissions", async () => {
    const before = statSync("/").mode & 0o777;
    const app = ingress({ materializationRoot: "/" });
    const accepted = app.accept(source({ kind: "photo", text: null, attachment: attachment("photo") }));

    await expect(app.materialize(accepted.job.id)).rejects.toEqual(
      expect.objectContaining<TelegramMaterializationError>({ code: "staging_failed" }),
    );
    expect(statSync("/").mode & 0o777).toBe(before);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("fails synchronous acceptance before effects when storage rejects the transaction", () => {
    const failingStore = {
      getBySourceKey: vi.fn(() => null),
      get: vi.fn(() => null),
      readSourcePayload: vi.fn(),
      transition: vi.fn(),
      acceptUpdate: vi.fn(() => { throw new Error("database or disk is full"); }),
    };
    const app = ingress({ store: failingStore });

    expect(() => app.accept(source())).toThrow(/full/i);
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(transcribeAttachment).not.toHaveBeenCalled();
  });

  it("fails real full and corrupt SQLite storage before external effects or staging", () => {
    const fullPath = path.join(directory, "full.sqlite");
    const fullStore = new SqliteTelegramJobStore(fullPath, { maxPageCount: 1 });
    const fullRoot = path.join(directory, "full-materialized");
    try {
      const app = ingress({ store: fullStore, materializationRoot: fullRoot });
      expect(() => app.accept(source({ text: "x".repeat(64 * 1024) }))).toThrow(/full/i);
      expect(fullStore.getBySourceKey({ botId: "telecodex-bot", updateId: 1 })).toBeNull();
      expect(existsSync(fullRoot)).toBe(false);
    } finally {
      fullStore.close();
    }

    const corruptPath = path.join(directory, "corrupt.sqlite");
    writeFileSync(corruptPath, "not a sqlite database");
    expect(() => new SqliteTelegramJobStore(corruptPath)).toThrow(
      "Unable to open Telegram SQLite job ledger",
    );
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(transcribeAttachment).not.toHaveBeenCalled();
  });

  it("creates a new linked retry job without mutating or replaying the old job", async () => {
    const app = ingress();
    const original = app.accept(source());
    await app.materialize(original.job.id);
    const oldJob = store.get(original.job.id);
    const oldEvents = store.listEvents(original.job.id);
    const oldSource = store.readSourcePayload(original.job.id);

    const retrySource = source({
      updateId: 2,
      messageId: 12,
      kind: "retry",
      text: "retry prompt",
      retryOfJobId: original.job.id,
    });
    const retry = app.accept(retrySource);

    expect(retry.created).toBe(true);
    expect(retry.job.id).not.toBe(original.job.id);
    expect(store.readSourcePayload(retry.job.id)).toEqual(retrySource);
    expect(store.get(original.job.id)).toEqual(oldJob);
    expect(store.listEvents(original.job.id)).toEqual(oldEvents);
    expect(store.readSourcePayload(original.job.id)).toEqual(oldSource);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("returns the durable winner after a stale cross-instance materialization conflict", async () => {
    const winner = ingress({ downloadAttachment: vi.fn(async () => new Uint8Array([7])) });
    const file = attachment("document");
    const accepted = winner.accept(source({ kind: "document", text: "caption", attachment: file }));
    const stale = store.get(accepted.job.id)!;
    let staleReads = 0;
    const staleStore = {
      acceptUpdate: store.acceptUpdate.bind(store),
      getBySourceKey: store.getBySourceKey.bind(store),
      readSourcePayload: store.readSourcePayload.bind(store),
      transition: store.transition.bind(store),
      get: (jobId: string) => {
        staleReads += 1;
        return staleReads <= 2 ? structuredClone(stale) : store.get(jobId);
      },
    };
    let releaseDownload!: (bytes: Uint8Array) => void;
    const losingDownload = vi.fn(() => new Promise<Uint8Array>((resolve) => {
      releaseDownload = resolve;
    }));
    const loser = ingress({ store: staleStore, downloadAttachment: losingDownload });

    const losingResult = loser.materialize(accepted.job.id);
    await vi.waitFor(() => expect(losingDownload).toHaveBeenCalledOnce());
    const winningResult = await winner.materialize(accepted.job.id);
    releaseDownload(new Uint8Array([8]));

    await expect(losingResult).resolves.toEqual(winningResult);
    const relativePath = winningResult.attachments[0]!.relativePath;
    const absolutePath = path.join(directory, "materialized", ...relativePath.split("/"));
    expect(readFileSync(absolutePath)).toEqual(Buffer.from([7]));
    expect(readdirSync(path.dirname(absolutePath))).toEqual([path.basename(absolutePath)]);
    expect(store.listEvents(accepted.job.id).map(({ event }) => event.type)).toEqual([
      "update.accepted", "materialization.succeeded",
    ]);
  });

  it("removes a slow candidate when another instance already published the winner", async () => {
    const winner = ingress({ downloadAttachment: vi.fn(async () => new Uint8Array([7])) });
    const file = attachment("document");
    const accepted = winner.accept(source({ kind: "document", text: "caption", attachment: file }));
    let releaseDownload!: (bytes: Uint8Array) => void;
    const losingDownload = vi.fn(() => new Promise<Uint8Array>((resolve) => {
      releaseDownload = resolve;
    }));
    const loser = ingress({ downloadAttachment: losingDownload });

    const losingResult = loser.materialize(accepted.job.id);
    await vi.waitFor(() => expect(losingDownload).toHaveBeenCalledOnce());
    const winningResult = await winner.materialize(accepted.job.id);
    releaseDownload(new Uint8Array([8]));

    await expect(losingResult).resolves.toEqual(winningResult);
    const relativePath = winningResult.attachments[0]!.relativePath;
    const absolutePath = path.join(directory, "materialized", ...relativePath.split("/"));
    expect(readFileSync(absolutePath)).toEqual(Buffer.from([7]));
    expect(readdirSync(path.dirname(absolutePath))).toEqual([path.basename(absolutePath)]);
    expect(store.listEvents(accepted.job.id).map(({ event }) => event.type)).toEqual([
      "update.accepted", "materialization.succeeded",
    ]);
  });
});
