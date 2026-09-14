import { describe, expect, it } from "vitest";

import {
  formatSessionLabel,
  renderHelpMessage,
  renderModelSummaryPlain,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "../src/bot-ui.js";

describe("bot-ui", () => {
  describe("renderHelpMessage", () => {
    it("contains all command groups", () => {
      const { html, plain } = renderHelpMessage();
      expect(html).toContain("Сессия");
      expect(html).toContain("Модель");
      expect(html).toContain("Авторизация");
      expect(html).toContain("Справка");
      expect(plain).toContain("/new");
      expect(plain).toContain("/help");
      expect(plain).toContain("/retry");
      expect(plain).toContain("/launch_profiles");
      expect(plain).toContain("/jira");
      expect(plain).not.toContain("/model");
    });

    it("lists all 27 commands", () => {
      const { plain } = renderHelpMessage();
      const commandMatches = plain.match(/^  \/\w+/gm) ?? [];
      expect(commandMatches.length).toBe(27);
    });

    it("explains task controls without confusing a session or MR draft with task completion", () => {
      for (const text of Object.values(renderHelpMessage())) {
        expect(text).toContain("Задача - ваша цель");
        expect(text).toContain("топик - место работы");
        expect(text).toContain("сессия - диалог с Codex");
        expect(text).toContain("/new - Новая сессия в этом топике");
        expect(text).toContain("/done - Черновик комментария к MR; задачу не завершает");
        expect(text).toContain("/task - Создать или обновить постоянную карточку задачи в этом топике");
        expect(text).toContain("/task off - Остановить обновления, сохранив карточку");
        expect(text).toContain(text.includes("<b>") ? "/task title &lt;название&gt;" : "/task title <название>");
      }
    });

    it("returns valid HTML with bold tags", () => {
      const { html } = renderHelpMessage();
      expect(html).toContain("<b>");
      expect(html).toContain("</b>");
    });
  });

  describe("renderModelSummaryPlain", () => {
    it("shows active and next provider/model pairs", () => {
      expect(
        renderModelSummaryPlain({
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          nextModel: "glm-5.3",
          nextModelProvider: "zai",
        }),
      ).toEqual([
        "Model: openai/gpt-5.6-sol",
        "Next model: zai/glm-5.3",
      ]);
    });

    it("omits missing model values", () => {
      expect(renderModelSummaryPlain({})).toEqual([]);
    });
  });

  describe("renderWelcomeFirstTime", () => {
    it("shows welcome without auth warning", () => {
      const { html, plain } = renderWelcomeFirstTime();
      expect(html).toContain("TeleCodex готов");
      expect(plain).toContain("/help");
      expect(plain).toContain("Опишите задачу сообщением, чтобы начать сессию с Codex.");
      expect(plain).not.toContain("choose a model");
      expect(html).not.toContain("⚠️");
    });

    it("includes auth warning when provided", () => {
      const { html, plain } = renderWelcomeFirstTime("Not authenticated");
      expect(html).toContain("⚠️");
      expect(plain).toContain("Not authenticated");
    });
  });

  describe("renderWelcomeReturning", () => {
    it("shows session info for returning user", () => {
      const { html, plain } = renderWelcomeReturning(
        "<b>Thread:</b> abc123",
        "Thread: abc123",
        false,
      );
      expect(html).toContain("TeleCodex");
      expect(html).toContain("abc123");
      expect(plain).toContain("abc123");
    });

    it("shows topic label for topic sessions", () => {
      const { html } = renderWelcomeReturning("", "", true);
      expect(html).toContain("сессия в топике");
    });

    it("includes auth warning when provided", () => {
      const { html } = renderWelcomeReturning("", "", false, "Expired");
      expect(html).toContain("⚠️");
      expect(html).toContain("Expired");
    });
  });

  describe("formatSessionLabel", () => {
    it("formats basic session label", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-project",
        title: "fix the login bug",
        relativeTime: "3h ago",
        isActive: false,
      });
      expect(label).toContain("📁");
      expect(label).toContain("my-project");
      expect(label).toContain("fix the login bug");
      expect(label).toContain("3h ago");
    });

    it("shows checkmark for active session", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "now",
        isActive: true,
      });
      expect(label).toContain("✅");
    });

    it("appends model tag when available", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "1m ago",
        model: "gpt-4o",
        isActive: false,
      });
      expect(label).toContain("gpt-4o");
    });

    it("truncates long workspace names to 12 chars", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-very-long-project-name",
        title: "test",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label).toContain("my-very-lon…");
    });

    it("truncates long titles to 20 chars", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "this is an extremely long title that should be truncated",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label.length).toBeLessThan(120);
    });

    it("handles missing title gracefully", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "",
        relativeTime: "5m ago",
        isActive: false,
      });
      expect(label).toContain("(untitled)");
    });

    it("truncates long model names", () => {
      const label = formatSessionLabel({
        workspace: "/p",
        title: "t",
        relativeTime: "1m",
        model: "very-long-model-name-here",
        isActive: false,
      });
      expect(label).toContain("very-long…");
    });
  });
});
