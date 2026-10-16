import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  editGitlabReviewCard,
  loadDailyDiffReviewTarget,
  loadGitlabReviewWebhookConfig,
  runDailyDiffReview,
} from "../src/gitlab-review-webhook-cli.js";
import { gitlabReviewKeyboard } from "../src/gitlab-review-links.js";

const SIGNING_TOKEN = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;

describe("GitLab review webhook CLI", () => {
  it("edits the exact Telegram card without retaining the launch button", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await editGitlabReviewCard({ chatId: -1001, messageThreadId: 7 }, 501, "safe html", {
      token: "bot-token",
      fetch: fetcher as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: -1001,
      message_id: 501,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text: "safe html",
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("accepts Telegram's idempotent not-modified response after a persistence retry", async () => {
    await expect(editGitlabReviewCard({ chatId: -1001, messageThreadId: 7 }, 501, "same html", {
      token: "bot-token",
      fetch: async () => new Response(JSON.stringify({
        ok: false,
        description: "Bad Request: message is not modified",
      }), { status: 400 }),
    })).resolves.toBeUndefined();
  });

  it("keeps diff and GitLab links on edited cards after consuming the launch action", async () => {
    const event = { projectPath: "group/app", after: "b".repeat(40) };
    const keyboard = gitlabReviewKeyboard(event, "1".repeat(32), {
      gitlabUrl: "https://git.example.test", miniAppLaunchUrl: "https://t.me/ExampleBot/app",
    }, false);
    let body: Record<string, unknown> = {};
    await editGitlabReviewCard({ chatId: -1001, messageThreadId: 7 }, 501, "result", {
      token: "bot-token", replyMarkup: keyboard,
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response("{}"); },
    });
    expect(body.reply_markup).toEqual(keyboard);
    expect(JSON.stringify(body.reply_markup)).not.toContain("greview:");
  });

  it("aborts a hung Telegram edit within its bounded deadline", async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    ));
    await expect(editGitlabReviewCard({ chatId: -1001, messageThreadId: 7 }, 501, "html", {
      token: "bot-token",
      fetch: fetcher as typeof fetch,
      timeoutMs: 10,
    })).rejects.toThrow("aborted");
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("loads the exact manual review card target before accepting hooks", () => {
    const target = loadDailyDiffReviewTarget(JSON.stringify({ recipes: [{
      id: "daily-diff-review",
      kind: "mircli-review",
      cwd: "/opt/telecodex",
      worktreeRoot: "/tmp/worktrees",
      promptFile: "/opt/prompt.md",
      deliver: { chatId: -1003981282865, messageThreadId: 3861 },
    }] }));
    expect(target).toEqual({ chatId: -1003981282865, messageThreadId: 3861 });
    expect(() => loadDailyDiffReviewTarget(JSON.stringify({ recipes: [] }))).toThrow("daily-diff-review");
    expect(() => loadDailyDiffReviewTarget(JSON.stringify({ recipes: [{
      id: "daily-diff-review", kind: "mircli-review", cwd: "/x", worktreeRoot: "/w", promptFile: "/p",
    }] }))).toThrow("deliver target");
  });

  it("runs main when the executable TypeScript entrypoint is reached through a symlink", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-webhook-cli-link-"));
    const linkedEntrypoint = path.join(directory, "gitlab-review-webhook-cli.ts");
    symlinkSync(path.resolve("src/gitlab-review-webhook-cli.ts"), linkedEntrypoint);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GITLAB_REVIEW_")),
    );
    try {
      const result = spawnSync(process.execPath, [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        linkedEntrypoint,
      ], { cwd: process.cwd(), env, encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GitLab review webhook failed to start");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses strict environment configuration with safe defaults", () => {
    const config = loadGitlabReviewWebhookConfig({
      GITLAB_REVIEW_WEBHOOK_SECRET: "s".repeat(32),
      GITLAB_REVIEW_WEBHOOK_SIGNING_TOKEN: SIGNING_TOKEN,
      GITLAB_REVIEW_WEBHOOK_PROJECTS: "[\"group/project\"]",
      GITLAB_REVIEW_WEBHOOK_PROJECT_IDS: "{\"group/project\":42}",
      GITLAB_REVIEW_WEBHOOK_DEBOUNCE_MS: "1500",
      GITLAB_REVIEW_WEBHOOK_STATE_PATH: "/var/lib/telecodex/gitlab-review.json",
      GITLAB_REVIEW_RUNNER_CWD: "/opt/telecodex",
      GITLAB_REVIEW_RUNNER_PATH: "/opt/releases/telecodex/dist/recipe-run.js",
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8790,
      projects: ["group/project"],
      projectIds: { "group/project": 42 },
      signingToken: SIGNING_TOKEN,
      debounceMs: 1500,
      statePath: "/var/lib/telecodex/gitlab-review.json",
      runnerCwd: "/opt/telecodex",
      runnerPath: "/opt/releases/telecodex/dist/recipe-run.js",
    });
  });

  it("rejects unsafe or ambiguous environment values", () => {
    const base = {
      GITLAB_REVIEW_WEBHOOK_SECRET: "s".repeat(32),
      GITLAB_REVIEW_WEBHOOK_SIGNING_TOKEN: SIGNING_TOKEN,
      GITLAB_REVIEW_WEBHOOK_PROJECTS: "[\"group/project\"]",
      GITLAB_REVIEW_WEBHOOK_PROJECT_IDS: "{\"group/project\":42}",
      GITLAB_REVIEW_WEBHOOK_STATE_PATH: "/var/lib/queue.json",
      GITLAB_REVIEW_RUNNER_CWD: "/opt/telecodex",
      GITLAB_REVIEW_RUNNER_PATH: "/opt/telecodex/dist/recipe-run.js",
    };
    expect(() => loadGitlabReviewWebhookConfig({ ...base, GITLAB_REVIEW_WEBHOOK_SECRET: "short" }))
      .toThrow("at least 32");
    expect(() => loadGitlabReviewWebhookConfig({ ...base, GITLAB_REVIEW_WEBHOOK_PROJECTS: "[]" }))
      .toThrow("non-empty JSON array");
    expect(() => loadGitlabReviewWebhookConfig({ ...base, GITLAB_REVIEW_WEBHOOK_STATE_PATH: "queue.json" }))
      .toThrow("absolute");
    expect(() => loadGitlabReviewWebhookConfig({ ...base, GITLAB_REVIEW_RUNNER_PATH: "dist/recipe-run.js" }))
      .toThrow("absolute");
    expect(() => loadGitlabReviewWebhookConfig({
      ...base,
      GITLAB_REVIEW_RUNNER_PATH: "/opt/releases/../telecodex/dist/recipe-run.js",
    })).toThrow("absolute normalized path");
    expect(() => loadGitlabReviewWebhookConfig({
      ...base,
      GITLAB_REVIEW_WEBHOOK_SIGNING_TOKEN: undefined,
    })).toThrow("SIGNING_TOKEN is required");
    expect(() => loadGitlabReviewWebhookConfig({
      ...base,
      GITLAB_REVIEW_WEBHOOK_SIGNING_TOKEN: "whsec_not-base64",
    })).toThrow("exactly 32 bytes");
    expect(() => loadGitlabReviewWebhookConfig({
      ...base,
      GITLAB_REVIEW_WEBHOOK_PROJECT_IDS: undefined,
    })).toThrow("PROJECT_IDS is required");
    expect(() => loadGitlabReviewWebhookConfig({
      ...base,
      GITLAB_REVIEW_WEBHOOK_PROJECTS: "[\"group/project\",\"group/second\"]",
      GITLAB_REVIEW_WEBHOOK_PROJECT_IDS: "{\"group/project\":42}",
    })).toThrow("exactly match");
    expect(() => loadGitlabReviewWebhookConfig({
      ...base,
      GITLAB_REVIEW_WEBHOOK_PROJECT_IDS: "{\"group/project\":42,\"group/extra\":99}",
    })).toThrow("exactly match");
    expect(() => loadGitlabReviewWebhookConfig({
      ...base,
      GITLAB_REVIEW_WEBHOOK_PROJECT_IDS: "{\"group/project\":0}",
    })).toThrow("invalid project id");
  });

  it("runs only the static review recipe without a shell and bounds output", async () => {
    const marker = JSON.stringify({ projects: [
      { name: "mir-back", status: "reviewed", findings: 0, freshFindings: 0 },
      { name: "mir-catalog-go", status: "unchanged" },
    ] });
    const runProcess = vi.fn(async () => ({
      stdout: `review output\nTELECODEX_GITLAB_REVIEW_RESULT=${marker}\n`,
      stderr: "warning output",
    }));
    const log = vi.fn();
    const result = await runDailyDiffReview({
      runnerCwd: "/opt/telecodex",
      runnerPath: "/opt/telecodex/dist/recipe-run.js",
      projects: ["mircli-ru/apps/mir-back", "mircli-ru/apps/mir-catalog-go"],
    }, [
      { projectPath: "mircli-ru/apps/mir-catalog-go", dedupId: "push:catalog" },
      { projectPath: "mircli-ru/apps/mir-back", dedupId: "push:back" },
    ], {
      runProcess,
      log,
    });

    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({
      file: process.execPath,
      args: [
        path.resolve("/opt/telecodex/dist/recipe-run.js"),
        "daily-diff-review",
        "--projects",
        JSON.stringify(["mir-back", "mir-catalog-go"]),
        "--webhook",
      ],
      cwd: "/opt/telecodex",
      timeoutMs: 3 * 60 * 60 * 1000,
      maxOutputBytes: 256 * 1024,
    }));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^GitLab review runner completed/));
    expect(log.mock.calls.flat().join(" ")).not.toContain("review output");
    expect(log.mock.calls.flat().join(" ")).not.toContain("warning output");
    expect(result).toEqual({
      "push:catalog": { outcome: "unchanged" },
      "push:back": { outcome: "reviewed", findings: 0, freshFindings: 0 },
    });
  });

  it("falls back to generic completion for a missing or malformed result marker", async () => {
    const log = vi.fn();
    const result = await runDailyDiffReview({
      runnerCwd: "/opt/telecodex",
      runnerPath: "/opt/telecodex/dist/recipe-run.js",
      projects: ["group/project"],
    }, [{ projectPath: "group/project", dedupId: "push:one" }], {
      runProcess: async () => ({ stdout: "TELECODEX_GITLAB_REVIEW_RESULT={bad", stderr: "" }),
      log,
    });
    expect(result).toEqual({});
    expect(log).toHaveBeenCalledWith("GitLab review runner result marker invalid");
  });

  it("preserves bounded AI details from runner markers and rejects malformed agent output", async () => {
    const details = { baseSha: "a".repeat(40), headSha: "b".repeat(40), items: [
      { priority: "P1", file: "src/auth.ts", line: 7, description: "User input is unchecked" },
    ] };
    const config = { runnerCwd: "/opt/app", runnerPath: "/opt/app/dist/recipe-run.js", projects: ["group/app"] };
    const events = [{ projectPath: "group/app", dedupId: "push:one" }];
    const marker = (extra: unknown) => ({ stdout: `TELECODEX_GITLAB_REVIEW_RESULT=${JSON.stringify({ projects: [
      { name: "app", status: "reviewed", findings: 1, freshFindings: 1, details: extra },
    ] })}`, stderr: "" });
    expect(await runDailyDiffReview(config, events, { runProcess: async () => marker(details), log: () => {} }))
      .toEqual({ "push:one": { outcome: "reviewed", findings: 1, freshFindings: 1, details } });
    expect(await runDailyDiffReview(config, events, {
      runProcess: async () => marker({ ...details, headSha: "main" }), log: () => {},
    })).toEqual({});
  });
});
