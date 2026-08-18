import os from "node:os";
import path from "node:path";

import { AppServerClient } from "./app-server-client.js";
import {
  AppServerTurnManager,
  type AppServerRequestClient,
  type AppServerTurnCallbacks,
  type AppServerUserInput,
} from "./app-server-turn-manager.js";
import type { TeleCodexConfig } from "./config.js";
import {
  findModelChoice,
  resolveDefaultModelChoice,
  type CodexModelChoice,
} from "./codex-model.js";
import {
  getThread,
  listModels,
  listThreads,
  listWorkspaces,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexSessionCallbacks extends AppServerTurnCallbacks {}

export interface CodexSessionInfo {
  threadId: string | null;
  workspace: string;
  model?: string;
  modelProvider?: string;
  modelChoiceId?: string;
  modelLabel?: string;
  supportsImages?: boolean;
  nextModel?: string;
  nextModelProvider?: string;
  nextModelChoiceId?: string;
  nextModelLabel?: string;
  nextSupportsImages?: boolean;
  reasoningEffort?: string;
  launchProfileId: string;
  launchProfileLabel: string;
  launchProfileBehavior: string;
  sandboxMode: string;
  approvalPolicy: string;
  unsafeLaunch: boolean;
  nextLaunchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  sessionTokens?: { input: number; cached: number; output: number };
}

export interface CreateOptions {
  workspace?: string;
  model?: string;
  modelProvider?: string;
  modelChoiceId?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
  /** Name of the Telegram topic this session belongs to, given to Codex as the thread title. */
  topicName?: string;
}

export interface CodexSessionDependencies {
  client: AppServerRequestClient & { close?: () => void };
  turnManager: Pick<AppServerTurnManager, "runTurn"> &
    Partial<
      Pick<
        AppServerTurnManager,
        "cancelTurn" | "dispose" | "trackThread" | "recoverTurn" | "reloadThread"
      >
    >;
}

export type CodexPromptInput = string | {
  text?: string;
  imagePaths?: string[];
  stagedFileInstructions?: string;
};

interface ThreadResponse {
  thread: { id: string; status: { type: "notLoaded" | "idle" | "systemError" | "active" } };
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: { type?: string };
  reasoningEffort?: CodexReasoningEffort | null;
}

export class CodexSessionService {
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private topicName: string | undefined;
  private currentModel: string | undefined;
  private currentModelProvider = "openai";
  private activeModelChoice: CodexModelChoice | null = null;
  private selectedModelChoice: CodexModelChoice | undefined;
  private currentReasoningEffort: CodexReasoningEffort | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private processing = false;
  private activeCallbacks: CodexSessionCallbacks | null = null;
  private readonly sessionTokens = { input: 0, cached: 0, output: 0 };

  private constructor(
    private readonly config: TeleCodexConfig,
    private readonly dependencies: CodexSessionDependencies,
  ) {
    this.currentWorkspace = config.workspace;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
    this.selectedModelChoice = resolveDefaultModelChoice(
      config.modelChoices,
      config.defaultModelChoiceId,
      config.codexModel,
    );
  }

  static async create(
    config: TeleCodexConfig,
    options?: CreateOptions,
    dependencies?: CodexSessionDependencies,
  ): Promise<CodexSessionService> {
    const service = new CodexSessionService(
      config,
      dependencies ?? createCodexSessionDependencies(config.telegramMaxActiveTopics),
    );
    service.currentWorkspace = options?.workspace ?? config.workspace;
    if (options?.modelChoiceId) {
      service.selectedModelChoice = service.requireModelChoice(options.modelChoiceId);
    }
    service.currentModel = options?.model ?? service.selectedModelChoice?.model ?? config.codexModel;
    service.currentModelProvider = options?.modelProvider ?? "openai";
    if (options?.resumeThreadId && service.currentModel) {
      service.activeModelChoice = service.choiceFromPair(
        service.currentModel,
        service.currentModelProvider,
      );
    }
    service.currentReasoningEffort = options?.reasoningEffort as CodexReasoningEffort | undefined;
    service.topicName = options?.topicName;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
    } else if (!options?.deferThreadStart) {
      await service.newThread(service.currentWorkspace);
    }
    return service;
  }

  getInfo(): CodexSessionInfo {
    const effectiveProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const activeChoice = this.activeModelChoice;
    const reportedChoice = activeChoice ?? this.selectedModelChoice;
    const info: CodexSessionInfo = {
      threadId: this.currentThreadId,
      workspace: this.currentWorkspace,
      model: reportedChoice?.model ?? this.currentModel,
      modelProvider: reportedChoice?.provider ?? this.currentModelProvider,
      launchProfileId: effectiveProfile.id,
      launchProfileLabel: effectiveProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveProfile),
      sandboxMode: effectiveProfile.sandboxMode,
      approvalPolicy: effectiveProfile.approvalPolicy,
      unsafeLaunch: effectiveProfile.unsafe,
    };
    if (reportedChoice) {
      info.modelChoiceId = reportedChoice.id;
      info.modelLabel = reportedChoice.label;
      info.supportsImages = reportedChoice.supportsImages;
    }
    if (
      activeChoice &&
      this.selectedModelChoice &&
      (activeChoice.model !== this.selectedModelChoice.model ||
        activeChoice.provider !== this.selectedModelChoice.provider)
    ) {
      info.nextModel = this.selectedModelChoice.model;
      info.nextModelProvider = this.selectedModelChoice.provider;
      info.nextModelChoiceId = this.selectedModelChoice.id;
      info.nextModelLabel = this.selectedModelChoice.label;
      info.nextSupportsImages = this.selectedModelChoice.supportsImages;
    }
    if (this.currentReasoningEffort) info.reasoningEffort = this.currentReasoningEffort;
    if (this.activeThreadLaunchProfile && this.activeThreadLaunchProfile.id !== this.currentLaunchProfile.id) {
      info.nextLaunchProfileId = this.currentLaunchProfile.id;
      info.nextLaunchProfileLabel = this.currentLaunchProfile.label;
      info.nextLaunchProfileBehavior = formatLaunchProfileBehavior(this.currentLaunchProfile);
      info.nextUnsafeLaunch = this.currentLaunchProfile.unsafe;
    }
    if (this.sessionTokens.input || this.sessionTokens.cached || this.sessionTokens.output) {
      info.sessionTokens = { ...this.sessionTokens };
    }
    return info;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  hasActiveThread(): boolean {
    return this.currentThreadId !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  /** Re-reads this thread from disk, so the next turn sees what is actually there. */
  async reloadThread(): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("No thread to reload");
    }
    if (!this.dependencies.turnManager.reloadThread) {
      throw new Error("This turn manager cannot reload threads");
    }
    await this.dependencies.turnManager.reloadThread(this.currentThreadId);
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.currentThreadId) throw new Error("Codex thread is not initialized");
    if (this.processing) throw new Error("A Codex turn is already in progress");

    this.processing = true;
    const trackedCallbacks = this.createTrackedCallbacks(callbacks);
    this.activeCallbacks = trackedCallbacks;
    const profile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;

    try {
      await this.dependencies.turnManager.runTurn({
        threadId: this.currentThreadId,
        input: buildAppServerInput(input),
        cwd: this.currentWorkspace,
        model: this.activeModelChoice?.model ?? this.currentModel,
        reasoningEffort: this.currentReasoningEffort,
        approvalPolicy: profile.approvalPolicy,
        sandbox: profile.sandboxMode,
        callbacks: trackedCallbacks,
      });
    } finally {
      this.processing = false;
      this.activeCallbacks = null;
    }
  }

  async recoverPrompt(turnId: string, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.currentThreadId) throw new Error("Codex thread is not initialized");
    if (this.processing) throw new Error("A Codex turn is already in progress");
    if (!this.dependencies.turnManager.recoverTurn) {
      throw new Error("Codex turn recovery is not available");
    }

    this.processing = true;
    const trackedCallbacks = this.createTrackedCallbacks(callbacks);
    this.activeCallbacks = trackedCallbacks;
    const profile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    try {
      await this.dependencies.turnManager.recoverTurn({
        threadId: this.currentThreadId,
        input: [],
        cwd: this.currentWorkspace,
        model: this.activeModelChoice?.model ?? this.currentModel,
        reasoningEffort: this.currentReasoningEffort,
        approvalPolicy: profile.approvalPolicy,
        sandbox: profile.sandboxMode,
        callbacks: trackedCallbacks,
      }, turnId);
    } finally {
      this.processing = false;
      this.activeCallbacks = null;
    }
  }

  async abort(): Promise<void> {
    if (this.currentThreadId && this.activeCallbacks && this.dependencies.turnManager.cancelTurn) {
      await this.dependencies.turnManager.cancelTurn(this.currentThreadId, this.activeCallbacks);
    }
  }

  async newThread(workspace?: string, modelChoiceId?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");
    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const choice = this.resolveSelectedModelChoice(modelChoiceId);
    const effectiveModel = choice?.model ?? this.currentModel;
    const modelProvider = choice?.provider ?? "openai";
    const threadConfig = {
      ...(this.currentReasoningEffort
        ? { model_reasoning_effort: this.currentReasoningEffort }
        : {}),
      ...(choice?.webSearch ? { web_search: choice.webSearch } : {}),
    };
    await this.dependencies.client.connect();
    const response = await this.dependencies.client.request<ThreadResponse>("thread/start", {
      cwd: effectiveWorkspace,
      model: effectiveModel,
      modelProvider,
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      sandbox: this.currentLaunchProfile.sandboxMode,
      serviceName: "telecodex",
      ...(Object.keys(threadConfig).length ? { config: threadConfig } : {}),
    });
    this.currentWorkspace = effectiveWorkspace;
    this.currentModel = effectiveModel;
    this.currentModelProvider = modelProvider;
    if (choice) this.selectedModelChoice = choice;
    this.applyThreadResponse(response, this.currentLaunchProfile, choice);
    await this.nameThread(response.thread.id);
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");
    await this.dependencies.client.connect();
    const response = await this.dependencies.client.request<ThreadResponse>("thread/resume", {
      threadId,
    });
    this.applyThreadResponse(response, this.currentLaunchProfile);
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");
    const record = getThread(threadId);
    if (record?.cwd) this.currentWorkspace = record.cwd;
    if (record?.model) {
      this.currentModel = record.model;
      this.currentModelProvider = record.modelProvider ?? "openai";
      this.activeModelChoice = this.choiceFromPair(
        record.model,
        this.currentModelProvider,
      );
    }
    return this.resumeThread(threadId);
  }

  listAllSessions(limit?: number): CodexThreadRecord[] {
    return listThreads(limit ?? 20);
  }

  listWorkspaces(): string[] {
    return listWorkspaces();
  }

  listModels(): CodexModelRecord[] {
    return listModels();
  }

  listModelChoices(): CodexModelChoice[] {
    if (this.config.modelChoices.length) {
      return [...this.config.modelChoices];
    }
    return listModels().map((model) => ({
      id: model.slug,
      label: model.displayName,
      provider: "openai",
      model: model.slug,
      supportsImages: true,
    }));
  }

  getModelChoice(choiceId: string): CodexModelChoice | undefined {
    return findModelChoice(this.listModelChoices(), choiceId);
  }

  setModelChoice(choiceId: string): CodexModelChoice {
    const choice = this.requireModelChoice(choiceId);
    this.selectedModelChoice = choice;
    return choice;
  }

  setModel(slug: string): string {
    const choice = this.listModelChoices().find(
      (candidate) => candidate.id === slug || candidate.model === slug,
    ) ?? createLegacyChoice(slug, "openai");
    this.selectedModelChoice = choice;
    return slug;
  }

  setReasoningEffort(effort: CodexReasoningEffort): void {
    this.currentReasoningEffort = effort;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    return this.currentLaunchProfile;
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    void this.abort();
    this.currentThreadId = null;
    this.activeModelChoice = null;
    this.activeThreadLaunchProfile = null;
    return info;
  }

  dispose(): void {
    void this.abort();
    this.currentThreadId = null;
    this.activeModelChoice = null;
    this.activeThreadLaunchProfile = null;
  }

  /**
   * Gives Codex the name the Telegram topic already carries.
   *
   * Without this a thread opened from an inbox ticket is titled with the whole
   * forwarded message, so the topic list and `codex resume` disagree about what
   * the same conversation is called.
   */
  private async nameThread(threadId: string): Promise<void> {
    if (!this.topicName) return;
    try {
      await this.dependencies.client.request("thread/name/set", {
        threadId,
        name: this.topicName,
      });
    } catch (error) {
      // A nameless thread still works, so this never fails a turn.
      console.error("Failed to name Codex thread:", error);
    }
  }

  private applyThreadResponse(
    response: ThreadResponse,
    baseProfile: CodexLaunchProfile,
    fallbackChoice: CodexModelChoice | null = this.activeModelChoice,
  ): void {
    this.currentThreadId = response.thread.id;
    this.dependencies.turnManager.trackThread?.(response.thread.id, response.thread.status.type);
    if (response.cwd) this.currentWorkspace = response.cwd;
    if (response.model) this.currentModel = response.model;
    if (response.modelProvider) this.currentModelProvider = response.modelProvider;
    const effectiveModel = response.model ?? fallbackChoice?.model ?? this.currentModel;
    const effectiveProvider =
      response.modelProvider ?? fallbackChoice?.provider ?? this.currentModelProvider ?? "openai";
    if (effectiveModel) {
      this.currentModelProvider = effectiveProvider;
      this.activeModelChoice = this.choiceFromPair(effectiveModel, effectiveProvider, fallbackChoice);
    }
    if (response.reasoningEffort) this.currentReasoningEffort = response.reasoningEffort;
    this.activeThreadLaunchProfile = profileFromResponse(baseProfile, response);
  }

  private createTrackedCallbacks(callbacks: CodexSessionCallbacks): CodexSessionCallbacks {
    return {
      ...callbacks,
      onTurnComplete: (usage) => {
        this.sessionTokens.input += usage.inputTokens;
        this.sessionTokens.cached += usage.cachedInputTokens;
        this.sessionTokens.output += usage.outputTokens;
        callbacks.onTurnComplete?.(usage);
      },
    };
  }

  private ensureIdle(action: string): void {
    if (this.processing) throw new Error(`Cannot ${action} while a turn is in progress`);
  }

  private resolveSelectedModelChoice(choiceId: string | undefined): CodexModelChoice | undefined {
    if (choiceId) {
      return this.requireModelChoice(choiceId);
    }
    if (this.selectedModelChoice) {
      return this.selectedModelChoice;
    }
    return this.currentModel ? createLegacyChoice(this.currentModel, "openai") : undefined;
  }

  private requireModelChoice(choiceId: string): CodexModelChoice {
    const choice = this.getModelChoice(choiceId);
    if (!choice) throw new Error(`Unknown model choice: ${choiceId}`);
    return choice;
  }

  private choiceFromPair(
    model: string,
    provider: string,
    fallback?: CodexModelChoice | null,
  ): CodexModelChoice {
    const configured = this.listModelChoices().find(
      (choice) => choice.model === model && choice.provider === provider,
    );
    if (configured) return configured;
    if (fallback && fallback.model === model && fallback.provider === provider) return fallback;
    return createLegacyChoice(model, provider);
  }
}

export function createCodexSessionDependencies(maxActiveTopics = 4): CodexSessionDependencies {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const client = new AppServerClient(
    path.join(codexHome, "app-server-control", "app-server-control.sock"),
  );
  return { client, turnManager: new AppServerTurnManager(client, maxActiveTopics) };
}

function getLaunchProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) throw new Error(`Unknown launch profile: ${profileId}`);
  return profile;
}

function createLegacyChoice(model: string, provider: string): CodexModelChoice {
  return {
    id: model,
    label: model,
    provider,
    model,
    supportsImages: provider === "openai",
  };
}

function buildAppServerInput(input: CodexPromptInput): AppServerUserInput[] {
  if (typeof input === "string") {
    return [{ type: "text", text: input, text_elements: [] }];
  }
  const result: AppServerUserInput[] = [];
  // The user's text leads: Codex titles the thread with the first message,
  // and boilerplate at the front made every thread carry the same title.
  const text = [input.text, input.stagedFileInstructions].filter(Boolean).join("\n\n");
  if (text) result.push({ type: "text", text, text_elements: [] });
  for (const imagePath of input.imagePaths ?? []) {
    result.push({ type: "localImage", path: imagePath });
  }
  return result;
}

function profileFromResponse(base: CodexLaunchProfile, response: ThreadResponse): CodexLaunchProfile {
  const sandboxMode = mapSandboxMode(response.sandbox?.type) ?? base.sandboxMode;
  const approvalPolicy = response.approvalPolicy ?? base.approvalPolicy;
  return {
    ...base,
    sandboxMode,
    approvalPolicy,
    unsafe: sandboxMode === "danger-full-access",
  };
}

function mapSandboxMode(type: string | undefined): CodexSandboxMode | undefined {
  if (type === "dangerFullAccess") return "danger-full-access";
  if (type === "readOnly") return "read-only";
  if (type === "workspaceWrite") return "workspace-write";
  return undefined;
}
