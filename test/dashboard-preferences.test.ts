import { describe, expect, it } from "vitest";
import { readPreferences, writePreferences } from "../web/src/dashboard-preferences.js";

describe("dashboard preferences", () => {
  it("isolates accounts and stores only bounded navigation data", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    writePreferences(storage, "user:1", { view: "completed", search: "ticket", project: "abc", count: 9999, anchor: { ids: Array.from({ length: 90 }, (_, i) => `task:${i}`), offset: 10 } });
    expect(readPreferences(storage, "user:2")).toBeUndefined();
    expect(readPreferences(storage, "user:1")).toMatchObject({ view: "completed", count: 1000, anchor: { offset: 10 } });
    expect(readPreferences(storage, "user:1")?.anchor?.ids).toHaveLength(32);
  });
  it("ignores malformed or inaccessible storage", () => {
    expect(readPreferences({ getItem: () => '{"view":"unknown"}' }, "a")).toBeUndefined();
    expect(readPreferences({ getItem: () => { throw Error("denied"); } }, "a")).toBeUndefined();
    expect(() => writePreferences({ setItem: () => { throw Error("quota"); } }, "a", { view: "active", search: "", project: "", count: 30 })).not.toThrow();
  });
});
