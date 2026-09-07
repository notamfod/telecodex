import { normalizeTelegramTurnResult } from "../src/telegram-turn-result.js";

describe("normalizeTelegramTurnResult", () => {
  it("preserves ordered logical content as an isolated JSON-safe value", () => {
    const input = {
      schemaVersion: 1,
      content: [
        { kind: "text", text: "First" },
        {
          kind: "attachment",
          attachment: { kind: "image", path: "durable/generated.png", name: "result.png" },
        },
        { kind: "text", text: "Last" },
        { kind: "attachment", attachment: { kind: "file", path: "outputs/report.txt" } },
      ],
    };

    const result = normalizeTelegramTurnResult(input);

    expect(result).toEqual(input);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).not.toBe(input);
    expect(result.content).not.toBe(input.content);
    expect(result.content[1]).not.toBe(input.content[1]);
    expect(result.content[1]?.kind === "attachment" && result.content[1].attachment)
      .not.toBe(input.content[1]?.attachment);

    input.content[0]!.text = "mutated";
    input.content[1]!.attachment!.path = "/mutated";
    expect(result.content[0]).toEqual({ kind: "text", text: "First" });
    expect(result.content[1]).toEqual({
      kind: "attachment",
      attachment: { kind: "image", path: "durable/generated.png", name: "result.png" },
    });
  });

  it("accepts an empty completion without inventing delivery content", () => {
    expect(normalizeTelegramTurnResult({ schemaVersion: 1, content: [] })).toEqual({
      schemaVersion: 1,
      content: [],
    });
  });

  it("preserves agent message phases on durable text content", () => {
    expect(normalizeTelegramTurnResult({
      schemaVersion: 1,
      content: [
        { kind: "text", phase: "commentary", text: "Checking." },
        { kind: "text", phase: "final_answer", text: "Done." },
      ],
    })).toEqual({
      schemaVersion: 1,
      content: [
        { kind: "text", phase: "commentary", text: "Checking." },
        { kind: "text", phase: "final_answer", text: "Done." },
      ],
    });
  });

  it("accepts the documented upper bounds", () => {
    const content = Array.from({ length: 256 }, (_, index) => index === 0
      ? { kind: "text", text: "x".repeat(1_000_000) }
      : {
          kind: "attachment",
          attachment: {
            kind: index % 2 === 0 ? "image" : "file",
            path: "p".repeat(1024),
            name: "n".repeat(1024),
          },
        });

    expect(normalizeTelegramTurnResult({ schemaVersion: 1, content }).content).toHaveLength(256);
  });

  it.each([
    null,
    [],
    { schemaVersion: 2, content: [] },
    { schemaVersion: 1, content: [], extra: true },
    { schemaVersion: 1, content: Array.from({ length: 257 }, () => ({ kind: "text", text: "x" })) },
    { schemaVersion: 1, content: [{ kind: "text", text: "" }] },
    { schemaVersion: 1, content: [{ kind: "text", text: "x".repeat(1_000_001) }] },
    { schemaVersion: 1, content: [{ kind: "text", text: "bad\0text" }] },
    { schemaVersion: 1, content: [{ kind: "text", phase: "reasoning", text: "private" }] },
    { schemaVersion: 1, content: [{ kind: "text", text: "x", extra: true }] },
    { schemaVersion: 1, content: [{ kind: "unknown", text: "x" }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "file", path: "p".repeat(1025) } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "bad\0path" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "/absolute/path" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "../escape" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "safe/../escape" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "safe\\escape" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "safe//file" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "video", path: "result" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "file", path: "result", name: "" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "file", path: "result", name: "n".repeat(1025) } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "file", path: "result", name: "bad\0name" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "file", path: "result", extra: true } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: { kind: "image", path: "result", base64: "AA==" } }] },
    { schemaVersion: 1, content: [{ kind: "attachment", attachment: new (class Attachment {
      kind = "file";
      path = "result";
    })() }] },
  ])("rejects malformed or unbounded input %#", (input) => {
    expect(() => normalizeTelegramTurnResult(input)).toThrow("Invalid Telegram turn result");
  });

  it.each(["\n", "\t", "\r", "\u007f"])(
    "rejects durable attachment path and name containing control %j",
    (control) => {
      expect(() => normalizeTelegramTurnResult({
        schemaVersion: 1,
        content: [{ kind: "attachment", attachment: { kind: "file", path: `outputs/bad${control}file` } }],
      })).toThrow("Invalid Telegram turn result");
      expect(() => normalizeTelegramTurnResult({
        schemaVersion: 1,
        content: [{
          kind: "attachment", attachment: { kind: "file", path: "outputs/file", name: `bad${control}name` },
        }],
      })).toThrow("Invalid Telegram turn result");
    },
  );

  it("rejects JSON-unsafe sparse arrays and symbol properties", () => {
    const sparse = { schemaVersion: 1, content: new Array(1) };
    const symbolProperty = { schemaVersion: 1, content: [] } as Record<PropertyKey, unknown>;
    symbolProperty[Symbol("hidden")] = "not JSON-visible";

    expect(() => normalizeTelegramTurnResult(sparse)).toThrow("Invalid Telegram turn result");
    expect(() => normalizeTelegramTurnResult(symbolProperty)).toThrow("Invalid Telegram turn result");
  });

  it("rejects accessor-backed and subclassed content arrays", () => {
    let getterCalled = false;
    const accessorContent: unknown[] = [];
    Object.defineProperty(accessorContent, 0, {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return { kind: "text", text: "hidden getter" };
      },
    });
    class ContentArray extends Array<unknown> {}

    expect(() => normalizeTelegramTurnResult({ schemaVersion: 1, content: accessorContent }))
      .toThrow("Invalid Telegram turn result");
    expect(getterCalled).toBe(false);
    expect(() => normalizeTelegramTurnResult({
      schemaVersion: 1,
      content: new ContentArray({ kind: "text", text: "subclassed" }),
    })).toThrow("Invalid Telegram turn result");
  });

  it("ignores inherited optional attachment getters", () => {
    let getterCalls = 0;
    Object.defineProperty(Object.prototype, "name", {
      configurable: true,
      get(): never {
        getterCalls += 1;
        throw new Error("prototype getter executed");
      },
    });
    try {
      expect(normalizeTelegramTurnResult({
        schemaVersion: 1,
        content: [{ kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } }],
      })).toEqual({
        schemaVersion: 1,
        content: [{ kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } }],
      });
      expect(getterCalls).toBe(0);
    } finally {
      delete (Object.prototype as { name?: unknown }).name;
    }
  });
});
