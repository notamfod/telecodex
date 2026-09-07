import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  AcceptUpdateResult,
  NewDeliveryPart,
  SqliteTelegramJobStore,
} from "./telegram-job-store.js";
import {
  TELEGRAM_STATUS_ANCHOR_PART_KEY,
  type MaterializedAttachment,
  type MaterializedPrompt,
  type MaterializationFailureCode,
  type TelegramAttachmentRef,
  type TelegramJob,
} from "./telegram-job-types.js";

export type TelegramWorkKind =
  | "text"
  | "voice"
  | "audio"
  | "photo"
  | "document"
  | "command"
  | "confirmation"
  | "retry";

export interface TelegramWorkSource {
  readonly botId: string;
  readonly updateId: number;
  readonly chatId: number;
  readonly messageThreadId: number | null;
  readonly messageId: number;
  readonly kind: TelegramWorkKind;
  readonly text: string | null;
  readonly attachment: TelegramAttachmentRef | null;
  readonly retryOfJobId: string | null;
  /** Durable execution/delivery destination when work is launched from a control topic. */
  readonly targetContext?: TelegramWorkTargetContext;
  readonly targetProvision?: TelegramWorkTargetProvision;
  readonly sessionDefaults?: TelegramWorkSessionDefaults;
  readonly implementationHandoffProfileId?: string;
  readonly completion?: TelegramWorkCompletion;
}

export interface TelegramWorkCompletion {
  readonly kind: "inbox_ticket";
  readonly ticketId: number;
}

export interface TelegramWorkTargetContext {
  readonly chatId: number;
  readonly messageThreadId: number;
}

export interface TelegramWorkTargetProvision {
  readonly kind: "forum_topic";
  readonly topicName: string;
  readonly state: "planned" | "in_flight" | "complete";
}

export interface TelegramWorkSessionDefaults {
  readonly workspace: string;
  readonly launchProfileId: string;
  readonly topicName?: string;
}

interface IngressStore {
  acceptUpdate: SqliteTelegramJobStore["acceptUpdate"];
  acceptRetryUpdate?: SqliteTelegramJobStore["acceptRetryUpdate"];
  get: SqliteTelegramJobStore["get"];
  getBySourceKey: SqliteTelegramJobStore["getBySourceKey"];
  readSourcePayload: SqliteTelegramJobStore["readSourcePayload"];
  transition: SqliteTelegramJobStore["transition"];
}

export interface TelegramJobIngressOptions {
  readonly store: IngressStore;
  readonly materializationRoot: string;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly materializationTimeoutMs?: number;
  readonly downloadAttachment: (attachment: TelegramAttachmentRef) => Promise<Uint8Array>;
  readonly transcribeAttachment?: (input: {
    readonly absolutePath: string;
    readonly attachment: TelegramAttachmentRef;
  }) => Promise<string>;
}

export class TelegramMaterializationError extends Error {
  readonly name = "TelegramMaterializationError";

  constructor(readonly code: MaterializationFailureCode) {
    super("Telegram attachment materialization failed");
  }
}

export class TelegramJobIngress {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly inFlight = new Map<string, Promise<MaterializedPrompt>>();
  private readonly materializationTimeoutMs: number;

  constructor(private readonly options: TelegramJobIngressOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.materializationTimeoutMs = positiveInteger(
      options.materializationTimeoutMs ?? 60_000,
      "materializationTimeoutMs",
    );
  }

  accept(input: TelegramWorkSource): AcceptUpdateResult {
    return this.acceptInternal(input);
  }

  acceptRetry(input: TelegramWorkSource, expectedParentVersion: number): AcceptUpdateResult {
    if (!Number.isSafeInteger(expectedParentVersion) || expectedParentVersion < 1) {
      throw new Error("Invalid Telegram retry parent version");
    }
    return this.acceptInternal(input, expectedParentVersion);
  }

  private acceptInternal(
    input: TelegramWorkSource,
    expectedParentVersion?: number,
  ): AcceptUpdateResult {
    const source = normalizeSource(input);
    const existing = this.options.store.getBySourceKey({
      botId: source.botId,
      updateId: source.updateId,
    });
    if (existing) return { created: false, job: existing };
    if (source.retryOfJobId !== null && !this.options.store.get(source.retryOfJobId)) {
      throw new Error("Invalid Telegram work source");
    }

    const acceptedAt = utcMilliseconds(this.now());
    const jobId = boundedId(this.createId());
    const job = initialJob(jobId, source, acceptedAt);
    const anchor = statusAnchor(job, source);
    const accepted = {
      job,
      sourcePayload: source,
      eventId: boundedId(this.createId()),
      initialDeliveries: [anchor],
    };
    if (expectedParentVersion !== undefined) {
      if (source.retryOfJobId === null || !this.options.store.acceptRetryUpdate) {
        throw new Error("Telegram retry reservation is unavailable");
      }
      return this.options.store.acceptRetryUpdate({
        ...accepted,
        parentJobId: source.retryOfJobId,
        expectedParentVersion,
      });
    }
    return this.options.store.acceptUpdate(accepted);
  }

  materialize(jobId: string): Promise<MaterializedPrompt> {
    const boundedJobId = boundedId(jobId);
    const existing = this.inFlight.get(boundedJobId);
    if (existing) return existing;
    const materialization = this.performMaterialization(boundedJobId);
    this.inFlight.set(boundedJobId, materialization);
    void materialization.finally(() => {
      if (this.inFlight.get(boundedJobId) === materialization) this.inFlight.delete(boundedJobId);
    }).catch(() => {});
    return materialization;
  }

  private async performMaterialization(jobId: string): Promise<MaterializedPrompt> {
    const job = this.options.store.get(jobId);
    if (!job) throw new Error("Unknown Telegram job");
    if (job.materializedPrompt) return structuredClone(job.materializedPrompt);
    const source = normalizeSource(this.options.store.readSourcePayload(jobId));
    if (source.botId !== job.source.botId || source.updateId !== job.source.updateId) {
      throw new Error("Malformed Telegram work source");
    }

    let stage: MaterializationFailureCode = "staging_failed";
    const candidatePaths: string[] = [];
    try {
      const materializedAttachments: MaterializedAttachment[] = [];
      let transcript: string | null = null;
      if (source.attachment) {
        const target = this.prepareTarget(
          job.id,
          source.attachment,
          boundedId(this.createId()),
        );
        stage = "download_failed";
        const bytes = await withinMaterializationDeadline(
          this.options.downloadAttachment(source.attachment),
          this.materializationTimeoutMs,
        );
        if (!(bytes instanceof Uint8Array)) throw new Error("Invalid attachment bytes");
        stage = "staging_failed";
        writePrivateFile(target.absolutePath, bytes);
        candidatePaths.push(target.absolutePath);
        materializedAttachments.push({
          id: source.attachment.id,
          kind: source.attachment.kind,
          relativePath: target.relativePath,
          ...(source.attachment.name === undefined ? {} : { name: source.attachment.name }),
          ...(source.attachment.mimeType === undefined ? {} : { mimeType: source.attachment.mimeType }),
        });
        if (source.attachment.kind === "voice" || source.attachment.kind === "audio") {
          stage = "transcription_failed";
          if (!this.options.transcribeAttachment) throw new Error("Transcription unavailable");
          transcript = materializedText(await withinMaterializationDeadline(
            this.options.transcribeAttachment({
              absolutePath: target.absolutePath,
              attachment: source.attachment,
            }),
            this.materializationTimeoutMs,
          ));
        }
      }
      const prompt: MaterializedPrompt = {
        text: [source.text, transcript].filter((value): value is string => value !== null).join("\n"),
        attachments: materializedAttachments,
      };
      const current = this.options.store.get(jobId);
      if (!current) throw new Error("Unknown Telegram job");
      if (current.materializedPrompt) {
        cleanupCandidates(candidatePaths, this.options.materializationRoot, current.materializedPrompt);
        return structuredClone(current.materializedPrompt);
      }
      const stored = this.options.store.transition({
        jobId,
        eventId: boundedId(this.createId()),
        expectedVersion: current.version,
        event: {
          schemaVersion: 1,
          type: "materialization.succeeded",
          eventAt: monotonicNow(this.now, current.updatedAt),
          attention: { kind: "none" },
          materializedPrompt: prompt,
        },
      });
      return structuredClone(stored.materializedPrompt!);
    } catch (error) {
      if (error instanceof TelegramMaterializationError) throw error;
      const canonical = this.options.store.get(jobId);
      if (canonical?.materializedPrompt) {
        cleanupCandidates(candidatePaths, this.options.materializationRoot, canonical.materializedPrompt);
        return structuredClone(canonical.materializedPrompt);
      }
      cleanupCandidates(candidatePaths, this.options.materializationRoot);
      this.recordFailure(jobId, stage);
      throw new TelegramMaterializationError(stage);
    }
  }

  private recordFailure(jobId: string, code: MaterializationFailureCode): void {
    try {
      const current = this.options.store.get(jobId);
      if (!current || current.materializedPrompt) return;
      this.options.store.transition({
        jobId,
        eventId: boundedId(this.createId()),
        expectedVersion: current.version,
        event: {
          schemaVersion: 1,
          type: "materialization.failed",
          eventAt: monotonicNow(this.now, current.updatedAt),
          failureCode: code,
          attention: { kind: "required", code: "materialization_failed", actions: ["retry"] },
        },
      });
    } catch {
      // The accepted source remains durable even if storage cannot record this attempt.
    }
  }

  private prepareTarget(jobId: string, attachment: TelegramAttachmentRef, attemptId: string): {
    readonly relativePath: string;
    readonly absolutePath: string;
  } {
    const root = path.resolve(this.options.materializationRoot);
    ensurePrivateDirectory(root);
    const realRoot = realpathSync(root);
    if (realRoot !== root) throw new Error("Unsafe materialization root");
    const jobDirectoryName = digest(jobId).slice(0, 32);
    const jobDirectory = path.join(root, jobDirectoryName);
    ensurePrivateDirectory(jobDirectory);
    const realJobDirectory = realpathSync(jobDirectory);
    if (!contained(realRoot, realJobDirectory)) throw new Error("Unsafe materialization directory");
    const fileName = `${digest(`${attachment.id}:${attemptId}`).slice(0, 32)}${safeExtension(attachment.name)}`;
    const relativePath = `${jobDirectoryName}/${fileName}`;
    const absolutePath = path.join(realJobDirectory, fileName);
    if (!contained(realRoot, absolutePath)) throw new Error("Unsafe materialization path");
    return { relativePath, absolutePath };
  }
}

function withinMaterializationDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Telegram attachment materialization timed out")), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function initialJob(id: string, source: TelegramWorkSource, acceptedAt: number): TelegramJob {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    source: { botId: source.botId, updateId: source.updateId },
    attachments: source.attachment ? [{ ...source.attachment }] : [],
    phase: "accepted",
    health: "healthy",
    activity: "unknown",
    attention: { kind: "none" },
    outcome: null,
    dispatchId: null,
    threadId: null,
    turnId: null,
    responsePlan: undefined,
    deliveries: [],
    acceptedAt,
    updatedAt: acceptedAt,
    terminalAt: null,
    dismissedAt: null,
    retainUntil: null,
  };
}

function statusAnchor(job: TelegramJob, source: TelegramWorkSource): NewDeliveryPart {
  const destination = source.targetContext ?? source;
  const payload = {
    chatId: destination.chatId,
    messageThreadId: destination.messageThreadId,
    sourceMessageId: source.messageId,
  };
  return {
    jobId: job.id,
    partKey: TELEGRAM_STATUS_ANCHOR_PART_KEY,
    ordinal: 0,
    kind: "status-anchor",
    state: "pending",
    payload,
    contentHash: digest(JSON.stringify(payload)),
    updatedAt: job.acceptedAt,
  };
}

function normalizeSource(value: unknown): TelegramWorkSource {
  const raw = plainRecord(value);
  if (!raw) throw new Error("Invalid Telegram work source");
  const allowed = [
    "botId", "updateId", "chatId", "messageThreadId", "messageId", "kind", "text",
    "attachment", "retryOfJobId", "targetContext", "targetProvision", "sessionDefaults", "implementationHandoffProfileId",
    "completion",
  ];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) invalidSource();
  const kind = workKind(raw.kind);
  const text = nullableText(raw.text, 64 * 1024);
  const file = raw.attachment === null ? null : attachmentRef(raw.attachment);
  const retryOfJobId = raw.retryOfJobId === null ? null : boundedText(raw.retryOfJobId, 128);
  const source: TelegramWorkSource = {
    botId: boundedText(raw.botId, 128),
    updateId: integer(raw.updateId, 0),
    chatId: nonzeroInteger(raw.chatId),
    messageThreadId: raw.messageThreadId === null ? null : integer(raw.messageThreadId, 1),
    messageId: integer(raw.messageId, 1),
    kind,
    text,
    attachment: file,
    retryOfJobId,
    ...(raw.targetContext === undefined ? {} : { targetContext: normalizeTargetContext(raw.targetContext) }),
    ...(raw.targetProvision === undefined ? {} : { targetProvision: normalizeTargetProvision(raw.targetProvision) }),
    ...(raw.sessionDefaults === undefined ? {} : { sessionDefaults: normalizeSessionDefaults(raw.sessionDefaults) }),
    ...(raw.implementationHandoffProfileId === undefined
      ? {}
      : { implementationHandoffProfileId: boundedText(raw.implementationHandoffProfileId, 128) }),
    ...(raw.completion === undefined ? {} : { completion: normalizeCompletion(raw.completion) }),
  };
  if (source.targetContext && source.targetContext.chatId !== source.chatId) invalidSource();
  if (source.targetProvision?.state === "complete" && !source.targetContext) invalidSource();
  if (source.targetContext && source.targetProvision && source.targetProvision.state !== "complete") invalidSource();
  const attachmentKind = kind === "voice" || kind === "audio" || kind === "photo" || kind === "document";
  if (attachmentKind && (!file || file.kind !== kind)) invalidSource();
  if (!attachmentKind && kind !== "retry" && file !== null) invalidSource();
  if ((kind === "text" || kind === "command" || kind === "confirmation") && !text) invalidSource();
  if (kind === "retry" ? !retryOfJobId : retryOfJobId !== null) invalidSource();
  if (kind === "retry" && !text && !file) invalidSource();
  if (source.completion && kind !== "confirmation" && kind !== "retry") invalidSource();
  return structuredClone(source);
}

function normalizeTargetProvision(value: unknown): TelegramWorkTargetProvision {
  const raw = plainRecord(value);
  if (!raw || Object.keys(raw).some((key) => !["kind", "topicName", "state"].includes(key))
    || raw.kind !== "forum_topic"
    || (raw.state !== "planned" && raw.state !== "in_flight" && raw.state !== "complete")) {
    return invalidSource();
  }
  return {
    kind: "forum_topic",
    topicName: boundedText(raw.topicName, 128),
    state: raw.state,
  };
}

function normalizeCompletion(value: unknown): TelegramWorkCompletion {
  const raw = plainRecord(value);
  if (!raw || Object.keys(raw).some((key) => !["kind", "ticketId"].includes(key))
    || raw.kind !== "inbox_ticket") {
    return invalidSource();
  }
  return { kind: "inbox_ticket", ticketId: integer(raw.ticketId, 1) };
}

function normalizeTargetContext(value: unknown): TelegramWorkTargetContext {
  const raw = plainRecord(value);
  if (!raw || Object.keys(raw).some((key) => !["chatId", "messageThreadId"].includes(key))) {
    return invalidSource();
  }
  return {
    chatId: nonzeroInteger(raw.chatId),
    messageThreadId: integer(raw.messageThreadId, 1),
  };
}

function normalizeSessionDefaults(value: unknown): TelegramWorkSessionDefaults {
  const raw = plainRecord(value);
  if (!raw || Object.keys(raw).some((key) => !["workspace", "launchProfileId", "topicName"].includes(key))) {
    return invalidSource();
  }
  const workspace = boundedText(raw.workspace, 4_096);
  if (!path.isAbsolute(workspace) || workspace === path.parse(workspace).root) invalidSource();
  return {
    workspace: path.normalize(workspace),
    launchProfileId: boundedText(raw.launchProfileId, 128),
    ...(raw.topicName === undefined ? {} : { topicName: boundedText(raw.topicName, 128) }),
  };
}

function attachmentRef(value: unknown): TelegramAttachmentRef {
  const raw = plainRecord(value);
  if (!raw) invalidSource();
  const allowed = ["id", "kind", "telegramFileId", "telegramFileUniqueId", "name", "mimeType", "size"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) invalidSource();
  const kind = attachmentKind(raw.kind);
  return {
    id: boundedText(raw.id, 1024),
    kind,
    telegramFileId: boundedText(raw.telegramFileId, 1024),
    ...(raw.telegramFileUniqueId === undefined ? {} : { telegramFileUniqueId: boundedText(raw.telegramFileUniqueId, 1024) }),
    ...(raw.name === undefined ? {} : { name: boundedText(raw.name, 1024) }),
    ...(raw.mimeType === undefined ? {} : { mimeType: boundedText(raw.mimeType, 1024) }),
    ...(raw.size === undefined ? {} : { size: integer(raw.size, 0) }),
  };
}

function ensurePrivateDirectory(directory: string): void {
  if (path.parse(directory).root === directory) throw new Error("Unsafe directory");
  assertNoSymlinkAncestor(directory);
  if (existsSync(directory)) {
    const existing = lstatSync(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory() || (existing.mode & 0o777) !== 0o700) {
      throw new Error("Unsafe directory");
    }
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("Unsafe directory");
  chmodSync(directory, 0o700);
}

function assertNoSymlinkAncestor(candidate: string): void {
  let ancestor = path.resolve(candidate);
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Unsafe directory");
    ancestor = parent;
  }
  if (realpathSync(ancestor) !== ancestor) throw new Error("Unsafe directory");
}

function writePrivateFile(filePath: string, bytes: Uint8Array): void {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(filePath, 0o600);
    const stored = lstatSync(filePath);
    if (!stored.isFile() || stored.isSymbolicLink()) throw new Error("Unsafe materialized file");
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the materialization error. */ }
    }
    if (created) {
      try { unlinkSync(filePath); } catch { /* Preserve the materialization error. */ }
    }
    throw error;
  }
}

function cleanupCandidates(
  candidates: readonly string[],
  materializationRoot: string,
  canonical?: MaterializedPrompt,
): void {
  const root = path.resolve(materializationRoot);
  const preserved = new Set((canonical?.attachments ?? []).map((attachment) =>
    path.join(root, ...attachment.relativePath.split("/"))));
  for (const candidate of candidates) {
    if (preserved.has(candidate) || !contained(root, candidate)) continue;
    try { unlinkSync(candidate); } catch { /* A private candidate may already be absent. */ }
  }
}

function safeExtension(name: string | undefined): string {
  const extension = name ? path.extname(name) : "";
  return /^\.[A-Za-z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : ".bin";
}

function contained(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function monotonicNow(now: () => number, previous: number): number {
  return Math.max(utcMilliseconds(now()), previous);
}

function utcMilliseconds(value: unknown): number {
  return integer(value, 0);
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function materializedText(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_000_000) throw new Error("Invalid transcript");
  return value;
}

function boundedId(value: unknown): string {
  return boundedText(value, 128);
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) invalidSource();
  return value;
}

function nullableText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum) invalidSource();
  return value;
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalidSource();
  return value;
}

function nonzeroInteger(value: unknown): number {
  const result = integer(value, Number.MIN_SAFE_INTEGER);
  if (result === 0) invalidSource();
  return result;
}

function workKind(value: unknown): TelegramWorkKind {
  if (value === "text" || value === "voice" || value === "audio" || value === "photo" ||
    value === "document" || value === "command" || value === "confirmation" || value === "retry") return value;
  return invalidSource();
}

function attachmentKind(value: unknown): TelegramAttachmentRef["kind"] {
  if (value === "photo" || value === "document" || value === "audio" || value === "voice" ||
    value === "video" || value === "unknown") return value;
  return invalidSource();
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function invalidSource(): never {
  throw new Error("Invalid Telegram work source");
}
