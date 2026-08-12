import { describe, expect, it } from "vitest";

import { buildMarkdownDocument } from "../src/markdown-document.js";

const long = (marker: string) => `${marker} ${"word ".repeat(400)}`.trim();

describe("buildMarkdownDocument", () => {
  it("keeps the whole answer in the file, untouched", () => {
    const text = `# Отчёт\n\n${long("Первый абзац.")}`;

    expect(buildMarkdownDocument(text).content).toBe(text);
  });

  it("leads with the opening of the answer and says it continues in the file", () => {
    const text = `Короткое вступление.\n\n${long("Дальше подробности.")}`;

    const { caption } = buildMarkdownDocument(text);

    expect(caption.startsWith("Короткое вступление.")).toBe(true);
    expect(caption).toContain("…");
    expect(caption.length).toBeLessThanOrEqual(1024);
  });

  it("cuts the lead-in at a line break rather than mid-word", () => {
    const text = `${"строка раз\n".repeat(200)}`;

    const { caption } = buildMarkdownDocument(text);

    expect(caption.replace("…", "").trimEnd().endsWith("строка раз")).toBe(true);
  });

  it("uses the whole text as the lead-in when it already fits", () => {
    const { caption } = buildMarkdownDocument("Одна строка.");

    expect(caption).toBe("Одна строка.");
  });

  it("names the file after the first heading", () => {
    expect(buildMarkdownDocument("# Статус синхронизации\n\nтекст").fileName).toBe(
      "статус-синхронизации.md",
    );
  });

  it("falls back to a plain name when there is nothing to name it after", () => {
    expect(buildMarkdownDocument("```\ncode\n```").fileName).toBe("ответ.md");
  });
});
