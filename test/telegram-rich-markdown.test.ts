import {
  TELEGRAM_RICH_BLOCK_LIMIT,
  TELEGRAM_RICH_CHARACTER_LIMIT,
  TELEGRAM_RICH_MEDIA_LIMIT,
  TELEGRAM_RICH_NESTING_LIMIT,
  formatTelegramRichResult,
  type TelegramFormattedRichPart,
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
const rich = (parts: TelegramFormattedRichPart[]) => parts.filter((part) => part.kind === "rich");

function expectNeutralizedOrLegacy(source: string, opening: string): void {
  const [part] = formatTelegramRichResult(result(text(source)));
  if (part?.kind === "legacy") {
    expect(part.source).toBe(source);
    return;
  }
  expect(part?.kind).toBe("rich");
  if (part?.kind === "rich") expect(part.markdown).toContain(`\`${opening}\``);
}

describe("Telegram Rich Markdown adversarial structures", () => {
  it("counts combined block kinds additively inside containers", () => {
    const headings = `<details><summary>headings</summary>\n${Array.from(
      { length: TELEGRAM_RICH_BLOCK_LIMIT + 1 }, (_, index) => `# heading ${index}`,
    ).join("\n")}\n</details>`;
    const mixed = `<details><summary>mixed</summary>\n${Array.from(
      { length: 300 }, () => "<p>paragraph</p>",
    ).join("\n")}\n${Array.from(
      { length: 300 }, (_, index) => `- item ${index}`,
    ).join("\n")}\n</details>`;

    expect(formatTelegramRichResult(result(text(headings)))).toEqual([
      { kind: "legacy", source: headings },
    ]);
    expect(formatTelegramRichResult(result(text(mixed)))).toEqual([
      { kind: "legacy", source: mixed },
    ]);
  });

  it("counts Markdown container blocks in addition to their children", () => {
    const list = Array.from({ length: TELEGRAM_RICH_BLOCK_LIMIT }, (_, index) =>
      `- item ${index}`).join("\n");
    const quote = Array.from({ length: TELEGRAM_RICH_BLOCK_LIMIT }, (_, index) =>
      `> paragraph ${index}`).join("\n>\n");
    const table = [
      "| key | value |",
      "| --- | --- |",
      ...Array.from({ length: TELEGRAM_RICH_BLOCK_LIMIT - 1 }, (_, index) =>
        `| ${index} | value |`),
    ].join("\n");

    for (const source of [list, quote, table]) {
      expect(formatTelegramRichResult(result(text(source)))).toEqual([
        { kind: "legacy", source },
      ]);
    }
  });

  it("starts a new list container when the marker type changes", () => {
    const source = Array.from({ length: 251 }, (_, index) =>
      index % 2 === 0 ? `- unordered ${index}` : `1. ordered ${index}`).join("\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("adds a list level after nested quote prefixes", () => {
    const source = `${"> ".repeat(TELEGRAM_RICH_NESTING_LIMIT)}- item`;

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("derives ordered-list depth from marker width and padding", () => {
    const nested = (depth: number): string => Array.from({ length: depth }, (_, index) =>
      `${"   ".repeat(index)}1. level ${index}`).join("\n");
    const allowed = nested(TELEGRAM_RICH_NESTING_LIMIT);
    const excessive = nested(TELEGRAM_RICH_NESTING_LIMIT + 1);

    expect(formatTelegramRichResult(result(text(allowed)))).toEqual([
      { kind: "rich", markdown: allowed, media: [], source: allowed },
    ]);
    expect(formatTelegramRichResult(result(text(excessive)))).toEqual([
      { kind: "legacy", source: excessive },
    ]);
  });

  it("includes closed inline Markdown formatting in nesting depth", () => {
    const nested = (depth: number): string => {
      let value = "deep";
      for (let index = 0; index < depth; index += 1) {
        const marker = index % 2 === 0 ? "*" : "**";
        value = `${marker}level${index} ${value} end${index}${marker}`;
      }
      return value;
    };
    const allowed = nested(TELEGRAM_RICH_NESTING_LIMIT);
    const excessive = nested(TELEGRAM_RICH_NESTING_LIMIT + 1);

    expect(formatTelegramRichResult(result(text(allowed)))).toEqual([
      { kind: "rich", markdown: allowed, media: [], source: allowed },
    ]);
    expect(formatTelegramRichResult(result(text(excessive)))).toEqual([
      { kind: "legacy", source: excessive },
    ]);
    const html = nested(TELEGRAM_RICH_NESTING_LIMIT).replace("deep", "<b>x</b>");
    expect(formatTelegramRichResult(result(text(html)))).toEqual([{ kind: "legacy", source: html }]);
    const sibling = `${nested(TELEGRAM_RICH_NESTING_LIMIT)} <b>x</b>`;
    expect(formatTelegramRichResult(result(text(sibling)))[0]?.kind).toBe("rich");
    const literals = "`*****************code*****************` and $*****************math*****************$ " +
      "and \\*escaped\\* ".repeat(17);
    expect(formatTelegramRichResult(result(text(literals)))[0]?.kind).toBe("rich");
  });

  it("includes links, images, and marks in inline nesting depth", () => {
    const wrap = (inner: string, depth = TELEGRAM_RICH_NESTING_LIMIT): string => {
      let value = inner;
      for (let index = 0; index < depth; index += 1) {
        const marker = index % 2 === 0 ? "*" : "**";
        value = `${marker}level${index} ${value} end${index}${marker}`;
      }
      return value;
    };

    for (const source of [
      wrap("[safe](https://example.com)"),
      wrap("![asset](https://example.com/asset.png)"),
      wrap("==marked=="),
    ]) expect(formatTelegramRichResult(result(text(source)))).toEqual([{ kind: "legacy", source }]);

    for (const source of ["[safe](https://example.com)", "==marked=="].map((value) =>
      wrap(value, TELEGRAM_RICH_NESTING_LIMIT - 1))) {
      expect(formatTelegramRichResult(result(text(source)))[0]?.kind).toBe("rich");
    }

    const escapedImage = wrap("\\![asset](https://example.com/asset.png)");
    expect(formatTelegramRichResult(result(text(escapedImage)))).toEqual([
      { kind: "rich", markdown: escapedImage, media: [], source: escapedImage },
    ]);
  });

  it("ignores details closers inside quote-prefixed fenced code", () => {
    const source = [
      "<details><summary>Code</summary>",
      "> ```html",
      "> </details>",
      "> ```",
      "after",
      "</details>",
    ].join("\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "rich", markdown: source, media: [], source },
    ]);
  });

  it("resolves collapsed image references and keeps the first definition", () => {
    const safe = "![asset][]\n\n[asset]: https://example.com/first.png";
    const unsafe = "![asset][]\n\n[asset]: mailto:user@example.com";
    const duplicate = [
      "![image][asset]",
      "",
      "[asset]: https://example.com/first.png",
      "[asset]: mailto:user@example.com",
    ].join("\n");

    expect(formatTelegramRichResult(result(text(safe)))).toEqual([
      { kind: "rich", markdown: safe, media: [], source: safe },
    ]);
    const [unsafePart] = formatTelegramRichResult(result(text(unsafe)));
    expect(unsafePart?.kind).toBe("rich");
    if (unsafePart?.kind === "rich") {
      expect(unsafePart.markdown).not.toContain("![asset][]");
      expect(unsafePart.markdown).toContain("`asset (mailto:user@example.com)`");
    }
    const [duplicatePart] = formatTelegramRichResult(result(text(duplicate)));
    expect(duplicatePart?.kind).toBe("rich");
    if (duplicatePart?.kind === "rich") {
      expect(duplicatePart.markdown).toContain("![image][asset]");
      expect(duplicatePart.markdown).toContain("[asset]: https://example.com/first.png");
    }
  });

  it("applies the media limit to collapsed image references", () => {
    const source = [
      ...Array.from({ length: TELEGRAM_RICH_MEDIA_LIMIT + 1 }, () => "![asset][]"),
      "[asset]: https://example.com/image.png",
    ].join("\n\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("recognizes quoted definitions and GFM shortcut image references", () => {
    const quotedUnsafe = [
      "> ![asset][]",
      ">",
      "> [asset]: javascript:alert(1)",
    ].join("\n");
    const [quotedPart] = formatTelegramRichResult(result(text(quotedUnsafe)));
    expect(quotedPart?.kind).toBe("rich");
    if (quotedPart?.kind === "rich") {
      expect(quotedPart.markdown).not.toContain("![asset][]");
      expect(quotedPart.markdown).not.toContain("[asset]: javascript:alert(1)");
    }

    const safe = "![asset]\n\n[asset]: https://example.com/first.png";
    expect(formatTelegramRichResult(result(text(safe)))).toEqual([
      { kind: "rich", markdown: safe, media: [], source: safe },
    ]);
    const unsafe = "![asset]\n\n[asset]: mailto:user@example.com";
    const [unsafePart] = formatTelegramRichResult(result(text(unsafe)));
    expect(unsafePart?.kind).toBe("rich");
    if (unsafePart?.kind === "rich") {
      expect(unsafePart.markdown).not.toContain("![asset]\n");
      expect(unsafePart.markdown).toContain("`asset (mailto:user@example.com)`");
    }
  });

  it("applies the media limit to GFM shortcut image references", () => {
    const source = [
      ...Array.from({ length: TELEGRAM_RICH_MEDIA_LIMIT + 1 }, () => "![asset]"),
      "[asset]: https://example.com/image.png",
    ].join("\n\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("keeps multiline formula blocks indivisible", () => {
    const source = `$$\n${"x".repeat(20_000)}\n\n${"y".repeat(20_000)}\n$$`;
    const comparisons = "$$\nx < y\n\nz > 1\n$$";
    const manyLines = `$$\n${Array.from({ length: TELEGRAM_RICH_BLOCK_LIMIT + 1 },
      (_, index) => `x_${index}`).join("\n\n")}\n$$`;

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
    for (const formula of [comparisons, manyLines]) {
      expect(formatTelegramRichResult(result(text(formula)))).toEqual([
        { kind: "rich", markdown: formula, media: [], source: formula },
      ]);
    }
  });

  it("protects inline formulas without treating escaped dollars as delimiters", () => {
    const formulas = "Inline $x < y$ and $$z < q$$ remain literal.";
    const escaped = "Escaped \\$x < y\\$ is not a formula.";

    expect(formatTelegramRichResult(result(text(formulas)))).toEqual([
      { kind: "rich", markdown: formulas, media: [], source: formulas },
    ]);
    expect(formatTelegramRichResult(result(text(escaped)))).toEqual([{
      kind: "rich",
      markdown: "Escaped \\$x &lt; y\\$ is not a formula.",
      media: [],
      source: escaped,
    }]);
  });

  it("keeps lazy blockquote and list continuations indivisible", () => {
    const quote = `> ${"q".repeat(20_000)}\nlazy ${"c".repeat(20_000)}`;
    const list = `- ${"i".repeat(20_000)}\nlazy ${"c".repeat(20_000)}`;

    for (const source of [quote, list]) {
      expect(formatTelegramRichResult(result(text(source)))).toEqual([
        { kind: "legacy", source },
      ]);
    }
  });

  it("preserves official self-closing media and gallery captions", () => {
    const source = [
      "<video src=\"https://example.com/video.mp4\"/>",
      "<tg-collage><figcaption>collage</figcaption></tg-collage>",
      "<tg-slideshow><figcaption>slides</figcaption></tg-slideshow>",
    ].join("\n\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "rich", markdown: source, media: [], source },
    ]);
  });

  it("neutralizes invalid parent and required tag grammar", () => {
    const source = [
      "<input checked>",
      "<li>standalone</li>",
      "<figcaption>standalone</figcaption>",
      "<tg-reference>reference</tg-reference>",
      "<tg-time>now</tg-time>",
      "<table><tr><td align=\"bogus\">cell</td></tr></table>",
    ].join("\n\n");
    const [part] = formatTelegramRichResult(result(text(source)));

    expect(part?.kind).toBe("rich");
    if (part?.kind !== "rich") return;
    for (const opening of [
      "<input checked>", "<li>", "<figcaption>", "<tg-reference>", "<tg-time>",
      "<td align=\"bogus\">",
    ]) expect(part.markdown).toContain(`\`${opening}\``);

    const valid = [
      "<ul><li><input type=\"checkbox\" checked> task</li></ul>",
      "<figure><figcaption>caption</figcaption></figure>",
      "<tg-reference name=\"source\">reference</tg-reference>",
      "<tg-time unix=\"1720000000\">time</tg-time>",
      "<table><tr><td align=\"center\" valign=\"top\">cell</td></tr></table>",
    ].join("\n\n");
    expect(formatTelegramRichResult(result(text(valid)))).toEqual([
      { kind: "rich", markdown: valid, media: [], source: valid },
    ]);
  });

  it("enforces cite, details, table-child, and tg-emoji grammar", () => {
    expectNeutralizedOrLegacy("<cite>standalone</cite>", "<cite>");
    expectNeutralizedOrLegacy("<details>missing summary</details>", "<details>");
    expectNeutralizedOrLegacy("<table><p>invalid child</p></table>", "<p>");

    const valid = [
      "<tg-emoji emoji-id=\"thumb\">👍</tg-emoji>",
      "<tg-emoji emoji-id=\"family\">👨‍👩‍👧‍👦</tg-emoji>",
    ].join("\n\n");
    expect(formatTelegramRichResult(result(text(valid)))).toEqual([
      { kind: "rich", markdown: valid, media: [], source: valid },
    ]);
    expectNeutralizedOrLegacy("<tg-emoji emoji-id=\"bad\">👍👍</tg-emoji>", "<tg-emoji emoji-id=\"bad\">");
    expectNeutralizedOrLegacy("<tg-emoji emoji-id=\"bad\" alt=\"👍👍\"/>", "<tg-emoji emoji-id=\"bad\" alt=\"👍👍\"/>");
    expectNeutralizedOrLegacy("<tg-emoji emoji-id=\"bad\" alt=\"👍\"/>", "<tg-emoji emoji-id=\"bad\" alt=\"👍\"/>");
  });

  it("preserves documented cite parents and rejects block children in structural tags", () => {
    const valid = [
      "<aside><cite>aside source</cite></aside>",
      "<blockquote><cite>quote source</cite></blockquote>",
      "<figure><figcaption><cite>caption source</cite></figcaption></figure>",
      "<blockquote><footer><cite>footer source</cite></footer></blockquote>",
      "<ul><li>item</li></ul>",
      "<table><tr><td><strong>inline</strong></td></tr></table>",
    ].join("\n\n");
    expect(formatTelegramRichResult(result(text(valid)))).toEqual([
      { kind: "rich", markdown: valid, media: [], source: valid },
    ]);

    expectNeutralizedOrLegacy("<ul><p>invalid</p></ul>", "<p>");
    expectNeutralizedOrLegacy("<table><tr><p>invalid</p></tr></table>", "<p>");
    expectNeutralizedOrLegacy("<table><tr><td><p>invalid</p></td></tr></table>", "<p>");
  });

  it("rejects non-whitespace text directly inside structural HTML containers", () => {
    const invalid = [
      "<ul>plain text</ul>",
      "<ul><p>invalid</p></ul>",
      "<table><tr>plain text<td>x</td></tr></table>",
    ];
    for (const source of invalid) expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);

    const whitespace = "<ul>\n  <li>item</li>\n</ul>";
    expect(formatTelegramRichResult(result(text(whitespace)))).toEqual([
      { kind: "rich", markdown: whitespace, media: [], source: whitespace },
    ]);
  });

  it("requires a single-emoji alt for tg emoji images", () => {
    const valid = "<img src=\"tg://emoji?id=123\" alt=\"👨‍👩‍👧‍👦\"/>";
    expect(formatTelegramRichResult(result(text(valid)))).toEqual([
      { kind: "rich", markdown: valid, media: [], source: valid },
    ]);

    expectNeutralizedOrLegacy("<img src=\"tg://emoji?id=123\"/>", "<img src=\"tg://emoji?id=123\"/>");
    expectNeutralizedOrLegacy(
      "<img src=\"tg://emoji?id=123\" alt=\"not emoji\"/>",
      "<img src=\"tg://emoji?id=123\" alt=\"not emoji\"/>",
    );
    expectNeutralizedOrLegacy(
      "<img src=\"tg://emoji?id=123\" alt=\"👍👍\"/>",
      "<img src=\"tg://emoji?id=123\" alt=\"👍👍\"/>",
    );
  });

  it("preserves safe GFM autolinks", () => {
    const source = "See <https://example.com/docs?q=1> for details.";

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "rich", markdown: source, media: [], source },
    ]);
  });

  it("still separates safe units at aggregate character boundaries", () => {
    const first = "a".repeat(TELEGRAM_RICH_CHARACTER_LIMIT / 2 + 1);
    const second = "b".repeat(TELEGRAM_RICH_CHARACTER_LIMIT / 2 + 1);
    const parts = rich(formatTelegramRichResult(result(text(`${first}\n\n${second}`))));

    expect(parts.map((part) => part.markdown)).toEqual([first, second]);
  });
});
