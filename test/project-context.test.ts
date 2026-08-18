import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSafeProjectContext,
  loadDofboxRealmContext,
  renderDofboxRealmContext,
} from "../src/project-context.js";

describe("isSafeProjectContext", () => {
  it("accepts ordinary context and rejects secret-bearing text", () => {
    expect(isSafeProjectContext("Jira project: MIR\nRepository: /srv/mircli")).toBe(true);
    expect(isSafeProjectContext("password = hunter2")).toBe(false);
    expect(isSafeProjectContext("kubeconfig: embedded-data")).toBe(false);
    expect(isSafeProjectContext("token sk-ABCDEFGHIJKLMNOPQRSTUV")).toBe(false);
  });
});

describe("renderDofboxRealmContext", () => {
  it("renders only allowlisted project fields and never secret values", () => {
    const rendered = renderDofboxRealmContext({
      name: "mircli",
      description: "MirCli production",
      repos: ["/srv/mir-back", { name: "frontend", path: "/srv/mir-frontend", token: "repo-secret" }],
      jira: { server: "https://jira.example.test", project: "MIR", apiToken: "jira-secret" },
      gitlab: { url: "https://gitlab.example.test", groupId: "42", token: "gitlab-secret" },
      sentry: { baseUrl: "https://sentry.example.test", org: "acme", project: "mir-back", token: "sentry-secret" },
      k8s: {
        context: "production",
        kubeconfig: "kubeconfig-secret",
        namespaces: {
          production: { token: "namespace-secret" },
          develop: { password: "password-secret" },
        },
      },
      telegram: { token: "telegram-secret" },
    });

    expect(rendered).toContain("mircli");
    expect(rendered).toContain("/srv/mir-back");
    expect(rendered).toContain("https://jira.example.test");
    expect(rendered).toContain("production, develop");
    for (const secret of [
      "repo-secret",
      "jira-secret",
      "gitlab-secret",
      "sentry-secret",
      "kubeconfig-secret",
      "namespace-secret",
      "password-secret",
      "telegram-secret",
    ]) {
    expect(rendered).not.toContain(secret);
    }
  });

  it("drops an allowlisted field when its value itself looks secret-bearing", () => {
    expect(renderDofboxRealmContext({
      name: "mircli",
      description: "password = hunter2",
    })).toBe("Realm: mircli");
  });
});

describe("loadDofboxRealmContext", () => {
  it("loads an inherited realm without exposing base secrets", () => {
    const realmsDir = mkdtempSync(path.join(tmpdir(), "telecodex-realms-"));
    writeFileSync(path.join(realmsDir, "default.json"), JSON.stringify({
      name: "default",
      sentry: { baseUrl: "https://sentry.example.test", token: "base-secret" },
    }));
    writeFileSync(path.join(realmsDir, "mircli.json"), JSON.stringify({
      extends: "default",
      name: "mircli",
      jira: { project: "MIR" },
    }));

    const rendered = loadDofboxRealmContext("mircli", realmsDir);

    expect(rendered).toContain("mircli");
    expect(rendered).toContain("https://sentry.example.test");
    expect(rendered).toContain("MIR");
    expect(rendered).not.toContain("base-secret");
  });

  it("rejects realm names that could escape the realms directory", () => {
    expect(() => loadDofboxRealmContext("../secret", "/tmp")).toThrow("Invalid realm name");
  });
});
