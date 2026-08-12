import { describe, expect, it } from "vitest";

import type { CodexThreadRecord } from "../src/codex-state.js";
import type { ContextMetadata } from "../src/session-registry.js";
import {
  findBoundTopic,
  groupThreadsByProject,
  projectButtons,
  renderProjectHTML,
  renderProjectsHTML,
  sessionButtons,
  topicUrl,
} from "../src/projects.js";

function thread(overrides: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  return {
    id: "019fda52-f2ec-7801-ba9c-8761cc89bae4",
    title: "Refactor payments",
    cwd: "/srv/projects/storefront",
    model: "gpt-5.6-sol",
    createdAt: new Date(0),
    updatedAt: new Date(1_000),
    firstUserMessage: "Refactor payments",
    ...overrides,
  };
}

describe("groupThreadsByProject", () => {
  it("groups threads by workspace, most recently used project first", () => {
    const groups = groupThreadsByProject([
      thread({ id: "a", cwd: "/srv/projects/storefront", updatedAt: new Date(1_000) }),
      thread({ id: "b", cwd: "/srv/projects/billing", updatedAt: new Date(3_000) }),
      thread({ id: "c", cwd: "/srv/projects/storefront", updatedAt: new Date(2_000) }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(["billing", "storefront"]);
    expect(groups[1].threads.map((entry) => entry.id)).toEqual(["c", "a"]);
  });

  it("does not expose suspicious workspace directory names", () => {
    const groups = groupThreadsByProject([
      thread({ cwd: "/root/Documents/Codex/8603016081-aafkgoyncrfhv9yjcln8mifaff-uyqbb6vu" }),
    ]);

    expect(groups[0].name).toBe("Codex");
  });
});

describe("projectButtons", () => {
  it("labels each project with its session count and indexes the callback", () => {
    const groups = groupThreadsByProject([
      thread({ id: "a", cwd: "/srv/projects/storefront" }),
      thread({ id: "b", cwd: "/srv/projects/storefront" }),
    ]);

    expect(projectButtons(groups)).toEqual([{ label: "storefront (2)", callbackData: "proj_0" }]);
  });
});

describe("sessionButtons", () => {
  it("attaches the Codex thread behind each button", () => {
    const [group] = groupThreadsByProject([thread({ id: "019fda52-f2ec-7801-ba9c-8761cc89bae4" })]);

    expect(sessionButtons(group)).toEqual([
      {
        label: "Refactor payments",
        callbackData: "projopen:019fda52-f2ec-7801-ba9c-8761cc89bae4",
      },
    ]);
  });

  it("keeps labels within the Telegram button limit", () => {
    const [group] = groupThreadsByProject([
      thread({ title: "", firstUserMessage: "Refactor the delivery pricing rules ".repeat(20) }),
    ]);

    const [button] = sessionButtons(group);
    expect([...button.label]).toHaveLength(60);
    expect(button.label.endsWith("…")).toBe(true);
  });

  it("does not expose API keys that leaked into a thread title", () => {
    const [group] = groupThreadsByProject([thread({ title: "deploy with sk-ABCDEFGHIJKLMNOPQRSTUV" })]);

    expect(sessionButtons(group)[0].label).toBe("Session 019fda52");
  });
});

describe("renderProjectsHTML", () => {
  it("lists every project with its session count and path", () => {
    const groups = groupThreadsByProject([thread(), thread({ id: "b" })]);
    const html = renderProjectsHTML(groups);

    expect(html).toContain("<b>storefront</b>");
    expect(html).toContain("(2)");
    expect(html).toContain("<code>/srv/projects/storefront</code>");
  });

  it("hides the workspace path when its directory name was redacted", () => {
    const groups = groupThreadsByProject([
      thread({ cwd: "/root/Documents/Codex/8603016081-aafkgoyncrfhv9yjcln8mifaff-uyqbb6vu" }),
    ]);

    expect(renderProjectsHTML(groups)).not.toContain("aafkgoyncrfhv9yjcln8mifaff");
  });

  it("never renders an empty message", () => {
    expect(renderProjectsHTML([]).trim().length).toBeGreaterThan(0);
  });
});

describe("renderProjectHTML", () => {
  it("escapes HTML coming from a workspace name", () => {
    const [group] = groupThreadsByProject([thread({ cwd: "/srv/projects/a&b" })]);

    expect(renderProjectHTML(group)).toContain("a&amp;b");
  });
});

describe("findBoundTopic", () => {
  const FORUM_CHAT_ID = -1001234567890;

  function context(overrides: Partial<ContextMetadata> = {}): ContextMetadata {
    return {
      contextKey: `${FORUM_CHAT_ID}:154`,
      threadId: "019fda52-f2ec-7801-ba9c-8761cc89bae4",
      workspace: "/srv/projects/storefront",
      updatedAt: 1_000,
      ...overrides,
    };
  }

  it("finds the topic a thread is already bound to", () => {
    const topic = findBoundTopic(
      [context({ contextKey: `${FORUM_CHAT_ID}:9`, threadId: "other" }), context()],
      FORUM_CHAT_ID,
      "019fda52-f2ec-7801-ba9c-8761cc89bae4",
    );

    expect(topic).toBe(154);
  });

  it("ignores a binding without a topic, so General never counts as one", () => {
    const topic = findBoundTopic(
      [context({ contextKey: `${FORUM_CHAT_ID}` })],
      FORUM_CHAT_ID,
      "019fda52-f2ec-7801-ba9c-8761cc89bae4",
    );

    expect(topic).toBeUndefined();
  });

  it("ignores bindings made in another chat", () => {
    const topic = findBoundTopic(
      [context({ contextKey: "-1001111111111:154" })],
      FORUM_CHAT_ID,
      "019fda52-f2ec-7801-ba9c-8761cc89bae4",
    );

    expect(topic).toBeUndefined();
  });
});

describe("topicUrl", () => {
  it("drops the -100 prefix a private supergroup id carries", () => {
    expect(topicUrl(-1001234567890, 154)).toBe("https://t.me/c/1234567890/154");
  });
});
