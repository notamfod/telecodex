import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LegacyTelegramJobStoreProbe,
  TelegramJobStore,
} from "../src/telegram-job-store.js";

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

  it("probes legacy JSON readability and writability without changing its contents", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-probe-"));
    const file = path.join(dir, "jobs.json");
    const source = JSON.stringify([{ id: "existing" }]);
    try {
      writeFileSync(file, source);
      const probe = new LegacyTelegramJobStoreProbe(file);

      await expect(probe.probeReadable()).resolves.toBeUndefined();
      expect(() => probe.probeWritable()).not.toThrow();
      expect(readFileSync(file, "utf8")).toBe(source);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unreadable legacy JSON shape", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-probe-"));
    const file = path.join(dir, "jobs.json");
    try {
      writeFileSync(file, "{\"not\":\"jobs\"}");

      await expect(new LegacyTelegramJobStoreProbe(file).probeReadable()).rejects.toThrow(
        "Legacy Telegram job store is invalid",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds a legacy JSON readability probe", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-probe-"));
    const file = path.join(dir, "jobs.json");
    try {
      writeFileSync(file, "[]");
      await expect(new LegacyTelegramJobStoreProbe(file).probeReadable(1)).rejects.toThrow(
        "Legacy Telegram job store is unavailable",
      );
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

  it("persists a model-selection wait and releases it exactly once", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-"));
    const file = path.join(dir, "jobs.json");
    try {
      const store = new TelegramJobStore(file, () => 1000);
      const waiting = store.create({
        contextKey: "-100:42",
        chatId: -100,
        messageThreadId: 42,
        threadId: null,
        input: "inspect this",
      });

      const awaiting = store.awaitModelSelection(waiting.id);

      expect(awaiting.state).toBe("awaiting-model");
      expect(awaiting.selectionToken).toMatch(/^[a-f0-9]{12}$/);
      expect(store.listRecoverable()).toEqual([]);
      expect(store.listAwaitingModel()).toHaveLength(1);
      expect(store.findAwaitingModel(awaiting.selectionToken!, "-100:42")?.id).toBe(waiting.id);
      expect(store.findAwaitingModel(awaiting.selectionToken!, "-100:99")).toBeUndefined();

      expect(() =>
        store.selectModel(awaiting.selectionToken!, "-100:99", "glm-53", "thread-glm"),
      ).toThrow("Invalid or expired model selection");

      const released = store.selectModel(
        awaiting.selectionToken!,
        "-100:42",
        "glm-53",
        "thread-glm",
      );
      expect(released).toEqual(
        expect.objectContaining({
          state: "waiting",
          modelChoiceId: "glm-53",
          threadId: "thread-glm",
        }),
      );
      expect(released.selectionToken).toBeUndefined();
      expect(() =>
        store.selectModel(awaiting.selectionToken!, "-100:42", "glm-53", "thread-glm"),
      ).toThrow("Invalid or expired model selection");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves a legacy model-selection wait back to the default queue", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-"));
    const file = path.join(dir, "jobs.json");
    try {
      const store = new TelegramJobStore(file, () => 1000);
      const waiting = store.create({
        contextKey: "-100:42",
        chatId: -100,
        messageThreadId: 42,
        threadId: null,
        input: "inspect this",
      });
      const awaiting = store.awaitModelSelection(waiting.id);

      const released = store.useDefaultModel(awaiting.id);

      expect(released.state).toBe("waiting");
      expect(released).not.toHaveProperty("modelChoiceId");
      expect(released).not.toHaveProperty("selectionToken");
      expect(store.listAwaitingModel()).toEqual([]);
      expect(store.listRecoverable()).toEqual([expect.objectContaining({ id: waiting.id })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips inbox cleanup metadata", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telecodex-job-store-"));
    const file = path.join(dir, "jobs.json");
    try {
      const store = new TelegramJobStore(file, () => 1000);
      const job = store.create({
        contextKey: "-100:1",
        chatId: -100,
        messageThreadId: 1,
        threadId: null,
        input: { imagePaths: ["/workspace/.telecodex/inbox/turn/photo.jpg"] },
        cleanupInbox: { workspace: "/workspace", turnId: "turn" },
      });

      const restored = new TelegramJobStore(file, () => 2000);
      expect(restored.get(job.id)?.cleanupInbox).toEqual({
        workspace: "/workspace",
        turnId: "turn",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
