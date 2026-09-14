import type { DashboardView } from "./model.js";

export interface DashboardPreferences {
  view: DashboardView;
  search: string;
  project: string;
  count: number;
  anchor?: { ids: string[]; offset: number; index?: number };
}

function normalize(value: unknown): DashboardPreferences | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as DashboardPreferences;
  if (!["active", "recent", "attention", "completed"].includes(v.view)
    || typeof v.search !== "string" || v.search.length > 160
    || typeof v.project !== "string" || v.project.length > 128
    || !Number.isFinite(v.count)) return;
  const anchor = v.anchor && Array.isArray(v.anchor.ids) && Number.isFinite(v.anchor.offset)
    ? { ids: v.anchor.ids.filter(id => typeof id === "string" && id.length <= 128).slice(0, 32),
      index: Number.isFinite(v.anchor.index) ? Math.max(0, Math.min(999, Math.floor(v.anchor.index!))) : 0,
      offset: Math.max(-2000, Math.min(2000, v.anchor.offset)) } : undefined;
  return { view: v.view, search: v.search, project: v.project,
    count: Math.max(30, Math.min(1000, Math.floor(v.count))), ...(anchor ? { anchor } : {}) };
}

export function readPreferences(storage: Pick<Storage, "getItem">, namespace: string): DashboardPreferences | undefined {
  try { return normalize(JSON.parse(storage.getItem(namespace) ?? "null")); } catch { return; }
}

export function writePreferences(storage: Pick<Storage, "setItem">, namespace: string, value: DashboardPreferences): void {
  try {
    const safe = normalize(value);
    if (safe) storage.setItem(namespace, JSON.stringify(safe));
  } catch { /* Storage may be disabled or full; navigation still works. */ }
}
