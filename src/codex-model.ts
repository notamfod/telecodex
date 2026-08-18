export type CodexWebSearchMode = "disabled" | "cached" | "live";

export interface CodexModelChoice {
  id: string;
  label: string;
  provider: string;
  model: string;
  supportsImages: boolean;
  webSearch?: CodexWebSearchMode;
}

const MODEL_CHOICE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WEB_SEARCH_MODES = new Set<CodexWebSearchMode>(["disabled", "cached", "live"]);

export function parseModelChoicesJson(raw: string | undefined): CodexModelChoice[] {
  if (!raw?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid CODEX_MODEL_CHOICES_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("CODEX_MODEL_CHOICES_JSON must be a JSON array");
  }

  const ids = new Set<string>();
  return parsed.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`Invalid model choice at index ${index}: expected an object`);
    }

    const id = requiredString(value.id, "id", index);
    if (!MODEL_CHOICE_ID.test(id)) {
      throw new Error(`Invalid model choice id: ${id}`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate model choice id: ${id}`);
    }
    ids.add(id);

    const label = requiredString(value.label, "label", index);
    const provider = requiredString(value.provider, "provider", index);
    const model = requiredString(value.model, "model", index);

    let supportsImages = provider === "openai";
    if (value.supportsImages !== undefined) {
      if (typeof value.supportsImages !== "boolean") {
        throw new Error(`Invalid supportsImages for model choice ${id}: expected boolean`);
      }
      supportsImages = value.supportsImages;
    }

    let webSearch: CodexWebSearchMode | undefined;
    if (value.webSearch !== undefined) {
      if (typeof value.webSearch !== "string" || !WEB_SEARCH_MODES.has(value.webSearch as CodexWebSearchMode)) {
        throw new Error(`Invalid webSearch for model choice ${id}`);
      }
      webSearch = value.webSearch as CodexWebSearchMode;
    }

    return {
      id,
      label,
      provider,
      model,
      supportsImages,
      ...(webSearch ? { webSearch } : {}),
    };
  });
}

export function resolveDefaultModelChoice(
  choices: CodexModelChoice[],
  defaultChoiceId: string | undefined,
  legacyModel: string | undefined,
): CodexModelChoice | undefined {
  if (defaultChoiceId) {
    const configured = findModelChoice(choices, defaultChoiceId);
    if (!configured) {
      throw new Error(`Unknown CODEX_DEFAULT_MODEL_CHOICE: ${defaultChoiceId}`);
    }
    return configured;
  }

  if (legacyModel) {
    const legacyChoice = choices.find((choice) => choice.model === legacyModel);
    if (legacyChoice) {
      return legacyChoice;
    }
  }

  return choices[0];
}

export function findModelChoice(
  choices: CodexModelChoice[],
  choiceId: string | undefined,
): CodexModelChoice | undefined {
  return choiceId ? choices.find((choice) => choice.id === choiceId) : undefined;
}

function requiredString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${field} for model choice at index ${index}`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
