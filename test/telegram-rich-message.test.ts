import {
  TELEGRAM_RICH_BLOCK_LIMIT,
  TELEGRAM_RICH_CHARACTER_LIMIT,
  TELEGRAM_RICH_MEDIA_LIMIT,
  TELEGRAM_RICH_NESTING_LIMIT,
  TELEGRAM_RICH_TABLE_COLUMN_LIMIT,
  formatTelegramRichResult,
  type TelegramFormattedRichPart,
} from "../src/telegram-rich-message.js";
import type {
  TelegramTurnResult,
  TelegramTurnResultContent,
} from "../src/telegram-turn-result.js";

const text = (value: string): TelegramTurnResultContent => ({ kind: "text", text: value });
const image = (index: number): TelegramTurnResultContent => ({
  kind: "attachment",
  attachment: { kind: "image", path: `outputs/image-${index}.png`, name: `image-${index}.png` },
});
const file = (path: string): TelegramTurnResultContent => ({
  kind: "attachment",
  attachment: { kind: "file", path },
});
const result = (...content: TelegramTurnResultContent[]): TelegramTurnResult => ({
  schemaVersion: 1,
  content,
});
const rich = (parts: TelegramFormattedRichPart[]) => parts.filter((part) => part.kind === "rich");

function table(columns: number, cell = "value"): string {
  const header = `| ${Array.from({ length: columns }, (_, index) => `h${index}`).join(" | ")} |`;
  const divider = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const row = `| ${Array.from({ length: columns }, () => cell).join(" | ")} |`;
  return `${header}\n${divider}\n${row}`;
}

describe("formatTelegramRichResult", () => {
  it("exports the Bot API 10.2 rich-message limits", () => {
    expect(TELEGRAM_RICH_CHARACTER_LIMIT).toBe(32_768);
    expect(TELEGRAM_RICH_BLOCK_LIMIT).toBe(500);
    expect(TELEGRAM_RICH_NESTING_LIMIT).toBe(16);
    expect(TELEGRAM_RICH_MEDIA_LIMIT).toBe(50);
    expect(TELEGRAM_RICH_TABLE_COLUMN_LIMIT).toBe(20);
  });

  it("preserves supported headings, lists, tables, quotes, code, details, formulas, footnotes, and links", () => {
    const markdown = [
      "# Report",
      "",
      "1. ordered",
      "2. next",
      "",
      "- unordered",
      "  - nested",
      "",
      "| Metric | Value |",
      "|:-------|------:|",
      "| Speed | **42** |",
      "",
      "> quoted",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "<details open><summary>More</summary>",
      "inside with [safe](https://example.com/docs)",
      "</details>",
      "",
      "Inline $x^2$ and block:",
      "",
      "$$E = mc^2$$",
      "",
      "Reference[^note].",
      "",
      "[^note]: Footnote text.",
    ].join("\n");

    expect(formatTelegramRichResult(result(text(markdown)))).toEqual([{
      kind: "rich",
      markdown,
      media: [],
      source: markdown,
    }]);
  });

  it("neutralizes unsafe links and tags while keeping attempts inside code literal", () => {
    const markdown = [
      "<u>allowed</u> <script>alert(1)</script>",
      "[safe](https://example.com) [bad](javascript:alert(1))",
      "<a href=\"data:text/html,bad\">raw bad</a>",
      "<img src=\"file:///etc/passwd\"/>",
      "`<script>[bad](javascript:alert(1))</script>`",
      "\\`<script>alert(2)</script>\\` [bad\\]](javascript:alert(2))",
      "[reference][unsafe]\n\n[unsafe]: javascript:alert(3)",
      "[bad [inner]](javascript:alert(4))",
      "[indented][ref]\n\n  [ref]: javascript:alert(5)",
      "[escaped][id\\]]\n\n[id\\]]: javascript:alert(6)",
      "`<script>alert(9)</script>\\`",
      "```html\n<script src=\"javascript:bad\">[bad](javascript:bad)</script>\n```",
    ].join("\n\n");

    const [part] = formatTelegramRichResult(result(text(markdown)));
    expect(part?.kind).toBe("rich");
    if (part?.kind !== "rich") return;
    expect(part.markdown).toContain("<u>allowed</u>");
    expect(part.markdown).toContain("[safe](https://example.com)");
    expect(part.markdown.match(/\[bad\]\(javascript:/g)).toHaveLength(2);
    expect(part.markdown).not.toContain("<script>alert");
    expect(part.markdown).toContain("`<script>`alert(1)`</script>`");
    expect(part.markdown).toContain("`bad (javascript:alert(1))`");
    expect(part.markdown).toContain(
      "`<a href=\"data:text/html,bad\">`raw bad`</a>`",
    );
    expect(part.markdown).toContain("`<img src=\"file:///etc/passwd\"/>`");
    expect(part.markdown).not.toContain("<script>alert(2)");
    expect(part.markdown).toContain("`bad\\] (javascript:alert(2))`");
    expect(part.markdown).toContain("`unsafe (javascript:alert(3))`");
    expect(part.markdown).toContain("`bad [inner] (javascript:alert(4))`");
    expect(part.markdown).toContain("`ref (javascript:alert(5))`");
    expect(part.markdown).toContain("`id\\] (javascript:alert(6))`");
    const [asymmetric] = formatTelegramRichResult(result(text("`<script>alert(9)</script>\\`")));
    expect(asymmetric?.kind).toBe("rich");
    if (asymmetric?.kind === "rich") expect(asymmetric.markdown).toMatch(/^\\`/);
    expect(part.markdown).toContain("`<script>[bad](javascript:alert(1))</script>`");
    expect(part.markdown).toContain(
      "```html\n<script src=\"javascript:bad\">[bad](javascript:bad)</script>\n```",
    );
  });

  it("assigns deterministic image IDs and separates non-image files", () => {
    const parts = formatTelegramRichResult(result(
      text("before"),
      image(1),
      image(2),
      file("outputs/report.csv"),
      text("after"),
      image(3),
    ));

    expect(parts).toEqual([
      {
        kind: "rich",
        markdown: "before\n\n![](tg://photo?id=generated_0001)\n\n![](tg://photo?id=generated_0002)",
        media: [
          { id: "generated_0001", path: "outputs/image-1.png", name: "image-1.png" },
          { id: "generated_0002", path: "outputs/image-2.png", name: "image-2.png" },
        ],
        source: "before\n\n![](tg://photo?id=generated_0001)\n\n![](tg://photo?id=generated_0002)",
      },
      { kind: "file", attachment: { kind: "file", path: "outputs/report.csv" } },
      {
        kind: "rich",
        markdown: "after\n\n![](tg://photo?id=generated_0003)",
        media: [
          { id: "generated_0003", path: "outputs/image-3.png", name: "image-3.png" },
        ],
        source: "after\n\n![](tg://photo?id=generated_0003)",
      },
    ]);
  });

  it("measures exact Unicode code-point boundaries at 32,768 characters", () => {
    const exact = "😀".repeat(TELEGRAM_RICH_CHARACTER_LIMIT);
    const oversized = `${exact}😀`;

    expect(formatTelegramRichResult(result(text(exact)))[0]?.kind).toBe("rich");
    expect([...((formatTelegramRichResult(result(text(exact)))[0] as { markdown: string }).markdown)])
      .toHaveLength(TELEGRAM_RICH_CHARACTER_LIMIT);
    expect(formatTelegramRichResult(result(text(oversized)))).toEqual([
      { kind: "legacy", source: oversized },
    ]);
  });

  it("starts another rich part for the 51st image", () => {
    const fifty = formatTelegramRichResult(result(...Array.from({ length: 50 }, (_, i) => image(i + 1))));
    const fiftyOne = formatTelegramRichResult(result(...Array.from({ length: 51 }, (_, i) => image(i + 1))));

    expect(rich(fifty)).toHaveLength(1);
    expect(rich(fifty)[0]?.media).toHaveLength(TELEGRAM_RICH_MEDIA_LIMIT);
    expect(rich(fiftyOne).map((part) => part.media.length)).toEqual([50, 1]);
    expect(rich(fiftyOne)[1]?.markdown).toBe("![](tg://photo?id=generated_0051)");
  });

  it("accepts 20 table columns and falls back for 21", () => {
    const htmlTable = (columns: number): string =>
      `<table><tr>${"<td>x</td>".repeat(columns)}</tr></table>`;
    expect(formatTelegramRichResult(result(text(table(20))))[0]?.kind).toBe("rich");
    expect(formatTelegramRichResult(result(text(table(21))))).toEqual([
      { kind: "legacy", source: table(21) },
    ]);
    expect(formatTelegramRichResult(result(text(htmlTable(20))))[0]?.kind).toBe("rich");
    expect(formatTelegramRichResult(result(text(htmlTable(21))))).toEqual([
      { kind: "legacy", source: htmlTable(21) },
    ]);
    const colspan = (columns: number): string =>
      `<table><tr><td colspan=\"${columns}\">x</td></tr></table>`;
    expect(formatTelegramRichResult(result(text(colspan(20))))[0]?.kind).toBe("rich");
    expect(formatTelegramRichResult(result(text(colspan(21))))).toEqual([
      { kind: "legacy", source: colspan(21) },
    ]);
    const rowspan = [
      `<table><tr><td rowspan="2">x</td>${"<td>x</td>".repeat(19)}</tr>`,
      `<tr>${"<td>x</td>".repeat(20)}</tr></table>`,
    ].join("\n");
    expect(formatTelegramRichResult(result(text(rowspan)))).toEqual([
      { kind: "legacy", source: rowspan },
    ]);
    const invalidSpan = "<table><tr><td colspan=\"1e309\">x</td></tr></table>";
    expect((formatTelegramRichResult(result(text(invalidSpan)))[0] as { markdown: string }).markdown)
      .toContain("`<td colspan=\"1e309\">`");
  });

  it("accepts nesting depth 16 and falls back at 17", () => {
    const allowed = `${"> ".repeat(TELEGRAM_RICH_NESTING_LIMIT)}deep`;
    const excessive = `${"> ".repeat(TELEGRAM_RICH_NESTING_LIMIT + 1)}deep`;
    const details = (depth: number): string => [
      ...Array.from({ length: depth }, () => "<details><summary>level</summary>"),
      "deep",
      ...Array.from({ length: depth }, () => "</details>"),
    ].join("\n");

    expect(formatTelegramRichResult(result(text(allowed)))[0]?.kind).toBe("rich");
    expect(formatTelegramRichResult(result(text(excessive)))).toEqual([
      { kind: "legacy", source: excessive },
    ]);
    expect(formatTelegramRichResult(result(text(details(16))))[0]?.kind).toBe("rich");
    expect(formatTelegramRichResult(result(text(details(17))))).toEqual([
      { kind: "legacy", source: details(17) },
    ]);
  });

  it("keeps 500 blocks together and splits before block 501", () => {
    const fiveHundred = Array.from({ length: 500 }, (_, index) => `p${index}`).join("\n\n");
    const fiveHundredOne = `${fiveHundred}\n\np500`;

    expect(rich(formatTelegramRichResult(result(text(fiveHundred))))).toHaveLength(1);
    const split = rich(formatTelegramRichResult(result(text(fiveHundredOne))));
    expect(split).toHaveLength(2);
    expect(split[0]?.markdown).toBe(fiveHundred);
    expect(split[1]?.markdown).toBe("p500");
    const html = "<p>x</p>".repeat(TELEGRAM_RICH_BLOCK_LIMIT + 1);
    expect(formatTelegramRichResult(result(text(html)))).toEqual([{ kind: "legacy", source: html }]);

    const headingPairs = Array.from({ length: 250 }, (_, index) =>
      `# heading ${index}\nparagraph ${index}`).join("\n");
    const adjacent = `${headingPairs}\n# heading 250`;
    const adjacentParts = rich(formatTelegramRichResult(result(text(adjacent))));
    expect(adjacentParts).toHaveLength(2);
    expect(adjacentParts.map((part) => part.markdown).join("\n")).toBe(adjacent);

    const quoted = Array.from({ length: 501 }, (_, index) => `> p${index}`).join("\n>\n");
    expect(formatTelegramRichResult(result(text(quoted)))).toEqual([
      { kind: "legacy", source: quoted },
    ]);
    const detailedList = `<details><summary>items</summary>\n${Array.from(
      { length: 501 }, (_, index) => `- item ${index}`,
    ).join("\n")}\n</details>`;
    expect(formatTelegramRichResult(result(text(detailedList)))).toEqual([
      { kind: "legacy", source: detailedList },
    ]);
  });

  it("falls back for malformed supported HTML and keeps code markers structural-literal", () => {
    expect(formatTelegramRichResult(result(text("<b>unclosed")))).toEqual([
      { kind: "legacy", source: "<b>unclosed" },
    ]);
    const mismatched = "<b><i>mismatched</b></i>";
    expect(formatTelegramRichResult(result(text(mismatched)))).toEqual([
      { kind: "legacy", source: mismatched },
    ]);
    expect(formatTelegramRichResult(result(text("`<details>` literal")))[0]).toMatchObject({
      kind: "rich", markdown: "`<details>` literal",
    });
    const quote = "<blockquote>\n\ninside\n\n</blockquote>";
    expect(formatTelegramRichResult(result(text(quote)))).toEqual([
      { kind: "rich", markdown: quote, media: [], source: quote },
    ]);

    const invalidGrammar = [
      "<img/>",
      "<tg-map/>",
      "<summary>x</summary>",
      "<code class=\"language-js\">x</code>",
      "<video></video>",
      "<td>x</td>",
      "<tg-emoji>👍</tg-emoji>",
    ].join("\n\n");
    const [grammarPart] = formatTelegramRichResult(result(text(invalidGrammar)));
    expect(grammarPart?.kind).toBe("rich");
    if (grammarPart?.kind !== "rich") return;
    expect(grammarPart.markdown).toContain("`<img/>`");
    expect(grammarPart.markdown).toContain("`<tg-map/>`");
    expect(grammarPart.markdown).toContain("`<summary>`x`</summary>`");
    expect(grammarPart.markdown).toContain("`<code class=\"language-js\">`x`</code>`");
    expect(grammarPart.markdown).not.toContain("<video></video>");
    expect(grammarPart.markdown).toContain("`<video>`");
    expect(grammarPart.markdown).toContain("`</video>`");
    expect(grammarPart.markdown).toContain("`<td>`x`</td>`");
    expect(grammarPart.markdown).toContain("`<tg-emoji>`👍`</tg-emoji>`");

    const customEmoji = "<img src=\"tg://emoji?id=123\" alt=\"👍\"/>";
    expect(formatTelegramRichResult(result(text(customEmoji)))).toEqual([
      { kind: "rich", markdown: customEmoji, media: [], source: customEmoji },
    ]);
  });

  it("composes Markdown and HTML nesting depth", () => {
    const source = `${"> ".repeat(16)}<b>x</b>`;
    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
    const crossLine = [
      ...Array.from({ length: 16 }, () => "<details><summary>level</summary>"),
      "- item",
      ...Array.from({ length: 16 }, () => "</details>"),
    ].join("\n");
    expect(formatTelegramRichResult(result(text(crossLine)))).toEqual([
      { kind: "legacy", source: crossLine },
    ]);
  });

  it("keeps multiline footnote definitions indivisible", () => {
    const source = `[^note]: ${"x".repeat(TELEGRAM_RICH_CHARACTER_LIMIT)}\n\n  continuation`;
    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
  });

  it("validates image targets against media context without counting inline entities", () => {
    const invalid = [
      "![mail](mailto:user@example.com)",
      "![user](tg://user?id=1)",
      "![missing](tg://photo?id=missing)",
    ].join("\n\n");
    const [invalidPart] = formatTelegramRichResult(result(text(invalid)));
    expect(invalidPart?.kind).toBe("rich");
    if (invalidPart?.kind !== "rich") return;
    expect(invalidPart.markdown).toContain("`mail (mailto:user@example.com)`");
    expect(invalidPart.markdown).toContain("`user (tg://user?id=1)`");
    expect(invalidPart.markdown).toContain("`missing (tg://photo?id=missing)`");
    expect(invalidPart.media).toEqual([]);

    const entities = Array.from({ length: 51 }, (_, index) => index % 2 === 0
      ? `![emoji](tg://emoji?id=${index})`
      : `![time](tg://time?unix=${index})`).join("\n\n");
    const entityParts = rich(formatTelegramRichResult(result(text(entities))));
    expect(entityParts).toHaveLength(1);
    expect(entityParts[0]?.markdown).toBe(entities);
    expect(entityParts[0]?.media).toEqual([]);

    const references = [
      ...Array.from({ length: 51 }, () => "![image][asset]"),
      "[asset]: https://example.com/image.png",
    ].join("\n\n");
    expect(formatTelegramRichResult(result(text(references)))).toEqual([
      { kind: "legacy", source: references },
    ]);

    const angled = Array.from({ length: 51 }, (_, index) =>
      `![image ${index}](<https://example.com/${index}.png>)`).join("\n\n");
    expect(rich(formatTelegramRichResult(result(text(angled))))).toHaveLength(2);

    const unsafeReference = "![image][As Set]\n\n[as   set]: mailto:user@example.com";
    const [unsafeReferencePart] = formatTelegramRichResult(result(text(unsafeReference)));
    expect(unsafeReferencePart?.kind).toBe("rich");
    if (unsafeReferencePart?.kind === "rich") {
      expect(unsafeReferencePart.markdown).not.toContain("![image][As Set]");
      expect(unsafeReferencePart.markdown).toContain("`image (mailto:user@example.com)`");
    }
  });

  it("preserves safe angle-bracket reference destinations", () => {
    const source = "[link][id]\n\n[id]: <https://example.com/path>";
    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "rich", markdown: source, media: [], source },
    ]);
  });

  it("never cuts normal fences, tables, or details structures at part boundaries", () => {
    const fence = `\`\`\`txt\n${"f".repeat(16_000)}\n\`\`\``;
    const markdownTable = table(2, "t".repeat(8_000));
    const details = `<details><summary>More</summary>\n${"d".repeat(16_000)}\n</details>`;
    const parts = rich(formatTelegramRichResult(result(text(
      `${fence}\n\n${markdownTable}\n\n${details}`,
    ))));

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.filter((part) => part.markdown.includes("```"))).toHaveLength(1);
    expect(parts.find((part) => part.markdown.includes("```"))?.markdown).toContain(fence);
    expect(parts.filter((part) => part.markdown.includes("| h0 | h1 |"))).toHaveLength(1);
    expect(parts.find((part) => part.markdown.includes("| h0 | h1 |"))?.markdown)
      .toContain(markdownTable);
    expect(parts.filter((part) => part.markdown.includes("<details>"))).toHaveLength(1);
    expect(parts.find((part) => part.markdown.includes("<details>"))?.markdown).toContain(details);

    const nestedFence = [
      "<details><summary>Code</summary>",
      "```html",
      "</details>",
      "```",
      "after",
      "</details>",
    ].join("\n");
    expect(formatTelegramRichResult(result(text(nestedFence)))).toEqual([
      { kind: "rich", markdown: nestedFence, media: [], source: nestedFence },
    ]);
  });

  it("splits only oversized fenced code by closing and reopening with its language", () => {
    const code = "😀".repeat(TELEGRAM_RICH_CHARACTER_LIMIT + 1_000);
    const parts = rich(formatTelegramRichResult(result(text(`\`\`\`typescript\n${code}\n\`\`\`\``))));

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.markdown.startsWith("```typescript\n"))).toBe(true);
    expect(parts.every((part) => part.markdown.endsWith("\n```"))).toBe(true);
    expect(parts.every((part) => [...part.markdown].length <= TELEGRAM_RICH_CHARACTER_LIMIT))
      .toBe(true);
    expect(parts.map((part) => part.markdown.slice(14, -4)).join("")).toBe(code);
  });

  it("uses legacy delivery for an indivisible over-budget details block", () => {
    const source = `<details><summary>Huge</summary>\n${"x".repeat(TELEGRAM_RICH_CHARACTER_LIMIT)}\n</details>`;
    const tooManyBlocks = [
      "<details><summary>Huge</summary>",
      Array.from({ length: TELEGRAM_RICH_BLOCK_LIMIT }, (_, index) => `p${index}`).join("\n\n"),
      "</details>",
    ].join("\n");

    expect(formatTelegramRichResult(result(text(source)))).toEqual([
      { kind: "legacy", source },
    ]);
    expect(formatTelegramRichResult(result(text(tooManyBlocks)))).toEqual([
      { kind: "legacy", source: tooManyBlocks },
    ]);
    const continuedList = `- ${"x".repeat(TELEGRAM_RICH_CHARACTER_LIMIT)}\n\n  continuation`;
    expect(formatTelegramRichResult(result(text(continuedList)))).toEqual([
      { kind: "legacy", source: continuedList },
    ]);
  });

});
