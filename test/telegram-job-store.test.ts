import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TelegramJobStore } from "../src/telegram-job-store.js";

describe("TelegramJobStore", () => {
  it("persists recoverable jobs atomically and preserves FIFO order", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-"));
    const file = path.join(dir, ".telecodex", "jobs.json");
    try {
      const store = new TelegramJobStore(file, () => 1000);
      const first = store.create({
        contextKey: "-100:1",
        chatId: -100,
        messageThreadId: 1,
        threadId: "thread-1",
        input: "first",
      });
      const second = store.create({
        contextKey: "-100:2",
        chatId: -100,
        messageThreadId: 2,
        threadId: "thread-2",
        input: { text: "second", imagePaths: [] },
      });
      store.update(first.id, { state: "active", turnId: "turn-1" });

      const restored = new TelegramJobStore(file, () => 2000);

      expect(restored.listRecoverable().map((job) => job.id)).toEqual([first.id, second.id]);
      expect(restored.get(first.id)).toEqual(expect.objectContaining({
        state: "active",
        turnId: "turn-1",
        updatedAt: 1000,
      }));
      expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates delivered parts and excludes completed jobs from recovery", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-"));
    const file = path.join(dir, "jobs.json");
    try {
      const store = new TelegramJobStore(file, () => 1000);
      const job = store.create({
        contextKey: "-100:1",
        chatId: -100,
        messageThreadId: 1,
        threadId: "thread-1",
        input: "hello",
      });

      expect(store.markPartSent(job.id, "final:0")).toBe(true);
      expect(store.markPartSent(job.id, "final:0")).toBe(false);
      expect(store.hasPart(job.id, "final:0")).toBe(true);
      store.update(job.id, { state: "completed" });

      expect(store.listRecoverable()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
