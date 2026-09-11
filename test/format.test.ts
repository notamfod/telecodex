import { performance } from "node:perf_hooks";

import {
  escapeHTML,
  formatTelegramHTML,
  normalizeTelegramPresentation,
  splitTelegramMarkdown,
} from "../src/format.js";

describe("escapeHTML", () => {
  it("escapes HTML entities", () => {
    expect(escapeHTML("<div>& hi ></div>")).toBe("&lt;div&gt;&amp; hi &gt;&lt;/div&gt;");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHTML("hello world")).toBe("hello world");
  });
});

describe("formatTelegramHTML", () => {
  it("formats inline code with single and double backticks", () => {
    expect(formatTelegramHTML("Use `const x = 1` now")).toBe("Use <code>const x = 1</code> now");
    expect(formatTelegramHTML("Use ``a ` tricky` value`` now")).toBe(
      "Use <code>a ` tricky` value</code> now",
    );
  });

  it("formats bold and italic markers", () => {
    expect(formatTelegramHTML("**bold** _italics_ *also italics*")).toBe(
      "<b>bold</b> <i>italics</i> <i>also italics</i>",
    );
  });

  it("formats links and sanitizes unsafe URLs", () => {
    expect(formatTelegramHTML("[safe](https://example.com) [mail](mailto:test@example.com)")).toBe(
      '<a href="https://example.com">safe</a> <a href="mailto:test@example.com">mail</a>',
    );
    expect(formatTelegramHTML("[bad](javascript:alert(1))")).toBe('<a href="#">bad</a>)');
  });

  it("formats blockquotes", () => {
    expect(formatTelegramHTML("> first\n> second\nplain")).toBe(
      "<blockquote>first\nsecond</blockquote>\nplain",
    );
  });

  it("supports mixed formatting in the same message", () => {
    const input = "Hello **bold** with `code` and _italics_ plus [link](tg://resolve?domain=pi)";
    expect(formatTelegramHTML(input)).toBe(
      'Hello <b>bold</b> with <code>code</code> and <i>italics</i> plus <a href="tg://resolve?domain=pi">link</a>',
    );
  });

  it("handles empty and whitespace-only strings", () => {
    expect(formatTelegramHTML("")).toBe("");
    expect(formatTelegramHTML("   ")).toBe("   ");
  });

  it("leaves unclosed markers untouched", () => {
    expect(formatTelegramHTML("**bold")).toBe("**bold");
    expect(formatTelegramHTML("`code")).toBe("`code");
    expect(formatTelegramHTML("[link](https://example.com")).toBe("[link](https://example.com");
  });

  it("escapes HTML before applying markdown formatting", () => {
    expect(formatTelegramHTML("<b>not bold</b> & **yes**")).toBe(
      "&lt;b&gt;not bold&lt;/b&gt; &amp; <b>yes</b>",
    );
  });

  it("does not escape double quotes (intentional for HTML content)", () => {
    expect(escapeHTML('say "hello"')).toBe('say "hello"');
  });

  it("handles blockquote-only input", () => {
    const result = formatTelegramHTML("> quoted line");
    expect(result).toBe("<blockquote>quoted line</blockquote>");
  });

  it("handles multi-line blockquotes", () => {
    const result = formatTelegramHTML("> line one\n> line two\nnot quoted");
    expect(result).toBe("<blockquote>line one\nline two</blockquote>\nnot quoted");
  });

  it("renders headings and lists using Telegram-native HTML", () => {
    expect(formatTelegramHTML("# Заголовок\n\n- первый\n- **второй**\n1. третий")).toBe(
      "<b>Заголовок</b>\n\n• первый\n• <b>второй</b>\n1. третий",
    );
  });

  it("caps visual list indentation at two levels", () => {
    const input = [
      "- root", "  - child", "    - deep", "      - deeper",
      "        1. ordered", "          - [x] checked",
    ].join("\n");

    expect(formatTelegramHTML(input)).toBe([
      "• root", "  • child", "    • deep", "    • • deeper",
      "    • • 1. ordered", "    • • • ☑ checked",
    ].join("\n"));
  });

  it("treats tabs as one bounded list level", () => {
    expect(formatTelegramHTML("- root\n\t- child\n\t\t\t- deep"))
      .toBe("• root\n  • child\n    • • deep");
  });

  it("normalizes Russian section spacing without expanding lists", () => {
    const input = [
      "# Что сделано", "Текст раздела.", "", "", "## Проверка",
      "- первый пункт", "", "- второй пункт",
    ].join("\n");

    expect(formatTelegramHTML(input)).toBe([
      "<b>Что сделано</b>", "", "Текст раздела.", "", "<b>Проверка</b>",
      "", "• первый пункт", "• второй пункт",
    ].join("\n"));
  });

  it("keeps authored paragraphs and collapses only excess outside-fence blanks", () => {
    expect(formatTelegramHTML("Первый.\n\n\n\nВторой.")).toBe("Первый.\n\nВторой.");
  });
});

describe("normalizeTelegramPresentation", () => {
  it("preserves whitespace-only input", () => {
    expect(normalizeTelegramPresentation("   ")).toBe("   ");
  });

  it("does not normalize indentation or blank lines inside a fence and is idempotent", () => {
    const source = [
      "Перед кодом", "```text", "  first  ", "", "    second", "```", "После кода",
    ].join("\n");
    const normalized = normalizeTelegramPresentation(source);

    expect(normalized).toBe([
      "Перед кодом", "", "```text", "  first  ", "", "    second", "```", "", "После кода",
    ].join("\n"));
    expect(normalizeTelegramPresentation(normalized)).toBe(normalized);
  });

  it("recognizes a CRLF closing fence while preserving its body bytes", () => {
    const source = "Перед\r\n```text\r\n  first  \r\n\r\n    second\r\n```\r\nПосле  \r\n";

    expect(normalizeTelegramPresentation(source)).toBe(
      "Перед\n\n```text\n  first  \r\n\r\n    second\r\n```\n\nПосле",
    );
  });

});

describe("splitTelegramMarkdown", () => {
  const hasLoneSurrogate = (value: string): boolean =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
  const codePointLength = (value: string): number => Array.from(value).length;
  const fencedBody = (value: string): string => value.replace(/^```txt\n/, "").replace(/\n```$/, "");

  it.each([
    { label: "plain target", input: `aaaa😀bbbbb`, target: 5, html: 100, fenced: false },
    { label: "plain HTML", input: `a😀b`, target: 100, html: 2, fenced: false },
    { label: "fenced target", input: `\`\`\`txt\na😀b\n\`\`\``, target: 12, html: 100, fenced: true },
    {
      label: "fenced HTML", input: `\`\`\`txt\na😀b\n\`\`\``, target: 100,
      html: codePointLength(formatTelegramHTML("```txt\n\n```")) + 2, fenced: true,
    },
  ])("does not split an astral character at the $label boundary", ({ input, target, html, fenced }) => {
    const chunks = splitTelegramMarkdown(input, target, html);
    const rejoined = fenced
      ? chunks.map((chunk) => fencedBody(chunk.sourceText)).join("")
      : chunks.map((chunk) => chunk.sourceText).join("");
    const original = fenced ? fencedBody(input) : input;

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => !hasLoneSurrogate(chunk.sourceText) && !hasLoneSurrogate(chunk.html))).toBe(true);
    expect(chunks.every((chunk) => codePointLength(chunk.sourceText) <= target)).toBe(true);
    expect(chunks.every((chunk) => codePointLength(chunk.html) <= html)).toBe(true);
    expect(rejoined).toBe(original);
  });

  it("keeps fenced code and links structurally intact", () => {
    const input = [
      "# Отчёт",
      "",
      "Текст ".repeat(300),
      "",
      "```ts",
      "const value = 1;",
      "console.log(value);",
      "```",
      "",
      "Подробнее: [документация](https://example.com/docs?q=one)",
    ].join("\n");

    const chunks = splitTelegramMarkdown(input, 500, 1000);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.html.length <= 1000)).toBe(true);
    expect(chunks.some((chunk) => chunk.html.includes(
      '<pre><code class="language-ts">const value = 1;\nconsole.log(value);\n</code></pre>',
    ))).toBe(true);
    expect(chunks.some((chunk) => chunk.html.includes(
      '<a href="https://example.com/docs?q=one">документация</a>',
    ))).toBe(true);
  });

  it("splits oversized fenced code into valid independent code blocks", () => {
    const input = `\`\`\`txt\n${"<&>\n".repeat(400)}\`\`\``;

    const chunks = splitTelegramMarkdown(input, 300, 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.html.startsWith('<pre><code class="language-txt">'))).toBe(true);
    expect(chunks.every((chunk) => chunk.html.endsWith("</code></pre>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.html.length <= 500)).toBe(true);
  });

  it("splits one million ordinary characters with bounded work", () => {
    const input = "x".repeat(1_000_000);
    const started = performance.now();
    const chunks = splitTelegramMarkdown(input, 3_000, 4_096);

    expect(performance.now() - started).toBeLessThan(10_000);
    expect(chunks).toHaveLength(334);
    expect(chunks.every((chunk) => chunk.html.length <= 4_096)).toBe(true);
    expect(chunks.map((chunk) => chunk.sourceText).join("")).toBe(input);
  });

  it("splits a large fenced block without repeatedly rendering its remaining suffix", () => {
    const input = `\`\`\`txt\n${"<&>\n".repeat(50_000)}\`\`\``;
    const started = performance.now();
    const chunks = splitTelegramMarkdown(input, 3_000, 4_096);

    expect(performance.now() - started).toBeLessThan(10_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.html.startsWith('<pre><code class="language-txt">'))).toBe(true);
    expect(chunks.every((chunk) => chunk.html.endsWith("</code></pre>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.html.length <= 4_096)).toBe(true);
  });

  it("stops bounded splitting before generating excess chunks", () => {
    const boundedSplit = splitTelegramMarkdown as (
      markdown: string, targetLength: number, maxHtmlLength: number, maximumChunks: number,
    ) => ReturnType<typeof splitTelegramMarkdown>;
    expect(() => boundedSplit("x".repeat(10_000), 3_000, 4_096, 2))
      .toThrow("Telegram markdown split exceeds chunk budget");
  });

  it("uses the same normalized source for sizing and rendering", () => {
    const chunks = splitTelegramMarkdown("# Раздел\nТекст\n\n\n- один\n\n- два", 4_096, 4_096);

    expect(chunks).toEqual([{
      sourceText: "# Раздел\n\nТекст\n\n- один\n- два",
      html: "<b>Раздел</b>\n\nТекст\n\n• один\n• два",
      plain: "# Раздел\n\nТекст\n\n- один\n- два",
    }]);
  });

  it("keeps a long Russian list compact and within Telegram limits", () => {
    const source = Array.from({ length: 300 }, (_, index) =>
      `${"  ".repeat(index % 6)}- пункт ${index + 1} 😀`).join("\n");
    const chunks = splitTelegramMarkdown(source, 3_000, 4_096);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(({ html }) => Array.from(html).length <= 4_096)).toBe(true);
    expect(chunks.every(({ html }) => !/^ {6}/m.test(html))).toBe(true);
    expect(chunks.map(({ html }) => html).join("\n")).toContain("пункт 300 😀");
  });

  it("canonicalizes pathological task-list indentation before splitting", () => {
    const expected = "    • • • …×2043 ☑ deep 😀";
    const chunks = splitTelegramMarkdown(`${"\t".repeat(2_045)}- [x] deep 😀`, 3_000, 4_096);

    expect(chunks).toEqual([{ sourceText: expected, html: expected, plain: expected }]);
    expect(chunks.some(({ sourceText, html, plain }) =>
      sourceText.includes("\t") || html.includes("\t") || plain.includes("\t"))).toBe(false);
  });

  it("canonicalizes pathological ordered-list indentation before splitting", () => {
    const expected = "    • • • …×2998 0042) deep 😀";
    const chunks = splitTelegramMarkdown(`${"\t".repeat(3_000)}0042) deep 😀`, 3_000, 4_096);

    expect(chunks).toEqual([{ sourceText: expected, html: expected, plain: expected }]);
    expect(chunks.some(({ sourceText, html, plain }) =>
      sourceText.includes("\t") || html.includes("\t") || plain.includes("\t"))).toBe(false);
  });

  it("canonicalizes a 2045-tab task row inside an adjacent list block", () => {
    const sourceText = "- root\n    • • • …×2043 ☑ deep 😀\n- tail";
    const html = "• root\n    • • • …×2043 ☑ deep 😀\n• tail";
    const chunks = splitTelegramMarkdown(
      `- root\n${"\t".repeat(2_045)}- [x] deep 😀\n- tail`, 3_000, 4_096,
    );

    expect(chunks).toEqual([{ sourceText, html, plain: sourceText }]);
    expect(chunks.every((chunk) => Array.from(chunk.sourceText).length <= 3_000
      && Array.from(chunk.html).length <= 4_096)).toBe(true);
    expect(chunks.every(({ sourceText: text, html: rendered, plain }) =>
      !text.includes("\t") && !rendered.includes("\t") && !plain.includes("\t"))).toBe(true);
  });

  it("canonicalizes a 3000-tab task row inside an adjacent list block", () => {
    const sourceText = "- root\n    • • • …×2998 ☑ deep 😀\n- tail";
    const html = "• root\n    • • • …×2998 ☑ deep 😀\n• tail";
    const chunks = splitTelegramMarkdown(
      `- root\n${"\t".repeat(3_000)}- [x] deep 😀\n- tail`, 3_000, 4_096,
    );

    expect(chunks).toEqual([{ sourceText, html, plain: sourceText }]);
    expect(chunks.every((chunk) => Array.from(chunk.sourceText).length <= 3_000
      && Array.from(chunk.html).length <= 4_096)).toBe(true);
    expect(chunks.every(({ sourceText: text, html: rendered, plain }) =>
      !text.includes("\t") && !rendered.includes("\t") && !plain.includes("\t"))).toBe(true);
  });

  it("canonicalizes a 2045-tab task row between prose lines", () => {
    const expected = "intro\n    • • • …×2043 ☑ deep 😀\noutro";
    const chunks = splitTelegramMarkdown(
      `intro\n${"\t".repeat(2_045)}- [x] deep 😀\noutro`, 3_000, 4_096,
    );

    expect(chunks).toEqual([{ sourceText: expected, html: expected, plain: expected }]);
    expect(chunks.every((chunk) => Array.from(chunk.sourceText).length <= 3_000
      && Array.from(chunk.html).length <= 4_096)).toBe(true);
    expect(chunks.every(({ sourceText, html, plain }) =>
      !sourceText.includes("\t") && !html.includes("\t") && !plain.includes("\t"))).toBe(true);
  });

  it("canonicalizes a 3000-tab task row between prose lines", () => {
    const expected = "intro\n    • • • …×2998 ☑ deep 😀\noutro";
    const chunks = splitTelegramMarkdown(
      `intro\n${"\t".repeat(3_000)}- [x] deep 😀\noutro`, 3_000, 4_096,
    );

    expect(chunks).toEqual([{ sourceText: expected, html: expected, plain: expected }]);
    expect(chunks.every((chunk) => Array.from(chunk.sourceText).length <= 3_000
      && Array.from(chunk.html).length <= 4_096)).toBe(true);
    expect(chunks.every(({ sourceText, html, plain }) =>
      !sourceText.includes("\t") && !html.includes("\t") && !plain.includes("\t"))).toBe(true);
  });

  it("does not renormalize later chunks of an unclosed fence", () => {
    const source = [
      "```text",
      "01234567890123456789",
      "abcdefghijklmnopqrst",
      "late  ",
      "",
      "",
      "end",
    ].join("\n");
    const chunks = splitTelegramMarkdown(source, 35, 4_096);
    const lateChunk = chunks.at(-1);
    const expected = "ghijklmnopqrst\nlate  \n\n\nend";

    expect(chunks.length).toBeGreaterThan(1);
    expect(lateChunk).toEqual({
      sourceText: expected,
      html: expected,
      plain: expected,
    });
  });
});
