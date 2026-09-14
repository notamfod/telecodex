import { expectTypeOf } from "vitest";

import {
  buildTelegramResponsePlan,
  type TelegramLegacyDeliveryPayload,
  type TelegramSupplementalResponsePart,
} from "../src/telegram-response-plan.js";
import type { TelegramTurnResult } from "../src/telegram-turn-result.js";

const destination = { chatId: -1001, messageThreadId: 77, anchorMessageId: 501 };

function result(content: TelegramTurnResult["content"]): TelegramTurnResult {
  return { schemaVersion: 1, content };
}

describe("buildTelegramResponsePlan", () => {
  it("keeps supplemental payload ownership legacy-only at compile time", () => {
    expectTypeOf<TelegramSupplementalResponsePart["payload"]>()
      .toEqualTypeOf<TelegramLegacyDeliveryPayload>();
  });

  it("edits the status anchor with compact HTML for one ordinary final answer", () => {
    const plan = buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "# Hello\n\n- one\n- two" }]),
      destination,
    });

    expect(plan.responsePlan).toEqual([]);
    expect(plan.parts).toEqual([]);
    expect(plan.anchor).toEqual(expect.objectContaining({
      partKey: "status-anchor", ordinal: 0, kind: "status-anchor",
      payload: {
        operation: "edit_text", chatId: -1001, messageId: 501,
        text: "<b>Hello</b>\n\n• one\n• two",
      },
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("keeps an advanced table on the existing rich anchor contract", () => {
    const plan = buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" }]),
      destination,
    });

    expect(plan.anchor.payload.operation).toBe("edit_rich");
    expect(plan.anchor.contentHash)
      .toBe("ba6271b979233e17ff6008c3a1c836639587e0cb5b536b490cb0ae3a6c815fbb");
  });

  it("sends each commentary message separately before the final answer", () => {
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", phase: "commentary", text: "Checking." },
        { kind: "text", phase: "commentary", text: "Still checking." },
        { kind: "text", phase: "final_answer", text: "# Done" },
      ] as never),
      destination,
    });

    expect(plan.anchor.payload).toEqual({
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Ответ будет отправлен ниже.",
    });
    expect(plan.responsePlan).toEqual([
      { partId: "summary:0000:0000", kind: "summary" },
      { partId: "summary:0001:0000", kind: "summary" },
      { partId: "final:0000", kind: "final" },
    ]);
    expect(plan.parts).toEqual([
      expect.objectContaining({
        partKey: "summary:0000:0000", ordinal: 0, kind: "summary",
        payload: expect.objectContaining({ operation: "send_text", text: "Checking." }),
      }),
      expect.objectContaining({
        partKey: "summary:0001:0000", ordinal: 1, kind: "summary",
        payload: expect.objectContaining({ operation: "send_text", text: "Still checking." }),
      }),
      expect.objectContaining({
        partKey: "final:0000", ordinal: 2, kind: "final",
        payload: expect.objectContaining({ operation: "send_text", text: "<b>Done</b>" }),
      }),
    ]);
  });

  it("builds one rich image send and keeps documents ordered", () => {
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", text: "chart" },
        { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
        { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf", name: "report.pdf" } },
      ]),
      destination,
    });

    expect(plan.anchor.payload).toEqual({
      operation: "edit_text", chatId: -1001, messageId: 501, text: "Ответ будет отправлен ниже несколькими сообщениями.",
    });
    expect(plan.parts.map((part) => part.payload.operation)).toEqual(["send_rich", "send_media"]);
    expect(plan.parts.map((part) => part.partKey)).toEqual(["final:0000", "attachment:0000"]);
    expect(plan.parts[0]).toMatchObject({
      kind: "final",
      payload: {
        operation: "send_rich",
        markdown: "chart\n\n![](tg://photo?id=generated_0001)",
        media: [{ id: "generated_0001", path: "outputs/chart.png" }],
        fallbackParts: [{
          partKey: "final:0000:fallback:0000", kind: "attachment",
          payload: {
            operation: "send_media", mediaKind: "image", path: "outputs/chart.png", caption: "chart",
          },
        }],
      },
    });
    const richPayload = plan.parts[0]!.payload;
    if (richPayload.operation !== "send_rich") throw new Error("expected rich response part");
    expect(JSON.stringify(richPayload.fallbackParts)).not.toContain("tg://photo");
    expect(plan.parts[1]).toMatchObject({
      kind: "attachment",
      payload: { operation: "send_media", mediaKind: "file", path: "outputs/report.pdf", name: "report.pdf" },
    });
  });

  it("keeps positioned image planning byte-identical", () => {
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", text: "before" },
        { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
        { kind: "text", text: "after" },
      ]),
      destination,
    });

    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]).toMatchObject({
      partKey: "final:0000",
      payload: { operation: "send_rich" },
      contentHash: "edb5ddce182732363bbbb181fe60ab16630e4e18da2babf2aab0766525350529",
    });
  });

  it("does not confuse a user-authored marker with a generated image marker", () => {
    const authored = "![](tg://photo?id=generated_0001)";
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", text: authored },
        { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
      ]),
      destination,
    });

    expect(plan.parts[0]).toMatchObject({ payload: {
      operation: "send_rich",
      markdown: expect.stringContaining("![](tg://photo?id=generated_0002)"),
      media: [{ id: "generated_0002", path: "outputs/chart.png" }],
      fallbackParts: [{
        partKey: "final:0000:fallback:0000", kind: "attachment",
        payload: {
          operation: "send_media", mediaKind: "image", path: "outputs/chart.png", caption: authored,
        },
      }],
    } });
    const payload = plan.parts[0]!.payload;
    if (payload.operation !== "send_rich") throw new Error("expected rich response part");
    expect(JSON.stringify(payload.fallbackParts)).not.toContain("generated_0002");
  });

  it("keeps Unicode text intact in a compact anchor without splitting surrogate pairs", () => {
    const text = `${"a".repeat(1_499)}😀${"b".repeat(1_499)}`;
    const plan = buildTelegramResponsePlan({ result: result([{ kind: "text", text }]), destination });

    expect(plan.anchor.payload).toMatchObject({ operation: "edit_text", text });
    expect(plan.parts).toEqual([]);
    expect(plan.responsePlan).toEqual([]);
  });

  it("splits oversized ordinary text into bounded compact rows", () => {
    const text = `${"a".repeat(2_047)}😀${"b".repeat(2_047)}`;
    const plan = buildTelegramResponsePlan({ result: result([{ kind: "text", text }]), destination });

    expect(plan.anchor.payload).toMatchObject({ operation: "edit_text" });
    expect(plan.parts.length).toBeGreaterThan(1);
    expect(plan.anchor.payload).toMatchObject({ text: "Ответ будет отправлен ниже несколькими сообщениями." });
    expect(plan.parts[0]?.payload).toMatchObject({ text: expect.stringMatching(/^<b>Часть 1 из \d+<\/b>\n\n/) });
    expect(plan.parts.every((part) => part.payload.operation === "send_text")).toBe(true);
    expect(plan.parts.every((part) => part.payload.operation !== "send_text"
      || [...part.payload.text].length <= 4_096)).toBe(true);
  });

  it("preserves text around a generated image before an ordered document", () => {
    const exactCaption = `${"c".repeat(1_022)}😀`;
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", text: exactCaption },
        { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
        { kind: "text", text: "report caption" },
        { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf", name: "report.pdf" } },
      ]),
      destination,
    });

    expect(plan.parts.map((part) => part.payload.operation)).toEqual(["send_rich", "send_media"]);
    expect(plan.parts[0]).toMatchObject({ payload: {
      operation: "send_rich",
      markdown: `${exactCaption}\n\n![](tg://photo?id=generated_0001)\n\nreport caption`,
      media: [{ id: "generated_0001", path: "outputs/chart.png" }],
    } });
    expect(plan.parts[1]).toMatchObject({ payload: {
      operation: "send_media", mediaKind: "file", path: "outputs/report.pdf", name: "report.pdf",
    } });
    expect(plan.parts.map((part) => part.ordinal)).toEqual([0, 1]);
  });

  it("keeps image-associated text above the legacy caption limit in one rich part", () => {
    const oversizedCaption = `${"c".repeat(1_023)}😀`;
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", text: oversizedCaption },
        { kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } },
      ]),
      destination,
    });

    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]).toMatchObject({
      partKey: "final:0000", ordinal: 0,
      payload: {
        operation: "send_rich",
        markdown: `${oversizedCaption}\n\n![](tg://photo?id=generated_0001)`,
        media: [{ id: "generated_0001", path: "outputs/chart.png" }],
      },
    });
  });

  it("keeps partial text and a bounded public failure notice", () => {
    const plan = buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "partial answer" }]), destination,
      failure: { code: "codex_turn_failed", publicDetail: "The turn stopped before completion." },
    });

    expect(plan.parts.map((part) => part.partKey)).toEqual(["final:0000", "notice:failure"]);
    expect(plan.parts.map((part) => part.ordinal)).toEqual([0, 1]);
    expect(plan.anchor.payload).toMatchObject({ operation: "edit_text", text: "Ответ будет отправлен ниже." });
    expect(plan.parts[0]).toMatchObject({
      kind: "final", payload: { operation: "send_text", text: "partial answer" },
    });
    expect(plan.parts[1]).toMatchObject({
      kind: "notice",
      payload: { operation: "send_text", text: "Не удалось завершить задачу. Код: codex_turn_failed. The turn stopped before completion." },
    });
  });

  it("rejects unbounded, control-bearing, or non-public failure detail", () => {
    expect(() => buildTelegramResponsePlan({
      result: result([]), destination,
      failure: { code: "codex_turn_failed", publicDetail: "bad\nstack" },
    })).toThrow("Invalid public failure detail");
    expect(() => buildTelegramResponsePlan({
      result: result([]), destination,
      failure: { code: "codex_turn_failed", publicDetail: "x".repeat(1_025) },
    })).toThrow("Invalid public failure detail");
    expect(() => buildTelegramResponsePlan({
      result: result([]), destination,
      failure: { code: "codex_turn_failed", detail: "raw provider error" } as never,
    })).toThrow("Invalid Telegram response failure");
  });

  it("keeps a response anchor and compact text when no stable anchor message id exists", () => {
    const plan = buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "hello" }]),
      destination: { chatId: -1001, messageThreadId: null, anchorMessageId: null },
    });
    expect(plan.anchor).toMatchObject({
      partKey: "status-anchor",
      payload: { operation: "send_text", chatId: -1001, messageThreadId: null, text: "Ответ будет отправлен ниже." },
    });
    expect(plan.parts).toEqual([expect.objectContaining({
      partKey: "final:0000",
      payload: expect.objectContaining({ operation: "send_text", text: "hello" }),
    })]);
    expect(plan.responsePlan).toEqual([{ partId: "final:0000", kind: "final" }]);
  });

  it("pins empty completed output to a deterministic non-response anchor", () => {
    const plan = buildTelegramResponsePlan({ result: result([]), destination });

    expect(plan.anchor.payload).toEqual({ operation: "edit_text", chatId: -1001, messageId: 501, text: "Готово." });
    expect(plan.responsePlan).toEqual([]);
    expect(plan.parts).toEqual([]);
  });

  it("keeps positioned image and file order byte-for-byte deterministic", () => {
    const input = {
      result: result([
        { kind: "text" as const, text: "before" },
        { kind: "attachment" as const,
          attachment: { kind: "image" as const, path: "outputs/chart.png" } },
        { kind: "text" as const, text: "after" },
        { kind: "attachment" as const,
          attachment: { kind: "file" as const, path: "outputs/report.pdf" } },
      ]),
      destination,
    };
    const plan = buildTelegramResponsePlan(input);
    expect(plan.parts.map((part) => [part.partKey, part.ordinal, part.payload.operation])).toEqual([
      ["final:0000", 0, "send_rich"],
      ["attachment:0000", 1, "send_media"],
    ]);
    expect(plan.parts.map((part) => part.payload.operation === "send_media" ? part.payload.path
      : part.payload.operation === "send_rich" ? part.payload.media.map(({ path }) => path) : []).flat())
      .toEqual(["outputs/chart.png", "outputs/report.pdf"]);
    const richPayload = plan.parts[0]!.payload;
    if (richPayload.operation !== "send_rich") throw new Error("expected rich response part");
    expect(JSON.stringify(richPayload.fallbackParts)).not.toContain("tg://photo");
    expect(JSON.stringify(plan)).toBe(JSON.stringify(buildTelegramResponsePlan(structuredClone(input))));
  });

  it("atomically appends a strict Jira confirmation part after the response", () => {
    const confirmation = {
      partKey: "jira-confirm",
      kind: "notice" as const,
      payload: {
        operation: "send_text" as const,
        chatId: -1001,
        messageThreadId: 77,
        text: "Result saved. Send to MIR-7000?",
        replyMarkup: {
          inlineKeyboard: [[{ text: "Send", callbackData: "jira_post:12" }]],
        },
      },
    };

    const plan = buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "answer" }]),
      destination,
      supplementalParts: [confirmation],
    });

    expect(plan.anchor.payload).toMatchObject({ operation: "edit_text", text: "Ответ будет отправлен ниже." });
    expect(plan.parts.map((part) => part.partKey)).toEqual(["final:0000", "jira-confirm"]);
    expect(plan.parts[0]).toMatchObject({ ordinal: 0, kind: "final", payload: { operation: "send_text" } });
    expect(plan.parts[1]).toEqual(expect.objectContaining({
      partKey: "jira-confirm", ordinal: 1, kind: "notice", payload: confirmation.payload,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(plan.responsePlan).toEqual([
      { partId: "final:0000", kind: "final" },
      { partId: "jira-confirm", kind: "notice" },
    ]);
    expect(() => buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "answer" }]),
      destination,
      supplementalParts: [{ ...confirmation, partKey: "status-anchor" }],
    })).toThrow("Invalid supplemental Telegram response part");
  });

  it("reserves generated fallback keys against supplemental part collisions", () => {
    expect(() => buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" }]),
      destination,
      supplementalParts: [{
        partKey: "final:0000:fallback:0000",
        kind: "notice",
        payload: {
          operation: "send_text", chatId: -1001, messageThreadId: 77, text: "collision",
        },
      }],
    })).toThrow("Invalid supplemental Telegram response part");
  });

  it("rejects a custom rich supplemental part instead of inventing fallback ownership", () => {
    expect(() => buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "answer" }]),
      destination,
      supplementalParts: [{
        partKey: "custom-rich",
        kind: "notice",
        payload: {
          operation: "send_rich", chatId: -1001, messageThreadId: 77,
          markdown: "supplemental", media: [],
          fallbackParts: [{
            partKey: "final:0042:fallback:0000", kind: "notice",
            payload: {
              operation: "send_text", chatId: -1001, messageThreadId: 77, text: "fallback",
            },
          }],
        },
      } as never],
    })).toThrow("Invalid supplemental Telegram response part");
  });

  it("rejects control-bearing generated image names through the durable result seam", () => {
    expect(() => buildTelegramResponsePlan({
      result: result([{
        kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png", name: "chart\n.png" },
      }]),
      destination,
    })).toThrow("Invalid Telegram turn result");
  });

  it("emits formatter-local legacy segments as ordinary stable response parts", () => {
    const plan = buildTelegramResponsePlan({
      result: result([{ kind: "text", text: "<b>unclosed" }]),
      destination,
    });

    expect(plan.anchor.payload).toMatchObject({ operation: "edit_text", text: "Ответ будет отправлен ниже." });
    expect(plan.parts).toEqual([expect.objectContaining({
      partKey: "final:0000", ordinal: 0, kind: "final",
      payload: { operation: "send_text", chatId: -1001, messageThreadId: 77, text: "&lt;b&gt;unclosed" },
    })]);
  });

  it("keeps compact text around a separate file in exact order", () => {
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", text: "before" },
        { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
        { kind: "text", text: "after" },
      ]),
      destination,
    });

    expect(plan.anchor.payload).toMatchObject({ operation: "edit_text", text: "Ответ будет отправлен ниже несколькими сообщениями." });
    expect(plan.parts.map((part) => [part.partKey, part.payload.operation])).toEqual([
      ["final:0000", "send_text"],
      ["attachment:0000", "send_media"],
      ["final:0001", "send_text"],
    ]);
    expect(plan.parts.map((part) => part.ordinal)).toEqual([0, 1, 2]);
  });

  it("uses rich only for the advanced segment in a mixed result", () => {
    const content: TelegramTurnResult["content"] = [
      { kind: "text", text: "ordinary before" },
      { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
      { kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" },
    ];
    const plan = buildTelegramResponsePlan({
      result: result(content),
      destination,
    });

    expect(plan.parts.map((part) => [part.partKey, part.ordinal, part.payload.operation])).toEqual([
      ["final:0000", 0, "send_text"],
      ["attachment:0000", 1, "send_media"],
      ["final:0001", 2, "send_rich"],
    ]);
    const richPayload = plan.parts[2]!.payload;
    if (richPayload.operation !== "send_rich") throw new Error("expected rich response part");
    expect(richPayload.fallbackParts.map(({ partKey }) => partKey))
      .toEqual(["final:0001:fallback:0000"]);
    expect(() => buildTelegramResponsePlan({
      result: result(content),
      destination,
      supplementalParts: [{
        partKey: "final:0001:fallback:0000",
        kind: "notice",
        payload: {
          operation: "send_text", chatId: -1001, messageThreadId: 77, text: "collision",
        },
      }],
    })).toThrow("Invalid supplemental Telegram response part");
  });

  it("keeps an external Markdown image rich before an ordered file", () => {
    const plan = buildTelegramResponsePlan({
      result: result([
        { kind: "text", text: "![chart](https://example.test/chart.png)" },
        { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
      ]),
      destination,
    });

    expect(plan.parts.map((part) => [part.partKey, part.ordinal, part.payload.operation])).toEqual([
      ["final:0000", 0, "send_rich"],
      ["attachment:0000", 1, "send_media"],
    ]);
  });

  it("does not re-read inherited attachment names after turn-result normalization", () => {
    let getterCalls = 0;
    let plan: ReturnType<typeof buildTelegramResponsePlan> | undefined;
    Object.defineProperty(Object.prototype, "name", {
      configurable: true,
      get(): never {
        getterCalls += 1;
        throw new Error("prototype getter executed");
      },
    });
    try {
      plan = buildTelegramResponsePlan({
        result: result([{ kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } }]),
        destination,
      });
    } finally {
      delete (Object.prototype as { name?: unknown }).name;
    }

    expect(getterCalls).toBe(0);
    expect(plan?.parts[0]?.payload).toEqual({
      operation: "send_media", chatId: -1001, messageThreadId: 77,
      mediaKind: "file", path: "outputs/report.pdf",
    });
  });
});
