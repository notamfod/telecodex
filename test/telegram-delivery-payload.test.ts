import {
  hashTelegramDeliveryPayload,
  normalizeTelegramDeliveryPayload,
} from "../src/telegram-response-plan.js";

describe("Telegram delivery payload canonicalization", () => {
  it("hashes the same strict payload identically regardless of input key insertion order", () => {
    const canonical = { operation: "edit_text", chatId: -1001, messageId: 501, text: "hello" } as const;
    const reordered = { text: "hello", messageId: 501, chatId: -1001, operation: "edit_text" } as const;

    expect(hashTelegramDeliveryPayload(reordered)).toBe(hashTelegramDeliveryPayload(canonical));
    expect(normalizeTelegramDeliveryPayload(reordered)).toEqual(canonical);
  });

  it.each([
    [
      { text: "hello", messageId: 501, chatId: -1001, operation: "edit_text" },
      '{"operation":"edit_text","chatId":-1001,"messageId":501,"text":"hello"}',
      "cea6a244e41ca1a04068cfe9719822fc477498ac3b5fe686fe2a66aee7e05d22",
    ],
    [
      { text: "hello", messageThreadId: null, chatId: -1001, operation: "send_text" },
      '{"operation":"send_text","chatId":-1001,"messageThreadId":null,"text":"hello"}',
      "fc5169cb0b092cf6cb41d96fc46a56b3f0a32ff150c53911e9f60f1490f396d1",
    ],
    [
      { replyMarkup: { inlineKeyboard: [[{ callbackData: "jira_post:12", text: "Send" }]] }, text: "hello", messageThreadId: 77, chatId: -1001, operation: "send_text" },
      '{"operation":"send_text","chatId":-1001,"messageThreadId":77,"text":"hello","replyMarkup":{"inlineKeyboard":[[{"text":"Send","callbackData":"jira_post:12"}]]}}',
      "23b8c80bf1f990cfa1d0de5fdb1ab90c044b6d556ccb003569764846cd24fc91",
    ],
    [
      { caption: "report", name: "report.pdf", path: "outputs/report.pdf", mediaKind: "file", messageThreadId: 77, chatId: -1001, operation: "send_media" },
      '{"operation":"send_media","chatId":-1001,"messageThreadId":77,"mediaKind":"file","path":"outputs/report.pdf","name":"report.pdf","caption":"report"}',
      "1e1dc862d61f1542136f8be4ade009940e7280fdc3b552afb23f0f603c1bb616",
    ],
  ] as const)("retains legacy normalized JSON and hash bytes exactly: %#", (reordered, json, hash) => {
    expect(JSON.stringify(normalizeTelegramDeliveryPayload(reordered))).toBe(json);
    expect(hashTelegramDeliveryPayload(reordered)).toBe(hash);
  });

  it("canonicalizes rich payloads and hashes nested keys deterministically", () => {
    const canonical = {
      operation: "send_rich", chatId: -1001, messageThreadId: 77, markdown: "# Hello",
      media: [{ id: "generated_0001", path: "outputs/chart.png", name: "chart.png" }],
      fallbackParts: [{
        partKey: "final:0000:fallback:0000", kind: "final",
        payload: { operation: "send_text", chatId: -1001, messageThreadId: 77, text: "<b>Hello</b>" },
      }],
    } as const;
    const reordered = {
      fallbackParts: [{ payload: { text: "<b>Hello</b>", messageThreadId: 77, chatId: -1001, operation: "send_text" }, kind: "final", partKey: "final:0000:fallback:0000" }],
      media: [{ name: "chart.png", path: "outputs/chart.png", id: "generated_0001" }],
      markdown: "# Hello", messageThreadId: 77, chatId: -1001, operation: "send_rich",
    } as const;

    expect(normalizeTelegramDeliveryPayload(reordered)).toEqual(canonical);
    expect(hashTelegramDeliveryPayload(reordered)).toBe(hashTelegramDeliveryPayload(canonical));
  });

  it("accepts a summary-scoped rich fallback without colliding with final fallbacks", () => {
    const payload = {
      ...richPayload(),
      fallbackParts: [{
        partKey: "summary:0000:fallback:0000",
        kind: "summary",
        payload: { operation: "send_text", chatId: -1001, messageThreadId: 77, text: "checking" },
      }],
    } as const;

    expect(normalizeTelegramDeliveryPayload(payload)).toEqual(payload);
  });

  it.each([
    [
      {
        operation: "edit_rich", chatId: -1001, messageId: 501, markdown: "# Hello", media: [],
        fallbackParts: [{
          partKey: "final:0000:fallback:0000", kind: "final",
          payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "<b>Hello</b>" },
        }],
      },
      '{"operation":"edit_rich","chatId":-1001,"messageId":501,"markdown":"# Hello","media":[],"fallbackParts":[{"partKey":"final:0000:fallback:0000","kind":"final","payload":{"operation":"edit_text","chatId":-1001,"messageId":501,"text":"<b>Hello</b>"}}]}',
      "a15fc15b436f0edf3971c747b0863eed69e2bdced585933b5320d02a974e4763",
    ],
    [
      {
        operation: "send_rich", chatId: -1001, messageThreadId: 77, markdown: "# Hello",
        media: [{ id: "generated_0001", path: "outputs/chart.png", name: "chart.png" }],
        fallbackParts: [{
          partKey: "final:0000:fallback:0000", kind: "final",
          payload: {
            operation: "send_text", chatId: -1001, messageThreadId: 77, text: "<b>Hello</b>",
          },
        }],
      },
      '{"operation":"send_rich","chatId":-1001,"messageThreadId":77,"markdown":"# Hello","media":[{"id":"generated_0001","path":"outputs/chart.png","name":"chart.png"}],"fallbackParts":[{"partKey":"final:0000:fallback:0000","kind":"final","payload":{"operation":"send_text","chatId":-1001,"messageThreadId":77,"text":"<b>Hello</b>"}}]}',
      "f4b48e367686e34c5501ab0bad55d9e46972f24f46aa7e0991cac7c4084943e2",
    ],
  ] as const)("retains rich normalized JSON and hash bytes exactly: %#", (payload, json, hash) => {
    expect(JSON.stringify(normalizeTelegramDeliveryPayload(payload))).toBe(json);
    expect(hashTelegramDeliveryPayload(payload)).toBe(hash);
  });

  const richPayload = () => ({
    operation: "send_rich" as const,
    chatId: -1001,
    messageThreadId: 77,
    markdown: "hello",
    media: [{ id: "generated_0001", path: "outputs/chart.png" }],
    fallbackParts: [{
      partKey: "final:0000:fallback:0000",
      kind: "final" as const,
      payload: { operation: "send_text" as const, chatId: -1001, messageThreadId: 77, text: "hello" },
    }],
  });

  it.each([
    () => ({ ...richPayload(), extra: true }),
    () => ({ ...richPayload(), media: [{ ...richPayload().media[0], extra: true }] }),
    () => ({ ...richPayload(), fallbackParts: [{ ...richPayload().fallbackParts[0], extra: true }] }),
    () => ({ ...richPayload(), fallbackParts: [{ ...richPayload().fallbackParts[0], payload: { ...richPayload().fallbackParts[0].payload, extra: true } }] }),
  ])("rejects unknown keys at every rich payload level", (makePayload) => {
    expect(() => normalizeTelegramDeliveryPayload(makePayload())).toThrow("Invalid Telegram delivery payload");
  });

  it.each([
    "/tmp/chart.png", "C:/chart.png", "../chart.png", "outputs/../chart.png", "outputs//chart.png", "outputs\\chart.png", "outputs/\0chart.png", "",
  ])("rejects non-contained rich media path %j", (path) => {
    expect(() => normalizeTelegramDeliveryPayload({ ...richPayload(), media: [{ id: "generated_0001", path }] }))
      .toThrow("Invalid Telegram delivery payload");
  });

  it.each(["\n", "\t", "\r", "\u007f"])(
    "rejects legacy and rich media path/name containing control %j",
    (control) => {
      for (const payload of [
        {
          operation: "send_media", chatId: -1001, messageThreadId: 77, mediaKind: "file",
          path: `outputs/bad${control}file`, name: "report.pdf",
        },
        {
          operation: "send_media", chatId: -1001, messageThreadId: 77, mediaKind: "file",
          path: "outputs/report.pdf", name: `bad${control}name`,
        },
        { ...richPayload(), media: [{ id: "generated_0001", path: `outputs/bad${control}file` }] },
        {
          ...richPayload(),
          media: [{ id: "generated_0001", path: "outputs/chart.png", name: `bad${control}name` }],
        },
      ]) {
        expect(() => normalizeTelegramDeliveryPayload(payload)).toThrow("Invalid Telegram delivery payload");
      }
    },
  );

  it("rejects duplicate media IDs and more than 50 media entries", () => {
    const duplicate = [{ id: "generated_0001", path: "outputs/a.png" }, { id: "generated_0001", path: "outputs/b.png" }];
    expect(() => normalizeTelegramDeliveryPayload({ ...richPayload(), media: duplicate }))
      .toThrow("Invalid Telegram delivery payload");
    const excessive = Array.from({ length: 51 }, (_, index) => ({
      id: `generated_${String(index + 1).padStart(4, "0")}`, path: `outputs/${index}.png`,
    }));
    expect(() => normalizeTelegramDeliveryPayload({ ...richPayload(), media: excessive }))
      .toThrow("Invalid Telegram delivery payload");
  });

  it("accepts 64-character media IDs and rejects 65", () => {
    expect(normalizeTelegramDeliveryPayload({
      ...richPayload(), media: [{ id: "a".repeat(64), path: "outputs/chart.png" }],
    })).toMatchObject({ media: [{ id: "a".repeat(64) }] });
    expect(() => normalizeTelegramDeliveryPayload({
      ...richPayload(), media: [{ id: "a".repeat(65), path: "outputs/chart.png" }],
    })).toThrow("Invalid Telegram delivery payload");
  });

  it("ignores inherited optional getters during strict normalization", () => {
    let getterCalls = 0;
    Object.defineProperty(Object.prototype, "replyMarkup", {
      configurable: true,
      get(): never {
        getterCalls += 1;
        throw new Error("prototype getter executed");
      },
    });
    try {
      expect(normalizeTelegramDeliveryPayload({
        operation: "send_text", chatId: -1001, messageThreadId: null, text: "hello",
      })).toEqual({ operation: "send_text", chatId: -1001, messageThreadId: null, text: "hello" });
      expect(getterCalls).toBe(0);
    } finally {
      delete (Object.prototype as { replyMarkup?: unknown }).replyMarkup;
    }
  });

  it("rejects empty or over-32768-code-point rich Markdown", () => {
    expect(() => normalizeTelegramDeliveryPayload({ ...richPayload(), markdown: "" }))
      .toThrow("Invalid Telegram delivery payload");
    expect(() => normalizeTelegramDeliveryPayload({ ...richPayload(), markdown: "😀".repeat(32_769) }))
      .toThrow("Invalid Telegram delivery payload");
    expect(normalizeTelegramDeliveryPayload({ ...richPayload(), markdown: "😀".repeat(32_768) }))
      .toMatchObject({ operation: "send_rich" });
  });

  it.each([
    () => ({ ...richPayload(), fallbackParts: [...richPayload().fallbackParts, richPayload().fallbackParts[0]] }),
    () => ({ ...richPayload(), fallbackParts: [{ ...richPayload().fallbackParts[0], partKey: "final:0:fallback:0000" }] }),
    () => ({
      ...richPayload(),
      fallbackParts: [{ ...richPayload().fallbackParts[0], partKey: "summary:0000:fallback:0000" }],
    }),
    () => ({ ...richPayload(), fallbackParts: [{ ...richPayload().fallbackParts[0], partKey: "final:0000:fallback:0001" }] }),
    () => ({ ...richPayload(), fallbackParts: [
      richPayload().fallbackParts[0],
      { ...richPayload().fallbackParts[0], partKey: "final:0001:fallback:0001" },
    ] }),
    () => ({ ...richPayload(), fallbackParts: [{ ...richPayload().fallbackParts[0], payload: richPayload() }] }),
  ])("rejects colliding, malformed, noncanonical, or recursive fallback parts", (makePayload) => {
    expect(() => normalizeTelegramDeliveryPayload(makePayload())).toThrow("Invalid Telegram delivery payload");
  });

  it.each([
    () => ({ ...richPayload(), chatId: Number.NaN }),
    () => ({ ...richPayload(), messageThreadId: 0 }),
    () => ({ ...richPayload(), markdown: 1 }),
    () => ({ ...richPayload(), media: {} }),
    () => ({ ...richPayload(), fallbackParts: {} }),
    () => ({ ...richPayload(), media: [{ id: "", path: "outputs/chart.png" }] }),
    () => ({ ...richPayload(), media: [{ id: "generated_0001", path: "outputs/chart.png", name: "" }] }),
    () => ({ ...richPayload(), fallbackParts: [{ ...richPayload().fallbackParts[0], kind: "other" }] }),
    () => ({ ...richPayload(), fallbackParts: [{
      ...richPayload().fallbackParts[0],
      payload: { ...richPayload().fallbackParts[0].payload, chatId: -1002 },
    }] }),
    () => ({ ...richPayload(), fallbackParts: [{
      ...richPayload().fallbackParts[0],
      payload: { ...richPayload().fallbackParts[0].payload, messageThreadId: 78 },
    }] }),
    () => ({ ...richPayload(), fallbackParts: [{
      ...richPayload().fallbackParts[0], kind: "attachment",
    }] }),
    () => ({ ...richPayload(), fallbackParts: [{
      ...richPayload().fallbackParts[0], kind: "final",
      payload: {
        operation: "send_media", chatId: -1001, messageThreadId: 77,
        mediaKind: "image", path: "outputs/chart.png",
      },
    }] }),
    () => ({
      operation: "send_rich", chatId: -1001, markdown: "hello",
      media: [], fallbackParts: richPayload().fallbackParts,
    }),
    () => ({
      operation: "send_rich", chatId: -1001, messageThreadId: 77, markdown: "hello",
      fallbackParts: richPayload().fallbackParts,
    }),
    () => ({
      operation: "send_rich", chatId: -1001, messageThreadId: 77, markdown: "hello", media: [],
    }),
    () => ({ ...richPayload(), replyMarkup: { inlineKeyboard: [[{ text: "Send", callbackData: "send", extra: true }]] } }),
    () => ({ operation: "edit_rich", chatId: -1001, messageId: 0, markdown: "hello", media: [], fallbackParts: [] }),
    () => ({
      operation: "edit_rich", chatId: -1001, messageId: 501, markdown: "hello", media: [],
      fallbackParts: [{
        partKey: "final:0001:fallback:0000", kind: "final",
        payload: { operation: "edit_text", chatId: -1001, messageId: 501, text: "hello" },
      }],
    }),
    () => ({
      operation: "edit_rich", chatId: -1001, messageId: 501, markdown: "hello", media: [],
      fallbackParts: [{
        partKey: "final:0000:fallback:0000", kind: "final",
        payload: { operation: "edit_text", chatId: -1001, messageId: 502, text: "hello" },
      }],
    }),
    () => ({
      operation: "edit_rich", chatId: -1001, messageId: 501, markdown: "hello", media: [],
      fallbackParts: [{
        partKey: "final:0000:fallback:0000", kind: "final",
        payload: { operation: "send_text", chatId: -1001, messageThreadId: 77, text: "hello" },
      }],
    }),
  ])("rejects invalid or missing required rich payload fields", (makePayload) => {
    expect(() => normalizeTelegramDeliveryPayload(makePayload())).toThrow("Invalid Telegram delivery payload");
  });

  it.each([
    { operation: "edit_text", chatId: -1001, messageId: 501, text: "hello", extra: true },
    { operation: "send_text", chatId: -1001, messageThreadId: null, text: "" },
    { operation: "send_media", chatId: -1001, messageThreadId: null, mediaKind: "image", path: "../secret" },
    { operation: "unknown", chatId: -1001, text: "hello" },
  ])("rejects malformed or extra-key persisted payloads: %#", (payload) => {
    expect(() => normalizeTelegramDeliveryPayload(payload)).toThrow("Invalid Telegram delivery payload");
    expect(() => hashTelegramDeliveryPayload(payload)).toThrow("Invalid Telegram delivery payload");
  });
});
