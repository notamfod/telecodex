import { describe, expect, it } from "vitest";

import { extractTopicRename, renamedTicketTopic, restoredTicketTopic, resolvedTicketTopic } from "../src/topic-naming.js";

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
      "💬 [Codex] MIR-6319 · Ошибка оплаты",
    );
    expect(renamedTicketTopic({ id: 7 }, "Ошибка оплаты")).toBe("💬 [Codex] #7 · Ошибка оплаты");
  });

  it("respects Telegram's 128-character topic limit", () => {
    expect([...renamedTicketTopic({ id: 7 }, "я".repeat(200))]).toHaveLength(128);
  });
});

it("restores legacy inbox titles from the forwarded text, never the bootstrap instructions", () => {
  expect(restoredTicketTopic({ id: 7, workspace: "/repo/mircli", prompt: "System instructions\n--- начало обращения ---\nОшибка оплаты\n--- конец обращения ---\nMore instructions" } as never))
    .toBe("💬 [mircli] #7 · Ошибка оплаты");
  expect(restoredTicketTopic({ id: 8, externalKey: "MIR-12", workspace: "/repo/mircli", prompt: "Разбери Jira-задачу MIR-12: Проверить услуги\n\nRead only" } as never))
    .toBe("🔎 [mircli] MIR-12 · Проверить услуги");
});

describe("resolvedTicketTopic", () => {
  const ticket = { id: 317, externalKey: "289", workspace: "/repo/antwerp", prompt: "--- начало обращения ---\n🆕 #289 New issue 🟡\nDashboard date filter broken\n--- конец обращения ---" };
  it.each(["#289", "Тикет #317", "💬 [antwerp] #289 · Задача", "💬 [antwerp] #289 · Тикет #317", "💬 [antwerp] #289 · Без описания"])("recovers content from placeholder %s", saved => {
    expect(resolvedTicketTopic(ticket, saved)).toBe("💬 [antwerp] #289 · Dashboard date filter broken");
  });
  it("preserves the latest meaningful name and respects manual ownership", () => {
    expect(resolvedTicketTopic(ticket, "🔎 [antwerp] #289 · Выбор дат", "Календарь")).toBe("💬 [antwerp] #289 · Календарь");
    expect(resolvedTicketTopic(ticket, "🔎 [antwerp] #289 · Выбор дат")).toBe("🔎 [antwerp] #289 · Выбор дат");
  });
  it("keeps emoji-prefixed canonical names within the durable UTF-16 limit", () => {
    const saved = `💬 [mircli] MIR-7124 · ${"а".repeat(106)}`;
    const title = resolvedTicketTopic({ id: 323, externalKey: "MIR-7124", workspace: "/repo/mircli", prompt: "Investigate" }, saved);
    expect(title.length).toBeLessThanOrEqual(128);
    expect(title).toMatch(/…$/u);
  });
  it("recovers recipe findings even when a stored ticket title is a placeholder", () => {
    expect(resolvedTicketTopic({ id: 315, workspace: "/repo/mircli", topicTitle: "Тикет #315", prompt: "Автоматическое ревью\nЧто нашли: Вместо названий фильтров видны slug\nНе коммить" }, "💬 [mircli] #315 · Тикет #315"))
      .toBe("💬 [mircli] #315 · Вместо названий фильтров видны slug");
  });
});
