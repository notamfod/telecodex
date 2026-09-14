import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";
import { InputFile } from "grammy";

import {
  TelegramBackgroundWriteGateAdmissionCancelledError,
  TelegramBackgroundWriteGateDisposedError,
}
  from "../src/telegram-background-write-gate.js";
import {
  classifyTelegramDeliveryError,
  classifyTelegramStatusError,
  createTelegramAttachmentDownloader,
  createTelegramDeliveryTransport,
  createTelegramStatusTransport,
} from "../src/telegram-grammy-transport.js";

describe("grammY canonical Telegram transports", () => {
  afterEach(() => vi.useRealTimers());

  it("downloads the exact durable file id with a bounded response", async () => {
    const api = { getFile: vi.fn(async () => ({ file_path: "voice/file.ogg", file_size: 3 })) };
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const download = createTelegramAttachmentDownloader({
      api: api as never, botToken: "123:secret", maxBytes: 10, fetch,
    });

    await expect(download(attachment())).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(api.getFile).toHaveBeenCalledWith("file-id", expect.any(AbortSignal));
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bot123:secret/voice/file.ogg",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("refuses metadata and body sizes above the configured limit", async () => {
    const tooLarge = createTelegramAttachmentDownloader({
      api: { getFile: vi.fn(async () => ({ file_path: "x", file_size: 11 })) } as never,
      botToken: "token", maxBytes: 10, fetch: vi.fn(),
    });
    await expect(tooLarge(attachment())).rejects.toThrow("too large");

    const bodyTooLarge = createTelegramAttachmentDownloader({
      api: { getFile: vi.fn(async () => ({ file_path: "x" })) } as never,
      botToken: "token", maxBytes: 2,
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    });
    await expect(bodyTooLarge(attachment())).rejects.toThrow("too large");
  });

  it("bounds a hung getFile call before any download starts", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    const download = createTelegramAttachmentDownloader({
      api: { getFile: vi.fn(() => new Promise(() => {})) } as never,
      botToken: "token",
      maxBytes: 10,
      fetch,
      timeoutMs: 25,
    });
    const outcome = download(attachment()).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);

    await expect(outcome).resolves.toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends and edits the exact durable status destination with bounded action callbacks", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 51 }));
    const editMessageText = vi.fn(async () => ({}));
    const gate = {
      run: vi.fn(async (
        _chatId: number,
        _priority: "ordinary" | "urgent",
        operation: () => Promise<unknown>,
      ) => operation()),
    };
    const transport = createTelegramStatusTransport(
      { sendMessage, editMessageText } as never,
      undefined,
      gate as never,
    );
    const message = {
      chatId: -1001, messageThreadId: 7, html: "<b>Queued</b>", plain: "Queued",
      priority: "urgent" as const,
      admissionSignal: new AbortController().signal,
      projection: {} as never,
      actions: [
        { kind: "abort" as const, jobId: "job-1", expectedVersion: 4 },
        { kind: "details" as const, jobId: "job-1", expectedVersion: 4 },
      ],
    };

    await expect(transport.send(message)).resolves.toBe(51);
    await transport.edit({ ...message, messageId: 51, priority: "ordinary" });

    expect(gate.run.mock.calls.map(([chatId, priority]) => [chatId, priority])).toEqual([
      [-1001, "urgent"],
      [-1001, "ordinary"],
    ]);
    expect(gate.run.mock.calls.map((call) => call[3])).toEqual([
      message.admissionSignal,
      message.admissionSignal,
    ]);

    expect(sendMessage).toHaveBeenCalledWith(-1001, "<b>Queued</b>", expect.objectContaining({
      message_thread_id: 7, parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [expect.objectContaining({ text: "Остановить", callback_data: "tcj:a:job-1:4" })],
        [expect.objectContaining({ text: "Подробности", callback_data: "tcj:d:job-1:4" })],
      ] },
    }), expect.any(AbortSignal));
    expect(editMessageText).toHaveBeenCalledWith(-1001, 51, "<b>Queued</b>", expect.objectContaining({
      parse_mode: "HTML",
    }), expect.any(AbortSignal));
  });

  it("bounds hung status sends and edits so acceptance and startup can continue", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const transport = createTelegramStatusTransport({
      sendMessage: vi.fn((_chatId, _text, _options, signal) => {
        signals.push(signal!);
        return new Promise(() => {});
      }),
      editMessageText: vi.fn((_chatId, _messageId, _text, _options, signal) => {
        signals.push(signal!);
        return new Promise(() => {});
      }),
    } as never, 25);
    const message = {
      chatId: -1001,
      messageThreadId: 7,
      html: "Queued",
      plain: "Queued",
      priority: "urgent" as const,
      projection: {} as never,
      actions: [],
    };
    const sending = transport.send(message).catch((error: unknown) => error);
    const editing = transport.edit({ ...message, messageId: 51 }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);

    await expect(sending).resolves.toBeInstanceOf(Error);
    await expect(editing).resolves.toBeInstanceOf(Error);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("starts the status request timeout only after the background gate admits it", async () => {
    vi.useFakeTimers();
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => { admit = resolve; });
    const signalSeen = vi.fn();
    const gate = {
      run: vi.fn(async (
        _chatId: number,
        _priority: "ordinary" | "urgent",
        operation: () => Promise<unknown>,
      ) => {
        await admitted;
        return operation();
      }),
    };
    const transport = createTelegramStatusTransport({
      sendMessage: vi.fn((_chatId, _text, _options, signal) => {
        signalSeen(signal);
        return new Promise(() => {});
      }),
      editMessageText: vi.fn(),
    } as never, 25, gate as never);
    const sending = transport.send({
      chatId: -1001, messageThreadId: 7, html: "Queued", plain: "Queued",
      priority: "urgent", projection: {} as never, actions: [],
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    expect(signalSeen).not.toHaveBeenCalled();
    admit();
    await vi.advanceTimersByTimeAsync(24);
    expect(signalSeen).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(signalSeen.mock.calls[0]![0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(sending).resolves.toBeInstanceOf(Error);
    expect(signalSeen.mock.calls[0]![0].aborted).toBe(true);
  });

  it("delivers text, known edits, and contained media using the requested operation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-transport-"));
    try {
      writeFileSync(path.join(directory, "answer.png"), "image");
      const api = {
        sendMessage: vi.fn(async () => ({ message_id: 61 })),
        editMessageText: vi.fn(async () => ({})),
        sendPhoto: vi.fn(async () => ({ message_id: 62 })),
        sendDocument: vi.fn(async () => ({ message_id: 63 })),
      };
      const transport = createTelegramDeliveryTransport(api as never, directory);

      await expect(transport.deliver({
        operation: "send_text", chatId: -1001, messageThreadId: 7, text: "answer",
      }, new AbortController().signal)).resolves.toEqual({ messageId: 61 });
      await expect(transport.deliver({
        operation: "send_text", chatId: -1001, messageThreadId: 7, text: "saved",
        replyMarkup: { inlineKeyboard: [[{ text: "Send", callbackData: "jira_post:12" }]] },
      }, new AbortController().signal)).resolves.toEqual({ messageId: 61 });
      await expect(transport.deliver({
        operation: "edit_text", chatId: -1001, messageId: 51, text: "done",
      }, new AbortController().signal)).resolves.toEqual({ messageId: 51 });
      await expect(transport.deliver({
        operation: "send_media", chatId: -1001, messageThreadId: 7,
        mediaKind: "image", path: "answer.png", caption: "caption",
      }, new AbortController().signal)).resolves.toEqual({ messageId: 62 });
      expect(api.sendMessage).toHaveBeenLastCalledWith(-1001, "saved", expect.objectContaining({
        reply_markup: { inline_keyboard: [[{ text: "Send", callback_data: "jira_post:12" }]] },
      }), expect.any(AbortSignal));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uploads legacy send_media from its opened descriptor when the pathname is swapped", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "telecodex-legacy-race-"));
    const directory = path.join(base, "root");
    let uploaded = "";
    let uploadedFd: number | undefined;
    try {
      mkdirSync(directory);
      const insidePath = path.join(directory, "race.png");
      const outsidePath = path.join(base, "outside.png");
      writeFileSync(insidePath, "inside");
      writeFileSync(outsidePath, "outside");
      const api = deliveryApi({
        sendPhoto: vi.fn(async (_chatId: number, input: InputFile) => {
          rmSync(insidePath);
          symlinkSync(outsidePath, insidePath);
          const result = await inputFileBytes(input);
          uploaded = result.bytes;
          uploadedFd = result.fd;
          return { message_id: 62 };
        }),
      });
      const transport = createTelegramDeliveryTransport(api as never, directory);

      await transport.deliver(legacyMedia("race.png"), new AbortController().signal);

      expect(uploaded).toBe("inside");
      expect(uploadedFd).toBeTypeOf("number");
      expectFdClosed(uploadedFd!);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("closes the legacy send_media descriptor when Telegram rejects", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-legacy-cleanup-"));
    let openedFd: number | undefined;
    try {
      writeFileSync(path.join(directory, "valid.png"), "inside");
      const api = deliveryApi({
        sendPhoto: vi.fn(async (_chatId: number, input: InputFile) => {
          openedFd = (await inputFileBytes(input)).fd;
          throw new Error("network failed");
        }),
      });
      const transport = createTelegramDeliveryTransport(api as never, directory);

      await expect(transport.deliver(legacyMedia("valid.png"), new AbortController().signal))
        .rejects.toThrow("network failed");

      expect(openedFd).toBeTypeOf("number");
      expectFdClosed(openedFd!);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects unsafe legacy send_media locally with zero Telegram API calls", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-legacy-unsafe-"));
    try {
      const api = deliveryApi();
      const transport = createTelegramDeliveryTransport(api as never, directory);

      await expect(transport.deliver(legacyMedia("missing.png"), new AbortController().signal))
        .rejects.toMatchObject({
          name: "TelegramDeliveryLocalError", reason: "unsafe_attachment",
          message: "Unsafe Telegram attachment path",
        });

      expect(Object.values(api).every((call) => call.mock.calls.length === 0)).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("classifies only explicit safe retry and permanent Telegram outcomes", () => {
    const retryAfter = { error_code: 429, parameters: { retry_after: 2 } };
    const missingEditedMessage = {
      error_code: 400,
      description: "Bad Request: message to edit not found",
    };
    const disposed = new TelegramBackgroundWriteGateDisposedError();
    const cancelled = new TelegramBackgroundWriteGateAdmissionCancelledError();
    expect(classifyTelegramStatusError("send", disposed)).toEqual({ disposition: "retryable" });
    expect(classifyTelegramStatusError("edit", disposed)).toEqual({ disposition: "retryable" });
    expect(classifyTelegramStatusError("send", cancelled)).toEqual({ disposition: "retryable" });
    expect(classifyTelegramStatusError("edit", cancelled)).toEqual({ disposition: "retryable" });
    expect(classifyTelegramStatusError("edit", retryAfter)).toEqual({
      disposition: "retryable", retryAfterMs: 2_000,
    });
    expect(classifyTelegramStatusError("send", new Error("timeout"))).toEqual({
      disposition: "acceptance_unknown",
    });
    expect(classifyTelegramStatusError("edit", new Error("timeout"))).toEqual({
      disposition: "retryable",
    });
    expect(classifyTelegramStatusError("edit", missingEditedMessage)).toEqual({
      disposition: "message_missing",
    });
    expect(classifyTelegramStatusError("send", missingEditedMessage)).toEqual({
      disposition: "permanent",
    });
    expect(classifyTelegramStatusError("edit", {
      error_code: 400,
      description: "Bad Request: message to edit not found now",
    })).toEqual({ disposition: "permanent" });
    expect(classifyTelegramStatusError("edit", {
      error_code: 400,
      description: "Bad Request: message to edit not found".padEnd(513, "x"),
    })).toEqual({ disposition: "permanent" });
    expect(classifyTelegramStatusError("send", { error_code: 403 })).toEqual({
      disposition: "permanent",
    });
    expect(classifyTelegramStatusError("edit", { error_code: 403 })).toEqual({
      disposition: "permanent",
    });
    expect(classifyTelegramStatusError("edit", {
      error_code: 403,
      description: "Bad Request: message to edit not found",
    })).toEqual({ disposition: "permanent" });

    expect(classifyTelegramDeliveryError(retryAfter)).toMatchObject({
      code: "retry_after", retryAfterMs: 2_000,
    });
    expect(classifyTelegramDeliveryError({
      error: { error_code: 429, parameters: { retry_after: 7_200 } },
    })).toMatchObject({
      code: "retry_after", retryAfterMs: 30_000,
    });
    expect(classifyTelegramDeliveryError({ error_code: 429 })).toMatchObject({
      code: "retry_after", retryAfterMs: 30_000,
    });
    expect(classifyTelegramDeliveryError(
      { error_code: 400, description: "message is not modified" }, "edit_text",
    ))
      .toMatchObject({ code: "message_not_modified" });
    const missingDeliveryMessage = {
      error_code: 400,
      description: "Bad Request: message to edit not found",
    };
    const missing = classifyTelegramDeliveryError(missingDeliveryMessage, "edit_text");
    expect(missing).toMatchObject({ code: "message_missing" });
    expect(missing?.retryAfterMs).toBeUndefined();
    expect(missing?.richReason).toBeUndefined();
    expect(classifyTelegramDeliveryError(missingDeliveryMessage, "edit_rich"))
      .toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError(missingDeliveryMessage, "send_text"))
      .toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError(missingDeliveryMessage, "send_rich"))
      .toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError({
      error_code: 400,
      description: "Bad Request: message to edit not found now",
    }, "edit_text")).toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError({
      error_code: 400,
      description: "Bad Request: message to edit not found".padEnd(513, "x"),
    }, "edit_text")).toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError({
      error_code: 403,
      description: "Bad Request: message to edit not found",
    }, "edit_text")).toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError({ error_code: 403 })).toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError(new Error("timeout"))).toBeNull();
  });

});

function attachment() {
  return {
    id: "voice:unique", kind: "voice" as const, telegramFileId: "file-id",
    telegramFileUniqueId: "unique", size: 3,
  };
}

function deliveryApi(overrides: Record<string, unknown> = {}) {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 61 })),
    editMessageText: vi.fn(async () => ({})),
    sendPhoto: vi.fn(async () => ({ message_id: 62 })),
    sendDocument: vi.fn(async () => ({ message_id: 63 })),
    sendRichMessage: vi.fn(async () => ({ message_id: 64 })),
    ...overrides,
  };
}

function legacyMedia(relativePath: string) {
  return {
    operation: "send_media" as const, chatId: -1001, messageThreadId: 7,
    mediaKind: "image" as const, path: relativePath, caption: "caption",
  };
}

async function inputFileBytes(inputFile: InputFile): Promise<{ bytes: string; fd: number }> {
  const raw = await inputFile.toRaw();
  const fd = await streamFd(raw);
  const chunks: Buffer[] = [];
  for await (const chunk of raw as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks).toString(), fd };
}

async function streamFd(raw: Awaited<ReturnType<InputFile["toRaw"]>>): Promise<number> {
  const stream = raw as { fd?: number | null; once?: (event: string, listener: (...args: unknown[]) => void) => void };
  if (typeof stream.fd === "number") return stream.fd;
  if (typeof stream.once !== "function") throw new Error("Expected file-backed stream");
  return await new Promise<number>((resolve, reject) => {
    stream.once!("open", (fd) => resolve(fd as number));
    stream.once!("error", (error) => reject(error));
  });
}

function expectFdClosed(fd: number): void {
  let closed = false;
  try { fstatSync(fd); }
  catch (error) { closed = (error as NodeJS.ErrnoException).code === "EBADF"; }
  if (!closed) closeSync(fd);
  expect(closed).toBe(true);
}
