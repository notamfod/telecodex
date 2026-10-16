import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { acquireRecipeRunLock } from "./recipe-run-lock.js";
import { isDeploySummaryRow, type DeploySummaryRow } from "./mircli-deploy-data.js";
type Ref = "main" | "production";
interface Target { chatId: number; messageThreadId: number }
export interface DeployViewRequest extends Target { messageId: number; ref: Ref }
interface Slot { ref: Ref; page: number; messageId: number; text: string; pinned: boolean }
interface State { version: 2; target: Target; messageId: number | null; pinned: boolean; text: string; view: Ref; deliveredView: Ref | null; retiredMessageIds: number[]; rows: DeploySummaryRow[] }
export type DeployTelegramCall = (method: string, body: Record<string, unknown>) => Promise<unknown>;
export class DeployViewContextError extends Error { constructor() { super("Deploy view context mismatch"); } }
export class DeployViewNotReadyError extends Error { constructor() { super("Deploy view not ready"); } }
export class MircliDeployTopic {
  private mutation = Promise.resolve();
  private closed = false;
  private constructor(private readonly options: { statePath: string; target: Target; call: DeployTelegramCall },
    private state: State, private readonly release: () => void) {}
  static async open(options: { statePath: string; target: Target; call: DeployTelegramCall }): Promise<MircliDeployTopic> {
    if (!path.isAbsolute(options.statePath) || !validTarget(options.target)) throw new Error("Invalid deploy topic configuration");
    await mkdir(path.dirname(options.statePath), { recursive: true, mode: 0o700 });
    const release = acquireRecipeRunLock(`${options.statePath}.lock`, { nonBlocking: true });
    try {
      let state: State;
      try { state = decode(JSON.parse(await readFile(options.statePath, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = { version: 2, target: options.target, messageId: null, pinned: false, text: "", view: "main", deliveredView: null, retiredMessageIds: [], rows: [] };
      }
      if (state.target.chatId !== options.target.chatId || state.target.messageThreadId !== options.target.messageThreadId) throw new Error("Deploy topic state target differs from configuration");
      return new MircliDeployTopic(options, state, release);
    } catch (error) { release(); throw error; }
  }
  rows(): DeploySummaryRow[] { return structuredClone(this.state.rows); }
  view(): Ref { return this.state.view; }
  messageId(): number | null { return this.state.messageId; }
  saveRows(rows: DeploySummaryRow[]): Promise<void> {
    return this.mutate(async () => {
      if (rows.length > 1000 || !rows.every(isDeploySummaryRow)) throw new Error("Invalid deploy summary rows");
      const previous = this.state.rows; this.state.rows = structuredClone(rows);
      try { await this.persist(); } catch (error) { this.state.rows = previous; throw error; }
    });
  }
  publish(ref: Ref, pages: readonly string[]): Promise<void> {
    return this.mutate(async () => {
      if (ref !== this.state.view) return; // A delayed poll must not undo a newer button selection.
      if (pages.length !== 1) throw new Error("Deploy summary must be one message");
      await this.publishNow(pages[0]);
    });
  }
  selectView(request: DeployViewRequest, html: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.state.messageId) throw new DeployViewNotReadyError();
      if (request.chatId !== this.state.target.chatId || request.messageThreadId !== this.state.target.messageThreadId
        || request.messageId !== this.state.messageId || !ref(request.ref)) throw new DeployViewContextError();
      const previous = this.state.view; this.state.view = request.ref;
      try { await this.persist(); } catch (error) { this.state.view = previous; throw error; }
      await this.publishNow(html);
    });
  }
  private async publishNow(html: string): Promise<void> {
    if (!html || html.length > 3900) throw new Error("Invalid deploy summary message");
    // Persist migration/selection before external writes, retaining the exact owned retired ids.
    await this.persist();
    if (!this.state.messageId) {
      const result = await this.options.call("sendMessage", { ...this.telegramText(html), message_thread_id: this.state.target.messageThreadId, disable_notification: true });
      if (!record(result) || !positive(result.message_id)) throw new Error("Telegram summary message id missing");
      this.state.messageId = result.message_id; this.state.text = html; this.state.deliveredView = this.state.view;
      await this.persist();
    }
    if (this.state.text !== html || this.state.deliveredView !== this.state.view) {
      await this.options.call("editMessageText", { ...this.telegramText(html), message_id: this.state.messageId });
      this.state.text = html; this.state.deliveredView = this.state.view; await this.persist();
    }
    if (!this.state.pinned) {
      await this.options.call("pinChatMessage", { chat_id: this.state.target.chatId, message_id: this.state.messageId, disable_notification: true });
      this.state.pinned = true; await this.persist();
    }
    while (this.state.retiredMessageIds.length) {
      await this.options.call("deleteMessage", { chat_id: this.state.target.chatId, message_id: this.state.retiredMessageIds[0] });
      this.state.retiredMessageIds.shift(); await this.persist();
    }
  }
  async close(): Promise<void> { this.closed = true; await this.mutation; this.release(); }
  private telegramText(text: string): Record<string, unknown> {
    return { chat_id: this.state.target.chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: this.state.view === "main" ? "✓ Dev" : "Dev", callback_data: "mdeploy:main" },
        { text: this.state.view === "production" ? "✓ Prod" : "Prod", callback_data: "mdeploy:production" }]] } };
  }
  private mutate(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Deploy topic closed"));
    const result = this.mutation.then(operation); this.mutation = result.catch(() => undefined); return result;
  }
  private async persist(): Promise<void> {
    const temporary = `${this.options.statePath}.tmp-${randomUUID()}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(this.state)}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.options.statePath);
      const directory = await open(path.dirname(this.options.statePath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}
export function deployTelegramCall(token: string, fetcher: typeof fetch = fetch): DeployTelegramCall {
  if (!token) throw new Error("Telegram token unavailable");
  return async (method, body) => {
    if (!["sendMessage", "editMessageText", "pinChatMessage", "deleteMessage"].includes(method)) throw new Error("Invalid deploy Telegram method");
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    const value: unknown = await response.json();
    if (record(value) && value.error_code === 400 && typeof value.description === "string"
      && ((method === "editMessageText" && value.description.includes("message is not modified"))
        || (method === "deleteMessage" && value.description.includes("message to delete not found")))) return true;
    if (!response.ok || !record(value) || value.ok !== true) throw new Error(`Telegram deploy ${method} failed (${response.status})`);
    return value.result;
  };
}
function decode(value: unknown): State {
  if (!record(value) || !validTarget(value.target) || !Array.isArray(value.rows) || value.rows.length > 1000 || !value.rows.every(isDeploySummaryRow)) throw new Error("Invalid deploy topic state");
  if (value.version === 2) {
    if (!(value.messageId === null || positive(value.messageId)) || typeof value.pinned !== "boolean"
      || typeof value.text !== "string" || value.text.length > 3900 || !ref(value.view)
      || !(value.deliveredView === null || ref(value.deliveredView)) || !Array.isArray(value.retiredMessageIds)
      || value.retiredMessageIds.length > 200 || !value.retiredMessageIds.every(positive)
      || (value.messageId !== null && value.retiredMessageIds.includes(value.messageId))
      || new Set(value.retiredMessageIds).size !== value.retiredMessageIds.length) throw new Error("Invalid deploy topic state");
    return value as unknown as State;
  }
  if (value.version !== 1 || !Array.isArray(value.slots) || value.slots.length > 200) throw new Error("Invalid deploy topic state");
  const slots = value.slots as unknown[];
  const keys = new Set<string>(); const ids = new Set<number>();
  for (const slot of slots) {
    if (!record(slot) || !ref(slot.ref) || !Number.isInteger(slot.page) || Number(slot.page) < 0 || Number(slot.page) >= 100
      || !positive(slot.messageId) || typeof slot.text !== "string" || slot.text.length > 3900 || typeof slot.pinned !== "boolean"
      || keys.has(`${slot.ref}:${slot.page}`) || ids.has(slot.messageId)) throw new Error("Invalid legacy deploy topic state");
    keys.add(`${slot.ref}:${slot.page}`); ids.add(slot.messageId);
  }
  const typed = slots as Slot[];
  const primary = typed.find(slot => slot.ref === "main" && slot.page === 0) ?? typed[0];
  return { version: 2, target: value.target, rows: value.rows, messageId: primary?.messageId ?? null, pinned: primary?.pinned ?? false,
    text: primary?.text ?? "", view: "main", deliveredView: null, retiredMessageIds: typed.filter(slot => slot !== primary).map(slot => slot.messageId) };
}
function ref(value: unknown): value is Ref { return value === "main" || value === "production"; }
function validTarget(value: unknown): value is Target { return record(value) && Number.isSafeInteger(value.chatId) && value.chatId !== 0 && positive(value.messageThreadId); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
