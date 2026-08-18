import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  TopicActivityIndicator,
  isTopicActivityEligible,
  topicIconChangeFromMessage,
} from "../src/topic-activity.js";

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-activity-"));
  const editTopicIcon = vi.fn(async () => undefined);
  const indicator = new TopicActivityIndicator({
    filePath: path.join(directory, "topic-icons.json"),
    listIconStickers: async () => [
      { emoji: "🤖", customEmojiId: "working-robot" },
      { emoji: "✅", customEmojiId: "done-check" },
    ],
    editTopicIcon,
    logger: { warn: vi.fn() },
  });
  return { directory, editTopicIcon, indicator };
}

describe("TopicActivityIndicator", () => {
  it("uses the robot while an agent runs and restores the standard icon", async () => {
    const fixture = createFixture();
    try {
      await fixture.indicator.start(-100123, 42);
      await fixture.indicator.finish(-100123, 42);

      expect(fixture.editTopicIcon.mock.calls).toEqual([
        [-100123, 42, "working-robot"],
        [-100123, 42, ""],
      ]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("restores the custom icon remembered for the topic", async () => {
    const fixture = createFixture();
    try {
      fixture.indicator.rememberIdleIcon(-100123, 42, "original-icon");

      await fixture.indicator.start(-100123, 42);
      fixture.indicator.rememberIdleIcon(-100123, 42, "working-robot");
      await fixture.indicator.finish(-100123, 42);

      expect(fixture.editTopicIcon.mock.calls).toEqual([
        [-100123, 42, "working-robot"],
        [-100123, 42, "original-icon"],
      ]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps the original icon across a restart during an active turn", async () => {
    const fixture = createFixture();
    try {
      fixture.indicator.rememberIdleIcon(-100123, 42, "original-icon");
      await fixture.indicator.start(-100123, 42);

      const recoveredEdit = vi.fn(async () => undefined);
      const recovered = new TopicActivityIndicator({
        filePath: path.join(fixture.directory, "topic-icons.json"),
        listIconStickers: async () => [{ emoji: "🤖", customEmojiId: "working-robot" }],
        editTopicIcon: recoveredEdit,
        logger: { warn: vi.fn() },
      });

      await recovered.restoreStaleTopics();

      expect(recoveredEdit).toHaveBeenCalledWith(-100123, 42, "original-icon");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("serializes an immediate finish after a slow start", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-activity-"));
    const calls: string[] = [];
    let releaseStart: (() => void) | undefined;
    const indicator = new TopicActivityIndicator({
      filePath: path.join(directory, "topic-icons.json"),
      listIconStickers: async () => [{ emoji: "🤖", customEmojiId: "working-robot" }],
      editTopicIcon: async (_chatId, _threadId, iconId) => {
        calls.push(iconId);
        if (iconId === "working-robot") {
          await new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
        }
      },
      logger: { warn: vi.fn() },
    });

    try {
      const starting = indicator.start(-100123, 42);
      const finishing = indicator.finish(-100123, 42);
      await vi.waitFor(() => expect(releaseStart).toBeTypeOf("function"));
      releaseStart!();
      await Promise.all([starting, finishing]);

      expect(calls).toEqual(["working-robot", ""]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an icon change received while the working icon is loading", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-activity-"));
    const editTopicIcon = vi.fn(async () => undefined);
    let releaseStickers: (() => void) | undefined;
    const indicator = new TopicActivityIndicator({
      filePath: path.join(directory, "topic-icons.json"),
      listIconStickers: async () => {
        await new Promise<void>((resolve) => {
          releaseStickers = resolve;
        });
        return [{ emoji: "🤖", customEmojiId: "working-robot" }];
      },
      editTopicIcon,
      logger: { warn: vi.fn() },
    });

    try {
      const starting = indicator.start(-100123, 42);
      await vi.waitFor(() => expect(releaseStickers).toBeTypeOf("function"));
      indicator.rememberIdleIcon(-100123, 42, "latest-idle-icon");
      releaseStickers!();
      await starting;
      await indicator.finish(-100123, 42);

      expect(editTopicIcon.mock.calls).toEqual([
        [-100123, 42, "working-robot"],
        [-100123, 42, "latest-idle-icon"],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries loading the working icon after a transient Telegram error", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-activity-"));
    const editTopicIcon = vi.fn(async () => undefined);
    const listIconStickers = vi
      .fn<() => Promise<Array<{ emoji: string; customEmojiId: string }>>>()
      .mockRejectedValueOnce(new Error("temporary Telegram error"))
      .mockResolvedValue([{ emoji: "🤖", customEmojiId: "working-robot" }]);
    const indicator = new TopicActivityIndicator({
      filePath: path.join(directory, "topic-icons.json"),
      listIconStickers,
      editTopicIcon,
      logger: { warn: vi.fn() },
    });

    try {
      await indicator.start(-100123, 42);
      await indicator.start(-100123, 42);
      await indicator.finish(-100123, 42);

      expect(listIconStickers).toHaveBeenCalledTimes(2);
      expect(editTopicIcon.mock.calls).toEqual([
        [-100123, 42, "working-robot"],
        [-100123, 42, ""],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not change Telegram when the original icon state cannot be persisted", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-activity-"));
    const blockedDirectory = path.join(directory, "not-a-directory");
    writeFileSync(blockedDirectory, "blocked", "utf8");
    const editTopicIcon = vi.fn(async () => undefined);
    const warn = vi.fn();
    const indicator = new TopicActivityIndicator({
      filePath: path.join(blockedDirectory, "topic-icons.json"),
      listIconStickers: async () => [{ emoji: "🤖", customEmojiId: "working-robot" }],
      editTopicIcon,
      logger: { warn },
    });

    try {
      await indicator.start(-100123, 42);

      expect(editTopicIcon).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not persist a working marker when Telegram rejects the working icon", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-activity-"));
    const editTopicIcon = vi
      .fn<(chatId: number, messageThreadId: number, iconId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("topic edit rejected"))
      .mockResolvedValue(undefined);
    const indicator = new TopicActivityIndicator({
      filePath: path.join(directory, "topic-icons.json"),
      listIconStickers: async () => [{ emoji: "🤖", customEmojiId: "working-robot" }],
      editTopicIcon,
      logger: { warn: vi.fn() },
    });

    try {
      await indicator.start(-100123, 42);
      await indicator.restoreStaleTopics();

      expect(editTopicIcon).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears a stale marker when Telegram says the idle icon is already current", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-topic-activity-"));
    const editTopicIcon = vi
      .fn<(chatId: number, messageThreadId: number, iconId: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Bad Request: TOPIC_NOT_MODIFIED"))
      .mockResolvedValue(undefined);
    const indicator = new TopicActivityIndicator({
      filePath: path.join(directory, "topic-icons.json"),
      listIconStickers: async () => [{ emoji: "🤖", customEmojiId: "working-robot" }],
      editTopicIcon,
      logger: { warn: vi.fn() },
    });

    try {
      indicator.rememberIdleIcon(-100123, 42, "original-icon");
      await indicator.start(-100123, 42);
      await indicator.finish(-100123, 42);

      indicator.rememberIdleIcon(-100123, 42, "new-idle-icon");
      await indicator.start(-100123, 42);
      await indicator.finish(-100123, 42);

      expect(editTopicIcon.mock.calls.at(-1)).toEqual([-100123, 42, "new-idle-icon"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not clear a stale marker for an active job awaiting recovery", async () => {
    const fixture = createFixture();
    try {
      fixture.indicator.rememberIdleIcon(-100123, 42, "active-original");
      fixture.indicator.rememberIdleIcon(-100123, 43, "stale-original");
      await fixture.indicator.start(-100123, 42);
      await fixture.indicator.start(-100123, 43);

      const recoveredEdit = vi.fn(async () => undefined);
      const recovered = new TopicActivityIndicator({
        filePath: path.join(fixture.directory, "topic-icons.json"),
        listIconStickers: async () => [{ emoji: "🤖", customEmojiId: "working-robot" }],
        editTopicIcon: recoveredEdit,
        logger: { warn: vi.fn() },
      });

      await recovered.restoreStaleTopics({
        exclude: [{ chatId: -100123, messageThreadId: 42 }],
      });

      expect(recoveredEdit).toHaveBeenCalledTimes(1);
      expect(recoveredEdit).toHaveBeenCalledWith(-100123, 43, "stale-original");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});

describe("isTopicActivityEligible", () => {
  it("accepts real topics but excludes non-topic chats and General", () => {
    expect(isTopicActivityEligible(undefined)).toBe(false);
    expect(isTopicActivityEligible(1)).toBe(false);
    expect(isTopicActivityEligible(42)).toBe(true);
  });
});

describe("topicIconChangeFromMessage", () => {
  it("reads created, changed and removed topic icons", () => {
    expect(topicIconChangeFromMessage({
      forum_topic_created: { name: "Task", icon_color: 123, icon_custom_emoji_id: "created" },
    })).toEqual({ iconCustomEmojiId: "created" });
    expect(topicIconChangeFromMessage({
      forum_topic_edited: { icon_custom_emoji_id: "changed" },
    })).toEqual({ iconCustomEmojiId: "changed" });
    expect(topicIconChangeFromMessage({
      forum_topic_edited: { icon_custom_emoji_id: "" },
    })).toEqual({ iconCustomEmojiId: null });
  });

  it("ignores lifecycle messages that do not change an icon", () => {
    expect(topicIconChangeFromMessage({ forum_topic_edited: { name: "Renamed" } })).toBeUndefined();
    expect(topicIconChangeFromMessage({ forum_topic_closed: {} })).toBeUndefined();
  });
});
