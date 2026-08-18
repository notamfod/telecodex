import { describe, expect, it } from "vitest";

import { extractTopicRename, renamedTicketTopic } from "../src/topic-naming.js";

describe("extractTopicRename", () => {
  it("extracts a Cyrillic first-line title and preserves markdown answer text", () => {
    expect(extractTopicRename("TOPIC: Ошибка оплаты Мир\n\n**Причина:** таймаут\n\n- шаг 1")).toEqual({
      title: "Ошибка оплаты Мир",
      text: "**Причина:** таймаут\n\n- шаг 1",
    });
  });

  it("requires the marker on the first line", () => {
    expect(extractTopicRename("Вводная строка\nTOPIC: Ошибка оплаты")).toBeUndefined();
    expect(extractTopicRename("Ответ без маркера")).toBeUndefined();
  });

  it("normalizes whitespace and caps a long title at 40 characters", () => {
    const result = extractTopicRename(`TOPIC:   ${"Очень длинное название ".repeat(5)}\n\nОтвет`);

    expect(result?.title).toHaveLength(40);
    expect(result?.title).not.toMatch(/\s{2,}/);
    expect(result?.text).toBe("Ответ");
  });

  it("rejects a title containing a secret", () => {
    expect(extractTopicRename("TOPIC: token sk-ABCDEFGHIJKLMNOPQRSTUV\n\nОтвет")).toBeUndefined();
  });
});

describe("renamedTicketTopic", () => {
  it("preserves an external key or the internal ticket number", () => {
    expect(renamedTicketTopic({ id: 7, externalKey: "MIR-6319" }, "Ошибка оплаты")).toBe(
      "MIR-6319 Ошибка оплаты",
    );
    expect(renamedTicketTopic({ id: 7 }, "Ошибка оплаты")).toBe("#7 Ошибка оплаты");
  });

  it("respects Telegram's 128-character topic limit", () => {
    expect([...renamedTicketTopic({ id: 7 }, "я".repeat(200))]).toHaveLength(128);
  });
});
