import { describe, expect, it } from "vitest";

import {
  buildCodexThreadKeyboard,
  extractCodexThreadIds,
  finalChunkThreadKeyboard,
  parseCodexThreadCallback,
} from "../src/thread-links.js";

const FIRST = "019fef85-92e7-7841-a26a-dbb311b50e31";
const SECOND = "019fefa1-8411-76e2-89a8-f1262f63338f";

describe("Codex task links", () => {
  it("extracts canonical task links once in source order", () => {
    const markdown = [
      `[Open](codex://threads/${FIRST})`,
      `codex://threads/${FIRST}`,
      `[Next](codex://threads/${SECOND})`,
    ].join("\n");

    expect(extractCodexThreadIds(markdown)).toEqual([FIRST, SECOND]);
  });

  it("ignores bare, malformed, and non-canonical task ids", () => {
    const markdown = [
      FIRST,
      "codex://threads/not-a-uuid",
      `codex://threads/${FIRST.toUpperCase()}`,
      `codex://threads/${FIRST}suffix`,
    ].join("\n");

    expect(extractCodexThreadIds(markdown)).toEqual([]);
  });

  it("builds attach and native copy buttons", () => {
    const keyboard = buildCodexThreadKeyboard(
      `[Найти простой способ синхронизации](codex://threads/${FIRST})\n` +
        `[Проверь TTFB десктопа в Sentry](codex://threads/${SECOND})`,
    );

    expect(keyboard?.inline_keyboard).toEqual([
      [
        {
          text: "Open Найти простой способ синхронизации",
          callback_data: `codex_thread:${FIRST}`,
        },
        { text: "Copy ID", copy_text: { text: FIRST } },
      ],
      [
        {
          text: "Open Проверь TTFB десктопа в Sentry",
          callback_data: `codex_thread:${SECOND}`,
        },
        { text: "Copy ID", copy_text: { text: SECOND } },
      ],
    ]);
  });

  it("restores Markdown-escaped punctuation in the exact task title", () => {
    const keyboard = buildCodexThreadKeyboard(
      `[Разобрать \\[draft\\] \\\\ sync](codex://threads/${FIRST})`,
    );

    expect(keyboard?.inline_keyboard[0][0]).toEqual({
      text: "Open Разобрать [draft] \\ sync",
      callback_data: `codex_thread:${FIRST}`,
    });
  });

  it("uses the id prefix for generic links and upgrades duplicates to an exact title", () => {
    const generic = buildCodexThreadKeyboard(`[Open task](codex://threads/${FIRST})`);
    expect(generic?.inline_keyboard[0][0]).toEqual({
      text: "Open 019fef85",
      callback_data: `codex_thread:${FIRST}`,
    });

    const upgraded = buildCodexThreadKeyboard(
      `[Open](codex://threads/${FIRST})\n` +
        `[Точное имя](codex://threads/${FIRST})`,
    );
    expect(upgraded?.inline_keyboard[0][0]).toEqual({
      text: "Open Точное имя",
      callback_data: `codex_thread:${FIRST}`,
    });
  });

  it("truncates long titles by Unicode code points within Telegram's button limit", () => {
    const title = "😀".repeat(80);
    const keyboard = buildCodexThreadKeyboard(`[${title}](codex://threads/${FIRST})`);
    const text = keyboard?.inline_keyboard[0][0].text ?? "";

    expect([...text]).toHaveLength(64);
    expect(text).toBe(`Open ${"😀".repeat(58)}…`);
  });

  it("never cuts a multi-code-point grapheme when truncating", () => {
    const family = "👨‍👩‍👧‍👦";
    const keyboard = buildCodexThreadKeyboard(
      `[${family.repeat(20)}](codex://threads/${FIRST})`,
    );
    const text = keyboard?.inline_keyboard[0][0].text ?? "";

    expect([...text].length).toBeLessThanOrEqual(64);
    expect(text).toBe(`Open ${family.repeat(8)}…`);
  });

  it("returns no keyboard when the response has no canonical links", () => {
    expect(buildCodexThreadKeyboard(`Task: ${FIRST}`)).toBeUndefined();
  });

  it("attaches actions only to the final rendered chunk", () => {
    const markdown = `[Open](codex://threads/${FIRST})`;

    expect(finalChunkThreadKeyboard(markdown, 0, 2)).toBeUndefined();
    expect(finalChunkThreadKeyboard(markdown, 1, 2)?.inline_keyboard).toHaveLength(1);
    expect(finalChunkThreadKeyboard(markdown, 2, 2)).toBeUndefined();
    expect(finalChunkThreadKeyboard(markdown, 0, 0)).toBeUndefined();
  });

  it("parses only exact lowercase UUID callbacks", () => {
    expect(parseCodexThreadCallback(`codex_thread:${FIRST}`)).toBe(FIRST);
    expect(parseCodexThreadCallback(`codex_thread:${FIRST.slice(0, 8)}`)).toBeNull();
    expect(parseCodexThreadCallback(`codex_thread:${FIRST.toUpperCase()}`)).toBeNull();
    expect(parseCodexThreadCallback(`other:${FIRST}`)).toBeNull();
    expect(parseCodexThreadCallback(`codex_thread:${FIRST}:extra`)).toBeNull();
  });
});
