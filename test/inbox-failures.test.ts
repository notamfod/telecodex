import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInboxHandlers } from "../src/bot-inbox.js";
import { makeInboxFailure } from "../src/inbox-failures.js";
import { InboxStore } from "../src/inbox.js";

const dirs: string[] = [];
function harness() {
  vi.useFakeTimers();
  const dir = mkdtempSync(path.join(tmpdir(), "inbox-failures-"));
  dirs.push(dir);
  const file = path.join(dir, "inbox.json");
  const inbox = new InboxStore(file);
  inbox.enable("-1001:7", { workspace: dir, template: "{message}" });
  const commands = new Map<string, (ctx: any) => Promise<void>>();
  const callbacks = new Map<string, (ctx: any) => Promise<void>>();
  let message!: (ctx: any, next: () => Promise<void>) => Promise<void>;
  const forwardMessage = vi.fn().mockRejectedValue(new Error("attachment SECRET_PAYLOAD"));
  const createForumTopic = vi.fn().mockRejectedValue(new Error("fetch failed SECRET_PAYLOAD"));
  const sendText = vi.fn().mockResolvedValue(undefined);
  const safeReply = vi.fn().mockResolvedValue(undefined);
  registerInboxHandlers({
    bot: {
      command: (name: string, fn: any) => commands.set(name, fn),
      callbackQuery: (pattern: RegExp, fn: any) => callbacks.set(pattern.source, fn),
      on: (_event: string, fn: any) => { message = fn; },
      api: { createForumTopic, forwardMessage },
    } as never,
    config: { workspace: dir } as never,
    registry: { setContextDefaults: vi.fn() } as never,
    inbox,
    topicActivity: { rememberIdleIcon: vi.fn() },
    getContextSession: vi.fn(), isBusy: vi.fn(), handleTicketPrompt: vi.fn(),
    topicIsAlive: vi.fn(), sendText, safeReply,
  });
  const deliver = (id: number, attachment = false, text = "A support request") => message({ chat: { id: -1001 }, message: {
    photo: attachment ? [{}] : undefined, message_id: id, message_thread_id: 7, text,
  } }, vi.fn());
  return { file, inbox, commands, callbacks, createForumTopic, sendText, safeReply, deliver,
    decision: (kind: "batch" | "duplicate") => inbox.getProvisioningService().store.listPending().find(([id]) => id.startsWith(`${kind}:`))![0].split(":")[1],
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe("Inbox asynchronous failure feedback", () => {
  it("persists source references without raw errors and retains its pending ticket and does not retry uncertain creation", async () => {
    const h = harness();
    await h.deliver(77);
    await vi.advanceTimersByTimeAsync(2_000);
    const reloaded = new InboxStore(h.file);
    expect(reloaded.listUnresolved()).toEqual([expect.objectContaining({ id: 1, workTopicId: 0 })]);
    expect(h.inbox.getProvisioningService().store.list()[0]).toMatchObject({ state: "unknown", metadata: { ticketId: 1 }, sourceMessageIds: [77] });
    expect(JSON.parse(readFileSync(h.file, "utf8")).failures).toEqual([expect.objectContaining({
      contextKey: "-1001:7", messageIds: [77], outcome: "creation_unknown", category: "acceptance_unknown",
    })]);
    expect(readFileSync(h.file, "utf8")).not.toContain("SECRET_PAYLOAD");
    expect(h.sendText).toHaveBeenCalledWith(-1001, expect.stringContaining("не подтверждено"), expect.objectContaining({ messageThreadId: 7 }));
    expect(h.sendText.mock.calls[0][1]).not.toMatch(/SECRET|перешли|заново/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.createForumTopic).toHaveBeenCalledOnce();
  });

  it("keeps failed notice discoverable through status after reload", async () => {
    const h = harness();
    h.sendText.mockRejectedValue(new Error("notice SECRET_PAYLOAD"));
    await h.deliver(78);
    await vi.advanceTimersByTimeAsync(2_000);
    await h.commands.get("inbox")!({ chat: { id: -1001 }, message: { message_thread_id: 7, text: "/inbox status" } });
    expect(h.safeReply.mock.calls.at(-1)![1]).toContain("78");
    expect(h.safeReply.mock.calls.at(-1)![1]).toContain("не подтверждено");
    expect(new InboxStore(h.file).listFailures("-1001:7")).toHaveLength(1);
  });

  it("reports the known created topic when card delivery fails", async () => {
    const h = harness();
    h.createForumTopic.mockResolvedValue({ message_thread_id: 99 });
    h.sendText.mockRejectedValueOnce(new Error("card SECRET_PAYLOAD"));
    await h.deliver(79);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.inbox.listUnresolved()[0].workTopicId).toBe(99);
    expect(h.sendText.mock.calls.at(-1)![1]).toContain("Топик существует");
    expect(h.sendText.mock.calls.at(-1)![1]).toContain("99");
    expect(h.inbox.listFailures("-1001:7")[0]).toMatchObject({ outcome: "topic_exists", workTopicId: 99 });
    expect(h.createForumTopic).toHaveBeenCalledOnce();
  });

  it("retains original messages if sending the split question fails", async () => {
    const h = harness();
    h.sendText.mockRejectedValueOnce(new Error("question SECRET_PAYLOAD"));
    await h.deliver(82); await h.deliver(83);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.inbox.listFailures("-1001:7")[0]).toMatchObject({ messageIds: [82, 83], outcome: "processing_failed" });
    expect(h.createForumTopic).not.toHaveBeenCalled();
  });

  it("does not suggest blindly forwarding again from an expired batch button", async () => {
    const h = harness();
    const answerCallbackQuery = vi.fn();
    await h.callbacks.get("^inbox_batch:(\\d+):(one|each|cancel)$")!({ match: ["", "999", "each"], answerCallbackQuery });
    expect(answerCallbackQuery.mock.calls[0][0].text).not.toMatch(/перешли|заново/);
    expect(answerCallbackQuery.mock.calls[0][0].text).toContain("/inbox status");
    expect(h.createForumTopic).not.toHaveBeenCalled();
  });

  it.each(["answerCallbackQuery", "editMessageText"])("retains batch sources and executes the durable choice once if %s fails", async (method) => {
    const h = harness();
    await h.deliver(84); await h.deliver(85);
    await vi.advanceTimersByTimeAsync(2_000);
    const ctx = { match: ["", h.decision("batch"), "each"], chat: { id: -1001 }, callbackQuery: { message: { message_thread_id: 7 } }, answerCallbackQuery: vi.fn(), editMessageText: vi.fn() };
    ctx[method as "answerCallbackQuery" | "editMessageText"].mockRejectedValue(new Error("callback SECRET_PAYLOAD"));
    const run = h.callbacks.get("^inbox_batch:(\\d+):(one|each|cancel)$")!(ctx);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(run).resolves.toBeUndefined();
    expect(new InboxStore(h.file).listFailures("-1001:7")).toEqual(expect.arrayContaining([expect.objectContaining({ messageIds: [84, 85], outcome: "processing_failed" })]));
    expect(h.createForumTopic).toHaveBeenCalledTimes(2);
    expect(h.inbox.getProvisioningService().store.list().map(record => record.state)).toEqual(["unknown", "unknown"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.createForumTopic).toHaveBeenCalledTimes(2);
    expect(h.sendText.mock.calls.at(-1)![1]).not.toContain("SECRET_PAYLOAD");
  });

  it("retains duplicate source and executes its durable choice once if acknowledgement fails", async () => {
    const h = harness();
    h.inbox.createTicket({ inboxContextKey: "-1001:7", externalKey: "MIR-123", workTopicId: 0,
      workspace: "/work", prompt: "Investigate", source: "telegram" });
    await h.deliver(86, false, "MIR-123 repeated request");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(h.callbacks.get("^ticket_dup:(\\d+):(reuse|new)$")!({
      match: ["", h.decision("duplicate"), "reuse"], chat: { id: -1001 }, callbackQuery: { message: { message_thread_id: 7 } }, editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined), answerCallbackQuery: vi.fn().mockRejectedValue(new Error("callback SECRET_PAYLOAD")),
    })).resolves.toBeUndefined();
    expect(new InboxStore(h.file).listFailures("-1001:7")).toEqual(expect.arrayContaining([expect.objectContaining({ messageIds: [86], outcome: "processing_failed" }), expect.objectContaining({ messageIds: [86], outcome: "creation_unknown" })]));
    expect(h.createForumTopic).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.createForumTopic).toHaveBeenCalledOnce();
  });

  it("retains both sequential batch failures and does not retry either create", async () => {
    const h = harness();
    await h.deliver(80); await h.deliver(81);
    await vi.advanceTimersByTimeAsync(2_000);
    const run = h.callbacks.get("^inbox_batch:(\\d+):(one|each|cancel)$")!({
      match: ["", h.decision("batch"), "each"], chat: { id: -1001 }, callbackQuery: { message: { message_thread_id: 7 } }, answerCallbackQuery: vi.fn(), editMessageText: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(3_000); await run;
    expect(h.inbox.listFailures("-1001:7").map(f => f.messageIds)).toEqual([[81], [80]]);
    expect(h.createForumTopic).toHaveBeenCalledTimes(2);
  });
});


describe("Inbox failure persistence", () => {
  it("does not claim durable status when persisting the failure fails", async () => {
    const h = harness();
    rmSync(h.file);
    mkdirSync(h.file);
    await h.deliver(91);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendText.mock.calls.at(-1)![1]).toContain("Не удалось сохранить запись ошибки");
  });

  it("replaces the persisted file atomically with private permissions", () => {
    const h = harness();
    const before = statSync(h.file);
    h.inbox.recordFailure(makeInboxFailure("-1001:7", [90], { outcome: "creation_unknown" }, new Error("failed")));
    expect(statSync(h.file).ino).not.toBe(before.ino);
    expect(statSync(h.file).mode & 0o777).toBe(0o600);
    expect(new InboxStore(h.file).listFailures("-1001:7")).toHaveLength(1);
  });

  it("reports attachment forwarding failures against the known topic", async () => {
    const h = harness();
    h.createForumTopic.mockResolvedValue({ message_thread_id: 99 });
    await h.deliver(89, true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.inbox.listFailures("-1001:7")[0]).toMatchObject({ outcome: "topic_exists", workTopicId: 99 });
    expect(h.sendText.mock.calls.at(-1)![1]).toContain("вложения");
    expect(h.createForumTopic).toHaveBeenCalledOnce();
  });

  it("loads legacy files and allowlists bounded failure history without changing tickets", () => {
    const h = harness();
    const legacy = JSON.parse(readFileSync(h.file, "utf8"));
    delete legacy.failures;
    writeFileSync(h.file, JSON.stringify(legacy));
    const store = new InboxStore(h.file);
    expect(store.listFailures("-1001:7")).toEqual([]);
    for (let id = 1; id <= 101; id++) {
      store.recordFailure({ ...makeInboxFailure("-1001:7", [id], { outcome: "creation_unknown" }, new Error("SECRET_PAYLOAD")), rawError: "SECRET_PAYLOAD" } as never);
    }
    const reloaded = new InboxStore(h.file);
    expect(reloaded.listFailures("-1001:7")).toHaveLength(100);
    expect(reloaded.listFailures("-1001:7")[0].messageIds).toEqual([101]);
    expect(reloaded.listUnresolved()).toEqual([]);
    expect(readFileSync(h.file, "utf8")).not.toContain("SECRET_PAYLOAD");
  });
});
