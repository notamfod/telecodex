import { describe, expect, it, vi } from "vitest";

import { registerCommands, renderUsageReport } from "../src/bot.js";

describe("TeleCodex command menu", () => {
  it("registers /tickets for unresolved ticket navigation", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "tickets", description: "List unresolved inbox tickets" },
    ]));
  });

  it("registers /title as the manual ticket-topic fallback", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "title", description: "Rename the current ticket topic" },
    ]));
  });

  it("registers /usage for project token totals", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerCommands({ api: { setMyCommands } } as never);

    expect(setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([
      { command: "usage", description: "Token usage by project" },
    ]));
  });
});

describe("usage report", () => {
  it("shows project totals and the weekly 80 percent warning", () => {
    const report = renderUsageReport([
      { workspace: "/work/alpha", inputTokens: 800, cachedInputTokens: 200, outputTokens: 100, totalTokens: 900, turns: 2 },
    ], 30, 1_000, 800);

    expect(report.html).toContain("За 30 дней");
    expect(report.html).toContain("/work/alpha");
    expect(report.html).toContain("Всего: 900");
    expect(report.html).toContain("80% недельного лимита");
    expect(report.plain).not.toContain("<code>");
  });

  it("shows an exceeded warning at the weekly limit", () => {
    const report = renderUsageReport([], 7, 1_000, 1_000);

    expect(report.html).toContain("Недельный лимит исчерпан");
  });
});
