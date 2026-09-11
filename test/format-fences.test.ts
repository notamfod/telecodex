import { performance } from "node:perf_hooks";

import {
  escapeHTML,
  formatTelegramHTML,
  normalizeTelegramPresentation,
  splitTelegramMarkdown,
} from "../src/format.js";

describe("formatTelegramHTML fenced code", () => {
  it("formats fenced code blocks with a language", () => {
    const input = "```ts\nconst x = 1 < 2;\n```";
    expect(formatTelegramHTML(input)).toBe(
      '<pre><code class="language-ts">const x = 1 &lt; 2;\n</code></pre>',
    );
  });

  it("formats fenced code blocks without a language and does not parse nested markdown", () => {
    const input = "```\n**bold**\n`code`\n```";
    expect(formatTelegramHTML(input)).toBe(
      '<pre><code class="language-text">**bold**\n`code`\n</code></pre>',
    );
  });

  it.each([
    ["invalid", "sql<script>"],
    ["overlong", "a".repeat(65)],
  ])("uses text for an %s fenced language", (_label, language) => {
    expect(formatTelegramHTML(`\`\`\`${language}\nSELECT 1;\n\`\`\``)).toBe(
      '<pre><code class="language-text">SELECT 1;\n</code></pre>',
    );
  });

  it("leaves an unclosed fence literal instead of inventing code structure", () => {
    expect(formatTelegramHTML("before\n```sql\nSELECT 1;")).toBe("before\n```sql\nSELECT 1;");
  });

  it("requires a closing fence on its own line", () => {
    const input = "```sql\nSELECT 1; ``` remains code\n```";
    expect(formatTelegramHTML(input)).toBe(
      '<pre><code class="language-sql">SELECT 1; ``` remains code\n</code></pre>',
    );
  });

  it("treats closing-fence indentation as syntax rather than code body", () => {
    const input = "  ```text\nvalue\n  ```";

    expect(formatTelegramHTML(input)).toBe(
      '  <pre><code class="language-text">value\n</code></pre>',
    );
  });

  it.each([
    ["bash", "npm test\nnpm run build"],
    ["yaml", "service:\n  replicas: 2\n  enabled: true"],
    ["sql", "SELECT id, status\nFROM jobs\nWHERE status = 'pending';"],
    ["text", "2026-09-11 INFO started\n2026-09-11 WARN retry"],
  ])("preserves %s fenced content", (language, body) => {
    const html = formatTelegramHTML(`\`\`\`${language}\n${body}\n\`\`\``);
    expect(html).toContain(`<pre><code class="language-${language}">`);
    expect(html).toContain(escapeHTML(body));
    expect(html.endsWith("</code></pre>")).toBe(true);
  });
});

describe("normalizeTelegramPresentation fenced code", () => {
  it("preserves an authored blank before an unclosed fence", () => {
    const source = "before\n\n```sql\nSELECT 1;";

    expect(normalizeTelegramPresentation(source)).toBe(source);
  });

  it("does not invent a blank before an adjacent unclosed fence", () => {
    const source = "before\n```sql\nSELECT 1;";

    expect(normalizeTelegramPresentation(source)).toBe(source);
  });
});

describe("splitTelegramMarkdown fenced code", () => {
  it("round-trips indentation trailing spaces and blank lines across fenced chunks", () => {
    const body = `${Array.from({ length: 80 }, (_, index) =>
      `  line ${index + 1}  `).join("\n")}\n\n  tail`;
    const chunks = splitTelegramMarkdown(`\`\`\`\n${body}\n\`\`\``, 120, 180);
    const restored = chunks.map(({ sourceText }) => sourceText
      .replace(/^```text\n/, "")
      .replace(/\n```$/, ""))
      .join("");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(({ sourceText }) => /^```text\n[\s\S]*\n```$/.test(sourceText))).toBe(true);
    expect(chunks.every(({ html }) => html.startsWith('<pre><code class="language-text">')
      && html.endsWith("</code></pre>"))).toBe(true);
    expect(restored).toBe(body);
  });

  it("keeps a newline selected as a fenced chunk boundary", () => {
    const body = "a\nb\nc";
    const chunks = splitTelegramMarkdown(`\`\`\`text\n${body}\n\`\`\``, 14, 100);
    const restored = chunks.map(({ sourceText }) => sourceText
      .replace(/^```text\n/, "")
      .replace(/\n```$/, ""))
      .join("");

    expect(chunks.length).toBeGreaterThan(1);
    expect(restored).toBe(body);
  });

  it("uses text for an unbounded fenced language identifier", () => {
    const language = "a".repeat(5_000);
    const input = `\`\`\`${language}\nten characters\n\`\`\``;
    const chunks = splitTelegramMarkdown(input, 3_000, 4_096);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sourceText).toBe("```text\nten characters\n```");
    expect(chunks[0]?.html).toBe('<pre><code class="language-text">ten characters\n</code></pre>');
    expect(chunks.every((chunk) => chunk.html.length <= 4_096)).toBe(true);

    const started = performance.now();
    const longChunks = splitTelegramMarkdown(`\`\`\`${language}\n${"<&>\n".repeat(50_000)}\`\`\``, 3_000, 4_096);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(longChunks.length).toBeLessThanOrEqual(512);
    expect(longChunks.every((chunk) => chunk.sourceText.length <= 3_000)).toBe(true);
    expect(longChunks.every((chunk) => chunk.html.length <= 4_096)).toBe(true);
  });

  it("keeps an empty fence with an oversized language as one valid text fence", () => {
    const input = `\`\`\`${"a".repeat(5_000)}\n\n\`\`\``;

    expect(splitTelegramMarkdown(input, 3_000, 4_096)).toEqual([{
      sourceText: "```text\n\n```",
      html: '<pre><code class="language-text">\n</code></pre>',
      plain: "```text\n\n```",
    }]);
  });

  it("accepts an empty sanitized fence at the exact source and HTML budgets", () => {
    const input = `\`\`\`${"a".repeat(5_000)}\n\n\`\`\``;

    expect(splitTelegramMarkdown(input, 12, 47)).toEqual([{
      sourceText: "```text\n\n```",
      html: '<pre><code class="language-text">\n</code></pre>',
      plain: "```text\n\n```",
    }]);
  });

  it.each([
    [11, 47],
    [12, 46],
  ])("rejects an empty text fence when the %i/%i budgets cannot fit its wrapper", (
    targetLength,
    maxHtmlLength,
  ) => {
    const input = `\`\`\`${"a".repeat(5_000)}\n\n\`\`\``;

    expect(() => splitTelegramMarkdown(input, targetLength, maxHtmlLength))
      .toThrow("Telegram markdown limits cannot fit fenced block");
  });

  it("requires room beyond the wrapper for a non-empty fenced body", () => {
    expect(() => splitTelegramMarkdown("```text\na\n```", 12, 100))
      .toThrow("Telegram markdown limits cannot fit fenced block");
  });

  it("does not canonicalize a pathological list row inside fenced code", () => {
    const body = `${"\t".repeat(2_045)}- [x] deep 😀`;
    const sourceText = `\`\`\`\n${body}\n\`\`\``;

    expect(splitTelegramMarkdown(sourceText, 3_000, 4_096)).toEqual([{
      sourceText,
      html: `<pre><code class="language-text">${body}\n</code></pre>`,
      plain: sourceText,
    }]);
  });

  it("preserves a pathological list row inside an indented fence", () => {
    const body = `${"\t".repeat(2_045)}- [x] deep 😀`;
    const sourceText = `  \`\`\`\n${body}\n  \`\`\``;
    const html = `  <pre><code class="language-text">${body}\n</code></pre>`;
    const chunks = splitTelegramMarkdown(sourceText, 3_000, 4_096);

    expect(chunks).toEqual([{ sourceText, html, plain: sourceText }]);
    expect(chunks.every((chunk) => Array.from(chunk.sourceText).length <= 3_000
      && Array.from(chunk.html).length <= 4_096)).toBe(true);
    expect(chunks[0]?.sourceText.match(/\t/g)).toHaveLength(2_045);
    expect(chunks[0]?.html.match(/\t/g)).toHaveLength(2_045);
  });
});
