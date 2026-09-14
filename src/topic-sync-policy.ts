import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface TopicSyncPolicy { mode: "all" | "selectedprojects" | "onrequest"; projects: string[] }
export function validateTopicSyncPolicy(value: TopicSyncPolicy): TopicSyncPolicy {
  if (!value || !["all", "selectedprojects", "onrequest"].includes(value.mode) || !Array.isArray(value.projects)
    || value.projects.length > 100 || value.projects.some(project => typeof project !== "string" || !path.isAbsolute(project) || project.length > 4096 || /[\r\n\0]/u.test(project))) throw new Error("Invalid topic sync policy");
  if (value.mode === "selectedprojects" && !value.projects.length) throw new Error("Select at least one absolute project path");
  return { mode: value.mode, projects: [...new Set(value.projects.map(project => path.resolve(project)))] };
}
export class TopicSyncPolicyStore {
  private policy: TopicSyncPolicy;
  constructor(private readonly file: string, fallback: TopicSyncPolicy) {
    this.policy = validateTopicSyncPolicy(fallback);
    try { this.policy = validateTopicSyncPolicy(JSON.parse(readFileSync(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  get(): TopicSyncPolicy { return structuredClone(this.policy); }
  set(policy: TopicSyncPolicy): void {
    const next = validateTopicSyncPolicy(policy);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.policy = next;
  }
}
export function matchesTopicSyncPolicy(policy: TopicSyncPolicy, cwd: string): boolean {
  if (policy.mode === "onrequest") return false;
  if (policy.mode === "all") return true;
  return policy.projects.some(project => {
    const relative = path.relative(path.resolve(project), path.resolve(cwd));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}
export function previewTopicSync(policy: TopicSyncPolicy, threads: { id: string; cwd: string }[], registry: { isThreadBoundInChat(id: string, chatId: number): boolean }, chatId: number): number {
  return threads.filter(thread => matchesTopicSyncPolicy(policy, thread.cwd) && !registry.isThreadBoundInChat(thread.id, chatId)).length;
}
