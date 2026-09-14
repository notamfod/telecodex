import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TopicTaskStore } from "../src/topic-task-store.js";
import { TopicTaskCardService, confirmedResultMessage } from "../src/topic-task-card.js";
let dir: string; let store: TopicTaskStore;
const identity = { chatId: -100123, messageThreadId: 5, title: "Задача", workspace: "/projects/test" };
const key = "-100123:5";
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "task-card-")); store = new TopicTaskStore(path.join(dir, "tasks.sqlite")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
function harness() {
 const transport = { send: vi.fn(async () => 42), edit: vi.fn(async () => {}), pin: vi.fn(async () => {}), probe: vi.fn(async () => "live" as const) };
 return { transport, service: new TopicTaskCardService(store, transport) };
}
it("sends once across concurrent activation, refresh and restart; edits only on change", async () => {
 const { service, transport } = harness();
 await Promise.all([service.activate(identity), service.activate(identity)]);
 await service.refresh(key);
 expect(transport.send).toHaveBeenCalledTimes(1); expect(transport.pin).toHaveBeenCalledTimes(1);
 expect(transport.edit).not.toHaveBeenCalled();
 store.close(); store = new TopicTaskStore(path.join(dir, "tasks.sqlite"));
 const resumed = new TopicTaskCardService(store, transport);
 await resumed.refresh(key); expect(transport.send).toHaveBeenCalledTimes(1);
 await resumed.update(key, { title: "Другая задача", titleSource: "manual" });
 expect(transport.edit).toHaveBeenCalledTimes(1); expect(store.get(key)?.cardMessageId).toBe(42);
});
it("persists the send intent before transport, blocks unknown outcomes and restart", async () => {
 const { service, transport } = harness();
 transport.send.mockImplementation(async () => { expect(store.get(key)?.cardState).toBe("sending"); throw new Error("timeout"); });
 await service.activate(identity);
 expect(store.get(key)?.cardState).toBe("unknown");
 await service.refresh(key, true); expect(transport.send).toHaveBeenCalledTimes(1);
 const current = store.get(key)!; store.update(key, current.version, { cardState: "sending" });
 await new TopicTaskCardService(store, transport).refresh(key, true);
 expect(transport.send).toHaveBeenCalledTimes(1);
});
it("keeps the card and explains denied pin permission without repeat pin calls", async () => {
 const { service, transport } = harness(); transport.pin.mockRejectedValue({ error_code: 403, description: "Forbidden" });
 await service.activate(identity); await service.refresh(key);
 expect(store.get(key)?.cardMessageId).toBe(42); expect(store.get(key)?.pinState).toBe("forbidden");
 expect(transport.pin).toHaveBeenCalledTimes(1);
 expect(transport.edit.mock.calls[0]?.[2]).toContain("закрепить вручную");
});
it.each(["closed", "missing", "unknown"])("does not replace missing card when topic is %s", async (presence) => {
 const { service, transport } = harness(); await service.activate(identity);
 transport.edit.mockRejectedValue({ error_code: 400, description: "Bad Request: message to edit not found" });
 if (presence === "unknown") transport.probe.mockRejectedValue(new Error("timeout"));
 else transport.probe.mockResolvedValue(presence as never);
 await service.update(key, { title: "Изменено" }); await service.refresh(key);
 expect(transport.send).toHaveBeenCalledTimes(1); expect(store.get(key)?.presence).toBe(presence);
});
it("replaces a proven missing card only in its existing live topic", async () => {
 const { service, transport } = harness(); await service.activate(identity);
 transport.edit.mockRejectedValueOnce({ error_code: 400, description: "Bad Request: message to edit not found" });
 await service.update(key, { title: "Изменено" });
 expect(transport.send).toHaveBeenCalledTimes(2);
 expect(transport.send.mock.calls[1]?.[0]).toMatchObject({ chatId: -100123, messageThreadId: 5 });
});
it("off keeps identity and prevents later writes", async () => {
 const { service, transport } = harness(); await service.activate(identity);
 await service.update(key, { enabled: false }); await service.refresh(key);
 expect(store.get(key)?.cardMessageId).toBe(42); expect(transport.edit).not.toHaveBeenCalled();
});

it("blocks a second send when Telegram succeeds but storing its message ID fails", async () => {
 const { service, transport } = harness();
 const update = store.update.bind(store);
 const failure = vi.spyOn(store, "update").mockImplementation((key, version, patch) => {
   if (patch.cardState === "ready") throw new Error("disk failure");
   return update(key, version, patch);
 });
 await expect(service.activate(identity)).rejects.toThrow("disk failure");
 expect(store.get(key)?.cardState).toBe("sending");
 failure.mockRestore();
 await new TopicTaskCardService(store, transport).refresh(key);
 expect(transport.send).toHaveBeenCalledTimes(1);
});
it("does not repeat a pin if its success could not be committed", async () => {
 const { service, transport } = harness();
 const update = store.update.bind(store);
 vi.spyOn(store, "update").mockImplementation((key, version, patch) => {
   if (patch.pinState === "pinned") throw new Error("disk failure");
   return update(key, version, patch);
 });
 await service.activate(identity);
 expect(store.get(key)?.pinState).toBe("unknown");
 await service.refresh(key);
 expect(transport.pin).toHaveBeenCalledTimes(1);
});
it("selects the actual final anchor rather than a delivered commentary summary", () => {
 const job = { id: "j", phase: "terminal", outcome: "completed", responsePlan: [{ partId: "summary:0000:0000", kind: "summary" }],
  turnResult: { content: [{ kind: "text", phase: "final_answer", text: "Результат" }] } };
 const deliveries = [
  { jobId: "j", partKey: "summary:0000:0000", state: "delivered", telegramMessageId: 5 },
  { jobId: "j", partKey: "status-anchor", state: "delivered", telegramMessageId: 6, payload: { operation: "edit_text" } },
 ];
 expect(confirmedResultMessage(job as never, { isDone: true } as never, deliveries as never)).toBe(6);
 expect(confirmedResultMessage(job as never, { isDone: false } as never, deliveries as never)).toBeNull();
 expect(confirmedResultMessage({ ...job, turnResult: { content: [] } } as never, { isDone: true } as never, deliveries as never)).toBeNull();
});
it("uses accepted event order for same-millisecond jobs and rejects older late updates", async () => {
 const { service } = harness(); await service.activate(identity);
 const job = (id: string, version: number) => ({ id, version, acceptedAt: 100, updatedAt: 200 + version, threadId: "thread", phase: "running" });
 const projection = (id: string, version: number) => ({ jobId: id, expectedVersion: version, state: "running", guardian: {}, timestamps: { lastEventAt: 200 } });
 await service.observe(job("old", 1) as never, projection("old", 1) as never, [], identity, undefined, 1);
 await service.observe(job("new", 1) as never, projection("new", 1) as never, [], identity, undefined, 2);
 await service.observe(job("old", 3) as never, projection("old", 3) as never, [], identity, undefined, 1);
 expect(store.get(key)?.latestJobId).toBe("new");
 expect(store.get(key)?.latestJobOrder).toBe(2);
 expect(store.get(key)?.cardMessageId).toBe(42);
});

it("allows only explicit reactivation after a proven rejected send", async () => {
 const { service, transport } = harness(); transport.send.mockRejectedValueOnce({ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } });
 await service.activate(identity); await service.refresh(key);
 expect(transport.send).toHaveBeenCalledTimes(1); expect(store.get(key)?.enabled).toBe(false);
 await service.activate(identity);
 expect(transport.send).toHaveBeenCalledTimes(2); expect(store.get(key)?.cardMessageId).toBe(42);
});
it("rechecks persisted closed presence on explicit activation after a missed reopen event", async () => {
 const { service, transport } = harness(); await service.activate(identity);
 await service.update(key, { presence: "closed", title: "Новое имя" });
 expect(transport.edit).toHaveBeenCalledTimes(1);
 expect(transport.edit.mock.calls[0]?.[2]).toContain("Топик закрыт");
 await service.activate(identity);
 expect(store.get(key)?.presence).toBe("open"); expect(transport.send).toHaveBeenCalledTimes(1);
 expect(transport.edit).toHaveBeenCalledTimes(2);
});

it("commits an already-applied edit after its first acknowledgement was lost", async () => {
 const { service, transport } = harness(); await service.activate(identity);
 transport.edit.mockRejectedValueOnce(new Error("timeout"))
   .mockRejectedValueOnce({ error_code: 400, description: "Bad Request: message is not modified" });
 await service.update(key, { title: "Изменено" });
 await service.refresh(key); await service.refresh(key);
 expect(transport.edit).toHaveBeenCalledTimes(2);
 expect(store.get(key)?.cardMessageId).toBe(42);
 expect(transport.send).toHaveBeenCalledTimes(1);
});

it("sends the requested card on unknown availability and records the actual success", async () => {
 const { service, transport } = harness(); transport.probe.mockResolvedValue("unknown" as never);
 await service.activate(identity);
 expect(transport.send).toHaveBeenCalledOnce();
 expect(store.get(key)).toMatchObject({ presence: "open", cardState: "ready", cardMessageId: 42 });
});
it("keeps definitive missing presence when later typing is inconclusive", async () => {
 const { service, transport } = harness(); transport.probe.mockResolvedValue("unknown" as never);
 transport.send.mockRejectedValue({ error_code: 400, description: "Bad Request: message thread not found" });
 await service.activate(identity);
 expect(store.get(key)).toMatchObject({ presence: "missing", cardState: "none" });
 await service.activate(identity);
 expect(transport.send).toHaveBeenCalledOnce();
 expect(store.get(key)?.presence).toBe("missing");
});
it("keeps an unknown send fenced even when the availability probe succeeds", async () => {
 const { service, transport } = harness(); transport.probe.mockResolvedValue("unknown" as never);
 transport.send.mockRejectedValue(new Error("network failed"));
 await service.activate(identity); await service.activate(identity);
 expect(transport.send).toHaveBeenCalledOnce();
 expect(store.get(key)).toMatchObject({ presence: "unknown", cardState: "unknown" });
});
it.each(["send_text", "send_rich"])("links a confirmed replacement final anchor using %s", operation => {
 const job = { id: "j", phase: "terminal", outcome: "completed", responsePlan: [],
   turnResult: { content: [{ kind: "text", phase: "final_answer", text: "Результат" }] } };
 const delivery = { jobId: "j", partKey: "status-anchor", state: "delivered", telegramMessageId: 6, payload: { operation } };
 expect(confirmedResultMessage(job as never, { isDone: true } as never, [delivery] as never)).toBe(6);
});
it.each([false, true])("replaces a definitively missing card despite unknown topic availability with send fence (ambiguous=%s)", async ambiguous => {
 const { service, transport } = harness(); await service.activate(identity);
 transport.probe.mockResolvedValue("unknown" as never);
 transport.edit.mockRejectedValueOnce({ error_code: 400, description: "Bad Request: message to edit not found" });
 transport.send.mockImplementation(async () => {
   expect(store.get(key)?.cardState).toBe("sending");
   if (ambiguous) throw new Error("lost send response");
   return 43;
 });
 await service.update(key, { title: "Изменено" });
 await service.refresh(key, true);
 expect(transport.send).toHaveBeenCalledTimes(2);
 expect(store.get(key)).toMatchObject(ambiguous
   ? { cardState: "unknown", presence: "unknown", cardMessageId: null }
   : { cardState: "ready", presence: "open", cardMessageId: 43 });
});
it("does not dispatch a card send after a rate-limited availability probe", async () => {
 const { service, transport } = harness();
 transport.probe.mockRejectedValue({ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } });
 await service.activate(identity);
 expect(transport.send).not.toHaveBeenCalled();
 expect(store.get(key)?.cardState).toBe("none");
});
