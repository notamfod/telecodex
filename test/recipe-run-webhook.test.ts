import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runReviewPortfolio: vi.fn(), deliverReviewDigest: vi.fn(), enqueue: vi.fn(), scheduled: vi.fn() }));
vi.mock("../src/review-pipeline-enqueue.js", () => ({ enqueueReviewFindings: mocks.enqueue, enqueueScheduledReviewFindings: mocks.scheduled }));
vi.mock("../src/recipe-review-delivery.js", () => ({ deliverReviewDigest: mocks.deliverReviewDigest }));
vi.mock("../src/review-portfolio.js", async (original) => ({
  ...await original<typeof import("../src/review-portfolio.js")>(),
  runReviewPortfolio: mocks.runReviewPortfolio,
}));

describe("webhook recipe runner", () => {
  const cwd = process.cwd();
  const argv = process.argv;
  const exitCode = process.exitCode;
  const config = process.env.RECIPES_CONFIG;
  let directory: string | undefined;

  afterEach(() => {
    process.chdir(cwd);
    process.argv = argv;
    process.exitCode = exitCode;
    if (config === undefined) delete process.env.RECIPES_CONFIG;
    else process.env.RECIPES_CONFIG = config;
    if (directory) rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
    mocks.runReviewPortfolio.mockReset();
    mocks.deliverReviewDigest.mockReset();
    mocks.enqueue.mockReset();
    mocks.scheduled.mockReset();
  });

  it("reports partial failure to the durable queue after preserving successful progress", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "tc-webhook-runner-"));
    writeFileSync(path.join(directory, "prompt.md"), "review");
    writeFileSync(path.join(directory, "recipes.json"), JSON.stringify({ recipes: [{
      id: "daily-diff-review", kind: "mircli-review", cwd: "/srv/mircli",
      worktreeRoot: "/cache", promptFile: "prompt.md",
    }] }));
    mocks.runReviewPortfolio.mockResolvedValue({ projects: [
      { name: "mir-back", sourcePath: "/srv/mircli/mir-back", status: "failed",
        headSha: "back-new", findings: [], error: "agent failed" },
      { name: "mir-admin", sourcePath: "/srv/mircli/mir-admin", status: "unchanged",
        headSha: "admin-new", findings: [] },
    ] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = ["node", "recipe-run.js", "daily-diff-review", "--projects", '["mir-back","mir-admin"]'];
    process.env.RECIPES_CONFIG = path.join(directory, "recipes.json");
    process.exitCode = 0;
    process.chdir(directory);
    await import("../src/recipe-run.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(mocks.runReviewPortfolio).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ projectNames: ["mir-back", "mir-admin"] }),
    );
    const state = JSON.parse(readFileSync(path.join(directory, ".telecodex", "recipes.json"), "utf8"));
    expect(state.runs["daily-diff-review"].projects["mir-admin"].lastSha).toBe("admin-new");
    expect(state.runs["daily-diff-review"].projects["mir-back"]).toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("retry required"));
  });

  it("emits bounded per-project machine results for a successful selected review", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "tc-webhook-result-"));
    writeFileSync(path.join(directory, "prompt.md"), "review");
    writeFileSync(path.join(directory, "recipes.json"), JSON.stringify({ recipes: [{
      id: "daily-diff-review", kind: "mircli-review", cwd: "/srv/mircli",
      worktreeRoot: "/cache", promptFile: "prompt.md",
    }] }));
    mocks.runReviewPortfolio.mockResolvedValue({ projects: [
      { name: "mir-back", sourcePath: "/srv/mircli/mir-back", status: "reviewed",
        headSha: "back-new", findings: [] },
      { name: "mir-admin", sourcePath: "/srv/mircli/mir-admin", status: "unchanged",
        headSha: "admin-new", findings: [] },
    ] });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message) => logs.push(String(message)));
    process.argv = ["node", "recipe-run.js", "daily-diff-review", "--projects", '["mir-back","mir-admin"]'];
    process.env.RECIPES_CONFIG = path.join(directory, "recipes.json");
    process.exitCode = 0;
    process.chdir(directory);

    await import("../src/recipe-run.js");
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("TELECODEX_GITLAB_REVIEW_RESULT="))).toBe(true));
    const marker = logs.find((line) => line.startsWith("TELECODEX_GITLAB_REVIEW_RESULT="))!;
    expect(JSON.parse(marker.split("=", 2)[1])).toEqual({ projects: [
      { name: "mir-back", status: "reviewed", findings: 0, freshFindings: 0 },
      { name: "mir-admin", status: "unchanged" },
    ] });
  });

  it("returns AI findings to the original webhook card instead of sending a full digest", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "tc-webhook-compact-"));
    writeFileSync(path.join(directory, "prompt.md"), "review");
    writeFileSync(path.join(directory, "recipes.json"), JSON.stringify({ recipes: [{
      id: "daily-diff-review", kind: "mircli-review", cwd: "/srv/mircli",
      worktreeRoot: "/cache", promptFile: "prompt.md", deliver: { chatId: -1001, messageThreadId: 7 },
    }] }));
    mocks.runReviewPortfolio.mockResolvedValue({ projects: [{
      name: "mir-back", sourcePath: "/srv/mircli/mir-back", status: "reviewed",
      baseSha: "a".repeat(40), headSha: "b".repeat(40), findings: [
        { severity: "high", priority: "P1", file: "x.ts", line: 7, category: "auth", description: "Missing auth" },
      ],
    }] });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message) => logs.push(String(message)));
    process.argv = ["node", "recipe-run.js", "daily-diff-review", "--projects", '["mir-back"]', "--webhook"];
    process.env.RECIPES_CONFIG = path.join(directory, "recipes.json");
    process.chdir(directory);
    await import("../src/recipe-run.js");
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("TELECODEX_GITLAB_REVIEW_RESULT="))).toBe(true));
    expect(mocks.deliverReviewDigest).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.scheduled).not.toHaveBeenCalled();
    const marker = JSON.parse(logs.find((line) => line.startsWith("TELECODEX_GITLAB_REVIEW_RESULT="))!.split("=", 2)[1]);
    expect(marker.projects[0].details.items[0].description).toBe("Missing auth");
    const state = JSON.parse(readFileSync(path.join(directory, ".telecodex", "recipes.json"), "utf8"));
    expect(state.pending).toBeUndefined();
  });

  it("automatically enqueues fresh scheduled findings with their reviewed SHA", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "tc-scheduled-pipeline-"));
    writeFileSync(path.join(directory, "prompt.md"), "review");
    writeFileSync(path.join(directory, "recipes.json"), JSON.stringify({ recipes: [{
      id: "daily-diff-review", kind: "mircli-review", cwd: "/srv/mircli", worktreeRoot: "/cache",
      promptFile: "prompt.md", deliver: { chatId: -1001, messageThreadId: 7 },
    }] }));
    const finding = { severity: "high", priority: "P1", file: "x.ts", line: 7, category: "auth", description: "Missing auth" };
    mocks.runReviewPortfolio.mockResolvedValue({ projects: [{ name: "mir-back", sourcePath: "/srv/mircli/mir-back",
      worktreePath: "/cache/mir-back", status: "reviewed", headSha: "b".repeat(40), findings: [finding],
    }] });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.argv = ["node", "recipe-run.js", "daily-diff-review"];
    process.env.RECIPES_CONFIG = path.join(directory, "recipes.json");
    process.chdir(directory);
    try {
      await import("../src/recipe-run.js");
      await vi.waitFor(() => expect(logs.some((line) => line.includes("1 reviewed"))).toBe(true));
      expect(mocks.scheduled).toHaveBeenCalledWith([{ source: { recipe: "daily-diff-review", project: "mir-back",
        cwd: "/cache/mir-back", headSha: "b".repeat(40) }, findings: [finding], baseSha: undefined }],
        { chatId: -1001, messageThreadId: 7 });
      expect(mocks.deliverReviewDigest).toHaveBeenCalledOnce();
    } finally {
      if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    }
  });
});
