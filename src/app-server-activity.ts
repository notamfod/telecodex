import type { JobActivity } from "./telegram-job-types.js";

export interface AppServerActivityMapping {
  activity: JobActivity;
  sample: boolean;
}

const modelDeltaMethods = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "thread/tokenUsage/updated",
]);

const toolProgressMethods = new Set([
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "command/exec/outputDelta",
  "process/outputDelta",
]);

const modelItemTypes = new Set(["agentMessage", "reasoning", "plan"]);
const toolItemTypes = new Set([
  "commandExecution",
  "fileChange",
  "webSearch",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "dynamicToolCall",
]);
const subagentItemTypes = new Set(["collabAgentToolCall", "subAgentActivity"]);

export function mapAppServerActivity(
  method: string,
  params: Record<string, unknown>,
): AppServerActivityMapping | undefined {
  if (modelDeltaMethods.has(method)) {
    return { activity: "model", sample: true };
  }
  if (method === "item/plan/delta") return { activity: "model", sample: true };
  if (toolProgressMethods.has(method)) return { activity: "tool", sample: true };
  if (method === "process/exited") return { activity: "tool", sample: false };
  if (method === "turn/plan/updated") return { activity: "model", sample: false };
  if (method === "turn/started") return { activity: "model", sample: false };
  if (method === "turn/completed" || method === "error") {
    return { activity: "unknown", sample: false };
  }

  if (method === "thread/status/changed") {
    const status = record(params.status);
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    return {
      activity: flags.some(
        (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
      )
        ? "waiting"
        : "unknown",
      sample: false,
    };
  }

  if (method !== "item/started" && method !== "item/completed") return undefined;
  const itemType = stringValue(record(params.item).type);
  if (modelItemTypes.has(itemType)) return { activity: "model", sample: false };
  if (toolItemTypes.has(itemType)) return { activity: "tool", sample: false };
  if (subagentItemTypes.has(itemType)) return { activity: "subagent", sample: false };
  if (itemType === "sleep") return { activity: "waiting", sample: false };
  return { activity: "unknown", sample: false };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
