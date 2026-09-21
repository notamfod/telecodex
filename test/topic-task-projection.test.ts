import { describe, it, expect } from "vitest";
import { taskAgentState, taskTopicName, renderTopicTask } from "../src/topic-task-projection.js";
import type { TelegramJobStatusProjection } from "../src/telegram-status-projection.js";
import type { TopicTaskRecord } from "../src/topic-task-store.js";
const projection = (state: string, flags: string[] = []) => ({ state, isDone: state === "terminal_delivered", guardian: { threadStatus: "active" } }) as TelegramJobStatusProjection;
it("distinguishes waiting from stalled and incomplete delivery from a result", () => {
  expect(taskAgentState(projection("stalled"), "input")).toBe("needs_input");
  expect(taskAgentState(projection("running"), "approval")).toBe("needs_approval");
  expect(taskAgentState(projection("terminal_incomplete"))).toBe("unknown");
  expect(taskAgentState(projection("terminal_delivered"))).toBe("result_ready");
});
it.each([
  ["accepted", "accepted"], ["queued", "queued"], ["dispatching_not_sent", "queued"],
  ["dispatching_unknown", "unknown"], ["running", "running"], ["stalled", "stalled"],
  ["delivering", "delivering"], ["delivery_failed", "unknown"], ["delivery_uncertain", "unknown"],
  ["terminal_failed", "failed"], ["terminal_aborted", "idle"], ["terminal_recovery_interrupted", "unknown"],
])("maps %s to %s", (state, expected) => expect(taskAgentState(projection(state))).toBe(expected));
it("normalizes names, prefixes project or ticket and rejects secrets", () => {
  expect(taskTopicName("Ошибка  оплаты", "mircli", "MIR-12")).toBe("💬 [mircli] MIR-12 · Ошибка оплаты");
  expect(taskTopicName("Проверка", "mircli")).toBe("🔎 [mircli] · Проверка");
  expect([...taskTopicName("😀".repeat(200), "test")]).toHaveLength(128);
  expect(() => taskTopicName("sk-" + "a".repeat(60), "test")).toThrow();
});
it("escapes text, exposes pin restriction and keeps task open after delivered run", () => {
  const task = { title: "A < B", workspace: "mircli", lifecycle: "open", agentState: "result_ready", presence: "open",
    chatId: -100123, messageThreadId: 5, lastResultMessageId: 99, lastEventAt: 1000, pinState: "forbidden" } as TopicTaskRecord;
  const card = renderTopicTask(task);
  expect(card.html).toContain("A &lt; B");
  expect(card.html).toContain("Результат готов");
  expect(card.html).not.toContain("Задача завершена");
  expect(card.html).toContain("https://t.me/c/123/99");
  expect(card.plain).toContain("закрепить вручную");
  expect(renderTopicTask({ ...task, lastResultMessageId: null }).html).not.toContain("https://t.me");
});

it("puts state first and omits missing-result and missing-event placeholders", () => {
  const task = { title: "Проверка", workspace: "mircli", lifecycle: "open", agentState: "running", presence: "open",
    chatId: -100123, lastResultMessageId: null, lastEventAt: null, pinState: "pinned" } as TopicTaskRecord;
  const card = renderTopicTask(task);
  expect(card.plain.split("\n")[0]).toBe("В работе");
  expect(card.plain).not.toContain("пока нет");
  expect(card.html).not.toContain("пока нет");
  const waiting = renderTopicTask({ ...task, agentState: "needs_approval" });
  expect(waiting.plain).toContain("Открой запрос");
  expect(waiting.plain.split("\n")[0]).toBe("Нужно твоё разрешение");
});
it("does not rewrite normal cards for timestamp-only observations", () => {
  const task = { title: "Проверка", workspace: "mircli", lifecycle: "open", agentState: "running", presence: "open",
    chatId: -100123, lastResultMessageId: null, lastEventAt: 1000, pinState: "pinned" } as TopicTaskRecord;
  expect(renderTopicTask({ ...task, lastEventAt: 2000 })).toEqual(renderTopicTask(task));
});

it("keeps project and key once when formatting existing or legacy names", () => {
  expect(taskTopicName("MIR-12 · Исправить оплату", "/work/Projects/mircli/mir-back", "MIR-12")).toBe("🛠 [mircli] MIR-12 · Исправить оплату");
  const name = taskTopicName("Проверить права", "/work/antwerp", "286");
  expect(name).toBe("🔎 [antwerp] #286 · Проверить права");
  expect(taskTopicName(name, "/work/antwerp", "286")).toBe(name);
  expect(taskTopicName("telecodex · Единые названия", "/work/telecodex")).toBe("💬 [telecodex] · Единые названия");
});

it("preserves Sentry alphanumeric keys across repeated normalization", () => {
  const name = taskTopicName("Sentry", "mircli", "MIR-BACK-34N");
  expect(name).toBe("🔎 [mircli] MIR-BACK-34N · Sentry");
  expect(taskTopicName(name, "mircli")).toBe(name);
  expect(taskTopicName(name, "mircli", "MIR-BACK-34N")).toBe(name);
});

it("keeps alphabetic Sentry suffixes and title tags", () => {
  const title = taskTopicName("Sentry", "mircli", "MIR-BACK-ABC");
  expect(taskTopicName(title, "mircli", "MIR-BACK-ABC")).toBe(title);
  expect(taskTopicName("🔎 [draft] Review", "mircli", "!12")).toBe("🔎 [mircli] !12 · [draft] Review");
});

it("uses the BuildFlow project rather than its organization directory", () => {
  expect(taskTopicName("Проверить задачу", "/root/dev/Projects/avis/buildflow")).toBe("🔎 [buildflow] · Проверить задачу");
});
