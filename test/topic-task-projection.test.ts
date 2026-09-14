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
  ["delivering", "delivering"], ["delivery_failed", "failed"], ["delivery_uncertain", "unknown"],
  ["terminal_failed", "failed"], ["terminal_aborted", "idle"], ["terminal_recovery_interrupted", "unknown"],
])("maps %s to %s", (state, expected) => expect(taskAgentState(projection(state))).toBe(expected));
it("normalizes names, prefixes project or ticket and rejects secrets", () => {
  expect(taskTopicName("Ошибка  оплаты", "mircli", "MIR-12")).toBe("MIR-12 · Ошибка оплаты");
  expect(taskTopicName("Проверка", "mircli")).toBe("mircli · Проверка");
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
