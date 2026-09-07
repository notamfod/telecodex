import type { HostThreadView, WaitingOn } from "./status-board.js";

/** Loaded threads are the only ones that can be running, so this stays small. */
const MAX_LOADED_THREADS = 100;
const HOST_REQUEST_TIMEOUT_MS = 500;
const HOST_READ_CONCURRENCY = 20;

export interface HostThreadClient {
  request<T>(method: string, params?: unknown, options?: { readonly timeoutMs?: number }): Promise<T>;
}

/**
 * Remembers when each thread was first seen working.
 *
 * A `Thread` carries no "this turn started at", and `updatedAt` moves with
 * every item, so the only honest elapsed time is the one we measure ourselves.
 * A thread that goes idle is dropped, so its next turn is timed from scratch.
 */
export function trackActiveSince(
  previous: ReadonlyMap<string, number>,
  threads: Array<{ id: string; active: boolean }>,
  now: number,
): Map<string, number> {
  const tracked = new Map<string, number>();
  for (const thread of threads) {
    if (!thread.active) continue;
    tracked.set(thread.id, previous.get(thread.id) ?? now);
  }
  return tracked;
}

export async function listHostThreads(
  client: HostThreadClient,
  options: { now: number; activeSince: ReadonlyMap<string, number>; limit?: number },
): Promise<{ threads: HostThreadView[]; activeSince: Map<string, number> }> {
  const loaded = await client.request<{ data: string[] }>("thread/loaded/list", {
    limit: options.limit ?? MAX_LOADED_THREADS,
  }, { timeoutMs: HOST_REQUEST_TIMEOUT_MS });

  const threadIds = (loaded.data ?? []).slice(0, options.limit ?? MAX_LOADED_THREADS);
  const results: Array<HostThreadView | undefined> = new Array(threadIds.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(HOST_READ_CONCURRENCY, threadIds.length) },
    async () => {
      while (cursor < threadIds.length) {
        const index = cursor++;
        const threadId = threadIds[index]!;
        try {
          const response = await client.request<{ thread?: unknown }>(
            "thread/read",
            { threadId },
            { timeoutMs: HOST_REQUEST_TIMEOUT_MS },
          );
          results[index] = toView(asRecord(response.thread ?? response), threadId, options);
        } catch {
          // One unreadable thread must not blank out the whole board.
        }
      }
    },
  ));
  const threads = results.filter((thread): thread is HostThreadView => thread !== undefined);

  const activeSince = trackActiveSince(options.activeSince, threads, options.now);
  return {
    threads: threads.map((thread) => ({
      ...thread,
      since: activeSince.get(thread.id) ?? options.now,
    })),
    activeSince,
  };
}

function toView(
  thread: Record<string, unknown>,
  threadId: string,
  options: { now: number },
): HostThreadView {
  const status = asRecord(thread.status);
  const subAgent = asRecord(asRecord(thread.source).subAgent).thread_spawn;
  const spawn = asRecord(subAgent);

  return {
    id: readString(thread, "id") ?? threadId,
    // A subagent's first message is whatever its parent handed it, usually a
    // wall of diff. The path it was spawned under is the task it was given.
    label: readString(thread, "name")
      || agentTask(spawn)
      || readString(thread, "preview")
      || `Тред ${threadId.slice(0, 8)}`,
    workspace: readString(thread, "cwd") ?? "",
    source: sourceLabel(thread.source),
    active: readString(status, "type") === "active",
    waitingOn: waitingFlag(status.activeFlags),
    parentThreadId: readString(spawn, "parent_thread_id")
      ?? readString(thread, "parentThreadId"),
    agentNickname: readString(spawn, "agent_nickname")
      ?? readString(thread, "agentNickname"),
    since: options.now,
  };
}

function agentTask(spawn: Record<string, unknown>): string | undefined {
  const agentPath = readString(spawn, "agent_path");
  return agentPath?.split("/").filter(Boolean).at(-1);
}

function waitingFlag(flags: unknown): WaitingOn | undefined {
  if (!Array.isArray(flags)) return undefined;
  if (flags.includes("waitingOnApproval")) return "approval";
  if (flags.includes("waitingOnUserInput")) return "input";
  return undefined;
}

/** Where a thread is being driven from, in the words the operator uses. */
function sourceLabel(source: unknown): string {
  if (typeof source === "string") {
    return source === "appServer" ? "app-server" : source;
  }
  const record = asRecord(source);
  if (record.subAgent !== undefined) return "подагент";
  const custom = readString(record, "custom");
  if (custom === "telecodex") return "телеграм";
  return custom ?? "?";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}
