import { buildTelegramResponsePlan } from "../src/telegram-response-plan.js";
import { formatTelegramHTML } from "../src/format.js";
import { formatTelegramRichResult, TELEGRAM_RICH_CHARACTER_LIMIT } from "../src/telegram-rich-message.js";

const destination = { chatId: -1001, messageThreadId: 77, anchorMessageId: 501 };
const makeResult = (text: string) => ({ schemaVersion: 1 as const, content: [{ kind: "text" as const, text }] });
const decode = (html: string) => html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function bodies(texts: string[]): string[] {
  expect(texts.length).toBeGreaterThan(1);
  return texts.map((text, index) => {
    const label = `<b>Часть ${index + 1} из ${texts.length}</b>\n\n`;
    expect(text.startsWith(label)).toBe(true);
    expect([...text].length).toBeLessThanOrEqual(4_096);
    expect(text.isWellFormed()).toBe(true);
    return text.slice(label.length);
  });
}

describe("multipart answer presentation", () => {
  it("preserves long escaped Unicode text within the HTML budget including labels", () => {
    const text = "😀<&>".repeat(2_000);
    const plan = buildTelegramResponsePlan({ result: makeResult(text), destination });
    const texts = plan.parts.map(({ payload }) => {
      if (payload.operation !== "send_text") throw new Error("expected compact text");
      return payload.text;
    });
    expect(bodies(texts).map(decode).join("")).toBe(text);
  });

  it("keeps multipart code in independently closed blocks with labels outside the code", () => {
    const code = '  console.log("😀 <&>");\n'.repeat(500);
    const plan = buildTelegramResponsePlan({ result: makeResult(`\`\`\`js\n${code}\`\`\``), destination });
    const texts = plan.parts.map(({ payload }) => {
      if (payload.operation !== "send_text") throw new Error("expected compact code");
      return payload.text;
    });
    const fragments = bodies(texts).map((html) => {
      expect(html).toMatch(/^<pre><code class="language-js">[\s\S]*<\/code><\/pre>$/);
      return decode(html.replace(/^<pre><code class="language-js">/, "").replace(/<\/code><\/pre>$/, ""));
    });
    // Reopened fences add one delimiter newline per fragment.
    expect(fragments.map((fragment) => fragment.replace(/\n$/, "")).join("").trimEnd()).toBe(code.trimEnd());
  });

  it("preserves short answer wording and links without service labels", () => {
    const text = "Готово: [отчёт](https://example.test/report?a=1&b=2). `x < 2`";
    const plan = buildTelegramResponsePlan({ result: makeResult(text), destination });
    expect(plan.anchor.payload).toMatchObject({ operation: "edit_text", text: formatTelegramHTML(text) });
    expect(plan.parts).toEqual([]);
  });

  it("keeps rich Markdown unchanged and labels only its independently bounded fallback", () => {
    const result = makeResult(`| A | B |\n|---|---|\n| 1 | 2 |\n\n${"😀<&>".repeat(2_000)}`);
    const formatted = formatTelegramRichResult(result);
    const plan = buildTelegramResponsePlan({ result, destination });
    const rich = plan.parts[0]?.payload;
    if (rich?.operation !== "send_rich" || formatted[0]?.kind !== "rich") throw new Error("expected rich part");
    expect(rich.markdown).toBe(formatted[0].markdown);
    expect([...rich.markdown].length).toBeLessThanOrEqual(TELEGRAM_RICH_CHARACTER_LIMIT);
    const texts = rich.fallbackParts.map(({ payload }) => {
      if (payload.operation !== "send_text") throw new Error("expected text fallback");
      return payload.text;
    });
    const decoded = bodies(texts).map(decode).join("");
    expect(decoded.match(/😀/gu)).toHaveLength(2_000);
    expect(decoded).toContain("| 1 | 2 |");
  });
});
