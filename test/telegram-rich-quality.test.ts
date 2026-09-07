import {
  TELEGRAM_RICH_CHARACTER_LIMIT,
  TELEGRAM_RICH_NESTING_LIMIT,
  formatTelegramRichResult,
} from "../src/telegram-rich-message.js";
import type {
  TelegramTurnResult,
  TelegramTurnResultContent,
} from "../src/telegram-turn-result.js";

const text = (value: string): TelegramTurnResultContent => ({ kind: "text", text: value });
const result = (...content: TelegramTurnResultContent[]): TelegramTurnResult => ({
  schemaVersion: 1,
  content,
});
const nestedInline = (inner: string, depth: number): string => {
  let value = inner;
  for (let index = 0; index < depth; index += 1) {
    const marker = index % 2 === 0 ? "*" : "**";
    value = `${marker}level${index} ${value} end${index}${marker}`;
  }
  return value;
};

describe("Telegram Rich Markdown quality regressions", () => {
  it("does not let quoted URL text close nested HTML for metrics", () => {
    const source = [
      ...Array.from({ length: 17 }, (_, index) =>
        `<details><summary>level ${index}</summary><a href="https://example.com/${index}></details>">link</a>`),
      ...Array.from({ length: 17 }, () => "</details>"),
    ].join("\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("keeps cross-block references and footnotes indivisible when they cannot fit", () => {
    const cases = [
      ["![asset][image]", "[image]: https://example.com/asset.png"],
      ["Read [docs][reference]", "[reference]: https://example.com/docs"],
      ["Read the note [^note]", "[^note]: footnote text"],
    ] as const;

    for (const [usage, definition] of cases) {
      const first = `${usage} ${"x".repeat(TELEGRAM_RICH_CHARACTER_LIMIT - 40)}`;
      const source = `${first}\n\n${definition}`;
      expect(formatTelegramRichResult(result(text(source)))).toEqual([
        { kind: "legacy", source },
      ]);
    }
  });

  it("handles escaped delimiter input within a generous CI bound", () => {
    const source = "\\*".repeat(80_000);
    const started = performance.now();

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("handles unmatched brackets within a generous CI bound", () => {
    for (const length of [20_000, 40_000]) {
      const source = "[".repeat(length);
      const started = performance.now();
      const [part] = formatTelegramRichResult(result(text(source)));

      expect(part?.kind).toBe(length <= TELEGRAM_RICH_CHARACTER_LIMIT ? "rich" : "legacy");
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  }, 30_000);

  it("keeps UTF-16 HTML offsets aligned after astral characters", () => {
    const source = `${"😀".repeat(20)}<b>${nestedInline(
      "x",
      TELEGRAM_RICH_NESTING_LIMIT + 1,
    )}</b>`;

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("counts Markdown nesting after an incomplete HTML opener", () => {
    const source = `<${nestedInline("x", TELEGRAM_RICH_NESTING_LIMIT + 1)}`;

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("keeps dependencies across adjacent text items indivisible", () => {
    const cases = [
      ["![asset][image]", "[image]: https://example.com/asset.png"],
      ["Read [docs][reference]", "[reference]: https://example.com/docs"],
      ["Read the note [^note]", "[^note]: footnote text"],
    ] as const;

    for (const [usage, definition] of cases) {
      const first = `${usage} ${"x".repeat(TELEGRAM_RICH_CHARACTER_LIMIT - 40)}`;
      const source = `${first}\n\n${definition}`;
      expect(formatTelegramRichResult(result(text(first), text(definition)))).toEqual([
        { kind: "legacy", source },
      ]);
    }
  });

  it("bounds large adjacent text runs without losing item order", () => {
    const items = Array.from({ length: 60 }, (_, index) => {
      const prefix = `part-${String(index).padStart(2, "0")}: `;
      return `${prefix}${"x".repeat(20_000 - prefix.length)}`;
    });
    const independent = formatTelegramRichResult(result(...items.map(text)));

    expect(independent.map((part) => part.kind)).toEqual(Array(60).fill("rich"));
    expect(independent.map((part) => part.kind === "rich" ? part.source : "")).toEqual(items);

    const dependent = [...items];
    dependent[0] = `![asset][image] ${dependent[0]}`;
    dependent[dependent.length - 1] =
      `${dependent.at(-1)}\n[image]: https://example.com/asset.png`;
    const fallback = formatTelegramRichResult(result(...dependent.map(text)));

    expect(fallback.map((part) => part.kind)).toEqual(Array(60).fill("legacy"));
    expect(fallback.map((part) => part.kind === "legacy" ? part.source : "")).toEqual(dependent);
  }, 30_000);

  it("caps metrics for deeply nested input", () => {
    const source = [
      ...Array.from({ length: 1_000 }, () => "<details><summary>level</summary>"),
      "deep",
      ...Array.from({ length: 1_000 }, () => "</details>"),
    ].join("\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  }, 10_000);
});
