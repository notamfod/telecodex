import { describe, expect, it } from "vitest";
import { gitlabReviewKeyboard, gitlabReviewUrl } from "../src/gitlab-review-links.js";

const event = { projectPath: "group/app", before: "a".repeat(40), after: "b".repeat(40) };
const requestId = "1".repeat(32);
const links = { gitlabUrl: "https://git.example.test", miniAppLaunchUrl: "https://t.me/ExampleBot/app?startapp=jira" };

describe("review navigation buttons", () => {
  it("uses group-compatible Mini App deep links and a pinned GitLab comparison", () => {
    const keyboard = gitlabReviewKeyboard(event, requestId, links, true);
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: "▶ Запустить ревью", callback_data: `greview:${requestId}` }],
      [{ text: "☐ В подборку", callback_data: `gpselect:${requestId}` },
        { text: "▶ Запустить пайплайн", callback_data: `gpipeline:${requestId}` }],
      [{ text: "📄 Дифф", url: `https://t.me/ExampleBot/app?startapp=review_${requestId}` },
        { text: "↗ GitLab", url: `https://git.example.test/group/app/-/compare/${event.before}...${event.after}?straight=true` }],
    ]);
    expect(gitlabReviewKeyboard(event, requestId, links, false).inline_keyboard).toHaveLength(2);
  });

  it("uses actual reviewed SHAs after review and falls back to a commit for old cards", () => {
    expect(gitlabReviewUrl(links.gitlabUrl, event, { baseSha: "c".repeat(40), headSha: "d".repeat(40), items: [] }))
      .toContain(`${"c".repeat(40)}...${"d".repeat(40)}`);
    expect(gitlabReviewUrl(links.gitlabUrl, { ...event, before: undefined })).toContain("/-/commit/");
    expect(gitlabReviewUrl(links.gitlabUrl, { ...event, before: "0".repeat(40) })).toContain("/-/commit/");
  });

  it("rejects unsafe origins, paths, and ids before buttons reach Telegram", () => {
    expect(() => gitlabReviewUrl("javascript:alert(1)", event)).toThrow();
    expect(() => gitlabReviewUrl(links.gitlabUrl, { ...event, projectPath: "../private" })).toThrow();
    expect(() => gitlabReviewKeyboard(event, "bad", links, true)).toThrow();
    expect(() => gitlabReviewKeyboard(event, requestId, { ...links, miniAppLaunchUrl: "http://example.test" }, true)).toThrow();
  });
});
