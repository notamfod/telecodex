import { expect, it, vi } from "vitest";
import { parsePipelineEvents, runPipelineEvents } from "../src/review-pipeline-events.js";

it("reviews each selected notification at its SHA without advancing the scheduled pointer", async () => {
  const events = parsePipelineEvents(JSON.stringify([
    { projectPath: "group/mir-back", after: "b".repeat(40), before: "a".repeat(40) },
    { projectPath: "group/mir-back", after: "c".repeat(40), before: "b".repeat(40) },
  ]));
  const review = vi.fn(async () => [{ severity: "medium" as const, file: "x.ts", category: "race", description: "late result" }]);
  const enqueue = vi.fn();
  const results = await runPipelineEvents({ id: "daily", kind: "mircli-review", cwd: "/repos",
    worktreeRoot: "/cache", promptFile: "/prompt" }, events, "review", {
    prepare: async ({ name, sourcePath }) => ({ name, sourcePath, worktreePath: "/prepared", headSha: "d".repeat(40) }),
    snapshot: async (_cwd, sha) => `/pinned/${sha}`,
    git: async (_cwd, args) => args.includes("--name-only") ? "x.ts\0" : "",
    reviewChunk: review, enqueue,
  });
  expect(review.mock.calls.map((args) => args[0].headSha)).toEqual(["b".repeat(40), "c".repeat(40)]);
  expect(enqueue.mock.calls.map((args) => args[0].headSha)).toEqual(["b".repeat(40), "c".repeat(40)]);
  expect(results).toHaveLength(2);
});

it.each(['[{"projectPath":"../mir-back","after":"bad"}]', '[]', '[null]'])("rejects unsafe pipeline events %s", (raw) => {
  expect(() => parsePipelineEvents(raw)).toThrow();
});
