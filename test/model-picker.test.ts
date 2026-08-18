import {
  canUseChoiceForInput,
  parsePromptModelCallback,
  promptModelCallback,
} from "../src/model-picker.js";

describe("model picker", () => {
  const openAiChoice = {
    id: "openai-default",
    label: "OpenAI",
    provider: "openai",
    model: "gpt-5.6-sol",
    supportsImages: true,
  };
  const glmChoice = {
    id: "glm-53",
    label: "GLM",
    provider: "zai",
    model: "glm-5.3",
    supportsImages: false,
  };

  it("round-trips a prompt selection callback below Telegram's limit", () => {
    const value = promptModelCallback("0123456789ab", "glm-53");
    expect(value).toBe("jobmodel:0123456789ab:glm-53");
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(parsePromptModelCallback(value)).toEqual({
      token: "0123456789ab",
      choiceId: "glm-53",
    });

    const longestChoiceId = `a${"b".repeat(31)}`;
    expect(Buffer.byteLength(promptModelCallback("0123456789ab", longestChoiceId), "utf8"))
      .toBeLessThanOrEqual(64);
  });

  it.each([
    "jobmodel:bad:glm-53",
    "jobmodel:0123456789ab:GLM 5.3",
    "jobmodel:0123456789ab:",
    "model:0123456789ab:glm-53",
  ])("rejects an invalid callback: %s", (value) => {
    expect(parsePromptModelCallback(value)).toBeNull();
  });

  it("rejects images for choices without image capability", () => {
    expect(canUseChoiceForInput(glmChoice, { imagePaths: ["/tmp/a.jpg"] })).toBe(false);
    expect(canUseChoiceForInput(openAiChoice, { imagePaths: ["/tmp/a.jpg"] })).toBe(true);
    expect(canUseChoiceForInput(glmChoice, { text: "plain text" })).toBe(true);
    expect(canUseChoiceForInput(glmChoice, "plain text")).toBe(true);
  });
});
