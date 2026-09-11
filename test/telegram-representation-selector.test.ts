import {
  selectTelegramTextRepresentation,
  selectTelegramTurnRepresentation,
} from "../src/telegram-representation-selector.js";
import type { TelegramTurnResult } from "../src/telegram-turn-result.js";

const textResult = (text: string): TelegramTurnResult => ({
  schemaVersion: 1,
  content: [{ kind: "text", text }],
});

describe("Telegram representation selector", () => {
  it.each([
    ["paragraph", "Обычный абзац."],
    ["heading", "## Раздел\n\nТекст"],
    ["emphasis and link", "**важно** и [ссылка](https://example.com)"],
    ["link with query dollars", "[API](https://example.com/?$select=id&$filter=active)"],
    ["bare URL with query dollars", "API: https://example.com/?$select=id&$filter=active"],
    ["autolink with query dollars", "<https://example.com/?$select=id&$filter=active>"],
    ["list", "- первый\n- второй\n  - вложенный"],
    ["quote", "> цитата"],
    ["inline code", "Запусти `npm test`."],
    ["fenced code", "```ts\nconst answer = 42;\n```"],
  ])("selects compact HTML for %s", (_name, source) => {
    expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
      .toBe("compact_html");
    expect(selectTelegramTurnRepresentation(textResult(source))).toBe("compact_html");
  });

  it.each([
    ["Markdown table", "| A | B |\n|---|---|\n| 1 | 2 |"],
    ["HTML table", "<table><tr><td>1</td></tr></table>"],
    ["inline formula", "Площадь: $a^2$."],
    ["block formula", "$$\nE = mc^2\n$$"],
    ["details", "<details><summary>Ещё</summary>Текст</details>"],
    ["footnote", "Ответ[^n].\n\n[^n]: пояснение"],
    ["reference definition", "[документация][docs]\n\n[docs]: https://example.com/docs"],
    ["inline image", "![chart](https://example.com/chart.png)"],
    ["reference image", "![chart][img]\n\n[img]: https://example.com/chart.png"],
  ])("selects native rich for %s", (_name, source) => {
    expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
      .toBe("native_rich");
  });

  it.each([
    ["inline literals", "`| A | B |`, `$x$`, `<details>` and `![x](url)`"],
    ["fenced literals", "```text\n| A | B |\n$x$\n<details>\n![x](url)\n```"],
    ["escaped formula", "Цена: \\$5, не формула."],
    ["escaped image", "\\![chart](https://example.com/chart.png)"],
    ["escaped HTML", "\\<details>literal\\</details> and \\<table>literal\\</table>"],
  ])("does not promote %s", (_name, source) => {
    expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
      .toBe("compact_html");
  });

  it("uses rich for a positioned image but not for a separate file", () => {
    const image: TelegramTurnResult = {
      schemaVersion: 1,
      content: [{ kind: "attachment", attachment: { kind: "image", path: "outputs/chart.png" } }],
    };
    const file: TelegramTurnResult = {
      schemaVersion: 1,
      content: [
        { kind: "text", text: "Отчёт" },
        { kind: "attachment", attachment: { kind: "file", path: "outputs/report.pdf" } },
      ],
    };

    expect(selectTelegramTurnRepresentation(image)).toBe("native_rich");
    expect(selectTelegramTurnRepresentation(file)).toBe("compact_html");
  });

  it("joins adjacent text while resolving an image reference", () => {
    const result: TelegramTurnResult = {
      schemaVersion: 1,
      content: [
        { kind: "text", text: "![chart][asset]" },
        { kind: "text", text: "[asset]: https://example.com/chart.png" },
      ],
    };

    expect(selectTelegramTurnRepresentation(result)).toBe("native_rich");
  });

  it("keeps invalid advanced input on the existing rich-to-legacy path", () => {
    expect(selectTelegramTextRepresentation({
      source: "<details><summary>broken</summary>",
      positionedImageCount: 0,
    })).toBe("native_rich");
  });

  it("keeps over-limit advanced input on the existing rich-to-legacy path", () => {
    const cells = Array.from({ length: 21 }, (_, index) => `c${index}`);
    const source = `| ${cells.join(" | ")} |\n| ${cells.map(() => "---").join(" | ")} |`;

    expect(selectTelegramTextRepresentation({ source, positionedImageCount: 0 }))
      .toBe("native_rich");
  });

  it("is deterministic and does not mutate the result", () => {
    const input = textResult("## Report\n\n- one\n- two");
    const before = JSON.stringify(input);

    expect(selectTelegramTurnRepresentation(input))
      .toBe(selectTelegramTurnRepresentation(structuredClone(input)));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("classifies one million ordinary characters without constructing rich payloads", () => {
    expect(selectTelegramTextRepresentation({
      source: "x".repeat(1_000_000),
      positionedImageCount: 0,
    })).toBe("compact_html");
  });

  it("bounds adjacent text runs before joining them", () => {
    const result: TelegramTurnResult = {
      schemaVersion: 1,
      content: [
        { kind: "text", text: "a".repeat(800_000) },
        { kind: "text", text: "b".repeat(800_000) },
      ],
    };

    expect(selectTelegramTurnRepresentation(result)).toBe("native_rich");
  });
});
