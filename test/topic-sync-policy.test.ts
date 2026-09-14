import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TopicSyncPolicyStore, matchesTopicSyncPolicy, previewTopicSync } from "../src/topic-sync-policy.js";
import { TopicSynchronizer } from "../src/topic-sync.js";
const dirs: string[] = [];
const file = () => { const dir = mkdtempSync(path.join(tmpdir(), "sync-policy-")); dirs.push(dir); return path.join(dir, "policy.json"); };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
it("preserves installation default and persists explicit modes across restart", () => {
 const p = file(); const store = new TopicSyncPolicyStore(p, { mode: "onrequest", projects: [] });
 expect(store.get().mode).toBe("onrequest"); store.set({ mode: "selectedprojects", projects: ["/srv/foo/"] });
 expect(new TopicSyncPolicyStore(p, { mode: "all", projects: [] }).get()).toEqual({ mode: "selectedprojects", projects: ["/srv/foo"] });
 expect(() => store.set({ mode: "selectedprojects", projects: ["relative"] })).toThrow();
});
it("filters project descendants at directory boundaries, independent of title", () => {
 const p = { mode: "selectedprojects" as const, projects: ["/srv/foo"] };
 expect(matchesTopicSyncPolicy(p, "/srv/foo/sub")).toBe(true);
 expect(matchesTopicSyncPolicy(p, "/srv/foobar")).toBe(false);
 expect(matchesTopicSyncPolicy({ mode: "onrequest", projects: [] }, "/srv/foo")).toBe(false);
});
it("preview excludes preserved deleted bindings and does not mutate search source", () => {
 const threads = [{ id: "deleted", cwd: "/srv/foo" }, { id: "new", cwd: "/srv/foo" }];
 expect(previewTopicSync({ mode: "all", projects: [] }, threads, { isThreadBoundInChat: id => id === "deleted" }, 1)).toBe(1);
 expect(threads).toHaveLength(2);
});
it("honors runtime mode changes and yields on Telegram rate limits", async () => {
 let policy = { mode: "onrequest" as "onrequest" | "all", projects: [] };
 const create = vi.fn().mockRejectedValue({ error_code: 429, parameters: { retry_after: 60 } });
 const sync = new TopicSynchronizer({ chatId: 1, intervalMs: 1000, registry: { isThreadBoundInChat: () => false, bindThread: vi.fn() },
 listUserThreads: () => [{ id: "a", cwd: "/x", title: "one", firstUserMessage: "" }, { id: "b", cwd: "/x", title: "two", firstUserMessage: "" }] as any,
 createForumTopic: create, getPolicy: () => policy, logger: { info: vi.fn(), warn: vi.fn() } });
 await sync.syncOnce(); expect(create).not.toHaveBeenCalled(); policy = { mode: "all", projects: [] };
 await sync.syncOnce(); expect(create).toHaveBeenCalledTimes(1);
 await sync.syncOnce(); expect(create).toHaveBeenCalledTimes(1);
});
it("caps bursts and does not overlap direct sync calls", async () => {
 const bound = new Set<string>();
 let finish!: (value: {message_thread_id: number}) => void;
 const create = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({message_thread_id: 42});
 const sync = new TopicSynchronizer({chatId: 1, intervalMs: 1000, registry: {isThreadBoundInChat: id => bound.has(id), bindThread: (_, thread) => {bound.add(thread.id);}}, createForumTopic: create,
 listUserThreads: () => Array.from({length: 25}, (_, index) => ({id: String(index), cwd: "/x", title: "new", firstUserMessage: ""})) as any});
 const first = sync.syncOnce(); await sync.syncOnce(); expect(create).toHaveBeenCalledTimes(1);
 finish({message_thread_id: 41}); await first; expect(create).toHaveBeenCalledTimes(10);
 await sync.syncOnce(); expect(create).toHaveBeenCalledTimes(20);
});
it("rechecks policy between creations in the same burst", async () => {
 let policy = { mode: "all" as "all" | "onrequest", projects: [] };
 const create = vi.fn().mockImplementation(async () => {policy = {mode: "onrequest", projects: []}; return {message_thread_id: 42};});
 const sync = new TopicSynchronizer({chatId: 1, intervalMs: 1000, registry: {isThreadBoundInChat: () => false, bindThread: vi.fn()}, createForumTopic: create, getPolicy: () => policy,
 listUserThreads: () => [{id: "a", cwd: "/x", title: "a"}, {id: "b", cwd: "/x", title: "b"}] as any});
 await sync.syncOnce(); expect(create).toHaveBeenCalledTimes(1);
});
