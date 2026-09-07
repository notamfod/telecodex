export type TelegramExactTurnInspection =
  | { readonly state: "active" | "completed" | "failed" | "absent" | "ambiguous" }
  | { readonly state: "unavailable"; readonly reasonCode: string };

export interface TelegramExactTurnReader {
  request(method: string, params: unknown): Promise<unknown>;
}

/** Read-only exact identity check. Recovery policy remains in the reconciler. */
export async function inspectTelegramExactTurn(
  client: TelegramExactTurnReader,
  input: { readonly threadId: string; readonly turnId: string },
): Promise<TelegramExactTurnInspection> {
  const threadId = bounded(input.threadId, "threadId");
  const turnId = bounded(input.turnId, "turnId");
  const raw = await client.request("thread/read", { threadId, includeTurns: true });
  let turns: Array<{ id: string; status: string }>;
  try {
    const response = record(raw);
    const thread = record(response?.thread);
    if (!thread || thread.id !== threadId || !Array.isArray(thread.turns)) invalid();
    turns = thread.turns.map((value) => {
      const turn = record(value);
      if (!turn) invalid();
      return { id: bounded(turn.id, "turn id"), status: bounded(turn.status, "turn status") };
    });
  } catch { invalid(); }
  const exact = turns.filter((turn) => turn.id === turnId);
  if (exact.length === 0) return { state: "absent" };
  if (exact.length !== 1) return { state: "ambiguous" };
  if (exact[0]!.status === "inProgress") return { state: "active" };
  if (exact[0]!.status === "completed") return { state: "completed" };
  if (["failed", "interrupted", "cancelled", "aborted"].includes(exact[0]!.status)) {
    return { state: "failed" };
  }
  return { state: "ambiguous" };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function bounded(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function invalid(): never { throw new Error("Invalid thread/read response"); }
