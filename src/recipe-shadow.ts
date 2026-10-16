import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ReviewRecipe, MircliReviewRecipe } from "./recipe-config.js";
import { fingerprintFinding, type Finding } from "./recipes.js";

type CodeReviewRecipe = ReviewRecipe | MircliReviewRecipe;

/** The shadow log is read by a human, so undo the Telegram markup and its escaping. */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** During calibration the findings land here so false positives can be muted by hand. */
export async function writeShadow(
  recipe: CodeReviewRecipe,
  project: string,
  stamp: string,
  findings: Finding[],
  html: string,
  shadowDir: string,
): Promise<void> {
  await mkdir(shadowDir, { recursive: true });
  const lines = [
    `## ${stamp} · ${project}`,
    "",
    toPlainText(html),
    "",
    "Отпечатки — скопируй в `ignored` в .telecodex/recipes.json, чтобы заглушить:",
    ...findings.map((finding) => `    ${JSON.stringify(fingerprintFinding(finding))},`),
    "",
    "",
  ];
  await appendFile(
    path.join(shadowDir, `${recipe.id}-${project}.shadow.md`),
    lines.join("\n"),
    "utf8",
  );
}
