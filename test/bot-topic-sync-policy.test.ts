import { afterEach, expect, it, vi } from "vitest";
import { registerTopicSyncPolicyCommands } from "../src/bot-topic-sync-policy.js";
function setup() {
  let command: any; let callback: any;
  let policy = { mode: "onrequest", projects: [] };
  const store = { get: () => structuredClone(policy), set: vi.fn(next => { policy = next; }) };
  registerTopicSyncPolicyCommands({ command: (_: any, fn: any) => { command = fn; }, callbackQuery: (_: any, fn: any) => { callback = fn; } } as any,
    { store: store as any, chatId: 1, registry: { isThreadBoundInChat: () => false }, listUserThreads: () => [{id: "new", cwd: "/srv/a"}], isAllowed: ctx => ctx.from?.id === 7 });
  const ctx = { from: { id: 7 }, chat: { id: 1 }, match: "all", reply: vi.fn(), answerCallbackQuery: vi.fn(), editMessageText: vi.fn() };
  const apply = () => { const data = ctx.reply.mock.calls.at(-1)![1].reply_markup.inline_keyboard[0][0].callback_data; return {...ctx, match: [data, data.split(":")[1]]}; };
  return { store, ctx, command, callback, apply };
}
afterEach(() => vi.useRealTimers());
it("previews candidate count before explicit apply, then ignores duplicate callbacks", async () => {
 const {store,ctx,command,callback,apply} = setup();
 await command(ctx); expect(store.set).not.toHaveBeenCalled(); expect(ctx.reply.mock.calls[0][0]).toContain("сейчас: 1");
 const click = apply(); await callback(click); expect(store.set).toHaveBeenCalledTimes(1);
 await callback(click); expect(store.set).toHaveBeenCalledTimes(1);
});
it("rejects other users, other chats, expired previews and stale policies", async () => {
 vi.useFakeTimers();
 const {store,ctx,command,callback,apply} = setup();
 await command({...ctx, chat: {id: 2}}); expect(ctx.reply).not.toHaveBeenCalled();
 await command(ctx); const click = apply();
 await callback({...click, from: {id: 8}}); expect(store.set).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(300_001); await callback(click); expect(store.set).not.toHaveBeenCalled();
 await command(ctx); const fresh = apply(); store.set({mode: "selectedprojects", projects: ["/srv/a"]});
 await callback(fresh); expect(store.set).toHaveBeenCalledTimes(1);
});
it("rejects relative project roots and accepts selected-project preview", async () => {
 const {store,ctx,command} = setup(); await command({...ctx, match: "selectedprojects relative"});
 expect(ctx.reply.mock.calls[0][0]).toContain("абсолютные пути"); expect(store.set).not.toHaveBeenCalled();
 await command({...ctx, match: "selectedprojects /srv/a; /srv/b"}); expect(ctx.reply.mock.calls[1][0]).toContain("сейчас: 1");
});
