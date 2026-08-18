import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { UsageStore, tokenBudgetStatus } from "../src/usage-store.js";

describe("UsageStore", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-usage-"));
    filePath = path.join(tempDir, ".telecodex", "token-usage.jsonl");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records one compact JSON object per completed turn", () => {
    const store = new UsageStore(filePath);

    store.record({
      ts: 1_000,
      contextKey: "1:2",
      workspace: "/work/a",
      model: "gpt-5",
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 4,
    });

    expect(readFileSync(filePath, "utf8")).toBe(
      '{"ts":1000,"contextKey":"1:2","workspace":"/work/a","model":"gpt-5","inputTokens":10,"cachedInputTokens":3,"outputTokens":4}\n',
    );
  });

  it("ignores malformed entries and aggregates by workspace", () => {
    const now = Date.UTC(2026, 7, 18);
    const store = new UsageStore(filePath);
    writeFileSync(filePath, [
      "not-json",
      JSON.stringify({ ts: now - 2 * 86_400_000, contextKey: "1", workspace: "/work/a", inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 }),
      JSON.stringify({ ts: now - 1 * 86_400_000, contextKey: "2", workspace: "/work/a", inputTokens: 7, cachedInputTokens: 1, outputTokens: 3 }),
      JSON.stringify({ ts: now - 3 * 86_400_000, contextKey: "3", workspace: "/work/b", inputTokens: 20, cachedInputTokens: 0, outputTokens: 6 }),
      JSON.stringify({ ts: now - 8 * 86_400_000, contextKey: "4", workspace: "/work/a", inputTokens: 100, cachedInputTokens: 0, outputTokens: 100 }),
      JSON.stringify({ ts: now, contextKey: "bad", workspace: "/work/c", inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }),
      "",
    ].join("\n"));

    expect(store.aggregate(7, now)).toEqual([
      { workspace: "/work/b", inputTokens: 20, cachedInputTokens: 0, outputTokens: 6, totalTokens: 26, turns: 1 },
      { workspace: "/work/a", inputTokens: 17, cachedInputTokens: 3, outputTokens: 8, totalTokens: 25, turns: 2 },
    ]);
  });

  it("keeps only the most recent 90 days during compaction", () => {
    const now = Date.UTC(2026, 7, 18);
    const store = new UsageStore(filePath);
    const recent = { ts: now - 89 * 86_400_000, contextKey: "recent", workspace: "/work/a", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };
    const expired = { ...recent, ts: now - 91 * 86_400_000, contextKey: "expired" };
    writeFileSync(filePath, `${JSON.stringify(expired)}\nmalformed\n${JSON.stringify(recent)}\n`);

    expect(store.compact(now)).toBe(1);
    expect(readFileSync(filePath, "utf8")).toBe(`${JSON.stringify(recent)}\n`);
  });
});

describe("tokenBudgetStatus", () => {
  it("returns warning at 80 percent and exceeded at 100 percent", () => {
    expect(tokenBudgetStatus(79, 100)).toBe("ok");
    expect(tokenBudgetStatus(80, 100)).toBe("warning");
    expect(tokenBudgetStatus(99, 100)).toBe("warning");
    expect(tokenBudgetStatus(100, 100)).toBe("exceeded");
  });
});
