import { vi } from "vitest";

import { createTelegramInboxCompletionProcessor } from "../src/telegram-inbox-completion.js";
import type { TelegramWorkSource } from "../src/telegram-job-ingress.js";

const source: TelegramWorkSource = {
  botId: "bot",
  updateId: 9,
  chatId: -1001,
  messageThreadId: 77,
  messageId: 19,
  kind: "confirmation",
  text: "inspect",
  attachment: null,
  retryOfJobId: null,
  completion: { kind: "inbox_ticket", ticketId: 12 },
};

describe("canonical Inbox completion", () => {
  it("strips TOPIC, durably saves the answer, renames once, and plans the exact Jira confirmation", async () => {
    const ticket = {
      id: 12,
      externalKey: "MIR-7000",
      inboxContextKey: "-1001:5",
      workTopicId: 77,
      workspace: "/work",
      prompt: "inspect",
      source: "telegram",
      createdAt: 1,
    };
    const saveAnswer = vi.fn(async () => undefined);
    const renameTopic = vi.fn(async () => true);
    const setTopicTitle = vi.fn((_id: number, title: string) => {
      (ticket as typeof ticket & { topicTitle?: string }).topicTitle = title;
      return true;
    });
    const processor = createTelegramInboxCompletionProcessor({
      getTicket: (id) => id === ticket.id ? ticket : undefined,
      jiraConfigured: true,
      saveAnswer,
      renameTopic,
      setTopicTitle,
      answerWorkspace: "/telecodex",
    });

    const prepared = await processor({
      jobId: "job-1",
      source,
      result: {
        schemaVersion: 1,
        content: [
          { kind: "text", text: "TOPIC: durable queue\n\nUse SQLite." },
          { kind: "attachment", attachment: { kind: "file", path: "outputs/report.md" } },
        ],
      },
    });

    expect(prepared.result.content).toEqual([
      { kind: "text", text: "Use SQLite." },
      { kind: "attachment", attachment: { kind: "file", path: "outputs/report.md" } },
    ]);
    expect(renameTopic).toHaveBeenCalledWith(-1001, 77, "MIR-7000 durable queue");
    expect(setTopicTitle).toHaveBeenCalledWith(12, "durable queue");
    expect(saveAnswer).toHaveBeenCalledWith("/telecodex", 12, "Use SQLite.");
    expect(prepared.supplementalParts).toEqual([{
      partKey: "jira-confirm",
      kind: "notice",
      payload: {
        operation: "send_text",
        chatId: -1001,
        messageThreadId: 77,
        text: "<b>Результат анализа сохранён.</b> Отправить в MIR-7000?",
        replyMarkup: {
          inlineKeyboard: [[{ text: "📤 В Jira", callbackData: "jira_post:12" }]],
        },
      },
    }]);
  });

  it("replays idempotent preparation after a crash but omits Jira confirmation when unavailable", async () => {
    const saveAnswer = vi.fn(async () => undefined);
    const renameTopic = vi.fn(async () => true);
    const ticket = {
      id: 12,
      inboxContextKey: "-1001:5",
      workTopicId: 77,
      workspace: "/work",
      prompt: "inspect",
      source: "telegram",
      createdAt: 1,
    };
    const setTopicTitle = vi.fn((_id: number, title: string) => {
      (ticket as typeof ticket & { topicTitle?: string }).topicTitle = title;
      return true;
    });
    const processor = createTelegramInboxCompletionProcessor({
      getTicket: () => ticket,
      jiraConfigured: false,
      saveAnswer,
      renameTopic,
      setTopicTitle,
      answerWorkspace: "/telecodex",
    });
    const input = {
      jobId: "job-1",
      source,
      result: { schemaVersion: 1 as const, content: [{ kind: "text" as const, text: "TOPIC: queue\n\nAnswer" }] },
    };

    await processor(input);
    const replayed = await processor(input);

    expect(saveAnswer).toHaveBeenCalledTimes(2);
    expect(renameTopic).toHaveBeenCalledOnce();
    expect(replayed.supplementalParts).toEqual([]);
  });

  it("rejects stale or cross-topic ticket metadata before side effects", async () => {
    const saveAnswer = vi.fn(async () => undefined);
    const processor = createTelegramInboxCompletionProcessor({
      getTicket: () => ({
        id: 12,
        inboxContextKey: "-1001:5",
        workTopicId: 99,
        workspace: "/work",
        prompt: "inspect",
        source: "telegram",
        createdAt: 1,
      }),
      jiraConfigured: true,
      saveAnswer,
      renameTopic: vi.fn(async () => true),
      setTopicTitle: vi.fn(() => true),
      answerWorkspace: "/telecodex",
    });

    await expect(processor({
      jobId: "job-1",
      source,
      result: { schemaVersion: 1, content: [{ kind: "text", text: "answer" }] },
    })).rejects.toThrow("Inbox completion context mismatch");
    expect(saveAnswer).not.toHaveBeenCalled();
  });

  it("continues answer persistence and Jira planning when topic rename is rejected", async () => {
    const ticket = {
      id: 12,
      externalKey: "MIR-7000",
      inboxContextKey: "-1001:5",
      workTopicId: 77,
      workspace: "/work",
      prompt: "inspect",
      source: "telegram",
      createdAt: 1,
    };
    const saveAnswer = vi.fn(async () => undefined);
    const setTopicTitle = vi.fn(() => true);
    const processor = createTelegramInboxCompletionProcessor({
      getTicket: () => ticket,
      jiraConfigured: true,
      answerWorkspace: "/telecodex",
      renameTopic: vi.fn(async () => false),
      setTopicTitle,
      saveAnswer,
    });

    const prepared = await processor({
      jobId: "job-rename-failed",
      source,
      result: { schemaVersion: 1, content: [{ kind: "text", text: "TOPIC: queue\n\nAnswer" }] },
    });

    expect(setTopicTitle).not.toHaveBeenCalled();
    expect(saveAnswer).toHaveBeenCalledWith("/telecodex", 12, "Answer");
    expect(prepared.result.content).toEqual([{ kind: "text", text: "Answer" }]);
    expect(prepared.supplementalParts).toHaveLength(1);
  });
});
