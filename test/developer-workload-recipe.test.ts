import { expect, it, vi } from "vitest";
import { runDeveloperWorkloadRecipe } from "../src/developer-workload-recipe.js";

const recipe = {
  id: "weekly-developer-workload",
  kind: "developer-workload" as const,
  cwd: "/srv/mircli",
  jiraClient: "/usr/bin/jira-client",
  capacityHours: 30,
  fromStatus: "In Progress",
  completionStatuses: ["For QA", "For Verification"],
  developerRoles: { Alice: ["frontend"], Bob: ["backend"], Anton: ["fullstack"] },
  deliver: { chatId: -100123, messageThreadId: 42 },
};

function response(issues: unknown[]) {
  return JSON.stringify({ total: issues.length, returned: issues.length, issues });
}

it("reports completed work, capacity and non-mutating allocation proposals", async () => {
  const execute = vi.fn(async (_command: string, args: string[]) => {
    const jql = args[1] ?? "";
    if (jql.includes("updated >=")) {
      return response([{ key: "MIR-1", summary: "Ready for QA", url: "https://jira/MIR-1", assignee: "Alice", status: "For QA", original_estimate_seconds: 3_600, status_transitions: [{ from_status: "In Progress", to_status: "For QA", at: "2026-09-20T10:00:00Z" }] }]);
    }
    if (jql.includes('status = "In Progress"')) {
      return response([
        { key: "MIR-2", summary: "Catalog", url: "https://jira/MIR-2", assignee: "Alice", status: "In Progress", original_estimate_seconds: 72_000, status_transitions: [] },
        { key: "MIR-3", summary: "Import", url: "https://jira/MIR-3", assignee: "Bob", status: "In Progress", original_estimate_seconds: 144_000, status_transitions: [] },
      ]);
    }
    return response([
      { key: "MIR-4", summary: "Unassigned", url: "https://jira/MIR-4", status: "To Do", original_estimate_seconds: 36_000, status_transitions: [] },
      { key: "MIR-5", summary: "Not started", url: "https://jira/MIR-5", assignee: "Bob", status: "To Do", original_estimate_seconds: 7_200, status_transitions: [] },
    ]);
  });
  const send = vi.fn(async () => undefined);

  await runDeveloperWorkloadRecipe(recipe, send, {
    now: new Date("2026-09-20T17:00:00Z"),
    execute,
  });

  expect(send).toHaveBeenCalledOnce();
  const report = send.mock.calls[0]?.[0] ?? "";
  expect(report).toContain("Нагрузка разработчиков");
  expect(report).toContain("<b>Alice</b> · 1 задач");
  expect(report).toContain("<b>Alice</b> · 20,0 ч · свободно 10,0 ч");
  expect(report).toContain("<b>Bob</b> · 40,0 ч · <b>перегрузка 10,0 ч</b>");
  expect(report).toContain('MIR-4');
  expect(report).toContain('MIR-5');
  expect(report).toContain("Предложения не меняют Jira");
  expect(execute).toHaveBeenCalledTimes(4);
  expect(execute.mock.calls.every(([, args]) => args[0] === "workload")).toBe(true);
});

it("routes tasks without a usable description to the full-stack analyst", async () => {
  const execute = vi.fn(async (_command: string, args: string[]) => {
    const jql = args[1] ?? "";
    if (jql.includes("updated >=")) return response([]);
    if (jql.includes('status = "In Progress"')) {
      return response([{ key: "MIR-2", summary: "Existing", url: "https://jira/MIR-2", assignee: "Alice", original_estimate_seconds: 3_600, description_length: 200 }]);
    }
    return response([{ key: "MIR-6", summary: "Investigate", url: "https://jira/MIR-6", original_estimate_seconds: 3_600, description_length: 0 }]);
  });
  const send = vi.fn(async () => undefined);

  await runDeveloperWorkloadRecipe(recipe, send, { now: new Date("2026-09-20T17:00:00Z"), execute });

  const report = send.mock.calls[0]?.[0] ?? "";
  expect(report).toContain("нужен анализ: Anton");
});
