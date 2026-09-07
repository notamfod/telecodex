import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CodexPromptInput, CodexSessionCallbacks } from "./codex-session.js";
import { contextKeyFromMessage, type TelegramContextKey } from "./context-key.js";
import type {
  TelegramCoordinatorCodexAdapter,
  TelegramCoordinatorTurnCallbacks,
  TelegramCoordinatorTurnRequest,
} from "./telegram-job-coordinator.js";
import type { MaterializedAttachment, MaterializedPrompt, TelegramJob } from "./telegram-job-types.js";

interface SessionLike {
  getInfo(): { readonly threadId: string | null; readonly sandboxMode?: string };
  newThread(): Promise<{ readonly threadId: string | null }>;
  prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void>;
  recoverPrompt(turnId: string, callbacks: CodexSessionCallbacks): Promise<void>;
  forkThread(launchProfileId: string): Promise<{ readonly threadId: string | null }>;
  resumeThread(threadId: string): Promise<{ readonly threadId: string | null }>;
  abortTurn(threadId: string, turnId: string): Promise<void>;
  abort(): Promise<void>;
}

interface RegistryLike {
  getOrCreate(
    contextKey: TelegramContextKey,
    options?: { readonly deferThreadStart?: boolean },
  ): Promise<SessionLike>;
  updateMetadata(contextKey: TelegramContextKey, session: SessionLike): void;
  setContextDefaults(contextKey: TelegramContextKey, defaults: {
    readonly workspace: string; readonly launchProfileId?: string; readonly topicName?: string;
  }): void;
  listContexts(): readonly {
    readonly contextKey: TelegramContextKey;
    readonly threadId: string | null;
    readonly workspace?: string;
    readonly launchProfileId?: string;
  }[];
}

interface SessionAdapterStore {
  readSourcePayload(jobId: string): unknown | null;
}

export interface TelegramSessionCodexAdapterOptions {
  readonly store: SessionAdapterStore;
  readonly registry: RegistryLike;
  readonly materializationRoot: string;
}

export function createTelegramSessionCodexAdapter(
  options: TelegramSessionCodexAdapterOptions,
): TelegramCoordinatorCodexAdapter {
  const root = path.resolve(options.materializationRoot);
  const sessionsByThread = new Map<string, SessionLike>();
  const threadResolutions = new Map<TelegramContextKey, Promise<string>>();

  async function sessionForJob(jobId: string): Promise<{
    readonly contextKey: TelegramContextKey;
    readonly session: SessionLike;
  }> {
    const source = durableTopic(options.store.readSourcePayload(jobId));
    const contextKey = contextKeyFromMessage(
      source.chatId,
      source.messageThreadId === null ? undefined : source.messageThreadId,
    );
    applySessionDefaults(options.registry, contextKey, source.sessionDefaults);
    const session = await options.registry.getOrCreate(contextKey, { deferThreadStart: true });
    if (source.implementationHandoffProfileId && session.getInfo().sandboxMode === "read-only") {
      const forked = await session.forkThread(source.implementationHandoffProfileId);
      if (!forked.threadId) throw new Error("Writable Codex handoff thread was not created");
      options.registry.updateMetadata(contextKey, session);
    }
    const threadId = session.getInfo().threadId;
    if (threadId) sessionsByThread.set(threadId, session);
    return { contextKey, session };
  }

  async function resolveThread(job: TelegramJob): Promise<string> {
    const source = durableTopic(options.store.readSourcePayload(job.id));
    const contextKey = contextKeyFromMessage(
      source.chatId,
      source.messageThreadId === null ? undefined : source.messageThreadId,
    );
    const existing = threadResolutions.get(contextKey);
    if (existing) return existing;
    const resolution = (async () => {
      const { session } = await sessionForJob(job.id);
      let threadId = session.getInfo().threadId;
      if (!threadId) {
        threadId = (await session.newThread()).threadId;
        if (!threadId) throw new Error("Codex thread was not created");
        options.registry.updateMetadata(contextKey, session);
      }
      sessionsByThread.set(threadId, session);
      return threadId;
    })().finally(() => {
      if (threadResolutions.get(contextKey) === resolution) threadResolutions.delete(contextKey);
    });
    threadResolutions.set(contextKey, resolution);
    return resolution;
  }

  async function exactSession(request: TelegramCoordinatorTurnRequest): Promise<SessionLike> {
    const { contextKey, session } = await sessionForJob(request.jobId);
    if (session.getInfo().threadId === null) {
      const resumed = await session.resumeThread(request.threadId);
      if (resumed.threadId !== request.threadId) throw new Error("Codex thread identity changed");
      options.registry.updateMetadata(contextKey, session);
    }
    if (session.getInfo().threadId !== request.threadId) {
      throw new Error("Codex thread identity changed");
    }
    sessionsByThread.set(request.threadId, session);
    return session;
  }

  return {
    resolveThread,
    async startTurn(request) {
      const session = await exactSession(request);
      const turnCallbacks = durableTurnCallbacks(request.callbacks, root, request.jobId);
      try {
        await session.prompt(
          toPromptInput(request.prompt, root, request.jobId),
          turnCallbacks.callbacks,
        );
      } finally {
        turnCallbacks.finish();
      }
    },
    async recoverTurn(request, exactTurnId) {
      const session = await exactSession(request);
      const turnCallbacks = durableTurnCallbacks(request.callbacks, root, request.jobId);
      try {
        await session.recoverPrompt(
          exactTurnId,
          turnCallbacks.callbacks,
        );
      } finally {
        turnCallbacks.finish();
      }
    },
    async abortTurn({ threadId, turnId }) {
      let session = sessionsByThread.get(threadId);
      if (!session) {
        const context = options.registry.listContexts().find((candidate) => candidate.threadId === threadId);
        if (!context) throw new Error("Unknown Codex thread");
        session = await options.registry.getOrCreate(context.contextKey, { deferThreadStart: true });
      }
      if (session.getInfo().threadId !== threadId) throw new Error("Codex thread identity changed");
      await session.abortTurn(threadId, turnId);
    },
  };
}

function toPromptInput(prompt: MaterializedPrompt, root: string, jobId: string): CodexPromptInput {
  const images: string[] = [];
  const files: Array<{ readonly attachment: MaterializedAttachment; readonly absolutePath: string }> = [];
  for (const attachment of prompt.attachments) {
    const absolutePath = materializedPath(root, attachment.relativePath);
    if (attachment.kind === "photo") images.push(absolutePath);
    else files.push({ attachment, absolutePath });
  }
  const outbox = durableOutbox(root, jobId);
  const instructions = [
    ...(files.length ? [stagedFileInstructions(files)] : []),
    `If you create a file for the user, save or copy it directly into ${JSON.stringify(outbox.absolutePath)}. Files elsewhere are not delivered.`,
  ].join("\n\n");
  return {
    text: prompt.text,
    ...(images.length ? { imagePaths: images } : {}),
    stagedFileInstructions: instructions,
  };
}

function materializedPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\\") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid materialized attachment path");
  }
  const absolute = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error("Invalid materialized attachment path");
  return absolute;
}

function stagedFileInstructions(
  files: readonly { readonly attachment: MaterializedAttachment; readonly absolutePath: string }[],
): string {
  return [
    "The following Telegram attachments were durably staged. Inspect them only at these paths:",
    ...files.map(({ attachment, absolutePath }) =>
      `- ${JSON.stringify(attachment.name ?? attachment.id)}: ${JSON.stringify(absolutePath)}`),
  ].join("\n");
}

function toSessionCallbacks(
  callbacks: TelegramCoordinatorTurnCallbacks,
  root: string,
  jobId: string,
): CodexSessionCallbacks {
  let generatedImageOrdinal = 0;
  let activeAgentMessage: { readonly itemId: string; readonly phase?: string } | undefined;
  return {
    beforeDispatchWrite: callbacks.beforeDispatchWrite,
    onDispatchWritten: callbacks.onDispatchWritten,
    onStarted: callbacks.onStarted,
    onActivity: callbacks.onActivity,
    onTextDelta: (delta) => callbacks.onTextDelta(delta, activeAgentMessage),
    onAgentMessageStart: (message) => {
      activeAgentMessage = {
        itemId: message.itemId,
        ...(message.phase === undefined ? {} : { phase: message.phase }),
      };
    },
    onAgentMessageEnd: (message) => {
      callbacks.onAgentMessageEnd?.(message);
      if (activeAgentMessage?.itemId === message.itemId) activeAgentMessage = undefined;
    },
    onGeneratedImage: (image) => {
      const ordinal = generatedImageOrdinal++;
      const relativePath = image.path
        ? preserveGeneratedImage(root, jobId, image.path, ordinal)
        : image.base64
          ? preserveGeneratedImageBase64(root, jobId, image.base64, ordinal)
          : null;
      if (relativePath) callbacks.onOutputAttachment({ kind: "image", path: relativePath });
    },
    onTurnOutcome: callbacks.onTurnOutcome,
    onToolStart: () => {},
    onToolUpdate: () => {},
    onToolEnd: () => {},
    onAgentEnd: () => {},
  };
}

function durableTurnCallbacks(
  callbacks: TelegramCoordinatorTurnCallbacks,
  root: string,
  jobId: string,
): { readonly callbacks: CodexSessionCallbacks; readonly finish: () => void } {
  let outcome: { status: string; eventAt: number } | undefined;
  const emittedPaths = new Set<string>();
  const wrapped = toSessionCallbacks({
    ...callbacks,
    onOutputAttachment: (attachment) => {
      emittedPaths.add(attachment.path);
      callbacks.onOutputAttachment(attachment);
    },
    onTurnOutcome: (event) => { outcome = event; },
  }, root, jobId);
  return {
    callbacks: wrapped,
    finish: () => {
      for (const attachment of collectDurableOutbox(root, jobId)) {
        if (!emittedPaths.has(attachment.path)) callbacks.onOutputAttachment(attachment);
      }
      if (outcome) callbacks.onTurnOutcome(outcome);
    },
  };
}

function durableOutbox(root: string, jobId: string): { readonly relativePath: string; readonly absolutePath: string } {
  ensureDurableRoot(root);
  const jobDirectory = createHash("sha256").update(jobId).digest("hex").slice(0, 32);
  const relativePath = path.posix.join("outputs", jobDirectory, "artifacts");
  const absolutePath = materializedPath(root, relativePath);
  mkdirSync(absolutePath, { recursive: true, mode: 0o700 });
  chmodSync(absolutePath, 0o700);
  return { relativePath, absolutePath };
}

function ensureDurableRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root
    || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Unsafe materialization root");
  }
}

function collectDurableOutbox(
  root: string,
  jobId: string,
): Array<{ kind: "image" | "file"; path: string; name: string }> {
  const outbox = durableOutbox(root, jobId);
  const results: Array<{ kind: "image" | "file"; path: string; name: string }> = [];
  for (const name of readdirSync(outbox.absolutePath).sort()) {
    const absolutePath = path.join(outbox.absolutePath, name);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) continue;
    chmodSync(absolutePath, 0o600);
    const extension = path.extname(name).toLowerCase();
    results.push({
      kind: [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension) ? "image" : "file",
      path: path.posix.join(outbox.relativePath, name),
      name,
    });
  }
  return results;
}

function preserveGeneratedImage(
  root: string,
  jobId: string,
  sourcePath: string,
  ordinal: number,
): string | null {
  try {
    if (!path.isAbsolute(sourcePath)) return null;
    const stat = lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) return null;
    const realSource = realpathSync(sourcePath);
    const sourceDigest = createHash("sha256")
      .update(realSource).update("\0").update(String(ordinal)).digest("hex").slice(0, 32);
    const safeName = path.basename(realSource).replace(/[^A-Za-z0-9._-]/g, "_") || "generated-image";
    const outbox = durableOutbox(root, jobId);
    const relativePath = path.posix.join(outbox.relativePath, `${sourceDigest}-${safeName}`);
    const target = materializedPath(root, relativePath);
    copyFileSync(realSource, target);
    chmodSync(target, 0o600);
    return relativePath;
  } catch {
    return null;
  }
}

function preserveGeneratedImageBase64(
  root: string,
  jobId: string,
  encoded: string,
  ordinal: number,
): string | null {
  try {
    const value = encoded.replace(/^data:image\/png;base64,/, "");
    if (value.length === 0 || value.length > 70 * 1024 * 1024
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024
      || bytes.toString("base64") !== value) return null;
    const digest = createHash("sha256").update(bytes).update("\0").update(String(ordinal))
      .digest("hex").slice(0, 32);
    const outbox = durableOutbox(root, jobId);
    const relativePath = path.posix.join(outbox.relativePath, `${digest}-generated.png`);
    const target = materializedPath(root, relativePath);
    writeFileSync(target, bytes, { mode: 0o600 });
    chmodSync(target, 0o600);
    return relativePath;
  } catch {
    return null;
  }
}

function applySessionDefaults(
  registry: RegistryLike,
  contextKey: TelegramContextKey,
  defaults: ReturnType<typeof durableTopic>["sessionDefaults"],
): void {
  if (!defaults) return;
  const existing = registry.listContexts().find((candidate) => candidate.contextKey === contextKey);
  if (existing?.threadId) {
    if (existing.workspace !== defaults.workspace || existing.launchProfileId !== defaults.launchProfileId) {
      throw new Error("Durable Telegram session context conflicts with an existing Codex thread");
    }
    return;
  }
  registry.setContextDefaults(contextKey, defaults);
}

function durableTopic(value: unknown): {
  readonly chatId: number;
  readonly messageThreadId: number | null;
  readonly sessionDefaults?: { readonly workspace: string; readonly launchProfileId: string; readonly topicName?: string };
  readonly implementationHandoffProfileId?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed Telegram work source");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.chatId !== "number" || !Number.isSafeInteger(source.chatId)
    || (source.messageThreadId !== null && (typeof source.messageThreadId !== "number"
      || !Number.isSafeInteger(source.messageThreadId) || source.messageThreadId < 1))) {
    throw new Error("Malformed Telegram work source");
  }
  const defaults = source.sessionDefaults;
  if (defaults !== undefined && (typeof defaults !== "object" || defaults === null || Array.isArray(defaults))) {
    throw new Error("Malformed Telegram work source");
  }
  const session = defaults as Record<string, unknown> | undefined;
  if (session && (typeof session.workspace !== "string" || !path.isAbsolute(session.workspace)
    || typeof session.launchProfileId !== "string" || session.launchProfileId.length === 0
    || !(session.topicName === undefined || typeof session.topicName === "string"))) {
    throw new Error("Malformed Telegram work source");
  }
  return {
    chatId: targetContext(source).chatId,
    messageThreadId: targetContext(source).messageThreadId,
    ...(session ? { sessionDefaults: {
      workspace: session.workspace as string,
      launchProfileId: session.launchProfileId as string,
      ...(session.topicName === undefined ? {} : { topicName: session.topicName as string }),
    } } : {}),
    ...(typeof source.implementationHandoffProfileId === "string"
      && source.implementationHandoffProfileId.length > 0
      ? { implementationHandoffProfileId: source.implementationHandoffProfileId }
      : {}),
  };
}

function targetContext(source: Record<string, unknown>): {
  readonly chatId: number;
  readonly messageThreadId: number | null;
} {
  const target = source.targetContext;
  if (target === undefined) {
    return { chatId: source.chatId as number, messageThreadId: source.messageThreadId as number | null };
  }
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new Error("Malformed Telegram work source");
  }
  const value = target as Record<string, unknown>;
  if (typeof value.chatId !== "number" || !Number.isSafeInteger(value.chatId) || value.chatId === 0
    || typeof value.messageThreadId !== "number" || !Number.isSafeInteger(value.messageThreadId)
    || value.messageThreadId < 1) {
    throw new Error("Malformed Telegram work source");
  }
  if (value.chatId !== source.chatId) throw new Error("Malformed Telegram work source");
  return { chatId: value.chatId, messageThreadId: value.messageThreadId };
}
