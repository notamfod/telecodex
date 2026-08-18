import { mkdtempSync, rmSync } from "node:fs";
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
});
