import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { containsSecret } from "./topic-sync.js";

type JsonObject = Record<string, unknown>;
const SENSITIVE_ASSIGNMENT = /\b(?:token|password|secret|api[_ -]?key|kubeconfig)\b\s*[:=]/i;

export function isSafeProjectContext(value: string): boolean {
  return Boolean(value.trim())
    && !containsSecret(value)
    && !SENSITIVE_ASSIGNMENT.test(value)
    && !/:\/\/[^/@\s]+:[^/@\s]+@/.test(value);
}

export function loadDofboxRealmContext(
  realmName: string,
  realmsDir = path.join(homedir(), ".dofbox", "realms"),
): string {
  assertRealmName(realmName);
  return renderDofboxRealmContext(loadRealm(realmName, realmsDir, new Set()));
}

export function renderDofboxRealmContext(realm: unknown): string {
  if (!isObject(realm)) {
    return "";
  }

  const lines: string[] = [];
  addLine(lines, "Realm", realm.name);
  addLine(lines, "Description", realm.description);

  if (Array.isArray(realm.repos)) {
    const repositories = realm.repos
      .map(renderRepository)
      .filter((value): value is string => Boolean(value));
    if (repositories.length) {
      lines.push(`Repositories: ${repositories.join(", ")}`);
    }
  }

  addPair(lines, "Jira", realm.jira, "server", "project");
  addPair(lines, "GitLab", realm.gitlab, "url", "group", "groupId");
  addPair(lines, "Sentry", realm.sentry, "baseUrl", "org", "project");

  if (isObject(realm.k8s)) {
    addLine(lines, "Kubernetes context", realm.k8s.context);
    if (isObject(realm.k8s.namespaces)) {
      const namespaces = Object.keys(realm.k8s.namespaces).filter(safeText);
      if (namespaces.length) {
        lines.push(`Kubernetes namespaces: ${namespaces.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

function loadRealm(name: string, realmsDir: string, loading: Set<string>): JsonObject {
  assertRealmName(name);
  if (loading.has(name)) {
    throw new Error(`Circular realm inheritance: ${name}`);
  }
  loading.add(name);
  const filePath = path.join(realmsDir, `${name}.json`);
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isObject(parsed)) {
    throw new Error(`Realm ${name} must contain a JSON object`);
  }
  const parentName = typeof parsed.extends === "string" ? parsed.extends : undefined;
  const merged = parentName
    ? mergeObjects(loadRealm(parentName, realmsDir, loading), parsed)
    : parsed;
  loading.delete(name);
  return merged;
}

function mergeObjects(base: JsonObject, override: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject(merged[key])
      ? mergeObjects(merged[key] as JsonObject, value)
      : value;
  }
  return merged;
}

function addPair(
  lines: string[],
  label: string,
  value: unknown,
  ...fields: string[]
): void {
  if (!isObject(value)) {
    return;
  }
  const values = fields.map((field) => safeValue(value[field])).filter(Boolean);
  if (values.length) {
    lines.push(`${label}: ${values.join(" · ")}`);
  }
}

function addLine(lines: string[], label: string, value: unknown): void {
  const safe = safeValue(value);
  if (safe) {
    lines.push(`${label}: ${safe}`);
  }
}

function renderRepository(value: unknown): string | undefined {
  if (typeof value === "string") {
    return safeValue(value);
  }
  if (!isObject(value)) {
    return undefined;
  }
  const name = safeValue(value.name);
  const repositoryPath = safeValue(value.path);
  return name && repositoryPath ? `${name}: ${repositoryPath}` : name ?? repositoryPath;
}

function safeValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  return safeText(text) ? text : undefined;
}

function safeText(value: string): boolean {
  return isSafeProjectContext(value);
}

function assertRealmName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid realm name: ${name}`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
