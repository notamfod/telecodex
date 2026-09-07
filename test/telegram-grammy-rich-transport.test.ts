import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InputFile } from "grammy";
import { vi } from "vitest";

import {
  classifyTelegramDeliveryError,
  createTelegramDeliveryTransport,
} from "../src/telegram-grammy-transport.js";

describe("grammY rich Telegram transport", () => {
  it("sends rich markdown and ordered contained photos to the requested topic", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-rich-transport-"));
    try {
      const firstPath = path.join(directory, "first.png");
      const secondPath = path.join(directory, "second.png");
      writeFileSync(firstPath, "first");
      writeFileSync(secondPath, "second");
      const consumedBytes: string[] = [];
      const api = deliveryApi({
        sendRichMessage: vi.fn(async (...args: unknown[]) => {
          const richMessage = args[1] as { media: Array<{ media: { media: InputFile } }> };
          for (const item of richMessage.media) {
            consumedBytes.push((await inputFileBytes(item.media.media)).bytes);
          }
          return { message_id: 64 };
        }),
      });
      const transport = createTelegramDeliveryTransport(api as never, directory);
      const signal = new AbortController().signal;

      await expect(transport.deliver({
        operation: "send_rich", chatId: -1001, messageThreadId: 7,
        markdown: "chart\n\n![](tg://photo?id=first)\n\n![](tg://photo?id=second)",
        media: [{ id: "first", path: "first.png" }, { id: "second", path: "second.png" }],
        fallbackParts: [sendFallback(7)],
      }, signal)).resolves.toEqual({ messageId: 64 });

      expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
      const [, richMessage, options, passedSignal] = api.sendRichMessage.mock.calls[0]!;
      expect(Object.keys(richMessage as object)).toEqual(["markdown", "media"]);
      expect(richMessage).toMatchObject({
        markdown: "chart\n\n![](tg://photo?id=first)\n\n![](tg://photo?id=second)",
        media: [
          { id: "first", media: { type: "photo", media: expect.any(InputFile) } },
          { id: "second", media: { type: "photo", media: expect.any(InputFile) } },
        ],
      });
      expect(consumedBytes).toEqual(["first", "second"]);
      expect(options).toEqual({ message_thread_id: 7 });
      expect(passedSignal).toBe(signal);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("omits media and topic options from a rich send when they are absent", async () => {
    const api = deliveryApi();
    const transport = createTelegramDeliveryTransport(api as never, "/unused");
    const signal = new AbortController().signal;

    await transport.deliver({
      operation: "send_rich", chatId: -1001, messageThreadId: null,
      markdown: "answer", media: [], fallbackParts: [sendFallback(null)],
    }, signal);

    expect(api.sendRichMessage).toHaveBeenCalledWith(-1001, { markdown: "answer" }, {}, signal);
  });

  it("edits a known message with the typed rich-message argument", async () => {
    const api = deliveryApi();
    const transport = createTelegramDeliveryTransport(api as never, "/unused");
    const signal = new AbortController().signal;

    await expect(transport.deliver({
      operation: "edit_rich", chatId: -1001, messageId: 51,
      markdown: "answer", media: [], fallbackParts: [editFallback()],
    }, signal)).resolves.toEqual({ messageId: 51 });

    expect(api.editMessageText).toHaveBeenCalledWith(-1001, 51, { markdown: "answer" }, {}, signal);
  });

  it("rejects unsafe filesystem media with one stable local error before API", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "telecodex-rich-safety-"));
    const directory = path.join(base, "root");
    try {
      mkdirSync(directory);
      mkdirSync(path.join(directory, "nested"));
      mkdirSync(path.join(base, "outside"));
      writeFileSync(path.join(directory, "valid.png"), "image");
      writeFileSync(path.join(base, "outside.png"), "outside");
      symlinkSync(path.join(base, "outside.png"), path.join(directory, "escape.png"));
      writeFileSync(path.join(base, "outside", "ancestor.png"), "ancestor");
      symlinkSync(path.join(base, "outside"), path.join(directory, "ancestor"));

      for (const mediaPath of ["missing.png", "nested", "escape.png", "ancestor/ancestor.png"]) {
        const api = deliveryApi();
        const transport = createTelegramDeliveryTransport(api as never, directory);
        await expect(transport.deliver({
          operation: "send_rich", chatId: -1001, messageThreadId: 7,
          markdown: "![](tg://photo?id=image)", media: [{ id: "image", path: mediaPath }],
          fallbackParts: [sendFallback(7)],
        }, new AbortController().signal)).rejects.toMatchObject({
          name: "TelegramDeliveryLocalError", reason: "unsafe_attachment",
          message: "Unsafe Telegram attachment path",
        });
        expect(deliveryApiCalls(api)).toBe(0);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    [{ id: "duplicate", path: "valid.png" }, { id: "duplicate", path: "valid.png" }],
    [{ id: "not valid", path: "valid.png" }],
  ])("rejects duplicate or invalid media ids during boundary normalization", async (media) => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-rich-normalize-"));
    try {
      writeFileSync(path.join(directory, "valid.png"), "image");
      const api = deliveryApi();
      const transport = createTelegramDeliveryTransport(api as never, directory);
      await expect(transport.deliver({
        operation: "send_rich", chatId: -1001, messageThreadId: 7,
        markdown: "![](tg://photo?id=image)", media, fallbackParts: [sendFallback(7)],
      } as never, new AbortController().signal)).rejects.toMatchObject({
        name: "Error", message: "Invalid Telegram delivery payload",
      });
      expect(deliveryApiCalls(api)).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["\n", "\t", "\r", "\u007f"])(
    "rejects control %j in a media path or name before Telegram API work",
    async (control) => {
      const api = deliveryApi();
      const transport = createTelegramDeliveryTransport(api as never, "/unused");
      for (const media of [
        [{ id: "image", path: `bad${control}path.png` }],
        [{ id: "image", path: "valid.png", name: `bad${control}name.png` }],
      ]) {
        await expect(transport.deliver({
          operation: "send_rich", chatId: -1001, messageThreadId: 7,
          markdown: "![](tg://photo?id=image)", media, fallbackParts: [sendFallback(7)],
        } as never, new AbortController().signal)).rejects.toThrow("Invalid Telegram delivery payload");
      }
      expect(deliveryApiCalls(api)).toBe(0);
    },
  );

  it("uploads the already-open inside file when its pathname is swapped before consumption", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "telecodex-rich-race-"));
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
        sendRichMessage: vi.fn(async (...args: unknown[]) => {
          rmSync(insidePath);
          symlinkSync(outsidePath, insidePath);
          const result = await inputFileBytes(richInputFile(args[1]));
          uploaded = result.bytes;
          uploadedFd = result.fd;
          return { message_id: 64 };
        }),
      });
      const transport = createTelegramDeliveryTransport(api as never, directory);

      await transport.deliver(richSend([{ id: "race", path: "race.png" }]), new AbortController().signal);

      expect(uploaded).toBe("inside");
      expect(uploadedFd).toBeTypeOf("number");
      expectFdClosed(uploadedFd!);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("closes an earlier valid descriptor when a later rich media item is invalid", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-rich-all-or-nothing-"));
    try {
      const validPath = path.join(directory, "valid.png");
      writeFileSync(validPath, "inside");
      const before = descriptorCount(validPath);
      const api = deliveryApi();
      const transport = createTelegramDeliveryTransport(api as never, directory);

      await expect(transport.deliver(richSend([
        { id: "valid", path: "valid.png" },
        { id: "missing", path: "missing.png" },
      ]), new AbortController().signal)).rejects.toMatchObject({
        name: "TelegramDeliveryLocalError", reason: "unsafe_attachment",
        message: "Unsafe Telegram attachment path",
      });

      expect(descriptorCount(validPath)).toBe(before);
      expect(deliveryApiCalls(api)).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("destroys the rich stream and closes its descriptor when the API rejects", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-rich-api-error-"));
    let openedFd: number | undefined;
    try {
      writeFileSync(path.join(directory, "valid.png"), "inside");
      const api = deliveryApi({
        sendRichMessage: vi.fn(async (...args: unknown[]) => {
          const raw = await richInputFile(args[1]).toRaw();
          openedFd = await streamFd(raw);
          throw new Error("network failed");
        }),
      });
      const transport = createTelegramDeliveryTransport(api as never, directory);

      await expect(transport.deliver(
        richSend([{ id: "valid", path: "valid.png" }]), new AbortController().signal,
      )).rejects.toThrow("network failed");

      expect(openedFd).toBeTypeOf("number");
      expectFdClosed(openedFd!);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a pre-aborted rich delivery before payload, file, or API work", async () => {
    const api = deliveryApi();
    const transport = createTelegramDeliveryTransport(api as never, "/missing-attachment-root");
    const aborted = new AbortController();
    aborted.abort();

    await expect(transport.deliver({
      operation: "send_rich", chatId: -1001, messageThreadId: 7,
      markdown: "![](tg://photo?id=image)", media: [{ id: "image", path: "missing.png" }],
      fallbackParts: [],
    }, aborted.signal)).rejects.toThrow("Telegram delivery aborted");
    expect(deliveryApiCalls(api)).toBe(0);
  });

  it("classifies an unavailable sendRichMessage method before opening rich files", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-rich-method-"));
    const api = deliveryApi();
    Reflect.deleteProperty(api, "sendRichMessage");
    const transport = createTelegramDeliveryTransport(api as never, directory);
    const filePath = path.join(directory, "valid.png");
    writeFileSync(filePath, "inside");
    const before = descriptorCount(filePath);

    try {
      await expect(transport.deliver(
        richSend([{ id: "valid", path: "valid.png" }]), new AbortController().signal,
      )).rejects.toMatchObject({
        name: "TelegramDeliveryApiError", code: "rich_rejected", richReason: "method_unavailable",
        message: "Telegram delivery failed",
      });
      expect(descriptorCount(filePath)).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["send_rich", "edit_rich"] as const)(
    "re-normalizes invalid runtime %s payloads before any Telegram API call",
    async (operation) => {
      const api = deliveryApi();
      const transport = createTelegramDeliveryTransport(api as never, "/unused");
      const payload = operation === "edit_rich"
        ? { operation, chatId: -1001, messageId: 51, markdown: "answer", media: [], fallbackParts: [editFallback()] }
        : {
            operation, chatId: -1001, messageThreadId: 7, markdown: "answer", media: [],
            fallbackParts: [sendFallback(7)],
          };

      await expect(transport.deliver({ ...payload, unknown: true } as never, new AbortController().signal))
        .rejects.toThrow("Invalid Telegram delivery payload");
      expect(deliveryApiCalls(api)).toBe(0);
    },
  );

  it("classifies only bounded allowlisted HTTP 400 failures as safe rich rejection", () => {
    const formatDescription = "Bad Request: can't parse rich message: unsupported tag";
    const format = classifyTelegramDeliveryError(
      { error_code: 400, description: formatDescription }, "send_rich",
    );
    expect(format).toMatchObject({
      code: "rich_rejected", richReason: "format", message: "Telegram delivery failed",
    });
    expect(format?.message).not.toContain(formatDescription);

    const unavailableDescription = "Bad Request: method sendRichMessage is not available";
    const unavailable = classifyTelegramDeliveryError(
      { error_code: 400, description: unavailableDescription }, "send_rich",
    );
    expect(unavailable).toMatchObject({
      code: "rich_rejected", richReason: "method_unavailable", message: "Telegram delivery failed",
    });
    expect(unavailable?.message).not.toContain(unavailableDescription);

    expect(classifyTelegramDeliveryError(
      { error_code: 400, description: formatDescription }, "send_text",
    )).toMatchObject({ code: "permanent" });
    for (const description of [
      "Bad Request: chat not found",
      "Bad Request: message thread not found",
      "Bad Request: not enough rights to send photos",
      `${formatDescription}${"x".repeat(1_024)}`,
    ]) {
      expect(classifyTelegramDeliveryError({ error_code: 400, description }, "send_rich"))
        .toMatchObject({ code: "permanent" });
    }
    expect(classifyTelegramDeliveryError({ error_code: 403 }, "send_rich"))
      .toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError(new Error("network timeout"), "send_rich")).toBeNull();
  });

  it("does not infer rich edit capability from generic or send-only unavailable methods", () => {
    for (const description of [
      "Bad Request: method not found",
      "Bad Request: method is not available",
      "Bad Request: method sendRichMessage is not available",
      "Bad Request: method editMessageText is not available",
    ]) {
      expect(classifyTelegramDeliveryError({ error_code: 400, description }, "edit_rich"))
        .toMatchObject({ code: "permanent" });
    }
    expect(classifyTelegramDeliveryError({
      error_code: 400, description: "Bad Request: Rich Messages are not available",
    }, "edit_rich")).toMatchObject({ code: "rich_rejected", richReason: "method_unavailable" });
  });

  it("classifies message-not-modified only for HTTP 400 edit operations", () => {
    const description = "Bad Request: message is not modified";
    for (const operation of ["edit_text", "edit_rich"] as const) {
      expect(classifyTelegramDeliveryError({ error_code: 400, description }, operation))
        .toMatchObject({ code: "message_not_modified" });
    }
    for (const operation of ["send_text", "send_rich"] as const) {
      expect(classifyTelegramDeliveryError({ error_code: 400, description }, operation))
        .toMatchObject({ code: "permanent" });
    }
    expect(classifyTelegramDeliveryError({ error_code: 403, description }, "edit_rich"))
      .toMatchObject({ code: "permanent" });
    expect(classifyTelegramDeliveryError({ description }, "edit_text")).toBeNull();
  });
});

function deliveryApi(overrides: Partial<Record<"sendRichMessage", ReturnType<typeof vi.fn>>> = {}) {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 61 })),
    editMessageText: vi.fn(async () => ({})),
    sendPhoto: vi.fn(async () => ({ message_id: 62 })),
    sendDocument: vi.fn(async () => ({ message_id: 63 })),
    sendRichMessage: vi.fn(async (..._args: unknown[]) => ({ message_id: 64 })),
    ...overrides,
  };
}

function richSend(media: Array<{ id: string; path: string }>) {
  return {
    operation: "send_rich" as const, chatId: -1001, messageThreadId: 7,
    markdown: "![](tg://photo?id=valid)", media, fallbackParts: [sendFallback(7)],
  };
}

function richInputFile(value: unknown): InputFile {
  const media = (value as { media: Array<{ media: { media: unknown } }> }).media[0]?.media.media;
  if (!(media instanceof InputFile)) throw new Error("Expected rich InputFile");
  return media;
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

function descriptorCount(filePath: string): number {
  return readdirSync("/proc/self/fd").filter((entry) => {
    try { return readlinkSync(`/proc/self/fd/${entry}`) === filePath; }
    catch { return false; }
  }).length;
}

function expectFdClosed(fd: number): void {
  let closed = false;
  try { fstatSync(fd); }
  catch (error) { closed = (error as NodeJS.ErrnoException).code === "EBADF"; }
  if (!closed) closeSync(fd);
  expect(closed).toBe(true);
}

function deliveryApiCalls(api: ReturnType<typeof deliveryApi>): number {
  return Object.values(api).reduce((count, call) => count + call.mock.calls.length, 0);
}

function sendFallback(messageThreadId: number | null) {
  return {
    partKey: "final:0000:fallback:0000", kind: "final" as const,
    payload: { operation: "send_text" as const, chatId: -1001, messageThreadId, text: "answer" },
  };
}

function editFallback() {
  return {
    partKey: "final:0000:fallback:0000", kind: "final" as const,
    payload: { operation: "edit_text" as const, chatId: -1001, messageId: 51, text: "answer" },
  };
}
