import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createJiraPanelStore } from "../src/jira-panel-store.js";

describe("Jira panel store", () => {
  it("persists the pinned message id across restarts", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-jira-panel-"));
    const file = path.join(directory, "jira-panel.json");
    try {
      const first = createJiraPanelStore(file);
      first.write({ messageId: 777 });

      const restored = createJiraPanelStore(file);
      expect(restored.read()).toEqual({ messageId: 777 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores invalid persisted state", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-jira-panel-"));
    const file = path.join(directory, "jira-panel.json");
    try {
      const store = createJiraPanelStore(file);
      store.write({});

      expect(createJiraPanelStore(file).read()).toEqual({});
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sees launcher moves written by another process", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-jira-panel-"));
    const file = path.join(directory, "jira-panel.json");
    try {
      const botStore = createJiraPanelStore(file);
      const recipeStore = createJiraPanelStore(file);

      recipeStore.write({ messageId: 777 });
      expect(botStore.read()).toEqual({ messageId: 777 });

      recipeStore.write({ messageId: 888 });
      expect(botStore.read()).toEqual({ messageId: 888 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails visibly when the new state cannot be persisted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecodex-jira-panel-"));
    const blockedParent = path.join(directory, "not-a-directory");
    writeFileSync(blockedParent, "blocked");
    try {
      const store = createJiraPanelStore(path.join(blockedParent, "jira-panel.json"));

      expect(() => store.write({ messageId: 777 })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
