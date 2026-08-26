import { describe, expect, it } from "vitest";

import {
  recipeDigestKeyboard,
  recipeFindingDetailKeyboard,
  renderRecipeDigestHTML,
  renderRecipeFindingDetailHTML,
} from "../src/recipe-review-digest.js";
import type { Finding } from "../src/recipes.js";

function findings(count = 12): Finding[] {
  return Array.from({ length: count }, (_, index) => ({
    severity: index < 3 ? "high" : "medium",
    priority: index < 3 ? "P1" : "P2",
    aspect: index % 2 === 0 ? "architecture" : "performance",
    file: `src/file-${index + 1}.ts`,
    line: index + 10,
    category: `category-${index + 1}`,
    description: `Описание ${index + 1}`,
    author: `Автор ${index + 1}`,
    commitSha: `${String(index + 1).padStart(8, "0")}abcdef`,
    commitUrl: `https://gitlab.example/project/-/commit/${index + 1}`,
  }));
}

describe("recipe review digest", () => {
  it("highlights the project and renders five findings with counts and metadata", () => {
    const html = renderRecipeDigestHTML({
      project: "mir-survey",
      findings: findings(),
      page: 0,
      repeatedCount: 2,
      suppressedCount: 1,
    });

    expect(html).toContain("<b>mir-survey</b>");
    expect(html).toContain("12 новых");
    expect(html).toContain("P1: 3");
    expect(html).toContain("P2: 9");
    expect(html).toContain("Страница 1/3");
    expect(html).toContain("Описание 1");
    expect(html).toContain("Описание 5");
    expect(html).not.toContain("Описание 6");
    expect(html).toContain("Автор: Автор 1");
    expect(html).toContain('href="https://gitlab.example/project/-/commit/1"');
    expect(html).toContain("повторы: 2");
    expect(html).toContain("заглушено: 1");
  });

  it("renders the requested page and creates detail plus bounded navigation callbacks", () => {
    const all = findings();
    const html = renderRecipeDigestHTML({ project: "mir-survey", findings: all, page: 1 });
    const keyboard = recipeDigestKeyboard(16, all, 1);

    expect(html).toContain("Описание 6");
    expect(html).toContain("Описание 10");
    expect(html).not.toContain("Описание 5");
    expect(html).not.toContain("Описание 11");
    expect(keyboard.inline_keyboard.slice(0, 5).map((row) => row[0]?.callback_data)).toEqual([
      "rdetail:16:5",
      "rdetail:16:6",
      "rdetail:16:7",
      "rdetail:16:8",
      "rdetail:16:9",
    ]);
    expect(keyboard.inline_keyboard.at(-1)?.map((button) => button.callback_data)).toEqual([
      "rpage:16:0",
      "rnoop:16",
      "rpage:16:2",
    ]);
  });

  it("renders one selected finding and keeps its actions in the same message", () => {
    const all = findings();
    const html = renderRecipeFindingDetailHTML("mir-survey", all[5]!, 5, all.length);
    const keyboard = recipeFindingDetailKeyboard(16, 5);

    expect(html).toContain("<b>mir-survey</b>");
    expect(html).toContain("6 из 12");
    expect(html).toContain("Описание 6");
    expect(html).toContain("Автор: Автор 6");
    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "🔧 Тред-фикс", callback_data: "rfix:16:5" },
        { text: "🔇 Игнорировать", callback_data: "rmute:16:5" },
      ],
      [{ text: "← К списку", callback_data: "rpage:16:1" }],
    ]);
    expect(recipeFindingDetailKeyboard(16, 5, true).inline_keyboard).toEqual([
      [{ text: "← К списку", callback_data: "rpage:16:1" }],
    ]);
  });

  it("keeps a five-finding page within Telegram's message limit", () => {
    const oversized = findings(5).map((finding, index) => ({
      ...finding,
      file: `src/${"<unsafe>".repeat(80)}-${index}.ts`,
      category: "<category>".repeat(80),
      description: "<description>".repeat(80),
      author: "<author>".repeat(80),
      commitUrl: `https://gitlab.example/${"segment/".repeat(80)}${index}`,
    }));

    const html = renderRecipeDigestHTML({
      project: "mir-survey",
      findings: oversized,
      page: 0,
    });

    expect(html.length).toBeLessThanOrEqual(4096);
    expect(html.match(/<b>\d+\.<\/b>/g)).toHaveLength(5);

    const detail = renderRecipeFindingDetailHTML(
      "<project>".repeat(200),
      oversized[0]!,
      0,
      oversized.length,
    );
    expect(detail.length).toBeLessThanOrEqual(4096);
  });
});
