import { describe, expect, it } from "vitest";

import {
  buildSentryAnalysisPrompt,
  openSentryTaskThread,
  parseSentryTaskCallback,
  sentryTaskTopicName,
} from "../src/sentry-task-thread.js";
import { vi } from "vitest";

describe("Sentry task thread", () => {
  it("parses a compact issue callback", () => {
    expect(parseSentryTaskCallback("sentry_task:3999:MIR-BACK-2TC")).toEqual({
      issueId: "3999",
      shortId: "MIR-BACK-2TC",
    });
    expect(parseSentryTaskCallback("sentry_task:../../etc:MIR-BACK-2TC")).toBeNull();
  });

  it("builds a read-only prompt that fetches details only after the button press", () => {
    const prompt = buildSentryAnalysisPrompt("3999", "MIR-BACK-2TC");

    expect(prompt).toContain("dofbox --realm mircli sentry issue 3999");
    expect(prompt).toContain("MIR-BACK-2TC");
    expect(prompt).toMatch(/ничего не меняй/i);
    expect(prompt).toMatch(/причин/i);
  });

  it("uses the configured Sentry realm instead of assuming MirCli", () => {
    const prompt = buildSentryAnalysisPrompt("4001", "ANT-BACK-2TC", "antwerp");

    expect(prompt).toContain("dofbox --realm antwerp sentry issue 4001");
    expect(prompt).not.toContain("--realm mircli");
  });

  it("uses the short id in a Telegram-safe topic name", () => {
    expect(sentryTaskTopicName("MIR-BACK-2TC")).toBe("🔎 MIR-BACK-2TC · Sentry");
  });

  it("creates the topic before starting the Codex analysis", async () => {
    const calls: string[] = [];
    const result = await openSentryTaskThread({
      issueId: "3999",
      shortId: "MIR-BACK-2TC",
    }, {
      createTopic: vi.fn(async (name) => {
        calls.push(`create:${name}`);
        return 2072;
      }),
      initializeTopic: vi.fn(async (topicId) => {
        calls.push(`init:${topicId}`);
      }),
      startAnalysis: vi.fn(async (topicId, prompt) => {
        calls.push(`start:${topicId}:${prompt.includes("sentry issue 3999")}`);
      }),
    });

    expect(calls).toEqual([
      "create:🔎 MIR-BACK-2TC · Sentry",
      "init:2072",
      "start:2072:true",
    ]);
    expect(result).toEqual({
      topicId: 2072,
      topicName: "🔎 MIR-BACK-2TC · Sentry",
    });
  });
});
