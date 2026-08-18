import {
  findModelChoice,
  parseModelChoicesJson,
  resolveDefaultModelChoice,
} from "../src/codex-model.js";

describe("Codex model choices", () => {
  const choices = [
    {
      id: "openai-default",
      label: "OpenAI GPT-5.6 Sol",
      provider: "openai",
      model: "gpt-5.6-sol",
      supportsImages: true,
    },
    {
      id: "glm-53",
      label: "Z.AI GLM-5.3",
      provider: "zai",
      model: "glm-5.3",
      supportsImages: false,
      webSearch: "disabled" as const,
    },
  ];

  it("parses configured provider/model pairs", () => {
    expect(parseModelChoicesJson(JSON.stringify(choices))).toEqual(choices);
  });

  it("keeps legacy behavior when choices are not configured", () => {
    expect(parseModelChoicesJson(undefined)).toEqual([]);
    expect(parseModelChoicesJson("   ")).toEqual([]);
  });

  it("defaults image support only for OpenAI", () => {
    expect(
      parseModelChoicesJson(
        JSON.stringify([
          { id: "openai", label: "OpenAI", provider: "openai", model: "gpt" },
          { id: "glm", label: "GLM", provider: "zai", model: "glm" },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({ id: "openai", supportsImages: true }),
      expect.objectContaining({ id: "glm", supportsImages: false }),
    ]);
  });

  it("rejects malformed JSON and non-array values", () => {
    expect(() => parseModelChoicesJson("{")).toThrow("Invalid CODEX_MODEL_CHOICES_JSON");
    expect(() => parseModelChoicesJson("{}")) .toThrow("must be a JSON array");
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      parseModelChoicesJson(
        JSON.stringify([
          { id: "same", label: "A", provider: "openai", model: "a" },
          { id: "same", label: "B", provider: "zai", model: "b" },
        ]),
      ),
    ).toThrow("Duplicate model choice id: same");
  });

  it.each([
    [{ id: "Bad ID", label: "A", provider: "openai", model: "a" }, "Invalid model choice id"],
    [{ id: "ok", label: "", provider: "openai", model: "a" }, "label"],
    [{ id: "ok", label: "A", provider: "", model: "a" }, "provider"],
    [{ id: "ok", label: "A", provider: "openai", model: "" }, "model"],
    [
      { id: "ok", label: "A", provider: "openai", model: "a", webSearch: "sometimes" },
      "webSearch",
    ],
  ])("rejects invalid choice %#", (choice, message) => {
    expect(() => parseModelChoicesJson(JSON.stringify([choice]))).toThrow(message as string);
  });

  it("resolves an explicit default and rejects an unknown one", () => {
    expect(resolveDefaultModelChoice(choices, "glm-53", undefined)?.provider).toBe("zai");
    expect(() => resolveDefaultModelChoice(choices, "missing", undefined)).toThrow(
      "Unknown CODEX_DEFAULT_MODEL_CHOICE: missing",
    );
  });

  it("resolves a configured legacy model and otherwise uses the first choice", () => {
    expect(resolveDefaultModelChoice(choices, undefined, "glm-5.3")?.id).toBe("glm-53");
    expect(resolveDefaultModelChoice(choices, undefined, "unknown")?.id).toBe("openai-default");
    expect(resolveDefaultModelChoice([], undefined, "gpt-5.6-sol")).toBeUndefined();
  });

  it("finds only allowlisted model choices", () => {
    expect(findModelChoice(choices, "glm-53")?.model).toBe("glm-5.3");
    expect(findModelChoice(choices, "missing")).toBeUndefined();
    expect(findModelChoice(choices, undefined)).toBeUndefined();
  });
});
