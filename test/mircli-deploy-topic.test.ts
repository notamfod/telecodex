import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MircliDeployTopic } from "../src/mircli-deploy-topic.js";
let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function setup(legacy = false) {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-topic-"));
  const call = vi.fn(async (method: string, _body: Record<string, unknown>) => method === "sendMessage" ? { message_id: 41 } : true);
  const options = { statePath: path.join(directory, "state.json"), target: { chatId: -1001, messageThreadId: 7 }, call };
  if (legacy) await writeFile(options.statePath, JSON.stringify({ version: 1, target: options.target, rows: [], slots: [
    { ref: "main", page: 0, messageId: 41, text: "old dev", pinned: true },
    { ref: "main", page: 1, messageId: 42, text: "old continuation", pinned: true },
    { ref: "production", page: 0, messageId: 43, text: "old prod", pinned: true },
  ] }));
  return { call, options, topic: await MircliDeployTopic.open(options) };
}
it("persists one message and selection, silently pins once and edits after restart", async () => {
  const { topic, options, call } = await setup();
  await topic.publish("main", ["dev one"]);
  expect(call.mock.calls.map(([method]) => method)).toEqual(["sendMessage", "pinChatMessage"]);
  expect(call.mock.calls[0][1]).toMatchObject({ message_thread_id: 7, disable_notification: true, reply_markup: expect.anything() });
  await topic.selectView({ ...options.target, messageId: 41, ref: "production" }, "prod one");
  expect(call.mock.calls.at(-1)).toEqual(["editMessageText", expect.objectContaining({ message_id: 41, text: "prod one", reply_markup: expect.anything() })]);
  await topic.close();
  const restarted = await MircliDeployTopic.open(options);
  expect(restarted.view()).toBe("production");
  await restarted.publish("production", ["prod two"]);
  expect(call.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
  expect(call.mock.calls.filter(([method]) => method === "pinChatMessage")).toHaveLength(1);
  await restarted.close();
});
it("migrates previous pinned cards, keeps first message and retires only owned extra summaries", async () => {
  const { topic, call, options } = await setup(true);
  await topic.publish("main", ["compact dev"]);
  expect(call.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(0);
  expect(call.mock.calls.filter(([method]) => method === "deleteMessage").map(([, body]) => body.message_id)).toEqual([42, 43]);
  expect(JSON.parse(await readFile(options.statePath, "utf8"))).toMatchObject({ version: 2, messageId: 41, retiredMessageIds: [] });
  await topic.close();
});
it("rejects forged topic/message context and ignores stale poll writes after switching", async () => {
  const { topic, call, options } = await setup();
  await topic.publish("main", ["dev"]);
  for (const forged of [{ chatId: -1002 }, { messageThreadId: 8 }, { messageId: 42 }]) {
    await expect(topic.selectView({ ...options.target, messageId: 41, ref: "production", ...forged }, "prod")).rejects.toThrow("context");
  }
  await topic.selectView({ ...options.target, messageId: 41, ref: "production" }, "prod");
  const count = call.mock.calls.length;
  await topic.publish("main", ["stale dev poll"]);
  expect(call).toHaveBeenCalledTimes(count);
  await topic.close();
});
it("recovers a failed pin without resending and rejects another writer or target", async () => {
  const { topic, call, options } = await setup();
  await expect(MircliDeployTopic.open(options)).rejects.toThrow("busy");
  call.mockImplementationOnce(async () => ({ message_id: 41 })).mockRejectedValueOnce(new Error("pin denied"));
  await expect(topic.publish("main", ["dev"])).rejects.toThrow("pin denied");
  await topic.publish("main", ["dev"]);
  expect(call.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
  await topic.close();
  await expect(MircliDeployTopic.open({ ...options, target: { chatId: -1002, messageThreadId: 7 } })).rejects.toThrow("target");
});
