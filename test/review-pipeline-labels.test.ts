import { describe, expect, it, vi } from "vitest";
import { fetchReviewLabelCatalog } from "../src/review-pipeline-labels.js";

const options = (fetchImpl: typeof fetch) => ({ server: "https://jira.example.test", login: "agent", token: "secret", fetchImpl });
const page = (issues: unknown[], total: number) => new Response(JSON.stringify({ issues, total }), { status: 200 });
const issue = (key: string, labels: string[], summary = "Summary") => ({ key, fields: { summary, labels } });

describe("review label catalog", () => {
  it("paginates MIR labels and filters technical labels", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([issue("MIR-1", ["поиск", "review", "ID12"])], 2))
      .mockResolvedValueOnce(page([issue("MIR-2", ["поиск", "seo_страницы", "telecodex-review-a"])], 2));
    await expect(fetchReviewLabelCatalog(options(fetchImpl))).resolves.toEqual([
      { label: "seo_страницы", examples: [{ key: "MIR-2", summary: "Summary" }] },
      { label: "поиск", examples: [{ key: "MIR-1", summary: "Summary" }, { key: "MIR-2", summary: "Summary" }] },
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ jql: "project = MIR AND labels is not EMPTY ORDER BY key", startAt: 0, maxResults: 1000, fields: ["summary", "labels"] });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ startAt: 1 });
  });

  it("fails closed on incomplete pagination", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page([], 1));
    await expect(fetchReviewLabelCatalog({ ...options(fetchImpl), server: "https://jira-two.example.test" })).rejects.toThrow(/pagination/i);
  });

  it("normalizes whitespace in untrusted Jira example summaries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page([issue("MIR-1", ["seo_страницы"], "\t[Frontend]: SEO\nстраницы")], 1));
    await expect(fetchReviewLabelCatalog({ ...options(fetchImpl), server: "https://jira-summary.example.test" })).resolves.toEqual([
      { label: "seo_страницы", examples: [{ key: "MIR-1", summary: "[Frontend]: SEO страницы" }] },
    ]);
  });

  it("fails closed when a page repeats an issue or claims the wrong offset", async () => {
    const repeated = vi.fn()
      .mockResolvedValueOnce(page([issue("MIR-1", ["поиск"])], 2))
      .mockResolvedValueOnce(page([issue("MIR-1", ["поиск"])], 2));
    await expect(fetchReviewLabelCatalog({ ...options(repeated), server: "https://jira-repeat.example.test" })).rejects.toThrow(/repeated/i);
    const wrongOffset = vi.fn().mockResolvedValue(new Response(JSON.stringify({ issues: [issue("MIR-1", ["поиск"])], total: 1, startAt: 1 }), { status: 200 }));
    await expect(fetchReviewLabelCatalog({ ...options(wrongOffset), server: "https://jira-offset.example.test" })).rejects.toThrow(/invalid page/i);
  });

  it("caches only for the same credentials and fetch implementation", async () => {
    const first = vi.fn().mockImplementation(() => Promise.resolve(page([issue("MIR-1", ["поиск"])], 1)));
    const second = vi.fn().mockImplementation(() => Promise.resolve(page([issue("MIR-1", ["акции"])], 1)));
    const base = { server: "https://jira-cache.example.test", login: "agent", token: "secret" };
    await fetchReviewLabelCatalog({ ...base, fetchImpl: first });
    await fetchReviewLabelCatalog({ ...base, fetchImpl: first });
    await fetchReviewLabelCatalog({ ...base, fetchImpl: second });
    await fetchReviewLabelCatalog({ ...base, login: "agent-two", fetchImpl: second });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });
});
